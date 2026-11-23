import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { setImmediate as immediate } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { RelayClient, frame, reconnectDelay } from '../src/relay.ts';
import { phoneHandshake, publicKey, transport } from '../src/relayCrypto.ts';
import { startServer } from '../src/server.ts';
import { config, publicKeyPem, ticket } from './accountHelpers.ts';
import type { AccountStatus } from '../src/account.ts';

const listen = { skip: process.env.AA_TEST_LISTEN !== '1' ? 'Requires listening permission; run AA_TEST_LISTEN=1 npm test' : false, timeout: 10_000 };
async function until(condition: () => boolean) {
  for (let i = 0; i < 10000; i++) { if (condition()) return; await immediate(); }
  assert.fail('Condition did not become true');
}
function account(serverUrl: string) {
  const listeners = new Set<() => void>();
  const a = {
    user: { id: 'user-1' } as { id: string } | undefined,
    publicKeyPem,
    get status(): AccountStatus { return { user: a.user ?? null, serverUrl, state: a.user ? 'online' : 'signedOut' }; },
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    async getAccessToken() { return 'test-access-token'; },
    async registerDevice() { return !!a.user; },
    stops: 0,
    stop() { a.stops++; },
    logout() { a.user = undefined; for (const fn of listeners) fn(); },
    login() { a.user = { id: 'user-1' }; for (const fn of listeners) fn(); },
  };
  return a;
}
function inbox(ws: WebSocket) {
  const messages: Buffer[] = [];
  ws.on('message', data => messages.push(Buffer.from(data as Buffer)));
  return async (id: number, type = 2) => {
    await until(() => messages.some(b => b[0] === type && b.readUInt32BE(1) === id));
    const index = messages.findIndex(b => b[0] === type && b.readUInt32BE(1) === id);
    return messages.splice(index, 1)[0].subarray(5);
  };
}

test('relay backoff saturates and replacement always waits longest', () => {
  assert.deepEqual(Array.from({ length: 7 }, (_, i) => reconnectDelay(i)), [1000, 2000, 5000, 10000, 30000, 30000, 30000]);
  assert.equal(reconnectDelay(0, true), 30000);
});

