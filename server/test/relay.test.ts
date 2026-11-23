import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { createApp } from '../src/app.ts';
import { initializeDatabase, openDatabase } from '../src/db.ts';
import { publicKey } from '../src/devices.ts';
import { CLOSE, DATA, OPEN, MAX_BUFFERED, attachRelay, createUpgradeLimiter, decodeFrame, encodeFrame, relayParameters } from '../src/relay.ts';
import { signToken } from '../src/tokens.ts';
import { fixture, initialTime, keys, secret } from './helpers.ts';

const deviceBody = { name: 'Mac', hosts: ['127.0.0.1'], port: 8787, bridgeVersion: '0.1' };

test('relay frames use a five-byte big-endian header and preserve arbitrary binary bytes', () => {
  const payload = Buffer.from([0, 255, 128, 1, 13, 10, 0]);
  const bytes = encodeFrame(DATA, 0x12345678, payload);
  assert.deepEqual(bytes.subarray(0, 5), Buffer.from([2, 0x12, 0x34, 0x56, 0x78]));
  assert.deepEqual(decodeFrame(bytes), { type: DATA, channel: 0x12345678, payload });
  for (const type of [OPEN, CLOSE] as const) {
    assert.deepEqual(decodeFrame(encodeFrame(type, 0xffff_ffff)), { type, channel: 0xffff_ffff, payload: Buffer.alloc(0) });
  }
  assert.deepEqual(decodeFrame(encodeFrame(DATA, 1)), { type: DATA, channel: 1, payload: Buffer.alloc(0) });
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(4), Buffer.from([99, 0, 0, 0, 1]),
    Buffer.from([2, 0, 0, 0, 0]), Buffer.from([1, 0, 0, 0, 1, 5]), Buffer.from([3, 0, 0, 0, 1, 5])]) {
    assert.equal(decodeFrame(bytes), null);
  }
  for (const channel of [0, -1, 1.5, 0x1_0000_0000, NaN]) assert.throws(() => encodeFrame(DATA, channel), RangeError);
  assert.throws(() => encodeFrame(OPEN, 1, payload), RangeError);
});

test('relay parameters accept only exact endpoints and one valid device UUID', () => {
  const id = randomUUID();
  assert.deepEqual(relayParameters(`/v1/relay/bridge?device=${id.toUpperCase()}`), { role: 'bridge', device: id });
  assert.deepEqual(relayParameters(`/v1/relay/phone?device=${id}`), { role: 'phone', device: id });
  for (const url of ['/other', `/v1/relay/bridge/?device=${id}`, '/v1/relay/phone', '/v1/relay/phone?device=',
    '/v1/relay/phone?device=invalid', `/v1/relay/phone?device=${id}&device=${id}`]) {
    assert.throws(() => relayParameters(url), { status: 404 });
  }
});

test('public keys require canonical unpadded base64url with exactly 32 decoded bytes', () => {
  const key = Buffer.alloc(32, 255).toString('base64url');
  assert.equal(publicKey(key), key);
  assert.equal(publicKey(Buffer.alloc(32).toString('base64url')), 'A'.repeat(43));
  for (const value of [null, undefined, 123, '', key + '=', key.replace(/_/g, '/'), ' ' + key,
    Buffer.alloc(31).toString('base64url'), Buffer.alloc(33).toString('base64url'), 'A'.repeat(42) + 'B']) {
    assert.throws(() => publicKey(value), { status: 400, code: 'invalid_request' });
  }
});

