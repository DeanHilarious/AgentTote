import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createCodes } from '../src/codes.ts';
import { openDatabase } from '../src/db.ts';
import { signToken, verifyToken } from '../src/tokens.ts';
import { fixture, initialTime, keys, secret } from './helpers.ts';

test('email login registers once, consumes the code, and logs into the same account', async t => {
  const f = await fixture(t);
  const first = await f.login(' Review@Example.COM ');
  assert.equal(first.isNewUser, true);
  assert.equal(first.user.email, 'review@example.com');
  assert.equal(first.user.createdAt, initialTime);
  assert.match(f.sent[0].code, /^\d{6}$/);
  const replay = await f.request('POST', '/auth/register', { password: '12345678', email: 'review@example.com', code: f.sent[0].code });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.error.code, 'email_taken');
  f.advance(60_000);
  const second = await f.login('review@example.com');
  assert.equal(second.isNewUser, false);
  assert.equal(second.user.id, first.user.id);
  const me = await f.request('GET', '/me', undefined, { token: second.accessToken });
  assert.deepEqual(me.body, second.user);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM users').get()!.n, 1);
  const stored = f.db.prepare('SELECT code_hash FROM codes LIMIT 1').get()!.code_hash as string;
  assert.match(stored, /^[0-9a-f]{64}$/);
  assert.notEqual(stored, f.sent[0].code);
});

test('legacy iOS accounts can open the workspace without a purchase or an entitlement grant', async t => {
  const f = await fixture(t);
  // An existing installation can still have the retired column, including its old default.
  f.db.exec('ALTER TABLE users ADD COLUMN has_lifetime_access INTEGER NOT NULL DEFAULT 0');
  const account = await f.login('free@example.com');
  assert.equal(account.user.hasLifetimeAccess, true);
  const me = await f.request('GET', '/me', undefined, { token: account.accessToken });
  assert.equal(me.body.hasLifetimeAccess, true);
  assert.equal((await f.request('GET', '/me')).status, 401);
});

test('email normalization rejects malformed targets', async t => {
  const f = await fixture(t);
  for (const target of ['bad', 'a@@example.com', 'a b@example.com', 'a@-example.com', '.a@example.com']) {
    const response = await f.send(target);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'invalid_target');
  }
});

test('five wrong attempts invalidate even the correct code and disclose no account state', async t => {
  const f = await fixture(t);
  await f.send('attempts@example.com');
  const correct = f.sent[0].code;
  const wrong = correct === '000000' ? '111111' : '000000';
  let last;
  for (let i = 0; i < 5; i++) {
    last = await f.request('POST', '/auth/register', { password: '12345678', email: 'attempts@example.com', code: wrong });
    assert.equal(last.status, 400);
    assert.equal(last.body.error.code, 'invalid_code');
  }
  const locked = await f.request('POST', '/auth/register', { password: '12345678', email: 'attempts@example.com', code: correct });
  const missing = await f.request('POST', '/auth/register', { password: '12345678', email: 'missing@example.com', code: correct });
  assert.deepEqual(locked.body, last!.body);
  assert.deepEqual(missing.body, last!.body);
  assert.equal(f.db.prepare('SELECT attempts FROM codes').get()!.attempts, 5);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM users').get()!.n, 0);
});

test('code expires at five minutes and purposes cannot be interchanged', async t => {
  const f = await fixture(t);
  await f.send('expired@example.com');
  f.advance(300_001);
  const expired = await f.request('POST', '/auth/register', { password: '12345678', email: 'expired@example.com', code: f.sent[0].code });
  assert.equal(expired.body.error.code, 'invalid_code');
  const session = await f.login('purpose@example.com');
  await f.request('POST', '/auth/code', { channel: 'email', target: 'bind-only@example.com', purpose: 'bind' }, { token: session.accessToken });
  const wrongPurpose = await f.request('POST', '/auth/register', { password: '12345678', email: 'bind-only@example.com', code: f.sent.at(-1)!.code });
  assert.equal(wrongPurpose.body.error.code, 'invalid_code');
});

