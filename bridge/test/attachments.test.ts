import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { displayAttachmentPrompt, TaskAttachments } from '../src/attachments.ts';
import { startServer, type ClientTransport } from '../src/server.ts';
import type { Adapter, RpcResponse, StartTaskOptions, TaskInfo } from '../src/types.ts';
import { config } from './accountHelpers.ts';

const task: TaskInfo = {
  id: 'task', agent: 'codex', cwd: '/tmp', prompt: 'test', permissionMode: 'readOnly', status: 'running', startedAt: 0,
};

test('upload boundaries, ordered retry, connection ownership and cancellation', async () => {
  const store = new TaskAttachments();
  const owner = {};
  for (const name of ['../test.txt', '.', '..', 'sub\\file', '', 'a\nb.txt']) {
    assert.throws(() => store.begin(owner, name, 1), /filename/);
  }
  for (const size of [-1, 1.5, 10 * 1024 * 1024 + 1]) assert.throws(() => store.begin(owner, 'notes.txt', size), /10 MiB/);
  const { id } = store.begin(owner, 'notes.txt', 6);
  await assert.rejects(store.start(owner, [id], () => [], async () => task), /incomplete/);
  assert.throws(() => store.chunk({}, id, 0, 'YWJj'), /Unknown/);
  assert.throws(() => store.chunk(owner, id, 1, 'YWJj'), /offset/);
  assert.throws(() => store.chunk(owner, id, 0, 'junk!'), /data/);
  assert.deepEqual(store.chunk(owner, id, 0, 'YWJj'), { offset: 3 });
  assert.deepEqual(store.chunk(owner, id, 0, 'YWJj'), { offset: 3 });
  assert.throws(() => store.chunk(owner, id, 0, 'ZGVm'), /Conflicting/);
  assert.throws(() => store.chunk(owner, id, 3, 'dG9vbG9uZw=='), /data/);
  assert.throws(() => store.chunk(owner, id, 3, Buffer.alloc(192 * 1024 + 1).toString('base64')), /size/);
  await assert.rejects(store.start(owner, [id, id], () => [], async () => task), /IDs/);
  for (let i = 0; i < 3; i++) store.begin(owner, 'empty', 0);
  assert.throws(() => store.begin(owner, 'fifth', 0), /four/);
  store.discard(owner, id);
  assert.throws(() => store.chunk(owner, id, 0, 'YWJj'), /Unknown/);
  const next = store.begin(owner, 'next', 1);
  store.disconnect(owner);
  assert.throws(() => store.chunk(owner, next.id, 0, 'YQ=='), /Unknown/);
});

test('attachment-like prose in session history keeps its original text', () => {
  for (const header of ['files', '[]', '12', '["/any/file.pdf"]']) {
    const message = `AgentTote attached local files: ${header}\n\nMessage from iPhone:\nRead this exactly`;
    assert.equal(displayAttachmentPrompt(message), message);
  }
});

test('sweeps expire idle staged uploads and startup cleanup reclaims only dead bridge directories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agenttote-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new TaskAttachments(root);
  const owner = {};
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const first = store.begin(owner, 'a.txt', 3);
  now += 11 * 60 * 1000;
  await store.prune(() => []);
  assert.throws(() => store.chunk(owner, first.id, 0, 'YWJj'), /Unknown/);

  const alive = `run-${process.pid}-${randomUUID()}`;
  const dead = `run-2147483647-${randomUUID()}`;
  for (const dir of [alive, dead, 'user-files']) await mkdir(join(root, dir));
  await store.removeOrphans();
  assert.deepEqual((await readdir(root)).sort(), [alive, 'user-files'].sort());
});

test('accepted tasks retain private files after disconnect, failed starts and expired tasks release them', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agenttote-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new TaskAttachments(root);
  const owner = {};
  const { id } = store.begin(owner, 'empty.pdf', 0);
  const failed = store.start(owner, [id], () => [], async () => { throw new Error('session busy'); });
  await assert.rejects(store.start(owner, [id], () => [], async () => task), /already submitted/);
  await assert.rejects(failed, /busy/);
  assert.deepEqual(await readdir(root), []);

  const fresh = store.begin(owner, 'empty.pdf', 0);
  let path = '';
  await store.start(owner, [fresh.id], () => [], async files => {
    path = files[0]!.path;
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    return task;
  });
  store.disconnect(owner);
  await store.prune(() => [task]);
  assert.equal((await stat(path)).size, 0);
  await store.prune(() => [{ ...task, status: 'completed', endedAt: 0 }]);
  assert.deepEqual(await readdir(root), []);
});

