import { WebSocket } from 'ws';
import type { AccountClient } from './account.ts';
import type { BridgeConfig } from './config.ts';
import type { Identity } from './identity.ts';
import type { ClientTransport } from './server.ts';
import { bridgeHandshake, transport } from './relayCrypto.ts';
import { verifyTicket } from './ticket.ts';

export interface RelayStatus { state: 'off' | 'connecting' | 'online' | 'error'; channels: number }
export function reconnectDelay(attempt: number, replaced = false): number {
  return replaced ? 30_000 : [1000, 2000, 5000, 10_000][attempt] ?? 30_000;
}
export function frame(type: number, channel: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const bytes = Buffer.alloc(5 + payload.length);
  bytes[0] = type; bytes.writeUInt32BE(channel, 1); payload.copy(bytes, 5);
  return bytes;
}
interface Connection { receive(text: string): Promise<void>; disconnect(): void }
interface Session { crypto?: ReturnType<typeof transport>; client?: Connection; timer: ReturnType<typeof setTimeout> }
interface Options {
  config: BridgeConfig;
  identity: Identity;
  account: Pick<AccountClient, 'status' | 'user' | 'publicKeyPem' | 'subscribe' | 'getAccessToken' | 'registerDevice' | 'stop'>;
  attachClient(client: ClientTransport): Connection;
  log(message: string): void;
  onChange?(status: RelayStatus): void;
}
export class RelayClient {
  private options: Options;
  private ws?: WebSocket;
  private sessions = new Map<number, Session>();
  private retry?: ReturnType<typeof setTimeout>;
  private unlisten?: () => void;
  private generation = 0;
  private connecting = false;
  private blocked = false;
  private attempt = 0;
  private forceRefresh = false;
  private current: RelayStatus = { state: 'off', channels: 0 };
  constructor(options: Options) { this.options = options; }
  get status(): RelayStatus { return { ...this.current }; }
  private publish(state = this.current.state) {
    const next = { state, channels: [...this.sessions.values()].filter(s => s.client).length };
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next;
    this.options.onChange?.(this.status);
  }
  start() {
    if (this.unlisten) return;
    this.unlisten = this.options.account.subscribe(() => this.sync());
    this.sync();
  }
  stop() {
    this.unlisten?.(); this.unlisten = undefined;
    this.disconnect();
  }
  private eligible() {
    const status = this.options.account.status;
    return !!status.user && !!status.serverUrl && status.state !== 'revoked';
  }
  private sync() {
    if (!this.eligible()) { this.blocked = false; this.attempt = 0; this.disconnect(); return; }
    if (!this.blocked && !this.ws && !this.retry && !this.connecting) void this.connect();
  }
  private disconnect() {
    this.generation++;
    this.connecting = false;
    clearTimeout(this.retry); this.retry = undefined;
    const ws = this.ws; this.ws = undefined;
    for (const id of this.sessions.keys()) this.closeChannel(id, false);
    ws?.terminate();
    this.publish('off');
  }
  private schedule(replaced = false) {
    if (!this.unlisten || !this.eligible() || this.blocked) return;
    const delay = reconnectDelay(this.attempt++, replaced);
    this.retry = setTimeout(() => { this.retry = undefined; this.sync(); }, delay);
    this.retry.unref();
    this.publish('error');
  }
  private async connect() {
    const generation = this.generation;
    this.connecting = true;
    this.publish('connecting');
    try {
      // Registration must finish before the first upgrade (new account/device).
      if (!await this.options.account.registerDevice()) throw new Error('Registration unavailable');
      const token = await this.options.account.getAccessToken(this.forceRefresh);
      this.forceRefresh = false;
      if (generation !== this.generation || !this.eligible()) return;
      if (!token) throw new Error('No account token');
      const url = new URL(this.options.config.serverUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.pathname = '/v1/relay/bridge'; url.search = ''; url.hash = '';
      url.searchParams.set('device', this.options.config.deviceId);
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` }, maxPayload: 1024 * 1024 + 5, handshakeTimeout: 10_000, perMessageDeflate: false });
      this.ws = ws;
      let openedAt = 0;
      let staleTimer: ReturnType<typeof setTimeout> | undefined;
      const watch = () => {
        clearTimeout(staleTimer);
        staleTimer = setTimeout(() => ws.terminate(), 70_000);
        staleTimer.unref();
      };
      ws.on('open', () => {
        if (this.ws !== ws) return;
        openedAt = Date.now(); watch();
        this.options.log('中转已连接'); this.publish('online');
      });
      ws.on('ping', watch);
      ws.on('message', (raw, binary) => {
        if (this.ws !== ws) return;
        const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (bytes.length < 5) { ws.close(1002); return; }
        const id = bytes.readUInt32BE(1), type = bytes[0];
        if (!binary || !id || ![1, 2, 3].includes(type) || (type !== 2 && bytes.length !== 5)) {
          if (id) this.closeChannel(id); else ws.close(1002);
          return;
        }
        if (type === 3) { this.closeChannel(id, false); return; }
        if (type === 1) {
          if (this.sessions.has(id) || this.sessions.size >= 8) { this.closeChannel(id); return; }
          const timer = setTimeout(() => this.closeChannel(id), 15_000); timer.unref();
          this.sessions.set(id, { timer }); this.options.log(`中转通道 ${id} 打开`);
          return;
        }
        this.data(id, bytes.subarray(5));
      });
      ws.on('unexpected-response', (_request, response) => {
        // HTTP authorization failures carry no payload into logs.
        if (response.statusCode === 401) this.forceRefresh = true;
        if (response.statusCode === 403 || response.statusCode === 404) {
          this.blocked = true; this.options.account.stop();
        }
        response.resume(); ws.terminate();
      });
      ws.on('error', () => { /* close schedules retry; never log error payloads */ });
      ws.on('close', (code, reason) => {
        clearTimeout(staleTimer);
        if (this.ws !== ws) return;
        this.ws = undefined;
        for (const id of this.sessions.keys()) this.closeChannel(id, false);
        this.options.log(code === 4000 ? '中转连接被替换，30 秒后重试' : '中转已断开');
        if (code === 1001 && reason.toString() === 'device_deleted') {
          this.blocked = true; this.options.account.stop();
        }
        if (openedAt && Date.now() - openedAt >= 60_000) this.attempt = 0;
        if (this.blocked) this.publish('off'); else this.schedule(code === 4000);
      });
    } catch {
      if (generation === this.generation) { this.options.log('中转连接失败'); this.schedule(); }
    } finally {
      if (generation === this.generation) this.connecting = false;
    }
  }
  private send(id: number, payload: Buffer) {
    if (payload.length > 1024 * 1024 - 5 || !this.ws || this.ws.readyState !== WebSocket.OPEN || this.ws.bufferedAmount > 4 * 1024 * 1024) {
      this.closeChannel(id); return;
    }
    const ws = this.ws, session = this.sessions.get(id);
    ws.send(frame(2, id, payload), error => {
      if (error && this.ws === ws && this.sessions.get(id) === session) this.closeChannel(id);
    });
  }
  private closeChannel(id: number, notify = true) {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    if (session) {
      clearTimeout(session.timer); session.client?.disconnect();
      this.options.log(`中转通道 ${id} 关闭`); this.publish();
    }
    if (notify && this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame(3, id));
  }
  private data(id: number, bytes: Buffer) {
    const session = this.sessions.get(id);
    if (!session) { this.closeChannel(id); return; }
    try {
      if (!session.crypto) {
        const handshake = bridgeHandshake(this.options.identity.privateKey, this.options.config.deviceId, bytes);
        session.crypto = transport(handshake, 'bridge');
        this.send(id, handshake.msg2); return;
      }
      const text = session.crypto.open(bytes);
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON envelope');
      if (!session.client) {
        if (Object.keys(value).length !== 1 || typeof value.auth !== 'string') throw new Error('Auth required');
        const account = this.options.account;
        const valid = this.eligible() && account.user && account.publicKeyPem && verifyTicket(value.auth, account.publicKeyPem, {
          deviceId: this.options.config.deviceId, userId: account.user.id,
        });
        this.send(id, session.crypto.seal(JSON.stringify({ auth: valid ? 'ok' : 'error' })));
        if (!valid) { this.options.log(`中转通道 ${id} 认证失败`); this.closeChannel(id); return; }
        if (!this.sessions.has(id)) return;
        clearTimeout(session.timer);
        session.client = this.options.attachClient({ kind: 'relay', remote: `relay:${id}`,
          send: text => {
            if (this.sessions.get(id) !== session) return;
            try { this.send(id, session.crypto!.seal(text)); } catch { this.closeChannel(id); }
          }, close: () => this.closeChannel(id),
        });
        this.publish();
      } else {
        if (typeof value.method !== 'string' || !(typeof value.id === 'string' || typeof value.id === 'number') ||
            (value.params !== undefined && (!value.params || typeof value.params !== 'object' || Array.isArray(value.params)))) throw new Error('Invalid RPC');
        void session.client.receive(text).catch(() => { if (this.sessions.get(id) === session) this.closeChannel(id); });
      }
    } catch { this.closeChannel(id); }
  }
}
