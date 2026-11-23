import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './db.ts';
import { unauthorized } from './errors.ts';

export type TokenType = 'access' | 'connect';
export interface TokenClaims {
  sub: string;
  typ: TokenType;
  iat: number;
  exp: number;
  dev?: string;
}

export interface VerifyOptions {
  typ: TokenType;
  now?: () => number;
  userId?: string;
  deviceId?: string;
}

const lifetimes = { access: 900, connect: 300 };

function decode(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw unauthorized();
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) throw unauthorized();
  return bytes;
}

export function signToken(claims: TokenClaims, privateKey: string | KeyObject): string {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected an Ed25519 signing key');
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const message = `${header}.${payload}`;
  return `${message}.${sign(null, Buffer.from(message), key).toString('base64url')}`;
}

// now() uses milliseconds; signed iat/exp use Unix seconds for cross-client verification.
export function verifyToken(token: string, publicKey: string | KeyObject, options: VerifyOptions): TokenClaims {
  try {
    if (typeof token !== 'string' || token.length > 4096) throw unauthorized();
    const parts = token.split('.');
    if (parts.length !== 3) throw unauthorized();
    const [headerPart, payloadPart, signaturePart] = parts;
    const header = JSON.parse(decode(headerPart).toString('utf8'));
    if (!header || header.alg !== 'EdDSA' || header.typ !== 'JWT' || Object.keys(header).length !== 2) throw unauthorized();
    const payloadBytes = decode(payloadPart);
    const signature = decode(signaturePart);
    const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
    // Signature checking stays in the native crypto primitive, never a JS string comparison.
    if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 ||
        !verify(null, Buffer.from(`${headerPart}.${payloadPart}`), key, signature)) throw unauthorized();
    const claims = JSON.parse(payloadBytes.toString('utf8')) as TokenClaims;
    const time = Math.floor((options.now ?? Date.now)() / 1000);
    if (!claims || typeof claims.sub !== 'string' || !claims.sub ||
        (claims.typ !== 'access' && claims.typ !== 'connect') || claims.typ !== options.typ ||
        !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
        claims.iat > time || claims.exp <= time || claims.exp <= claims.iat ||
        claims.exp - claims.iat > lifetimes[claims.typ] ||
        (claims.typ === 'connect' && (typeof claims.dev !== 'string' || !claims.dev)) ||
        (options.deviceId !== undefined && claims.dev !== options.deviceId) ||
        (options.userId !== undefined && claims.sub !== options.userId)) throw unauthorized();
    return claims;
  } catch {
    throw unauthorized();
  }
}

interface RefreshRow {
  id: string;
  user_id: string;
  device_label: string;
  family_id: string;
  expires_at: number;
  revoked_at: number | null;
  replaced_by: string | null;
}

export function createTokens(db: DatabaseSync, privateKey: string | KeyObject, now: () => number) {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  if (key.asymmetricKeyType !== 'ed25519' || key.type !== 'private') throw new Error('Expected an Ed25519 private key');
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
  const hash = (token: string) => createHash('sha256').update(token).digest('hex');
  const validRefresh = (token: unknown): token is string => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);

  function issue(userId: string, typ: TokenType, deviceId?: string): string {
    const iat = Math.floor(now() / 1000);
    return signToken({ sub: userId, typ, iat, exp: iat + lifetimes[typ], ...(deviceId ? { dev: deviceId } : {}) }, key);
  }

  function insertRefresh(userId: string, deviceLabel: string, familyId: string) {
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    db.prepare(`INSERT INTO refresh_tokens (id, user_id, device_label, token_hash, family_id, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, userId, deviceLabel, hash(token), familyId, now() + 30 * 86_400_000);
    return { id, token };
  }

  return {
    publicKey,
    access(userId: string) { return issue(userId, 'access'); },
    connect(userId: string, deviceId: string) { return issue(userId, 'connect', deviceId); },
    authenticate(token: string) { return verifyToken(token, publicKey, { typ: 'access', now }).sub; },
    createSession(userId: string, deviceLabel: string) {
      return { accessToken: issue(userId, 'access'), refreshToken: insertRefresh(userId, deviceLabel, randomUUID()).token };
    },
    refresh(token: unknown) {
      if (!validRefresh(token)) throw unauthorized();
      const pair = transaction(db, () => {
        const row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(hash(token)) as unknown as RefreshRow | undefined;
        if (!row) return null;
        if (row.replaced_by !== null) {
          db.prepare('UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE family_id = ?').run(now(), row.family_id);
          return null;
        }
        if (row.revoked_at !== null || row.expires_at <= now()) return null;
        const replacement = insertRefresh(row.user_id, row.device_label, row.family_id);
        db.prepare('UPDATE refresh_tokens SET revoked_at = ?, replaced_by = ? WHERE id = ?').run(now(), replacement.id, row.id);
        return { accessToken: issue(row.user_id, 'access'), refreshToken: replacement.token };
      });
      // Throw after COMMIT: reuse detection must not roll back the family revocation.
      if (!pair) throw unauthorized();
      return pair;
    },
    logout(token: unknown) {
      if (!validRefresh(token)) throw unauthorized();
      db.prepare(`UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, ?)
        WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = ?)`)
        .run(now(), hash(token));
    },
  };
}
