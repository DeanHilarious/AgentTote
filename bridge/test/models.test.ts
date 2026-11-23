import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CodexAdapter, type CodexServer } from '../src/adapters/codex.ts';
import { WorkBuddyAdapter, WORKBUDDY_EFFORTS } from '../src/adapters/workbuddy.ts';
import { ModelCatalog } from '../src/models.ts';
import { startServer } from '../src/server.ts';
import { TaskManager } from '../src/tasks.ts';
import { saveWorkBuddyKey } from '../src/workbuddyKey.ts';
import type { Adapter, ModelOption, PermissionMode, StartTaskOptions, TaskSink } from '../src/types.ts';
import { config } from './accountHelpers.ts';

class FakeCodexServer implements CodexServer {
  approvalPolicy = new Map<string, PermissionMode>();
  requests: { method: string; params: any }[] = [];
  listeners = new Set<(method: string, params: any) => void>();
  async request(method: string, params: any) {
    this.requests.push({ method, params });
    if (method === 'model/list') {
      const model = (id: string, hidden = false) => ({ id, model: id, displayName: id.toUpperCase(), description: 'Description',
        hidden, isDefault: id === 'first', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }], defaultReasoningEffort: 'high' });
      return params.cursor ? { data: [model('second')], nextCursor: null }
        : { data: [model('first'), model('hidden', true)], nextCursor: 'page-2' };
    }
    if (method.startsWith('thread/')) return { thread: { id: params.threadId ?? 'new-thread' }, model: params.model ?? 'first', reasoningEffort: 'high' };
    return { turn: { id: 'turn' } };
  }
  subscribe(listener: (method: string, params: any) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const sink: TaskSink = { emit() {}, delta() {}, setSession() {}, finish() {} };

test('Codex pages through model/list, removes hidden and maps capabilities', async () => {
  const server = new FakeCodexServer();
  const models = await new CodexAdapter(server).listModels();
  assert.deepEqual(models, ['first', 'second'].map(id => ({ id, name: id.toUpperCase(), description: 'Description',
    isDefault: id === 'first', efforts: ['high'], defaultEffort: 'high' })));
  assert.deepEqual(server.requests.map(r => r.params), [
    { limit: 100, includeHidden: false }, { cursor: 'page-2', limit: 100, includeHidden: false },
  ]);
});

test('Codex sends model/effort for new and resumed turns, omits unselected defaults', async () => {
  for (const sessionId of [undefined, 'existing']) for (const selected of [false, true]) {
    const server = new FakeCodexServer();
    let execution: unknown;
    await new CodexAdapter(server).startTask({ sessionId, cwd: '/tmp', prompt: 'go', permissionMode: 'readOnly',
      ...(selected ? { model: 'second', effort: 'high' } : {}) }, { ...sink, setModel: (model, effort) => { execution = { model, effort }; } });
    assert.deepEqual(execution, { model: selected ? 'second' : 'first', effort: 'high' });
    const turn = server.requests.find(r => r.method === 'turn/start')!.params;
    assert.deepEqual(turn, { threadId: sessionId ?? 'new-thread', input: [{ type: 'text', text: 'go', text_elements: [] }],
      ...(selected ? { model: 'second', effort: 'high' } : {}) });
    const thread = server.requests[0];
    assert.equal(thread.method, sessionId ? 'thread/resume' : 'thread/start');
    if (!sessionId) assert.equal(thread.params.model, selected ? 'second' : undefined);
  }
});

test('WorkBuddy product environment, task model filters, descriptions, notes and effort capabilities', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aa-models-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'dist'));
  const cli = join(directory, 'dist', 'codebuddy-headless.js');
  const models = [
    { id: 'auto', name: 'Auto', supportsToolCall: true, isDefault: true, reasoning: { effort: 'high' } },
    { id: 'glm', name: 'GLM', supportsToolCall: true, supportsReasoning: true, reasoning: { effort: 'medium' },
      descriptionZh: '中文说明', descriptionEn: 'English', credits: 'x0.79 credits' },
    { id: 'kimi', name: 'Kimi', supportsToolCall: true, supportsReasoning: true, descriptionEn: 'English' },
    ...['codewise-task', 'completion-gf', 'completion', 'hunyuan-image'].map(id => ({ id, supportsToolCall: true,
      ...(id === 'hunyuan-image' ? { tags: ['text-to-image'] } : {}) })),
    { id: 'image-edit', supportsToolCall: true, tags: ['image-to-image'] },
    { id: 'hunyuan-3b' }, { id: 'false', supportsToolCall: false }, { id: 'truthy', supportsToolCall: 1 },
  ];
  await writeFile(join(directory, 'product.internal.json'), JSON.stringify({ models }));
  await writeFile(join(directory, 'product.json'), JSON.stringify({ models: [{ id: 'external', name: 'External', supportsToolCall: true }] }));
  // Only synthetic test credentials; never inspect the user's stored credential.
  await saveWorkBuddyKey({ apiKey: 'synthetic-test-key-1234', environment: 'internal' }, directory);
  const adapter = new WorkBuddyAdapter({ cli, directory });
  const options = await adapter.listModels();
  assert.deepEqual(options.map(m => m.id), ['auto', 'glm', 'kimi']);
  assert.equal(options[0].isDefault, true);
  assert.equal(options[0].efforts, undefined);
  assert.equal(options[0].defaultEffort, undefined);
  assert.deepEqual(options[1], { id: 'glm', name: 'GLM', description: '中文说明', note: 'x0.79 credits', isDefault: false,
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' });
  assert.deepEqual(options[2].efforts, WORKBUDDY_EFFORTS);
  assert.equal(options[2].description, 'English');
  await saveWorkBuddyKey({ apiKey: 'synthetic-test-key-1234', environment: null }, directory);
  assert.deepEqual((await adapter.listModels()).map(m => m.id), ['external']);
  await rm(join(directory, 'product.json'));
  await assert.rejects(adapter.listModels(), /ENOENT/);
});

