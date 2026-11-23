import assert from 'node:assert/strict';
import { createDecipheriv, hkdfSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { test } from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import { AccountClient, AccountError, AccountNetworkError } from '../src/account.ts';
import { encryptPush, pushPlaintext, PushManager, registration } from '../src/push.ts';
import type { PushAccount } from '../src/push.ts';
import { publicKey, sharedSecret } from '../src/relayCrypto.ts';
import { redactSecrets } from '../src/secrets.ts';
import { bridgeHello, startServer } from '../src/server.ts';
import { TaskManager } from '../src/tasks.ts';
import type { Adapter, TaskInfo, TaskSink } from '../src/types.ts';
import { config } from './accountHelpers.ts';

const vectors = JSON.parse(readFileSync(new URL('../../docs/push-test-vectors.json', import.meta.url), 'utf8'));
const phonePrivate = Buffer.from(vectors.phonePrivate, 'hex');
const reg = { installationId: randomUUID(), apnsToken: 'abcd'.repeat(16), environment: 'sandbox', publicKey: vectors.phonePublic };
const opts = { cwd: '/tmp', prompt: 'Private title\nsecond', permissionMode: 'readOnly' as const };
function open(ciphertext: string): string {
  const bytes = Buffer.from(ciphertext, 'base64');
  assert.equal(bytes[0], 1);
  const key = Buffer.from(hkdfSync('sha256', sharedSecret(phonePrivate, bytes.subarray(1, 33)), Buffer.concat([bytes.subarray(1, 33), publicKey(phonePrivate)]), 'aa push v1', 32));
  const plainSize = bytes.length - 61;
  const decipher = createDecipheriv('chacha20-poly1305', key, bytes.subarray(33, 45), { authTagLength: 16 });
  decipher.setAAD(Buffer.from('aa push v1'), { plaintextLength: plainSize });
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(45, -16)), decipher.final()]).toString('utf8');
}
function adapter(start: (sink: TaskSink) => void): Adapter {
  return { kind: 'codex', name: 'fake', async detect() { return { kind: 'codex', name: 'fake', status: 'ready', runningProcesses: 0 }; },
    async listSessions() { return []; }, async getMessages() { return []; },
    async startTask(_opts, sink) { start(sink); return { cancel() { sink.finish({ status: 'failed', error: 'cancel requested' }); } }; } };
}
const task: TaskInfo = { id: 'test-task', agent: 'codex', ...opts, status: 'completed', startedAt: 1, endedAt: 2, result: 'Private summary' };

