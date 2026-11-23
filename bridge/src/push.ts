import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { AccountError, AccountNetworkError } from './account.ts';
import type { AccountClient } from './account.ts';
import { publicKey, sharedSecret } from './relayCrypto.ts';
import { rememberSecret } from './secrets.ts';
import type { PushStatus, TaskInfo } from './types.ts';

const CONTEXT = Buffer.from('aa push v1');
export interface PushRegistration {
  installationId: string;
  apnsToken: string;
  environment: 'sandbox' | 'production';
  publicKey: string;
}
export type PushAccount = Pick<AccountClient, 'status' | 'subscribe' | 'authorizedRequest'>;

export function registration(params: Record<string, unknown>): PushRegistration {
  const { installationId, apnsToken, environment, publicKey: key } = params;
  if (typeof installationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(installationId)) throw new Error('Invalid installationId');
  if (typeof apnsToken !== 'string' || !/^[0-9a-f]{64,200}$/i.test(apnsToken) || apnsToken.length % 2) throw new Error('Invalid apnsToken');
  if (environment !== 'sandbox' && environment !== 'production') throw new Error('Invalid environment');
  if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 32 || Buffer.from(key, 'base64').toString('base64') !== key) throw new Error('Invalid publicKey');
  try { sharedSecret(Buffer.alloc(32, 1), Buffer.from(key, 'base64')); } catch { throw new Error('Invalid publicKey'); }
  rememberSecret(apnsToken);
  rememberSecret(key);
  return { installationId: installationId.toLowerCase(), apnsToken, environment, publicKey: key };
}

/** The optional randomness is only for cross-platform test vectors. */
export function encryptPush(phonePub: Buffer, plaintext: string, ephemeral = randomBytes(32), nonce = randomBytes(12)): string {
  if (nonce.length !== 12) throw new Error('Invalid nonce');
  const ephPub = publicKey(ephemeral);
  const key = Buffer.from(hkdfSync('sha256', sharedSecret(ephemeral, phonePub), Buffer.concat([ephPub, phonePub]), CONTEXT, 32));
  const bytes = Buffer.from(plaintext, 'utf8');
  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  cipher.setAAD(CONTEXT, { plaintextLength: bytes.length });
  return Buffer.concat([Buffer.from([1]), ephPub, nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]).toString('base64');
}

const clip = (text: string, length: number) => Array.from(text).slice(0, length).join('');
export function pushPlaintext(deviceId: string, macName: string, task: TaskInfo): string {
  if (task.status === 'running') throw new Error('Task is still running');
  const data = {
    v: 1, deviceId, macName, taskId: task.id, agent: task.agent,
    ...(task.sessionId ? { sessionId: task.sessionId } : {}), status: task.status,
    title: clip(task.prompt.split(/\r\n|\r|\n/)[0], 80),
    summary: clip((task.status === 'completed' ? task.result ?? '' : task.status === 'failed' ? task.error ?? '' : '').replace(/\s+/gu, ' ').trim(), 240),
    endedAt: task.endedAt!,
  };
  // JSON escaping and multi-byte Unicode can expand the nominal character limits.
  while (4 * Math.ceil((61 + Buffer.byteLength(JSON.stringify(data))) / 3) > 3000) {
    if (!data.summary) throw new Error('Push metadata exceeds payload limit');
    data.summary = clip(data.summary, Array.from(data.summary).length - 1);
  }
  return JSON.stringify(data);
}

export class PushManager {
  private registrations = new Map<string, PushRegistration>();
  private disabled = false;
  private lastStatus: string;
  private unsubscribe?: () => void;
  private account?: PushAccount;
  private device: { deviceId: string; name: string };
  private change: (status: PushStatus) => void;
  private log: (message: string) => void;
  private sleep: (ms: number) => Promise<void>;

  constructor(device: { deviceId: string; name: string }, account: PushAccount | undefined,
    change: (status: PushStatus) => void, log: (message: string) => void,
    sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {
    this.device = device; this.account = account; this.change = change; this.log = log; this.sleep = sleep;
    this.lastStatus = JSON.stringify(this.status);
    this.unsubscribe = account?.subscribe(() => this.changed());
  }
  get status(): PushStatus {
    if (!this.account?.status.user || this.account.status.state === 'revoked' || this.account.status.state === 'signedOut') return { available: false, reason: 'signed_out' };
    return this.disabled ? { available: false, reason: 'server_disabled' } : { available: true };
  }
  private changed() {
    const next = JSON.stringify(this.status);
    if (next !== this.lastStatus) { this.lastStatus = next; this.change(this.status); }
  }
  close() { this.unsubscribe?.(); }
  has(id: string | undefined): id is string { return !!id && this.registrations.has(id); }
  register(params: Record<string, unknown>): string {
    const info = registration(params);
    this.registrations.delete(info.installationId);
    this.registrations.set(info.installationId, info);
    if (this.registrations.size > 20) this.registrations.delete(this.registrations.keys().next().value!);
    return info.installationId;
  }
  async send(task: TaskInfo, installationId: string): Promise<void> {
    const info = this.registrations.get(installationId);
    if (!info) return;
    if (!this.account || this.status.reason === 'signed_out') { this.log('Push skipped: signed_out'); return; }
    try {
      const ciphertext = encryptPush(Buffer.from(info.publicKey, 'base64'), pushPlaintext(this.device.deviceId, this.device.name, task));
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await this.account.authorizedRequest(`/devices/${encodeURIComponent(this.device.deviceId)}/notify`, {
            apnsToken: info.apnsToken, environment: info.environment, ciphertext,
          }, 'POST');
          if (result === undefined) { this.changed(); this.log('Push skipped: signed_out'); return; }
          this.disabled = false; this.changed(); return;
        } catch (error) {
          if (error instanceof AccountNetworkError && attempt < 2) { await this.sleep(attempt === 0 ? 1000 : 5000); continue; }
          if (error instanceof AccountError && error.code === 'token_invalid' && this.registrations.get(installationId) === info) this.registrations.delete(installationId);
          if (error instanceof AccountError && error.code === 'push_disabled') { this.disabled = true; this.changed(); }
          throw error;
        }
      }
    } catch { this.log('Push delivery failed'); }
  }
}
