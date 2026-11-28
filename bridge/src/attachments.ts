import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { configDirectory } from './config.ts';
import type { StartTaskOptions, TaskAttachment, TaskInfo } from './types.ts';

const MAX_FILES = 4;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CHUNK_BYTES = 192 * 1024;
const MAX_PENDING_BYTES = 128 * 1024 * 1024;
const MAX_PENDING_FILES = 64;
const UPLOAD_IDLE_MS = 10 * 60 * 1000;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_RETAINED_BYTES = 512 * 1024 * 1024;

interface Upload {
  owner: object;
  name: string;
  bytes: Buffer;
  offset: number;
  claimed: boolean;
  updatedAt: number;
}

function isNativeImage(bytes: Buffer): boolean {
  return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    || bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    || ['GIF87a', 'GIF89a'].includes(bytes.toString('latin1', 0, 6))
    || (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP');
}

const FILES_HEADER = 'AgentTote attached local files: ';
const REQUEST_HEADER = '\n\nMessage from iPhone:\n';

export function attachmentPrompts(prompt: string, files?: TaskAttachment[]) {
  if (!files?.length) return { display: prompt, agent: prompt };
  const display = [prompt, ...files.map(file => `📎 ${basename(file.path)}`)].join('\n');
  return { display, agent: FILES_HEADER + JSON.stringify(files.map(file => file.path)) + REQUEST_HEADER + display };
}

export function displayAttachmentPrompt(prompt: string) {
  if (!prompt.startsWith(FILES_HEADER)) return prompt;
  const index = prompt.indexOf(REQUEST_HEADER);
  if (index < 0) return prompt;
  let paths: unknown;
  try {
    paths = JSON.parse(prompt.slice(FILES_HEADER.length, index));
  } catch {
    // A user can type the same header as ordinary prose.
    return prompt;
  }
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_FILES || !paths.every((path, i): path is string =>
    typeof path === 'string' && isAbsolute(path) && basename(dirname(path)) === String(i)
      && /^run-\d+-[\da-f-]{36}$/.test(basename(dirname(dirname(path)))))) return prompt;
  const display = prompt.slice(index + REQUEST_HEADER.length);
  const labels = paths.map(path => '\n📎 ' + basename(path)).join('');
  return display.endsWith(labels) ? display : prompt;
}

export function attachmentDirectories(opts: StartTaskOptions): string[] {
  return [...new Set(opts.attachments?.map(file => dirname(file.path)))];
}

/** Only completed uploads are materialized. Disconnect drops staging but does not interrupt a submitted task. */
export class TaskAttachments {
  private pending = new Map<string, Upload>();
  private retained = new Map<string, { taskId?: string; size: number }>();
  private readonly root: string;
  private maintenance = Promise.resolve();
  private closing?: Promise<void>;

  constructor(root = join(configDirectory(), 'attachments')) {
    this.root = resolve(root);
  }

