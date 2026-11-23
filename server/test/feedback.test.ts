import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { SendMailOptions, Transporter } from 'nodemailer';
import { createFeedback, feedbackBody, agentCandidates } from '../src/feedback.ts';
import { exportOptions, feedbackReport, renderFeedback } from '../src/feedback-export.ts';
import { openDatabase } from '../src/db.ts';
import { SmtpSender } from '../src/senders.ts';
import { createTokens } from '../src/tokens.ts';
import { fixture, initialTime, secret, keys } from './helpers.ts';
const request = { kind: 'agent_request', agents: ['gemini-cli', 'cursor'] };

test('anonymous and authenticated feedback; email is account-only and logs omit private data', async t => {
  const logs: string[] = [];
  const f = await fixture(t, new Map(), undefined, { log: s => logs.push(s), trustProxy: true });
  const anon = await f.request('POST', '/feedback', { ...request, contactOk: true, contact_email: 'forged@example.com', contactEmail: 'forged@example.com', message: 'private content' }, { headers: { 'x-forwarded-for': '192.0.2.1' } });
  assert.equal(anon.status, 200);
  assert.equal(anon.body.ok, true);
  const row = f.db.prepare('SELECT * FROM feedback WHERE id = ?').get(anon.body.id)!;
  assert.equal(row.user_id, null);
  assert.equal(row.contact_email, null);
  assert.equal(row.ip_hash, createHmac('sha256', secret).update('feedback-ip:192.0.2.1').digest('hex'));
  const session = await f.login('feedback@example.com');
  for (const contactOk of [true, false]) {
    const reply = await f.request('POST', '/feedback', { kind: 'bug', message: 'private content', contactOk, contactEmail: 'forged@example.com' }, { token: session.accessToken });
    assert.equal(reply.status, 200);
    const saved = f.db.prepare('SELECT * FROM feedback WHERE id = ?').get(reply.body.id)!;
    assert.equal(saved.user_id, session.user.id);
    assert.equal(saved.contact_email, contactOk ? 'feedback@example.com' : null);
  }
  assert.equal((await f.request('POST', '/feedback', request, { token: 'bad-token' })).status, 401);
  assert.equal((await f.request('POST', '/feedback', request, { headers: { authorization: 'Basic invalid' } })).status, 401);
  assert.ok(logs.every(log => !log.includes('private content') && !log.includes('@')));
  assert.deepEqual(Object.keys(JSON.parse(logs[0])), ['id', 'kind', 'agents']);
});

test('validation, inclusive bounds and diagnostics whitelist', async t => {
  const f = await fixture(t);
  const bad = [
    {}, { kind: 'oops' }, { kind: 'agent_request' }, { kind: 'agent_request', otherAgent: '  ' },
    { ...request, agents: ['codex'] }, { ...request, agents: ['constructor'] }, { ...request, agents: [7] },
    { ...request, agents: 'cursor' }, { ...request, agents: Array(11).fill('cursor') },
    { ...request, otherAgent: '界'.repeat(61) }, { ...request, otherAgent: 5 },
    { ...request, message: '😀'.repeat(2001) }, { ...request, message: null },
    ...['bug', 'idea', 'other'].map(kind => ({ kind, message: '  ' })),
    { ...request, contactOk: 'true' }, { ...request, diagnostics: [] },
    { ...request, diagnostics: { appVersion: 1 } }, { ...request, diagnostics: { locale: 'x'.repeat(65) } },
    { ...request, diagnostics: { enabledAgents: ['unknown-agent'] } }, { ...request, diagnostics: { enabledAgents: 'codex' } },
  ];
  for (const body of bad) assert.equal((await f.request('POST', '/feedback', body)).status, 400, JSON.stringify(body));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM feedback').get()!.n, 0);
  const reply = await f.request('POST', '/feedback', {
    kind: 'agent_request', otherAgent: '😀'.repeat(60), message: '😀'.repeat(2000),
    diagnostics: { appVersion: 'a'.repeat(64), build: '1', osVersion: '17', deviceModel: 'iPhone16,1', bridgeVersion: '0.1', locale: 'en_US', enabledAgents: ['codex', 'claude', 'workbuddy', 'antigravity', 'cursor'], token: 'secret', path: '/private', session: 'private content', phone: '123' },
  });
  assert.equal(reply.status, 200);
  const diagnostics = JSON.parse(f.db.prepare('SELECT diagnostics FROM feedback WHERE id = ?').get(reply.body.id)!.diagnostics as string);
  assert.deepEqual(diagnostics.enabledAgents, ['codex', 'claude', 'workbuddy', 'antigravity', 'cursor']);
  assert.deepEqual(Object.keys(diagnostics).sort(), ['appVersion', 'build', 'osVersion', 'deviceModel', 'bridgeVersion', 'locale', 'enabledAgents'].sort());
  assert.deepEqual(feedbackBody({ ...request, agents: ['cursor', 'cursor'] }).agents, ['cursor']);
  for (const kind of ['bug', 'idea', 'other']) assert.equal((await f.request('POST', '/feedback', { kind, message: 'Something' })).status, 200);
});

