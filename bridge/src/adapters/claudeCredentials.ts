import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exists, HOME } from '../util.ts';

export const CLAUDE_LOGIN_REQUIRED = "Claude Code isn't signed in on this Mac. Run `claude` in Terminal and use /login.";

/** Only the exit code is observed; Keychain output is never read or captured. */
export function keychainHasClaudeCredentials(): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials'],
      { stdio: 'ignore', timeout: 3_000 });
    child.once('error', () => resolve(false));
    child.once('close', code => resolve(code === 0));
  });
}

function nonempty(value: unknown): boolean { return typeof value === 'string' && value.trim().length > 0; }
function hasEnvCredentials(env: NodeJS.ProcessEnv): boolean {
  return nonempty(env.ANTHROPIC_API_KEY) || nonempty(env.ANTHROPIC_AUTH_TOKEN);
}

export class ClaudeCredentials {
  private readonly env: NodeJS.ProcessEnv;
  private readonly readSettings: () => Promise<string>;
  private readonly credentialsExist: () => Promise<boolean>;
  private readonly keychainExists: () => Promise<boolean>;
  private readonly now: () => number;
  private cache?: { checkedAt: number; result: Promise<boolean> };

  constructor(options: { env?: NodeJS.ProcessEnv; readSettings?: () => Promise<string>;
    credentialsExist?: () => Promise<boolean>; keychainExists?: () => Promise<boolean>; now?: () => number } = {}) {
    this.env = options.env ?? process.env;
    const directory = this.env.CLAUDE_CONFIG_DIR ?? join(HOME, '.claude');
    this.readSettings = options.readSettings ?? (() => readFile(join(directory, 'settings.json'), 'utf8'));
    this.credentialsExist = options.credentialsExist ?? (() => exists(join(directory, '.credentials.json')));
    this.keychainExists = options.keychainExists ?? keychainHasClaudeCredentials;
    this.now = options.now ?? Date.now;
  }

  hasCredentials(): Promise<boolean> {
    const now = this.now();
    if (this.cache && now >= this.cache.checkedAt && now - this.cache.checkedAt < 30_000) return this.cache.result;
    const result = this.check();
    this.cache = { checkedAt: now, result };
    return result;
  }

  private async check(): Promise<boolean> {
    if (hasEnvCredentials(this.env)) return true;
    try {
      const settings = JSON.parse(await this.readSettings());
      if (hasEnvCredentials(settings?.env ?? {}) || nonempty(settings?.apiKeyHelper)) return true;
    } catch { /* Missing or malformed settings do not rule out other credential sources. */ }
    if (await this.credentialsExist().catch(() => false)) return true;
    return this.keychainExists().catch(() => false);
  }
}