test('old device databases automatically gain a nullable public_key without losing records', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
    hosts TEXT NOT NULL, port INTEGER NOT NULL, bridge_version TEXT NOT NULL,
    last_seen_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO devices VALUES ('legacy', 'owner', 'Mac', '["localhost"]', 8787, '0.1', 1, 1);`);
  initializeDatabase(db);
  assert.equal(db.prepare('SELECT public_key FROM devices WHERE id = ?').get('legacy')!.public_key, null);
  db.prepare('UPDATE devices SET public_key = ?').run('preserved');
  initializeDatabase(db);
  assert.equal(db.prepare('SELECT public_key FROM devices WHERE id = ?').get('legacy')!.public_key, 'preserved');
});

test('device HTTP API validates and persists publicKey, preserving it on older heartbeats', async t => {
  const f = await fixture(t);
  const owner = await f.login('key-owner@example.com');
  const auth = { token: owner.accessToken };
  const id = randomUUID();
  const key = Buffer.alloc(32, 42).toString('base64url');
  const first = await f.request('PUT', `/devices/${id}`, deviceBody, auth);
  assert.equal(first.body.publicKey, null);
  assert.equal(first.body.relayOnline, false);
  assert.equal((await f.request('PUT', `/devices/${id}`, { ...deviceBody, publicKey: key }, auth)).status, 200);
  assert.equal((await f.request('PUT', `/devices/${id}`, deviceBody, auth)).body.publicKey, key);
  for (const publicKey of [null, 123, key + '=', 'A'.repeat(42) + 'B']) {
    const result = await f.request('PUT', `/devices/${id}`, { ...deviceBody, publicKey }, auth);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'invalid_request');
  }
  const listed = (await f.request('GET', '/devices', undefined, auth)).body.devices[0];
  assert.equal(listed.publicKey, key);
  assert.equal(listed.relayOnline, false);
});

test('phone upgrade limiter allows 60 per IP in a rolling minute and supplies retryAfter', () => {
  let time = initialTime;
  const limiter = createUpgradeLimiter(() => time);
  for (let i = 0; i < 60; i++) { limiter.check('one'); time += 100; }
  assert.throws(() => limiter.check('one'), { status: 429, code: 'rate_limited', retryAfter: 54 });
  limiter.check('two');
  time = initialTime + 60_000;
  limiter.check('one');
  assert.throws(() => limiter.check('one'), { status: 429, retryAfter: 1 });
  time += 60_000;
  limiter.prune();
  limiter.check('one');
  limiter.clear();
  limiter.check('one');
});

// Exercise timer/backpressure branches without OS ports or filling a real TCP queue.
// Only the WebSocket upgrade boundary is substituted; the relay's handlers are real.
class TestSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: Buffer[] = [];
  pings = 0;
  terminated = false;
  closure?: { code: number; reason: string };
  send(data: Buffer, _options: unknown, callback: (error?: Error) => void) { this.sent.push(data); callback(); }
  ping() { this.pings++; }
  close(code: number, reason: string) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.closure = { code, reason };
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
  terminate() { this.terminated = true; this.close(1006, 'terminated'); }
}

function coreFixture(t: TestContext) {
  const db = openDatabase();
  const id = randomUUID();
  const owner = randomUUID();
  db.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').run(owner, initialTime);
  db.prepare(`INSERT INTO devices (id, user_id, name, hosts, port, bridge_version, last_seen_at, created_at)
    VALUES (?, ?, 'Mac', '["localhost"]', 8787, '0.1', ?, ?)`).run(id, owner, initialTime, initialTime);
  const server = createServer();
  const logs: string[] = [];
  const relay = attachRelay(server, { db, authenticate: () => owner, clientIp: () => 'ip', log: line => logs.push(line) });
  let next!: TestSocket;
  t.mock.method(WebSocketServer.prototype, 'handleUpgrade', (_req: unknown, _socket: unknown, _head: unknown,
    callback: (ws: WebSocket) => void) => callback(next as unknown as WebSocket));
  const sockets: Socket[] = [];
  t.after(() => { relay.dispose(); for (const socket of sockets) socket.destroy(); db.close(); });
  function connect(role: 'bridge' | 'phone') {
    next = new TestSocket();
    const socket = new Socket();
    sockets.push(socket);
    const req = new IncomingMessage(socket);
    req.url = `/v1/relay/${role}?device=${id}`;
    req.headers.authorization = 'Bearer test';
    server.emit('upgrade', req, socket, Buffer.alloc(0));
    return next;
  }
  return { relay, connect, id, logs, server };
}

test('relay counts discarded bridge frames and keeps counters/logs free of payloads', t => {
  const f = coreFixture(t);
  const bridge = f.connect('bridge');
  const phone = f.connect('phone');
  const payload = Buffer.from('sensitive payload that must never be logged');
  for (const bytes of [Buffer.alloc(4), Buffer.from([99, 0, 0, 0, 1]), encodeFrame(DATA, 999, payload),
    encodeFrame(OPEN, 1), Buffer.from([3, 0, 0, 0, 1, 5])]) bridge.emit('message', bytes, true);
  assert.equal(f.relay.stats().invalidBridgeFrames, 5);
  assert.equal(phone.sent.length, 0);
  bridge.emit('message', encodeFrame(DATA, 1, payload), true);
  assert.deepEqual(phone.sent, [payload]);
  assert.ok(!f.logs.join('\n').includes(payload.toString()));
});

test('backpressure above 4 MiB closes only the affected channel with 1013', t => {
  const f = coreFixture(t);
  const bridge = f.connect('bridge');
  const first = f.connect('phone');
  const second = f.connect('phone');
  first.bufferedAmount = MAX_BUFFERED + 1;
  bridge.emit('message', encodeFrame(DATA, 1, Buffer.from('blocked')), true);
  assert.equal(first.closure?.code, 1013);
  assert.equal(decodeFrame(bridge.sent.at(-1)!)!.type, CLOSE);
  assert.equal(second.closure, undefined);
  assert.equal(f.relay.isOnline(f.id), true);
  second.bufferedAmount = MAX_BUFFERED;
  bridge.emit('message', encodeFrame(DATA, 2, Buffer.from('at threshold')), true);
  assert.equal(second.closure, undefined);
  bridge.bufferedAmount = MAX_BUFFERED + 1;
  second.emit('message', Buffer.from('slow bridge'), true);
  assert.deepEqual(second.closure, { code: 1013, reason: 'backpressure' });
  assert.equal(bridge.closure, undefined);
});

test('relay pings both endpoints every 25s and terminates a bridge at 60s without pong', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const f = coreFixture(t);
  const bridge = f.connect('bridge');
  const phone = f.connect('phone');
  t.mock.timers.tick(25_000);
  assert.equal(bridge.pings, 1);
  assert.equal(phone.pings, 1);
  t.mock.timers.tick(34_999);
  assert.equal(f.relay.isOnline(f.id), true);
  t.mock.timers.tick(1);
  assert.equal(bridge.terminated, true);
  assert.equal(f.relay.isOnline(f.id), false);
  assert.equal(phone.closure?.code, 1012);
});

test('pong resets the 60s deadline; a stale phone closes its channel while bridge stays online', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const f = coreFixture(t);
  const bridge = f.connect('bridge');
  const phone = f.connect('phone');
  t.mock.timers.tick(50_000);
  bridge.emit('pong');
  t.mock.timers.tick(10_000);
  assert.equal(phone.terminated, true);
  assert.equal(f.relay.isOnline(f.id), true);
  assert.deepEqual(decodeFrame(bridge.sent.at(-1)!), { type: CLOSE, channel: 1, payload: Buffer.alloc(0) });
  t.mock.timers.tick(49_999);
  assert.equal(f.relay.isOnline(f.id), true);
  t.mock.timers.tick(1);
  assert.equal(bridge.terminated, true);
});

test('HTTP server.close synchronously disposes bridge and channels before waiting for sockets', t => {
  const f = coreFixture(t);
  const bridge = f.connect('bridge');
  const phone = f.connect('phone');
  f.server.close(() => {});
  assert.equal(f.relay.isOnline(f.id), false);
  assert.deepEqual(bridge.closure, { code: 1001, reason: 'server_shutdown' });
  assert.deepEqual(phone.closure, { code: 1001, reason: 'server_shutdown' });
});

const listening = { skip: process.env.AA_TEST_LISTEN !== '1' ? 'Set AA_TEST_LISTEN=1 to run real WebSocket clients' : false, timeout: 15_000 };

// Register message/close queues before opening: OPEN and immediate close can arrive
// before await connect() resumes. No sleeps or races between attaching listeners.
class Peer {
  ws: WebSocket;
  opened: Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
  #messages: { bytes: Buffer; binary: boolean }[] = [];
  #waiters: ((value: { bytes: Buffer; binary: boolean }) => void)[] = [];
  constructor(url: string, headers: Record<string, string>) {
    this.ws = new WebSocket(url, { headers });
    this.opened = new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); });
    this.closed = new Promise(resolve => this.ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    this.ws.on('message', (data, binary) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      const message = { bytes, binary };
      const waiter = this.#waiters.shift();
      if (waiter) waiter(message); else this.#messages.push(message);
    });
  }
  async message() {
    const received = this.#messages.shift() ?? await new Promise<{ bytes: Buffer; binary: boolean }>(resolve => this.#waiters.push(resolve));
    assert.equal(received.binary, true);
    return received.bytes;
  }
  async frame() {
    const frame = decodeFrame(await this.message());
    assert.ok(frame);
    return frame;
  }
}

async function relayFixture(t: TestContext, trustProxy = false) {
  const db = openDatabase();
  const clients: WebSocket[] = [];
  const logs: string[] = [];
  let time = initialTime;
  const owner = randomUUID();
  const other = randomUUID();
  const id = randomUUID();
  const key = Buffer.alloc(32, 24).toString('base64url');
  for (const user of [owner, other]) db.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').run(user, time);
  db.prepare(`INSERT INTO devices (id, user_id, name, hosts, port, bridge_version, public_key, last_seen_at, created_at)
    VALUES (?, ?, 'Mac', '["localhost"]', 8787, '0.1', ?, ?, ?)`).run(id, owner, key, time, time);
  const sender = { async send() {} };
  const server = createApp({ db, signingKey: keys.privateKey, serverSecret: secret, trustProxy,
    now: () => time, senders: { email: sender, sms: sender }, log: message => logs.push(message) });
  t.after(async () => {
    for (const ws of clients) ws.terminate();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    db.close();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = base.replace('http:', 'ws:');
  function token(user = owner, typ: 'access' | 'connect' = 'access', exp = 900) {
    const iat = Math.floor(time / 1000);
    return signToken({ sub: user, typ, iat, exp: iat + exp, ...(typ === 'connect' ? { dev: id } : {}) }, keys.privateKey);
  }
  async function connect(role: 'bridge' | 'phone', headers: Record<string, string> = {}) {
    const peer = new Peer(`${wsBase}/v1/relay/${role}?device=${id}`, { authorization: `Bearer ${token()}`, ...headers });
    clients.push(peer.ws);
    await peer.opened;
    return peer;
  }
  function rejected(path: string, auth?: string, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; retryAfter?: string }>((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}${path}`, { headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...headers } });
      clients.push(ws);
      ws.once('unexpected-response', (_req, res) => {
        res.resume();
        resolve({ status: res.statusCode!, retryAfter: res.headers['retry-after'] });
        ws.terminate();
      });
      ws.once('open', () => { ws.terminate(); reject(new Error('Unexpected successful upgrade')); });
      ws.on('error', () => {});
    });
  }
  async function request(method: string, path: string) {
    const response = await fetch(`${base}/v1${path}`, { method, headers: { authorization: `Bearer ${token()}` } });
    return { status: response.status, body: await response.json() as any };
  }
  return { connect, rejected, request, token, id, other, key, logs, advance(ms: number) { time += ms; } };
}

