import { DatabaseSync } from 'node:sqlite';

export function initializeDatabase(db: DatabaseSync): DatabaseSync {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      password_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS identities (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('sms', 'email')),
      target TEXT NOT NULL UNIQUE,
      verified_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, channel)
    );
    CREATE TABLE IF NOT EXISTS auth_attempts (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('register', 'login')),
      target TEXT NOT NULL,
      ip TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      phone_count INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS auth_attempts_ip ON auth_attempts(kind, ip, created_at);
    CREATE INDEX IF NOT EXISTS auth_attempts_target ON auth_attempts(kind, target, created_at);
    CREATE TABLE IF NOT EXISTS push_attempts (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS push_attempts_user_time ON push_attempts(user_id, created_at);
    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      kind TEXT NOT NULL CHECK (kind IN ('agent_request', 'bug', 'idea', 'other')),
      agents TEXT NOT NULL,
      message TEXT NOT NULL,
      contact_ok INTEGER NOT NULL CHECK (contact_ok IN (0, 1)),
      contact_email TEXT,
      diagnostics TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS feedback_ip_time ON feedback(ip_hash, created_at);
    CREATE INDEX IF NOT EXISTS feedback_user_time ON feedback(user_id, created_at);
    CREATE INDEX IF NOT EXISTS feedback_time ON feedback(created_at);
    CREATE TABLE IF NOT EXISTS codes (
      id INTEGER PRIMARY KEY,
      channel TEXT NOT NULL CHECK (channel IN ('sms', 'email')),
      target TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('register', 'reset', 'bind')),
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      consumed_at INTEGER,
      created_at INTEGER NOT NULL,
      ip TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS codes_target_time ON codes(target, created_at);
    CREATE INDEX IF NOT EXISTS codes_ip_time ON codes(ip, created_at);
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_label TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      family_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      replaced_by TEXT REFERENCES refresh_tokens(id)
    );
    CREATE INDEX IF NOT EXISTS refresh_family ON refresh_tokens(family_id);
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      hosts TEXT NOT NULL,
      port INTEGER NOT NULL,
      bridge_version TEXT NOT NULL,
      public_key TEXT,
      last_seen_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS devices_user ON devices(user_id);
  `);
  // CREATE TABLE IF NOT EXISTS does not migrate databases created by older releases.
  if (!db.prepare('PRAGMA table_info(devices)').all().some(column => column.name === 'public_key')) {
    db.exec('ALTER TABLE devices ADD COLUMN public_key TEXT');
  }
  if (!db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'password_hash')) {
    db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
  }
  // Preserve historical quota records, but invalidate codes issued by the retired login flow.
  const codeSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'codes'").get()!;
  if (String(codeSchema.sql).includes("'login'")) {
    transaction(db, () => {
      db.exec(`ALTER TABLE codes RENAME TO codes_legacy;
        DROP INDEX codes_target_time;
        DROP INDEX codes_ip_time;
        CREATE TABLE codes (
          id INTEGER PRIMARY KEY, channel TEXT NOT NULL CHECK (channel IN ('sms', 'email')),
          target TEXT NOT NULL, purpose TEXT NOT NULL CHECK (purpose IN ('register', 'reset', 'bind')),
          code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
          consumed_at INTEGER, created_at INTEGER NOT NULL, ip TEXT NOT NULL
        );
        INSERT INTO codes SELECT id, channel, target, CASE WHEN purpose = 'login' THEN 'register' ELSE purpose END,
          code_hash, expires_at, attempts, CASE WHEN purpose = 'login' THEN COALESCE(consumed_at, created_at) ELSE consumed_at END,
          created_at, ip FROM codes_legacy;
        DROP TABLE codes_legacy;
        CREATE INDEX codes_target_time ON codes(target, created_at);
        CREATE INDEX codes_ip_time ON codes(ip, created_at);`);
    });
  }
  return db;
}

export function openDatabase(path = ':memory:'): DatabaseSync {
  return initializeDatabase(new DatabaseSync(path));
}

export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
