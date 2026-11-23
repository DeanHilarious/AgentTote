import { createPrivateKey, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect } from 'node:http2';
import type { ClientHttp2Session } from 'node:http2';
import { HttpError } from './errors.ts';

export interface ApnsConfig {
  privateKey: KeyObject;
  keyId: string;
  teamId: string;
  bundleId: string;
  sandboxOrigin: string;
  productionOrigin: string;
}
export interface NotifyBody { apnsToken: string; environment: 'sandbox' | 'production'; ciphertext: string }

export function loadApnsConfig(env: NodeJS.ProcessEnv, log: (message: string) => void): ApnsConfig | undefined {
  try {
    if (!env.AA_APNS_KEY_FILE || !env.AA_APNS_KEY_ID || !env.AA_APNS_TEAM_ID) throw new Error();
    const privateKey = createPrivateKey(readFileSync(env.AA_APNS_KEY_FILE));
    if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error();
    const origin = (override: string | undefined, fallback: string) => {
      const url = new URL(override ?? fallback);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
      return url.origin;
    };
    const bundleId = env.AA_APNS_BUNDLE_ID ?? 'com.deanhilarious.agentanywhere';
    if (!bundleId || /[\s\r\n]/.test(bundleId) || !/^[A-Za-z0-9]+$/.test(env.AA_APNS_KEY_ID) || !/^[A-Za-z0-9]+$/.test(env.AA_APNS_TEAM_ID)) throw new Error();
    return { privateKey, keyId: env.AA_APNS_KEY_ID, teamId: env.AA_APNS_TEAM_ID, bundleId,
      sandboxOrigin: origin(env.AA_APNS_ORIGIN_SANDBOX, 'https://api.sandbox.push.apple.com'),
      productionOrigin: origin(env.AA_APNS_ORIGIN_PRODUCTION, 'https://api.push.apple.com') };
  } catch { log('APNs disabled'); return undefined; }
}

export function notifyBody(body: Record<string, unknown>): NotifyBody {
  const { apnsToken, environment, ciphertext } = body;
  if (typeof apnsToken !== 'string' || !/^[0-9a-f]{64,200}$/i.test(apnsToken) || apnsToken.length % 2 ||
      (environment !== 'sandbox' && environment !== 'production') ||
      typeof ciphertext !== 'string' || !ciphertext || Buffer.byteLength(ciphertext) > 3000 ||
      Buffer.from(ciphertext, 'base64').toString('base64') !== ciphertext) {
    throw new HttpError(400, 'invalid_request', 'Invalid notification body');
  }
  return { apnsToken, environment, ciphertext };
}

