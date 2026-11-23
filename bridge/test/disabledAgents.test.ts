import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AccountClient } from '../src/account.ts';
import { loadConfig, writePrivateFile } from '../src/config.ts';
import { createIpcController, ipcError } from '../src/ipc.ts';
import { bridgeHello, startServer } from '../src/server.ts';
import { AGENT_KINDS, type Adapter, type TaskSink } from '../src/types.ts';
import { config } from './accountHelpers.ts';

test('agent switches govern RPC, detection, IPC and all phone transports without losing tasks', async t => {
  // Exercise the real RPC transport and task manager without opening a listening socket.
  t.mock.method(Server.prototype, 'listen', function (this: Server, ...args: any[]) {
    queueMicrotask(args.at(-1));
    return this;
  });
  const directory = await mkdtemp(join(tmpdir(), 'aa-agents-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cfg = { ...config, disabledAgents: [] };
  const account = new AccountClient({ config: cfg, bridgeVersion: 'test', directory });
  t.after(() => account.stop());
  const calls: string[] = [];
  const sinks = new Map<string, TaskSink>();
  const adapters: Adapter[] = AGENT_KINDS.map(kind => ({
    kind, name: kind === 'claude' ? 'Claude Code' : kind,
    async detect() { calls.push(`detect:${kind}`); return { kind, name: this.name, status: 'ready', runningProcesses: 0 }; },
    async listSessions() { calls.push(`sessions:${kind}`); return [{ id: kind, agent: kind, title: kind, cwd: `/${kind}`, running: false, updatedAt: 1 }]; },
    async getMessages() { calls.push(`messages:${kind}`); return []; },
    async startTask(_opts, sink) { calls.push(`start:${kind}`); sinks.set(kind, sink); return { cancel() {} }; },
  }));
  const server = await startServer(cfg, adapters, () => {});
  t.after(() => server.shutdown().catch(() => {}));
  const local: any[] = [], relay: any[] = [], events: any[] = [];
  const phone = server.attachClient({ kind: 'local', remote: 'test', send: text => local.push(JSON.parse(text)), close() {} });
  const relayPhone = server.attachClient({ kind: 'relay', remote: 'test', send: text => relay.push(JSON.parse(text)), close() {} });
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const requestId = ++id;
    await phone.receive(JSON.stringify({ id: requestId, method, params: method === 'hello' ? { agents: AGENT_KINDS, ...params } : params }));
    return local.find(value => value.id === requestId);
  };
  await rpc('hello');
  await relayPhone.receive(JSON.stringify({ id: 0, method: 'hello', params: { agents: AGENT_KINDS } }));
  const controller = createIpcController({ cfg, account, adapters, server,
    emit: (event, data) => events.push({ event, data }), rememberToken() {}, hosts: [],
    persist: next => writePrivateFile('bridge.json', JSON.stringify(next), directory) });
  await controller.refresh();
  const running = (await rpc('tasks.start', { agent: 'claude', cwd: '/tmp', prompt: 'go' })).result;
  await controller.execute('config.set', { disabledAgents: ['claude'] });
  calls.length = 0;
  assert.deepEqual((await rpc('hello')).result.agents.map((a: any) => a.kind), ['codex', 'workbuddy', 'antigravity', 'cursor']);
  assert.deepEqual((await rpc('agents.list')).result.map((a: any) => a.kind), ['codex', 'workbuddy', 'antigravity', 'cursor']);
  assert.deepEqual((await rpc('projects.recent')).result.map((p: any) => p.path), ['/codex', '/workbuddy', '/antigravity', '/cursor']);
  for (const method of ['sessions.list', 'sessions.messages', 'tasks.start']) {
    assert.equal((await rpc(method, { agent: 'claude', sessionId: 'claude', prompt: 'go' })).error.message,
      'Claude Code is turned off on this Mac.');
  }
  await controller.refresh();
  assert.ok(calls.every(call => !call.endsWith(':claude')), 'Disabled adapters must not be probed or read');
  assert.equal((await rpc('tasks.get', { taskId: running.id })).result.task.status, 'running');
  sinks.get('claude')!.finish({ status: 'completed', result: 'done' });
  assert.equal((await rpc('tasks.get', { taskId: running.id })).result.task.result, 'done');
  assert.equal((await rpc('tasks.list')).result.find((task: any) => task.id === running.id).status, 'completed');
  const agentEvent = events.filter(e => e.event === 'agents').at(-1);
  assert.deepEqual(agentEvent.data.map((a: any) => [a.kind, a.enabled]), [['claude', false], ['codex', true], ['workbuddy', true], ['antigravity', true], ['cursor', true]]);
  assert.deepEqual(controller.status().disabledAgents, ['claude']);
  for (const received of [local, relay]) {
    const updated = received.filter(e => e.event === 'agents.updated').at(-1);
    assert.deepEqual(updated.data.map((a: any) => a.kind), ['codex', 'workbuddy', 'antigravity', 'cursor']);
  }
  assert.deepEqual((await loadConfig({ directory })).disabledAgents, ['claude']);
  await controller.execute('config.set', { disabledAgents: ['claude', 'workbuddy', 'antigravity', 'cursor'] });
  await assert.rejects(controller.execute('config.set', { disabledAgents: [...AGENT_KINDS] }), error => {
    assert.equal(ipcError(error).message, 'Keep at least one agent turned on.');
    return true;
  });
  assert.deepEqual((await loadConfig({ directory })).disabledAgents, ['claude', 'workbuddy', 'antigravity', 'cursor']);
  const restartedConfig = await loadConfig({ directory });
  calls.length = 0;
  const restarted = createIpcController({ cfg: restartedConfig, account, adapters, server,
    emit() {}, rememberToken() {}, hosts: [], persist: async () => {} });
  await restarted.refresh();
  assert.deepEqual(calls, ['detect:codex']);
  assert.deepEqual(restarted.status().agents.map(a => a.enabled), [false, true, false, false, false]);
  for (const invalid of [['unknown'], 'claude', null]) {
    await assert.rejects(controller.execute('config.set', { disabledAgents: invalid }), /Expected disabledAgents/);
  }
  await controller.execute('config.set', { disabledAgents: [] });
  assert.equal(local.filter(e => e.event === 'agents.updated').at(-1).data.length, 5);
  assert.equal((await rpc('sessions.list', { agent: 'claude' })).result.length, 1);
  assert.equal((await rpc('sessions.messages', { agent: 'claude', sessionId: 'claude' })).error, undefined);
});

test('phones that do not list agents in hello never see agents their build cannot decode', async t => {
  t.mock.method(Server.prototype, 'listen', function (this: Server, ...args: any[]) {
    queueMicrotask(args.at(-1));
    return this;
  });
  const cfg = { ...config, disabledAgents: [] };
  const sinks = new Map<string, TaskSink>();
  const adapters: Adapter[] = AGENT_KINDS.map(kind => ({
    kind, name: kind === 'antigravity' ? 'Antigravity' : kind,
    async detect() { return { kind, name: this.name, status: 'ready', runningProcesses: 0 }; },
    async listSessions() { return [{ id: kind, agent: kind, title: kind, cwd: `/${kind}`, running: false, updatedAt: 1 }]; },
    async getMessages() { return []; },
    async startTask(_opts, sink) { sinks.set(kind, sink); return { cancel() {} }; },
  }));
  const server = await startServer(cfg, adapters, () => {});
  t.after(() => server.shutdown().catch(() => {}));
  const phones = { legacy: [] as any[], current: [] as any[], beforeCursor: [] as any[] };
  const connect = (inbox: any[]) => {
    const conn = server.attachClient({ kind: 'relay', remote: 'test', send: text => inbox.push(JSON.parse(text)), close() {} });
    let id = 0;
    return async (method: string, params: Record<string, unknown> = {}) => {
      const requestId = ++id;
      await conn.receive(JSON.stringify({ id: requestId, method, params }));
      return inbox.find(value => value.id === requestId);
    };
  };
  const legacy = connect(phones.legacy), current = connect(phones.current);
  const beforeCursor = connect(phones.beforeCursor);
  const kinds = (list: any[]) => list.map(a => a.kind);
  const shipped = ['claude', 'codex', 'workbuddy'];

  assert.deepEqual(kinds((await legacy('hello')).result.agents), shipped);
  const fourAgents = [...shipped, 'antigravity'];
  assert.deepEqual(kinds((await beforeCursor('hello', { agents: fourAgents })).result.agents), fourAgents);
  assert.deepEqual(kinds((await current('hello', { agents: [...AGENT_KINDS, 'future'] })).result.agents), [...AGENT_KINDS]);
  assert.deepEqual(kinds((await legacy('agents.list')).result), shipped);
  assert.deepEqual((await legacy('projects.recent')).result.map((p: any) => p.path), ['/claude', '/codex', '/workbuddy']);
  assert.equal((await legacy('sessions.list', { agent: 'antigravity' })).error.message,
    'Update AgentTote on your iPhone to use Antigravity.');
  assert.equal((await current('sessions.list', { agent: 'antigravity' })).result.length, 1);

  const task = (await current('tasks.start', { agent: 'antigravity', cwd: '/tmp', prompt: 'go' })).result;
  sinks.get('antigravity')!.emit({ kind: 'text', text: 'hi' });
  server.agentsUpdated(adapters.map(a => ({ kind: a.kind, name: a.name, status: 'ready', runningProcesses: 0 })));
  assert.deepEqual((await legacy('tasks.list')).result, []);
  assert.equal((await legacy('tasks.get', { taskId: task.id })).error.message, `Unknown task ${task.id}`);
  assert.equal((await current('tasks.list')).result.length, 1);

  const pushes = (inbox: any[]) => inbox.filter(m => m.event);
  assert.ok(pushes(phones.legacy).every(m => !JSON.stringify(m).includes('antigravity') && m.data?.taskId !== task.id));
  assert.deepEqual(kinds(pushes(phones.legacy).find(m => m.event === 'agents.updated').data), shipped);
  assert.ok(pushes(phones.current).some(m => m.event === 'task.event' && m.data.taskId === task.id));
  assert.deepEqual(kinds(pushes(phones.current).find(m => m.event === 'agents.updated').data), [...AGENT_KINDS]);
  const cursorTask = (await current('tasks.start', { agent: 'cursor', cwd: '/tmp', prompt: 'go' })).result;
  sinks.get('cursor')!.emit({ kind: 'text', text: 'cursor reply' });
  assert.deepEqual(kinds((await beforeCursor('agents.list')).result), fourAgents);
  assert.match((await beforeCursor('sessions.list', { agent: 'cursor' })).error.message, /Update AgentTote/);
  assert.equal((await beforeCursor('tasks.get', { taskId: cursorTask.id })).error.message, `Unknown task ${cursorTask.id}`);
  assert.ok(pushes(phones.beforeCursor).every(m => !JSON.stringify(m).includes('cursor') && m.data?.taskId !== cursorTask.id));
});

test('hello excludes an agent switched off while its detection was in flight', async () => {
  const cfg = { ...config, disabledAgents: [] as typeof config.disabledAgents };
  let finish!: () => void;
  const adapter = { kind: 'claude', async detect() {
    await new Promise<void>(resolve => { finish = resolve; });
    return { kind: 'claude', name: 'Claude Code', status: 'ready', runningProcesses: 0 };
  } } as Adapter;
  const hello = bridgeHello(cfg, [adapter]);
  cfg.disabledAgents = ['claude'];
  finish();
  assert.deepEqual((await hello).agents, []);
});

test('a concurrent hello also includes an agent just turned back on', async () => {
  const cfg = { ...config, disabledAgents: ['claude'] as typeof config.disabledAgents };
  let finish!: () => void;
  let checks = 0;
  const adapters = ['claude', 'codex'].map(kind => ({ kind, async detect() {
    if (kind === 'codex' && checks++ === 0) await new Promise<void>(resolve => { finish = resolve; });
    return { kind, name: kind, status: 'ready', runningProcesses: 0 };
  } })) as Adapter[];
  const hello = bridgeHello(cfg, adapters);
  cfg.disabledAgents = [];
  finish();
  assert.deepEqual((await hello).agents.map(a => a.kind), ['claude', 'codex']);
});

test('CLI overrides persist through reload and cannot disable the last agent', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aa-agent-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual((await loadConfig({ directory })).disabledAgents, []);
  await loadConfig({ directory, disableAgent: 'claude' });
  assert.deepEqual((await loadConfig({ directory })).disabledAgents, ['claude']);
  await loadConfig({ directory, disableAgent: 'workbuddy' });
  await loadConfig({ directory, disableAgent: 'antigravity' });
  await loadConfig({ directory, disableAgent: 'cursor' });
  await assert.rejects(loadConfig({ directory, disableAgent: 'codex' }), /Keep at least one agent turned on\./);
  await assert.rejects(loadConfig({ directory, enableAgent: 'other' }), /Unknown agent/);
  await assert.rejects(loadConfig({ directory, disableAgent: 'other' }), /Unknown agent/);
  assert.deepEqual((await loadConfig({ directory, enableAgent: 'claude' })).disabledAgents, ['workbuddy', 'antigravity', 'cursor']);
  assert.deepEqual((await loadConfig({ directory })).disabledAgents, ['workbuddy', 'antigravity', 'cursor']);
});
