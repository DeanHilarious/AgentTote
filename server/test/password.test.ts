import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { initializeDatabase, openDatabase } from '../src/db.ts';
import { createPasswordAuth, hashPassword, verifyPassword } from '../src/passwords.ts';
import { fixture } from './helpers.ts';

const email = 'user@example.com', password = '12345678';

test('email registration stores verified identity and salted password; credentials errors are uniform', async t => {
  const f = await fixture(t);
  const first = await f.login(email);
  assert.equal(first.isNewUser, true);
  assert.equal(first.user.email, email);
  assert.equal(first.user.hasPassword, true);
  assert.equal(f.db.prepare('SELECT verified_at FROM identities').get()!.verified_at, f.now());
  const hash = f.db.prepare('SELECT password_hash FROM users').get()!.password_hash as string;
  assert.match(hash, /^scrypt\$16384\$8\$1\$[\w-]{22}\$[\w-]{86}$/);
  assert.equal(await verifyPassword(password, hash), true);
  assert.notEqual(await hashPassword(password), hash);
  for (const path of ['/auth/register', '/auth/code']) {
    const duplicate = await f.request('POST', path, { email, password, channel: 'email', target: email, purpose: 'register' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'email_taken');
  }
  assert.equal((await f.login(email)).user.id, first.user.id);
  for (const [target, value] of [[email, 'wrong'], ['unknown@example.com', password]]) {
    const result = await f.request('POST', '/auth/password', { email: target, password: value });
    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, 'invalid_credentials');
  }
  f.db.prepare('UPDATE users SET password_hash = NULL').run();
  assert.equal((await f.request('POST', '/auth/password', { email, password })).body.error.code, 'invalid_credentials');
});

test('password rules only restrict character length; session creation rolls back with registration', async () => {
  const db = openDatabase();
  try {
    const auth = createPasswordAuth(db, Date.now);
    for (const value of ['', '1234567', 'x'.repeat(129), null, 12345678]) {
      await assert.rejects(auth.register(email, value, 'ip', () => {}, () => {}), { code: 'weak_password' });
    }
    await assert.rejects(auth.register(email, password, 'ip', () => {}, () => { throw new Error('session failure'); }), /session failure/);
    assert.equal(db.prepare('SELECT count(*) n FROM users').get()!.n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM identities').get()!.n, 0);
    await auth.register(email, '😀'.repeat(128), 'ip', () => {}, () => {});
  } finally { db.close(); }
});

test('change password requires original password; retired endpoints reject requests', async t => {
  const f = await fixture(t);
  const session = await f.login(email);
  const options = { token: session.accessToken };
  for (const currentPassword of [undefined, 'bad']) {
    assert.equal((await f.request('POST', '/me/password', { currentPassword, newPassword: 'new password' }, options)).body.error.code, 'invalid_credentials');
  }
  assert.equal((await f.request('POST', '/me/password', { currentPassword: password, newPassword: 'new password' }, options)).status, 200);
  assert.equal((await f.request('POST', '/auth/password', { email, password })).body.error.code, 'invalid_credentials');
  assert.equal((await f.request('POST', '/auth/password', { email, password: 'new password' })).status, 200);
  assert.equal((await f.request('POST', '/me/phone', {}, options)).status, 410);
  const removed = await f.request('POST', '/auth/verify', { channel: 'email', target: email, code: '123456' });
  assert.equal(removed.status, 410);
  assert.equal(removed.body.error.code, 'code_login_removed');
  assert.equal((await f.request('POST', '/auth/code', { channel: 'email', target: email, purpose: 'login' })).status, 400);
  assert.equal((await f.request('POST', '/auth/code', { channel: 'sms', target: '13800138000' })).body.error.code, 'sms_disabled');
});

test('legacy login is opt-in, never registers and phone registration is always disabled', async t => {
  for (const enabled of [false, true]) {
    const f = await fixture(t, new Map(), undefined, { legacyPhoneLogin: enabled });
    const id = await f.legacy();
    const body = { phone: '13800138000', password };
    const result = await f.request('POST', '/auth/password', body);
    assert.equal(result.status, enabled ? 200 : 400);
    if (enabled) assert.equal(result.body.user.id, id);
    else assert.equal(result.body.error.code, 'phone_login_disabled');
    assert.equal((await f.request('POST', '/auth/register', body)).body.error.code, 'phone_registration_disabled');
    const missing = await f.request('POST', '/auth/password', { phone: '13900139000', password });
    assert.equal(missing.body.error.code, enabled ? 'invalid_credentials' : 'phone_login_disabled');
    assert.equal(f.db.prepare('SELECT count(*) n FROM users').get()!.n, 1);
  }
});

test('reset is purpose-bound, revokes every old refresh family, and keeps its new session', async t => {
  const f = await fixture(t);
  const first = await f.login(email);
  const mac = await f.login(email);
  const rotated = (await f.request('POST', '/auth/refresh', { refreshToken: mac.refreshToken })).body;
  f.advance(60000);
  await f.send(email, 'email', 'reset');
  const code = f.sent.at(-1)!.code;
  const bad = await f.request('POST', '/auth/reset', { email, code: 'bad', password: 'new password' });
  assert.equal(bad.body.error.code, 'invalid_code');
  const reset = await f.request('POST', '/auth/reset', { email, code, password: 'new password' });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.user.id, first.user.id);
  for (const refreshToken of [first.refreshToken, mac.refreshToken, rotated.refreshToken]) {
    assert.equal((await f.request('POST', '/auth/refresh', { refreshToken })).status, 401);
  }
  assert.equal((await f.request('POST', '/auth/refresh', { refreshToken: reset.body.refreshToken })).status, 200);
  assert.equal((await f.request('POST', '/auth/password', { email, password })).body.error.code, 'invalid_credentials');
  assert.equal((await f.request('POST', '/auth/password', { email, password: 'new password' })).status, 200);
  assert.equal((await f.request('POST', '/auth/reset', { email, code, password })).body.error.code, 'invalid_code');
});

