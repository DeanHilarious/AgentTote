import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { authorizeUpgrade } from '../src/server.ts';
import { verifyTicket } from '../src/ticket.ts';
import { config, nowMs, nowSeconds, publicKeyPem, signClaims, ticket } from './accountHelpers.ts';

const options = { deviceId: config.deviceId, userId: 'user-1', now: () => nowMs };
const context = { ...options, pairingToken: config.token, publicKeyPem };

test('verifyTicket accepts a native Ed25519 connect ticket', () => {
  assert.equal(verifyTicket(ticket(), publicKeyPem, options)?.dev, config.deviceId);
});

test('verifyTicket rejects tampering and incorrect signatures', () => {
  const parts = ticket().split('.');
  parts[1] = Buffer.from(JSON.stringify({ sub: 'attacker', typ: 'connect', dev: config.deviceId, iat: nowSeconds, exp: nowSeconds + 300 })).toString('base64url');
  assert.equal(verifyTicket(parts.join('.'), publicKeyPem, options), undefined);
  parts[1] = ticket().split('.')[1];
  parts[2] = Buffer.alloc(64).toString('base64url');
  assert.equal(verifyTicket(parts.join('.'), publicKeyPem, options), undefined);
  parts[2] = Buffer.alloc(63).toString('base64url');
  assert.equal(verifyTicket(parts.join('.'), publicKeyPem, options), undefined);
  const wrongKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  assert.equal(verifyTicket(ticket(), wrongKey, options), undefined);
});

test('verifyTicket binds type, device and user and limits lifetime', () => {
  for (const changes of [
    { typ: 'access' }, { dev: 'other-device' }, { sub: 'other-user' },
    { exp: nowSeconds + 301 }, { exp: nowSeconds }, { iat: 1.5 }, { sub: '' }, { dev: null },
    { exp: '1800000300' }, { iat: nowSeconds - 500, exp: nowSeconds - 61 },
  ]) assert.equal(verifyTicket(ticket(changes), publicKeyPem, options), undefined);
});

test('verifyTicket tolerates exactly 60 seconds of clock skew with an exclusive expiry boundary', () => {
  for (const ahead of [30, 60]) {
    assert.ok(verifyTicket(ticket({ iat: nowSeconds + ahead, exp: nowSeconds + ahead + 300 }), publicKeyPem, options));
  }
  assert.equal(verifyTicket(ticket({ iat: nowSeconds + 90, exp: nowSeconds + 390 }), publicKeyPem, options), undefined);
  assert.ok(verifyTicket(ticket({ iat: nowSeconds - 300, exp: nowSeconds - 59 }), publicKeyPem, options));
  assert.equal(verifyTicket(ticket({ iat: nowSeconds - 300, exp: nowSeconds - 60 }), publicKeyPem, options), undefined);
});

test('verifyTicket strictly checks headers, canonical base64url and Ed25519 key type', () => {
  const claims = { sub: 'user-1', typ: 'connect', dev: config.deviceId, iat: nowSeconds, exp: nowSeconds + 300 };
  for (const header of [{ alg: 'HS256', typ: 'JWT' }, { alg: 'EdDSA', typ: 'other' }, { alg: 'EdDSA', typ: 'JWT', kid: 'extra' }]) {
    assert.equal(verifyTicket(signClaims(claims, header), publicKeyPem, options), undefined);
  }
  for (const value of ['', 'invalid', 'a.b.c', `${ticket()}=`, `${ticket()}.extra`, 'x'.repeat(4097)]) {
    assert.equal(verifyTicket(value, publicKeyPem, options), undefined);
  }
  const parts = ticket().split('.');
  parts[2] = parts[2].slice(0, -1) + 'B';
  assert.equal(verifyTicket(parts.join('.'), publicKeyPem, options), undefined);
  const ecKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
  assert.equal(verifyTicket(ticket(), ecKey, options), undefined);
  assert.equal(verifyTicket(ticket(), 'broken pem', options), undefined);
});

test('authorizeUpgrade accepts pairing and only accepts account tickets with a logged-in matching user and key', () => {
  assert.equal(authorizeUpgrade(config.token, context), 'pairing');
  assert.equal(authorizeUpgrade('incorrect-token', context), undefined);
  assert.equal(authorizeUpgrade(ticket(), context), 'account');
  assert.equal(authorizeUpgrade(ticket(), { ...context, userId: undefined }), undefined);
  assert.equal(authorizeUpgrade(ticket(), { ...context, publicKeyPem: undefined }), undefined);
  assert.equal(authorizeUpgrade(ticket({ dev: 'other-device' }), context), undefined);
  assert.equal(authorizeUpgrade(ticket({ sub: 'other-user' }), context), undefined);
  assert.equal(authorizeUpgrade(config.token, { ...context, userId: undefined, publicKeyPem: undefined }), 'pairing');
});
