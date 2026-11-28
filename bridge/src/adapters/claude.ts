import { attachmentDirectories } from '../attachments.ts';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { snapshotProcesses } from '../procs.ts';
import type { Adapter, AgentInfo, ChatMessage, PermissionMode, RunningTask, SessionSummary, StartTaskOptions, TaskSink } from '../types.ts';
import { ACTIVE_WINDOW_MS, augmentedEnv, exists, HOME, listProjectJsonl, oneLine, parseJsonLines, readChunk, run } from '../util.ts';
import { runStreamJson } from './streamJson.ts';
import { ClaudeCredentials, CLAUDE_LOGIN_REQUIRED } from './claudeCredentials.ts';
import { ClaudeApiProxy } from './claudeProxy.ts';

const PROJECTS = join(HOME, '.claude', 'projects');

const PERMISSION_FLAGS: Record<PermissionMode, string> = {
  readOnly: 'plan',
  acceptEdits: 'acceptEdits',
  full: 'bypassPermissions',
};

/** Human-typed text of a transcript `user` entry, or undefined for tool results, reminders and commands. */
export function claudeUserText(entry: any): string | undefined {
  if (entry.type !== 'user' || entry.isSidechain || entry.isMeta) return undefined;
  const content = entry.message?.content;
  const parts: string[] =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content.filter((b: any) => b.type === 'text').map((b: any) => String(b.text))
        : [];
  const text = parts.filter(p => !p.trimStart().startsWith('<')).join('\n').trim();
  return text || undefined;
}

export function claudeAssistantText(entry: any): string | undefined {
  if (entry.type !== 'assistant' || entry.isSidechain) return undefined;
  const content = entry.message?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => String(b.text))
    .join('\n')
    .trim();
  return text || undefined;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** The Claude desktop app keeps its own up-to-date copy of Claude Code here. */
async function desktopBundledClaude(): Promise<{ bin: string; version: string } | undefined> {
  const root = join(HOME, 'Library/Application Support/Claude/claude-code');
  const versions = (await readdir(root).catch(() => [] as string[])).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort(compareVersions).reverse();
  for (const version of versions) {
    for (const build of await readdir(join(root, version)).catch(() => [] as string[])) {
      const bin = join(root, version, build, 'claude.app/Contents/MacOS/claude');
      if (await exists(bin)) return { bin, version };
    }
  }
  return undefined;
}

export class ClaudeAdapter implements Adapter {
  readonly kind = 'claude' as const;
  readonly name = 'Claude Code';
  private cwdCache = new Map<string, string>();
  private resolved?: Promise<{ bin: string; version: string } | undefined>;
  private proxy: ClaudeApiProxy;
  private credentials: ClaudeCredentials;

  constructor(proxy = new ClaudeApiProxy(), credentials = new ClaudeCredentials()) {
    this.proxy = proxy;
    this.credentials = credentials;
  }

  /**
   * Picks the newest Claude Code available: `CLAUDE_BIN`, the `claude` on PATH, or the copy
   * bundled with the desktop app. Resuming a session written by a newer CLI with an older one can fail.
   */
  private resolveBinary() {
    this.resolved ??= (async () => {
      if (process.env.CLAUDE_BIN) {
        const v = await run(process.env.CLAUDE_BIN, ['--version']);
        return { bin: process.env.CLAUDE_BIN, version: v.stdout.trim().split(' ')[0] };
      }
      const [onPath, bundled] = await Promise.all([run('claude', ['--version']), desktopBundledClaude()]);
      const pathVersion = onPath.code === 0 ? onPath.stdout.trim().split(' ')[0] : undefined;
      if (pathVersion && (!bundled || compareVersions(pathVersion, bundled.version) >= 0)) return { bin: 'claude', version: pathVersion };
      return bundled;
    })();
    return this.resolved;
  }

  async detect(): Promise<AgentInfo> {
    const [claude, procs] = await Promise.all([this.resolveBinary(), snapshotProcesses()]);
    if (!claude) {
      return { kind: this.kind, name: this.name, status: 'unavailable', runningProcesses: procs.claudeProcesses, detail: 'Claude Code not found (install the CLI or the Claude desktop app)' };
    }
    const detail = await this.proxy.failure() ?? (await this.credentials.hasCredentials() ? undefined : CLAUDE_LOGIN_REQUIRED);
    return { kind: this.kind, name: this.name, status: detail ? 'needsLogin' : 'ready', detail, version: claude.version, runningProcesses: procs.claudeProcesses };
  }

