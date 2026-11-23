import { spawn } from 'node:child_process';
import { cp, copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
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
import { ACTIVE_WINDOW_MS, augmentedEnv, describeToolInput, exists, HOME, oneLine, parseJsonLines, readChunk, run } from '../util.ts';

const require = createRequire(import.meta.url);

export const ANTIGRAVITY_APP = process.env.ANTIGRAVITY_APP ?? '/Applications/Antigravity.app';
export const ANTIGRAVITY_HOME = process.env.ANTIGRAVITY_HOME ?? join(HOME, '.gemini', 'antigravity');
export const ANTIGRAVITY_CLI_HOME = process.env.ANTIGRAVITY_CLI_HOME ?? join(HOME, '.gemini', 'antigravity-cli');
export const ANTIGRAVITY_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const ANTIGRAVITY_LOGIN_REQUIRED = 'Sign in to Antigravity on your Mac (or run `agy` in Terminal) and try again.';

const PERMISSION_FLAGS: Record<PermissionMode, string[]> = {
  readOnly: ['--mode=plan'],
  acceptEdits: ['--mode=accept-edits'],
  full: ['--dangerously-skip-permissions'],
};

const FILE_WRITE_TOOLS = new Set(['write_file', 'write_to_file']);
const FILE_EDIT_TOOLS = new Set([
  'write_file',
  'write_to_file',
  'edit_file',
  'replace_file_content',
  'multi_replace_file_content',
  'sed_file',
  'notebook_edit',
]);

export interface AntigravityOptions {
  cli?: string;
  app?: string;
  appHome?: string;
  cliHome?: string;
  processCount?: () => Promise<number>;
  /** Lock files currently held open by a process; defaults to an lsof scan. */
  heldLocks?: (paths: string[]) => Promise<Set<string>>;
}

/**
 * Antigravity leaves `presence/<id>.lock` files behind after a conversation closes, so only a
 * lock some process still holds open means the conversation is loaded in Desktop or `agy`.
 */
async function lsofHeld(paths: string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  const res = await run('/usr/sbin/lsof', ['-Fn', '--', ...paths], 5000);
  return new Set(res.stdout.split('\n').filter(l => l.startsWith('n')).map(l => l.slice(1)));
}

/** Extract user-typed prompt text from an Antigravity transcript USER_INPUT step. */
export function antigravityUserText(entry: any): string | undefined {
  if (entry?.type !== 'USER_INPUT' || typeof entry.content !== 'string') return undefined;
  if (entry.source && entry.source !== 'USER_EXPLICIT') return undefined;
  const raw = entry.content;
  const reqMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(raw);
  // `agy --mode=plan` (our read-only mode) prepends the /plan slash command to the prompt.
  if (reqMatch) return reqMatch[1].replace(/^\/plan\s+/, '').trim() || undefined;
  const stripped = raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, '')
    .trim();
  if (!stripped || stripped.startsWith('<')) return undefined;
  return stripped;
}

export function antigravityAssistantText(entry: any): string | undefined {
  if (entry?.type !== 'PLANNER_RESPONSE' || typeof entry.content !== 'string') return undefined;
  const text = entry.content.trim();
  return text || undefined;
}

export function extractWorkspaceFromText(text: string): string | undefined {
  const m =
    /Command Working Directory:\s*([^\r\n<]+)/.exec(text) ??
    /Active Workspaces:\s*\r?\n-\s*([^\r\n<]+)/.exec(text);
  return m?.[1]?.trim() || undefined;
}