test('WorkBuddy selected flags precede -- and prompt; default leaves flags absent', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aa-model-args-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = join(directory, 'fake.cjs');
  await writeFile(cli, `require('fs').writeFileSync('args.json', JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({type:'system',subtype:'init',model:'glm'})); console.log(JSON.stringify({type:'result',subtype:'success',result:'OK'}));`);
  for (const selected of [true, false]) {
    let finish!: TaskSink['finish'];
    const done = new Promise(resolve => { finish = resolve; });
    let execution: unknown;
    await new WorkBuddyAdapter({ cli, directory }).startTask({ cwd: directory, prompt: '--model is prompt text', permissionMode: 'readOnly',
      ...(selected ? { model: 'glm', effort: 'xhigh' } : {}) }, { ...sink, finish, setModel: (model, effort) => { execution = { model, effort }; } });
    const outcome = await done as { status: string };
    assert.equal(outcome.status, 'completed');
    assert.deepEqual(execution, { model: 'glm', effort: selected ? 'xhigh' : undefined });
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'args.json'), 'utf8')), [
      '-p', '--output-format', 'stream-json', '--include-partial-messages', '--permission-mode', 'plan',
      ...(selected ? ['--model', 'glm', '--effort', 'xhigh'] : []), '--', '--model is prompt text',
    ]);
  }
});

test('model cache coalesces concurrent requests, expires at ten minutes, and retries errors', async t => {
  let now = 100;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  let fail = false;
  const adapter = { kind: 'codex', async listModels() { calls++; if (fail) throw new Error('offline'); return []; } } as unknown as Adapter;
  const catalog = new ModelCatalog();
  await Promise.all([catalog.list(adapter), catalog.list(adapter)]);
  assert.equal(calls, 1);
  now += 600_000 - 1;
  await catalog.list(adapter);
  assert.equal(calls, 1);
  now++;
  fail = true;
  await assert.rejects(catalog.list(adapter), /offline/);
  fail = false;
  await catalog.list(adapter);
  assert.equal(calls, 3);
});

test('model cache retries synchronous discovery failures too', async () => {
  let calls = 0;
  const adapter = { kind: 'codex', listModels() {
    if (++calls === 1) throw new Error('offline');
    return Promise.resolve([]);
  } } as unknown as Adapter;
  const catalog = new ModelCatalog();
  await assert.rejects(catalog.list(adapter), /offline/);
  assert.deepEqual(await catalog.list(adapter), []);
  assert.equal(calls, 2);
});

