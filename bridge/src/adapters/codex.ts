import { displayAttachmentPrompt } from '../attachments.ts';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { snapshotProcesses } from '../procs.ts';
import type { Adapter, AgentInfo, ChatMessage, ModelOption, PermissionMode, RunningTask, SessionSummary, StartTaskOptions, TaskSink } from '../types.ts';
import { augmentedEnv, exists, HOME, oneLine, run } from '../util.ts';

export const CODEX_LOGIN_REQUIRED = "ChatGPT (Codex CLI) isn't signed in on this Mac. Open the ChatGPT desktop app and sign in, or run `codex login` in Terminal.";

/** The ChatGPT / Codex desktop app ships its own `codex` binary here. */
const BUNDLED_CODEX_PATHS = [
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  join(HOME, 'Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'),
  '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex',
  join(HOME, 'Applications/Codex.app/Contents/Resources/codex-cli/bin/codex'),
];

export interface CodexBinary {
  bin: string;
  version: string;
}

export async function resolveCodexBinary(candidates?: string[]): Promise<CodexBinary | undefined> {
  const list = candidates ?? [
    process.env.CODEX_BIN,
    'codex',
    ...BUNDLED_CODEX_PATHS,
  ].filter((c): c is string => Boolean(c));

  for (const bin of list) {
    if (bin.includes('/') && !(await exists(bin))) continue;
    const res = await run(bin, ['--version'], 5000);
    if (res.code === 0 && res.stdout.trim()) {
      const version = res.stdout.trim().split(/\s+/).pop() ?? res.stdout.trim();
      return { bin, version };
    }
  }
  return undefined;
}

/**
 * `thread/list` always reports `forkedFromId: null` (codex-cli 0.162), but the rollout's first
 * line records `forked_from_id`. A thread's origin never changes, so each file is read once.
 */
/** The raw start of a file. The first rollout line is far longer than this (it embeds the
 * instructions), so readChunk's whole-line trimming would return nothing. */
async function headBytes(path: string, bytes = 4096): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

export class ForkOrigins {
  private cache = new Map<string, string | null>();
  private read: (path: string) => Promise<string>;
  constructor(read: (path: string) => Promise<string> = headBytes) { this.read = read; }
  async get(path: string): Promise<string | undefined> {
    if (!this.cache.has(path)) {
      let id: string | null = null;
      try {
        const head = (await this.read(path)).split('\n', 1)[0];
        id = /"forked_from_id":"([0-9a-f-]{36})"/.exec(head)?.[1] ?? null;
      } catch { /* Unreadable or missing rollouts are treated as originals. */ }
      this.cache.set(path, id);
    }
    return this.cache.get(path) ?? undefined;
  }
}

const SANDBOX: Record<PermissionMode, string> = {
  readOnly: 'read-only',
  acceptEdits: 'workspace-write',
  full: 'danger-full-access',
};

type Listener = (method: string, params: any) => void;

export interface CodexServer {
  request(method: string, params: unknown): Promise<any>;
  subscribe(listener: Listener): () => void;
  approvalPolicy: Map<string, PermissionMode>;
}

/**
 * JSON-RPC client for `codex app-server` over stdio (one JSON object per line).
 * Threads it creates or resumes are persisted to ~/.codex like any other Codex session,
 * so they show up in the Codex desktop app's history too.
 */
class CodexAppServer {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<Listener>();
  private resolveBin: () => Promise<CodexBinary | undefined>;
  /** Answers approval prompts the server sends back to us, keyed by thread id. */
  approvalPolicy = new Map<string, PermissionMode>();

  constructor(resolveBin: () => Promise<CodexBinary | undefined> = () => resolveCodexBinary()) {
    this.resolveBin = resolveBin;
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const cli = await this.resolveBin();
      const bin = cli?.bin ?? 'codex';
      const child = spawn(bin, ['app-server'], { env: augmentedEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      child.stderr.resume();
      createInterface({ input: child.stdout }).on('line', line => this.onLine(line));
      const reset = (err: Error) => {
        if (this.child !== child) return;
        this.child = undefined;
        this.ready = undefined;
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        for (const l of this.listeners) l('bridge/serverExited', { message: err.message });
      };
      child.on('error', err => reset(new Error(`Could not start codex app-server: ${err.message}`)));
      child.on('close', code => reset(new Error(`codex app-server exited (code ${code})`)));
      await this.rawRequest('initialize', {
        clientInfo: { name: 'agentanywhere', title: 'AgentTote', version: '0.1.0' },
        capabilities: null,
      });
      this.write({ method: 'initialized' });
    })();
    return this.ready;
  }

  private write(msg: object) {
    this.child?.stdin.write(JSON.stringify(msg) + '\n');
  }

