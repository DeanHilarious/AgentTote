import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http2, { createServer } from 'node:http2';
import { syncBuiltinESMExports } from 'node:module';
import { Duplex } from 'node:stream';
import type { TestContext } from 'node:test';
import type { Http2Session } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ApnsClient, loadApnsConfig, notifyBody } from '../src/apns.ts';
import type { ApnsConfig } from '../src/apns.ts';
import { initializeDatabase } from '../src/db.ts';
import { fixture, initialTime } from './helpers.ts';

const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const cfg: ApnsConfig = { privateKey: ec.privateKey, keyId: 'KEY123', teamId: 'TEAM123', bundleId: 'com.deanhilarious.agentanywhere', sandboxOrigin: 'http://127.0.0.1:1', productionOrigin: 'http://127.0.0.1:2' };
const body = { apnsToken: 'ab'.repeat(32), environment: 'sandbox' as const, ciphertext: Buffer.from('encrypted envelope').toString('base64') };
const device = { name: 'Mac', hosts: ['localhost'], port: 8787, bridgeVersion: '0.1' };
const listen = { skip: process.env.AA_TEST_LISTEN !== '1' ? 'Run AA_TEST_LISTEN=1 npm test for local h2c APNs' : false, timeout: 20000 };

test('APNs configuration disables missing/unreadable/invalid keys without crashing; defaults and explicit h2c origins', t => {
  const dir = mkdtempSync(join(tmpdir(), 'aa-apns-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'apns.p8');
  writeFileSync(path, ec.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const logs: string[] = [], log = (s: string) => logs.push(s);
  const env = { AA_APNS_KEY_FILE: path, AA_APNS_KEY_ID: cfg.keyId, AA_APNS_TEAM_ID: cfg.teamId };
  assert.equal(loadApnsConfig({}, log), undefined);
  assert.equal(loadApnsConfig({ ...env, AA_APNS_KEY_FILE: join(dir, 'absent') }, log), undefined);
  const config = loadApnsConfig(env, log)!;
  assert.equal(config.bundleId, cfg.bundleId);
  assert.equal(config.sandboxOrigin, 'https://api.sandbox.push.apple.com');
  assert.equal(config.productionOrigin, 'https://api.push.apple.com');
  assert.equal(loadApnsConfig({ ...env, AA_APNS_ORIGIN_SANDBOX: 'http://127.0.0.1:1234' }, log)!.sandboxOrigin, 'http://127.0.0.1:1234');
  assert.equal(loadApnsConfig({ ...env, AA_APNS_ORIGIN_SANDBOX: 'file:///private' }, log), undefined);
  writeFileSync(path, 'secret invalid key');
  assert.equal(loadApnsConfig(env, log), undefined);
  assert.ok(logs.every(s => s === 'APNs disabled'));
});
test('notification validation uses encoded byte limit and canonical padded base64', () => {
  assert.deepEqual(notifyBody(body), body);
  assert.equal(notifyBody({ ...body, ciphertext: Buffer.alloc(2250).toString('base64') }).ciphertext.length, 3000);
  for (const patch of [{ apnsToken: '' }, { apnsToken: 'f'.repeat(201) }, { apnsToken: 'z'.repeat(64) }, { environment: 'development' }, { ciphertext: '' }, { ciphertext: 'A===' }, { ciphertext: 'YWJj\n' }, { ciphertext: 'not-base64' }, { ciphertext: Buffer.alloc(2251).toString('base64') }]) assert.throws(() => notifyBody({ ...body, ...patch }), { status: 400 });
});
test('notify requires bearer auth and device ownership; disabled returns 503; private inputs are not stored', async t => {
  const logs: string[] = [];
  const f = await fixture(t, new Map(), undefined, { log: s => logs.push(s) });
  const owner = await f.login('push-owner@example.com'), other = await f.login('push-other@example.com');
  const id = randomUUID();
  const send = (token?: string, payload: unknown = body, deviceId = id) => f.request('POST', `/devices/${deviceId}/notify`, payload, { token });
  await f.request('PUT', `/devices/${id}`, device, { token: owner.accessToken });
  assert.equal((await send()).status, 401);
  assert.equal((await send(other.accessToken)).status, 404);
  assert.equal((await send(owner.accessToken, body, randomUUID())).status, 404);
  assert.equal((await send(owner.accessToken, { ...body, ciphertext: '**' })).status, 400);
  const disabled = await send(owner.accessToken);
  assert.equal(disabled.status, 503); assert.equal(disabled.body.error.code, 'push_disabled');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM push_attempts').get()!.n, 0);
  for (const table of ['devices', 'push_attempts']) {
    const rows = JSON.stringify(f.db.prepare(`SELECT * FROM ${table}`).all());
    assert.ok(!rows.includes(body.apnsToken)); assert.ok(!rows.includes(body.ciphertext));
  }
  assert.ok(!logs.join('').includes(body.apnsToken));
});
test('per-user minute/day quota is persistent, reserves before APNs, includes retryAfter, and expires at boundary', async t => {
  let sent = 0;
  t.mock.method(ApnsClient.prototype, 'send', async () => { sent++; return { ok: true }; });
  const f = await fixture(t, new Map(), undefined, { apns: cfg });
  const owner = await f.login('push-limit@example.com');
  const id = randomUUID(); await f.request('PUT', `/devices/${id}`, device, { token: owner.accessToken });
  const send = () => f.request('POST', `/devices/${id}/notify`, body, { token: owner.accessToken });
  for (let i = 0; i < 30; i++) assert.equal((await send()).status, 200);
  initializeDatabase(f.db); // Reinitialization must preserve reservations.
  const limited = await send(); assert.equal(limited.status, 429); assert.equal(limited.body.error.retryAfter, 60); assert.equal(limited.headers['retry-after'], '60'); assert.equal(sent, 30);
  f.advance(60_000); assert.equal((await send()).status, 200);
  const other = await f.login('push-limit-other@example.com');
  const otherId = randomUUID(); await f.request('PUT', `/devices/${otherId}`, device, { token: other.accessToken });
  assert.equal((await f.request('POST', `/devices/${otherId}/notify`, body, { token: other.accessToken })).status, 200);
  f.db.prepare('DELETE FROM push_attempts WHERE user_id = ?').run(owner.user.id);
  for (let i = 0; i < 500; i++) f.db.prepare('INSERT INTO push_attempts (user_id, created_at) VALUES (?, ?)').run(owner.user.id, initialTime);
  const daily = await send(); assert.equal(daily.status, 429); assert.equal(daily.body.error.retryAfter, 86340);
  f.advance(86340_000);
  // Access token has expired; renew it before exercising daily quota boundary.
  const refresh = await f.request('POST', '/auth/refresh', { refreshToken: owner.refreshToken });
  owner.accessToken = refresh.body.accessToken;
  assert.equal((await send()).status, 200);
  const rows = JSON.stringify(f.db.prepare('SELECT * FROM push_attempts').all());
  assert.ok(!rows.includes(body.apnsToken)); assert.ok(!rows.includes(body.ciphertext));
});

test('in-memory h2c validates ES256 JWT, cache, headers, payload, HTTP mapping and reconnect', t => verifyApns(t, true));
test('local socket h2c validates the complete APNs protocol', listen, t => verifyApns(t, false));

async function verifyApns(t: TestContext, memory: boolean) {
  const fake = createServer();
  const sessions = new Set<Http2Session>();
  fake.on('session', s => { sessions.add(s); s.on('close', () => sessions.delete(s)); });
  let responseStatus = 200, reason = '', time = initialTime;
  let failure: 'hang' | 'stream' | 'session' | 'alwaysHang' | undefined;
  let openedSessions = 0;
  fake.on('session', () => { openedSessions++; });
  const received: { headers: Record<string, unknown>; body: any }[] = [];
  fake.on('stream', (stream, headers) => {
    let text = ''; stream.on('data', chunk => { text += chunk; });
    stream.on('end', () => {
      received.push({ headers, body: JSON.parse(text) });
      const mode = failure;
      if (mode !== 'alwaysHang') failure = undefined;
      if (mode === 'hang' || mode === 'alwaysHang') return;
      if (mode === 'stream') { stream.close(http2.constants.NGHTTP2_CANCEL); return; }
      if (mode === 'session') { stream.session!.destroy(); return; }
      stream.respond({ ':status': responseStatus }); stream.end(reason ? JSON.stringify({ reason }) : '');
    });
  });
  let origin = 'http://127.0.0.1:1234';
  if (memory) {
    // Exercise Node's real HTTP/2 framing over connected Duplex streams, without
    // binding a socket. Keep the separate socket test for AA_TEST_LISTEN=1 runs.
    const originalConnect = http2.connect;
    const mock = t.mock.method(http2, 'connect', (url: string) => {
      let client!: Duplex, server!: Duplex;
      client = new Duplex({ read() {}, write(chunk, _encoding, done) { server.push(Buffer.from(chunk)); done(); }, final(done) { server.push(null); done(); } });
      server = new Duplex({ read() {}, write(chunk, _encoding, done) { client.push(Buffer.from(chunk)); done(); }, final(done) { client.push(null); done(); } });
      fake.emit('connection', server);
      return originalConnect(url, { createConnection: () => client });
    });
    syncBuiltinESMExports();
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  } else {
    fake.listen(0, '127.0.0.1'); await once(fake, 'listening');
    const address = fake.address(); assert.ok(address && typeof address === 'object');
    origin = `http://127.0.0.1:${address.port}`;
  }
  const logs: string[] = [];
  const apns = new ApnsClient({ ...cfg, sandboxOrigin: origin, productionOrigin: origin }, () => time, s => logs.push(s),
    { requestMs: 150, idleMs: 5 * 60_000 });
  t.after(async () => { apns.close(); for (const s of sessions) s.destroy(); await new Promise<void>(resolve => fake.close(() => resolve())); });
  assert.deepEqual(await apns.send('12345678-private-user', body), { ok: true });
  const h = received[0].headers;
  assert.equal(h[':method'], 'POST'); assert.equal(h[':path'], `/3/device/${body.apnsToken}`);
  assert.equal(h['apns-topic'], cfg.bundleId); assert.equal(h['apns-push-type'], 'alert'); assert.equal(h['apns-priority'], '10'); assert.equal(h['apns-expiration'], String(initialTime / 1000 + 86400));
  const jwt = String(h.authorization).slice(7), parts = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(parts[0], 'base64url').toString()), { alg: 'ES256', kid: cfg.keyId });
  assert.deepEqual(JSON.parse(Buffer.from(parts[1], 'base64url').toString()), { iss: cfg.teamId, iat: initialTime / 1000 });
  assert.equal(Buffer.from(parts[2], 'base64url').length, 64);
  assert.ok(verify('sha256', Buffer.from(parts.slice(0, 2).join('.')), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url')));
  assert.deepEqual(received[0].body, { aps: { alert: { title: 'AgentTote', body: 'A task you follow has an update.' }, 'mutable-content': 1, sound: 'default' }, aa: body.ciphertext });
  time += 49 * 60_000; await apns.send('12345678', { ...body, environment: 'production' });
  assert.equal(received[1].headers.authorization, h.authorization); assert.equal(sessions.size, 1);
  time += 60_000; await apns.send('12345678', body);
  assert.notEqual(received[2].headers.authorization, h.authorization);
  for (const [status, responseReason, expectedStatus, code] of [[410, 'Unregistered', 410, 'token_invalid'], [400, 'BadDeviceToken', 410, 'token_invalid'], [400, 'DeviceTokenNotForTopic', 410, 'token_invalid'], [403, 'InvalidProviderToken', 502, 'apns_unavailable'], [429, 'TooManyRequests', 502, 'apns_unavailable'], [500, 'InternalServerError', 502, 'apns_unavailable']] as const) {
    responseStatus = status; reason = responseReason;
    const before = received.length;
    await assert.rejects(apns.send('12345678', body), { status: expectedStatus, code });
    assert.equal(received.length, before + 1, 'HTTP 4xx/5xx must never retry');
  }
  responseStatus = 200; reason = '';
  for (const mode of ['hang', 'stream', 'session'] as const) {
    failure = mode;
    const before = received.length, connections = openedSessions;
    assert.deepEqual(await apns.send('12345678', body), { ok: true });
    assert.equal(received.length, before + 2, `${mode}: one retry`);
    assert.equal(openedSessions, connections + 1, `${mode}: retry uses a new session`);
  }
  failure = 'alwaysHang';
  const before = received.length;
  await assert.rejects(apns.send('12345678', body), { status: 502, code: 'apns_unavailable' });
  assert.equal(received.length, before + 2, 'transport failure retries at most once');
  failure = undefined;
  assert.deepEqual(await apns.send('12345678', body), { ok: true });

  const idleApns = new ApnsClient({ ...cfg, sandboxOrigin: origin }, Date.now, () => {}, { requestMs: 1000, idleMs: 30 });
  t.after(() => idleApns.close());
  await idleApns.send('12345678', body);
  const connections = openedSessions;
  await new Promise(resolve => setTimeout(resolve, 80));
  await idleApns.send('12345678', body);
  assert.equal(openedSessions, connections + 1, 'idle session is closed and replaced');
  idleApns.close();
  // Verify HTTP API mapping too, using the same local h2c fake.
  const f = await fixture(t, new Map(), undefined, { apns: { ...cfg, sandboxOrigin: origin }, log: s => logs.push(s) });
  const owner = await f.login('apns-route@example.com'), id = randomUUID();
  await f.request('PUT', `/devices/${id}`, device, { token: owner.accessToken });
  for (const [status, responseReason, expected] of [[200, '', 200], [410, 'Unregistered', 410], [400, 'BadDeviceToken', 410], [403, 'InvalidProviderToken', 502]] as const) {
    responseStatus = status; reason = responseReason;
    assert.equal((await f.request('POST', `/devices/${id}/notify`, body, { token: owner.accessToken })).status, expected);
  }
  responseStatus = 200; reason = '';
  apns.close(); assert.deepEqual(await apns.send('12345678', body), { ok: true });
  assert.ok(logs.some(s => s.includes('Check APNs key configuration')));
  for (const secret of [body.apnsToken, body.ciphertext, 'private-user', cfg.teamId, cfg.keyId]) assert.ok(!logs.join('\n').includes(secret));
}