test('direct and relay attachment RPCs deliver exact bytes, preserve prompt history, and isolate clients', async t => {
  t.mock.method(Server.prototype, 'listen', function(this: Server, ...args: unknown[]) {
    const ready = args.at(-1);
    if (typeof ready === 'function') queueMicrotask(() => ready());
    return this;
  });
  const root = await mkdtemp(join(tmpdir(), 'agenttote-rpc-'));
  const prior = process.env.AGENTANYWHERE_HOME;
  process.env.AGENTANYWHERE_HOME = root;
  t.after(async () => {
    if (prior === undefined) delete process.env.AGENTANYWHERE_HOME;
    else process.env.AGENTANYWHERE_HOME = prior;
    await rm(root, { recursive: true, force: true });
  });
  const starts: StartTaskOptions[] = [];
  const adapter: Adapter = {
    kind: 'codex', name: 'ChatGPT',
    async detect() { return { kind: 'codex', name: 'ChatGPT', status: 'ready', runningProcesses: 0 }; },
    async listSessions() { return []; },
    async getMessages() { return [{ id: 'msg', role: 'user', text: starts.at(-1)!.prompt }]; },
    async startTask(options, sink) {
      starts.push(options);
      sink.finish({ status: 'completed' });
      return { cancel() {} };
    },
  };
  const server = await startServer(config, [adapter], () => {});
  t.after(() => server.shutdown().catch(error => { if (error.code !== 'ERR_SERVER_NOT_RUNNING') throw error; }));
  function connect(kind: ClientTransport['kind']) {
    let sequence = 0;
    const responses = new Map<number | string, RpcResponse>();
    const client = server.attachClient({
      kind, remote: 'test', close() {},
      send(text) { const reply = JSON.parse(text); if (reply.id) responses.set(reply.id, reply); },
    });
    return async (method: string, params: Record<string, unknown>) => {
      const id = ++sequence;
      await client.receive(JSON.stringify({ id, method, params }));
      const response = responses.get(id)!;
      if ('error' in response) throw new Error(response.error.message);
      return response.result;
    };
  }
  for (const kind of ['local', 'relay'] as const) {
    const rpc = connect(kind);
    assert.equal((await rpc('hello', {}) as { supportsAttachments: boolean }).supportsAttachments, true);
    const photo = Buffer.from('89504e470d0a1a0a', 'hex');
    const document = Buffer.alloc(256 * 1024, 78);
    const ids = [];
    for (const bytes of [photo, document]) {
      const { id } = await rpc('attachments.begin', { name: '测试.png', size: bytes.length }) as { id: string };
      ids.push(id);
      for (let offset = 0; offset < bytes.length; offset += 128 * 1024) {
        const chunk = bytes.subarray(offset, offset + 128 * 1024);
        assert.deepEqual(await rpc('attachments.chunk', { id, offset, data: chunk.toString('base64') }), { offset: offset + chunk.length });
      }
    }
    const params = { cwd: root, permissionMode: 'readOnly', prompt: 'Summarize', agent: 'codex', attachmentIds: ids };
    await assert.rejects(connect(kind)('tasks.start', params), /Unknown/);
    const created = await rpc('tasks.start', params) as TaskInfo;
    const sent = starts.at(-1)!;
    assert.equal(sent.permissionMode, 'readOnly');
    assert.equal(sent.attachments!.length, 2);
    for (const [index, expected] of [photo, document].entries()) {
      const file = sent.attachments![index]!;
      assert.deepEqual(await readFile(file.path), expected);
      assert.ok(sent.prompt.includes(file.path));
      assert.equal(file.isImage, index === 0);
      assert.ok(!created.prompt.includes(file.path));
    }
    assert.deepEqual(await rpc('sessions.messages', { agent: 'codex', sessionId: 'thread' }),
      [{ id: 'msg', role: 'user', text: created.prompt }]);
    await assert.rejects(rpc('tasks.start', params), /Unknown/);
  }
});