  private rawRequest(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  async request(method: string, params: unknown): Promise<any> {
    await this.start();
    return this.rawRequest(method, params);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private onLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method) return this.onServerRequest(msg);
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) for (const l of this.listeners) l(msg.method, msg.params);
  }

  /** We run turns with approvalPolicy "never", so these are rare; answer by the task's permission mode. */
  private onServerRequest(msg: any) {
    const mode = this.approvalPolicy.get(msg.params?.threadId) ?? 'readOnly';
    const allow = mode === 'full' || (mode === 'acceptEdits' && msg.method === 'item/fileChange/requestApproval');
    switch (msg.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        this.write({ id: msg.id, result: { decision: allow ? 'accept' : 'decline' } });
        break;
      default:
        this.write({ id: msg.id, error: { code: -32601, message: `AgentTote cannot answer ${msg.method} remotely` } });
    }
  }
}

/** Codex wraps the user's text when files are attached; show only what they typed. */
function codexUserText(item: any): string {
  const text = (item.content ?? [])
    .filter((c: any) => c.type === 'text')
    .map((c: any) => String(c.text))
    .join('\n');
  const display = displayAttachmentPrompt(text);
  if (display !== text) return display;
  const marker = '## My request:';
  const i = text.lastIndexOf(marker);
  return (i >= 0 ? text.slice(i + marker.length) : text).trim();
}

function describeItem(item: any): { name: string; detail?: string } | undefined {
  switch (item.type) {
    case 'commandExecution':
      return { name: 'Shell', detail: oneLine(String(item.command ?? ''), 160) };
    case 'fileChange':
      return { name: 'Edit', detail: (item.changes ?? []).map((c: any) => c.path).filter(Boolean).join(', ') };
    case 'mcpToolCall':
      return { name: `${item.server}.${item.tool}` };
    case 'dynamicToolCall':
      return { name: String(item.tool) };
    case 'webSearch':
      return { name: 'WebSearch', detail: item.query ? oneLine(String(item.query)) : undefined };
    default:
      return undefined;
  }
}

/** A distinguishable title for a forked copy, e.g. "Plan · iPhone copy 10/18 08:50". */
export function copyName(original: string | null | undefined, now: Date): string {
  let base = (original ?? '').trim();
  // Strip Codex's " (2)" suffix and any copy suffixes we added previously, outermost first.
  for (;;) {
    const next = base
      .replace(/\s*·\s*iPhone copy\b[^·]*$/i, '')
      .replace(/\s*\(\d+\)$/, '')
      .trim();
    if (next === base) break;
    base = next;
  }
  if (!base) base = 'Conversation';
  const time = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const suffix = ` · iPhone copy ${time}`;
  const room = 120 - suffix.length;
  if (base.length > room) base = base.slice(0, Math.max(0, room)).trimEnd() || 'Conversation';
  return base + suffix;
}

/** Codex refuses writes when the desktop app already owns the thread. */
export function isActiveWriterError(message: string): boolean {
  return message.includes('already has an active writer');
}

const SESSION_BUSY = 'SESSION_BUSY: This conversation is open in the Codex app on your Mac.';

function sessionError(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err);
  return isActiveWriterError(message) ? new Error(SESSION_BUSY) : err;
}

export class CodexAdapter implements Adapter {
  readonly kind = 'codex' as const;
  readonly name = 'ChatGPT';
  private server: CodexServer;
  private forks: ForkOrigins;
  private resolveBin: () => Promise<CodexBinary | undefined>;
  constructor(
    server?: CodexServer,
    forks = new ForkOrigins(),
    resolveBin: () => Promise<CodexBinary | undefined> = () => resolveCodexBinary(),
  ) {
    this.resolveBin = resolveBin;
    this.server = server ?? new CodexAppServer(resolveBin);
    this.forks = forks;
  }
  /** Threads with a turn started through the bridge, so the list can mark them running. */
  private activeThreads = new Set<string>();

  async listModels(): Promise<ModelOption[]> {
    const models: ModelOption[] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await this.server.request('model/list', { ...(cursor ? { cursor } : {}), limit: 100, includeHidden: false });
      for (const model of page.data) {
        if (model.hidden) continue;
        models.push({
          id: model.id, name: model.displayName, description: model.description,
          isDefault: model.isDefault,
          efforts: model.supportedReasoningEfforts.map((effort: { reasoningEffort: string }) => effort.reasoningEffort),
          defaultEffort: model.defaultReasoningEffort,
        });
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor && cursors.has(cursor)) throw new Error('Repeated cursor in Codex model list');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return models;
  }

