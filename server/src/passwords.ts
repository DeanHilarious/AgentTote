import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './db.ts';
import { HttpError, unauthorized } from './errors.ts';

const N = 16384, r = 8, p = 1;
const dummySalt = randomBytes(16);
const invalidCredentials = () => new HttpError(401, 'invalid_credentials', 'Wrong email or password');

export function validatePassword(value: unknown): string {
  if (typeof value !== 'string' || [...value].length < 8 || [...value].length > 128) {
    throw new HttpError(400, 'weak_password', 'Use 8–128 characters');
  }
  return value;
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N, r, p }, (error, key) => error ? reject(error) : resolve(key));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: unknown, encoded: string | null): Promise<boolean> {
  const parts = encoded?.split('$');
  const valid = parts?.length === 6 && parts[0] === 'scrypt' && parts[1] === String(N) &&
    parts[2] === String(r) && parts[3] === String(p) &&
    /^[A-Za-z0-9_-]{22}$/.test(parts[4]) && /^[A-Za-z0-9_-]{86}$/.test(parts[5]);
  const salt = valid ? Buffer.from(parts[4], 'base64url') : dummySalt;
  const expected = valid ? Buffer.from(parts[5], 'base64url') : Buffer.alloc(64);
  // Unknown identities and accounts without a password still pay the same scrypt cost.
  const supplied = typeof password === 'string' && [...password].length <= 128 ? password : '';
  const key = await derive(supplied, salt);
  return timingSafeEqual(key, expected) && !!valid && typeof password === 'string' && supplied === password;
}

export function createPasswordAuth(db: DatabaseSync, now: () => number) {
  function reserve(kind: string, target: string, ip: string) {
    return transaction(db, () => {
      const time = now();
      db.prepare('DELETE FROM auth_attempts WHERE created_at <= ?').run(time - 3_600_000);
      const ips = db.prepare('SELECT created_at FROM auth_attempts WHERE kind = ? AND ip = ? ORDER BY created_at')
        .all(kind, ip) as unknown as { created_at: number }[];
      const targets = kind === 'login' ? db.prepare(`SELECT created_at FROM auth_attempts
        WHERE kind = 'login' AND target = ? AND phone_count = 1 AND created_at > ? ORDER BY created_at`)
        .all(target, time - 900_000) as unknown as { created_at: number }[] : [];
      const ipLimit = kind === 'register' ? 10 : 60;
      let until = time;
      if (ips.length >= ipLimit) until = Math.max(until, ips[ips.length - ipLimit].created_at + 3_600_000);
      if (targets.length >= 10) until = Math.max(until, targets[targets.length - 10].created_at + 900_000);
      if (until > time) throw new HttpError(429, 'rate_limited', 'Too many attempts', Math.ceil((until - time) / 1000));
      // Pending attempts reserve quota before async hashing, preventing concurrent bypasses.
      return db.prepare('INSERT INTO auth_attempts (kind, target, ip, created_at) VALUES (?, ?, ?, ?)')
        .run(kind, target, ip, time).lastInsertRowid;
    });
  }

  function passwordRow(userId: string) {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string | null } | undefined;
    if (!row) throw unauthorized();
    return row.password_hash;
  }

  return {
    async register<T>(email: string, password: unknown, ip: string, verify: () => void, finish: (id: string) => T): Promise<T> {
      reserve('register', email, ip);
      if (db.prepare('SELECT user_id FROM identities WHERE target = ?').get(email)) {
        throw new HttpError(409, 'email_taken', 'Email is already bound');
      }
      const value = validatePassword(password);
      verify();
      const hash = await hashPassword(value);
      return transaction(db, () => {
        if (db.prepare('SELECT user_id FROM identities WHERE target = ?').get(email)) {
          throw new HttpError(409, 'email_taken', 'Email is already bound');
        }
        const id = randomUUID();
        db.prepare('INSERT INTO users (id, created_at, password_hash) VALUES (?, ?, ?)').run(id, now(), hash);
        db.prepare("INSERT INTO identities (user_id, channel, target, verified_at) VALUES (?, 'email', ?, ?)").run(id, email, now());
        return finish(id);
      });
    },
    async reset<T>(email: string, password: unknown, ip: string, verify: () => void, finish: (id: string) => T): Promise<T> {
      reserve('register', email, ip);
      const value = validatePassword(password);
      verify();
      const hash = await hashPassword(value);
      return transaction(db, () => {
        const row = db.prepare("SELECT user_id FROM identities WHERE channel = 'email' AND target = ?").get(email);
        if (!row) throw new HttpError(400, 'invalid_code', 'Invalid or expired verification code');
        const id = row.user_id as string;
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
        db.prepare('UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?').run(now(), id);
        return finish(id);
      });
    },
    async login(target: string, password: unknown, ip: string, channel: 'email' | 'sms' = 'email'): Promise<string> {
      const attempt = reserve('login', target, ip);
      const row = db.prepare(`SELECT u.id, u.password_hash FROM users u JOIN identities i ON i.user_id = u.id
        WHERE i.channel = ? AND i.target = ?`).get(channel, target) as { id: string; password_hash: string | null } | undefined;
      const matches = await verifyPassword(password, row?.password_hash ?? null);
      if (!matches || !row || passwordRow(row.id) !== row.password_hash) {
        db.prepare('UPDATE auth_attempts SET phone_count = 1 WHERE id = ?').run(attempt);
        throw invalidCredentials();
      }
      transaction(db, () => {
        db.prepare('DELETE FROM auth_attempts WHERE id = ?').run(attempt);
        db.prepare("UPDATE auth_attempts SET phone_count = 0 WHERE kind = 'login' AND target = ?").run(target);
      });
      return row.id;
    },
    async setPassword(userId: string, current: unknown, password: unknown) {
      const value = validatePassword(password);
      const previous = passwordRow(userId);
      if (previous && !await verifyPassword(current, previous)) throw invalidCredentials();
      const hash = await hashPassword(value);
      transaction(db, () => {
        if (passwordRow(userId) !== previous) throw invalidCredentials();
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
      });
    },
  };
}
