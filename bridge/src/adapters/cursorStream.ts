import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { redactSecrets } from '../secrets.ts';
import type { RunningTask, TaskSink } from '../types.ts';
import { describeToolInput, oneLine } from '../util.ts';
import { describeError, isCursorSessionId, isRecord } from './cursorSessions.ts';

const TOOL_METADATA = new Set(['hookAdditionalContexts', 'toolCallId', 'startedAtMs', 'completedAtMs']);
const FILE_TOOLS: Record<string, 'created' | 'modified'> = { writeToolCall: 'created', editToolCall: 'modified' };
const DEFAULT_KILL_GRACE_MS = 5000;
const running = new Set<CursorRun>();

// The bridge explicitly exits during shutdown, before asynchronous cancellation timers can run.
process.once('exit', () => {
  for (const task of running) task.stopOnExit();
});

export interface CursorRunSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Resume target: any other id reported by the CLI is a conflict. */
  sessionId?: string;
  killGraceMs?: number;
  /** Returns an error message when the reported session cannot be used (for example it is already running). */
  claimSession(id: string): string | undefined;
  /** Runs after a successful result and a clean exit; completion waits for it. */
  persist(done: { sessionId: string; text: string }): Promise<void>;
  /** Called exactly once when the task is over, whatever the outcome. */
  release(): void;
}

function assistantText(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.content)) return '';
  return message.content
    .filter(isRecord)
    .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('');
}

function toolDisplayName(key: string | undefined): string {
  if (!key) return 'tool';
  return key.endsWith('ToolCall') && key.length > 'ToolCall'.length ? key.slice(0, -'ToolCall'.length) : key;
}

function nestedMessage(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!isRecord(value)) return undefined;
  for (const key of ['message', 'reason', 'error', 'errorMessage']) {
    const text = value[key];
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return undefined;
}

/** Why a completed tool call is not a success; never guesses success from missing fields. */
function toolFailureReason(result: Record<string, unknown> | undefined): string {
  if (!result) return 'Cursor reported no result';
  for (const [key, value] of Object.entries(result)) {
    if (key === 'success') continue;
    const message = nestedMessage(value);
    return message ? `${key}: ${oneLine(message, 200)}` : `Cursor reported ${key}`;
  }
  return 'Cursor reported an empty result';
}

/**
 * Runs `cursor-agent --print --output-format stream-json --stream-partial-output` and maps its
 * dialect (init / assistant deltas / tool_call / result) to task events. Completion requires a
 * single successful result, a clean exit and successful persistence; finish fires at most once.
 */
class CursorRun implements RunningTask {
  private readonly spec: CursorRunSpec;
  private readonly sink: TaskSink;
  private readonly child: ChildProcessByStdio<null, Readable, Readable>;
  private finished = false;
  private closed = false;
  private cancelled = false;
  private failure?: string;
  private sessionId?: string;
  private result?: string;
  private terminals = 0;
  private segment = '';
  private segmentId = randomUUID();
  private emittedText = false;
  private readonly startedTools = new Set<string>();
  private stderrTail = '';
  private killTimer?: NodeJS.Timeout;