test('task snapshots and terminal records preserve reported execution metadata', async () => {
  let sink!: TaskSink;
  const adapter = { kind: 'codex', async startTask(_opts: StartTaskOptions, next: TaskSink) { sink = next; return { cancel() {} }; } } as Adapter;
  const manager = new TaskManager([adapter], () => {});
  const task = await manager.start('codex', { cwd: '/tmp', prompt: 'go', permissionMode: 'readOnly' });
  sink.setModel!('actual-default', 'medium');
  assert.equal(manager.get(task.id).task.model, 'actual-default');
  assert.equal(manager.get(task.id).task.effort, 'medium');
  sink.finish({ status: 'completed', result: 'OK' });
  sink.setModel!('late-model', 'high');
  assert.equal(manager.list()[0].model, 'actual-default');
  assert.equal(manager.list()[0].effort, 'medium');
});

test('models RPC uses cached capabilities, validates tasks, fails open on discovery errors and respects disabled agents', async t => {
  t.mock.method(Server.prototype, 'listen', function (this: Server, ...args: any[]) { queueMicrotask(args.at(-1)); return this; });
  const cfg = { ...config, disabledAgents: [] as typeof config.disabledAgents };
  let calls = 0;
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  let fail = false;
  const models: ModelOption[] = [{ id: 'glm', name: 'GLM', isDefault: true, efforts: ['high'] }, { id: 'auto', name: 'Auto', isDefault: false }];
  const starts: StartTaskOptions[] = [];
  const adapter: Adapter = { kind: 'workbuddy', name: 'WorkBuddy', async detect() { throw new Error('unused'); },
    async listSessions() { return []; }, async getMessages() { return []; },
    async listModels() { calls++; if (fail) throw new Error('offline'); return models; },
    async startTask(options) { starts.push(options); return { cancel() {} }; } };
  const server = await startServer(cfg, [adapter, { ...adapter, kind: 'claude', listModels: undefined }], () => {});
  t.after(() => server.shutdown().catch(() => {}));
  const received: any[] = [];
  const phone = server.attachClient({ kind: 'local', remote: 'test', send: text => received.push(JSON.parse(text)), close() {} });
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const requestId = ++id;
    await phone.receive(JSON.stringify({ id: requestId, method, params }));
    return received.find(r => r.id === requestId);
  };
  assert.deepEqual((await rpc('agents.models', { agent: 'workbuddy' })).result, { agent: 'workbuddy', models });
  assert.deepEqual((await rpc('agents.models', { agent: 'claude' })).result.models, []);
  assert.deepEqual((await rpc('agents.models', { agent: 'workbuddy' })).result.models, models);
  const start = (selection: Record<string, unknown>) => rpc('tasks.start', { agent: 'workbuddy', cwd: '/tmp', prompt: 'go', ...selection });
  assert.equal((await start({ model: 'missing' })).error.message, 'Unknown model missing');
  assert.equal((await start({ model: 'glm', effort: 'low' })).error.message, "glm doesn't support effort low");
  assert.equal((await start({ model: 'auto', effort: 'high' })).error.message, "auto doesn't support effort high");
  assert.equal((await start({ effort: 'low' })).error.message, "glm doesn't support effort low");
  assert.equal((await start({ model: 2 })).error.message, 'Invalid model');
  const task = (await start({ model: 'glm', effort: 'high' })).result;
  assert.equal(task.model, 'glm');
  assert.equal(task.effort, 'high');
  assert.equal((await rpc('tasks.get', { taskId: task.id })).result.task.model, 'glm');
  assert.equal(starts[0].effort, 'high');
  assert.equal(calls, 1);
  const defaultTask = (await start({})).result;
  assert.equal(defaultTask.model, undefined);
  assert.equal(defaultTask.effort, undefined);
  assert.equal((await start({ effort: 'high' })).result.effort, 'high');
  now += 600_000;
  fail = true;
  assert.equal((await rpc('agents.models', { agent: 'workbuddy' })).error.message, 'offline');
  assert.equal((await start({ model: 'unknown-but-pass-through', effort: 'future' })).result.model, 'unknown-but-pass-through');
  assert.equal(starts.at(-1)!.effort, 'future');
  cfg.disabledAgents.push('workbuddy');
  assert.equal((await rpc('agents.models', { agent: 'workbuddy' })).error.message, 'WorkBuddy is turned off on this Mac.');
  assert.equal((await start({ model: 'glm' })).error.message, 'WorkBuddy is turned off on this Mac.');
});
