import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { snapshotProcesses } from '../procs.ts';
import type { Adapter, AgentInfo, ChatMessage, ModelOption, PermissionMode, RunningTask, SessionSummary, StartTaskOptions, TaskSink } from '../types.ts';
import { ACTIVE_WINDOW_MS, exists, listProjectJsonl, oneLine, parseJsonLines, readChunk, run } from '../util.ts';
import { runStreamJson } from './streamJson.ts';
import { isWorkBuddyAuthFailure, loadWorkBuddyKey, workbuddyEnv, WORKBUDDY_CLI, WORKBUDDY_HOME, WORKBUDDY_CONNECT_DETAIL, WORKBUDDY_CONNECT_ERROR } from '../workbuddyKey.ts';
import { redactSecrets } from '../secrets.ts';
export { WORKBUDDY_CLI, WORKBUDDY_HOME, workbuddyEnv } from '../workbuddyKey.ts';

const APP = process.env.WORKBUDDY_APP ?? '/Applications/WorkBuddy.app';
const PROJECTS = join(WORKBUDDY_HOME, 'projects');

// Verified with the bundled codebuddy-headless.js --help (2026-10-15).
export const WORKBUDDY_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const PERMISSION_FLAGS: Record<PermissionMode, string> = {
  readOnly: 'plan',
  acceptEdits: 'acceptEdits',
  full: 'bypassPermissions',
};

function textParts(entry: any, partType: string): string {
  if (entry.type !== 'message' || !Array.isArray(entry.content)) return '';
  return entry.content
    .filter((c: any) => c.type === partType && typeof c.text === 'string')
    .map((c: any) => c.text as string)
    .filter((t: string) => !t.trimStart().startsWith('<')) // system reminders, expert prompts
    .join('\n')
    .trim();
}

export class WorkBuddyAdapter implements Adapter {
  readonly kind = 'workbuddy' as const;
  readonly name = 'WorkBuddy';
  private needsLogin = false;
  private cwdCache = new Map<string, string>();
  private activeSessions = new Set<string>();
  private options: { cli?: string; directory?: string; processCount?: () => Promise<number> };
  private credentialGeneration = 0;
  constructor(options: { cli?: string; directory?: string; processCount?: () => Promise<number> } = {}) { this.options = options; }
  credentialsChanged(): void { this.credentialGeneration++; this.needsLogin = false; }

  async listModels(): Promise<ModelOption[]> {
    const env = workbuddyEnv(await loadWorkBuddyKey(this.options.directory));
    const cliDirectory = dirname(this.options.cli ?? WORKBUDDY_CLI);
    const productDirectory = ['bin', 'dist'].includes(basename(cliDirectory)) ? dirname(cliDirectory) : cliDirectory;
    const filename = env.CODEBUDDY_INTERNET_ENVIRONMENT === 'internal' ? 'product.internal.json' : 'product.json';
    const product = JSON.parse(await readFile(join(productDirectory, filename), 'utf8'));
    if (!Array.isArray(product.models)) throw new Error('Invalid WorkBuddy model list');
    return product.models
      .filter((model: any) => typeof model.id === 'string' && model.supportsToolCall === true
        && !/^(codewise-|completion)/i.test(model.id)
        && !(model.tags ?? []).some((tag: unknown) => typeof tag === 'string' && /image|图片|图像/i.test(tag)))
      .map((model: any): ModelOption => ({
        id: model.id, name: model.name || model.id,
        description: model.descriptionZh || model.descriptionEn, note: model.credits,
        isDefault: model.isDefault === true,
        ...(model.supportsReasoning === true ? {
          efforts: [...WORKBUDDY_EFFORTS], defaultEffort: model.reasoning?.effort,
        } : {}),
      }));
  }

