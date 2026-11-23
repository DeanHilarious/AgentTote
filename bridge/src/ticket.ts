import { createPublicKey, verify } from 'node:crypto';

export interface TicketClaims {
  sub: string;
  typ: 'connect';
  dev: string;
  iat: number;
  exp: number;
}

function decode(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error('Invalid encoding');
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) throw new Error('Invalid encoding');
  return bytes;
}

export function verifyTicket(ticket: string, publicKeyPem: string, options: {
  deviceId: string; userId: string; now?: () => number;
}): TicketClaims | undefined {
  try {
    if (typeof ticket !== 'string' || ticket.length > 4096) return undefined;
    const parts = ticket.split('.');
    if (parts.length !== 3) return undefined;
    const [headerPart, payloadPart, signaturePart] = parts;
    const header = JSON.parse(decode(headerPart).toString('utf8'));
    if (!header || header.alg !== 'EdDSA' || header.typ !== 'JWT' || Object.keys(header).length !== 2) return undefined;
    const payloadBytes = decode(payloadPart);
    const signature = decode(signaturePart);
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 ||
        !verify(null, Buffer.from(`${headerPart}.${payloadPart}`), key, signature)) return undefined;
    const claims = JSON.parse(payloadBytes.toString('utf8')) as TicketClaims;
    const time = Math.floor((options.now ?? Date.now)() / 1000);
    // The issuer and this Mac have separate clocks; tolerate one minute in either direction.
    if (!claims || typeof claims.sub !== 'string' || !claims.sub || claims.typ !== 'connect' ||
        typeof claims.dev !== 'string' || !claims.dev ||
        !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
        claims.iat > time + 60 || claims.exp <= time - 60 || claims.exp <= claims.iat ||
        claims.exp - claims.iat > 300 || claims.dev !== options.deviceId || claims.sub !== options.userId) return undefined;
    return claims;
  } catch {
    return undefined;
  }
}
