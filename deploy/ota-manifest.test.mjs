import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { archiveMetadata, main, signManifest, verifyManifest, publicKeyFromRaw, DEFAULT_FEED } from './ota-manifest.mjs';

const fixture = () => ({ version: '2026.10.18', build: '20261018120001', url: new URL('fixture.zip', DEFAULT_FEED).href,
  sha256: 'a'.repeat(64), size: 42, notes: '', minimumSystemVersion: '14.0', publishedAt: '2026-10-18T12:00:00Z' });

test('Ed25519 round trip uses raw 32-byte public key; rejects wrong key, signature and modified payload', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
  const verifier = publicKeyFromRaw(raw);
  const envelope = signManifest(fixture(), privateKey, verifier);
  assert.deepEqual(verifyManifest(envelope, verifier), fixture());
  assert.throws(() => verifyManifest(envelope, generateKeyPairSync('ed25519').publicKey), /signature/);
  assert.throws(() => verifyManifest({ ...envelope, signature: Buffer.alloc(64).toString('base64') }, verifier), /signature/);
  const tampered = Buffer.concat([Buffer.from(envelope.payload, 'base64'), Buffer.from(' ')]).toString('base64');
  assert.throws(() => verifyManifest({ ...envelope, payload: tampered }, verifier), /signature/);
  assert.throws(() => signManifest(fixture(), privateKey, generateKeyPairSync('ed25519').publicKey), /signature/);
  assert.throws(() => publicKeyFromRaw('bad key'), /base64/);
});

test('signed URL and metadata constraints fail closed', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  for (const url of ['http://agent-anywhere.nuts-claw.tech/a.zip', 'https://evil.example/a.zip',
    'https://agent-anywhere.nuts-claw.tech:444/a.zip', 'https://user@agent-anywhere.nuts-claw.tech/a.zip']) {
    assert.throws(() => signManifest({ ...fixture(), url }, privateKey, publicKey), /origin/);
  }
  for (const patch of [{ size: 0 }, { build: '1.2' }, { sha256: 'bad' }, { version: '1.beta' }, { publishedAt: 'bad' }]) {
    assert.throws(() => signManifest({ ...fixture(), ...patch }, privateKey, publicKey), /metadata/);
  }
});

test('CLI creates and self-verifies manifest using temporary keys; enforces private key permissions', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-ota-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePath = path.join(directory, 'test-only-private.pem');
  const publicPath = path.join(directory, 'public.txt');
  const zip = path.join(directory, 'fixture.zip');
  const output = path.join(directory, 'latest.json');
  fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(publicPath, Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'));
  fs.writeFileSync(zip, 'offline archive fixture');
  const args = ['--zip', zip, '--version', '2026.10.18', '--build', '20261018120001', '--url', fixture().url,
    '--private-key', privatePath, '--public-key', publicPath, '--output', output, '--notes', 'Same-day release'];
  await main(args);
  const result = verifyManifest(JSON.parse(fs.readFileSync(output)), publicKey);
  assert.equal(result.notes, 'Same-day release');
  assert.deepEqual({ sha256: result.sha256, size: result.size }, await archiveMetadata(zip));
  fs.chmodSync(privatePath, 0o644);
  await assert.rejects(main(args), /permissions 600/);
  assert.deepEqual(verifyManifest(JSON.parse(fs.readFileSync(output)), publicKey), result);
});

test('keygen uses only a temporary release machine, refuses overwrites and in-repository private keys', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-ota-keygen-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'test-repository');
  const script = path.join(root, 'mac/scripts/ota-keygen.sh');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(new URL('../mac/scripts/ota-keygen.sh', import.meta.url), script);
  const privatePath = path.join(directory, 'test-release-machine/ed25519-private.pem');
  const run = filename => spawnSync('/bin/bash', [script], {
    env: { ...process.env, OTA_PRIVATE_KEY: filename }, encoding: 'utf8',
  });
  assert.notEqual(run(path.join(root, 'forbidden/private.pem')).status, 0);
  assert.equal(fs.existsSync(path.join(root, 'forbidden/private.pem')), false);
  const result = run(privatePath);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(privatePath).mode & 0o777, 0o600);
  const publicPath = path.join(root, 'mac/ota-public-key.txt');
  const originalPublic = fs.readFileSync(publicPath, 'utf8');
  assert.equal(Buffer.from(originalPublic.trim(), 'base64').length, 32);
  assert.notEqual(run(privatePath).status, 0);
  assert.equal(fs.readFileSync(publicPath, 'utf8'), originalPublic);
  assert.notEqual(run(path.join(directory, 'another-test-private.pem')).status, 0);
  assert.equal(fs.existsSync(path.join(directory, 'another-test-private.pem')), false);
});