test('relay upgrade rejects missing, wrong, expired or connect tokens and foreign/missing devices', listening, async t => {
  const f = await relayFixture(t);
  for (const role of ['bridge', 'phone']) {
    const path = `/v1/relay/${role}?device=${f.id}`;
    for (const token of [undefined, 'wrong', f.token(undefined, 'connect', 300)]) {
      assert.equal((await f.rejected(path, token)).status, 401);
    }
    assert.equal((await f.rejected(path, f.token(f.other))).status, 403);
    assert.equal((await f.rejected(`/v1/relay/${role}?device=${randomUUID()}`, f.token())).status, 404);
  }
  const expired = f.token();
  f.advance(900_000);
  assert.equal((await f.rejected(`/v1/relay/bridge?device=${f.id}`, expired)).status, 401);
  assert.equal((await f.rejected('/unknown', f.token())).status, 404);
});

test('relay multiplexes OPEN/DATA/CLOSE and leaves unrelated phone channels intact', listening, async t => {
  const f = await relayFixture(t);
  assert.equal((await f.request('GET', '/devices')).body.devices[0].relayOnline, false);
  const bridge = await f.connect('bridge');
  const device = (await f.request('GET', '/devices')).body.devices[0];
  assert.equal(device.relayOnline, true);
  assert.equal(device.publicKey, f.key);
  const first = await f.connect('phone');
  assert.deepEqual(await bridge.frame(), { type: OPEN, channel: 1, payload: Buffer.alloc(0) });
  const second = await f.connect('phone');
  assert.equal((await bridge.frame()).channel, 2);
  const payload = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  first.ws.send(payload);
  assert.deepEqual(await bridge.frame(), { type: DATA, channel: 1, payload });
  bridge.ws.send(encodeFrame(DATA, 2, payload));
  assert.deepEqual(await second.message(), payload);
  second.ws.send(Buffer.alloc(0));
  assert.deepEqual(await bridge.frame(), { type: DATA, channel: 2, payload: Buffer.alloc(0) });
  first.ws.close();
  assert.deepEqual(await bridge.frame(), { type: CLOSE, channel: 1, payload: Buffer.alloc(0) });
  bridge.ws.send(encodeFrame(DATA, 2, Buffer.from('still connected')));
  assert.equal((await second.message()).toString(), 'still connected');
  bridge.ws.send(encodeFrame(CLOSE, 2));
  assert.equal((await second.closed).code, 1000);
  const third = await f.connect('phone');
  assert.equal((await bridge.frame()).channel, 3);
  third.ws.close();
  assert.equal((await bridge.frame()).type, CLOSE);
  assert.ok(!f.logs.join('\n').includes('still connected'));
});

