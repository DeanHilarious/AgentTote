import { ApnsClient, notifyBody } from './apns.ts';
import type { ApnsConfig } from './apns.ts';
import type { KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { createPasswordAuth } from './passwords.ts';
import { createCodes } from './codes.ts';
import { readTrustProxy } from './config.ts';
import { initializeDatabase, openDatabase, transaction } from './db.ts';
import { createDevices, deviceId } from './devices.ts';
import { HttpError, stringField, unauthorized } from './errors.ts';
import { createFeedback } from './feedback.ts';
import type { MailSender } from './senders.ts';
import type { CodeSender } from './senders.ts';
import { attachRelay } from './relay.ts';
import { normalizeTarget, parsePurpose } from './targets.ts';
import type { Channel } from './targets.ts';
import { createTokens } from './tokens.ts';

export interface AppOptions {
  feedbackNotification?: { to: string; sender: MailSender };
  legacyPhoneLogin?: boolean;
  apns?: ApnsConfig;
  db?: DatabaseSync;
  databasePath?: string;
  serverSecret: string;
  signingKey: string | KeyObject;
  senders: Record<Channel, CodeSender>;
  testAccounts?: ReadonlyMap<string, string>;
  trustProxy?: boolean;
  now?: () => number;
  log?: (message: string) => void;
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    // Only the final hop is appended by our proxy; earlier entries may be forged.
    const ip = (Array.isArray(forwarded) ? forwarded.at(-1) : forwarded)?.split(',').at(-1)?.trim();
    if (ip) return ip;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function readBody(req: IncomingMessage, allowEmpty = false): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > 64 * 1024) {
        rejected = true;
        chunks.length = 0;
        reject(new HttpError(413, 'body_too_large', 'Request body exceeds 64 KB'));
      } else {
        chunks.push(chunk);
      }
    });
    req.on('error', () => reject(new HttpError(400, 'invalid_request', 'Incomplete request body')));
    req.on('aborted', () => reject(new HttpError(400, 'invalid_request', 'Incomplete request body')));
    req.on('end', () => {
      if (rejected) return;
      try {
        if (size === 0 && allowEmpty) { resolve({}); return; }
        if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Error();
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, 'invalid_request', 'Expected a JSON object'));
      }
    });
  });
}

function json(res: ServerResponse, status: number, body: unknown, retryAfter?: number) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) }),
  });
  res.end(JSON.stringify(body));
}

