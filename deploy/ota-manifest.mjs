#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export const DEFAULT_FEED = 'https://agent-anywhere.nuts-claw.tech/updates/mac/latest.json';
const decimal = value => typeof value === 'string' && /^\d+$/.test(value);
const version = value => typeof value === 'string' && /^\d+(\.\d+)*$/.test(value);
function decode64(value, length) {
  if (typeof value !== 'string') throw new Error('Invalid base64');
  const data = Buffer.from(value, 'base64');
  if (data.toString('base64') !== value || (length && data.length !== length)) throw new Error('Invalid base64');
  return data;
}
export function validatePayload(payload, feedURL = DEFAULT_FEED) {
  const feed = new URL(feedURL);
  const url = new URL(payload.url);
  if (feed.protocol !== 'https:' || url.protocol !== 'https:' || url.origin !== feed.origin ||
      feed.username || feed.password || url.username || url.password || url.hash) throw new Error('HTTPS feed origin required');
  if (!url.pathname.endsWith('.zip') || !version(payload.version) || !decimal(payload.build) ||
      !version(payload.minimumSystemVersion) || !/^[a-f0-9]{64}$/.test(payload.sha256) ||
      !Number.isSafeInteger(payload.size) || payload.size <= 0 ||
      (payload.notes != null && typeof payload.notes !== 'string') ||
      typeof payload.publishedAt !== 'string' || !Number.isFinite(Date.parse(payload.publishedAt))) throw new Error('Invalid payload metadata');
  return payload;
}
export function publicKeyFromRaw(base64) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: decode64(base64.trim(), 32).toString('base64url') }, format: 'jwk' });
}
export function signManifest(payload, privateKey, publicKey, feedURL = DEFAULT_FEED) {
  validatePayload(payload, feedURL);
  if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 keys required');
  const bytes = Buffer.from(JSON.stringify(payload));
  const envelope = { payload: bytes.toString('base64'), signature: sign(null, bytes, privateKey).toString('base64') };
  verifyManifest(envelope, publicKey, feedURL); // Fail before writing when key files do not match.
  return envelope;
}
export function verifyManifest(envelope, publicKey, feedURL = DEFAULT_FEED) {
  const bytes = decode64(envelope.payload);
  if (!verify(null, bytes, publicKey, decode64(envelope.signature, 64))) throw new Error('Manifest signature verification failed');
  return validatePayload(JSON.parse(bytes.toString('utf8')), feedURL);
}
export async function archiveMetadata(filename) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(filename)) { size += chunk.length; hash.update(chunk); }
  return { sha256: hash.digest('hex'), size };
}
export async function main(args) {
  const options = {};
  const allowed = new Set(['zip', 'version', 'build', 'url', 'feed', 'minimum-system-version', 'notes', 'private-key', 'public-key', 'output']);
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !allowed.has(name) || args[i + 1] === undefined || name in options) throw new Error('Invalid or duplicate option');
    options[name] = args[i + 1];
  }
  for (const name of ['zip', 'version', 'build', 'url', 'output']) if (!options[name]) throw new Error(`Missing --${name}`);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const privatePath = options['private-key'] ?? process.env.OTA_PRIVATE_KEY ?? path.join(os.homedir(), '.agentanywhere/ota/ed25519-private.pem');
  const actual = fs.realpathSync(privatePath);
  const actualRoot = fs.realpathSync(root);
  if (actual === actualRoot || actual.startsWith(actualRoot + path.sep)) throw new Error('Private key must be outside the repository');
  const stat = fs.lstatSync(privatePath);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error('Private key must be a regular file with permissions 600');
  const privateKey = createPrivateKey(fs.readFileSync(privatePath));
  const publicKey = publicKeyFromRaw(fs.readFileSync(options['public-key'] ?? path.join(root, 'mac/ota-public-key.txt'), 'utf8'));
  const payload = {
    version: options.version, build: options.build, url: options.url,
    ...await archiveMetadata(options.zip), notes: options.notes ?? '',
    minimumSystemVersion: options['minimum-system-version'] ?? '14.0',
    publishedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  const envelope = signManifest(payload, privateKey, publicKey, options.feed ?? DEFAULT_FEED);
  const temp = `${options.output}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(envelope) + '\n', { flag: 'wx', mode: 0o644 });
    fs.renameSync(temp, options.output);
  } finally { fs.rmSync(temp, { force: true }); }
  console.log(`Signed and locally verified OTA manifest for ${payload.version}-${payload.build}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