test('account deletion closes the existing bridge and every phone channel and rejects reconnection', listening, async t => {
  const f = await relayFixture(t);
  const bridge = await f.connect('bridge');
  const first = await f.connect('phone');
  await bridge.frame();
  const second = await f.connect('phone');
  await bridge.frame();
  assert.equal((await f.request('DELETE', '/me')).status, 200);
  for (const peer of [bridge, first, second]) {
    assert.deepEqual(await peer.closed, { code: 1001, reason: 'device_deleted' });
  }
  for (const role of ['bridge', 'phone']) {
    assert.equal((await f.rejected(`/v1/relay/${role}?device=${f.id}`, f.token())).status, 401);
  }
});

test('bridge offline closes phone with 4404; replacement closes old bridge and all its channels', listening, async t => {
  const f = await relayFixture(t);
  assert.deepEqual(await (await f.connect('phone')).closed, { code: 4404, reason: 'bridge_offline' });
  const old = await f.connect('bridge');
  const phone = await f.connect('phone');
  await old.frame();
  const replacement = await f.connect('bridge');
  assert.deepEqual(await old.closed, { code: 4000, reason: 'replaced' });
  assert.equal((await phone.closed).code, 1012);
  const next = await f.connect('phone');
  assert.equal((await replacement.frame()).channel, 1);
  replacement.ws.close();
  assert.equal((await next.closed).code, 1012);
  assert.equal((await f.request('GET', '/devices')).body.devices[0].relayOnline, false);
});