  async detect(): Promise<AgentInfo> {
    const [cli, procs] = await Promise.all([this.resolveBin(), snapshotProcesses()]);
    if (!cli) {
      return { kind: this.kind, name: this.name, status: 'unavailable', runningProcesses: procs.codexProcesses, detail: 'ChatGPT (Codex CLI) is not installed: install the ChatGPT desktop app or `codex` CLI' };
    }
    const login = await run(cli.bin, ['login', 'status'], 5000);
    const combined = `${login.stdout}\n${login.stderr}`;
    if (login.code !== 0 && /not logged in/i.test(combined)) {
      return { kind: this.kind, name: this.name, status: 'needsLogin', version: cli.version, runningProcesses: procs.codexProcesses, detail: CODEX_LOGIN_REQUIRED };
    }
    return { kind: this.kind, name: this.name, status: 'ready', version: cli.version, runningProcesses: procs.codexProcesses };
  }

  async listSessions(limit: number): Promise<SessionSummary[]> {
    const res = await this.server.request('thread/list', { limit, sortKey: 'updated_at', useStateDbOnly: true });
    return Promise.all((res.data ?? []).map(
      async (t: any): Promise<SessionSummary> => {
        const forkedFromId = typeof t.forkedFromId === 'string' && t.forkedFromId ? t.forkedFromId
          : typeof t.path === 'string' && t.path ? await this.forks.get(t.path) : undefined;
        return {
          id: t.id,
          agent: this.kind,
          title: oneLine(t.name || t.preview || 'Untitled thread', 80),
          cwd: t.cwd ?? '',
          updatedAt: (t.updatedAt ?? t.createdAt ?? 0) * 1000,
          running: t.status?.type === 'active' || this.activeThreads.has(t.id),
          preview: t.preview ? oneLine(t.preview, 160) : undefined,
          ...(t.originator ? { origin: t.originator === 'Codex Desktop' ? 'mac' : t.originator === 'agentanywhere' ? 'phone' : 'cli' } : {}),
          ...(forkedFromId ? { forkedFromId } : {}),
        };
      },
    ));
  }

  async getMessages(sessionId: string, limit: number): Promise<ChatMessage[]> {
    // Newest turns first; each turn becomes one user bubble and one merged assistant bubble.
    const res = await this.server.request('thread/turns/list', { threadId: sessionId, limit: Math.ceil(limit / 2), itemsView: 'full', sortDirection: 'desc' });
    const messages: ChatMessage[] = [];
    for (const turn of [...(res.data ?? [])].reverse()) {
      const ts = turn.startedAt ? turn.startedAt * 1000 : undefined;
      const replies: string[] = [];
      for (const item of turn.items ?? []) {
        if (item.type === 'userMessage') {
          const text = codexUserText(item);
          if (text) messages.push({ id: item.id, role: 'user', text, timestamp: ts });
        } else if (item.type === 'agentMessage' && item.text?.trim()) {
          replies.push(item.text.trim());
        }
      }
      if (replies.length) messages.push({ id: `${turn.id}-reply`, role: 'assistant', text: replies.join('\n\n'), timestamp: turn.completedAt ? turn.completedAt * 1000 : ts });
    }
    return messages.slice(-limit);
  }

