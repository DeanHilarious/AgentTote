import { createPrivateKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { loadApnsConfig } from './apns.ts';
import type { ApnsConfig } from './apns.ts';
import { parseTestAccounts } from './targets.ts';

export interface Config {
  apns?: ApnsConfig;
  port: number;
  host: string;
  trustProxy: boolean;
  dataDir: string;
  serverSecret: string;
  signingKey: string;
  emailSender: 'console' | 'smtp';
  smsSender: 'console' | 'aliyun' | 'tencent';
  feedbackEmail?: string;
  smtpUrl?: string;
  mailFrom?: string;
  testAccounts: Map<string, string>;
}

export function readTrustProxy(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AA_TRUST_PROXY === '1' || env.AA_TRUST_PROXY === 'true';
}

function developmentKey(path: string, generate: () => string): string {
  try {
    writeFileSync(path, generate(), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  chmodSync(path, 0o600);
  return readFileSync(path, 'utf8').trim();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, log = console.log): Config {
  const port = Number(env.PORT ?? 8790);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
  const host = env.AA_HOST ?? '0.0.0.0';
  if (!isIP(host)) throw new Error('AA_HOST must be an IP address');
  const emailSender = env.AA_EMAIL_SENDER ?? 'console';
  const smsSender = env.AA_SMS_SENDER ?? 'console';
  if (emailSender !== 'console' && emailSender !== 'smtp') throw new Error('Invalid AA_EMAIL_SENDER');
  if (smsSender !== 'console' && smsSender !== 'aliyun' && smsSender !== 'tencent') throw new Error('Invalid AA_SMS_SENDER');
  if (emailSender === 'smtp' && (!env.AA_SMTP_URL || !env.AA_MAIL_FROM)) {
    throw new Error('SMTP requires AA_SMTP_URL and AA_MAIL_FROM');
  }
  if (env.NODE_ENV === 'production' && (!env.AA_SERVER_SECRET || !env.AA_SIGNING_KEY)) {
    throw new Error('Production requires AA_SERVER_SECRET and AA_SIGNING_KEY');
  }
  const dataDir = resolve(env.AA_DATA_DIR ?? fileURLToPath(new URL('../data', import.meta.url)));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (!env.AA_SERVER_SECRET || !env.AA_SIGNING_KEY) log('开发密钥，勿用于生产');
  const serverSecret = env.AA_SERVER_SECRET || developmentKey(resolve(dataDir, 'server-secret'), () => randomBytes(32).toString('hex'));
  const signingKey = env.AA_SIGNING_KEY || developmentKey(resolve(dataDir, 'signing-key.pem'), () =>
    generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  if (Buffer.byteLength(serverSecret) < 32) throw new Error('AA_SERVER_SECRET must be at least 32 bytes');
  if (createPrivateKey(signingKey).asymmetricKeyType !== 'ed25519') throw new Error('AA_SIGNING_KEY must be Ed25519');
  return {
    apns: loadApnsConfig(env, log),
    port, host, trustProxy: readTrustProxy(env), dataDir, serverSecret, signingKey, emailSender, smsSender,
    feedbackEmail: env.AA_FEEDBACK_EMAIL?.trim() || undefined,
    smtpUrl: env.AA_SMTP_URL, mailFrom: env.AA_MAIL_FROM,
    testAccounts: parseTestAccounts(env.AA_TEST_ACCOUNTS),
  };
}
