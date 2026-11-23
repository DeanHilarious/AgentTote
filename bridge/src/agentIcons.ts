import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { promisify } from 'node:util';
import type { AgentInfo, AgentKind } from './types.ts';

const exec = promisify(execFile);
const apps = {
  codex: { bundleId: 'com.openai.codex', path: '/Applications/ChatGPT.app' },
  workbuddy: { bundleId: 'com.tencent.workbuddy.mac', path: '/Applications/WorkBuddy.app' },
  // Confirmed from /Applications/Claude.app/Contents/Info.plist.
  claude: { bundleId: 'com.anthropic.claudefordesktop', path: '/Applications/Claude.app' },
  antigravity: { bundleId: 'com.google.antigravity', path: '/Applications/Antigravity.app' },
  cursor: { bundleId: 'com.todesktop.230313mzl4w4u92', path: '/Applications/Cursor.app' },
};
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const MAX_BYTES = 64 * 1024;

export interface AgentIconData { iconHash: string; png: Buffer; iconPath?: string }
export interface IconProvider { get(agent: AgentKind): Promise<AgentIconData | undefined> }
export interface IconDependencies {
  run(file: string, args: string[]): Promise<string>;
  read(path: string): Promise<Buffer>;
  stat(path: string): Promise<{ mtimeMs: number }>;
  mkdir(path: string): Promise<unknown>;
  temporary(): Promise<string>;
  write(path: string, data: Buffer): Promise<unknown>;
  remove(path: string): Promise<unknown>;
}
const defaults: IconDependencies = {
  run: async (file, args) => (await exec(file, args, { timeout: 5_000, maxBuffer: 1024 * 1024 })).stdout,
  read: readFile, stat,
  mkdir: path => mkdir(path, { recursive: true, mode: 0o700 }),
  temporary: () => mkdtemp(join(tmpdir(), 'agentanywhere-icon-')),
  write: (path, data) => writeFile(path, data, { mode: 0o600 }),
  remove: path => rm(path, { recursive: true, force: true }),
};

/** Only PNGs produced at runtime are cached; no vendor artwork ships with the bridge. */
export class AgentIcons implements IconProvider {
  private cache = new Map<string, AgentIconData>();
  private pending = new Map<AgentKind, Promise<AgentIconData | undefined>>();
  private directory: string;
  private io: IconDependencies;
  constructor(directory = join(homedir(), '.agentanywhere', 'icons'), io: IconDependencies = defaults) {
    this.directory = directory;
    this.io = io;
  }

  get(agent: AgentKind): Promise<AgentIconData | undefined> {
    const existing = this.pending.get(agent);
    if (existing) return existing;
    const promise = this.load(agent).catch(() => undefined).finally(() => { this.pending.delete(agent); });
    this.pending.set(agent, promise);
    return promise;
  }

  private async plist(app: string, key: string): Promise<string> {
    return (await this.io.run('/usr/bin/plutil', ['-extract', key, 'raw', join(app, 'Contents', 'Info.plist')])).trim();
  }

  private async locate(agent: AgentKind): Promise<string | undefined> {
    const spec = apps[agent];
    let found: string[] = [];
    try {
      found = (await this.io.run('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == '${spec.bundleId}'`]))
        .split('\n').map(p => p.trim()).filter(p => p.startsWith('/') && p.endsWith('.app'))
        .sort((a, b) => Number(!a.startsWith('/Applications/')) - Number(!b.startsWith('/Applications/')) || a.localeCompare(b));
    } catch { /* Spotlight may be unavailable; try the known installation path. */ }
    for (const app of [...new Set([...found, spec.path])]) {
      try {
        // The Codex app also contains app.icns; deliberately use only the ChatGPT artwork.
        const name = agent === 'codex' ? 'icon-chatgpt.icns' : await this.plist(app, 'CFBundleIconFile');
        if (!name || basename(name) !== name) continue;
        const path = join(app, 'Contents', 'Resources', name.endsWith('.icns') ? name : `${name}.icns`);
        await this.io.stat(path);
        return path;
      } catch { /* Try another installation, otherwise retain the drawn fallback. */ }
    }
    return undefined;
  }

  private valid(png: Buffer): boolean {
    return png.length >= 24 && png.length <= MAX_BYTES && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      png.toString('ascii', 12, 16) === 'IHDR' && png.readUInt32BE(16) > 0 && png.readUInt32BE(16) <= 192 &&
      png.readUInt32BE(20) > 0 && png.readUInt32BE(20) <= 192;
  }

  private async load(agent: AgentKind): Promise<AgentIconData | undefined> {
    const source = await this.locate(agent);
    if (!source) return undefined;
    const { mtimeMs } = await this.io.stat(source);
    const key = `${source}\0${mtimeMs}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const iconPath = join(this.directory, `${agent}-${digest(key).slice(0, 12)}.png`);
    let png: Buffer | undefined;
    try {
      const disk = await this.io.read(iconPath);
      if (this.valid(disk)) png = disk;
    } catch { /* First conversion or stale/corrupt cache. */ }
    if (!png) {
      const temporary = await this.io.temporary();
      try {
        const output = join(temporary, 'icon.png');
        for (const size of [192, 128]) {
          await this.io.run('/usr/bin/sips', ['-s', 'format', 'png', '-Z', String(size), source, '--out', output]);
          const converted = await this.io.read(output);
          if (this.valid(converted)) { png = converted; break; }
        }
      } finally { await this.io.remove(temporary); }
      if (!png) return undefined;
      try {
        await this.io.mkdir(this.directory);
        await this.io.write(iconPath, png);
      } catch {
        // A read-only home should not prevent phone icons from working.
        const result = { iconHash: digest(png).slice(0, 16), png };
        this.cache.set(key, result);
        return result;
      }
    }
    const result = { iconHash: digest(png).slice(0, 16), png, iconPath };
    // Only retain the latest version of this source in memory.
    for (const old of this.cache.keys()) if (old.startsWith(`${source}\0`)) this.cache.delete(old);
    this.cache.set(key, result);
    return result;
  }
}

export const agentIcons = new AgentIcons();

export async function withAgentIcon(info: AgentInfo, icons: IconProvider = agentIcons, local = false): Promise<AgentInfo & { iconPath?: string }> {
  const { iconHash: _oldHash, iconPath: _oldPath, ...base } = info as AgentInfo & { iconPath?: string };
  const icon = await icons.get(info.kind);
  return { ...base, ...(icon ? { iconHash: icon.iconHash, ...(local && icon.iconPath ? { iconPath: icon.iconPath } : {}) } : {}) };
}
