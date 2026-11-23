import type { IncomingMessage, Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import { deviceId } from './devices.ts';
import { HttpError, unauthorized } from './errors.ts';

export const OPEN = 1;
export const DATA = 2;
export const CLOSE = 3;
export const MAX_PAYLOAD = 1024 * 1024;
export const MAX_BUFFERED = 4 * 1024 * 1024;
export const MAX_CHANNELS = 8;
export const PING_INTERVAL = 25_000;
export const PONG_TIMEOUT = 60_000;
const MAX_CHANNEL_ID = 0xffff_ffff;

type FrameType = typeof OPEN | typeof DATA | typeof CLOSE;
export interface RelayFrame { type: FrameType; channel: number; payload: Buffer }

export function encodeFrame(type: FrameType, channel: number, payload: Uint8Array = Buffer.alloc(0)): Buffer {
  if (![OPEN, DATA, CLOSE].includes(type) || !Number.isInteger(channel) || channel < 1 || channel > MAX_CHANNEL_ID ||
      (type !== DATA && payload.length !== 0)) throw new RangeError('Invalid relay frame');
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame[0] = type;
  frame.writeUInt32BE(channel, 1);
  frame.set(payload, 5);
  return frame;
}

export function decodeFrame(bytes: Buffer): RelayFrame | null {
  if (bytes.length < 5) return null;
  const type = bytes[0];
  const channel = bytes.readUInt32BE(1);
  if ((type !== OPEN && type !== DATA && type !== CLOSE) || channel === 0 ||
      (type !== DATA && bytes.length !== 5)) return null;
  return { type, channel, payload: bytes.subarray(5) };
}

export function relayParameters(url: string): { role: 'bridge' | 'phone'; device: string } {
  let parsed: URL;
  try { parsed = new URL(url, 'http://localhost'); } catch { throw new HttpError(404, 'not_found', 'Relay route not found'); }
  const role = parsed.pathname === '/v1/relay/bridge' ? 'bridge' : parsed.pathname === '/v1/relay/phone' ? 'phone' : null;
  if (!role) throw new HttpError(404, 'not_found', 'Relay route not found');
  const ids = parsed.searchParams.getAll('device');
  try {
    if (ids.length !== 1) throw new Error();
    return { role, device: deviceId(ids[0]) };
  } catch { throw new HttpError(404, 'not_found', 'Device not found'); }
}

// Sliding window, matching the HTTP service's retryAfter semantics. Failed attempts count too.
export function createUpgradeLimiter(now: () => number) {
  const attempts = new Map<string, number[]>();
  function prune() {
    const cutoff = now() - 60_000;
    for (const [ip, times] of attempts) {
      const recent = times.filter(time => time > cutoff);
      if (recent.length) attempts.set(ip, recent);
      else attempts.delete(ip);
    }
  }
  return {
    prune,
    clear() { attempts.clear(); },
    check(ip: string) {
      const time = now();
      const recent = (attempts.get(ip) ?? []).filter(at => at > time - 60_000);
      if (recent.length >= 60) {
        throw new HttpError(429, 'rate_limited', 'Too many requests', Math.ceil((recent[0] + 60_000 - time) / 1000));
      }
      recent.push(time);
      attempts.set(ip, recent);
    },
  };
}

interface Bridge {
  id: string;
  ws: WebSocket;
  nextChannel: number;
  channels: Map<number, WebSocket>;
}

interface RelayOptions {
  db: DatabaseSync;
  authenticate(token: string): string;
  clientIp(req: IncomingMessage): string;
  now?: () => number;
  log?: (message: string) => void;
}

function buffer(data: RawData): Buffer {
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function rejectUpgrade(socket: Duplex, error: HttpError) {
  const body = JSON.stringify({ error: { code: error.code, message: error.message,
    ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }) } });
  const reason = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 500: 'Internal Server Error' }[error.status] ?? 'Bad Request';
  socket.on('error', () => {});
  socket.end(`HTTP/1.1 ${error.status} ${reason}\r\nConnection: close\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    (error.retryAfter === undefined ? '' : `Retry-After: ${error.retryAfter}\r\n`) + `\r\n${body}`, () => socket.destroy());
}

export function attachRelay(server: Server, options: RelayOptions) {
  const now = options.now ?? Date.now;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  const bridges = new Map<string, Bridge>();
  const limiter = createUpgradeLimiter(now);
  const stats = { invalidBridgeFrames: 0 };
  let disposed = false;
  const pruneTimer = setInterval(() => limiter.prune(), PING_INTERVAL);
  pruneTimer.unref();

  function log(event: string, id: string, channel?: number, reason?: string) {
    // Only server-defined metadata. Never include tokens, frames, client close reasons or errors.
    options.log?.(JSON.stringify({ event, device: id, ...(channel === undefined ? {} : { channel }), ...(reason ? { reason } : {}) }));
  }

  function watch(ws: WebSocket, lost: () => void) {
    let timeout: NodeJS.Timeout;
    const reset = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => { lost(); ws.terminate(); }, PONG_TIMEOUT);
      timeout.unref();
    };
    reset();
    const ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, PING_INTERVAL);
    ping.unref();
    ws.on('pong', reset);
    ws.on('error', () => {
      // ws starts a protocol close (e.g. 1009) before emitting receiver errors.
      // Let that frame flush; transport errors on an open socket terminate immediately.
      const protocolClosing = ws.readyState === WebSocket.CLOSING;
      lost();
      if (!protocolClosing) ws.terminate();
    });
    ws.once('close', () => { clearInterval(ping); clearTimeout(timeout); ws.off('pong', reset); lost(); });
  }

  function send(ws: WebSocket, bytes: Buffer, failure: () => void) {
    if (ws.readyState !== WebSocket.OPEN) { failure(); return; }
    ws.send(bytes, { binary: true }, error => { if (error) failure(); });
  }

  function closeChannel(bridge: Bridge, channel: number, code = 1000, reason = 'channel_closed', notify = true) {
    const phone = bridge.channels.get(channel);
    if (!phone) return;
    // Remove synchronously so close events cannot notify twice or remove a replacement.
    bridge.channels.delete(channel);
    if (notify && bridge.ws.readyState === WebSocket.OPEN) {
      // A five-byte CLOSE releases bridge resources without dropping unrelated channels.
      send(bridge.ws, encodeFrame(CLOSE, channel), () => closeBridge(bridge));
    }
    phone.close(code, reason);
    log('relay_channel_close', bridge.id, channel, reason);
  }

  function closeBridge(bridge: Bridge, code = 1012, reason = 'bridge_disconnected') {
    if (bridges.get(bridge.id) !== bridge) return;
    bridges.delete(bridge.id);
    for (const channel of bridge.channels.keys()) closeChannel(bridge, channel, code === 4000 ? 1012 : code, reason, false);
    bridge.ws.close(code, reason);
    log('relay_bridge_close', bridge.id, undefined, reason);
  }

  function bridgeConnected(id: string, ws: WebSocket) {
    const old = bridges.get(id);
    if (old) closeBridge(old, 4000, 'replaced');
    const bridge: Bridge = { id, ws, nextChannel: 1, channels: new Map() };
    bridges.set(id, bridge);
    watch(ws, () => closeBridge(bridge));
    ws.on('message', (data, binary) => {
      if (bridges.get(id) !== bridge) return;
      if (!binary) { closeBridge(bridge, 1003, 'binary_required'); return; }
      const frame = decodeFrame(buffer(data));
      if (!frame || frame.type === OPEN || !bridge.channels.has(frame.channel)) {
        stats.invalidBridgeFrames++;
        return;
      }
      if (frame.type === CLOSE) { closeChannel(bridge, frame.channel, 1000, 'bridge_closed', false); return; }
      const phone = bridge.channels.get(frame.channel)!;
      if (phone.bufferedAmount > MAX_BUFFERED || ws.bufferedAmount > MAX_BUFFERED) {
        closeChannel(bridge, frame.channel, 1013, 'backpressure'); return;
      }
      send(phone, frame.payload, () => closeChannel(bridge, frame.channel, 1013, 'send_failed'));
      if (phone.bufferedAmount > MAX_BUFFERED) closeChannel(bridge, frame.channel, 1013, 'backpressure');
    });
    log('relay_bridge_open', id);
  }

  function phoneConnected(id: string, ws: WebSocket) {
    const bridge = bridges.get(id);
    // Even immediately rejected upgraded sockets need error handlers and a bounded lifetime.
    if (!bridge || bridge.ws.readyState !== WebSocket.OPEN) {
      ws.on('error', () => {});
      ws.close(4404, 'bridge_offline');
      return;
    }
    if (bridge.channels.size >= MAX_CHANNELS || bridge.nextChannel > MAX_CHANNEL_ID) {
      ws.on('error', () => {});
      ws.close(4429, 'too_many_channels');
      return;
    }
    const channel = bridge.nextChannel++;
    bridge.channels.set(channel, ws);
    watch(ws, () => closeChannel(bridge, channel));
    ws.on('message', (data, binary) => {
      if (!bridge.channels.has(channel)) return;
      if (!binary) { closeChannel(bridge, channel, 1003, 'binary_required'); return; }
      if (bridge.ws.bufferedAmount > MAX_BUFFERED || ws.bufferedAmount > MAX_BUFFERED) {
        closeChannel(bridge, channel, 1013, 'backpressure'); return;
      }
      send(bridge.ws, encodeFrame(DATA, channel, buffer(data)), () => closeBridge(bridge));
      if (bridge.ws.bufferedAmount > MAX_BUFFERED) closeChannel(bridge, channel, 1013, 'backpressure');
    });
    if (bridge.ws.bufferedAmount > MAX_BUFFERED) { closeChannel(bridge, channel, 1013, 'backpressure'); return; }
    send(bridge.ws, encodeFrame(OPEN, channel), () => closeBridge(bridge));
    log('relay_channel_open', id, channel);
  }

  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    try {
      // Determine the endpoint first so all unknown upgrade paths consistently return 404.
      let parsed: URL;
      try { parsed = new URL(req.url ?? '/', 'http://localhost'); }
      catch { throw new HttpError(404, 'not_found', 'Relay route not found'); }
      if (parsed.pathname === '/v1/relay/phone') limiter.check(options.clientIp(req));
      const { role, device } = relayParameters(req.url ?? '/');
      const auth = req.headers.authorization;
      if (!auth?.startsWith('Bearer ')) throw unauthorized();
      const userId = options.authenticate(auth.slice(7));
      const row = options.db.prepare('SELECT user_id FROM devices WHERE id = ?').get(device);
      if (!row) throw new HttpError(404, 'not_found', 'Device not found');
      if (row.user_id !== userId) throw new HttpError(403, 'forbidden', 'Device belongs to another user');
      wss.handleUpgrade(req, socket, head, ws => {
        if (role === 'bridge') bridgeConnected(device, ws);
        else phoneConnected(device, ws);
      });
    } catch (error) {
      if (!(error instanceof HttpError)) options.log?.('Internal relay upgrade failure');
      rejectUpgrade(socket, error instanceof HttpError ? error : new HttpError(500, 'internal_error', 'Internal server error'));
    }
  }
  server.on('upgrade', upgrade);

  function dispose() {
    if (disposed) return;
    disposed = true;
    server.off('upgrade', upgrade);
    clearInterval(pruneTimer);
    limiter.clear();
    for (const bridge of bridges.values()) closeBridge(bridge, 1001, 'server_shutdown');
    // Upgraded sockets are not closed by HTTP server.closeAllConnections().
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.close(1001, 'server_shutdown');
    }
    wss.close();
  }
  server.once('close', dispose);
  // HTTP close waits for TCP sockets, including upgrades, but does not close them.
  // Dispose before waiting so SIGTERM and callers of createApp().close() cannot hang.
  const closeHttp = server.close;
  server.close = function(callback) {
    dispose();
    return closeHttp.call(this, callback);
  };
  return {
    isOnline(id: string) { return bridges.get(id)?.ws.readyState === WebSocket.OPEN; },
    closeDevice(id: string) { const bridge = bridges.get(id); if (bridge) closeBridge(bridge, 1001, 'device_deleted'); },
    stats() { return { ...stats }; },
    dispose,
  };
}
