import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, RequestOptions, IncomingMessage, ClientRequest } from 'node:http';

export const PREVIEW_CHUNK = 512 * 1024;
export const PREVIEW_LIMIT = 50 * 1024 * 1024;
export const EXCLUDED_PORTS = new Set([
  3306, 5432, 5433, 6379, 6380, 27017, 27018, 11211, 9200, 9300, 5672, 15672, 9092, 2181,
  5000, 7000, 63342, 9222, 9229, 7890, 7897, 1080,
]);
// Exact runtime names only, including lsof's nine-character http-server truncation.
export const DEVELOPMENT_RUNTIMES = /^(?:node|bun|deno|python(?:3(?:\.\d+)?)?|ruby|php|java|hugo|caddy|http-serv(?:er)?|vite|esbuild|dotnet)$/i;
export const BLOCKED_PROCESSES = [
  'WeChat', 'Feishu', 'Lark', 'DingTalk', 'ToDesk', 'TeamViewer', 'ssh', 'sshd', 'Electron',
  'clash', 'verge', 'mihomo', 'Surge', 'ShadowsocksX', 'Tailscale', 'idea', 'webstorm', 'pycharm',
  'Code Helper', 'language_server', 'QoderCN', 'Antigravity', 'XTerminal', 'claude', 'ChatGPT', 'codex',
  'ControlCenter', 'rapportd', 'sharingd', 'AirPlay', 'mDNSResponder', 'launchd', 'postgres', 'mysqld', 'redis', 'mongod',
];
export const PREVIEW_PROBE_TIMEOUT = 800;
export const PREVIEW_PROBE_TTL = 15_000;
function processName(name: string) {
  return name.replace(/\\x([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
export function blockedProcess(name: string, pid: number): boolean {
  if (pid === process.pid) return true;
  const normalized = processName(name).toLowerCase().replace(/\s+/g, '');
  // Compare both prefixes and truncated names. Decode lsof's spaces before matching.
  return /helper|hel(?:p(?:e)?)?$/.test(normalized) || BLOCKED_PROCESSES.some(value => {
    const prefix = value.toLowerCase().replace(/\s+/g, '');
    return normalized.startsWith(prefix) || (normalized.length >= 4 && prefix.startsWith(normalized));
  });
}
export interface PreviewTarget { port: number; process: string; pid: number; url: string; source: 'task' | 'lsof'; taskIds?: string[]; cwd?: string; project?: string }
export function allowedPort(port: number, bridgePort: number) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== bridgePort && !EXCLUDED_PORTS.has(port);
}
/** Keep every owner, including denied processes: dropping one here would let a task
 * URL or another IPv4/IPv6 listener accidentally restore a blacklisted port. */
export function parseListeners(output: string, bridgePort: number): PreviewTarget[] {
  const found: PreviewTarget[] = [];
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/);
    const port = Number(line.match(/:(\d+)\s+\(LISTEN\)\s*$/)?.[1]);
    if (!allowedPort(port, bridgePort) || !/^\d+$/.test(fields[1] ?? '')) continue;
    found.push({ port, process: processName(fields[0]!), pid: Number(fields[1]), url: `http://localhost:${port}`, source: 'lsof' });
  }
  return found;
}
function lsof(): Promise<string> {
  // Ask for full command names so a Helper suffix cannot hide beyond column 9.
  // The matcher still accepts truncated inventories from older lsof outputs.
  return new Promise(resolve => execFile('/usr/sbin/lsof', ['+c', '0', '-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-u', String(process.getuid?.() ?? -1)],
    { timeout: 3000, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve(error ? '' : stdout)));
}
/** Which project a server belongs to: the working directory of its process, named by package.json when present. */
export async function describeProcess(pid: number): Promise<{ cwd?: string; project?: string }> {
  const out = await new Promise<string>(resolve => execFile('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
    { timeout: 2000, maxBuffer: 64 * 1024 }, (error, stdout) => resolve(error ? '' : stdout)));
  const cwd = out.split('\n').find(line => line.startsWith('n'))?.slice(1);
  if (!cwd || cwd === '/' || cwd === homedir()) return {};
  let project = basename(cwd);
  try {
    const name = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')).name;
    if (typeof name === 'string' && name.trim() && name.length <= 80) project = name.trim();
  } catch { /* not a node project */ }
  return { cwd, project };
}
/** Headers suffice; destroy immediately rather than downloading an arbitrary body
 * (zero body bytes consumed is within the 4 KiB probe budget). Never redirect. */
export function probeWebServer(port: number, transport: RequestTransport = httpRequest): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    let request: ClientRequest | undefined;
    const finish = (web: boolean) => {
      if (settled) return;
      settled = true; clearTimeout(timer); request?.destroy(); resolve(web);
    };
    const timer = setTimeout(() => finish(false), PREVIEW_PROBE_TIMEOUT);
    try {
      request = transport({ hostname: '127.0.0.1', port, path: '/', method: 'GET', agent: false, maxHeaderSize: 16384,
        headers: { host: `localhost:${port}`, accept: 'text/html', 'accept-encoding': 'identity' } }, response => {
        const status = response.statusCode ?? 0;
        const html = String(response.headers['content-type'] ?? '').toLowerCase().includes('text/html');
        response.on('error', () => {});
        // Fail closed: redirects, like 2xx responses, must identify HTML.
        finish(status >= 200 && status < 400 && html);
        response.destroy();
      });
      request.on('error', () => finish(false));
      request.end();
    } catch { finish(false); }
  });
}
const PREVIEW_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection']);
export function cleanHeaders(input: Record<string, unknown>): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  const connection = String(input.connection ?? input.Connection ?? '').toLowerCase().split(',').map(s => s.trim());
  for (const [name, value] of Object.entries(input)) {
    const key = name.toLowerCase();
    if (HOP_HEADERS.has(key) || connection.includes(key) || key === 'host' || key === 'content-length') continue;
    if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(key)) continue;
    if (typeof value === 'string' && !/[\r\n]/.test(value)) result[key] = value;
    else if (Array.isArray(value) && value.every(v => typeof v === 'string' && !/[\r\n]/.test(v))) result[key] = value;
  }
  return result;
}
export interface PreviewRequest { port: number; method: string; path: string; headers?: Record<string, unknown>; body?: string; bodyId?: string }
type RequestTransport = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
interface Upload { owner: object; parts: Buffer[]; size: number; touched: number }
interface Stream { owner: object; port: number; status: number; headers: Record<string, string | string[]>; data: Buffer; offset: number; touched: number }
export class WebPreviews {
  private uploads = new Map<string, Upload>();
  private transport: RequestTransport;
  private probe: (port: number) => Promise<boolean>;
  private describe: (pid: number) => Promise<{ cwd?: string; project?: string }>;
  private owners = new Map<number, { cwd?: string; project?: string }>();
  private probeCache = new Map<number, { identity: string; at: number; web: boolean }>();
  private pendingProbes = new Map<number, { identity: string; promise: Promise<boolean> }>();
  private closed = false;
  private inFlight = 0;
  private bridgePort: () => number;
  private scan: () => Promise<string>;
  private timeout: number;
  private now: () => number;
  private taskPorts = new Map<number, Set<string>>();
  private streams = new Map<string, Stream>();
  private tails = new Map<string, string>();
  private sweep: ReturnType<typeof setInterval>;
  private active = new Set<ReturnType<typeof httpRequest>>();
  constructor(bridgePort: () => number, scan = lsof, timeout = 30_000, now = Date.now, transport: RequestTransport = httpRequest, probe?: (port: number) => Promise<boolean>, describe: (pid: number) => Promise<{ cwd?: string; project?: string }> = describeProcess) {
    this.describe = describe;
    this.probe = probe ?? (port => probeWebServer(port, transport));
    this.transport = transport;
    this.bridgePort = bridgePort; this.scan = scan; this.timeout = timeout; this.now = now;
    this.sweep = setInterval(() => this.expire(), 10_000); this.sweep.unref();
  }
  observe(taskId: string, text: string) {
    const combined = (this.tails.get(taskId) ?? '') + text;
    for (const match of combined.matchAll(/http:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})(?=[/\s\x1b"'<>),;]|$)/g)) {
      const port = Number(match[1]);
      if (!allowedPort(port, this.bridgePort())) continue;
      const ids = this.taskPorts.get(port) ?? new Set<string>(); ids.add(taskId); this.taskPorts.set(port, ids);
    }
    this.tails.set(taskId, combined.slice(-128));
    if (this.tails.size > 200) this.tails.delete(this.tails.keys().next().value!);
  }
  private async isWeb(port: number, identity: string): Promise<boolean> {
    const cached = this.probeCache.get(port);
    if (cached?.identity === identity && this.now() - cached.at < PREVIEW_PROBE_TTL) return cached.web;
    const pending = this.pendingProbes.get(port);
    if (pending?.identity === identity) return pending.promise;
    // Also bound injected probes. Cache failures/timeouts to avoid repeatedly
    // connecting to non-HTTP listeners on every phone refresh.
    const promise = new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), PREVIEW_PROBE_TIMEOUT);
      Promise.resolve().then(() => this.probe(port)).then(web => {
        clearTimeout(timer); resolve(web === true);
      }, () => { clearTimeout(timer); resolve(false); });
    });
    const entry = { identity, promise };
    this.pendingProbes.set(port, entry);
    try {
      const web = await promise;
      if (!this.closed && this.pendingProbes.get(port) === entry) this.probeCache.set(port, { identity, at: this.now(), web });
      return web;
    } finally { if (this.pendingProbes.get(port) === entry) this.pendingProbes.delete(port); }
  }
  async targets(): Promise<PreviewTarget[]> {
    if (this.closed) return [];
    // Task URLs do not grant access when process ownership cannot be checked.
    const listeners = parseListeners(await this.scan().catch(() => ''), this.bridgePort());
    const owners = new Map<number, PreviewTarget[]>();
    for (const listener of listeners) owners.set(listener.port, [...(owners.get(listener.port) ?? []), listener]);
    for (const port of this.probeCache.keys()) if (!owners.has(port)) this.probeCache.delete(port);
    const candidates: { target: PreviewTarget; identity: string }[] = [];
    for (const [port, processes] of owners) {
      if (processes.some(p => blockedProcess(p.process, p.pid))) { this.probeCache.delete(port); continue; }
      const taskIds = this.taskPorts.get(port);
      if (!taskIds && !processes.every(p => DEVELOPMENT_RUNTIMES.test(p.process))) continue;
      const target: PreviewTarget = { ...processes[0]!, ...(taskIds ? { source: 'task', taskIds: [...taskIds] } : {}) };
      candidates.push({ target, identity: [...new Set(processes.map(p => `${p.pid}:${p.process}`))].sort().join('|') });
    }
    const result: PreviewTarget[] = [];
    // Bounded parallel probing keeps a refresh responsive without flooding localhost.
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, async () => {
      while (index < candidates.length && !this.closed) {
        const { target, identity } = candidates[index++]!;
        if (await this.isWeb(target.port, identity)) result.push(target);
      }
    }));
    if (this.closed) return [];
    const live = new Set(result.map(t => t.pid));
    for (const pid of this.owners.keys()) if (!live.has(pid)) this.owners.delete(pid);
    await Promise.all(result.map(async t => {
      if (!this.owners.has(t.pid)) this.owners.set(t.pid, await this.describe(t.pid).catch(() => ({})));
      Object.assign(t, this.owners.get(t.pid));
    }));
    return result.sort((a, b) => a.port - b.port);
  }
  upload(p: { bodyId?: string; data: string; offset: number }, owner: object) {
    this.expire();
    if (typeof p.data !== 'string' || p.data.length > Math.ceil(PREVIEW_CHUNK / 3) * 4) throw new Error('Invalid upload chunk');
    const data = Buffer.from(p.data, 'base64');
    const id = p.bodyId ?? randomUUID();
    let upload = this.uploads.get(id);
    if (!p.bodyId) {
      if (this.uploads.size >= 4) throw new Error('Too many preview uploads');
      upload = { owner, parts: [], size: 0, touched: this.now() };
    }
    if (!upload || upload.owner !== owner) throw new Error('Preview upload expired');
    if (p.offset !== upload.size || data.length > PREVIEW_CHUNK || upload.size + data.length > PREVIEW_LIMIT) throw new Error('Invalid upload range or size');
    upload.parts.push(data); upload.size += data.length; upload.touched = this.now(); this.uploads.set(id, upload);
    return { bodyId: id, offset: upload.size };
  }
  private expire() {
    for (const [id, upload] of this.uploads) if (this.now() - upload.touched >= 60_000) this.uploads.delete(id);
    for (const [id, stream] of this.streams) if (this.now() - stream.touched >= 60_000) this.streams.delete(id);
  }
  disconnect(owner: object) { for (const [id, u] of this.uploads) if (u.owner === owner) this.uploads.delete(id); for (const [id, s] of this.streams) if (s.owner === owner) this.streams.delete(id); }
  close() { this.closed = true; this.probeCache.clear(); this.pendingProbes.clear(); clearInterval(this.sweep); this.streams.clear(); this.uploads.clear(); for (const req of this.active) req.destroy(); }
  async request(p: PreviewRequest, owner: object) {
    if (!allowedPort(p.port, this.bridgePort()) || !(await this.targets()).some(t => t.port === p.port)) throw new Error('Port is not available for preview');
    const method = typeof p.method === 'string' ? p.method.toUpperCase() : '';
    if (!PREVIEW_METHODS.has(method)) throw new Error('Unsupported HTTP method');
    if (typeof p.path !== 'string' || !p.path.startsWith('/') || p.path.startsWith('//') || /[\r\n\x00]/.test(p.path)) throw new Error('Invalid HTTP path');
    const headers = cleanHeaders(p.headers ?? {});
    if (Buffer.byteLength(JSON.stringify(headers)) > 16384) throw new Error('Request headers too large');
    headers.host = `localhost:${p.port}`;
    headers.origin = `http://localhost:${p.port}`;
    headers.referer = `http://localhost:${p.port}`;
    // Uncompressed content can be rewritten by the phone; servers that ignore identity retain their encoding.
    headers['accept-encoding'] = 'identity';
    if (p.body !== undefined && (typeof p.body !== 'string' || p.body.length > Math.ceil(PREVIEW_CHUNK / 3) * 4)) throw new Error('Invalid request body');
    let body = p.body === undefined ? undefined : Buffer.from(p.body, 'base64');
    if (body && body.length > PREVIEW_CHUNK) throw new Error('Preview request bodies are limited to 512 KiB');
    if (p.bodyId) {
      this.expire();
      const upload = this.uploads.get(p.bodyId);
      if (!upload || upload.owner !== owner || body) throw new Error('Preview upload expired');
      body = Buffer.concat(upload.parts); this.uploads.delete(p.bodyId);
    }
    if (this.inFlight >= 12) throw new Error('Too many preview requests');
    this.inFlight++;
    if (body) headers['content-length'] = String(body.length);
    const fetch = (host: string) => new Promise<{ status: number; headers: IncomingHttpHeaders; data: Buffer }>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const req = this.transport({ hostname: host, port: p.port, method, path: p.path, headers, agent: false, maxHeaderSize: 16384 }, res => {
        const parts: Buffer[] = []; let size = 0;
        res.on('data', (part: Buffer) => {
          size += part.length;
          if (size > PREVIEW_LIMIT) { res.destroy(new Error('Preview response exceeds 50 MiB')); req.destroy(); return; }
          parts.push(part);
        });
        res.on('end', () => {
          try {
            let data = Buffer.concat(parts);
            const decode = ({ gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync } as Record<string, typeof gunzipSync>)[String(res.headers['content-encoding'])];
            if (decode) { data = decode(data, { maxOutputLength: PREVIEW_LIMIT }); delete res.headers['content-encoding']; }
            resolve({ status: res.statusCode ?? 502, headers: res.headers, data });
          } catch { reject(new Error('Unable to decode preview response within the 50 MiB limit')); }
        });
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('Preview response interrupted')));
      });
      this.active.add(req);
      timer = setTimeout(() => req.destroy(new Error('Preview request timed out')), this.timeout);
      req.on('error', reject);
      req.on('close', () => { clearTimeout(timer); this.active.delete(req); });
      req.end(body);
    });
    let result;
    try { result = await fetch('127.0.0.1'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED') throw error; result = await fetch('::1'); }
    finally { this.inFlight--; }
    this.expire();
    if (this.streams.size >= 8) throw new Error('Too many preview downloads; retry shortly');
    const streamId = randomUUID();
    const stream = { owner, port: p.port, ...result, headers: cleanHeaders(result.headers), offset: 0, touched: this.now() };
    if (method === 'HEAD' && /^\d+$/.test(String(result.headers['content-length']))) stream.headers['content-length'] = String(result.headers['content-length']);
    this.streams.set(streamId, stream);
    return this.chunk(streamId, owner);
  }
  chunk(id: string, owner: object) {
    this.expire();
    const s = this.streams.get(id);
    if (!s || s.owner !== owner) throw new Error('Preview stream expired');
    const data = s.data.subarray(s.offset, s.offset + PREVIEW_CHUNK).toString('base64');
    s.offset += PREVIEW_CHUNK; s.touched = this.now();
    const eof = s.offset >= s.data.length;
    if (eof) this.streams.delete(id);
    return { status: s.status, headers: s.headers, data, ...(eof ? {} : { streamId: id }), eof };
  }
}