  async listSessions(limit: number): Promise<SessionSummary[]> {
    const [files, procs] = await Promise.all([listProjectJsonl(PROJECTS), snapshotProcesses()]);
    const now = Date.now();
    const out: SessionSummary[] = [];
    for (const f of files) {
      if (out.length >= limit) break;
      const summary = await this.summarize(f.path, f.mtimeMs).catch(() => undefined);
      if (!summary) continue;
      summary.running = procs.claudeSessionIds.has(summary.id) || now - f.mtimeMs < ACTIVE_WINDOW_MS;
      out.push(summary);
    }
    return out;
  }

  private async summarize(path: string, mtimeMs: number): Promise<SessionSummary | undefined> {
    const id = basename(path, '.jsonl');
    const head = parseJsonLines(await readChunk(path, 256 * 1024, false));
    const tail = parseJsonLines(await readChunk(path, 256 * 1024, true));
    let cwd = '';
    let firstPrompt: string | undefined;
    for (const e of head) {
      if (!cwd && typeof e.cwd === 'string') cwd = e.cwd;
      if (!firstPrompt) firstPrompt = claudeUserText(e);
      if (cwd && firstPrompt) break;
    }
    if (!cwd && !firstPrompt) return undefined; // Not a conversation (e.g. only bookkeeping lines).
    let title: string | undefined;
    let preview: string | undefined;
    for (const e of [...head, ...tail]) {
      if (e.type === 'custom-title' && e.customTitle) title = e.customTitle;
      else if (e.type === 'agent-name' && e.agentName && !title) title = e.agentName;
      else if (e.type === 'summary' && e.summary && !title) title = e.summary;
      if (e.type === 'last-prompt' && e.lastPrompt) preview = e.lastPrompt;
    }
    if (cwd) this.cwdCache.set(id, cwd);
    return {
      id,
      agent: this.kind,
      title: oneLine(title ?? firstPrompt ?? 'Untitled session', 80),
      cwd,
      updatedAt: Math.round(mtimeMs),
      running: false,
      preview: preview ? oneLine(preview, 160) : undefined,
    };
  }

  private async findSessionFile(sessionId: string): Promise<string | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return undefined;
    for (const p of await readdir(PROJECTS).catch(() => [] as string[])) {
      const candidate = join(PROJECTS, p, `${sessionId}.jsonl`);
      if (await exists(candidate)) return candidate;
    }
    return undefined;
  }

  async getMessages(sessionId: string, limit: number): Promise<ChatMessage[]> {
    const file = await this.findSessionFile(sessionId);
    if (!file) throw new Error(`Claude session ${sessionId} not found`);
    const entries = parseJsonLines(await readChunk(file, 2 * 1024 * 1024, true));
    const messages: ChatMessage[] = [];
    for (const e of entries) {
      const ts = e.timestamp ? Date.parse(e.timestamp) : undefined;
      const user = claudeUserText(e);
      if (user) {
        messages.push({ id: e.uuid ?? String(messages.length), role: 'user', text: user, timestamp: ts });
        continue;
      }
      const reply = claudeAssistantText(e);
      if (!reply) continue;
      const prev = messages[messages.length - 1];
      // A single assistant turn is split over several transcript lines; show it as one bubble.
      if (prev?.role === 'assistant') prev.text += '\n\n' + reply;
      else messages.push({ id: e.uuid ?? String(messages.length), role: 'assistant', text: reply, timestamp: ts });
    }
    return messages.slice(-limit);
  }

  async startTask(opts: StartTaskOptions, sink: TaskSink): Promise<RunningTask> {
    if (opts.fork) {
      sink.finish({ status: 'failed', error: 'Continuing in a copy is only supported for ChatGPT (Codex).' });
      return { cancel() {} };
    }
    const failure = await this.proxy.failure(true) ?? (await this.credentials.hasCredentials() ? undefined : CLAUDE_LOGIN_REQUIRED);
    if (failure) {
      sink.finish({ status: 'failed', error: failure });
      return { cancel() {} };
    }
    let cwd = opts.cwd;
    if (opts.sessionId) {
      cwd = this.cwdCache.get(opts.sessionId);
      if (!cwd) {
        const file = await this.findSessionFile(opts.sessionId);
        if (!file) throw new Error(`Claude session ${opts.sessionId} not found`);
        cwd = (await this.summarize(file, Date.now()))?.cwd;
      }
    }
    if (!cwd) throw new Error('A working directory is required for a new Claude session');
    const claude = await this.resolveBinary();
    if (!claude) throw new Error('Claude Code is not installed on this Mac');
    const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--permission-mode', PERMISSION_FLAGS[opts.permissionMode]];
    const directories = attachmentDirectories(opts);
    if (directories.length) args.push('--add-dir', ...directories);
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    args.push('--', opts.prompt); // `--` so a prompt starting with "-" isn't read as a flag.
    return runStreamJson({ command: claude.bin, args, cwd, env: augmentedEnv(), retryWithoutPartialMessages: true, reportApiRetries: true }, sink);
  }
}
