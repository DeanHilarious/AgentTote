import { attachmentPrompts } from './attachments.ts';
import { randomUUID } from 'node:crypto';
import type { Adapter, AgentKind, PushMessage, RunningTask, StartTaskOptions, TaskEvent, TaskEventBody, TaskInfo, TaskDraft } from './types.ts';

const MAX_TASKS = 200;
const MAX_EVENTS_PER_TASK = 2000;

interface TaskRecord {
  info: TaskInfo;
  watchers: Set<string>;
  events: TaskEvent[];
  handle?: RunningTask;
  cancelRequested: boolean;
  draft?: TaskDraft;
  pendingText: string;
  pendingOffset: number;
  deltaTimer?: ReturnType<typeof setTimeout>;
  lastDeltaAt: number;
  flushDraft?: () => void;
}

/**
 * Owns every task started from the phone. Tasks keep running when the phone disconnects;
 * the event log lets a reconnecting phone catch up with `tasks.get { sinceSeq }`.
 */
export class TaskManager {
  private tasks = new Map<string, TaskRecord>();
  private adapters: Map<AgentKind, Adapter>;
  private broadcast: (msg: PushMessage) => void;
  private output: (taskId: string, text: string) => void;
  private notify: (task: TaskInfo, installationId: string) => Promise<void>;

  constructor(adapters: Adapter[], broadcast: (msg: PushMessage) => void,
    notify: (task: TaskInfo, installationId: string) => Promise<void> = async () => {},
    privateOutput: (taskId: string, text: string) => void = () => {}) {
    this.output = privateOutput;
    this.adapters = new Map(adapters.map(a => [a.kind, a]));
    this.broadcast = broadcast;
    this.notify = notify;
  }

  adapter(kind: AgentKind): Adapter {
    const a = this.adapters.get(kind);
    if (!a) throw new Error(`Unknown agent "${kind}"`);
    return a;
  }

  allAdapters(): Adapter[] {
    return [...this.adapters.values()];
  }

  agentOf(taskId: string): AgentKind | undefined {
    return this.tasks.get(taskId)?.info.agent;
  }

  list(installationId?: string): TaskInfo[] {
    return [...this.tasks.values()].map(t => this.view(t, installationId)).sort((a, b) => b.startedAt - a.startedAt);
  }

  get(taskId: string, sinceSeq = 0, installationId?: string): { task: TaskInfo; events: TaskEvent[]; draft?: TaskDraft } {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error(`Unknown task ${taskId}`);
    return { task: this.view(t, installationId), events: t.events.filter(e => e.seq > sinceSeq), ...(t.draft ? { draft: { ...t.draft } } : {}) };
  }

  /** Establish a draft boundary before replying: a pending batch must precede the
   * snapshot on the ordered transport, otherwise its offset overlaps the snapshot. */
  async snapshot(taskId: string, sinceSeq = 0, installationId?: string): Promise<ReturnType<TaskManager['get']>> {
    const rec = this.tasks.get(taskId);
    if (!rec) throw new Error(`Unknown task ${taskId}`);
    while (rec.pendingText) {
      const remaining = Math.max(0, 50 - (Date.now() - rec.lastDeltaAt));
      if (remaining) await new Promise<void>(resolve => setTimeout(resolve, remaining));
      else rec.flushDraft?.();
    }
    return this.get(taskId, sinceSeq, installationId);
  }

  /** Ids of sessions with a task in flight, so session lists can show them as running. */
  runningSessionIds(agent: AgentKind): Set<string> {
    const ids = new Set<string>();
    for (const t of this.tasks.values()) if (t.info.agent === agent && t.info.status === 'running' && t.info.sessionId) ids.add(t.info.sessionId);
    return ids;
  }

