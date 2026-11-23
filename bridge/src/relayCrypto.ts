import { createPrivateKey, createPublicKey, randomBytes, diffieHellman, createHash, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';

const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI = Buffer.from('302a300506032b656e032100', 'hex');
function size(key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('Invalid X25519 key');
  return key;
}
export function privateKey(raw: Buffer) {
  return createPrivateKey({ key: Buffer.concat([PKCS8, size(raw)]), format: 'der', type: 'pkcs8' });
}
export function publicKey(rawPrivate: Buffer): Buffer {
  return createPublicKey(privateKey(rawPrivate)).export({ format: 'der', type: 'spki' }).subarray(-32);
}
export function sharedSecret(secret: Buffer, publicBytes: Buffer): Buffer {
  const shared = diffieHellman({ privateKey: privateKey(secret), publicKey: createPublicKey({
    key: Buffer.concat([SPKI, size(publicBytes)]), format: 'der', type: 'spki',
  }) });
  if (shared.every(byte => byte === 0)) throw new Error('Invalid shared secret');
  return shared;
}
export function nonce(counter: bigint): Buffer {
  if (counter < 0n || counter > 0xffffffffffffffffn) throw new Error('Counter exhausted');
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(counter, 4);
  return n;
}
export function encrypt(key: Buffer, counter: bigint, plaintext: Buffer, aad: Buffer = Buffer.alloc(0)): Buffer {
  const cipher = createCipheriv('chacha20-poly1305', key, nonce(counter), { authTagLength: 16 });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}
export function decrypt(key: Buffer, counter: bigint, ciphertext: Buffer, aad: Buffer = Buffer.alloc(0)): Buffer {
  if (ciphertext.length < 16) throw new Error('Invalid ciphertext');
  const decipher = createDecipheriv('chacha20-poly1305', key, nonce(counter), { authTagLength: 16 });
  decipher.setAAD(aad, { plaintextLength: ciphertext.length - 16 });
  decipher.setAuthTag(ciphertext.subarray(-16));
  return Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
}
export function transcript(deviceId: string, s: Buffer, e1: Buffer, e2: Buffer): Buffer {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(deviceId)) throw new Error('Invalid device UUID');
  return Buffer.concat([Buffer.from('AA-RELAY-1'), Buffer.from(deviceId.replaceAll('-', ''), 'hex'), size(s), size(e1), size(e2)]);
}
export function deriveKeys(dh1: Buffer, dh2: Buffer, t: Buffer) {
  if ([dh1, dh2].some(dh => size(dh).every(byte => byte === 0))) throw new Error('Invalid shared secret');
  const okm = Buffer.from(hkdfSync('sha256', Buffer.concat([dh1, dh2]), createHash('sha256').update(t).digest(), 'aa relay v1 keys', 64));
  return { k_p2b: okm.subarray(0, 32), k_b2p: okm.subarray(32) };
}
export function bridgeHandshake(staticPrivate: Buffer, deviceId: string, msg1: Buffer, ephemeral: Buffer = randomBytes(32)) {
  if (msg1.length !== 33 || msg1[0] !== 1) throw new Error('Invalid handshake');
  const e1 = msg1.subarray(1), e2 = publicKey(ephemeral);
  const t = transcript(deviceId, publicKey(staticPrivate), e1, e2);
  const keys = deriveKeys(sharedSecret(staticPrivate, e1), sharedSecret(ephemeral, e1), t);
  const msg2 = Buffer.concat([Buffer.from([1]), e2, encrypt(keys.k_b2p, 0n, Buffer.from('AA-RELAY-OK'), t)]);
  return { ...keys, transcript: t, msg2 };
}
export function phoneHandshake(phonePrivate: Buffer, staticPublic: Buffer, deviceId: string, msg2: Buffer) {
  if (msg2.length !== 60 || msg2[0] !== 1) throw new Error('Invalid handshake');
  const e2 = msg2.subarray(1, 33);
  const t = transcript(deviceId, staticPublic, publicKey(phonePrivate), e2);
  const keys = deriveKeys(sharedSecret(phonePrivate, staticPublic), sharedSecret(phonePrivate, e2), t);
  if (!decrypt(keys.k_b2p, 0n, msg2.subarray(33), t).equals(Buffer.from('AA-RELAY-OK'))) throw new Error('Invalid confirmation');
  return keys;
}
/** Counters are implicit on the wire. AEAD verifies the next expected nonce. */
export function transport(keys: { k_p2b: Buffer; k_b2p: Buffer }, role: 'bridge' | 'phone') {
  let sending = role === 'bridge' ? 1n : 0n;
  let receiving = role === 'bridge' ? 0n : 1n;
  const sendKey = role === 'bridge' ? keys.k_b2p : keys.k_p2b;
  const receiveKey = role === 'bridge' ? keys.k_p2b : keys.k_b2p;
  return {
    seal(text: string): Buffer { const bytes = encrypt(sendKey, sending, Buffer.from(text)); sending++; return bytes; },
    open(bytes: Buffer): string {
      const plain = decrypt(receiveKey, receiving, bytes);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(plain);
      receiving++;
      return text;
    },
  };
}
