import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { test } from 'node:test';
import { CodexAdapter, copyName, isActiveWriterError, type CodexServer } from '../src/adapters/codex.ts';
import { startServer } from '../src/server.ts';
import type { Adapter, PermissionMode, StartTaskOptions, TaskSink } from '../src/types.ts';
import { config } from './accountHelpers.ts';

class FakeCodexServer implements CodexServer {
  approvalPolicy = new Map<string, PermissionMode>();
  requests: { method: string; params: any }[] = [];
  listeners = new Set<(method: string, params: any) => void>();
  threads: any[] = [];
  fail?: { method: string; message: string };

  async request(method: string, params: any) {
    this.requests.push({ method, params });
    if (this.fail?.method === method) throw new Error(this.fail.message);
    if (method === 'thread/list') return { data: this.threads };
    if (method === 'thread/fork') return { thread: { id: 'forked-thread', name: 'Old name (2)', cwd: '/tmp' }, model: 'fork-model', reasoningEffort: 'high' };
    if (method === 'thread/resume') return { thread: { id: params.threadId }, model: 'resume-model' };
    return { turn: { id: 'turn' } };
  }

  subscribe(listener: (method: string, params: any) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function makeSink() {
  const sessions: string[] = [];
  const sink: TaskSink & { sessions: string[] } = {
    sessions,
    emit() {}, delta() {}, finish() {},
    setSession(id) { sessions.push(id); },
  };
  return sink;
}

test('isActiveWriterError only matches the Codex writer conflict', () => {
  assert.equal(isActiveWriterError('thread abc already has an active writer'), true);
  assert.equal(isActiveWriterError('thread abc: already has an active writer (pid 42)'), true);
  assert.equal(isActiveWriterError('SESSION_BUSY: This conversation is open in the Codex app on your Mac.'), false);
  assert.equal(isActiveWriterError('thread abc not found'), false);
  assert.equal(isActiveWriterError(''), false);
});

test('Codex listSessions maps originator and forkedFromId', async () => {
  const server = new FakeCodexServer();
  server.threads = [
    { id: 'mac', name: 'From Mac', cwd: '/tmp', updatedAt: 1, originator: 'Codex Desktop' },
    { id: 'phone', name: 'From phone', cwd: '/tmp', updatedAt: 2, originator: 'agentanywhere' },
    { id: 'cli', name: 'From CLI', cwd: '/tmp', updatedAt: 3, originator: 'codex_cli_rs' },
    { id: 'unknown', name: 'No originator', cwd: '/tmp', updatedAt: 4 },
    { id: 'copy', name: 'Copy', cwd: '/tmp', updatedAt: 5, originator: 'Codex Desktop', forkedFromId: 'mac' },
  ];
  const sessions = await new CodexAdapter(server).listSessions(20);
  assert.deepEqual(sessions.map(s => s.origin), ['mac', 'phone', 'cli', undefined, 'mac']);
  assert.equal(sessions[4]!.forkedFromId, 'mac');
  assert.equal('origin' in sessions[3]!, false);
  assert.equal('forkedFromId' in sessions[0]!, false);
  assert.equal('forkedFromId' in sessions[4]!, true);
});

test('fork calls thread/fork with resume-style params and continues on the new thread', async () => {
  for (const model of [undefined, 'second']) {
    const server = new FakeCodexServer();
    const sink = makeSink();
    await new CodexAdapter(server).startTask({ sessionId: 'old', cwd: '/tmp', prompt: 'go',
      permissionMode: 'acceptEdits', fork: true, ...(model ? { model } : {}) }, sink);
    assert.equal(server.requests[0]!.method, 'thread/fork');
    assert.deepEqual(server.requests[0]!.params, { threadId: 'old', approvalPolicy: 'never', sandbox: 'workspace-write',
      excludeTurns: true, ...(model ? { model } : {}) });
    assert.equal(server.requests.find(r => r.method === 'thread/resume'), undefined);
    const turn = server.requests.find(r => r.method === 'turn/start')!;
    assert.equal(turn.params.threadId, 'forked-thread');
    assert.deepEqual(sink.sessions, ['forked-thread']);
  }
});

test('Codex passes uploaded image paths as native image inputs alongside the document prompt', async () => {
  const server = new FakeCodexServer();
  const photo = '/tmp/private/photo.png';
  const document = '/tmp/private/notes.pdf';
  await new CodexAdapter(server).startTask({
    sessionId: 'old', prompt: `Read ${document}`, permissionMode: 'readOnly',
    attachments: [{ path: photo, isImage: true }, { path: document, isImage: false }],
  }, makeSink());
  const turn = server.requests.find(r => r.method === 'turn/start')!;
  assert.deepEqual(turn.params.input, [
    { type: 'text', text: `Read ${document}`, text_elements: [] },
    { type: 'localImage', path: photo },
  ]);
});

test('active-writer failures surface as SESSION_BUSY, other errors unchanged', async () => {
  for (const method of ['thread/resume', 'turn/start']) {
    const server = new FakeCodexServer();
    server.fail = { method, message: 'thread old already has an active writer' };
    await assert.rejects(
      new CodexAdapter(server).startTask({ sessionId: 'old', prompt: 'go', permissionMode: 'readOnly' }, makeSink()),
      (err: Error) => err.message === 'SESSION_BUSY: This conversation is open in the Codex app on your Mac.',
    );
  }
  const server = new FakeCodexServer();
  server.fail = { method: 'thread/resume', message: 'thread old not found' };
  await assert.rejects(
    new CodexAdapter(server).startTask({ sessionId: 'old', prompt: 'go', permissionMode: 'readOnly' }, makeSink()),
    (err: Error) => err.message === 'thread old not found',
  );
});

test('tasks.start validates fork and forwards it to the adapter', async t => {
  t.mock.method(Server.prototype, 'listen', function (this: Server, ...args: any[]) { queueMicrotask(args.at(-1)); return this; });
  const starts: StartTaskOptions[] = [];
  const adapter: Adapter = {
    kind: 'codex', name: 'ChatGPT',
    async detect() { throw new Error('unused'); },
    async listSessions() { return []; },
    async getMessages() { return []; },
    async startTask(options, sink) {
      starts.push(options);
      sink.finish({ status: 'completed', result: 'OK' });
      return { cancel() {} };
    },
  };
  const server = await startServer({ ...config, disabledAgents: [] }, [adapter], () => {});
  t.after(() => server.shutdown().catch(() => {}));
  const received: any[] = [];
  const phone = server.attachClient({ kind: 'local', remote: 'test', send: text => received.push(JSON.parse(text)), close() {} });
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const requestId = ++id;
    await phone.receive(JSON.stringify({ id: requestId, method, params }));
    return received.find(r => r.id === requestId);
  };
  const start = (params: Record<string, unknown>) => rpc('tasks.start', { agent: 'codex', prompt: 'go', ...params });

  assert.equal((await start({ cwd: '/tmp', fork: 'yes' })).error.message, 'Invalid fork');
  assert.equal((await start({ cwd: '/tmp', fork: true })).error.message, 'fork requires a sessionId');
  const forked = await start({ sessionId: 'old', fork: true });
  assert.equal(forked.error, undefined);
  assert.equal(starts[0]!.sessionId, 'old');
  assert.equal(starts[0]!.fork, true);
  const plain = await start({ sessionId: 'other' });
  assert.equal(plain.error, undefined);
  assert.equal(starts[1]!.fork, false);
});

test('copyName strips old copy suffixes and appends a local timestamp', () => {
  const now = new Date(2026, 9, 18, 8, 50);
  assert.equal(copyName('Plan', now), 'Plan · iPhone copy 10/18 08:50');
  assert.equal(copyName('Plan (2)', now), 'Plan · iPhone copy 10/18 08:50');
  assert.equal(copyName('  Plan (2)  ', now), 'Plan · iPhone copy 10/18 08:50');
  assert.equal(copyName('Plan · iPhone copy 9/1 07:05', now), 'Plan · iPhone copy 10/18 08:50');
  assert.equal(copyName('Plan · iPhone copy 9/1 07:05 (2)', now), 'Plan · iPhone copy 10/18 08:50');
  assert.equal(copyName('Plan · iPhone copy 1/1 00:00 · iPhone copy 2/2 03:04', now), 'Plan · iPhone copy 10/18 08:50');
  assert.equal(copyName('', now), 'Conversation · iPhone copy 10/18 08:50');
  assert.equal(copyName(null, now), 'Conversation · iPhone copy 10/18 08:50');
  assert.equal(copyName(undefined, now), 'Conversation · iPhone copy 10/18 08:50');
  assert.equal(copyName('Plan', new Date(2026, 0, 2, 7, 5)), 'Plan · iPhone copy 1/2 07:05');
});

test('copyName truncates only the base name to keep the suffix under 120 characters', () => {
  const now = new Date(2026, 9, 18, 8, 50);
  const name = copyName('x'.repeat(200), now);
  assert.equal(name.length, 120);
  assert.ok(name.startsWith('x'));
  assert.ok(name.endsWith(' · iPhone copy 10/18 08:50'));
});

test('fork renames the new thread via thread/name/set', async () => {
  const server = new FakeCodexServer();
  const sink = makeSink();
  await new CodexAdapter(server).startTask({ sessionId: 'old', prompt: 'go', permissionMode: 'readOnly', fork: true }, sink);
  const rename = server.requests.find(r => r.method === 'thread/name/set')!;
  assert.equal(rename.params.threadId, 'forked-thread');
  assert.match(rename.params.name, /^Old name · iPhone copy \d{1,2}\/\d{1,2} \d{2}:\d{2}$/);
  assert.equal(server.requests.find(r => r.method === 'turn/start')!.params.threadId, 'forked-thread');
  assert.deepEqual(sink.sessions, ['forked-thread']);
});

test('thread/name/set failures do not affect a forked task', async () => {
  const server = new FakeCodexServer();
  server.fail = { method: 'thread/name/set', message: 'rename failed' };
  const sink = makeSink();
  await new CodexAdapter(server).startTask({ sessionId: 'old', prompt: 'go', permissionMode: 'readOnly', fork: true }, sink);
  assert.deepEqual(sink.sessions, ['forked-thread']);
  assert.ok(server.requests.some(r => r.method === 'turn/start'));
});

test('ForkOrigins reads forked_from_id from the first rollout line once', async () => {
  const { ForkOrigins } = await import('../src/adapters/codex.ts');
  const reads: string[] = [];
  const files: Record<string, string> = {
    '/fork.jsonl': '{"type":"session_meta","payload":{"id":"x","forked_from_id":"01a14044-7b39-7173-854f-f8b323fc134a","cwd":"/w"}}\n{"forked_from_id":"ignored"}',
    '/orig.jsonl': '{"type":"session_meta","payload":{"id":"y"}}\n{"payload":{"forked_from_id":"01a14044-7b39-7173-854f-f8b323fc134b"}}',
  };
  const forks = new ForkOrigins(async path => { reads.push(path); if (!(path in files)) throw new Error('ENOENT'); return files[path]; });
  assert.equal(await forks.get('/fork.jsonl'), '01a14044-7b39-7173-854f-f8b323fc134a');
  assert.equal(await forks.get('/fork.jsonl'), '01a14044-7b39-7173-854f-f8b323fc134a');
  assert.equal(await forks.get('/orig.jsonl'), undefined, 'only the first line counts');
  assert.equal(await forks.get('/missing.jsonl'), undefined);
  assert.deepEqual(reads, ['/fork.jsonl', '/orig.jsonl', '/missing.jsonl'], 'cached after the first read');
});

test('CodexAdapter resolves bundled binary and detects needsLogin vs ready', async t => {
  const { chmod, mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { CODEX_LOGIN_REQUIRED, ForkOrigins, resolveCodexBinary } = await import('../src/adapters/codex.ts');
  const dir = await mkdtemp(join(tmpdir(), 'aa-codex-bin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fakeBin = join(dir, 'fake-codex');
  await writeFile(
    fakeBin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.169.0'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') {
  if (process.env.FAKE_CODEX_LOGGED_OUT === '1') { console.error('Not logged in'); process.exit(1); }
  console.log('Logged in using ChatGPT'); process.exit(0);
}
`,
  );
  await chmod(fakeBin, 0o755);

  const resolved = await resolveCodexBinary([join(dir, 'missing'), fakeBin]);
  assert.deepEqual(resolved, { bin: fakeBin, version: '0.169.0' });
  assert.equal(await resolveCodexBinary([join(dir, 'missing')]), undefined);

  const missingAdapter = new CodexAdapter(new FakeCodexServer(), new ForkOrigins(), async () => undefined);
  const missingInfo = await missingAdapter.detect();
  assert.equal(missingInfo.status, 'unavailable');

  const adapter = new CodexAdapter(new FakeCodexServer(), new ForkOrigins(), async () => resolved);
  const readyInfo = await adapter.detect();
  assert.equal(readyInfo.status, 'ready');
  assert.equal(readyInfo.version, '0.169.0');

  process.env.FAKE_CODEX_LOGGED_OUT = '1';
  t.after(() => { delete process.env.FAKE_CODEX_LOGGED_OUT; });
  const loggedOutInfo = await adapter.detect();
  assert.equal(loggedOutInfo.status, 'needsLogin');
  assert.equal(loggedOutInfo.detail, CODEX_LOGIN_REQUIRED);
});
