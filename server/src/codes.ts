import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './db.ts';
import { HttpError } from './errors.ts';
import type { CodeSender } from './senders.ts';
import type { Channel, Purpose } from './targets.ts';

interface CodeRow {
  id: number;
  code_hash: string;
  expires_at: number;
  attempts: number;
  consumed_at: number | null;
}

export function createCodes(db: DatabaseSync, secret: string, now: () => number,
  senders: Record<Channel, CodeSender>, testAccounts: ReadonlyMap<string, string> = new Map()) {
  const hash = (channel: Channel, target: string, code: string) =>
    createHmac('sha256', secret).update(`${channel}|${target}|${code}`).digest();

  function rateLimit(target: string, ip: string, time: number) {
    const targets = db.prepare('SELECT created_at FROM codes WHERE target = ? AND created_at > ? ORDER BY created_at')
      .all(target, time - 86_400_000) as unknown as { created_at: number }[];
    const ips = db.prepare('SELECT created_at FROM codes WHERE ip = ? AND created_at > ? ORDER BY created_at')
      .all(ip, time - 3_600_000) as unknown as { created_at: number }[];
    let until = time;
    const latest = targets.at(-1);
    if (latest) until = Math.max(until, latest.created_at + 60_000);
    if (targets.length >= 10) until = Math.max(until, targets[targets.length - 10].created_at + 86_400_000);
    if (ips.length >= 30) until = Math.max(until, ips[ips.length - 30].created_at + 3_600_000);
    if (until > time) throw new HttpError(429, 'rate_limited', 'Too many requests', Math.ceil((until - time) / 1000));
  }

  return {
    async send(channel: Channel, target: string, purpose: Purpose, ip: string, deliver = true) {
      const time = now();
      const fixed = testAccounts.get(`${channel}:${target}`);
      const code = fixed ?? randomInt(0, 1_000_000).toString().padStart(6, '0');
      // Reserve the quota before awaiting delivery so concurrent sends cannot bypass it.
      const id = transaction(db, () => {
        // Rate limits look back at most a day; don't keep addresses and IPs longer than needed.
        db.prepare('DELETE FROM codes WHERE created_at <= ?').run(time - 2 * 86_400_000);
        rateLimit(target, ip, time);
        db.prepare('UPDATE codes SET consumed_at = ? WHERE channel = ? AND target = ? AND purpose = ? AND consumed_at IS NULL')
          .run(time, channel, target, purpose);
        return db.prepare(`INSERT INTO codes (channel, target, purpose, code_hash, expires_at, created_at, ip)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(channel, target, purpose, hash(channel, target, code).toString('hex'),
          time + 300_000, time, ip).lastInsertRowid;
      });
      if (!deliver) db.prepare('UPDATE codes SET consumed_at = ? WHERE id = ?').run(time, id);
      try {
        if (deliver && fixed === undefined) await senders[channel].send(target, code, purpose);
      } catch {
        // Keep the quota record even on delivery failure; otherwise outages enable unlimited retries.
        db.prepare('UPDATE codes SET consumed_at = ? WHERE id = ?').run(now(), id);
        throw new HttpError(500, 'delivery_failed', 'Could not send the verification code; the delivery channel may not be configured');
      }
      return { expiresIn: 300, resendAfter: 60 };
    },

    consume(channel: Channel, target: string, purpose: Purpose, code: unknown): boolean {
      return transaction(db, () => {
        const time = now();
        const row = db.prepare('SELECT * FROM codes WHERE channel = ? AND target = ? AND purpose = ? ORDER BY id DESC LIMIT 1')
          .get(channel, target, purpose) as unknown as CodeRow | undefined;
        const supplied = typeof code === 'string' && /^\d{6}$/.test(code) ? code : '';
        const expected = row ? Buffer.from(row.code_hash, 'hex') : Buffer.alloc(32);
        const matches = timingSafeEqual(hash(channel, target, supplied), expected);
        if (!row || row.consumed_at !== null || row.expires_at <= time || row.attempts >= 5) return false;
        db.prepare('UPDATE codes SET attempts = attempts + 1, consumed_at = ? WHERE id = ?')
          .run(matches || row.attempts >= 4 ? time : null, row.id);
        return matches;
      });
    },
  };
}
