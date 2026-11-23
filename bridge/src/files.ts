import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Adapter, AgentKind, SessionSummary } from './types.ts';

export const FILE_CHUNK = 512 * 1024;
export const FILE_LIMIT = 20 * 1024 * 1024;
export const SECRET_ERROR = "This file may contain secrets and can't be opened from the phone.";
export function sensitivePath(path: string): boolean {
  return path.split(/[\\/]/).some(name => /^(?:\.ssh|\.env(?:\..*)?|\.npmrc|\.netrc|\.git-credentials|id_rsa.*|id_ed25519.*)$/i.test(name) || /\.(?:pem|key|p8|p12)$/i.test(name));
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
function gitPath(path: string) { return path.split(sep).some(part => part.toLowerCase() === '.git'); }
export function fileMime(path: string, sample: Buffer): string {
  const types: Record<string, string> = {
    '.md': 'text/markdown', '.markdown': 'text/markdown', '.html': 'text/html', '.htm': 'text/html',
    '.txt': 'text/plain', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
    '.pdf': 'application/pdf', '.xml': 'application/xml', '.wasm': 'application/wasm',
  };
  if (types[extname(path).toLowerCase()]) return types[extname(path).toLowerCase()]!;
  try {
    if (sample.some(b => b === 0 || (b < 32 && ![9, 10, 12, 13].includes(b)))) return 'application/octet-stream';
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true });
    return 'text/plain';
  } catch { return 'application/octet-stream'; }
}
export interface FileParams { cwd: string; path?: string; agent?: AgentKind; sessionId?: string; showHidden?: boolean; offset?: number; length?: number }

/** The same cached session collection backs projects.recent and file authorization.
 * Agent switches are checked again on every operation, including after I/O. */
