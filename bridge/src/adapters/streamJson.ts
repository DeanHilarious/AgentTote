import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { RunningTask, TaskSink } from '../types.ts';
import { describeToolInput } from '../util.ts';

export interface StreamJsonSpawn {
  command: string;
  retryWithoutPartialMessages?: boolean;
  reportApiRetries?: boolean;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Lets an adapter recognise agent-specific failures, e.g. WorkBuddy's login prompt. */
  onResult?: (result: any) => void;
  /** Parsed, sanitized events for agent-specific execution metadata. */
  onMessage?: (message: any) => void;
  /** Inspect raw output before parsing; return a safe terminal error to stop the task. */
  onOutput?: (output: string) => string | undefined;
  sanitizeOutput?: (output: string) => string;
}

/**
 * Runs a CLI that speaks Claude Code's `--output-format stream-json` dialect
 * (Claude Code itself, and WorkBuddy's bundled CodeBuddy engine) and translates
 * its events into task events.
 */
export function runStreamJson(spec: StreamJsonSpawn, sink: TaskSink): RunningTask {
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let finished = false;
  let cancelled = false;
  let lastText = '';
  let stderrTail = '';
  let sessionSeen = false;
  let apiRetryReported = false;
  const reportApiRetry = () => {
    if (!spec.reportApiRetries || apiRetryReported || finished) return;
    apiRetryReported = true;
    sink.emit({ kind: 'status', text: "Claude Code can't reach its API — retrying…" });
  };
  const partial = streamTextDeltas(sink);

  const finish: TaskSink['finish'] = outcome => {
    if (finished) return;
    finished = true;
    sink.finish(outcome);
  };

  child.stderr.on('data', d => {
    stderrTail = (stderrTail + String(d)).slice(-4000);
    if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND/.test(stderrTail)) reportApiRetry();
    checkOutput(stderrTail);
  });

  const checkOutput = (output: string): boolean => {
    if (finished) return true;
    const error = spec.onOutput?.(output);
    if (!error) return false;
    sink.emit({ kind: 'result', text: error, isError: true });
    finish({ status: 'failed', error });
    child.kill('SIGKILL');
    return true;
  };

  createInterface({ input: child.stdout }).on('line', line => {
    if (checkOutput(line)) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
      // Canonicalise JSON escapes first, so escaped slashes/Unicode cannot bypass redaction.
      if (spec.sanitizeOutput) msg = JSON.parse(spec.sanitizeOutput(JSON.stringify(msg)));
    } catch {
      return;
    }
    spec.onMessage?.(msg);
    if (msg.type === 'user') {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'tool_result') sink.output?.(typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''));
      }
    }
    if (typeof msg.session_id === 'string' && !sessionSeen) {
      sessionSeen = true;
      sink.setSession(msg.session_id);
    }
    partial(msg);
    switch (msg.type) {
      case 'assistant': {
        if (msg.parent_tool_use_id) break; // Sub-agent chatter; the parent's tool call already shows up.
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'text' && block.text?.trim()) {
            lastText = block.text;
            sink.emit({ kind: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            sink.emit({ kind: 'tool', name: block.name, detail: describeToolInput(block.input) });
            streamFileEvent(block, spec.cwd, sink);
          }
        }
        break;
      }
      case 'system':
        if (msg.subtype === 'api_retry') reportApiRetry();
        if (msg.subtype === 'compact_boundary') sink.emit({ kind: 'status', text: 'Context compacted' });
        break;
      case 'result': {
        spec.onResult?.(msg);
        const isError = Boolean(msg.is_error) || msg.subtype !== 'success';
        const errors: string[] = Array.isArray(msg.errors) ? msg.errors : [];
        const text = typeof msg.result === 'string' && msg.result ? msg.result : errors.join('\n') || lastText;
        const denials: any[] = Array.isArray(msg.permission_denials) ? msg.permission_denials : [];
        if (denials.length) {
          const tools = [...new Set(denials.map(d => d.tool_name).filter(Boolean))].join(', ');
          sink.emit({ kind: 'status', text: `Blocked by permission mode: ${tools}` });
        }
        sink.emit({ kind: 'result', text, isError });
        finish({
          status: isError ? 'failed' : 'completed',
          result: text,
          error: isError ? errors.join('\n') || text || msg.subtype : undefined,
          costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
        });
        break;
      }
    }
  });

  child.on('error', err => finish({ status: 'failed', error: `Could not start ${spec.command}: ${err.message}` }));
  child.on('close', code => {
    if (!finished && !cancelled && !sessionSeen && spec.retryWithoutPartialMessages
        && /(?:unknown|unrecognized|unexpected|unsupported|invalid)[^\n]*include-partial-messages/i.test(stderrTail)) {
      console.error('Agent CLI does not support --include-partial-messages; retrying without streaming');
      replacement = runStreamJson({ ...spec, args: spec.args.filter(a => a !== '--include-partial-messages'), retryWithoutPartialMessages: false }, sink);
      return;
    }
    if (cancelled) finish({ status: 'cancelled', result: lastText || undefined });
    else finish({ status: 'failed', error: `Agent exited (code ${code}) without a result.\n${(spec.sanitizeOutput?.(stderrTail) ?? stderrTail).trim()}`.trim() });
  });

  let replacement: RunningTask | undefined;
  return {
    cancel() {
      if (replacement) return replacement.cancel();
      if (finished) return;
      cancelled = true;
      child.kill('SIGINT');
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 5000).unref();
    },
  };
}

/** Only parent assistant text enters the transient draft channel. */
export function streamTextDeltas(sink: Pick<TaskSink, 'delta'>): (msg: any) => void {
  let messageId: string | undefined;
  return msg => {
    if (msg.type !== 'stream_event' || msg.parent_tool_use_id) return;
    const event = msg.event;
    if (event?.type === 'message_start') {
      messageId = typeof event.message?.id === 'string' ? event.message.id : randomUUID();
    } else if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta'
        && typeof event.delta.text === 'string' && messageId) {
      sink.delta(messageId, event.delta.text);
    }
  };
}

/** Claude Code and WorkBuddy's CodeBuddy both emit assistant.message.content tool_use blocks. */
export function streamFileEvent(block: any, cwd: string, sink: Pick<TaskSink, 'emit'>) {
  if (block?.type !== 'tool_use' || !['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(block.name)) return;
  const path = block.input?.file_path;
  if (typeof path !== 'string' || !path.trim()) return;
  sink.emit({ kind: 'file', path: resolve(cwd, path), change: block.name === 'Write' ? 'created' : 'modified' });
}