test('push vector encrypts exactly, decrypts independently, and rejects tampering', () => {
  const encrypted = encryptPush(Buffer.from(vectors.phonePublic, 'base64'), vectors.plaintext, Buffer.from(vectors.ephemeralPrivate, 'hex'), Buffer.from(vectors.nonce, 'hex'));
  assert.equal(encrypted, vectors.ciphertext);
  assert.equal(publicKey(phonePrivate).toString('base64'), vectors.phonePublic);
  assert.equal(sharedSecret(phonePrivate, Buffer.from(vectors.ephemeralPublic, 'base64')).toString('hex'), vectors.shared);
  assert.equal(open(encrypted), vectors.plaintext);
  const tampered = Buffer.from(encrypted, 'base64'); tampered[50] ^= 1;
  assert.throws(() => open(tampered.toString('base64')));
  assert.notEqual(encryptPush(publicKey(phonePrivate), vectors.plaintext), encrypted);
});
test('plaintext has bounded Unicode title, one-line summary, and base64 fits even escaped JSON', () => {
  const plain = pushPlaintext(config.deviceId, 'Mac', { ...task, prompt: '😀'.repeat(100) + '\nignored', result: 'a\n\t b\r c' });
  assert.equal(Array.from(JSON.parse(plain).title).length, 80);
  assert.equal(JSON.parse(plain).summary, 'a b c');
  assert.equal(JSON.parse(pushPlaintext(config.deviceId, 'Mac', { ...task, status: 'cancelled' })).summary, '');
  const large = pushPlaintext(config.deviceId, 'Mac'.repeat(150), { ...task, prompt: '\u0000'.repeat(80), result: '\u0000'.repeat(240) });
  assert.ok(encryptPush(publicKey(phonePrivate), large).length <= 3000);
  assert.ok(JSON.parse(large).summary.length < 240);
});
test('registration validates UUID, canonical base64, environment, token and usable X25519', () => {
  assert.equal(registration(reg).installationId, reg.installationId);
  for (const patch of [{ installationId: 'wrong' }, { apnsToken: 'f'.repeat(63) }, { apnsToken: 'f'.repeat(65) }, { apnsToken: 'g'.repeat(64) }, { apnsToken: 'f'.repeat(202) }, { environment: 'other' }, { publicKey: vectors.phonePublic.slice(0, -1) }, { publicKey: Buffer.alloc(32).toString('base64') }]) assert.throws(() => registration({ ...reg, ...patch }));
  assert.equal(redactSecrets(`token=${reg.apnsToken} key=${reg.publicKey}`), 'token=[redacted] key=[redacted]');
});
test('finish sends once for every terminal state, synchronous finish, start rejection, and cancelRequested', async () => {
  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    const delivered: TaskInfo[] = [];
    const manager = new TaskManager([adapter(sink => { sink.finish({ status, result: 'result', error: 'error' }); sink.finish({ status }); })], msg => assert.ok(!('watching' in msg.data)), async info => { delivered.push(info); });
    const info = await manager.start('codex', opts, reg.installationId);
    assert.equal(info.watching, false); assert.equal(delivered.length, 1); assert.equal(delivered[0].status, status);
  }
  let sink!: TaskSink;
  const delivered: TaskInfo[] = [];
  const manager = new TaskManager([adapter(s => { sink = s; })], () => {}, async info => { delivered.push(info); });
  const info = await manager.start('codex', opts, reg.installationId);
  manager.cancel(info.id); sink.finish({ status: 'completed' });
  assert.equal(delivered.length, 1); assert.equal(delivered[0].status, 'cancelled');
  const broken = adapter(() => { throw new Error('start failure'); });
  const failed = new TaskManager([broken], () => {}, async info => { delivered.push(info); });
  await failed.start('codex', opts, reg.installationId);
  assert.equal(delivered.length, 2); assert.equal(delivered[1].status, 'failed');
});
test('watch belongs to installation and does not enter broadcasts; unwatch and terminal watch', async () => {
  let sink!: TaskSink;
  const sent: string[] = [];
  const manager = new TaskManager([adapter(s => { sink = s; })], msg => assert.ok(!('watching' in msg.data)), async (_info, id) => { sent.push(id); });
  const info = await manager.start('codex', opts, 'phone-a');
  assert.equal(manager.get(info.id, 0, 'phone-a').task.watching, true);
  assert.equal(manager.list('phone-b')[0].watching, false);
  manager.watch(info.id, 'phone-b', true); manager.watch(info.id, 'phone-a', false);
  sink.finish({ status: 'completed' });
  assert.deepEqual(sent, ['phone-b']);
  assert.deepEqual(manager.watch(info.id, 'phone-a', true), { taskId: info.id, watching: false, status: 'completed' });
});
test('push status changes, network retries, invalid-token deletion, replacement and oldest-registration eviction', async () => {
  const listeners = new Set<() => void>(), delays: number[] = [], changes: unknown[] = [], logs: string[] = [];
  let mode = 'disabled', attempts = 0;
  const account = { status: { user: { id: 'user' }, state: 'online' } as PushAccount['status'], subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); },
    async authorizedRequest() {
      attempts++;
      if (mode === 'disabled') throw new AccountError(503, 'push_disabled');
      if (mode === 'invalid') throw new AccountError(410, 'token_invalid');
      if (mode === 'always-network' || (mode === 'network' && attempts < 3)) throw new AccountNetworkError(new Error('private input'));
      return { ok: true };
    } } as PushAccount;
  const push = new PushManager(config, account, s => changes.push(s), s => logs.push(s), async ms => { delays.push(ms); });
  push.register(reg); await push.send(task, reg.installationId);
  assert.deepEqual(push.status, { available: false, reason: 'server_disabled' });
  mode = 'network'; attempts = 0; await push.send(task, reg.installationId);
  assert.deepEqual(delays, [1000, 5000]); assert.equal(attempts, 3); assert.deepEqual(push.status, { available: true });
  mode = 'always-network'; attempts = 0;
  await push.send(task, reg.installationId);
  assert.equal(attempts, 3); assert.deepEqual(delays, [1000, 5000, 1000, 5000]);
  mode = 'invalid'; await push.send(task, reg.installationId); assert.equal(push.has(reg.installationId), false);
  push.register(reg);
  const other = { ...reg, installationId: randomUUID() }; push.register(other); push.register(reg);
  for (let i = 0; i < 19; i++) push.register({ ...reg, installationId: randomUUID() });
  assert.equal(push.has(other.installationId), false); assert.equal(push.has(reg.installationId), true);
  account.status.user = null; account.status.state = 'signedOut'; for (const fn of listeners) fn();
  assert.deepEqual(push.status, { available: false, reason: 'signed_out' });
  assert.equal(changes.length, 3); assert.ok(!logs.join('').includes(reg.apnsToken));
  push.close(); assert.equal(listeners.size, 0);
});
test('signed-out hello reports push unavailable', async () => {
  assert.deepEqual((await bridgeHello(config, [])).push, { available: false, reason: 'signed_out' });
});

