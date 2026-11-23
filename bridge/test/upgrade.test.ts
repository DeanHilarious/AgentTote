import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { startServer } from '../src/server.ts';
import { config, publicKeyPem, ticket } from './accountHelpers.ts';

test('real WebSocket upgrades accept header/query credentials and observe account state changes', {
  skip: process.env.AA_TEST_LISTEN !== '1' ? 'Requires listening permission; run AA_TEST_LISTEN=1 npm test outside the sandbox' : false,
}, async t => {
  let userId: string | undefined = 'user-1';
  const logs: string[] = [];
  const server = await startServer({ ...config, port: 0 }, [], message => logs.push(message), () => ({ userId, publicKeyPem }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `ws://127.0.0.1:${address.port}`;
  const sockets = new Set<WebSocket>();
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const connect = (credential: string, header: boolean): Promise<boolean> => new Promise((resolve, reject) => {
    const socket = new WebSocket(header ? url : `${url}?token=${encodeURIComponent(credential)}`, header ? { headers: { Authorization: `Bearer ${credential}` } } : undefined);
    sockets.add(socket);
    socket.once('open', () => resolve(true));
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response) => {
      assert.equal(response.statusCode, 401);
      response.resume();
      socket.terminate();
      resolve(false);
    });
  });
  const time = Math.floor(Date.now() / 1000);
  const validTicket = ticket({ iat: time, exp: time + 300 });
  assert.equal(await connect(config.token, false), true);
  assert.equal(await connect(config.token, true), true);
  assert.equal(await connect(validTicket, true), true);
  assert.equal(await connect(validTicket, false), true);
  assert.equal(await connect('wrong-token', false), false);
  assert.equal(await connect(ticket({ dev: 'other-device', iat: time, exp: time + 300 }), true), false);
  userId = undefined;
  assert.equal(await connect(validTicket, false), false);
  assert.equal(await connect(config.token, true), true);
  assert.ok(logs.some(message => message.startsWith('配对 token 连接')));
  assert.ok(logs.some(message => message.startsWith('账号票据连接')));
  assert.ok(logs.every(message => !message.includes(config.token) && !message.includes(validTicket)));
});

test('hello RPC returns the persistent deviceId for pairing and account connections', {
  skip: process.env.AA_TEST_LISTEN !== '1' ? 'Requires listening permission; run AA_TEST_LISTEN=1 npm test outside the sandbox' : false,
  timeout: 5_000,
}, async t => {
  const server = await startServer({ ...config, port: 0 }, [], () => {}, () => ({ userId: 'user-1', publicKeyPem }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const sockets = new Set<WebSocket>();
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const now = Math.floor(Date.now() / 1000);
  for (const credential of [config.token, ticket({ iat: now, exp: now + 300 })]) {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`, { headers: { Authorization: `Bearer ${credential}` } });
    sockets.add(socket);
    const response = await new Promise<{ id: number; result: { deviceId: string; name: string } }>((resolve, reject) => {
      socket.once('error', reject);
      socket.once('message', data => resolve(JSON.parse(String(data))));
      socket.once('open', () => socket.send(JSON.stringify({ id: 1, method: 'hello' })));
    });
    assert.equal(response.id, 1);
    assert.equal(response.result.deviceId, config.deviceId);
    assert.equal(response.result.name, config.name);
  }
});