export class ApnsClient {
  private sessions = new Map<string, { session: ClientHttp2Session; active: number; idle?: NodeJS.Timeout }>();
  private timeouts: { requestMs: number; idleMs: number };
  private jwt?: { value: string; createdAt: number };
  private config: ApnsConfig | undefined;
  private now: () => number;
  private log: (message: string) => void;
  constructor(config: ApnsConfig | undefined, now = Date.now, log: (message: string) => void = () => {}, timeouts = { requestMs: 10_000, idleMs: 5 * 60_000 }) {
    this.config = config; this.now = now; this.log = log; this.timeouts = timeouts;
  }
  get available() { return !!this.config; }
  close() {
    for (const [origin, entry] of this.sessions) this.discard(origin, entry.session);
  }
  private discard(origin: string, session: ClientHttp2Session) {
    const entry = this.sessions.get(origin);
    if (entry?.session === session) {
      clearTimeout(entry.idle);
      this.sessions.delete(origin);
    }
    session.destroy();
  }
  private authorization(): string {
    const now = this.now();
    if (this.jwt && now >= this.jwt.createdAt && now - this.jwt.createdAt < 50 * 60_000) return this.jwt.value;
    const cfg = this.config!;
    const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid: cfg.keyId })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: cfg.teamId, iat: Math.floor(now / 1000) })).toString('base64url');
    const input = `${head}.${claims}`;
    const value = `${input}.${sign('sha256', Buffer.from(input), { key: cfg.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    this.jwt = { value, createdAt: now };
    return value;
  }
  private session(origin: string): ClientHttp2Session {
    const existing = this.sessions.get(origin);
    if (existing && !existing.session.closed && !existing.session.destroyed) return existing.session;
    if (existing) this.discard(origin, existing.session);
    const session = connect(origin);
    this.sessions.set(origin, { session, active: 0 });
    const forget = () => {
      const entry = this.sessions.get(origin);
      if (entry?.session === session) { clearTimeout(entry.idle); this.sessions.delete(origin); }
    };
    session.on('error', () => { forget(); session.destroy(); });
    session.on('close', forget);
    session.on('goaway', () => { forget(); session.close(); });
    return session;
  }
  private async request(origin: string, body: NotifyBody): Promise<{ status: number; reason: string }> {
    const session = this.session(origin);
    const entry = this.sessions.get(origin)!;
    clearTimeout(entry.idle);
    entry.active++;
    try {
      return await new Promise((resolve, reject) => {
        const req = session.request({ ':method': 'POST', ':path': `/3/device/${body.apnsToken}`,
          authorization: `bearer ${this.authorization()}`, 'apns-topic': this.config!.bundleId, 'apns-push-type': 'alert',
          'apns-priority': '10', 'apns-expiration': String(Math.floor(this.now() / 1000) + 86400) });
        let status = 0, response = '', settled = false;
        const cleanup = () => { clearTimeout(timer); session.off('error', failed); };
        const complete = () => {
          if (settled) return;
          settled = true; cleanup();
          let reason = '';
          try { reason = JSON.parse(response).reason ?? ''; } catch { /* Empty success body. */ }
          resolve({ status, reason });
        };
        const failed = (error: Error) => {
          if (settled) return;
          // An HTTP rejection is authoritative, even if its response body is interrupted.
          if (status >= 400) { complete(); this.discard(origin, session); return; }
          settled = true; cleanup();
          this.discard(origin, session);
          reject(error);
        };
        const timer = setTimeout(() => failed(new Error('APNs timeout')), this.timeouts.requestMs);
        session.on('error', failed);
        req.setEncoding('utf8');
        req.on('error', failed);
        req.on('response', headers => { status = Number(headers[':status']); });
        req.on('data', chunk => { if (response.length < 4096) response += chunk; else failed(new Error('APNs response too large')); });
        req.on('end', () => { if (status) complete(); else failed(new Error('APNs missing status')); });
        req.on('close', () => failed(new Error('APNs stream closed')));
        req.end(JSON.stringify({ aps: { alert: { title: 'AgentTote', body: 'A task you follow has an update.' },
          'mutable-content': 1, sound: 'default' }, aa: body.ciphertext }));
      });
    } catch (error) {
      this.discard(origin, session);
      throw error;
    } finally {
      entry.active--;
      if (entry.active === 0 && this.sessions.get(origin) === entry) {
        entry.idle = setTimeout(() => {
          if (this.sessions.get(origin) !== entry) return;
          this.sessions.delete(origin);
          session.close();
        }, this.timeouts.idleMs);
        entry.idle.unref();
      }
    }
  }
  async send(userId: string, body: NotifyBody): Promise<{ ok: true }> {
    if (!this.config) throw new HttpError(503, 'push_disabled', 'Push notifications are disabled');
    const cfg = this.config;
    let result: { status: number; reason: string };
    const origin = body.environment === 'sandbox' ? cfg.sandboxOrigin : cfg.productionOrigin;
    try {
      try { result = await this.request(origin, body); }
      catch { result = await this.request(origin, body); }
    } catch {
      this.log(`APNs user=${userId.slice(0, 8)} status=0 reason=transport_failure`);
      throw new HttpError(502, 'apns_unavailable', 'APNs is unavailable');
    }
    // Never echo arbitrary upstream text (including reflected request values).
    const reasons = ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic', 'InvalidProviderToken', 'ExpiredProviderToken', 'MissingProviderToken', 'Forbidden', 'TooManyRequests', 'InternalServerError', 'ServiceUnavailable', 'Shutdown'];
    const reason = reasons.includes(result.reason) ? result.reason : result.status === 200 ? 'ok' : 'other';
    this.log(`APNs user=${userId.slice(0, 8)} status=${result.status} reason=${reason}${result.status === 403 ? ' Check APNs key configuration' : ''}`);
    if (result.status === 200) return { ok: true };
    if ((result.status === 400 && ['BadDeviceToken', 'DeviceTokenNotForTopic'].includes(result.reason)) || (result.status === 410 && result.reason === 'Unregistered')) {
      throw new HttpError(410, 'token_invalid', 'Notification token is invalid');
    }
    throw new HttpError(502, 'apns_unavailable', 'APNs is unavailable');
  }
}