test('RPC connection watch isolation and disconnected phone push via fake authenticated HTTP service', async t => {
  t.mock.method(Server.prototype, 'listen', function (this: Server, ...args: any[]) { queueMicrotask(() => args.at(-1)()); return this; });
  const received: { url: string; auth: string | undefined; body: any }[] = [];
  let responseCode = 200;
  const fake = createServer((req, res) => {
    let text = ''; req.on('data', data => { text += data; }); req.on('end', () => {
      received.push({ url: req.url!, auth: req.headers.authorization, body: JSON.parse(text) });
      const body = JSON.stringify(responseCode === 200 ? { ok: true } : { error: { code: 'token_invalid' } });
      res.writeHead(responseCode, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }).end(body);
    });
  });
  const cfg = { ...config, port: 0, serverUrl: 'http://127.0.0.1:1234' };
  const fetcher: typeof fetch = async (input, init) => new Promise(resolve => {
    const output: Buffer[] = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { output.push(Buffer.from(chunk)); done(); } });
    const req = new IncomingMessage(new Socket());
    req.method = init!.method; req.url = new URL(String(input)).pathname;
    req.headers = Object.fromEntries(new Headers(init!.headers));
    req.httpVersion = '1.1'; req.httpVersionMajor = 1; req.httpVersionMinor = 1;
    const res = new ServerResponse(req); res.assignSocket(socket as Socket);
    res.on('finish', () => {
      const bytes = Buffer.concat(output), boundary = bytes.indexOf('\r\n\r\n');
      const status = Number(bytes.subarray(0, boundary).toString().split(' ')[1]);
      resolve(new Response(bytes.subarray(boundary + 4), { status, headers: { 'content-type': 'application/json' } }));
      socket.destroy(); req.socket.destroy();
    });
    fake.emit('request', req, res); req.push(Buffer.from(String(init!.body))); req.push(null);
  });
  // Exercise AccountClient's real authorized request without writing an account file.
  const client = new AccountClient({ config: cfg, bridgeVersion: 'test', fetch: fetcher, log: () => {} });
  Object.assign(client, { account: { serverUrl: cfg.serverUrl, user: { id: 'user' }, refreshToken: 'unused' }, accessToken: 'access-token', expiresAt: Date.now() + 3600_000 });
  const logs: string[] = [], messages: any[][] = [[], []];
  const sinks: TaskSink[] = [];
  const bridge = await startServer(cfg, [adapter(s => sinks.push(s))], s => logs.push(s), undefined, undefined, client);
  t.after(() => { bridge.emit('close'); bridge.close(() => {}); fake.close(() => {}); });
  const connect = (index: number) => bridge.attachClient({ kind: 'relay', remote: 'test', send: text => messages[index].push(JSON.parse(text)), close() {} });
  const a = connect(0), b = connect(1);
  let id = 0;
  const rpc = async (connection: typeof a, index: number, method: string, params: unknown = {}) => {
    const callId = ++id; await connection.receive(JSON.stringify({ id: callId, method, params })); return messages[index].find(m => m.id === callId);
  };
  assert.equal((await rpc(b, 1, 'tasks.watch', { taskId: 'x', watch: true })).error.message, 'Register for notifications first');
  assert.ok((await rpc(a, 0, 'push.register', { ...reg, environment: 'invalid' })).error);
  assert.deepEqual((await rpc(a, 0, 'push.register', reg)).result, { push: { available: true } });
  const info = (await rpc(a, 0, 'tasks.start', { agent: 'codex', ...opts, watch: true })).result;
  assert.equal(info.watching, true);
  assert.equal((await rpc(a, 0, 'tasks.get', { taskId: info.id })).result.task.watching, true);
  assert.equal((await rpc(b, 1, 'tasks.list')).result[0].watching, undefined);
  const regB = { ...reg, installationId: randomUUID() };
  await rpc(b, 1, 'push.register', regB);
  assert.equal((await rpc(b, 1, 'tasks.get', { taskId: info.id })).result.task.watching, false);
  await rpc(b, 1, 'tasks.watch', { taskId: info.id, watch: true });
  await rpc(b, 1, 'tasks.watch', { taskId: info.id, watch: false });
  a.disconnect(); sinks[0].finish({ status: 'completed', result: 'Private summary' }); sinks[0].finish({ status: 'failed' });
  for (let i = 0; i < 200 && received.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(received.length, 1);
  assert.equal(received[0].url, `/v1/devices/${cfg.deviceId}/notify`); assert.equal(received[0].auth, 'Bearer access-token');
  assert.deepEqual(Object.keys(received[0].body).sort(), ['apnsToken', 'ciphertext', 'environment']);
  assert.equal(JSON.parse(open(received[0].body.ciphertext)).summary, 'Private summary');
  assert.ok(messages.flat().filter(m => m.event === 'task.updated').every(m => !('watching' in m.data)));
  assert.ok(logs.every(s => !s.includes(received[0].body.ciphertext) && !s.includes('Private summary')));
  responseCode = 410;
  const next = (await rpc(b, 1, 'tasks.start', { agent: 'codex', ...opts, watch: true })).result;
  sinks[1].finish({ status: 'failed', error: 'Private error' });
  for (let i = 0; i < 200; i++) {
    await immediate();
    const r = await rpc(b, 1, 'tasks.watch', { taskId: next.id, watch: true });
    if (r.error) break;
    if (i === 199) assert.fail('Invalid token registration was not deleted');
  }
  assert.equal((await rpc(b, 1, 'tasks.watch', { taskId: next.id, watch: true })).error.message, 'Register for notifications first');
  assert.equal(JSON.parse(open(received[1].body.ciphertext)).status, 'failed');
  responseCode = 200;
  await rpc(b, 1, 'push.register', regB);
  const cancelled = (await rpc(b, 1, 'tasks.start', { agent: 'codex', ...opts, watch: true })).result;
  await rpc(b, 1, 'tasks.cancel', { taskId: cancelled.id });
  sinks[2].finish({ status: 'cancelled' });
  for (let i = 0; i < 200 && received.length < 3; i++) await immediate();
  assert.equal(received.length, 3);
  assert.equal(JSON.parse(open(received[2].body.ciphertext)).status, 'cancelled');
  assert.equal(JSON.parse(open(received[2].body.ciphertext)).summary, '');
  assert.deepEqual((await rpc(b, 1, 'tasks.watch', { taskId: cancelled.id, watch: true })).result, { taskId: cancelled.id, watching: false, status: 'cancelled' });
  for (const secret of [reg.apnsToken, reg.publicKey, received[0].body.ciphertext, 'Private title', 'Private summary', 'Private error']) assert.ok(!logs.join('\n').includes(secret));
});

