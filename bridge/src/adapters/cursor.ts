import { attachmentDirectories } from '../attachments.ts';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { configDirectory } from '../config.ts';
import { snapshotProcesses } from '../procs.ts';
import { redactSecrets } from '../secrets.ts';
import type {
  Adapter,
  AgentInfo,
  ChatMessage,
  ModelOption,
  PermissionMode,
  RunningTask,
  SessionSummary,
  StartTaskOptions,
  TaskSink,
} from '../types.ts';
import { augmentedEnv, exists, HOME, oneLine, run } from '../util.ts';
import { CursorSessionStore, describeError, isCursorSessionId, isMissingFile, isRecord } from './cursorSessions.ts';
import { runCursorStream } from './cursorStream.ts';

export const CURSOR_LOGIN_REQUIRED = 'Run `cursor-agent login` in Terminal, then try again.';
const AUTH_FAILURE = /not (?:logged|signed) in|log ?in required|please (?:log|sign) ?in|unauthenticated|not authenticated|authentication (?:required|failed)|cursor-agent login/i;
const NO_EFFORT = 'Cursor models encode reasoning effort in the model ID. Pick a model such as a "-high" variant instead of an effort.';
const UNRESTRICTED =
  'Cursor CLI is set to approvalMode "unrestricted", which would let this run execute commands without asking. ' +
  'Choose Full access to allow that, or change approvalMode in Cursor\'s CLI settings yourself (AgentTote never edits them).';

const PERMISSION_FLAGS: Record<PermissionMode, string[]> = {
  // Plan mode is Cursor's read-only planning mode; commands the user already allow-listed may still run.
  readOnly: ['--mode', 'plan'],
  acceptEdits: ['--sandbox', 'enabled'],
  full: ['--force'],
};

export interface CursorOptions {
  /** Explicit CLI path; when set it is the only candidate. */
  cli?: string;
  /** Session history directory; defaults to `<AgentTote config>/cursor/sessions`. */
  directory?: string;
  /** Cursor CLI config directory; defaults to `CURSOR_CONFIG_DIR` or `~/.cursor`. */
  configDir?: string;
  processCount?: () => Promise<number>;
  killGraceMs?: number;
}

interface Cli {
  bin: string;
  version: string;
}

/** Removes terminal colour codes and anything that looks like an email address. */
function sanitizeDiagnostic(text: string): string {
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '').replace(/[^\s@]+@[^\s@]+/g, '[email]');
  return oneLine(redactSecrets(plain), 200);
}

export function parseCursorModels(output: string): ModelOption[] {
  const seen = new Set<string>();
  const models: ModelOption[] = [];
  for (const line of output.replace(/\u001b\[[0-9;]*m/g, '').split('\n')) {
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*) - (.+)$/.exec(line.trim());
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    const isDefault = /\(default\)\s*$/i.test(match[2]);
    const name = match[2].replace(/\s*\(default\)\s*$/i, '').trim() || match[1];
    models.push({ id: match[1], name, isDefault });
  }
  if (models.length && !models.some(m => m.isDefault)) models[0].isDefault = true;
  return models;
}

export class CursorAdapter implements Adapter {
  readonly kind = 'cursor' as const;
  readonly name = 'Cursor';
  private readonly options: CursorOptions;
  private readonly store: CursorSessionStore;

  constructor(options: CursorOptions = {}) {
    this.options = options;
    this.store = new CursorSessionStore(options.directory ?? join(configDirectory(), 'cursor', 'sessions'));
  }

  private async resolveCli(): Promise<Cli | undefined> {
    const candidates = this.options.cli
      ? [this.options.cli]
      : [
          process.env.CURSOR_BIN,
          join(HOME, '.local', 'bin', 'cursor-agent'),
          'cursor-agent',
          '/Applications/Cursor.app/Contents/Resources/app/bin/cursor-agent',
          join(HOME, 'Applications/Cursor.app/Contents/Resources/app/bin/cursor-agent'),
        ];
    for (const bin of candidates) {
      if (!bin || (bin.includes('/') && !(await exists(bin)))) continue;
      const res = await run(bin, ['--version'], 5000);
      const version = res.stdout.trim().split(/\s+/)[0];
      if (res.code === 0 && version) return { bin, version };
    }
    return undefined;
  }

  async detect(): Promise<AgentInfo> {
    const runningProcesses = this.options.processCount
      ? await this.options.processCount()
      : (await snapshotProcesses()).cursorProcesses;
    const base = { kind: this.kind, name: this.name, runningProcesses };
    const cli = await this.resolveCli();
    if (!cli) return { ...base, status: 'unavailable', detail: 'Cursor CLI (cursor-agent) not found. Install it from cursor.com/cli.' };
    const res = await run(cli.bin, ['status'], 10_000);
    const output = `${res.stdout}\n${res.stderr}`;
    const withVersion = { ...base, version: cli.version };
    if (AUTH_FAILURE.test(output)) return { ...withVersion, status: 'needsLogin', detail: CURSOR_LOGIN_REQUIRED };
    if (res.code === 0 && /logged in/i.test(res.stdout)) return { ...withVersion, status: 'ready' };
    const shown = sanitizeDiagnostic(output) || 'no output';
    const problem = res.code === 0 ? 'Unexpected `cursor-agent status` output' : `\`cursor-agent status\` failed (exit ${res.code})`;
    return { ...withVersion, status: 'unavailable', detail: `${problem}: ${shown}` };
  }

