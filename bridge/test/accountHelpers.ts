import { generateKeyPairSync, sign } from 'node:crypto';
import type { BridgeConfig } from '../src/config.ts';

export const nowMs = 1_800_000_000_000;
export const nowSeconds = nowMs / 1000;
export const keys = generateKeyPairSync('ed25519');
export const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
export const config: BridgeConfig = {
  disabledAgents: [],
  keepAwake: 'onPower',
  name: 'Test Mac', port: 8787, token: 'pairing-secret',
  deviceId: 'aefbca50-e78c-4a3c-b1d1-488df3cc7777', serverUrl: 'http://account.test',
};

export function signClaims(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'EdDSA', typ: 'JWT' }): string {
  const message = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  return `${message}.${sign(null, Buffer.from(message), keys.privateKey).toString('base64url')}`;
}

export function ticket(changes: Record<string, unknown> = {}): string {
  return signClaims({ sub: 'user-1', typ: 'connect', dev: config.deviceId, iat: nowSeconds, exp: nowSeconds + 300, ...changes });
}

export function access(exp = nowSeconds + 900): string {
  return signClaims({ sub: 'user-1', typ: 'access', iat: nowSeconds, exp });
}

export function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers });
}
