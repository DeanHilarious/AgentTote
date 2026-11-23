import { createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configDirectory, deleteAccount, loadAccount, reachableAddresses, saveAccount, writePrivateFile } from './config.ts';
import type { AccountConfig, AccountUser, BridgeConfig } from './config.ts';

export type Purpose = 'register' | 'reset' | 'bind';

/** Marks fetch failures without changing AccountError handling in the CLI or heartbeat. */
export class AccountNetworkError extends Error {
  constructor(cause: unknown) {
    super("Can't reach the account server", { cause });
  }
}

export class AccountError extends Error {
  status: number;
  code: string;
  retryAfter?: number;

  constructor(status: number, code: string, retryAfter?: number) {
    super(`Account request failed (${status}, ${code})`);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

interface DeviceInfo {
  name: string;
  hosts: string[];
  port: number;
  bridgeVersion: string;
}

export interface AccountStatus {
  user: AccountUser | null;
  serverUrl: string;
  state: 'signedOut' | 'online' | 'unreachable' | 'revoked';
}

interface AccountOptions {
  onChange?: (status: AccountStatus) => void;
  config: BridgeConfig;
  bridgeVersion: string;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
  directory?: string;
  deviceInfo?: () => DeviceInfo;
}

function accessExpiry(token: string): number {
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  if (!Number.isSafeInteger(claims.exp)) throw new Error('Invalid access token');
  return claims.exp * 1000;
}

function validPublicKey(pem: string): boolean {
  try {
    return createPublicKey(pem).asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

export class AccountClient {
  private onChange?: (status: AccountStatus) => void;
  private listeners = new Set<() => void>();
  private lastStatus = '';
  private config: BridgeConfig;
  private fetcher: typeof fetch;
  private now: () => number;
  private log: (message: string) => void;
  private directory: string;
  private deviceInfo: () => DeviceInfo;
  private account?: AccountConfig;
  private accessToken?: string;
  private expiresAt = 0;
  private refreshPromise?: Promise<string | undefined>;
  private persistPromise?: Promise<void>;
  private heartbeatPromise?: Promise<boolean>;
  private heartbeatQueued = false;
  private timer?: ReturnType<typeof setInterval>;
  private dirty = false;
  private unreachable = false;
  private invalidated = false;
  private ownershipConflict = false;
  private loggingOut = false;
  private heartbeatError?: string;
  publicKeyPem?: string;

  constructor(options: AccountOptions) {
    this.onChange = options.onChange;
    this.config = options.config;
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? console.log;
    this.directory = options.directory ?? configDirectory();
    this.deviceInfo = options.deviceInfo ?? (() => ({
      name: this.config.name,
      hosts: reachableAddresses().map(host => host.address),
      port: this.config.port,
      bridgeVersion: options.bridgeVersion,
    }));
  }

  get user(): AccountUser | undefined {
    // Never send a saved refresh token to a different account server after a URL change.
    return !this.loggingOut && this.account?.serverUrl.replace(/\/+$/, '') === this.config.serverUrl.replace(/\/+$/, '')
      ? this.account?.user : undefined;
  }

  get status(): AccountStatus {
    return { user: this.user ?? null, serverUrl: this.config.serverUrl,
      state: this.invalidated || this.ownershipConflict ? 'revoked' : !this.user ? 'signedOut' : this.unreachable ? 'unreachable' : 'online' };
  }

  notifyStatus(): void {
    const next = JSON.stringify(this.status);
    if (next === this.lastStatus) return;
    this.lastStatus = next;
    this.onChange?.(this.status);
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async getAccessToken(forceRefresh = false): Promise<string | undefined> {
    if (!this.user || this.status.state === 'revoked') return undefined;
    await this.persist();
    return forceRefresh || !this.accessToken || this.expiresAt - this.now() < 60_000 ? this.refresh() : this.accessToken;
  }

  get isHeartbeating(): boolean {
    return this.timer !== undefined;
  }

  async initialize(): Promise<void> {
    this.account = await loadAccount(this.directory);
    this.notifyStatus();
    if (!this.user) return;
    try {
      const pem = await readFile(join(this.directory, 'server-key.pem'), 'utf8');
      if (validPublicKey(pem)) this.publicKeyPem = pem;
    } catch {
      // A missing cache must not block pairing or the first online key fetch.
    }
  }

  private async request<T>(path: string, body?: unknown, token?: string, method = 'POST', serverUrl = this.config.serverUrl): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${serverUrl.replace(/\/+$/, '')}/v1${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      if (!this.unreachable) this.log('账号服务不可达');
      this.unreachable = true;
      this.notifyStatus();
      throw new AccountNetworkError(error);
    }
    if (this.unreachable) this.log('账号服务已恢复');
    this.unreachable = false;
    this.notifyStatus();
    let data;
    try { data = await response.json(); } catch (error) {
      // A connection can fail after headers arrive. Push retries must recognize
      // interrupted response bodies too, while malformed JSON is a protocol error.
      if (error instanceof SyntaxError) throw new AccountError(response.status, 'invalid_response');
      throw new AccountNetworkError(error);
    }
    if (!response.ok) {
      const retryValue = data?.error?.retryAfter ?? response.headers.get('retry-after');
      const retryAfter = retryValue == null ? NaN : Number(retryValue);
      throw new AccountError(response.status, data?.error?.code ?? 'invalid_response', Number.isFinite(retryAfter) ? retryAfter : undefined);
    }
    return data as T;
  }

  async sendCode(email: string, purpose: Purpose): Promise<{ expiresIn: number; resendAfter: number }> {
    const body = { channel: 'email', target: email, purpose };
    if (purpose === 'bind') {
      const result = await this.authorizedRequest<{ expiresIn: number; resendAfter: number }>('/auth/code', body, 'POST');
      if (!result) throw new AccountError(401, 'unauthorized');
      return result;
    }
    return this.request('/auth/code', body);
  }

  async login(email: string, password: string): Promise<AccountUser> {
    const result = await this.request<SessionTokens & { user: AccountUser }>('/auth/password', {
      email, password, deviceLabel: this.config.name,
    });
    return this.acceptSession(result);
  }

  async register(email: string, code: string, password: string): Promise<AccountUser> {
    const result = await this.request<SessionTokens & { user: AccountUser }>('/auth/register', {
      email, code, password, deviceLabel: this.config.name,
    });
    return this.acceptSession(result);
  }

  async resetPassword(email: string, code: string, password: string): Promise<AccountUser> {
    const result = await this.request<SessionTokens & { user: AccountUser }>('/auth/reset', {
      email, code, password, deviceLabel: this.config.name,
    });
    return this.acceptSession(result);
  }

  private async acceptSession(result: SessionTokens & { user: AccountUser }): Promise<AccountUser> {
    const expiresAt = accessExpiry(result.accessToken);
    if (!result.refreshToken || !result.user?.id) throw new Error('Invalid account response');
    // A key cached for the previous server must never authenticate the new account.
    if (this.account?.serverUrl !== this.config.serverUrl) {
      this.publicKeyPem = undefined;
      await writePrivateFile('server-key.pem', '', this.directory);
    }
    this.account = { serverUrl: this.config.serverUrl, refreshToken: result.refreshToken, user: result.user };
    this.accessToken = result.accessToken;
    this.expiresAt = expiresAt;
    this.invalidated = false;
    this.ownershipConflict = false;
    this.dirty = true;
    await this.persist();
    this.notifyStatus();
    return result.user;
  }

  private persist(): Promise<void> {
    if (this.persistPromise) return this.persistPromise.then(() => this.persist());
    if (!this.dirty || !this.account) return Promise.resolve();
    const account = this.account;
    this.persistPromise = saveAccount(account, this.directory).then(() => {
      if (this.account === account) this.dirty = false;
    }).finally(() => { this.persistPromise = undefined; });
    return this.persistPromise;
  }

  private async invalidate(): Promise<void> {
    this.account = undefined;
    this.accessToken = undefined;
    this.dirty = false;
    this.stop();
    if (!this.invalidated) this.log('账号登录已失效，请运行 npm run login 重新登录');
    this.invalidated = true;
    this.notifyStatus();
    await deleteAccount(this.directory).catch(() => this.log('无法删除已失效的 account.json，请检查目录权限'));
  }

  private refresh(): Promise<string | undefined> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      if (!this.user || !this.account) return undefined;
      await this.persist();
      try {
        const result = await this.request<SessionTokens>('/auth/refresh', { refreshToken: this.account.refreshToken });
        if (!result.refreshToken) throw new Error('Invalid refresh response');
        // Keep the rotated token in memory before any fallible disk work; never reuse its predecessor.
        this.account = { ...this.account, refreshToken: result.refreshToken };
        this.dirty = true;
        await this.persist();
        this.expiresAt = accessExpiry(result.accessToken);
        this.accessToken = result.accessToken;
        return this.accessToken;
      } catch (error) {
        if (error instanceof AccountError && error.status === 401) {
          await this.invalidate();
          return undefined;
        }
        throw error;
      }
    })().finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }

  async authorizedRequest<T>(path: string, body?: unknown, method = 'GET'): Promise<T | undefined> {
    if (!this.user) return undefined;
    await this.persist();
    const token = !this.accessToken || this.expiresAt - this.now() < 60_000 ? await this.refresh() : this.accessToken;
    if (!token || !this.user) return undefined;
    try {
      return await this.request<T>(path, body, token, method);
    } catch (error) {
      if (!(error instanceof AccountError) || error.status !== 401) throw error;
      // Concurrent 401 responses may arrive after another request already rotated the session.
      const next = this.accessToken !== token ? this.accessToken : await this.refresh();
      if (!next || !this.user) return undefined;
      try {
        return await this.request<T>(path, body, next, method);
      } catch (retryError) {
        if (retryError instanceof AccountError && retryError.status === 401) {
          await this.invalidate();
          return undefined;
        }
        throw retryError;
      }
    }
  }

  async refreshKeys(): Promise<void> {
    try {
      const result = await this.request<{ ed25519PublicKey: string }>('/keys', undefined, undefined, 'GET');
      if (!validPublicKey(result.ed25519PublicKey)) throw new Error('Invalid public key');
      await writePrivateFile('server-key.pem', result.ed25519PublicKey, this.directory);
      this.publicKeyPem = result.ed25519PublicKey;
    } catch {
      // Retain the trusted cache so issued tickets still work during an outage.
    }
  }

  start(): void {
    if (!this.user || this.timer || this.ownershipConflict) return;
    this.timer = setInterval(() => { void this.registerDevice(); }, 60_000);
    this.timer.unref();
    void this.registerDevice();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.heartbeatQueued = false;
  }

  registerDevice(refreshAfterCurrent = false): Promise<boolean> {
    if (this.heartbeatPromise) {
      // A network change during an old PUT needs one more PUT with the latest hosts.
      if (refreshAfterCurrent) this.heartbeatQueued = true;
      return this.heartbeatPromise;
    }
    this.heartbeatPromise = (async () => {
      if (!this.user || this.ownershipConflict) return false;
      try {
        const result = await this.authorizedRequest(`/devices/${encodeURIComponent(this.config.deviceId)}`, { ...this.deviceInfo(), ...(this.config.publicKey ? { publicKey: this.config.publicKey } : {}) }, 'PUT');
        if (result === undefined) return false;
        this.heartbeatError = undefined;
        return true;
      } catch (error) {
        if (error instanceof AccountError && error.status === 409) {
          this.ownershipConflict = true;
          this.notifyStatus();
          this.stop();
          this.log('本机设备已属于其他账号，已停止心跳；请使用原账号登录，或从原账号移除此设备后重启 bridge');
        } else if (error instanceof AccountError) {
          if (this.heartbeatError !== error.code) this.log(`设备注册/心跳失败：${error.status} (${error.code})`);
          this.heartbeatError = error.code;
        } else if (!this.unreachable && this.heartbeatError !== 'local') {
          this.log('设备注册/心跳失败，请检查本地账号文件和服务响应');
          this.heartbeatError = 'local';
        }
        return false;
      } finally {
        // Directory errors must not prevent fetching the key used for offline connections.
        if (this.user) await this.refreshKeys();
      }
    })().finally(() => {
      this.heartbeatPromise = undefined;
      if (this.heartbeatQueued) {
        this.heartbeatQueued = false;
        if (this.user) void this.registerDevice();
      }
    });
    return this.heartbeatPromise;
  }

  async logout(): Promise<void> {
    this.stop();
    this.loggingOut = true;
    this.notifyStatus();
    await this.refreshPromise?.catch(() => undefined);
    await this.persistPromise?.catch(() => undefined);
    if (this.account) {
      await this.request('/auth/logout', { refreshToken: this.account.refreshToken }, undefined, 'POST', this.account.serverUrl).catch(() => undefined);
    }
    this.account = undefined;
    this.accessToken = undefined;
    this.dirty = false;
    this.loggingOut = false;
    this.invalidated = false;
    this.ownershipConflict = false;
    this.unreachable = false;
    this.notifyStatus();
    await deleteAccount(this.directory);
  }
}
