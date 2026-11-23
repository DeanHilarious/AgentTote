import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamTextDeltas, runStreamJson } from '../src/adapters/streamJson.ts';
import { codexTextDelta } from '../src/adapters/codex.ts';
import { Server } from 'node:http';
import { startServer } from '../src/server.ts';
import { config } from './accountHelpers.ts';
import { TaskManager } from '../src/tasks.ts';
import type { Adapter, TaskSink, PushMessage } from '../src/types.ts';

function fixture() {
  let sink!: TaskSink;
  const pushes: PushMessage[] = [];
  const adapter: Adapter = {
    kind: 'claude', name: 'fake', detect: async () => { throw new Error('unused'); },
    listSessions: async () => [], getMessages: async () => [],
    startTask: async (_opts, s) => { sink = s; return { cancel() {} }; },
  };
  const manager = new TaskManager([adapter], msg => pushes.push(structuredClone(msg)));
  return { manager, adapter, pushes, get sink() { return sink; } };
}
const opts = { cwd: '/tmp', prompt: 'test', permissionMode: 'readOnly' as const };

// Tests the same stateful parser used by both CLI adapters.
test('stream_event filters subagents/thinking and switches message ids', () => {
  const deltas: [string, string][] = [];
  const parse = streamTextDeltas({ delta: (id, text) => deltas.push([id, text]) });
  const event = (event: object, parent_tool_use_id?: string) => parse({ type: 'stream_event', event, parent_tool_use_id });
  event({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'before start' } });
  event({ type: 'message_start', message: { id: 'one' } });
  event({ type: 'content_block_delta', delta: { type: 'text_delta', text: '你好😀' } });
  event({ type: 'message_start', message: { id: 'child' } }, 'tool');
  event({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hidden' } }, 'tool');
  event({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'secret' } });
  event({ type: 'content_block_delta', delta: { type: 'text_delta', text: ' parent' } });
  event({ type: 'message_start', message: { id: 'two' } });
  event({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'second' } });
  assert.deepEqual(deltas, [['one', '你好😀'], ['one', ' parent'], ['two', 'second']]);
  event({ type: 'message_start', message: {} });
  event({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'generated' } });
  assert.ok(deltas.at(-1)![0]);
  assert.notEqual(deltas.at(-1)![0], 'two');
});

test('Codex AgentMessageDeltaNotification maps itemId and delta only', () => {
  const deltas: [string, string][] = [];
  const sink = { delta: (id: string, text: string) => deltas.push([id, text]) };
  codexTextDelta({ threadId: 'thread', turnId: 'turn', itemId: 'item', delta: 'hello' }, sink);
  codexTextDelta({ itemId: 'item', text: 'wrong field' }, sink);
  codexTextDelta({ itemId: 1, delta: 'invalid' }, sink);
  assert.deepEqual(deltas, [['item', 'hello']]);
});

test('TaskManager batches at 50ms, uses UTF-16 offsets, snapshots without seq', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const f = fixture();
  const task = await f.manager.start('claude', opts);
  f.pushes.length = 0;
  f.sink.delta('one', '你😀');
  f.sink.delta('one', '好');
  const snapshot = f.manager.get(task.id);
  assert.deepEqual(snapshot.draft, { messageId: 'one', text: '你😀好' });
  assert.deepEqual(snapshot.events, []);
  t.mock.timers.tick(49);
  assert.equal(f.pushes.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(f.pushes, [{ event: 'task.delta', data: { taskId: task.id, messageId: 'one', text: '你😀好', offset: 0 } }]);
  f.sink.delta('one', '!');
  assert.equal(snapshot.draft?.text, '你😀好', 'snapshot is a value copy');
  t.mock.timers.tick(50);
  assert.deepEqual(f.pushes.at(-1), { event: 'task.delta', data: { taskId: task.id, messageId: 'one', text: '!', offset: 4 } });
  f.sink.emit({ kind: 'text', text: '你😀好!' });
  assert.equal(f.manager.get(task.id).draft, undefined);
  assert.equal(f.manager.get(task.id).events[0].seq, 1);
  assert.deepEqual(f.manager.get(task.id, 1).events, []);
});

test('2KB UTF-8 threshold flushes early but sustained pushes remain at most 20Hz', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const f = fixture();
  const task = await f.manager.start('claude', opts);
  f.pushes.length = 0;
  f.sink.delta('one', '你'.repeat(683));
  assert.equal(f.pushes.length, 1);
  f.sink.delta('one', 'x'.repeat(2048));
  assert.equal(f.pushes.length, 1);
  t.mock.timers.tick(49);
  assert.equal(f.pushes.length, 1);
  t.mock.timers.tick(1);
  assert.equal(f.pushes.length, 2);
  assert.equal(f.pushes[1].event === 'task.delta' && f.pushes[1].data.offset, 683);
  f.sink.delta('two', 'new');
  assert.deepEqual(f.manager.get(task.id).draft, { messageId: 'two', text: 'new' });
  t.mock.timers.tick(50);
  assert.equal(f.pushes.at(-1)?.event === 'task.delta' && (f.pushes.at(-1) as any).data.offset, 0);
});