test('resend rate limit includes retryAfter and failed delivery still consumes quota', async t => {
  const f = await fixture(t);
  assert.equal((await f.send('rate@example.com')).status, 200);
  f.advance(1500);
  const limited = await f.send(' RATE@example.com ', 'email', 'reset');
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.retryAfter, 59);
  assert.equal(limited.headers['retry-after'], '59');
  f.advance(58_500);
  assert.equal((await f.send('rate@example.com')).status, 200);
  assert.equal(f.sent.length, 2);

  const failed = await fixture(t, new Map(), { async send() { throw new Error('sensitive provider error'); } });
  const failure = await failed.send('delivery@example.com');
  assert.equal(failure.status, 500);
  assert.equal(failure.body.error.code, 'delivery_failed');
  assert.equal(failure.body.error.message, 'Could not send the verification code; the delivery channel may not be configured');
  assert.ok(!JSON.stringify(failure.body).includes('sensitive'));
  assert.equal((await failed.send('delivery@example.com')).status, 429);
  assert.notEqual(failed.db.prepare('SELECT consumed_at FROM codes').get()!.consumed_at, null);
});

test('concurrent code requests reserve quota before the sender resolves', async t => {
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, new Map(), { async send() { started(); await pending; } });
  const first = f.send('concurrent@example.com');
  await startedPromise;
  try { assert.equal((await f.send('concurrent@example.com')).status, 429); } finally { release(); }
  assert.equal((await first).status, 200);
});

test('rolling daily target and hourly IP limits survive service recreation', async t => {
  const db = openDatabase();
  t.after(() => db.close());
  let time = initialTime;
  const now = () => time;
  const sender = { async send() {} };
  const makeCodes = () => createCodes(db, secret, now, { email: sender, sms: sender });
  for (let i = 0; i < 10; i++) {
    await makeCodes().send('email', 'daily@example.com', i % 2 ? 'bind' : 'register', `ip-${i}`);
    time += 60_000;
  }
  await assert.rejects(makeCodes().send('email', 'daily@example.com', 'register', 'other-ip'),
    { status: 429, retryAfter: 85_800 });
  time = initialTime + 86_400_000;
  await makeCodes().send('email', 'daily@example.com', 'register', 'other-ip');
  for (let i = 0; i < 30; i++) await makeCodes().send('email', `ip-${i}@example.com`, 'register', 'shared-ip');
  await assert.rejects(makeCodes().send('email', 'blocked@example.com', 'register', 'shared-ip'), { status: 429, retryAfter: 3600 });
  time += 3_600_000;
  await makeCodes().send('email', 'blocked@example.com', 'register', 'shared-ip');
});

test('test accounts use fixed codes without invoking senders, retaining normal limits', async t => {
  const f = await fixture(t, new Map([['email:review@example.com', '123456'], ['sms:+8613800000000', '000000']]));
  assert.equal((await f.login('review@example.com')).user.email, 'review@example.com');
  assert.equal((await f.send('+8613800000000', 'sms')).body.error.code, 'sms_disabled');
  assert.equal(f.sent.length, 0);
  assert.equal((await f.send('review@example.com', 'email', 'reset')).status, 429);
});

test('refresh rotation detects replay and revokes the entire family, but not other sessions', async t => {
  const f = await fixture(t);
  const first = await f.login('refresh@example.com');
  f.advance(60_000);
  const separate = await f.login('refresh@example.com');
  const rotated = await f.request('POST', '/auth/refresh', { refreshToken: first.refreshToken });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.body.refreshToken, first.refreshToken);
  assert.equal(verifyToken(rotated.body.accessToken, keys.publicKey, { typ: 'access', now: f.now }).sub, first.user.id);
  const replay = await f.request('POST', '/auth/refresh', { refreshToken: first.refreshToken });
  assert.equal(replay.status, 401);
  assert.equal((await f.request('POST', '/auth/refresh', { refreshToken: rotated.body.refreshToken })).status, 401);
  assert.equal((await f.request('POST', '/auth/refresh', { refreshToken: separate.refreshToken })).status, 200);
  assert.equal(f.db.prepare('SELECT token_hash FROM refresh_tokens WHERE token_hash = ?')
    .get(createHash('sha256').update(first.refreshToken).digest('hex'))!.token_hash,
  createHash('sha256').update(first.refreshToken).digest('hex'));
  assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM refresh_tokens').all()).includes(first.refreshToken));
});