test('multiplexed handshake, ticket, shared RPC/push, invalid auth/ciphertext isolation and logout', listen, async t => {
  const fake = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(fake, 'listening');
  const addr = fake.address(); assert.ok(addr && typeof addr !== 'string');
  const url = `http://127.0.0.1:${addr.port}`;
  const a = account(url), logs: string[] = [];
  const secret = randomBytes(32), identity = { privateKey: secret, publicKey: publicKey(secret).toString('base64url') };
  const cfg = { ...config, port: 0, serverUrl: url, publicKey: identity.publicKey };
  const server = await startServer(cfg, [], s => logs.push(s));
  const relay = new RelayClient({ config: cfg, identity, account: a, attachClient: server.attachClient, log: s => logs.push(s) });
  t.after(async () => { relay.stop(); for (const ws of fake.clients) ws.terminate(); await server.shutdown(); await new Promise<void>(r => fake.close(() => r())); });
  const connected = once(fake, 'connection');
  relay.start();
  const [ws, req] = await connected as [WebSocket, { url: string; headers: Record<string, string> }];
  assert.equal(req.url, `/v1/relay/bridge?device=${config.deviceId}`);
  assert.equal(req.headers.authorization, 'Bearer test-access-token');
  const next = inbox(ws);
  const handshake = async (id: number) => {
    const privateBytes = randomBytes(32);
    ws.send(frame(1, id)); ws.send(frame(2, id, Buffer.concat([Buffer.from([1]), publicKey(privateBytes)])));
    const msg2 = await next(id);
    return transport(phoneHandshake(privateBytes, publicKey(secret), cfg.deviceId, msg2), 'phone');
  };
  const time = Math.floor(Date.now() / 1000);
  const credential = ticket({ iat: time, exp: time + 300 });
  const phone = await handshake(1);
  ws.send(frame(2, 1, phone.seal(JSON.stringify({ auth: credential }))));
  assert.deepEqual(JSON.parse(phone.open(await next(1))), { auth: 'ok' });
  assert.equal(server.clientCount(), 1);
  assert.deepEqual(relay.status, { state: 'online', channels: 1 });
  ws.send(frame(2, 1, phone.seal('{"id":1,"method":"hello"}')));
  const hello = JSON.parse(phone.open(await next(1)));
  assert.equal(hello.result.deviceId, cfg.deviceId); assert.equal(hello.result.publicKey, identity.publicKey);
  ws.send(frame(2, 1, phone.seal('{"id":2,"method":"agents.list"}')));
  assert.deepEqual(JSON.parse(phone.open(await next(1))), { id: 2, result: [] });
  const push = { event: 'task.event', data: { taskId: 'test', event: { seq: 1, ts: Date.now(), kind: 'text', text: 'private push' } } };
  // The production TaskManager uses this exact broadcast function.
  server.broadcast(push as Parameters<typeof server.broadcast>[0]);
  assert.deepEqual(JSON.parse(phone.open(await next(1))), push);
  const delta = { event: 'task.delta' as const, data: { taskId: 'test', messageId: 'item', text: 'private draft', offset: 0 } };
  server.broadcast(delta);
  assert.deepEqual(JSON.parse(phone.open(await next(1))), delta);
  const badAuth = await handshake(2);
  ws.send(frame(2, 2, badAuth.seal('{"auth":"not-a-ticket"}')));
  assert.deepEqual(JSON.parse(badAuth.open(await next(2))), { auth: 'error' }); await next(2, 3);
  const badCipher = await handshake(3);
  const corrupted = badCipher.seal(JSON.stringify({ auth: credential })); corrupted[0] ^= 1;
  ws.send(frame(2, 3, corrupted)); await next(3, 3);
  const noAuth = await handshake(4);
  ws.send(frame(2, 4, noAuth.seal('{"id":4,"method":"hello"}'))); await next(4, 3);
  assert.equal(server.clientCount(), 1);
  ws.send(frame(2, 1, phone.seal('{"id":5,"method":"hello"}')));
  assert.equal(JSON.parse(phone.open(await next(1))).id, 5);
  ws.send(frame(3, 1)); await until(() => server.clientCount() === 0);
  a.logout(); await until(() => relay.status.state === 'off');
  assert.equal(relay.status.channels, 0);
  assert.ok(logs.some(s => s.includes('中转') && s.includes('认证失败')));
  for (const sensitive of [credential, 'not-a-ticket', 'test-access-token', 'private push', 'private draft']) assert.ok(logs.every(s => !s.includes(sensitive)));
});

test('replacement waits 30 seconds; device deletion stops until next login', listen, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const fake = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(fake, 'listening');
  const addr = fake.address(); assert.ok(addr && typeof addr !== 'string');
  const url = `http://127.0.0.1:${addr.port}`, a = account(url);
  let count = 0;
  fake.on('connection', () => { count++; });
  const secret = randomBytes(32);
  const relay = new RelayClient({ config: { ...config, serverUrl: url }, identity: { privateKey: secret, publicKey: publicKey(secret).toString('base64url') },
    account: a, attachClient: () => ({ receive: async () => {}, disconnect() {} }), log() {} });
  t.after(async () => { relay.stop(); for (const ws of fake.clients) ws.terminate(); await new Promise<void>(r => fake.close(() => r())); });
  let connection = once(fake, 'connection'); relay.start();
  const [first] = await connection as [WebSocket];
  await until(() => relay.status.state === 'online');
  first.close(4000, 'replaced'); await until(() => relay.status.state === 'error');
  t.mock.timers.tick(29999); await immediate(); assert.equal(count, 1);
  connection = once(fake, 'connection'); t.mock.timers.tick(1);
  const [second] = await connection as [WebSocket]; assert.equal(count, 2);
  await until(() => relay.status.state === 'online');
  t.mock.timers.tick(60_000);
  second.terminate(); await until(() => relay.status.state === 'error');
  t.mock.timers.tick(999); await immediate(); assert.equal(count, 2);
  connection = once(fake, 'connection'); t.mock.timers.tick(1);
  const [third] = await connection as [WebSocket]; assert.equal(count, 3);
  await until(() => relay.status.state === 'online');
  third.close(1001, 'device_deleted'); await until(() => relay.status.state === 'off');
  assert.equal(a.stops, 1); t.mock.timers.tick(120_000); await immediate(); assert.equal(count, 3);
  a.logout(); connection = once(fake, 'connection'); a.login(); await connection;
  assert.equal(count, 4);
  a.logout(); t.mock.timers.tick(120_000); await immediate(); assert.equal(count, 4);
  assert.equal(relay.status.state, 'off');
});