  async start(agent: AgentKind, opts: StartTaskOptions, installationId?: string): Promise<TaskInfo> {
    const adapter = this.adapter(agent);
    if (opts.sessionId) {
      for (const t of this.tasks.values()) {
        if (t.info.agent === agent && t.info.sessionId === opts.sessionId && t.info.status === 'running') {
          throw new Error('A task is already running in this session; wait for it or cancel it first.');
        }
      }
    }
    const prompt = attachmentPrompts(opts.prompt, opts.attachments);
    const rec: TaskRecord = {
      info: {
        id: randomUUID(),
        agent,
        sessionId: opts.sessionId,
        cwd: opts.cwd ?? '',
        prompt: prompt.display,
        permissionMode: opts.permissionMode,
        model: opts.model,
        effort: opts.effort,
        status: 'running',
        startedAt: Date.now(),
      },
      watchers: new Set(installationId ? [installationId] : []),
      events: [],
      cancelRequested: false,
      pendingText: '', pendingOffset: 0, lastDeltaAt: -Infinity,
    };
    this.tasks.set(rec.info.id, rec);
    this.prune();

    let seq = 0;
    let outputTail = '';
    const previewLinks = new Set<string>();
    const clearDraft = () => {
      clearTimeout(rec.deltaTimer);
      rec.deltaTimer = undefined;
      rec.draft = undefined;
      rec.pendingText = '';
    };
    const flush = () => {
      clearTimeout(rec.deltaTimer);
      rec.deltaTimer = undefined;
      if (!rec.draft || !rec.pendingText || rec.info.status !== 'running') return;
      this.broadcast({ event: 'task.delta', data: {
        taskId: rec.info.id, messageId: rec.draft.messageId,
        text: rec.pendingText, offset: rec.pendingOffset,
      } });
      rec.pendingText = '';
      rec.lastDeltaAt = Date.now();
    };
    rec.flushDraft = flush;
    const delta = (messageId: string, text: string) => {
      if (!text || rec.info.status !== 'running') return;
      this.output(rec.info.id, text);
      if (rec.draft?.messageId !== messageId) {
        clearDraft();
        rec.draft = { messageId, text: '' };
      }
      if (!rec.pendingText) rec.pendingOffset = rec.draft.text.length;
      rec.draft.text += text;
      rec.pendingText += text;
      const remaining = Math.max(0, 50 - (Date.now() - rec.lastDeltaAt));
      if (Buffer.byteLength(rec.pendingText, 'utf8') >= 2048 && remaining === 0) flush();
      else if (!rec.deltaTimer) rec.deltaTimer = setTimeout(flush, Math.max(remaining, 50));
    };
    const emit = (body: TaskEventBody) => {
      if (rec.info.status !== 'running') return;
      if ('text' in body) this.output(rec.info.id, body.text);
      if (body.kind === 'text') clearDraft();
      if (body.kind === 'file') rec.events = rec.events.filter(e => e.kind !== 'file' || e.path !== body.path);
      const event = { ...body, seq: ++seq, ts: Date.now() } as TaskEvent;
      rec.events.push(event);
      if (rec.events.length > MAX_EVENTS_PER_TASK) rec.events.splice(0, rec.events.length - MAX_EVENTS_PER_TASK);
      this.broadcast({ event: 'task.event', data: { taskId: rec.info.id, event } });
    };

    try {
      rec.handle = await adapter.startTask({ ...opts, prompt: prompt.agent }, {
        emit,
        output: text => {
          this.output(rec.info.id, text);
          const output = outputTail + text;
          outputTail = output.slice(-128);
          for (const match of output.matchAll(/http:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})(?:\/[^\s<>"')\]]*)?/g)) {
            const url = match[0], port = Number(match[1]);
            if (port < 1024 || port > 65535 || previewLinks.has(match[1]!)) continue;
            previewLinks.add(match[1]!);
            emit({ kind: 'status', text: `Web preview: ${url}` });
          }
        },
        delta,
        setModel: (model, effort) => {
          if (rec.info.status !== 'running') return;
          rec.info.model = model;
          rec.info.effort = effort;
          this.broadcast({ event: 'task.updated', data: rec.info });
        },
        setSession: sessionId => {
          if (rec.info.sessionId === sessionId) return;
          rec.info.sessionId = sessionId;
          emit({ kind: 'session', sessionId });
          this.broadcast({ event: 'task.updated', data: rec.info });
        },
        finish: outcome => {
          if (rec.info.status !== 'running') return;
          clearDraft();
          Object.assign(rec.info, outcome, { endedAt: Date.now() });
          if (rec.cancelRequested && outcome.status === 'failed') rec.info.status = 'cancelled';
          this.broadcast({ event: 'task.updated', data: rec.info });
          this.notifyWatchers(rec);
        },
      });
      if (rec.cancelRequested) rec.handle.cancel();
    } catch (err) {
      clearDraft();
      if (rec.info.status === 'running') {
        Object.assign(rec.info, { status: rec.cancelRequested ? 'cancelled' : 'failed', error: (err as Error).message, endedAt: Date.now() });
        this.notifyWatchers(rec);
      }
    }
    this.broadcast({ event: 'task.updated', data: rec.info });
    return this.view(rec, installationId);
  }

  cancel(taskId: string): TaskInfo {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error(`Unknown task ${taskId}`);
    if (t.info.status === 'running') {
      t.cancelRequested = true;
      t.handle?.cancel();
    }
    return t.info;
  }

  private view(rec: TaskRecord, installationId?: string): TaskInfo {
    return { ...rec.info, ...(installationId ? { watching: rec.watchers.has(installationId) } : {}) };
  }

  watch(taskId: string, installationId: string, watch: boolean) {
    const rec = this.tasks.get(taskId);
    if (!rec) throw new Error(`Unknown task ${taskId}`);
    if (!watch) rec.watchers.delete(installationId);
    else if (rec.info.status === 'running') rec.watchers.add(installationId);
    return { taskId, watching: rec.watchers.has(installationId), status: rec.info.status };
  }

  private notifyWatchers(rec: TaskRecord) {
    const watchers = [...rec.watchers];
    rec.watchers.clear();
    for (const id of watchers) void this.notify({ ...rec.info }, id).catch(() => {});
  }

  private prune() {
    if (this.tasks.size <= MAX_TASKS) return;
    for (const [id, t] of this.tasks) {
      if (this.tasks.size <= MAX_TASKS) break;
      if (t.info.status !== 'running') this.tasks.delete(id);
    }
  }
}