test('logout revokes a family; refresh expires after 30 days', async t => {
  const f = await fixture(t);
  const session = await f.login('logout@example.com');
  const rotated = await f.request('POST', '/auth/refresh', { refreshToken: session.refreshToken });
  assert.equal((await f.request('POST', '/auth/logout', { refreshToken: session.refreshToken })).status, 200);
  assert.equal((await f.request('POST', '/auth/refresh', { refreshToken: rotated.body.refreshToken })).status, 401);
  assert.equal((await f.request('POST', '/auth/logout', { refreshToken: session.refreshToken })).status, 200);
  const expired = await f.login('expiry@example.com');
  f.advance(30 * 86_400_000);
  assert.equal((await f.request('POST', '/auth/refresh', { refreshToken: expired.refreshToken })).status, 401);
});

test('access expires after 15 minutes and connect tickets cannot authenticate API calls', async t => {
  const f = await fixture(t);
  const session = await f.login('access@example.com');
  assert.equal((await f.request('GET', '/me')).status, 401);
  const ticket = signToken({ sub: session.user.id, typ: 'connect', dev: randomUUID(), iat: f.now() / 1000, exp: f.now() / 1000 + 300 }, keys.privateKey);
  assert.equal((await f.request('GET', '/me', undefined, { token: ticket })).status, 401);
  f.advance(16 * 60_000);
  assert.equal((await f.request('GET', '/me', undefined, { token: session.accessToken })).status, 401);
});

test('legacy phone account binds email and keeps original password and user id', async t => {
  const f = await fixture(t, new Map(), undefined, { legacyPhoneLogin: true });
  const id = await f.legacy();
  const phone = (await f.request('POST', '/auth/password', { phone: '13800138000', password: '12345678' })).body;
  const options = { token: phone.accessToken };
  assert.equal((await f.request('POST', '/auth/code', { channel: 'email', target: 'bound@example.com', purpose: 'bind' })).status, 401);
  await f.request('POST', '/auth/code', { channel: 'email', target: 'bound@example.com', purpose: 'bind' }, options);
  const bound = await f.request('POST', '/me/identities', { channel: 'email', target: 'bound@example.com', code: f.sent.at(-1)!.code }, options);
  assert.equal(bound.status, 200);
  assert.equal(bound.body.id, id);
  assert.equal(bound.body.phone, '+8613800138000');
  assert.equal((await f.login('bound@example.com')).user.id, id);
  await f.login('other@example.com');
  const taken = await f.request('POST', '/auth/code', { channel: 'email', target: 'other@example.com', purpose: 'bind' }, options);
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.code, 'email_taken');
  await f.send('unbound@example.com');
  assert.equal((await f.request('POST', '/me/identities', { channel: 'email', target: 'unbound@example.com', code: f.sent.at(-1)!.code }, options)).body.error.code, 'invalid_code');
});

test('device lifecycle protects ownership and heartbeat updates online state and all mutable fields', async t => {
  const f = await fixture(t);
  const owner = await f.login('owner@example.com');
  const other = await f.login('intruder@example.com');
  const id = randomUUID();
  const body = { name: 'Mac', hosts: ['192.168.1.2', '::1'], port: 8787, bridgeVersion: '0.1.0' };
  const put = await f.request('PUT', `/devices/${id.toUpperCase()}`, body, { token: owner.accessToken });
  assert.equal(put.status, 200);
  assert.equal(put.body.online, true);
  assert.equal(put.body.id, id);
  assert.equal((await f.request('PUT', `/devices/${id}`, body, { token: other.accessToken })).status, 409);
  assert.deepEqual((await f.request('GET', '/devices', undefined, { token: other.accessToken })).body.devices, []);
  f.advance(120_000);
  const offline = await f.request('GET', '/devices', undefined, { token: owner.accessToken });
  assert.equal(offline.body.devices[0].online, false);
  const update = { name: 'New Mac', hosts: ['10.0.0.2'], port: 9000, bridgeVersion: '0.2.0' };
  const heartbeat = await f.request('PUT', `/devices/${id}`, update, { token: owner.accessToken });
  assert.deepEqual(heartbeat.body, { ...update, id, createdAt: initialTime, lastSeenAt: f.now(), online: true,
    publicKey: null, relayOnline: false });
  assert.equal((await f.request('DELETE', `/devices/${id}`, undefined, { token: other.accessToken })).status, 404);
  assert.equal((await f.request('DELETE', `/devices/${id}`, undefined, { token: owner.accessToken })).status, 200);
  assert.deepEqual((await f.request('GET', '/devices', undefined, { token: owner.accessToken })).body.devices, []);
  assert.equal((await f.request('POST', `/devices/${id}/ticket`, {}, { token: owner.accessToken })).status, 404);
  assert.equal((await f.request('PUT', '/devices/not-a-uuid', body, { token: owner.accessToken })).status, 400);
  for (const invalid of [{ port: 0 }, { hosts: [] }, { hosts: [123] }, { name: '' }, { bridgeVersion: null }]) {
    assert.equal((await f.request('PUT', `/devices/${id}`, { ...body, ...invalid }, { token: owner.accessToken })).status, 400);
  }
});