  async listModels(): Promise<ModelOption[]> {
    const cli = await this.resolveCli();
    if (!cli) throw new Error('Cursor CLI (cursor-agent) is not installed');
    const res = await run(cli.bin, ['models'], 15_000);
    const output = `${res.stdout}\n${res.stderr}`;
    if (AUTH_FAILURE.test(output)) throw new Error(CURSOR_LOGIN_REQUIRED);
    if (res.code !== 0) throw new Error(`Could not list Cursor models: ${sanitizeDiagnostic(output) || `exit ${res.code}`}`);
    const models = parseCursorModels(res.stdout);
    if (!models.length) throw new Error('Cursor CLI returned no models');
    return models;
  }

  async listSessions(limit: number): Promise<SessionSummary[]> {
    const sessions = await this.store.list(limit);
    return sessions.map(s => ({
      id: s.id,
      agent: this.kind,
      title: s.title,
      cwd: s.cwd,
      updatedAt: Math.round(s.updatedAt),
      running: this.store.isActive(s.id),
      preview: s.messages.length ? oneLine(s.messages[s.messages.length - 1].text, 160) : undefined,
      origin: 'phone' as const,
    }));
  }

  async getMessages(sessionId: string, limit: number): Promise<ChatMessage[]> {
    const session = await this.store.read(sessionId);
    if (!session) throw new Error(`Cursor session ${sessionId} not found`);
    return limit > 0 ? session.messages.slice(-limit) : [];
  }

  /** Reads only `approvalMode` from Cursor's CLI config; nothing else is kept or logged. */
  private async approvalMode(): Promise<string | undefined> {
    const dir = this.options.configDir ?? process.env.CURSOR_CONFIG_DIR ?? join(HOME, '.cursor');
    let raw: string;
    try {
      raw = await readFile(join(dir, 'cli-config.json'), 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw new Error('Could not read Cursor CLI settings to check its approval mode. Fix the file permissions or choose Full access.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Cursor CLI settings are not valid JSON, so its approval mode cannot be checked. Repair them or choose Full access.');
    }
    return isRecord(parsed) && typeof parsed.approvalMode === 'string' ? parsed.approvalMode : undefined;
  }

  private optionError(opts: StartTaskOptions): string | undefined {
    if (opts.fork) return 'Continuing in a copy is only supported for ChatGPT (Codex).';
    if (opts.effort !== undefined) return NO_EFFORT;
    if (opts.model !== undefined && (!opts.model.trim() || opts.model.startsWith('-'))) return `Invalid Cursor model "${opts.model}".`;
    return undefined;
  }

  /** Resume needs a session AgentTote created and its saved directory; new tasks need an existing cwd. */
  private async resolveTarget(opts: StartTaskOptions): Promise<{ cwd: string; sessionId?: string }> {
    let cwd = opts.cwd;
    let sessionId: string | undefined;
    if (opts.sessionId !== undefined) {
      const stored = isCursorSessionId(opts.sessionId) ? await this.store.read(opts.sessionId) : undefined;
      if (!stored) throw new Error(`Cursor session ${opts.sessionId} not found`);
      sessionId = stored.id;
      cwd = stored.cwd;
    }
    if (!cwd) throw new Error('A working directory is required for a new Cursor task');
    const absolute = resolve(cwd);
    const info = await stat(absolute).catch((error: unknown) => {
      if (isMissingFile(error)) throw new Error(`Working directory ${absolute} does not exist`);
      throw error;
    });
    if (!info.isDirectory()) throw new Error(`Working directory ${absolute} is not a directory`);
    return { cwd: absolute, sessionId };
  }

  private async startupError(opts: StartTaskOptions): Promise<string | undefined> {
    const invalid = this.optionError(opts);
    if (invalid) return invalid;
    if (opts.permissionMode !== 'acceptEdits') return undefined;
    return (await this.approvalMode()) === 'unrestricted' ? UNRESTRICTED : undefined;
  }

  async startTask(opts: StartTaskOptions, sink: TaskSink): Promise<RunningTask> {
    const refused = await this.startupError(opts).catch((error: unknown) => describeError(error));
    if (refused) {
      sink.finish({ status: 'failed', error: refused });
      return { cancel() {} };
    }
    const cli = await this.resolveCli();
    if (!cli) throw new Error('Cursor CLI (cursor-agent) is not installed');
    const target = await this.resolveTarget(opts);
    let held: string | undefined;
    if (target.sessionId) {
      if (!this.store.acquire(target.sessionId)) throw new Error(`Cursor session ${target.sessionId} is already running a task`);
      held = target.sessionId;
    }
    const release = (): void => {
      if (held) this.store.release(held);
      held = undefined;
    };
    const startedAt = Date.now();
    try {
      return runCursorStream({
        command: cli.bin,
        args: this.buildArgs(opts, target),
        cwd: target.cwd,
        env: augmentedEnv(),
        sessionId: target.sessionId,
        killGraceMs: this.options.killGraceMs,
        claimSession: id => {
          if (held === id) return undefined;
          if (held || !this.store.acquire(id)) return `Cursor session ${id} is already running a task`;
          held = id;
          return undefined;
        },
        persist: done => this.store.append({ id: done.sessionId, cwd: target.cwd, prompt: opts.prompt, reply: done.text, startedAt }),
        release,
      }, sink);
    } catch (error) {
      release();
      throw error;
    }
  }

  private buildArgs(opts: StartTaskOptions, target: { cwd: string; sessionId?: string }): string[] {
    const args = ['--print', '--output-format', 'stream-json', '--stream-partial-output', '--workspace', target.cwd, '--trust'];
    for (const directory of attachmentDirectories(opts)) args.push('--add-dir', directory);
    args.push(...PERMISSION_FLAGS[opts.permissionMode]);
    if (opts.model !== undefined) args.push('--model', opts.model);
    if (target.sessionId) args.push('--resume', target.sessionId);
    // `--` so a prompt beginning with "-" is not read as a flag.
    args.push('--', opts.prompt);
    return args;
  }
}
