import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { signToken } from '../src/tokens.ts';
import { fixture, keys } from './helpers.ts';

const device = { name: 'Review Mac', hosts: ['127.0.0.1'], port: 8787, bridgeVersion: 'tc-test-version' };

test('account deletion requires an unexpired access token for an existing user', async t => {
  const f = await fixture(t);
  const account = await f.login('delete-auth@example.com');
  const iat = f.now() / 1000;
  const ticket = signToken({ sub: account.user.id, typ: 'connect', dev: randomUUID(), iat, exp: iat + 300 },
    keys.privateKey);
  for (const token of [undefined, 'tc-test-token', ticket]) {
    assert.equal((await f.request('DELETE', '/me', undefined, { token })).status, 401);
  }
  f.advance(900_000);
  assert.equal((await f.request('DELETE', '/me', undefined, { token: account.accessToken })).status, 401);
  assert.ok(f.db.prepare('SELECT id FROM users WHERE id = ?').get(account.user.id));
});

test('deletion removes all account-linked data while preserving another account on the same IP', async t => {
  const f = await fixture(t);
  const account = await f.login('delete-data@example.com');
  const other = await f.login('keep-data@example.com');
  const auth = { token: account.accessToken };
  const otherAuth = { token: other.accessToken };
  const id = randomUUID();
  const otherId = randomUUID();
  await f.request('PUT', `/devices/${id}`, device, auth);
  await f.request('PUT', `/devices/${otherId}`, device, otherAuth);
  await f.request('POST', '/auth/refresh', { refreshToken: account.refreshToken });
  for (const userId of [account.user.id, other.user.id]) {
    f.db.prepare('INSERT INTO push_attempts (user_id, created_at) VALUES (?, ?)').run(userId, f.now());
  }
  for (const options of [auth, otherAuth]) {
    assert.equal((await f.request('POST', '/feedback', {
      kind: 'bug', message: 'tc-test-feedback', contactOk: true,
    }, options)).status, 200);
  }
  f.advance(60_000);
  for (const email of ['delete-data@example.com', 'keep-data@example.com']) {
    await f.send(email, 'email', 'reset');
    await f.request('POST', '/auth/password', { email, password: 'tc-test-wrong-password' });
  }

  const deleted = await f.request('DELETE', '/me', undefined, auth);
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { ok: true });
  for (const table of ['users', 'identities', 'devices', 'refresh_tokens', 'push_attempts', 'feedback']) {
    const key = table === 'users' ? 'id' : 'user_id';
    const count = f.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${key} = ?`);
    assert.equal(count.get(account.user.id)!.n, 0, table);
    assert.equal(count.get(other.user.id)!.n, 1, table);
  }
  for (const table of ['codes', 'auth_attempts']) {
    const count = f.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE target = ?`);
    assert.equal(count.get('delete-data@example.com')!.n, 0);
    assert.ok(Number(count.get('keep-data@example.com')!.n) > 0);
  }
  assert.equal((await f.request('GET', '/me', undefined, otherAuth)).status, 200);
});

test('deletion invalidates every service session and permits fresh registration without restoring old data', async t => {
  const f = await fixture(t);
  const account = await f.login('delete-sessions@example.com');
  const second = await f.login('delete-sessions@example.com');
  const rotated = await f.request('POST', '/auth/refresh', { refreshToken: account.refreshToken });
  const id = randomUUID();
  const auth = { token: account.accessToken };
  await f.request('PUT', `/devices/${id}`, device, auth);
  assert.equal((await f.request('DELETE', '/me', undefined, auth)).status, 200);
  for (const token of [account.accessToken, second.accessToken, rotated.body.accessToken]) {
    const options = { token };
    assert.equal((await f.request('GET', '/me', undefined, options)).status, 401);
    assert.equal((await f.request('GET', '/devices', undefined, options)).status, 401);
    assert.equal((await f.request('PUT', `/devices/${id}`, device, options)).status, 401);
    assert.equal((await f.request('DELETE', '/me', undefined, options)).status, 401);
    assert.equal((await f.request('POST', `/devices/${id}/ticket`, {}, options)).status, 401);
  }
  for (const refreshToken of [account.refreshToken, second.refreshToken, rotated.body.refreshToken]) {
    assert.equal((await f.request('POST', '/auth/refresh', { refreshToken })).status, 401);
  }
  const again = await f.login('delete-sessions@example.com');
  assert.notEqual(again.user.id, account.user.id);
  const devices = await f.request('GET', '/devices', undefined, { token: again.accessToken });
  assert.deepEqual(devices.body, { devices: [] });
  assert.equal((await f.request('GET', '/me', undefined, auth)).status, 401);
});

test('legacy accounts without a password can delete both phone and email identities', async t => {
  const f = await fixture(t);
  const userId = randomUUID();
  f.db.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').run(userId, f.now());
  f.db.prepare("INSERT INTO identities VALUES (?, 'sms', '+8613800000000', ?)").run(userId, f.now());
  f.db.prepare("INSERT INTO identities VALUES (?, 'email', 'tc-test-legacy@example.com', ?)").run(userId, f.now());
  const iat = f.now() / 1000;
  const token = signToken({ sub: userId, typ: 'access', iat, exp: iat + 900 }, keys.privateKey);
  assert.equal((await f.request('DELETE', '/me', undefined, { token })).status, 200);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM identities').get()!.n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM users').get()!.n, 0);
});

test('a database failure rolls back deletion of the account and its dependent records', async t => {
  const logs: string[] = [];
  const f = await fixture(t, new Map(), undefined, { log: line => logs.push(line) });
  const account = await f.login('delete-rollback@example.com');
  const auth = { token: account.accessToken };
  const id = randomUUID();
  await f.request('PUT', `/devices/${id}`, device, auth);
  await f.request('POST', '/feedback', { kind: 'bug', message: 'tc-test-feedback' }, auth);
  logs.length = 0;
  f.db.exec(`CREATE TRIGGER reject_account_delete BEFORE DELETE ON users
    BEGIN SELECT RAISE(ABORT, 'tc-test-failure'); END`);
  assert.equal((await f.request('DELETE', '/me', undefined, auth)).status, 500);
  for (const table of ['users', 'identities', 'devices', 'refresh_tokens', 'feedback', 'codes', 'auth_attempts']) {
    assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 1, table);
  }
  assert.equal((await f.request('GET', '/me', undefined, auth)).status, 200);
  assert.equal((await f.request('POST', '/auth/refresh', { refreshToken: account.refreshToken })).status, 200);
  assert.deepEqual(logs, ['Internal request failure']);
});