  async detect(): Promise<AgentInfo> {
    const runningProcesses = this.options.processCount ? await this.options.processCount() : (await snapshotProcesses()).workbuddyProcesses;
    const base = { kind: this.kind, name: this.name, runningProcesses };
    if (!(await exists(this.options.cli ?? WORKBUDDY_CLI))) return { ...base, status: 'unavailable', detail: `WorkBuddy not found at ${APP}` };
    const v = await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(APP, 'Contents/Info.plist')]);
    const version = v.code === 0 ? v.stdout.trim() : undefined;
    if (!await loadWorkBuddyKey(this.options.directory) || this.needsLogin) {
      return { ...base, status: 'needsLogin', version, detail: WORKBUDDY_CONNECT_DETAIL };
    }
    return { ...base, status: 'ready', version };
  }

  async listSessions(limit: number): Promise<SessionSummary[]> {
    const files = await listProjectJsonl(PROJECTS);
    const now = Date.now();
    const out: SessionSummary[] = [];
    for (const f of files) {
      if (out.length >= limit) break;
      const s = await this.summarize(f.path, f.mtimeMs).catch(() => undefined);
      if (!s) continue;
      s.running = this.activeSessions.has(s.id) || now - f.mtimeMs < ACTIVE_WINDOW_MS;
      out.push(s);
    }
    return out;
  }

  private async summarize(path: string, mtimeMs: number): Promise<SessionSummary | undefined> {
    const id = basename(path, '.jsonl');
    const head = parseJsonLines(await readChunk(path, 512 * 1024, false));
    const tail = parseJsonLines(await readChunk(path, 128 * 1024, true));
    let cwd = '';
    let title: string | undefined;
    let firstPrompt: string | undefined;
    let lastPrompt: string | undefined;
    for (const e of [...head, ...tail]) {
      if (!cwd && typeof e.cwd === 'string') cwd = e.cwd;
      if (e.type === 'ai-title' && e.aiTitle) title = e.aiTitle;
      if (e.role === 'user') {
        const t = textParts(e, 'input_text');
        if (t) {
          firstPrompt ??= t;
          lastPrompt = t;
        }
      }
    }
    if (!cwd && !firstPrompt) return undefined;
    if (cwd) this.cwdCache.set(id, cwd);
    return {
      id,
      agent: this.kind,
      title: oneLine(title ?? firstPrompt ?? 'Untitled task', 80),
      cwd,
      updatedAt: Math.round(mtimeMs),
      running: false,
      preview: lastPrompt ? oneLine(lastPrompt, 160) : undefined,
    };
  }

  private async findSessionFile(sessionId: string): Promise<string | undefined> {
    if (!/^[0-9a-z-]{8,64}$/i.test(sessionId)) return undefined;
    for (const p of await readdir(PROJECTS).catch(() => [] as string[])) {
      const candidate = join(PROJECTS, p, `${sessionId}.jsonl`);
      if (await exists(candidate)) return candidate;
    }
    return undefined;
  }

  async getMessages(sessionId: string, limit: number): Promise<ChatMessage[]> {
    const file = await this.findSessionFile(sessionId);
    if (!file) throw new Error(`WorkBuddy session ${sessionId} not found`);
    const messages: ChatMessage[] = [];
    for (const e of parseJsonLines(await readChunk(file, 2 * 1024 * 1024, true))) {
      const role = e.role === 'user' ? 'user' : e.role === 'assistant' ? 'assistant' : undefined;
      if (!role) continue;
      const text = textParts(e, role === 'user' ? 'input_text' : 'output_text');
      if (!text) continue;
      const prev = messages[messages.length - 1];
      if (role === 'assistant' && prev?.role === 'assistant') prev.text += '\n\n' + text;
      else messages.push({ id: e.id ?? String(messages.length), role, text, timestamp: typeof e.timestamp === 'number' ? e.timestamp : undefined });
    }
    return messages.slice(-limit);
  }

  async startTask(opts: StartTaskOptions, sink: TaskSink): Promise<RunningTask> {
    if (opts.fork) {
      sink.finish({ status: 'failed', error: 'Continuing in a copy is only supported for ChatGPT (Codex).' });
      return { cancel() {} };
    }
    const key = await loadWorkBuddyKey(this.options.directory);
    const generation = this.credentialGeneration;
    let cwd = opts.cwd;
    if (opts.sessionId) {
      cwd = this.cwdCache.get(opts.sessionId);
      if (!cwd) {
        const file = await this.findSessionFile(opts.sessionId);
        if (!file) throw new Error(`WorkBuddy session ${opts.sessionId} not found`);
        cwd = (await this.summarize(file, Date.now()))?.cwd;
      }
    }
    if (!cwd) throw new Error('A working directory is required for a new WorkBuddy task');
    const args = [this.options.cli ?? WORKBUDDY_CLI, '-p', '--output-format', 'stream-json', '--include-partial-messages', '--permission-mode', PERMISSION_FLAGS[opts.permissionMode]];
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    if (opts.model !== undefined) args.push('--model', opts.model);
    if (opts.effort !== undefined) args.push('--effort', opts.effort);
    args.push('--', opts.prompt);

    let sessionId = opts.sessionId;
    const trackingSink: TaskSink = {
      emit: e => sink.emit(e),
      delta: (id, text) => sink.delta(id, text),
      setSession: id => {
        sessionId = id;
        this.activeSessions.add(id);
        sink.setSession(id);
      },
      finish: outcome => {
        if (sessionId) this.activeSessions.delete(sessionId);
        sink.finish(outcome);
      },
    };
    return runStreamJson(
      {
        // Run the bundled JS with our own Node so it works without WorkBuddy's private runtime on PATH.
        command: process.execPath,
        retryWithoutPartialMessages: true,
        args,
        cwd,
        env: workbuddyEnv(key),
        sanitizeOutput: redactSecrets,
        onMessage: message => {
          if (message.type === 'system' && message.subtype === 'init' && typeof message.model === 'string') {
            sink.setModel?.(message.model, opts.effort);
          }
        },
        onOutput: output => {
          if (!isWorkBuddyAuthFailure(output)) return undefined;
          if (generation === this.credentialGeneration) this.needsLogin = true;
          return WORKBUDDY_CONNECT_ERROR;
        },
        onResult: r => {
          if (generation === this.credentialGeneration && !r.is_error && r.subtype === 'success') this.needsLogin = false;
        },
      },
      trackingSink,
    );
  }
}