test('ticket validates with published key and rejects tampering, expiry, type, device, and user mismatch', async t => {
  const f = await fixture(t);
  const owner = await f.login('ticket@example.com');
  const other = await f.login('ticket-other@example.com');
  const id = randomUUID();
  await f.request('PUT', `/devices/${id}`, { name: 'Mac', hosts: ['localhost'], port: 8787, bridgeVersion: '0.1' }, { token: owner.accessToken });
  const response = await f.request('POST', `/devices/${id}/ticket`, undefined, { token: owner.accessToken });
  assert.equal(response.status, 200);
  assert.equal(response.body.expiresIn, 300);
  const { ed25519PublicKey } = (await f.request('GET', '/keys')).body;
  const ticket = response.body.ticket as string;
  const options = { typ: 'connect' as const, now: f.now, userId: owner.user.id, deviceId: id };
  const claims = verifyToken(ticket, ed25519PublicKey, options);
  assert.equal(claims.dev, id);
  assert.equal(claims.sub, owner.user.id);
  assert.equal(claims.exp - claims.iat, 300);
  assert.equal((await f.request('POST', `/devices/${id}/ticket`, {}, { token: other.accessToken })).status, 404);
  const parts = ticket.split('.');
  parts[1] = Buffer.from(JSON.stringify({ ...claims, dev: randomUUID() })).toString('base64url');
  assert.throws(() => verifyToken(parts.join('.'), ed25519PublicKey, options));
  const signature = ticket.split('.');
  const bytes = Buffer.from(signature[2], 'base64url');
  bytes[0] ^= 1;
  signature[2] = bytes.toString('base64url');
  assert.throws(() => verifyToken(signature.join('.'), ed25519PublicKey, options));
  assert.throws(() => verifyToken(owner.accessToken, ed25519PublicKey, options));
  assert.throws(() => verifyToken(ticket, ed25519PublicKey, { ...options, deviceId: randomUUID() }));
  assert.throws(() => verifyToken(ticket, ed25519PublicKey, { ...options, userId: other.user.id }));
  assert.throws(() => verifyToken(`${ticket}=`, ed25519PublicKey, options));
  f.advance(300_000);
  assert.throws(() => verifyToken(ticket, ed25519PublicKey, options));
});

test('HTTP errors are JSON, malformed bodies are rejected, and 64 KB limit uses bytes', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('GET', '/health')).body, { ok: true });
  assert.equal((await f.request('GET', '/unknown')).status, 404);
  for (const raw of ['{', 'null', '[]', '1', '']) {
    const response = await f.request('POST', '/auth/code', undefined, { raw });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'invalid_request');
  }
  assert.equal((await f.request('POST', '/auth/code', {}, { headers: { 'content-type': 'text/plain' } })).status, 400);
  const tooLarge = await f.request('POST', '/auth/code', { target: '汉'.repeat(23_000) });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.error.code, 'body_too_large');
  const exactly = JSON.stringify({ padding: 'x'.repeat(65522) });
  assert.equal(Buffer.byteLength(exactly), 65536);
  assert.equal((await f.request('POST', '/auth/code', undefined, { raw: exactly })).body.error.code, 'invalid_target');
  assert.equal((await f.request('POST', '/auth/refresh', {})).status, 401);
  assert.equal((await f.request('POST', '/auth/code', { channel: 'email', target: 'a@example.com', purpose: 'login' })).status, 400);
});
