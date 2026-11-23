import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configDirectory, writePrivateFile } from './config.ts';
import { rememberSecret } from './secrets.ts';
import { augmentedEnv, HOME, parseJsonLines } from './util.ts';

const APP = process.env.WORKBUDDY_APP ?? '/Applications/WorkBuddy.app';
export const WORKBUDDY_CLI = join(APP, 'Contents/Resources/app.asar.unpacked/cli/bin/codebuddy');
export const WORKBUDDY_HOME = join(HOME, '.workbuddy');
export const WORKBUDDY_KEYS_URL = 'https://www.codebuddy.cn/profile/keys';
export const WORKBUDDY_CONNECT_DETAIL = 'Connect WorkBuddy in the AgentTote app on your Mac.';
export const WORKBUDDY_CONNECT_ERROR = "WorkBuddy isn't connected. Connect it in the AgentTote app on your Mac.";

export interface WorkBuddyKey { apiKey: string; environment?: string | null }
export type KeyVerification = { ok: true; environment: string | null }
  | { ok: false; code: 'invalid_key' | 'verify_failed'; reason: string };

export function normalizeWorkBuddyKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value.trim();
  return key.length >= 16 && key.length <= 512 && !/\s/u.test(key) ? key : undefined;
}

export async function loadWorkBuddyKey(directory = configDirectory()): Promise<WorkBuddyKey | undefined> {
  try {
    const value = JSON.parse(await readFile(join(directory, 'workbuddy.json'), 'utf8'));
    const apiKey = normalizeWorkBuddyKey(value?.apiKey);
    if (!apiKey || !(value.environment === undefined || value.environment === null || typeof value.environment === 'string')) return undefined;
    rememberSecret(apiKey);
    return { apiKey, environment: value.environment === undefined ? 'internal' : value.environment };
  } catch { return undefined; }
}

export async function saveWorkBuddyKey(key: WorkBuddyKey, directory = configDirectory()): Promise<void> {
  rememberSecret(key.apiKey);
  await writePrivateFile('workbuddy.json', JSON.stringify({ apiKey: key.apiKey, environment: key.environment === undefined ? 'internal' : key.environment }) + '\n', directory);
}

export async function deleteWorkBuddyKey(directory = configDirectory()): Promise<void> {
  await loadWorkBuddyKey(directory); // Keep the old value in the redaction set.
  await rm(join(directory, 'workbuddy.json'), { force: true });
}

export function workbuddyEnv(key?: WorkBuddyKey): NodeJS.ProcessEnv {
  const env = augmentedEnv({ CODEBUDDY_CONFIG_DIR: WORKBUDDY_HOME });
  if (key) {
    rememberSecret(key.apiKey);
    env.CODEBUDDY_API_KEY = key.apiKey;
    if (key.environment === null) delete env.CODEBUDDY_INTERNET_ENVIRONMENT;
    else env.CODEBUDDY_INTERNET_ENVIRONMENT = key.environment ?? 'internal';
  }
  return env;
}

export function isWorkBuddyAuthFailure(output: string): boolean {
  if (/Authentication required/i.test(output)) return true;
  return output.split('\n').some(line => {
    try {
      const message = JSON.parse(line);
      line = JSON.stringify(message);
      if (/Authentication required/i.test(line)) return true;
      // Normal answers can discuss authentication errors; inspect failed CLI output only.
      if (message.type === 'assistant' || message.type === 'result' && message.subtype === 'success' && !message.is_error) return false;
    } catch { /* Plain CLI diagnostics. */ }
    return /invalid[ _-]?api[ _-]?key|(?:http|api[ _-]?error|status(?:[_ -]?code)?)["'\s:=]*(?:error[\s:]*)?401\b|\b401\b[^\n]*(?:auth|api.?key|credential)|(?:auth|api.?key|credential)[^\n]*\b401\b/i.test(line);
  });
}

/** Test injection changes only the CLI path/deadline, never calls the real CLI in tests. */
export async function verifyWorkBuddyKey(apiKey: string, environment: string | null = 'internal', options: {
  cli?: string; timeoutMs?: number;
} = {}): Promise<KeyVerification> {
  rememberSecret(apiKey);
  let directory: string | undefined;
  try {
    const attempt = async (env: string | null): Promise<KeyVerification> => {
      if (directory) await rm(directory, { recursive: true, force: true });
      directory = await mkdtemp(join(tmpdir(), 'aa-workbuddy-verify-'));
      return new Promise(resolve => {
        const childEnv = workbuddyEnv({ apiKey, environment: env });
        // Isolate verification from saved sign-in, plugins and project configuration.
        childEnv.CODEBUDDY_CONFIG_DIR = join(directory!, 'config');
        execFile(process.execPath, [options.cli ?? WORKBUDDY_CLI, '-p', 'Reply with OK', '--output-format', 'stream-json', '--permission-mode', 'plan'], {
          cwd: directory, env: childEnv, timeout: options.timeoutMs ?? 90_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
        }, (error, stdout, stderr) => {
          const output = String(stdout) + '\n' + String(stderr);
          if (isWorkBuddyAuthFailure(output)) return resolve({ ok: false, code: 'invalid_key', reason: 'Authentication failed.' });
          const result = parseJsonLines(String(stdout)).findLast(m => m.type === 'result');
          if (!error && result && !result.is_error && result.subtype === 'success' && typeof result.result === 'string' && result.result.trim()) {
            return resolve({ ok: true, environment: env });
          }
          // Never forward CLI diagnostics: they may echo credentials or request headers.
          const reason = error?.killed ? 'Verification timed out.' : error ? 'CLI could not complete verification.' : 'CLI returned no successful result.';
          resolve({ ok: false, code: 'verify_failed', reason });
        });
      });
    };
    const first = await attempt(environment);
    return !first.ok && first.code === 'invalid_key' && environment === 'internal' ? await attempt(null) : first;
  } catch { return { ok: false, code: 'verify_failed', reason: 'Could not prepare verification.' }; }
  finally { if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {}); }
}
