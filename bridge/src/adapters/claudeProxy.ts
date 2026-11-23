import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { HOME } from '../util.ts';

/** Extract only the endpoint; settings may contain credentials and must never be logged. */
export function settingsBaseUrl(text: string): string | undefined {
  try {
    const value = JSON.parse(text)?.env?.ANTHROPIC_BASE_URL;
    return typeof value === 'string' ? value : undefined;
  } catch { return undefined; }
}

export function tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (ok: boolean) => { clearTimeout(timer); socket.destroy(); resolve(ok); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export class ClaudeApiProxy {
  private env: NodeJS.ProcessEnv;
  private readSettings: () => Promise<string>;
  private connect: typeof tcpReachable;
  private now: () => number;
  private cache?: { address: string; checkedAt: number; result: Promise<string | undefined> };

  constructor(options: { env?: NodeJS.ProcessEnv; readSettings?: () => Promise<string>;
    connect?: typeof tcpReachable; now?: () => number } = {}) {
    this.env = options.env ?? process.env;
    this.readSettings = options.readSettings ?? (() => readFile(join(this.env.CLAUDE_CONFIG_DIR ?? join(HOME, '.claude'), 'settings.json'), 'utf8'));
    this.connect = options.connect ?? tcpReachable;
    this.now = options.now ?? Date.now;
  }

  /** Detection caches for 10s; task starts always check the current endpoint afresh. */
  async failure(fresh = false): Promise<string | undefined> {
    const base = this.env.ANTHROPIC_BASE_URL ?? settingsBaseUrl(await this.readSettings().catch(() => ''));
    if (!base) return undefined;
    let url: URL;
    try { url = new URL(base); } catch { return undefined; }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(host)) return undefined;
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const address = `${host === '::1' ? '[::1]' : host}:${port}`;
    const now = this.now();
    if (!fresh && this.cache?.address === address && now >= this.cache.checkedAt && now - this.cache.checkedAt < 10_000) return this.cache.result;
    const result = this.connect(host, port, 1000).catch(() => false).then(ok => ok ? undefined :
      `Claude Code's API proxy at ${address} isn't running. Start it on your Mac (for example cc-switch).`);
    this.cache = { address, checkedAt: now, result };
    return result;
  }
}
