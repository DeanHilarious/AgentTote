import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writePrivateFile } from '../config.ts';
import { redactSecrets } from '../secrets.ts';
import type { ChatMessage } from '../types.ts';
import { oneLine } from '../util.ts';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;
const MAX_STORED_MESSAGES = 1000;

export interface CursorSession {
  id: string;
  cwd: string;
  title: string;
  /** Unix epoch milliseconds. */
  updatedAt: number;
  messages: ChatMessage[];
}

export interface CursorTurn {
  id: string;
  cwd: string;
  prompt: string;
  reply: string;
  startedAt: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isCursorSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

export function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseMessage(value: unknown, file: string): ChatMessage {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.text !== 'string'
      || (value.role !== 'user' && value.role !== 'assistant')
      || typeof value.timestamp !== 'number' || !Number.isFinite(value.timestamp)) {
    throw new Error(`Cursor session file ${file} has an invalid message`);
  }
  return { id: value.id, role: value.role, text: value.text, timestamp: value.timestamp };
}

/** Strongly validates stored JSON; the file name is the only source of truth for the id. */
export function parseCursorSession(raw: unknown, id: string): CursorSession {
  const file = `${id}.json`;
  if (!isRecord(raw) || raw.version !== 1 || raw.id !== id || typeof raw.cwd !== 'string' || !raw.cwd
      || typeof raw.title !== 'string' || typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)
      || !Array.isArray(raw.messages)) {
    throw new Error(`Cursor session file ${file} is not a valid AgentTote session`);
  }
  return {
    id,
    cwd: raw.cwd,
    title: raw.title,
    updatedAt: raw.updatedAt,
    messages: raw.messages.map(message => parseMessage(message, file)),
  };
}

/** Sessions created by AgentTote only; Cursor's own chat databases are never read. */
export class CursorSessionStore {
  private readonly directory: string;
  private readonly active = new Set<string>();

  constructor(directory: string) {
    this.directory = directory;
  }

  /** Claims a session for one running task; false when another task already holds it. */
  acquire(id: string): boolean {
    if (this.active.has(id)) return false;
    this.active.add(id);
    return true;
  }

  release(id: string): void {
    this.active.delete(id);
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  async read(id: string): Promise<CursorSession | undefined> {
    if (!isCursorSessionId(id)) return undefined;
    const key = id.toLowerCase();
    let text: string;
    try {
      text = await readFile(join(this.directory, `${key}.json`), 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`Cursor session file ${key}.json is not valid JSON`);
    }
    return parseCursorSession(raw, key);
  }

  async list(limit: number): Promise<CursorSession[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    const sessions: CursorSession[] = [];
    for (const name of names) {
      const id = SESSION_FILE.exec(name)?.[1];
      const session = id ? await this.read(id) : undefined;
      if (session) sessions.push(session);
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.max(0, limit));
  }

  /** Appends one completed turn. Callers hold `acquire(id)`, so writes never interleave. */
  async append(turn: CursorTurn): Promise<void> {
    const existing = await this.read(turn.id);
    const now = Date.now();
    const messages: ChatMessage[] = [
      ...(existing?.messages ?? []),
      { id: randomUUID(), role: 'user', text: turn.prompt, timestamp: turn.startedAt },
    ];
    const reply = redactSecrets(turn.reply).trim();
    if (reply) messages.push({ id: randomUUID(), role: 'assistant', text: reply, timestamp: now });
    const session = {
      version: 1,
      id: turn.id,
      cwd: existing?.cwd ?? turn.cwd,
      title: existing?.title ?? oneLine(turn.prompt, 80),
      updatedAt: now,
      messages: messages.slice(-MAX_STORED_MESSAGES),
    };
    await writePrivateFile(`${turn.id}.json`, JSON.stringify(session, null, 2) + '\n', this.directory);
  }
}