test('ninth phone closes with 4429; channel cleanup releases capacity without reusing IDs', listening, async t => {
  const f = await relayFixture(t);
  const bridge = await f.connect('bridge');
  const phones: Peer[] = [];
  for (let i = 1; i <= 8; i++) {
    phones.push(await f.connect('phone'));
    assert.equal((await bridge.frame()).channel, i);
  }
  assert.deepEqual(await (await f.connect('phone')).closed, { code: 4429, reason: 'too_many_channels' });
  phones[0].ws.close();
  assert.equal((await bridge.frame()).type, CLOSE);
  await f.connect('phone');
  assert.equal((await bridge.frame()).channel, 9);
});

test('deleting a device closes its bridge and phones and prevents new upgrades', listening, async t => {
  const f = await relayFixture(t);
  const bridge = await f.connect('bridge');
  const phones = [await f.connect('phone'), await f.connect('phone')];
  assert.equal((await f.request('DELETE', `/devices/${f.id}`)).status, 200);
  assert.deepEqual(await bridge.closed, { code: 1001, reason: 'device_deleted' });
  for (const phone of phones) assert.equal((await phone.closed).code, 1001);
  assert.deepEqual((await f.request('GET', '/devices')).body.devices, []);
  assert.equal((await f.rejected(`/v1/relay/bridge?device=${f.id}`, f.token())).status, 404);
});