export function parseWorkspaceUris(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return '';
    for (const item of list) {
      if (typeof item !== 'string' || !item.trim()) continue;
      if (item.startsWith('file://')) {
        try {
          return fileURLToPath(item);
        } catch {
          return decodeURIComponent(item.replace(/^file:\/\//, ''));
        }
      }
      return item;
    }
  } catch {
    // Ignore malformed workspace URI JSON.
  }
  return '';
}

export function describeAntigravityTool(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const i = input as Record<string, unknown>;
  for (const key of ['CommandLine', 'Path', 'TargetFile', 'DirectoryPath', 'SearchPath', 'Query', 'Url', 'Pattern']) {
    if (typeof i[key] === 'string' && (i[key] as string).trim()) return oneLine(i[key] as string, 100);
  }
  return describeToolInput(input);
}

export function isAntigravityAuthFailure(output: string): boolean {
  return /not logged into Antigravity|auth_revoked|Authentication failed|Please log in/i.test(output);
}

interface SummaryRow {
  id: string;
  title: string;
  preview: string;
  cwd: string;
  status: string;
  parentId: string;
  updatedAt: number;
}

function readSummariesDb(dbPath: string): SummaryRow[] {
  try {
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
        prepare(sql: string): { all(): any[] };
        close(): void;
      };
    };
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare(
          `SELECT conversation_id, title, preview, workspace_uris, status, parent_conversation_id, last_modified_time
           FROM conversation_summaries
           ORDER BY last_modified_time DESC
           LIMIT 200`,
        )
        .all();
      return rows
        .filter(r => typeof r?.conversation_id === 'string' && r.conversation_id)
        .map(r => {
          const ts = typeof r.last_modified_time === 'string' ? Date.parse(r.last_modified_time) : NaN;
          return {
            id: r.conversation_id as string,
            title: typeof r.title === 'string' ? r.title.trim() : '',
            preview: typeof r.preview === 'string' ? r.preview.trim() : '',
            cwd: parseWorkspaceUris(r.workspace_uris),
            status: typeof r.status === 'string' ? r.status : '',
            parentId: typeof r.parent_conversation_id === 'string' ? r.parent_conversation_id : '',
            updatedAt: Number.isFinite(ts) && ts > 0 ? ts : 0,
          };
        });
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export class AntigravityAdapter implements Adapter {
  readonly kind = 'antigravity' as const;
  readonly name = 'Antigravity';
  private needsLogin = false;
  private cwdCache = new Map<string, string>();
  private activeSessions = new Set<string>();
  private options: AntigravityOptions;

  constructor(options: AntigravityOptions = {}) {
    this.options = options;
  }

  private get appPath(): string {
    return this.options.app ?? ANTIGRAVITY_APP;
  }

  private get appHome(): string {
    return this.options.appHome ?? ANTIGRAVITY_HOME;
  }

  private get cliHome(): string {
    return this.options.cliHome ?? ANTIGRAVITY_CLI_HOME;
  }

  private async resolveCli(): Promise<{ bin: string; version?: string } | undefined> {
    const candidates = [
      this.options.cli,
      process.env.AGY_BIN,
      join(HOME, '.local', 'bin', 'agy'),
      'agy',
      join(this.appPath, 'Contents/Resources/app/bin/agy'),
      join(this.appPath, 'Contents/Resources/bin/agy'),
    ].filter((c): c is string => Boolean(c));

    for (const bin of candidates) {
      if (bin.includes('/') && !(await exists(bin))) continue;
      const res = await run(bin, ['--version'], 5000);
      if (res.code === 0 && res.stdout.trim()) {
        return { bin, version: res.stdout.trim().split(/\s+/)[0] };
      }
    }
    return undefined;
  }

  async detect(): Promise<AgentInfo> {
    const runningProcesses = this.options.processCount
      ? await this.options.processCount()
      : (await snapshotProcesses()).antigravityProcesses;
    const base = { kind: this.kind, name: this.name, runningProcesses };
    const [cli, plist] = await Promise.all([
      this.resolveCli(),
      run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(this.appPath, 'Contents/Info.plist')]),
    ]);
    const appVersion = plist.code === 0 && plist.stdout.trim() ? plist.stdout.trim() : undefined;
    if (!cli) {
      return {
        ...base,
        status: 'unavailable',
        version: appVersion,
        detail: `Antigravity CLI (agy) not found at ${join(HOME, '.local/bin/agy')}`,
      };
    }
    const version = appVersion ?? cli.version;
    if (this.needsLogin) {
      return { ...base, status: 'needsLogin', version, detail: ANTIGRAVITY_LOGIN_REQUIRED };
    }
    return { ...base, status: 'ready', version };
  }

  async listModels(): Promise<ModelOption[]> {
    const cli = await this.resolveCli();
    if (!cli) throw new Error('Antigravity CLI (agy) is not installed');
    let configuredDefault: string | undefined;
    try {
      const settings = JSON.parse(await readFile(join(this.cliHome, 'settings.json'), 'utf8'));
      if (typeof settings?.model === 'string' && settings.model.trim()) {
        configuredDefault = settings.model.trim();
      }
    } catch {
      // Optional settings file.
    }

    const res = await run(cli.bin, ['models'], 15_000);
    if (res.code !== 0) {
      const combined = `${res.stdout}\n${res.stderr}`;
      if (isAntigravityAuthFailure(combined)) {
        this.needsLogin = true;
        throw new Error(ANTIGRAVITY_LOGIN_REQUIRED);
      }
      throw new Error(res.stderr.trim() || res.stdout.trim() || 'Could not list Antigravity models');
    }

    const parsed: { id: string; name: string }[] = [];
    for (const rawLine of res.stdout.split('\n')) {
      const line = rawLine.trim();
      if (!line || !line.includes('\t')) continue;
      const [id, ...rest] = line.split('\t');
      const modelId = id.trim();
      const modelName = rest.join('\t').trim() || modelId;
      if (modelId) parsed.push({ id: modelId, name: modelName });
    }
    if (!parsed.length) throw new Error('No Antigravity models returned by agy');

    const defaultIndex = configuredDefault
      ? parsed.findIndex(m => m.id === configuredDefault || m.name === configuredDefault)
      : 0;
    const chosenDefault = defaultIndex >= 0 ? defaultIndex : 0;

    return parsed.map((m, idx): ModelOption => ({
      id: m.id,
      name: m.name,
      isDefault: idx === chosenDefault,
    }));
  }

  private async findTranscriptFile(sessionId: string): Promise<{ path: string; mtimeMs: number } | undefined> {
    if (!/^[0-9a-z-]{8,64}$/i.test(sessionId)) return undefined;
    const candidates: { path: string; mtimeMs: number }[] = [];
    for (const root of [this.cliHome, this.appHome]) {
      for (const file of ['transcript_full.jsonl', 'transcript.jsonl']) {
        const p = join(root, 'brain', sessionId, '.system_generated', 'logs', file);
        const st = await stat(p).catch(() => undefined);
        if (st?.isFile()) {
          candidates.push({ path: p, mtimeMs: st.mtimeMs });
          break;
        }
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0];
  }

  private async findConversationDb(sessionId: string): Promise<{ path: string; mtimeMs: number } | undefined> {
    if (!/^[0-9a-z-]{8,64}$/i.test(sessionId)) return undefined;
    const candidates: { path: string; mtimeMs: number }[] = [];
    for (const root of [this.cliHome, this.appHome]) {
      const p = join(root, 'conversations', `${sessionId}.db`);
      const st = await stat(p).catch(() => undefined);
      if (st?.isFile()) candidates.push({ path: p, mtimeMs: st.mtimeMs });
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0];
  }

  async listSessions(limit: number): Promise<SessionSummary[]> {
    const merged = new Map<string, SummaryRow>();
    for (const root of [this.appHome, this.cliHome]) {
      const dbPath = join(root, 'conversation_summaries.db');
      if (!(await exists(dbPath))) continue;
      for (const row of readSummariesDb(dbPath)) {
        const existing = merged.get(row.id);
        if (!existing) {
          merged.set(row.id, { ...row });
        } else {
          if (!existing.title && row.title) existing.title = row.title;
          if (!existing.preview && row.preview) existing.preview = row.preview;
          if (!existing.cwd && row.cwd) existing.cwd = row.cwd;
          if (!existing.parentId && row.parentId) existing.parentId = row.parentId;
          if (row.status === 'CASCADE_RUN_STATUS_RUNNING') existing.status = row.status;
          if (row.updatedAt > existing.updatedAt) existing.updatedAt = row.updatedAt;
        }
      }
    }

    for (const root of [this.appHome, this.cliHome]) {
      const ids = await readdir(join(root, 'brain')).catch(() => [] as string[]);
      for (const id of ids) {
        if (!/^[0-9a-z-]{8,64}$/i.test(id) || merged.has(id)) continue;
        merged.set(id, { id, title: '', preview: '', cwd: '', status: '', parentId: '', updatedAt: 0 });
      }
    }

    const now = Date.now();
    const summaries: SessionSummary[] = [];
    // A held lock only means the conversation is open somewhere, not that a turn is running,
    // so `running` relies on run status, our own tasks and recent writes.

    for (const row of merged.values()) {
      if (row.parentId) continue;
      const [transcript, convDb] = await Promise.all([
        this.findTranscriptFile(row.id),
        this.findConversationDb(row.id),
      ]);
      if (!transcript && !convDb) continue;

      let cwd = row.cwd;
      let firstPrompt: string | undefined;
      let lastPrompt: string | undefined;

      if (transcript) {
        const head = parseJsonLines(await readChunk(transcript.path, 256 * 1024, false).catch(() => ''));
        const tail = parseJsonLines(await readChunk(transcript.path, 128 * 1024, true).catch(() => ''));
        for (const e of [...head, ...tail]) {
          if (!cwd && typeof e?.content === 'string') {
            cwd = extractWorkspaceFromText(e.content) ?? '';
          }
          const t = antigravityUserText(e);
          if (t) {
            firstPrompt ??= t;
            lastPrompt = t;
          }
        }
      }

      const rawPreview = lastPrompt ?? (row.preview ? antigravityUserText({ type: 'USER_INPUT', content: row.preview }) ?? row.preview : undefined);
      const titleText = row.title || firstPrompt || rawPreview;
      if (!cwd && !titleText) continue;
      if (cwd) this.cwdCache.set(row.id, cwd);

      const mtimeMs = Math.max(row.updatedAt, transcript?.mtimeMs ?? 0, convDb?.mtimeMs ?? 0);
      const running =
        this.activeSessions.has(row.id) ||
        row.status === 'CASCADE_RUN_STATUS_RUNNING' ||
        (mtimeMs > 0 && now - mtimeMs < ACTIVE_WINDOW_MS);

      summaries.push({
        id: row.id,
        agent: this.kind,
        title: oneLine(titleText ?? 'Untitled task', 80),
        cwd,
        updatedAt: Math.round(mtimeMs || now),
        running,
        preview: rawPreview ? oneLine(rawPreview, 160) : undefined,
      });
    }

    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries.slice(0, limit);
  }

  async getMessages(sessionId: string, limit: number): Promise<ChatMessage[]> {
    const transcript = await this.findTranscriptFile(sessionId);
    if (!transcript) {
      const db = await this.findConversationDb(sessionId);
      if (!db) throw new Error(`Antigravity session ${sessionId} not found`);
      return [];
    }
    const messages: ChatMessage[] = [];
    for (const e of parseJsonLines(await readChunk(transcript.path, 4 * 1024 * 1024, true))) {
      const userText = antigravityUserText(e);
      const assistantText = userText ? undefined : antigravityAssistantText(e);
      const role = userText ? 'user' : assistantText ? 'assistant' : undefined;
      const text = userText ?? assistantText;
      if (!role || !text) continue;

      const ts = typeof e.created_at === 'string' ? Date.parse(e.created_at) : NaN;
      const timestamp = Number.isFinite(ts) ? ts : undefined;
      const prev = messages[messages.length - 1];
      if (role === 'assistant' && prev?.role === 'assistant') {
        prev.text += '\n\n' + text;
      } else {
        messages.push({
          id: typeof e.step_index === 'number' ? String(e.step_index) : String(messages.length),
          role,
          text,
          timestamp,
        });
      }
    }
    return messages.slice(-limit);
  }

  /**
   * Antigravity Desktop stores conversations in ~/.gemini/antigravity while `agy` reads
   * ~/.gemini/antigravity-cli. Copy the desktop session files into the CLI store before
   * resuming when the desktop copy is newer or missing in the CLI store.
   */
  private async syncSessionToCli(sessionId: string): Promise<boolean> {
    if (this.appHome === this.cliHome) return false;
    const appDb = join(this.appHome, 'conversations', `${sessionId}.db`);
    const cliDb = join(this.cliHome, 'conversations', `${sessionId}.db`);
    const [appStat, cliStat] = await Promise.all([
      stat(appDb).catch(() => undefined),
      stat(cliDb).catch(() => undefined),
    ]);
    if (!appStat?.isFile()) return false;
    if (!cliStat?.isFile() || appStat.mtimeMs > cliStat.mtimeMs) {
      await mkdir(join(this.cliHome, 'conversations'), { recursive: true });
      await copyFile(appDb, cliDb);
      const appAnnotation = join(this.appHome, 'annotations', `${sessionId}.pbtxt`);
      if (await exists(appAnnotation)) {
        await mkdir(join(this.cliHome, 'annotations'), { recursive: true });
        await copyFile(appAnnotation, join(this.cliHome, 'annotations', `${sessionId}.pbtxt`));
      }
      const appBrain = join(this.appHome, 'brain', sessionId);
      if (await exists(appBrain)) {
        await mkdir(join(this.cliHome, 'brain'), { recursive: true });
        await cp(appBrain, join(this.cliHome, 'brain', sessionId), { recursive: true, force: true });
      }
    }
    return true;
  }

  private async syncSessionBackToDesktop(sessionId: string): Promise<void> {
    if (this.appHome === this.cliHome) return;
    // Desktop keeps an open conversation in memory and would overwrite our copy.
    const lock = join(this.appHome, 'presence', `${sessionId}.lock`);
    if ((await exists(lock)) && (await (this.options.heldLocks ?? lsofHeld)([lock])).has(lock)) return;
    const cliDb = join(this.cliHome, 'conversations', `${sessionId}.db`);
    if (!(await exists(cliDb))) return;
    await mkdir(join(this.appHome, 'conversations'), { recursive: true });
    await copyFile(cliDb, join(this.appHome, 'conversations', `${sessionId}.db`)).catch(() => {});
    const cliAnnotation = join(this.cliHome, 'annotations', `${sessionId}.pbtxt`);
    if (await exists(cliAnnotation)) {
      await mkdir(join(this.appHome, 'annotations'), { recursive: true });
      await copyFile(cliAnnotation, join(this.appHome, 'annotations', `${sessionId}.pbtxt`)).catch(() => {});
    }
    const cliBrain = join(this.cliHome, 'brain', sessionId);
    if (await exists(cliBrain)) {
      await mkdir(join(this.appHome, 'brain'), { recursive: true });
      await cp(cliBrain, join(this.appHome, 'brain', sessionId), { recursive: true, force: true }).catch(() => {});
    }
  }

  async startTask(opts: StartTaskOptions, sink: TaskSink): Promise<RunningTask> {
    if (opts.fork) {
      sink.finish({ status: 'failed', error: 'Continuing in a copy is only supported for ChatGPT (Codex).' });
      return { cancel() {} };
    }

    const cli = await this.resolveCli();
    if (!cli) throw new Error('Antigravity CLI (agy) is not installed');

    let cwd = opts.cwd;
    let syncedFromDesktop = false;
    if (opts.sessionId) {
      let sessionCwd = this.cwdCache.get(opts.sessionId);
      if (!sessionCwd) {
        const sessions = await this.listSessions(200);
        sessionCwd = sessions.find(s => s.id === opts.sessionId)?.cwd;
      }
      if (!sessionCwd) {
        const transcript = await this.findTranscriptFile(opts.sessionId);
        const db = await this.findConversationDb(opts.sessionId);
        if (!transcript && !db) throw new Error(`Antigravity session ${opts.sessionId} not found`);
      }
      if (sessionCwd && (await exists(sessionCwd))) {
        cwd = sessionCwd;
      } else if (!cwd || !(await exists(cwd))) {
        cwd = HOME;
      }
      syncedFromDesktop = await this.syncSessionToCli(opts.sessionId);
    }
    if (!cwd) throw new Error('A working directory is required for a new Antigravity task');

    const args = ['--output-format', 'stream-json', ...PERMISSION_FLAGS[opts.permissionMode]];
    if (opts.sessionId) args.push('--conversation', opts.sessionId);
    if (opts.model !== undefined) args.push('--model', opts.model);
    if (opts.effort !== undefined) args.push('--effort', opts.effort);
    // Attach the prompt directly to -p=... so agy never mistakes a flag for the prompt value.
    args.push(`-p=${opts.prompt}`);

    if (opts.model !== undefined || opts.effort !== undefined) {
      sink.setModel?.(opts.model ?? 'default', opts.effort);
    }

    let currentSessionId = opts.sessionId;
    if (currentSessionId) this.activeSessions.add(currentSessionId);

    const child = spawn(cli.bin, args, {
      cwd,
      env: augmentedEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let finished = false;
    let cancelled = false;
    let sessionSeen = false;
    let lastText = '';
    let stderrTail = '';
    const stepTexts = new Map<string, string>();
    const emittedTools = new Set<number>();

    const finish: TaskSink['finish'] = outcome => {
      if (finished) return;
      finished = true;
      if (currentSessionId) this.activeSessions.delete(currentSessionId);
      sink.finish(outcome);
    };

    const recordSession = (id: unknown) => {
      if (typeof id !== 'string' || !id) return;
      currentSessionId = id;
      this.activeSessions.add(id);
      if (!sessionSeen) {
        sessionSeen = true;
        sink.setSession(id);
      }
    };

    child.stderr.on('data', d => {
      stderrTail = (stderrTail + String(d)).slice(-4000);
      if (isAntigravityAuthFailure(stderrTail)) {
        this.needsLogin = true;
      }
    });

    createInterface({ input: child.stdout }).on('line', line => {
      let msg: any;
      try {
        msg = JSON.parse(redactSecrets(line));
      } catch {
        return;
      }

      if (msg.event === 'init') {
        recordSession(msg.conversation_id);
        return;
      }

      if (msg.event === 'step_update' && msg.step_update) {
        const step = msg.step_update;
        recordSession(step.conversation_id);
        const stepIdx = typeof step.step_index === 'number' ? step.step_index : 0;
        const stepKey = String(stepIdx);

        if (step.step_type === 'agent_response') {
          if (typeof step.text_delta === 'string' && step.text_delta) {
            stepTexts.set(stepKey, (stepTexts.get(stepKey) ?? '') + step.text_delta);
            sink.delta(stepKey, step.text_delta);
          }
          if (step.state === 'DONE') {
            const full = (stepTexts.get(stepKey) ?? '').trim();
            if (full) {
              lastText = full;
              sink.emit({ kind: 'text', text: full });
            }
          }
        } else if (step.step_type === 'tool') {
          const toolName = String(step.tool_name || step.tool_info?.name || 'tool');
          const params = step.tool_info?.parameters;
          if (!emittedTools.has(stepIdx)) {
            emittedTools.add(stepIdx);
            sink.emit({ kind: 'tool', name: toolName, detail: describeAntigravityTool(params) });
          }
          if (step.state === 'DONE') {
            if (typeof step.tool_info?.output === 'string' && step.tool_info.output) {
              sink.output?.(step.tool_info.output);
            }
            if (FILE_EDIT_TOOLS.has(toolName) && params && typeof params === 'object') {
              const rawPath = (params as any).Path ?? (params as any).TargetFile ?? (params as any).file_path ?? (params as any).path;
              if (typeof rawPath === 'string' && rawPath.trim()) {
                sink.emit({
                  kind: 'file',
                  path: resolve(cwd, rawPath),
                  change: FILE_WRITE_TOOLS.has(toolName) ? 'created' : 'modified',
                });
              }
            }
          }
        }
        return;
      }

      if (msg.event === 'result' && msg.result) {
        const r = msg.result;
        recordSession(r.conversation_id);
        const denials: any[] = Array.isArray(r.denied_actions) ? r.denied_actions : [];
        let denialNote: string | undefined;
        if (denials.length) {
          const tools = [...new Set(denials.map(d => d.action || d.display_name).filter(Boolean))].join(', ');
          denialNote = `Blocked by permission mode: ${tools}`;
          sink.emit({ kind: 'status', text: denialNote });
        }

        const isError = r.status !== 'SUCCESS' || Boolean(r.error);
        if (!isError) this.needsLogin = false;

        const responseText = typeof r.response === 'string' ? r.response.trim() : '';
        if (!isError && responseText && responseText !== lastText) {
          lastText = responseText;
          sink.emit({ kind: 'text', text: responseText });
        }

        const errorText = typeof r.error === 'string' && r.error.trim() ? r.error.trim() : stderrTail.trim();
        const text = responseText || lastText || errorText || denialNote || '';
        sink.emit({ kind: 'result', text, isError });
        finish({
          status: isError ? 'failed' : 'completed',
          result: text || undefined,
          error: isError ? errorText || text || 'Antigravity task failed' : undefined,
        });
      }
    });

    child.on('error', err => finish({ status: 'failed', error: `Could not start ${cli.bin}: ${err.message}` }));
    child.on('close', async code => {
      if (syncedFromDesktop && currentSessionId) {
        await this.syncSessionBackToDesktop(currentSessionId);
      }
      if (finished) return;
      if (cancelled) {
        finish({ status: 'cancelled', result: lastText || undefined });
      } else if (isAntigravityAuthFailure(stderrTail)) {
        this.needsLogin = true;
        sink.emit({ kind: 'result', text: ANTIGRAVITY_LOGIN_REQUIRED, isError: true });
        finish({ status: 'failed', error: ANTIGRAVITY_LOGIN_REQUIRED });
      } else {
        const cleanErr = redactSecrets(stderrTail).trim();
        finish({ status: 'failed', error: `Agent exited (code ${code}) without a result.\n${cleanErr}`.trim() });
      }
    });

    return {
      cancel() {
        if (finished) return;
        cancelled = true;
        child.kill('SIGINT');
        setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 5000).unref();
      },
    };
  }
}