  async startTask(opts: StartTaskOptions, sink: TaskSink): Promise<RunningTask> {
    const sandbox = SANDBOX[opts.permissionMode];
    let threadId: string;
    let cwd = opts.cwd ?? '';
    let threadModel: string | undefined;
    let threadEffort: string | undefined;
    if (opts.sessionId) {
      let res: any;
      try {
        res = await this.server.request(opts.fork ? 'thread/fork' : 'thread/resume', {
          threadId: opts.sessionId, approvalPolicy: 'never', sandbox, excludeTurns: true,
          ...(opts.fork && opts.model !== undefined ? { model: opts.model } : {}),
        });
      } catch (err) {
        throw sessionError(err);
      }
      threadId = res.thread?.id ?? opts.sessionId;
      cwd = res.thread?.cwd ?? cwd;
      threadModel = res.model;
      threadEffort = res.reasoningEffort ?? undefined;
      if (opts.fork && res.thread?.id) {
        // Renaming must never delay or fail the task, so fire it and ignore the result.
        const name = copyName(res.thread.name ?? null, new Date());
        void this.server.request('thread/name/set', { threadId: res.thread.id, name }).catch(() => {});
      }
    } else {
      if (!opts.cwd) throw new Error('A working directory is required for a new ChatGPT thread');
      const res = await this.server.request('thread/start', { cwd: opts.cwd, approvalPolicy: 'never', sandbox,
        ...(opts.model !== undefined ? { model: opts.model } : {}) });
      threadId = res.thread.id;
      cwd = res.thread?.cwd ?? cwd;
      threadModel = res.model;
      threadEffort = res.reasoningEffort ?? undefined;
    }
    sink.setSession(threadId);
    this.server.approvalPolicy.set(threadId, opts.permissionMode);

    let turnId: string | undefined;
    let lastText = '';
    let done = false;
    const finish: TaskSink['finish'] = outcome => {
      if (done) return;
      done = true;
      unsubscribe();
      this.activeThreads.delete(threadId);
      sink.finish(outcome);
    };

    const unsubscribe = this.server.subscribe((method, params) => {
      if (method === 'bridge/serverExited') return finish({ status: 'failed', error: params.message });
      if (params?.threadId !== threadId) return;
      if (turnId && params.turnId && params.turnId !== turnId) return;
      switch (method) {
        case 'item/agentMessage/delta':
          codexTextDelta(params, sink);
          break;
        case 'item/started': {
          const tool = describeItem(params.item);
          if (tool) sink.emit({ kind: 'tool', ...tool });
          break;
        }
        case 'item/commandExecution/outputDelta':
          if (typeof params.delta === 'string') sink.output?.(params.delta);
          break;
        case 'item/completed':
          codexFileEvents(params.item, cwd, sink);
          if (typeof params.item?.aggregatedOutput === 'string') sink.output?.(params.item.aggregatedOutput);
          if (params.item?.type === 'agentMessage' && params.item.text?.trim()) {
            lastText = params.item.text;
            sink.emit({ kind: 'text', text: params.item.text });
          } else if (params.item?.type === 'reasoning') {
            // Short headlines like "**Checking the build config**" show progress during long turns.
            const headline = (params.item.summary ?? []).map((s: string) => s.replace(/\*\*/g, '').trim()).find(Boolean);
            if (headline) sink.emit({ kind: 'status', text: oneLine(headline, 120) });
          }
          break;
        case 'thread/compacted':
          sink.emit({ kind: 'status', text: 'Context compacted' });
          break;
        case 'turn/completed': {
          const turn = params.turn ?? {};
          if (turnId && turn.id && turn.id !== turnId) return;
          if (turn.status === 'completed') {
            sink.emit({ kind: 'result', text: lastText, isError: false });
            finish({ status: 'completed', result: lastText });
          } else if (turn.status === 'interrupted') {
            finish({ status: 'cancelled', result: lastText || undefined });
          } else {
            const error = turn.error?.message ?? `Turn ${turn.status ?? 'failed'}`;
            sink.emit({ kind: 'result', text: error, isError: true });
            finish({ status: 'failed', error });
          }
          break;
        }
      }
    });

    try {
      const images = (opts.attachments ?? []).filter(file => file.isImage).map(file => ({ type: 'localImage', path: file.path }));
      const res = await this.server.request('turn/start', { threadId, input: [{ type: 'text', text: opts.prompt, text_elements: [] }, ...images],
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.effort !== undefined ? { effort: opts.effort } : {}) });
      turnId = res.turn?.id;
      const model = opts.model ?? threadModel;
      if (model) sink.setModel?.(model, opts.effort ?? (model === threadModel ? threadEffort : undefined));
      this.activeThreads.add(threadId);
    } catch (err) {
      unsubscribe();
      throw sessionError(err);
    }

    return {
      cancel: () => {
        if (done || !turnId) return;
        this.server.request('turn/interrupt', { threadId, turnId }).catch(err => finish({ status: 'cancelled', error: String(err.message ?? err) }));
      },
    };
  }
}

/** Fields verified with `codex app-server generate-ts`: v2/AgentMessageDeltaNotification. */
export function codexTextDelta(params: any, sink: Pick<TaskSink, 'delta'>): void {
  if (typeof params?.itemId === 'string' && typeof params?.delta === 'string') {
    sink.delta(params.itemId, params.delta);
  }
}

/** Verified against generated v2/ThreadItem, FileUpdateChange and PatchChangeKind. */
export function codexFileEvents(item: any, cwd: string, sink: Pick<TaskSink, 'emit'>) {
  if (item?.type !== 'fileChange' || item.status !== 'completed' || !Array.isArray(item.changes)) return;
  for (const entry of item.changes) {
    if (typeof entry.path !== 'string' || !entry.path || !['add', 'update', 'delete'].includes(entry.kind?.type)) continue;
    if (!cwd && !entry.path.startsWith('/')) continue;
    const path = resolve(cwd, entry.path);
    const moved = entry.kind.type === 'update' && typeof entry.kind.move_path === 'string' && entry.kind.move_path;
    if (moved) {
      sink.emit({ kind: 'file', path, change: 'deleted' });
      sink.emit({ kind: 'file', path: resolve(cwd, moved), change: 'created' });
    } else sink.emit({ kind: 'file', path, change: entry.kind.type === 'add' ? 'created' : entry.kind.type === 'delete' ? 'deleted' : 'modified' });
  }
}
