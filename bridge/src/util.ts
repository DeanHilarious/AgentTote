import { execFile } from 'node:child_process';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = homedir();

/** Launchd and GUI launches get a bare PATH; make sure the usual CLI locations are present. */
export function augmentedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', join(HOME, '.local/bin'), join(HOME, 'homebrew/bin')];
  const parts = (env.PATH ?? '/usr/bin:/bin').split(':');
  for (const d of dirs) if (!parts.includes(d)) parts.push(d);
  env.PATH = parts.join(':');
  // Started from inside a Claude Code session? Don't let child agents inherit that session's identity.
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key === 'CLAUDE_PID' || key.startsWith('CLAUDE_CODE_') || key.startsWith('CLAUDE_AGENT_SDK_')) delete env[key];
  }
  return env;
}

export function run(cmd: string, args: string[], timeoutMs = 10_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise(resolve => {
    try {
      execFile(cmd, args, { env: augmentedEnv(), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      });
    } catch (err) {
      resolve({ stdout: '', stderr: err instanceof Error ? err.message : String(err), code: 1 });
    }
  });
}

/** Read up to `bytes` from the start (or end) of a file. Agent transcripts can be many MB. */
export async function readChunk(path: string, bytes: number, fromEnd: boolean): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(bytes, size);
    const pos = fromEnd ? size - len : 0;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, pos);
    let text = buf.toString('utf8');
    // Drop the partial line at the cut.
    if (fromEnd && pos > 0) text = text.slice(text.indexOf('\n') + 1);
    if (!fromEnd && len < size) text = text.slice(0, text.lastIndexOf('\n') + 1);
    return text;
  } finally {
    await fh.close();
  }
}

export function parseJsonLines(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Truncated or non-JSON line; skip.
    }
  }
  return out;
}

export interface FileEntry {
  path: string;
  mtimeMs: number;
}

/** `<root>/<project>/<file>.jsonl`, newest first. */
export async function listProjectJsonl(root: string): Promise<FileEntry[]> {
  let projects: string[];
  try {
    projects = await readdir(root);
  } catch {
    return [];
  }
  const entries: FileEntry[] = [];
  await Promise.all(
    projects.map(async p => {
      const dir = join(root, p);
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        return;
      }
      await Promise.all(
        files
          .filter(f => f.endsWith('.jsonl'))
          .map(async f => {
            const path = join(dir, f);
            try {
              const s = await stat(path);
              if (s.isFile()) entries.push({ path, mtimeMs: s.mtimeMs });
            } catch {
              // Vanished between readdir and stat.
            }
          }),
      );
    }),
  );
  return entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function oneLine(text: string, max = 120): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** A transcript entry is "recently written" if it changed in the last two minutes. */
export const ACTIVE_WINDOW_MS = 2 * 60 * 1000;

/** Short human description of a tool call's input, for the phone's activity feed. */
export function describeToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  for (const key of ['command', 'description', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt']) {
    if (typeof o[key] === 'string' && o[key]) return oneLine(o[key] as string, 160);
  }
  return undefined;
}