test('persistent hourly/daily IP limits and account quota across IPs', async t => {
  const f = await fixture(t, new Map(), undefined, { trustProxy: true });
  const submit = (ip: string, token?: string) => f.request('POST', '/feedback', request, { token, headers: { 'x-forwarded-for': ip } });
  for (let hour = 0; hour < 3; hour++) {
    for (let n = 0; n < 10; n++) assert.equal((await submit('ip-a')).status, 200);
    const limited = await submit('ip-a');
    assert.equal(limited.status, 429);
    assert.equal(Number(limited.headers['retry-after']), limited.body.error.retryAfter);
    assert.equal(limited.body.error.retryAfter, hour === 2 ? 22 * 3600 : 3600);
    f.advance(3600_000);
  }
  assert.equal((await submit('ip-a')).status, 429);
  f.advance(21 * 3600_000);
  assert.equal((await submit('ip-a')).status, 200);
  const session = await f.login('quota@example.com');
  for (let n = 0; n < 20; n++) assert.equal((await submit(`ip-${n}`, session.accessToken)).status, 200);
  const limited = await submit('new-ip', session.accessToken);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.retryAfter, 86400);
  f.advance(86400_000);
  const renewed = await f.login('quota@example.com');
  assert.equal((await submit('new-ip', renewed.accessToken)).status, 200);
});

test('quotas survive database reopen; only HMAC IP is stored', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'aa-feedback-'));
  try {
    const path = resolve(dir, 'db.sqlite');
    let db = openDatabase(path);
    for (let n = 0; n < 10; n++) createFeedback(db, secret, () => initialTime)(request, '192.0.2.1');
    db.close(); db = openDatabase(path);
    try {
      assert.throws(() => createFeedback(db, secret, () => initialTime)(request, '192.0.2.1'), { status: 429 });
      const row = db.prepare('SELECT * FROM feedback LIMIT 1').get()!;
      assert.equal(row.ip_hash, createHmac('sha256', secret).update('feedback-ip:192.0.2.1').digest('hex'));
      assert.ok(!Object.hasOwn(row, 'ip'));
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shared SMTP transport sends pure text; delivery failure does not affect API', async t => {
  const mails: SendMailOptions[] = [], logs: string[] = [];
  let fail = false;
  const transport = { async sendMail(mail: SendMailOptions) { mails.push(mail); if (fail) throw new Error('private SMTP credentials'); return {}; } } as Pick<Transporter, 'sendMail'>;
  const sender = new SmtpSender('unused', 'sender@example.com', transport);
  const f = await fixture(t, new Map(), undefined, { feedbackNotification: { to: 'owner@example.com', sender }, log: s => logs.push(s) });
  const session = await f.login('contact@example.com');
  const reply = await f.request('POST', '/feedback', { ...request, message: '<b>private</b>\nsecond line', contactOk: true, diagnostics: { build: '42' } }, { token: session.accessToken });
  assert.equal(reply.status, 200);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mails[0].to, 'owner@example.com');
  assert.equal(mails[0].from, 'sender@example.com');
  assert.equal(mails[0].subject, 'AgentTote 反馈：申请 Agent（Gemini CLI, Cursor）');
  assert.equal(mails[0].html, undefined);
  for (const expected of ['申请 Agent', '<b>private</b>\nsecond line', '同意联系：是', 'contact@example.com', '"build": "42"', new Date(initialTime).toISOString(), reply.body.id]) assert.ok(String(mails[0].text).includes(expected));
  fail = true;
  assert.equal((await f.request('POST', '/feedback', { kind: 'bug', message: 'private' })).status, 200);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mails[1].subject, 'AgentTote 反馈：问题');
  assert.ok(logs.some(log => log.startsWith('Feedback notification failed:')));
  assert.ok(logs.every(log => !log.includes('private') && !log.includes('credentials')));
});