test('invalid bridge frames are discarded; text closes only the offending connection', listening, async t => {
  const f = await relayFixture(t);
  const bridge = await f.connect('bridge');
  const phone = await f.connect('phone');
  await bridge.frame();
  for (const bytes of [Buffer.alloc(4), Buffer.from([99, 0, 0, 0, 1]), encodeFrame(DATA, 999, Buffer.from('unknown')),
    encodeFrame(OPEN, 1), Buffer.from([3, 0, 0, 0, 1, 5])]) bridge.ws.send(bytes);
  bridge.ws.send(encodeFrame(DATA, 1, Buffer.from('valid')));
  assert.equal((await phone.message()).toString(), 'valid');
  phone.ws.send('text must not relay');
  assert.equal((await phone.closed).code, 1003);
  assert.equal((await bridge.frame()).type, CLOSE);
  const next = await f.connect('phone');
  await bridge.frame();
  bridge.ws.send('bridge text');
  assert.equal((await bridge.closed).code, 1003);
  assert.equal((await next.closed).code, 1003);
  assert.equal((await f.request('GET', '/devices')).body.devices[0].relayOnline, false);
});

test('1 MiB maxPayload closes oversized phone and bridge binary messages with 1009', listening, async t => {
  const f = await relayFixture(t);
  const bridge = await f.connect('bridge');
  const phone = await f.connect('phone');
  await bridge.frame();
  phone.ws.send(Buffer.alloc(1024 * 1024 + 1));
  assert.equal((await phone.closed).code, 1009);
  assert.equal((await bridge.frame()).type, CLOSE);
  bridge.ws.send(Buffer.alloc(1024 * 1024 + 1));
  assert.equal((await bridge.closed).code, 1009);
});

test('trusted final XFF IP shares 60/min quota despite forged prefixes; bridge upgrades are exempt', listening, async t => {
  const f = await relayFixture(t, true);
  const path = `/v1/relay/phone?device=${f.id}`;
  for (let i = 0; i < 60; i++) {
    assert.equal((await f.rejected(path, undefined, { 'x-forwarded-for': `198.51.100.${i}, 203.0.113.1` })).status, 401);
  }
  assert.deepEqual(await f.rejected(path, f.token(), { 'x-forwarded-for': '198.51.100.99, 203.0.113.1' }),
    { status: 429, retryAfter: '60' });
  assert.equal((await f.rejected(path, undefined, { 'x-forwarded-for': '203.0.113.2' })).status, 401);
  await f.connect('bridge', { 'x-forwarded-for': '203.0.113.1' });
  f.advance(60_000);
  const phone = await f.connect('phone', { 'x-forwarded-for': '203.0.113.1' });
  phone.ws.close();
});

test('untrusted XFF cannot bypass phone upgrade quota', listening, async t => {
  const f = await relayFixture(t);
  const path = `/v1/relay/phone?device=${f.id}`;
  for (let i = 0; i < 60; i++) {
    assert.equal((await f.rejected(path, undefined, { 'x-forwarded-for': `203.0.113.${i}` })).status, 401);
  }
  assert.equal((await f.rejected(path, f.token(), { 'x-forwarded-for': '203.0.113.99' })).status, 429);
});
