import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCodes } from '../src/codes.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase, transaction } from '../src/db.ts';
import { AliyunSmsSender, ConsoleSender, TencentSmsSender } from '../src/senders.ts';
import { normalizeTarget, parseTestAccounts } from '../src/targets.ts';
import { createTokens, signToken, verifyToken } from '../src/tokens.ts';
import type { TokenClaims } from '../src/tokens.ts';
import { fixture, initialTime, keys, secret } from './helpers.ts';

test('development secrets persist with 0600 permissions and configuration validates fail-closed', t => {
  const dir = mkdtempSync(join(tmpdir(), 'aa-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logs: string[] = [];
  const env = { AA_DATA_DIR: dir, AA_TEST_ACCOUNTS: 'email: Review@Example.COM =123456,sms:13800000000=000000' };
  const first = loadConfig(env, message => logs.push(message));
  const second = loadConfig(env, message => logs.push(message));
  assert.equal(first.port, 8790);
  assert.equal(first.emailSender, 'console');
  assert.equal(first.smsSender, 'console');
  assert.equal(first.serverSecret, second.serverSecret);
  assert.equal(first.signingKey, second.signingKey);
  assert.equal(createPublicKey(first.signingKey).asymmetricKeyType, 'ed25519');
  assert.equal(statSync(join(dir, 'server-secret')).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'signing-key.pem')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(dir, 'server-secret'), 'utf8'), first.serverSecret);
  assert.deepEqual(logs, ['开发密钥，勿用于生产', 'APNs disabled', '开发密钥，勿用于生产', 'APNs disabled']);
  assert.equal(first.testAccounts.get('email:review@example.com'), '123456');
  assert.equal(first.testAccounts.get('sms:+8613800000000'), '000000');
  assert.throws(() => loadConfig({ ...env, NODE_ENV: 'production' }), /Production requires/);
  assert.throws(() => loadConfig({ ...env, PORT: 'abc' }), /PORT/);
  assert.throws(() => loadConfig({ ...env, AA_EMAIL_SENDER: 'unknown' }), /AA_EMAIL_SENDER/);
  assert.throws(() => loadConfig({ ...env, AA_SMS_SENDER: 'unknown' }), /AA_SMS_SENDER/);
  assert.throws(() => loadConfig({ ...env, AA_EMAIL_SENDER: 'smtp' }), /SMTP requires/);
  const production = loadConfig({ ...env, NODE_ENV: 'production', AA_SERVER_SECRET: secret, AA_SIGNING_KEY: first.signingKey },
    message => assert.equal(message, 'APNs disabled', 'Explicit production keys must not produce a development-key log'));
  assert.equal(production.serverSecret, secret);
  assert.equal(production.signingKey, first.signingKey);
  assert.throws(() => loadConfig({ ...env, AA_SERVER_SECRET: 'short' }, () => {}), /at least 32 bytes/);
  assert.throws(() => parseTestAccounts('email:a@example.com=123'), /Invalid AA_TEST_ACCOUNTS/);
  assert.throws(() => parseTestAccounts('email:bad=123456'), /Invalid email/);
  assert.equal(normalizeTarget('sms', '+14155552671').target, '+14155552671');
});

test('file database retains codes, quotas, sessions and replay revocations after reopening', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aa-storage-'));
  const path = join(dir, 'account.sqlite');
  let db = openDatabase(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
  const now = () => initialTime;
  let code = '';
  const sender = { async send(_target: string, value: string) { code = value; } };
  const makeCodes = () => createCodes(db, secret, now, { email: sender, sms: sender });
  await makeCodes().send('email', 'persist@example.com', 'register', 'ip');
  const id = randomUUID();
  db.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').run(id, now());
  const session = createTokens(db, keys.privateKey, now).createSession(id, 'Mac');
  db.close();
  db = openDatabase(path);
  await assert.rejects(makeCodes().send('email', 'persist@example.com', 'register', 'ip'), { status: 429 });
  assert.equal(makeCodes().consume('email', 'persist@example.com', 'register', code), true);
  const rotated = createTokens(db, keys.privateKey, now).refresh(session.refreshToken);
  db.close();
  db = openDatabase(path);
  assert.throws(() => createTokens(db, keys.privateKey, now).refresh(session.refreshToken), { status: 401 });
  db.close();
  db = openDatabase(path);
  assert.throws(() => createTokens(db, keys.privateKey, now).refresh(rotated.refreshToken), { status: 401 });
  assert.throws(() => db.prepare('INSERT INTO identities VALUES (?, ?, ?, ?)').run('missing', 'email', 'a@example.com', now()), /FOREIGN KEY/);
  assert.throws(() => transaction(db, () => {
    db.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').run('rolled-back', now());
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(db.prepare('SELECT * FROM users WHERE id = ?').get('rolled-back'), undefined);
});

test('strict token verification rejects malformed signed claims and algorithm confusion', () => {
  const now = () => initialTime;
  const claims: TokenClaims = { sub: randomUUID(), typ: 'connect', dev: randomUUID(), iat: now() / 1000, exp: now() / 1000 + 300 };
  const options = { typ: 'connect' as const, now };
  for (const patch of [
    { typ: 'access' }, { typ: 'refresh' }, { sub: '' }, { sub: 1 }, { dev: undefined },
    { iat: claims.iat + 1 }, { exp: claims.iat }, { exp: claims.exp + 1 },
    { exp: 'forever' }, { iat: claims.iat + 0.5 },
  ]) {
    const token = signToken({ ...claims, ...patch } as TokenClaims, keys.privateKey);
    assert.throws(() => verifyToken(token, keys.publicKey, options));
  }
  for (const header of [{ alg: 'none', typ: 'JWT' }, { alg: 'HS256', typ: 'JWT' }, { alg: 'EdDSA', typ: 'JWT', crit: ['x'] }]) {
    const message = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    const token = `${message}.${sign(null, Buffer.from(message), keys.privateKey).toString('base64url')}`;
    assert.throws(() => verifyToken(token, keys.publicKey, options));
  }
  for (const token of ['', 'abc', 'a.b.c', 'a.b.c.d', '.b.c', 'x'.repeat(4097)]) {
    assert.throws(() => verifyToken(token, keys.publicKey, options));
  }
  const good = signToken(claims, keys.privateKey);
  assert.throws(() => verifyToken(good, generateKeyPairSync('ed25519').publicKey, options));
  assert.throws(() => verifyToken(good, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey, options));
});

test('concurrent refresh reuse invalidates the replacement produced by the winner', async t => {
  const f = await fixture(t);
  const session = await f.login('refresh-race@example.com');
  const results = await Promise.all([
    f.request('POST', '/auth/refresh', { refreshToken: session.refreshToken }),
    f.request('POST', '/auth/refresh', { refreshToken: session.refreshToken }),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 401]);
  const winner = results.find(result => result.status === 200)!;
  assert.equal((await f.request('POST', '/auth/refresh', { refreshToken: winner.body.refreshToken })).status, 401);
});

test('console sender includes the code and validity; SMS placeholders fail explicitly', async () => {
  const logs: string[] = [];
  await new ConsoleSender(message => logs.push(message)).send('review@example.com', '123456', 'register');
  assert.match(logs[0], /123456/);
  assert.match(logs[0], /5 分钟内有效/);
  await assert.rejects(new AliyunSmsSender().send('+8613800000000', '123456', 'register'), /未配置/);
  await assert.rejects(new TencentSmsSender().send('+8613800000000', '123456', 'register'), /未配置/);
});
