#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
umask 077
node --input-type=module - "$ROOT" "${OTA_PRIVATE_KEY:-$HOME/.agentanywhere/ota/ed25519-private.pem}" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
const [root, filename] = process.argv.slice(2);
const privatePath = path.resolve(filename);
const publicPath = path.join(root, 'mac/ota-public-key.txt');
if (fs.existsSync(privatePath) || fs.existsSync(publicPath)) throw new Error('Refusing to overwrite an existing OTA key');
fs.mkdirSync(path.dirname(privatePath), { recursive: true, mode: 0o700 });
const actualParent = fs.realpathSync(path.dirname(privatePath));
const actualRoot = fs.realpathSync(root);
if (actualParent === actualRoot || actualParent.startsWith(actualRoot + path.sep)) throw new Error('Private key must be outside the repository');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
fs.writeFileSync(publicPath, raw.toString('base64') + '\n', { flag: 'wx', mode: 0o644 });
console.log('Created OTA key pair. Back up the private key securely; commit only mac/ota-public-key.txt.');
NODE
