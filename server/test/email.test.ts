import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { SendMailOptions, Transporter } from 'nodemailer';
import { SmtpSender } from '../src/senders.ts';
import { initializeDatabase } from '../src/db.ts';
import { createCodes } from '../src/codes.ts';
import { initialTime, secret } from './helpers.ts';

test('SMTP sends purpose-specific Chinese subject, text and inline HTML without personal data or tracking', async () => {
  const messages: SendMailOptions[] = [];
  const transport = { async sendMail(message: SendMailOptions) { messages.push(message); return {}; } } as Pick<Transporter, 'sendMail'>;
  const sender = new SmtpSender('unused', 'AgentAnywhere <sender@example.com>', transport);
  for (const [purpose, action] of [['register', '注册'], ['reset', '重置密码'], ['bind', '绑定邮箱']] as const) {
    await sender.send('recipient@example.com', '123456', purpose);
    const mail = messages.at(-1)!;
    assert.equal(mail.subject, `AgentTote ${action}验证码`);
    assert.equal(mail.to, 'recipient@example.com');
    for (const body of [mail.text, mail.html]) {
      assert.equal(typeof body, 'string');
      assert.match(String(body), /123456/);
      assert.match(String(body), /5 分钟/);
      assert.match(String(body), /如非本人操作请忽略/);
      assert.doesNotMatch(String(body), /recipient@|sender@|password|refreshToken|user_id|<img|https?:\/\//i);
    }
    assert.match(String(mail.html), /#4B3AF0/);
    assert.match(String(mail.html), /monospace/);
    assert.match(String(mail.html), /If you did not request it/);
  }
});

test('legacy code schema migrates once, preserves quotas and bind codes, invalidates login codes', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE codes (
      id INTEGER PRIMARY KEY, channel TEXT NOT NULL, target TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('login', 'bind')), code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, consumed_at INTEGER,
      created_at INTEGER NOT NULL, ip TEXT NOT NULL);
      INSERT INTO codes VALUES (1, 'email', 'old@example.com', 'login', 'deadbeef', ${initialTime + 300000}, 0, NULL, ${initialTime}, 'ip');
      INSERT INTO codes VALUES (2, 'email', 'bind@example.com', 'bind', 'deadbeef', ${initialTime + 300000}, 2, NULL, ${initialTime}, 'ip');`);
    initializeDatabase(db);
    initializeDatabase(db);
    const rows = db.prepare('SELECT purpose, consumed_at, attempts FROM codes ORDER BY id').all();
    assert.equal(rows[0].purpose, 'register');
    assert.equal(rows[0].consumed_at, initialTime);
    assert.equal(rows[1].purpose, 'bind');
    assert.equal(rows[1].consumed_at, null);
    assert.equal(rows[1].attempts, 2);
    const sender = { async send() {} };
    const codes = createCodes(db, secret, () => initialTime, { email: sender, sms: sender });
    await assert.rejects(codes.send('email', 'old@example.com', 'reset', 'ip'), { status: 429 });
    await codes.send('email', 'new@example.com', 'reset', 'ip');
    assert.throws(() => db.prepare("UPDATE codes SET purpose = 'login'").run(), /CHECK/);
  } finally { db.close(); }
});