export function createApp(options: AppOptions) {
  const now = options.now ?? Date.now;
  const legacyPhoneLogin = options.legacyPhoneLogin ?? process.env.AA_LEGACY_PHONE_LOGIN === '1';
  const apns = new ApnsClient(options.apns, now, options.log);
  const trustProxy = options.trustProxy ?? readTrustProxy();
  const db = options.db ? initializeDatabase(options.db) : openDatabase(options.databasePath);
  const codes = createCodes(db, options.serverSecret, now, options.senders, options.testAccounts);
  const passwords = createPasswordAuth(db, now);
  const tokens = createTokens(db, options.signingKey, now);

  const feedback = createFeedback(db, options.serverSecret, now, options.log, options.feedbackNotification);

  function user(userId: string) {
    const row = db.prepare('SELECT id, created_at, password_hash FROM users WHERE id = ?').get(userId) as {
      id: string; created_at: number; password_hash: string | null;
    } | undefined;
    if (!row) throw unauthorized();
    const result: {
      id: string; createdAt: number; hasPassword: boolean; hasLifetimeAccess: boolean; phone?: string; email?: string;
    } = {
      id: row.id, createdAt: row.created_at, hasPassword: row.password_hash !== null,
      // Older iOS releases use this field to open the workspace after sign-in.
      hasLifetimeAccess: true,
    };
    for (const identity of db.prepare('SELECT channel, target FROM identities WHERE user_id = ?').all(userId)) {
      if (identity.channel === 'sms') result.phone = identity.target as string;
      if (identity.channel === 'email') result.email = identity.target as string;
    }
    return result;
  }

  async function route(req: IncomingMessage) {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const method = req.method;
    if (method === 'POST' && (path === '/v1/auth/verify' || path === '/v1/me/phone')) {
      req.resume();
      throw new HttpError(410, path === '/v1/auth/verify' ? 'code_login_removed' : 'phone_binding_removed', 'Use email and password');
    }
    const body = method === 'POST' || method === 'PUT' || method === 'PATCH' ?
      await readBody(req, method === 'POST' && /^\/v1\/devices\/[^/]+\/ticket$/.test(path)) : {};
    if (method === 'GET' && path === '/v1/health') return { ok: true };
    if (method === 'GET' && path === '/v1/keys') return { ed25519PublicKey: tokens.publicKey };
    if (method === 'POST' && ['/v1/auth/register', '/v1/auth/password', '/v1/auth/reset'].includes(path)) {
      const registering = path === '/v1/auth/register';
      if (body.phone !== undefined) {
        if (registering) throw new HttpError(400, 'phone_registration_disabled', 'Phone registration is disabled');
        if (path !== '/v1/auth/password' || !legacyPhoneLogin) throw new HttpError(400, 'phone_login_disabled', 'Use email and password');
      }
      const channel = body.phone !== undefined ? 'sms' : 'email';
      const { target } = normalizeTarget(channel, channel === 'sms' ? body.phone : body.email);
      const label = body.deviceLabel === undefined ? '' : stringField(body, 'deviceLabel', 128);
      const ip = clientIp(req, trustProxy);
      const finish = (id: string) => ({ ...tokens.createSession(id, label), user: user(id), isNewUser: registering });
      if (path === '/v1/auth/password') {
        const id = await passwords.login(target, body.password, ip, channel);
        return transaction(db, () => finish(id));
      }
      const verify = () => {
        if (!codes.consume('email', target, registering ? 'register' : 'reset', body.code)) {
          throw new HttpError(400, 'invalid_code', 'Invalid or expired verification code');
        }
      };
      return registering ? passwords.register(target, body.password, ip, verify, finish) :
        passwords.reset(target, body.password, ip, verify, finish);
    }
    if (method === 'POST' && path === '/v1/auth/code') {
      if (body.channel === 'sms') throw new HttpError(400, 'sms_disabled', 'SMS verification is disabled');
      const { channel, target } = normalizeTarget(body.channel, body.target);
      const purpose = parsePurpose(body.purpose);
      const identity = db.prepare('SELECT user_id FROM identities WHERE target = ?').get(target);
      if (purpose === 'bind') {
        const auth = req.headers.authorization;
        if (!auth?.startsWith('Bearer ')) throw unauthorized();
        const id = tokens.authenticate(auth.slice(7));
        user(id);
        if (identity && identity.user_id !== id) throw new HttpError(409, 'email_taken', 'Email is already bound');
      }
      if (purpose === 'register' && identity) throw new HttpError(409, 'email_taken', 'Email is already bound');
      return codes.send(channel, target, purpose, clientIp(req, trustProxy), purpose !== 'reset' || !!identity);
    }
    if (method === 'POST' && path === '/v1/auth/refresh') return tokens.refresh(body.refreshToken);
    if (method === 'POST' && path === '/v1/auth/logout') {
      tokens.logout(body.refreshToken);
      return { ok: true };
    }

    if (method === 'POST' && path === '/v1/feedback') {
      const auth = req.headers.authorization;
      if (auth !== undefined && !auth.startsWith('Bearer ')) throw unauthorized();
      const current = auth === undefined ? undefined : user(tokens.authenticate(auth.slice(7)));
      return feedback(body, clientIp(req, trustProxy), current);
    }

    const deviceMatch = /^\/v1\/devices\/([^/]+)(\/(?:ticket|notify))?$/.exec(path);
    const protectedRoute = (path === '/v1/me' && (method === 'GET' || method === 'DELETE')) ||
      (['/v1/me/identities', '/v1/me/password'].includes(path) && method === 'POST') ||
      (path === '/v1/devices' && method === 'GET') ||
      (deviceMatch && (deviceMatch[2] ? method === 'POST' : method === 'PUT' || method === 'DELETE'));
    if (!protectedRoute) throw new HttpError(404, 'not_found', 'Route not found');
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) throw unauthorized();
    const userId = tokens.authenticate(auth.slice(7));
    const currentUser = user(userId);
    if (path === '/v1/me') {
      if (method === 'GET') return currentUser;
      const removedDevices = transaction(db, () => {
        const registered = db.prepare('SELECT id FROM devices WHERE user_id = ?').all(userId);
        // Codes and login attempts are keyed by identity, not by a cascading user foreign key.
        db.prepare('DELETE FROM codes WHERE target IN (SELECT target FROM identities WHERE user_id = ?)').run(userId);
        db.prepare('DELETE FROM auth_attempts WHERE target IN (SELECT target FROM identities WHERE user_id = ?)').run(userId);
        db.prepare('DELETE FROM feedback WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        return registered;
      });
      // Only disconnect after commit; a failed deletion must leave the account usable.
      for (const device of removedDevices) relay.closeDevice(String(device.id));
      return { ok: true };
    }
    if (path === '/v1/me/password') {
      await passwords.setPassword(userId, body.currentPassword, body.newPassword);
      return user(userId);
    }
    if (path === '/v1/me/identities') {
      if (body.channel === 'sms') throw new HttpError(400, 'sms_disabled', 'SMS verification is disabled');
      const { channel, target } = normalizeTarget(body.channel, body.target);
      if (!codes.consume(channel, target, 'bind', body.code)) throw new HttpError(400, 'invalid_code', 'Invalid or expired verification code');
      return transaction(db, () => {
        const identity = db.prepare('SELECT user_id FROM identities WHERE target = ?').get(target);
        const existing = db.prepare('SELECT target FROM identities WHERE user_id = ? AND channel = ?').get(userId, channel);
        if ((identity && identity.user_id !== userId) || (existing && existing.target !== target)) {
          throw new HttpError(409, 'email_taken', 'Email is already bound');
        }
        db.prepare(`INSERT INTO identities (user_id, channel, target, verified_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id, channel) DO UPDATE SET verified_at = excluded.verified_at`).run(userId, channel, target, now());
        return user(userId);
      });
    }
    if (path === '/v1/devices') return { devices: devices.list(userId) };
    const id = deviceId(deviceMatch![1]);
    if (deviceMatch![2] === '/notify') {
      if (!db.prepare('SELECT id FROM devices WHERE id = ? AND user_id = ?').get(id, userId)) throw new HttpError(404, 'not_found', 'Device not found');
      const notification = notifyBody(body);
      if (!apns.available) throw new HttpError(503, 'push_disabled', 'Push notifications are disabled');
      transaction(db, () => {
        const time = now();
        db.prepare('DELETE FROM push_attempts WHERE created_at <= ?').run(time - 86400_000);
        let retryAfter = 0;
        for (const [window, limit] of [[60_000, 30], [86400_000, 500]]) {
          const row = db.prepare('SELECT count(*) AS n, min(created_at) AS oldest FROM push_attempts WHERE user_id = ? AND created_at > ?').get(userId, time - window)!;
          if (Number(row.n) >= limit) retryAfter = Math.max(retryAfter, Math.ceil((Number(row.oldest) + window - time) / 1000));
        }
        if (retryAfter) throw new HttpError(429, 'rate_limited', 'Notification limit exceeded', retryAfter);
        db.prepare('INSERT INTO push_attempts (user_id, created_at) VALUES (?, ?)').run(userId, time);
      });
      return apns.send(userId, notification);
    }
    if (deviceMatch![2]) return devices.ticket(userId, id);
    if (method === 'PUT') return devices.put(userId, id, body);
    return devices.remove(userId, id);
  }

  const server = createServer((req, res) => {
    void route(req).then(result => json(res, 200, result)).catch(error => {
      const known = error instanceof HttpError;
      const status = known ? error.status : 500;
      // Sender/SQLite errors can contain private inputs; only log a fixed diagnostic here.
      if (!known) options.log?.('Internal request failure');
      const code = known ? error.code : 'internal_error';
      const message = known ? error.message : 'Internal server error';
      const retryAfter = known ? error.retryAfter : undefined;
      json(res, status, { error: { code, message, ...(retryAfter === undefined ? {} : { retryAfter }) } }, retryAfter);
    });
  });
  const relay = attachRelay(server, {
    db, now, log: options.log,
    authenticate(token) { const id = tokens.authenticate(token); user(id); return id; },
    clientIp: req => clientIp(req, trustProxy),
  });
  const devices = createDevices(db, now, tokens.connect, relay);
  server.once('close', () => apns.close());
  if (!options.db) server.once('close', () => db.close());
  return server;
}