export class ProjectFiles {
  private owners = new Map<string, Set<AgentKind>>();
  private cached?: { at: number; signature: string; sessions: SessionSummary[] };
  private pending?: { signature: string; promise: Promise<SessionSummary[]> };
  private adapters: () => Adapter[];
  private disabled: () => AgentKind[];
  private now: () => number;
  constructor(adapters: () => Adapter[], disabled: () => AgentKind[], now = Date.now) {
    this.adapters = adapters; this.disabled = disabled; this.now = now;
  }
  invalidate() { this.cached = undefined; }
  async sessions(): Promise<SessionSummary[]> {
    const signature = [...this.disabled()].sort().join(',');
    if (this.cached?.signature === signature && this.now() - this.cached.at < 60_000) return this.cached.sessions;
    if (this.pending?.signature === signature) return this.pending.promise;
    const promise = Promise.all(this.adapters().filter(a => !this.disabled().includes(a.kind))
      .map(a => a.listSessions(60).catch(() => [] as SessionSummary[]))).then(lists => {
      const sessions = lists.flat();
      for (const s of sessions) { const owners = this.owners.get(s.cwd) ?? new Set<AgentKind>(); owners.add(s.agent); this.owners.set(s.cwd, owners); }
      this.cached = { at: this.now(), signature, sessions };
      return sessions;
    });
    this.pending = { signature, promise };
    try { return await promise; } finally { if (this.pending?.promise === promise) this.pending = undefined; }
  }
  private checkAgent(agent?: AgentKind) {
    if (agent && this.disabled().includes(agent)) throw new Error(`${this.adapters().find(a => a.kind === agent)?.name ?? agent} is turned off on this Mac.`);
  }
  async authorize(p: FileParams) {
    this.checkAgent(p.agent);
    if (typeof p.cwd !== 'string' || !isAbsolute(p.cwd)) throw new Error('Unknown project directory');
    const sessions = await this.sessions();
    this.checkAgent(p.agent);
    // Projects are shared across enabled agents. sessionId is UI context, never
    // an authorization grant; only the server-discovered cwd collection grants access.
    const matches = sessions.filter(s => s.cwd === p.cwd);
    if (!matches.some(s => !this.disabled().includes(s.agent))) {
      const owners = [...(this.owners.get(p.cwd) ?? [])];
      if (owners.length && owners.every(a => this.disabled().includes(a))) this.checkAgent(owners[0]);
      throw new Error('Unknown project directory');
    }
    return realpath(p.cwd);
  }
  private async target(p: FileParams) {
    const root = await this.authorize(p);
    if (p.path !== undefined && typeof p.path !== 'string') throw new Error('Invalid path');
    const requested = resolve(p.cwd, p.path ?? '.');
    if (sensitivePath(requested)) throw new Error(SECRET_ERROR);
    if (gitPath(requested)) throw new Error('This directory is not available');
    const path = await realpath(requested);
    if (!inside(root, path)) throw new Error('Path is outside the project directory');
    if (sensitivePath(path)) throw new Error(SECRET_ERROR);
    if (gitPath(path)) throw new Error('This directory is not available');
    return { root, path };
  }
  async list(p: FileParams) {
    const { root, path } = await this.target(p);
    const names = (await readdir(path, { withFileTypes: true })).filter(e => e.name.toLowerCase() !== '.git' && (p.showHidden === true || !e.name.startsWith('.')));
    const entries = [];
    for (const entry of names) {
      const child = resolve(path, entry.name);
      let blocked = sensitivePath(child), size = 0, modifiedAt = 0, kind: 'file' | 'dir' = entry.isDirectory() ? 'dir' : 'file';
      try {
        const actual = await realpath(child);
        blocked ||= !inside(root, actual) || sensitivePath(actual) || gitPath(actual);
        if (!blocked) {
          const info = await stat(actual);
          size = info.size; modifiedAt = info.mtimeMs; kind = info.isDirectory() ? 'dir' : 'file';
          blocked ||= !info.isFile() && !info.isDirectory();
        }
      } catch { blocked = true; }
      entries.push({ name: entry.name, path: child, kind, size, modifiedAt, hidden: entry.name.startsWith('.'), blocked });
    }
    entries.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'dir' ? -1 : 1) || a.name.localeCompare(b.name));
    if (await this.authorize(p) !== root || await realpath(path) !== path) throw new Error('Directory changed; retry');
    // Leave room for JSON and the relay's encrypted base64 envelope, even with
    // deeply nested directories and maximum-length Unicode filenames.
    const page = []; let bytes = Buffer.byteLength(root) + Buffer.byteLength(path) + 1024;
    for (const entry of entries.slice(0, 500)) {
      bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (bytes > 600 * 1024) break;
      page.push(entry);
    }
    return { root, path, entries: page, ...(entries.length > page.length ? { truncated: true } : {}) };
  }
  async read(p: FileParams) {
    const { root, path } = await this.target(p);
    const offset = p.offset ?? 0, length = p.length ?? FILE_CHUNK;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1) throw new Error('Invalid file range');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      // Reject a replaced parent/symlink between realpath and open as well.
      const actual = await realpath(path), current = await stat(actual);
      if (!inside(root, actual) || actual !== path || current.ino !== info.ino || current.dev !== info.dev) throw new Error('File changed; retry');
      if (!info.isFile()) throw new Error('Not a regular file');
      if (info.size > FILE_LIMIT) throw new Error('Files larger than 20 MiB cannot be opened from the phone.');
      const sample = Buffer.alloc(Math.min(4096, info.size));
      await file.read(sample, 0, sample.length, 0);
      const data = Buffer.alloc(Math.min(length, FILE_CHUNK, Math.max(0, info.size - offset)));
      const { bytesRead } = await file.read(data, 0, data.length, offset);
      if (await this.authorize(p) !== root) throw new Error('Directory changed; retry');
      return { root, path, size: info.size, mime: fileMime(path, sample), offset, data: data.subarray(0, bytesRead).toString('base64'), eof: offset + bytesRead >= info.size };
    } finally { await file.close(); }
  }
}