test('unknown reset email returns identical delivery response, consumes quota and never sends or creates users', async t => {
  const f = await fixture(t, new Map([['email:unknown@example.com', '123456']]));
  await f.login(email);
  f.advance(60000);
  const known = await f.send(email, 'email', 'reset');
  const sentCount = f.sent.length;
  const unknown = await f.send('unknown@example.com', 'email', 'reset');
  assert.equal(unknown.status, known.status);
  assert.deepEqual(unknown.body, known.body);
  assert.equal(f.sent.length, sentCount);
  assert.equal((await f.send('unknown@example.com', 'email', 'reset')).status, 429);
  assert.equal((await f.request('POST', '/auth/reset', { email: 'unknown@example.com', code: '123456', password })).body.error.code, 'invalid_code');
  assert.equal(f.db.prepare('SELECT count(*) n FROM users').get()!.n, 1);
});

test('registration IP and login phone/IP quotas persist; success clears phone failures only', async () => {
  const db = openDatabase();
  let time = 1800000000000;
  try {
    let auth = createPasswordAuth(db, () => time);
    for (let i = 0; i < 10; i++) await auth.register(`user${i}@example.com`, password, 'register-ip', () => {}, id => id);
    await assert.rejects(auth.register(email, password, 'register-ip', () => {}, () => {}), { code: 'rate_limited', retryAfter: 3600 });
    auth = createPasswordAuth(db, () => time);
    const target = 'user0@example.com';
    for (let i = 0; i < 9; i++) await assert.rejects(auth.login(target, 'wrong', 'login-ip'), { code: 'invalid_credentials' });
    await auth.login(target, password, 'login-ip');
    for (let i = 0; i < 10; i++) await assert.rejects(auth.login(target, 'wrong', 'login-ip'), { code: 'invalid_credentials' });
    await assert.rejects(auth.login(target, password, 'different-ip'), { code: 'rate_limited', retryAfter: 900 });
    time += 900000;
    await auth.login(target, password, 'login-ip');
    for (let i = 0; i < 41; i++) await assert.rejects(auth.login(`missing${i}@example.com`, 'wrong', 'login-ip'), { code: 'invalid_credentials' });
    await assert.rejects(auth.login('user1@example.com', password, 'login-ip'), { code: 'rate_limited', retryAfter: 2700 });
    time += 3600000;
    await auth.login(target, password, 'login-ip');
  } finally { db.close(); }
});

test('concurrent registration/login cannot bypass quotas or create duplicate identities', async () => {
  const db = openDatabase();
  try {
    const auth = createPasswordAuth(db, Date.now);
    const registrations = await Promise.allSettled(Array.from({ length: 2 }, () => auth.register(email, password, 'ip', () => {}, id => id)));
    assert.equal(registrations.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((registrations.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'email_taken');
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => auth.login(email, 'wrong', 'ip')));
    assert.equal(attempts.filter(r => r.status === 'rejected' && r.reason.code === 'rate_limited').length, 2);
  } finally { db.close(); }
});

test('old users table gains nullable password_hash without losing users; initialization is idempotent', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL); INSERT INTO users VALUES ('old', 1)");
    initializeDatabase(db);
    initializeDatabase(db);
    assert.equal(db.prepare('SELECT password_hash FROM users WHERE id = ?').get('old')!.password_hash, null);
    assert.equal(db.prepare('SELECT created_at FROM users WHERE id = ?').get('old')!.created_at, 1);
  } finally { db.close(); }
});