  constructor(spec: CursorRunSpec, sink: TaskSink) {
    this.spec = spec;
    this.sink = sink;
    this.child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    running.add(this);
    this.child.stderr.on('data', chunk => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-4000);
    });
    createInterface({ input: this.child.stdout }).on('line', line => this.handleLine(line));
    this.child.on('error', error => this.onSpawnError(error));
    this.child.on('close', (code, signal) => {
      this.onClose(code, signal).catch(error => this.end({ status: 'failed', error: describeError(error) }));
    });
  }

  cancel(): void {
    if (this.finished || this.closed) return;
    this.cancelled = true;
    this.terminate();
  }

  stopOnExit(): void {
    this.signal('SIGKILL');
  }

  private signal(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined || this.closed) return;
    try {
      // The child leads its own process group, so descendants stop with it and nothing else does.
      process.kill(process.platform === 'win32' ? pid : -pid, signal);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) this.child.kill(signal);
    }
  }

  private terminate(): void {
    if (this.closed || this.killTimer) return;
    this.signal('SIGTERM');
    this.killTimer = setTimeout(() => this.signal('SIGKILL'), this.spec.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    this.killTimer.unref();
  }

  private fail(message: string): void {
    this.failure ??= message;
    this.terminate();
  }

  private end(outcome: Parameters<TaskSink['finish']>[0]): void {
    if (this.finished) return;
    this.finished = true;
    this.spec.release();
    if (outcome.status !== 'cancelled') {
      const text = outcome.status === 'failed' ? outcome.error ?? 'Cursor task failed' : outcome.result ?? '';
      this.sink.emit({ kind: 'result', text, isError: outcome.status === 'failed' });
    }
    this.sink.finish(outcome);
  }

  private onSpawnError(error: Error): void {
    running.delete(this);
    this.closed = true;
    clearTimeout(this.killTimer);
    this.end({ status: 'failed', error: `Could not start ${this.spec.command}: ${error.message}` });
  }

  private async onClose(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    // A cancelled group may still contain children after its leader has closed its stdio.
    if (this.cancelled || this.failure) this.signal('SIGKILL');
    running.delete(this);
    this.closed = true;
    clearTimeout(this.killTimer);
    if (this.finished) return;
    if (this.cancelled) return this.end({ status: 'cancelled' });
    if (this.failure) return this.end({ status: 'failed', error: this.failure });
    if (code !== 0) {
      const detail = redactSecrets(this.stderrTail).trim();
      const how = code === null ? `signal ${signal}` : `code ${code}`;
      return this.end({ status: 'failed', error: `Cursor exited with ${how}.${detail ? `\n${detail}` : ''}` });
    }
    if (this.result === undefined || this.sessionId === undefined) {
      return this.end({ status: 'failed', error: 'Cursor exited without a final result.' });
    }
    await this.complete(this.sessionId, this.result);
  }

  private async complete(sessionId: string, text: string): Promise<void> {
    this.flushSegment(text);
    try {
      await this.spec.persist({ sessionId, text });
    } catch (error) {
      return this.end({ status: 'failed', error: `Could not save the Cursor session: ${redactSecrets(describeError(error))}` });
    }
    this.end({ status: 'completed', result: text });
  }

  private handleLine(line: string): void {
    if (this.finished || this.failure || this.cancelled || !line.trim()) return;
    let msg: unknown;
    try {
      // Canonicalise escapes first so escaped secrets cannot slip past redaction.
      msg = JSON.parse(redactSecrets(JSON.stringify(JSON.parse(line))));
    } catch {
      return this.fail('Cursor produced a malformed stream-json line.');
    }
    if (!isRecord(msg) || typeof msg.type !== 'string') return this.fail('Cursor produced an unrecognised stream event.');
    this.handleEvent(msg, msg.type);
  }

  private handleEvent(msg: Record<string, unknown>, type: string): void {
    if (type === 'system' && msg.subtype === 'init') this.handleInit(msg);
    else if (type === 'assistant') this.handleAssistant(msg);
    else if (type === 'tool_call') this.handleTool(msg);
    else if (type === 'result') this.handleResult(msg);
  }

  private adoptSession(value: unknown): boolean {
    if (!isCursorSessionId(value)) {
      this.fail('Cursor reported an invalid session id.');
      return false;
    }
    const id = value.toLowerCase();
    if ((this.spec.sessionId && id !== this.spec.sessionId) || (this.sessionId && id !== this.sessionId)) {
      this.fail('Cursor reported a conflicting session id.');
      return false;
    }
    if (this.sessionId) return true;
    const problem = this.spec.claimSession(id);
    if (problem) {
      this.fail(problem);
      return false;
    }
    this.sessionId = id;
    this.sink.setSession(id);
    return true;
  }

  private handleInit(msg: Record<string, unknown>): void {
    if (!this.adoptSession(msg.session_id)) return;
    if (typeof msg.model === 'string' && msg.model) this.sink.setModel?.(msg.model);
  }

  /** With partial output only timestamped messages without model_call_id are new; the rest repeat earlier text. */
  private handleAssistant(msg: Record<string, unknown>): void {
    const isNewDelta = typeof msg.timestamp_ms === 'number' && msg.model_call_id === undefined;
    const text = assistantText(msg.message);
    if (!isNewDelta || !text) return;
    this.segment += text;
    this.sink.delta(this.segmentId, text);
  }

  private flushSegment(finalText?: string): void {
    const text = this.segment.trim();
    this.segment = '';
    this.segmentId = randomUUID();
    const shown = text || (this.emittedText ? '' : finalText?.trim() ?? '');
    if (!shown) return;
    this.emittedText = true;
    this.sink.emit({ kind: 'text', text: shown });
  }

  private handleTool(msg: Record<string, unknown>): void {
    const { subtype, call_id: callId, tool_call: call } = msg;
    if (subtype !== 'started' && subtype !== 'completed') return;
    if (typeof callId !== 'string' || !callId || !isRecord(call)) return this.fail('Cursor produced a malformed tool_call event.');
    const key = Object.keys(call).find(k => !TOOL_METADATA.has(k));
    const raw = key ? call[key] : undefined;
    const body = isRecord(raw) ? raw : {};
    const name = toolDisplayName(key);
    if (!this.startedTools.has(callId)) {
      this.startedTools.add(callId);
      this.flushSegment();
      this.sink.emit({ kind: 'tool', name, detail: describeToolInput(body.args) });
    }
    if (subtype === 'completed') this.reportToolResult(key, name, body);
  }

  private reportToolResult(key: string | undefined, name: string, body: Record<string, unknown>): void {
    const result = isRecord(body.result) ? body.result : undefined;
    if (!result || !isRecord(result.success)) {
      this.sink.emit({ kind: 'status', text: `${name} failed: ${toolFailureReason(result)}` });
      return;
    }
    const change = key ? FILE_TOOLS[key] : undefined;
    const path = isRecord(body.args) ? body.args.path : undefined;
    if (change && typeof path === 'string' && path.trim()) {
      this.sink.emit({ kind: 'file', path: resolve(this.spec.cwd, path), change });
    }
  }

  private handleResult(msg: Record<string, unknown>): void {
    this.terminals += 1;
    if (this.terminals > 1) return this.fail('Cursor reported more than one final result.');
    if ((msg.session_id !== undefined || !this.sessionId) && !this.adoptSession(msg.session_id)) return;
    if (msg.subtype !== 'success' || msg.is_error !== false || typeof msg.result !== 'string') {
      const detail = typeof msg.result === 'string' && msg.result ? msg.result : String(msg.subtype ?? 'error');
      return this.fail(`Cursor reported an error: ${oneLine(detail, 300)}`);
    }
    this.result = msg.result;
  }
}

export function runCursorStream(spec: CursorRunSpec, sink: TaskSink): RunningTask {
  return new CursorRun(spec, sink);
}