test('final text, all terminal outcomes and start failures cancel pending draft pushes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    const f = fixture();
    const task = await f.manager.start('claude', opts);
    f.sink.delta('one', 'pending');
    f.sink.emit({ kind: 'text', text: 'final' });
    assert.equal(f.manager.get(task.id).draft, undefined);
    f.sink.delta('two', 'pending again');
    f.sink.finish({ status });
    f.sink.delta('late', 'ignored');
    t.mock.timers.tick(100);
    assert.equal(f.manager.get(task.id).draft, undefined);
    assert.equal(f.pushes.filter(p => p.event === 'task.delta').length, 0);
  }
  const bad: Adapter = { kind: 'claude', name: 'bad', detect: async () => { throw Error(); }, listSessions: async () => [], getMessages: async () => [],
    startTask: async (_opts, sink) => { sink.delta('one', 'pending'); throw Error('start failed'); } };
  const pushes: PushMessage[] = [];
  const manager = new TaskManager([bad], p => pushes.push(p));
  const task = await manager.start('claude', opts);
  t.mock.timers.tick(100);
  assert.equal(task.status, 'failed');
  assert.equal(manager.get(task.id).draft, undefined);
  assert.equal(pushes.filter(p => p.event === 'task.delta').length, 0);
});

test('legacy WorkBuddy retries unknown partial flag exactly once', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aa-partial-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'cli.cjs');
  await writeFile(script, `const fs = require('fs'); fs.appendFileSync('attempts', 'x');
    if (process.argv.includes('--include-partial-messages')) { console.error("error: unknown option '--include-partial-messages'"); process.exit(1); }
    console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'final'}]}}));
    console.log(JSON.stringify({type:'result',subtype:'success',result:'final'}));`);
  const events: object[] = [];
  const outcome = await new Promise<any>(resolve => {
    runStreamJson({ command: process.execPath, args: [script, '--include-partial-messages'], cwd: directory, env: process.env, retryWithoutPartialMessages: true }, {
      delta() {}, emit: e => events.push(e), setSession() {}, finish: resolve,
    });
  });
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(join(directory, 'attempts'), 'utf8'), 'xx');
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(events[0], { kind: 'text', text: 'final' });
});

test('tasks.get snapshot aligns the next delta offset, including a throttled pending batch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const f = fixture();
  const task = await f.manager.start('claude', opts);
  f.pushes.length = 0;
  f.sink.delta('one', 'prefix');
  const first = await f.manager.snapshot(task.id);
  assert.equal(first.draft?.text, 'prefix');
  assert.equal(f.pushes.length, 1, 'pending delta precedes the snapshot reply');
  f.sink.delta('one', ' suffix');
  const waiting = f.manager.snapshot(task.id);
  t.mock.timers.tick(49);
  assert.equal(f.pushes.length, 1, 'snapshot respects the 20Hz limit');
  t.mock.timers.tick(1);
  const snapshot = await waiting;
  assert.equal(snapshot.draft?.text, 'prefix suffix');
  f.sink.delta('one', '!');
  t.mock.timers.tick(50);
  assert.equal(f.pushes.at(-1)?.event === 'task.delta' && (f.pushes.at(-1) as any).data.offset, snapshot.draft?.text.length);
  assert.deepEqual(snapshot.events, []);
});


test('tasks.get RPC returns the aligned draft and deltas never enter logs or seq replay', async t => {
  // Exercise the actual RPC dispatcher with an in-memory authenticated transport;
  // suppress only socket binding so this test also runs in restricted environments.
  t.mock.method(Server.prototype, 'listen', function (this: Server, ...args: any[]) {
    queueMicrotask(() => args.at(-1)());
    return this;
  });
  const f = fixture();
  const logs: string[] = [];
  const messages: any[] = [];
  const server = await startServer({ ...config, port: 0 }, [f.adapter], text => logs.push(text));
  t.after(() => { server.emit('close'); server.close(() => {}); });
  const connection = server.attachClient({ kind: 'relay', remote: 'test',
    send: text => messages.push(JSON.parse(text)), close() {}, });
  await connection.receive(JSON.stringify({ id: 1, method: 'tasks.start', params: { agent: 'claude', ...opts } }));
  const taskId = messages.find(m => m.id === 1).result.id;
  f.sink.delta('one', 'private draft');
  await connection.receive(JSON.stringify({ id: 2, method: 'tasks.get', params: { taskId, sinceSeq: 0 } }));
  const reply = messages.find(m => m.id === 2);
  assert.deepEqual(reply.result.draft, { messageId: 'one', text: 'private draft' });
  assert.deepEqual(reply.result.events, []);
  const deltaIndex = messages.findIndex(m => m.event === 'task.delta');
  assert.ok(deltaIndex >= 0 && deltaIndex < messages.indexOf(reply));
  f.sink.emit({ kind: 'text', text: 'private final' });
  await connection.receive(JSON.stringify({ id: 3, method: 'tasks.get', params: { taskId, sinceSeq: 0 } }));
  const final = messages.find(m => m.id === 3).result;
  assert.equal(final.draft, undefined);
  assert.equal(final.events.length, 1);
  assert.equal(final.events[0].seq, 1);
  assert.ok(logs.every(line => !line.includes('private')));
  f.sink.finish({ status: 'completed' });
  connection.disconnect();
});