test('export deduplicates account OR IP with bridging identities, windows and all formats', () => {
  const db = openDatabase();
  try {
    for (const id of ['u1', 'u2', 'u3']) db.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').run(id, initialTime);
    let time = initialTime;
    const send = createFeedback(db, secret, () => time);
    send(request, 'ip1');
    send(request, 'ip1', { id: 'u1' });
    send(request, 'ip2', { id: 'u1' });
    send(request, 'ip2', { id: 'u2' });
    send({ ...request, agents: ['cursor'] }, 'ip3', { id: 'u3' });
    send({ kind: 'agent_request', otherAgent: 'Custom, "Agent"', message: '=HYPERLINK("test")\nline' }, 'ip4');
    time += 8 * 86400_000;
    send({ kind: 'idea', message: 'a'.repeat(101) }, 'ip5');
    const report = feedbackReport(db, 'all', time);
    assert.equal(report.ranking.find(r => r.agent === 'cursor')!.count, 2);
    assert.equal(report.ranking.find(r => r.agent === 'gemini-cli')!.count, 1);
    assert.equal(feedbackReport(db, '7d', time).feedback.length, 1);
    assert.equal(feedbackReport(db, '30d', time).feedback.length, 7);
    assert.equal(report.feedback[0].kind, 'idea');
    const table = renderFeedback(report, 'table');
    assert.ok(table.indexOf('各 Agent') < table.indexOf('最近反馈'));
    assert.ok(table.includes('a'.repeat(100) + '…'));
    assert.deepEqual(JSON.parse(renderFeedback(report, 'json')), report);
    const csv = renderFeedback(report, 'csv');
    assert.ok(csv.startsWith('"record_type","agent"'));
    assert.ok(csv.includes('Custom, ""Agent""'));
    assert.ok(csv.includes(`"'=HYPERLINK(""test"")\nline"`));
    assert.deepEqual(exportOptions([]), { since: '30d', format: 'table' });
    assert.deepEqual(exportOptions(['--format', 'csv', '--since', 'all']), { since: 'all', format: 'csv' });
    for (const args of [['--since', '1d'], ['--format', 'xml'], ['--since'], ['oops']]) assert.throws(() => exportOptions(args));
  } finally { db.close(); }
});

test('CLI export reads existing database without configuration, migration or HTTP listen', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'aa-feedback-cli-'));
  try {
    const db = openDatabase(resolve(dir, 'account.sqlite'));
    createFeedback(db, secret, Date.now)(request, 'ip');
    db.close();
    for (const format of ['table', 'json', 'csv']) {
      const child = spawnSync(process.execPath, ['--no-warnings', 'src/index.ts', 'feedback', '--since', 'all', '--format', format], {
        encoding: 'utf8', cwd: resolve(import.meta.dirname, '..'), env: { ...process.env, AA_DATA_DIR: dir, AA_SIGNING_KEY: 'invalid', AA_EMAIL_SENDER: 'invalid' }, timeout: 10000,
      });
      assert.equal(child.status, 0, child.stderr);
      if (format === 'json') assert.equal(JSON.parse(child.stdout).ranking[0].count, 1);
      else assert.ok(child.stdout.includes(format === 'table' ? '各 Agent' : 'record_type'));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('phone-only authenticated accounts cannot supply a contact email', async t => {
  const f = await fixture(t);
  const userId = await f.legacy();
  const token = createTokens(f.db, keys.privateKey, f.now).createSession(userId, 'Test').accessToken;
  const reply = await f.request('POST', '/feedback', { ...request, contactOk: true, contactEmail: 'fake@example.com' }, { token });
  assert.equal(reply.status, 200);
  assert.equal(f.db.prepare('SELECT contact_email FROM feedback WHERE id = ?').get(reply.body.id)!.contact_email, null);
});

test('slow email delivery never delays API response', async t => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const f = await fixture(t, new Map(), undefined, { feedbackNotification: { to: 'owner@example.com', sender: { sendMail: () => pending } } });
  try {
    const reply = await f.request('POST', '/feedback', request);
    assert.equal(reply.status, 200);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM feedback').get()!.n, 1);
  } finally { finish(); }
});


test('current iOS candidates match the server while retired Cursor requests remain accepted', () => {
  const source = readFileSync(new URL('../../ios/AgentAnywhere/Models/Feedback.swift', import.meta.url), 'utf8');
  const candidates = Object.fromEntries([...source.matchAll(/\.init\(id: "([^"]+)", name: "([^"]+)"/g)].map(match => [match[1], match[2]]));
  // Older iPhone builds can still submit requests for the now-supported Cursor agent.
  const { cursor, ...currentCandidates } = agentCandidates;
  assert.equal(cursor, 'Cursor');
  assert.deepEqual(candidates, currentCandidates);
});
