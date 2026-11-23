import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadIdentity } from '../src/identity.ts';
import { bridgeHandshake, phoneHandshake, publicKey, transport, encrypt, deriveKeys, nonce } from '../src/relayCrypto.ts';
// @ts-expect-error Generator is also an executable ES module.
import { generateVectors } from '../scripts/relay-vectors.mjs';

test('committed interoperability vectors match the generator byte for byte', async () => {
  const text = await readFile(new URL('../../docs/relay-test-vectors.json', import.meta.url), 'utf8');
  assert.equal(text, JSON.stringify(generateVectors(), null, 2) + '\n');
  const v = JSON.parse(text);
  const keys = phoneHandshake(Buffer.from(v.phonePrivate, 'hex'), Buffer.from(v.staticPublic, 'hex'), v.deviceId, Buffer.from(v.msg2, 'hex'));
  assert.equal(keys.k_p2b.toString('hex'), v.k_p2b);
  assert.equal(keys.k_b2p.toString('hex'), v.k_b2p);
  const phone = transport(keys, 'phone'), bridge = transport(keys, 'bridge');
  for (const m of v.messages) assert.equal((m.direction === 'p2b' ? bridge : phone).open(Buffer.from(m.ciphertext, 'hex')), m.plaintext);
});

test('handshake and transport round trip; tampering, replay, wrong counters and zero keys rejected', () => {
  const s = randomBytes(32), p = randomBytes(32), device = '00112233-4455-6677-8899-aabbccddeeff';
  const msg1 = Buffer.concat([Buffer.from([1]), publicKey(p)]);
  const h = bridgeHandshake(s, device, msg1);
  const keys = phoneHandshake(p, publicKey(s), device, h.msg2);
  const bridge = transport(h, 'bridge'), phone = transport(keys, 'phone');
  const cipher = phone.seal('{"text":"你好"}');
  assert.equal(bridge.open(cipher), '{"text":"你好"}');
  assert.throws(() => bridge.open(cipher));
  assert.equal(phone.open(bridge.seal('{"ok":true}')), '{"ok":true}');
  const bad = phone.seal('{}'); bad[0] ^= 1;
  assert.throws(() => bridge.open(bad));
  assert.throws(() => bridge.open(encrypt(keys.k_p2b, 2n, Buffer.from('{}'))));
  const changed = Buffer.from(h.msg2); changed[40] ^= 1;
  assert.throws(() => phoneHandshake(p, publicKey(s), device, changed));
  assert.throws(() => phoneHandshake(p, publicKey(randomBytes(32)), device, h.msg2));
  assert.throws(() => bridgeHandshake(s, device, Buffer.concat([Buffer.from([1]), Buffer.alloc(32)])));
  assert.throws(() => phoneHandshake(p, Buffer.alloc(32), device, h.msg2));
  assert.throws(() => deriveKeys(Buffer.alloc(32), randomBytes(32), Buffer.alloc(0)));
  assert.throws(() => bridgeHandshake(s, device, msg1.subarray(1)));
  assert.throws(() => nonce(1n << 64n));
  assert.equal(nonce(0x0102030405060708n).toString('hex'), '000000000102030405060708');
});

test('identity is persistent, private, concurrency safe and corruption is never replaced', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aa-identity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const [a, b] = await Promise.all([loadIdentity(dir), loadIdentity(dir)]);
  assert.equal(a.publicKey, b.publicKey);
  assert.match(a.publicKey, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await stat(join(dir, 'identity.key'))).mode & 0o777, 0o600);
  assert.deepEqual((await loadIdentity(dir)).privateKey, a.privateKey);
  await writeFile(join(dir, 'identity.key'), '{broken');
  await assert.rejects(loadIdentity(dir), /damaged/);
  assert.equal(await readFile(join(dir, 'identity.key'), 'utf8'), '{broken');
});
