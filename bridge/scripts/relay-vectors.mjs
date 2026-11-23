import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { publicKey, bridgeHandshake, transport } from '../src/relayCrypto.ts';

export function generateVectors() {
  const staticPrivate = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const phonePrivate = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 32));
  const ephemeralPrivate = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 64));
  const deviceId = '00112233-4455-6677-8899-aabbccddeeff';
  const msg1 = Buffer.concat([Buffer.from([1]), publicKey(phonePrivate)]);
  const result = bridgeHandshake(staticPrivate, deviceId, msg1, ephemeralPrivate);
  const phone = transport(result, 'phone'), bridge = transport(result, 'bridge');
  const messages = [
    { direction: 'p2b', counter: '0', plaintext: '{"auth":"example-ticket"}' },
    { direction: 'p2b', counter: '1', plaintext: '{"id":1,"method":"hello","params":{}}' },
    { direction: 'b2p', counter: '1', plaintext: '{"auth":"ok"}' },
  ].map(message => ({ ...message, ciphertext: (message.direction === 'p2b' ? phone : bridge).seal(message.plaintext).toString('hex') }));
  return {
    version: 1, encoding: 'Keys, transcript, handshake messages and ciphertext are hexadecimal; counters are decimal strings; plaintext is exact UTF-8.',
    deviceId, staticPrivate: staticPrivate.toString('hex'), phonePrivate: phonePrivate.toString('hex'),
    ephemeralPrivate: ephemeralPrivate.toString('hex'), staticPublic: publicKey(staticPrivate).toString('hex'),
    publicKey: publicKey(staticPrivate).toString('base64url'), transcript: result.transcript.toString('hex'),
    msg1: msg1.toString('hex'), msg2: result.msg2.toString('hex'),
    k_p2b: result.k_p2b.toString('hex'), k_b2p: result.k_b2p.toString('hex'), messages,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeFile(new URL('../../docs/relay-test-vectors.json', import.meta.url), JSON.stringify(generateVectors(), null, 2) + '\n');
}