  begin(owner: object, name: unknown, size: unknown) {
    if (typeof name !== 'string' || !name.trim() || Buffer.byteLength(name) > 255
      || /[/\\:\x00-\x1f\x7f]/u.test(name) || name === '.' || name === '..') {
      throw new Error('Invalid attachment filename');
    }
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
      throw new Error('Attachments must be at most 10 MiB each');
    }
    const uploads = [...this.pending.values()];
    if (uploads.filter(upload => upload.owner === owner).length >= MAX_FILES) {
      throw new Error('At most four attachments per task');
    }
    const reserved = uploads.reduce((sum, upload) => sum + upload.bytes.length, size);
    if (uploads.length >= MAX_PENDING_FILES || reserved > MAX_PENDING_BYTES) {
      throw new Error('Mac upload capacity reached; retry after existing uploads finish');
    }
    const id = randomUUID();
    this.pending.set(id, { owner, name, bytes: Buffer.alloc(size), offset: 0, claimed: false, updatedAt: Date.now() });
    return { id };
  }

  private upload(owner: object, id: unknown) {
    const upload = typeof id === 'string' ? this.pending.get(id) : undefined;
    if (!upload || upload.owner !== owner || upload.claimed) throw new Error('Unknown or already submitted attachment');
    return upload;
  }

  chunk(owner: object, id: unknown, offset: unknown, data: unknown) {
    const upload = this.upload(owner, id);
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > upload.offset) {
      throw new Error('Invalid attachment offset');
    }
    if (typeof data !== 'string' || !data.length || data.length > 4 * Math.ceil(MAX_CHUNK_BYTES / 3)) {
      throw new Error('Invalid attachment chunk size');
    }
    const bytes = Buffer.from(data, 'base64');
    const end = offset + bytes.length;
    if (bytes.toString('base64') !== data || end > upload.bytes.length) throw new Error('Invalid attachment data');
    if (offset === upload.offset) {
      bytes.copy(upload.bytes, offset);
      upload.offset += bytes.length;
    } else if (end > upload.offset || !bytes.equals(upload.bytes.subarray(offset, end))) {
      throw new Error('Conflicting attachment chunk');
    }
    upload.updatedAt = Date.now();
    return { offset: upload.offset };
  }

  discard(owner: object, id: string) {
    this.upload(owner, id);
    this.pending.delete(id);
    return {};
  }

  disconnect(owner: object) {
    for (const [id, upload] of this.pending) if (upload.owner === owner && !upload.claimed) this.pending.delete(id);
  }

  async removeOrphans() {
    // Another live bridge can use the same config directory.
    const entries = await readdir(this.root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      const pid = entry.isDirectory() && /^run-(\d+)-[\da-f-]{36}$/.exec(entry.name)?.[1];
      if (!pid) continue;
      try {
        process.kill(Number(pid), 0);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM') continue;
        if (code !== 'ESRCH') throw error;
        await rm(join(this.root, entry.name), { recursive: true, force: true });
      }
    }
  }

  async start(owner: object, ids: unknown, tasks: () => TaskInfo[],
    start: (files: TaskAttachment[]) => Promise<TaskInfo>): Promise<TaskInfo> {
    if (ids === undefined) return start([]);
    if (!Array.isArray(ids) || ids.length > MAX_FILES || new Set(ids).size !== ids.length
      || !ids.every((id): id is string => typeof id === 'string')) throw new Error('Invalid attachment IDs');
    if (!ids.length) return start([]);
    const uploads = ids.map(id => this.upload(owner, id));
    if (uploads.some(upload => upload.offset !== upload.bytes.length)) {
      throw new Error('Attachment upload is incomplete');
    }
    // Reserve synchronously before any filesystem await so concurrent starts cannot consume the same bytes.
    for (const upload of uploads) upload.claimed = true;
    const dir = join(this.root, `run-${process.pid}-${randomUUID()}`);
    const retained: { size: number; taskId?: string } = { size: uploads.reduce((n, u) => n + u.bytes.length, 0) };
    this.retained.set(dir, retained);
    let created = false;
    try {
      await this.prune(tasks);
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await mkdir(dir, { mode: 0o700 });
      created = true;
      const files: TaskAttachment[] = [];
      for (const [index, upload] of uploads.entries()) {
        const subdir = join(dir, String(index));
        await mkdir(subdir, { mode: 0o700 });
        const path = join(subdir, upload.name);
        await writeFile(path, upload.bytes, { flag: 'wx', mode: 0o600 });
        files.push({ path, isImage: isNativeImage(upload.bytes) });
      }
      if (this.closing) throw new Error('Bridge stopped during attachment upload');
      const task = await start(files);
      retained.taskId = task.id;
      return task;
    } catch (error) {
      if (created) await this.remove(dir);
      else this.retained.delete(dir);
      throw error;
    } finally {
      for (const id of ids) this.pending.delete(id);
    }
  }

  private async remove(dir: string) {
    await rm(dir, { recursive: true, force: true });
    this.retained.delete(dir);
  }

  private serializeCleanup(operation: () => Promise<void>) {
    // Each caller observes its own error; a failed sweep must not poison subsequent cleanup.
    this.maintenance = this.maintenance.then(operation, operation);
    return this.maintenance;
  }

  prune(tasks: () => TaskInfo[]) {
    return this.serializeCleanup(async () => {
      const now = Date.now();
      for (const [id, upload] of this.pending) {
        if (!upload.claimed && now - upload.updatedAt >= UPLOAD_IDLE_MS) this.pending.delete(id);
      }
      if (!this.retained.size) return;
      const byId = new Map(tasks().map(task => [task.id, task]));
      let total = [...this.retained.values()].reduce((sum, item) => sum + item.size, 0);
      const expired: string[] = [];
      for (const [dir, entry] of this.retained) {
        if (!entry.taskId) continue;
        const task = byId.get(entry.taskId);
        if (task?.status === 'running') continue;
        if (task?.endedAt !== undefined && now - task.endedAt < RETENTION_MS && total <= MAX_RETAINED_BYTES) continue;
        expired.push(dir);
        total -= entry.size;
      }
      await Promise.all(expired.map(dir => this.remove(dir)));
      if (total > MAX_RETAINED_BYTES) throw new Error('Mac attachment storage is full while tasks are running');
    });
  }

  close() {
    this.pending.clear();
    this.closing ??= this.serializeCleanup(async () => {
      await Promise.all([...this.retained.keys()].map(dir => this.remove(dir)));
    });
    return this.closing;
  }
}
