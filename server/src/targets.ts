import { HttpError } from './errors.ts';

export type Channel = 'email' | 'sms';
export type Purpose = 'register' | 'reset' | 'bind';

export function normalizeTarget(channel: unknown, value: unknown): { channel: Channel; target: string } {
  const invalid = () => new HttpError(400, 'invalid_target', 'Invalid email address or phone number');
  if ((channel !== 'email' && channel !== 'sms') || typeof value !== 'string') throw invalid();
  let target = value.trim();
  if (channel === 'sms') {
    if (/^1[3-9]\d{9}$/.test(target)) target = `+86${target}`;
    if (!/^\+[1-9]\d{7,14}$/.test(target)) throw invalid();
    if (target.startsWith('+86') && !/^\+861[3-9]\d{9}$/.test(target)) throw invalid();
  } else {
    target = target.toLowerCase();
    const parts = target.split('@');
    const local = parts[0];
    const domain = parts[1];
    if (parts.length !== 2 || target.length > 254 || !local || local.length > 64 ||
        !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || local.startsWith('.') ||
        local.endsWith('.') || local.includes('..') || !domain || !domain.includes('.') ||
        !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw invalid();
    }
  }
  return { channel, target };
}

export function parsePurpose(value: unknown): Purpose {
  if (value === 'register' || value === 'reset' || value === 'bind') return value;
  throw new HttpError(400, 'invalid_request', 'Invalid purpose');
}

export function parseTestAccounts(value = ''): Map<string, string> {
  const accounts = new Map<string, string>();
  if (!value.trim()) return accounts;
  for (const entry of value.split(',')) {
    const match = /^(email|sms):(.+)=(\d{6})$/.exec(entry.trim());
    if (!match) throw new Error('Invalid AA_TEST_ACCOUNTS entry');
    const { channel, target } = normalizeTarget(match[1], match[2]);
    accounts.set(`${channel}:${target}`, match[3]);
  }
  return accounts;
}