test('interrupted HTTP response bodies use bounded retries through AccountClient', async () => {
  let attempts = 0;
  const delays: number[] = [];
  const client = new AccountClient({ config, bridgeVersion: 'test', fetch: async () => {
    attempts++;
    if (attempts <= 2) return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('connection lost after headers')); } }));
    return new Response(JSON.stringify({ ok: true }));
  } });
  Object.assign(client, { account: { serverUrl: config.serverUrl, user: { id: 'user' } }, accessToken: 'unused', expiresAt: Date.now() + 3600_000 });
  const push = new PushManager(config, client, () => {}, () => {}, async ms => { delays.push(ms); });
  push.register(reg); await push.send(task, reg.installationId);
  assert.equal(attempts, 3); assert.deepEqual(delays, [1000, 5000]); push.close();
});

test('late token-invalid response preserves a refreshed installation registration', async () => {
  let reject!: (error: Error) => void;
  const account = { status: { user: { id: 'user' }, state: 'online', serverUrl: config.serverUrl }, subscribe() { return () => {}; },
    authorizedRequest: () => new Promise((_resolve, rejectRequest) => { reject = rejectRequest; }) } as PushAccount;
  const push = new PushManager(config, account, () => {}, () => {});
  push.register(reg);
  const pending = push.send(task, reg.installationId);
  push.register({ ...reg, apnsToken: 'ef'.repeat(32) });
  reject(new AccountError(410, 'token_invalid')); await pending;
  assert.equal(push.has(reg.installationId), true); push.close();
});
