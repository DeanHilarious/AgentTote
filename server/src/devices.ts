import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './db.ts';
import { HttpError, stringField } from './errors.ts';

interface DeviceRow {
  id: string;
  user_id: string;
  name: string;
  hosts: string;
  port: number;
  bridge_version: string;
  public_key: string | null;
  last_seen_at: number;
  created_at: number;
}

export function deviceId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, 'invalid_request', 'Device id must be a UUID');
  }
  return value.toLowerCase();
}

export function publicKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value) ||
      Buffer.from(value, 'base64url').length !== 32 || Buffer.from(value, 'base64url').toString('base64url') !== value) {
    throw new HttpError(400, 'invalid_request', 'publicKey must be an unpadded base64url 32-byte key');
  }
  return value;
}

export function createDevices(db: DatabaseSync, now: () => number, connect: (userId: string, id: string) => string,
  relay: { isOnline(id: string): boolean; closeDevice(id: string): void }) {
  function view(row: DeviceRow) {
    return {
      id: row.id, name: row.name, hosts: JSON.parse(row.hosts) as string[], port: row.port,
      bridgeVersion: row.bridge_version, lastSeenAt: row.last_seen_at, createdAt: row.created_at,
      online: row.last_seen_at > now() - 120_000,
      publicKey: row.public_key, relayOnline: relay.isOnline(row.id),
    };
  }

  function owned(userId: string, id: string): DeviceRow {
    const row = db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(id, userId) as unknown as DeviceRow | undefined;
    if (!row) throw new HttpError(404, 'not_found', 'Device not found');
    return row;
  }

  return {
    list(userId: string) {
      return (db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at, id').all(userId) as unknown as DeviceRow[]).map(view);
    },
    put(userId: string, id: string, body: Record<string, unknown>) {
      const name = stringField(body, 'name', 128);
      const bridgeVersion = stringField(body, 'bridgeVersion', 64);
      const hosts = body.hosts;
      const port = body.port;
      const key = body.publicKey === undefined ? undefined : publicKey(body.publicKey);
      if (!Array.isArray(hosts) || hosts.length < 1 || hosts.length > 32 ||
          !hosts.every(host => typeof host === 'string' && host.length > 0 && host.length <= 253 && !/[\s/\\?#@]/.test(host)) ||
          typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new HttpError(400, 'invalid_request', 'Invalid hosts or port');
      }
      return transaction(db, () => {
        const row = db.prepare('SELECT user_id FROM devices WHERE id = ?').get(id);
        if (row && row.user_id !== userId) throw new HttpError(409, 'conflict', 'Device belongs to another user');
        const time = now();
        db.prepare(`INSERT INTO devices (id, user_id, name, hosts, port, bridge_version, last_seen_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
          name = excluded.name, hosts = excluded.hosts, port = excluded.port,
          bridge_version = excluded.bridge_version, last_seen_at = excluded.last_seen_at`)
          .run(id, userId, name, JSON.stringify(hosts), port, bridgeVersion, time, time);
        // An old bridge's heartbeat without publicKey must preserve the registered key.
        if (key !== undefined) db.prepare('UPDATE devices SET public_key = ? WHERE id = ?').run(key, id);
        return view(owned(userId, id));
      });
    },
    remove(userId: string, id: string) {
      if (!db.prepare('DELETE FROM devices WHERE id = ? AND user_id = ?').run(id, userId).changes) {
        throw new HttpError(404, 'not_found', 'Device not found');
      }
      relay.closeDevice(id);
      return { ok: true };
    },
    ticket(userId: string, id: string) {
      owned(userId, id);
      return { ticket: connect(userId, id), expiresIn: 300 };
    },
  };
}
