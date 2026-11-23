import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectFiles, FILE_CHUNK, FILE_LIMIT, SECRET_ERROR, fileMime } from '../src/files.ts';
import { codexFileEvents } from '../src/adapters/codex.ts';
import { streamFileEvent } from '../src/adapters/streamJson.ts';
import { TaskManager } from '../src/tasks.ts';
import type { Adapter, AgentKind, TaskEventBody, TaskSink } from '../src/types.ts';

test('files authorize known sessions, realpath boundaries, secrets, hidden files, chunks and limits', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'aa-files-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'project'); await mkdir(root); await mkdir(join(root, 'dir')); await mkdir(join(root, '.git')); await mkdir(join(root, '.ssh'));
  await writeFile(join(temp, 'outside'), 'outside'); await symlink(join(temp, 'outside'), join(root, 'escape'));
  await writeFile(join(root, 'a.txt'), 'abc'); await symlink(join(root, 'a.txt'), join(root, 'alias'));
  const secrets = ['.env', '.env.local', 'a.pem', 'a.key', 'a.p8', 'a.p12', 'id_rsa.pub', 'id_ed25519', '.npmrc', '.netrc', '.git-credentials', '.ssh/config'];
  for (const name of [...secrets, '.hidden', '.git/config']) await writeFile(join(root, name), 'SECRET');
  await symlink(join(root, '.env'), join(root, 'secret-alias'));
  let disabled: AgentKind[] = [], now = 0, scans = 0;
  const adapter = { kind: 'codex', name: 'ChatGPT', async listSessions() { scans++; return [{ agent: 'codex', id: 's', cwd: root, title: 'project', running: false, updatedAt: 1 }]; }, async detect() { return { kind: 'codex', name: 'ChatGPT', status: 'ready', runningProcesses: 0 }; }, async getMessages() { return []; }, async startTask() { return { cancel() {} }; } } as Adapter;
  const files = new ProjectFiles(() => [adapter], () => disabled, () => now);
  const p = { cwd: root, agent: 'codex' as const, sessionId: 's' };
  const list = await files.list(p);
  assert.equal(list.entries[0]?.name, 'dir'); assert.ok(!list.entries.some(e => e.hidden));
  assert.equal(list.entries.find(e => e.name === 'escape')?.blocked, true);
  assert.equal(list.entries.find(e => e.name === 'secret-alias')?.blocked, true);
  assert.equal(Buffer.from((await files.read({ ...p, path: 'alias' })).data, 'base64').toString(), 'abc');
  const hidden = await files.list({ ...p, showHidden: true });
  assert.ok(hidden.entries.some(e => e.name === '.hidden')); assert.ok(!hidden.entries.some(e => e.name === '.git'));
  for (const path of secrets) await assert.rejects(files.read({ ...p, path }), { message: SECRET_ERROR });
  assert.equal(hidden.entries.find(e => e.name === '.ssh')?.blocked, true);
  for (const path of ['../outside', join(temp, 'outside'), 'escape']) await assert.rejects(files.read({ ...p, path }), /outside the project/);
  await assert.rejects(files.read({ ...p, path: '.git/config' }), /not available/);
  await assert.rejects(files.list({ ...p, cwd: temp }), /Unknown project/);
  assert.ok((await files.list({ cwd: root, agent: 'claude', sessionId: 'new-session' })).entries.length, 'Known projects can be shared with another enabled agent');
  await assert.rejects(files.read({ ...p, path: 'a.txt', offset: -1 }), /Invalid file range/);
  const large = Buffer.alloc(FILE_CHUNK + 7, 97); await writeFile(join(root, 'large'), large);
  const first = await files.read({ ...p, path: 'large', length: FILE_LIMIT });
  assert.equal(first.eof, false); assert.equal(Buffer.from(first.data, 'base64').length, FILE_CHUNK);
  const last = await files.read({ ...p, path: 'large', offset: FILE_CHUNK });
  assert.equal(last.eof, true); assert.equal(Buffer.from(last.data, 'base64').length, 7);
  await truncate(join(root, 'large'), FILE_LIMIT + 1);
  await assert.rejects(files.read({ ...p, path: 'large' }), /20 MiB/);
  assert.equal(scans, 1); now = 60_001; await files.list(p); assert.equal(scans, 2);
  disabled = ['codex']; await assert.rejects(files.list(p), /turned off/); await assert.rejects(files.read({ cwd: root, path: 'a.txt' }), /turned off/);
  disabled = []; await Promise.all(Array.from({ length: 505 }, (_, i) => writeFile(join(root, `entry-${i}`), '')));
  const truncated = await files.list(p); assert.equal(truncated.entries.length, 500); assert.equal(truncated.truncated, true);
  assert.equal(fileMime('code.unknown', Buffer.from('let x = 1')), 'text/plain');
  assert.equal(fileMime('data.unknown', Buffer.from([0, 1, 2])), 'application/octet-stream');
});

test('Codex fileChange protocol and Claude/WorkBuddy tool_use fields preserve tool events and last change', async () => {
  const events: TaskEventBody[] = []; const sink = { emit: (e: TaskEventBody) => events.push(e) };
  codexFileEvents({ type: 'fileChange', status: 'completed', changes: [
    { path: 'a', kind: { type: 'add' } }, { path: 'b', kind: { type: 'delete' } },
    { path: 'c', kind: { type: 'update', move_path: 'd' } },
  ] }, '/project', sink);
  assert.deepEqual(events.map(e => e.kind === 'file' && [e.path, e.change]), [['/project/a', 'created'], ['/project/b', 'deleted'], ['/project/c', 'deleted'], ['/project/d', 'created']]);
  codexFileEvents({ type: 'fileChange', status: 'failed', changes: [{ path: 'no', kind: { type: 'add' } }] }, '/project', sink);
  assert.equal(events.length, 4);
  for (const agent of ['claude', 'workbuddy'] as const) {
    let taskSink!: TaskSink;
    const adapter = { kind: agent, async startTask(_opts: unknown, s: TaskSink) { taskSink = s; return { cancel() {} }; } } as Adapter;
    const manager = new TaskManager([adapter], () => {});
    const task = await manager.start(agent, { cwd: '/project', prompt: 'go', permissionMode: 'acceptEdits' });
    for (const name of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      taskSink.emit({ kind: 'tool', name });
      streamFileEvent({ type: 'tool_use', name, input: { file_path: 'file' } }, '/project', taskSink);
    }
    const saved = manager.get(task.id).events;
    assert.equal(saved.filter(e => e.kind === 'tool').length, 4);
    assert.deepEqual(saved.filter(e => e.kind === 'file').map(e => [e.path, e.change]), [['/project/file', 'modified']]);
  }
});

test('Claude/WorkBuddy stream-json assistant blocks append file events alongside tool events', async () => {
  const { runStreamJson } = await import('../src/adapters/streamJson.ts');
  for (const agent of ['Claude', 'WorkBuddy']) {
    const events: TaskEventBody[] = [];
    await new Promise<void>(resolve => runStreamJson({ command: process.execPath, cwd: '/tmp', env: process.env, args: ['-e', `
      console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'Write',input:{file_path:'/tmp/example.md'}}]}}));
      console.log(JSON.stringify({type:'result',subtype:'success',result:'done'}));
    `] }, { emit: e => events.push(e), delta() {}, setSession() {}, finish: () => resolve() }));
    assert.equal(events[0]?.kind, 'tool', agent);
    assert.deepEqual(events[1], { kind: 'file', path: '/tmp/example.md', change: 'created' }, agent);
  }
});
