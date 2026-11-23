import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Server } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { config } from './accountHelpers.ts';
import type { Adapter, AgentKind } from '../src/types.ts';

test('file RPC parity over direct/relay, disabled agents, and path-free logging', async t => {
  t.mock.method(Server.prototype, 'listen', function(this: Server, ...args: any[]) { queueMicrotask(args.at(-1)); return this; });
  const cwd = await mkdtemp(join(tmpdir(), 'aa-content-rpc-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'test.txt'), Buffer.alloc(512 * 1024 + 10, 97));
  await writeFile(join(cwd, '.env'), 'secret-do-not-log');
  const adapter: Adapter = { kind: 'codex', name: 'ChatGPT',
    async detect() { return { kind: 'codex', name: 'ChatGPT', status: 'ready', runningProcesses: 0 }; },
    async listSessions() { return [{ id: 'session', agent: 'codex', title: 'Project', cwd, running: false, updatedAt: 1 }]; },
    async getMessages() { return []; }, async startTask() { return { cancel() {} }; } };
  const cfg = { ...config, disabledAgents: [] as AgentKind[] };
  const logs: string[] = [];
  const server = await startServer(cfg, [adapter], msg => logs.push(msg)); t.after(() => server.shutdown().catch(() => {}));
  for (const kind of ['local', 'relay'] as const) {
    const responses: any[] = [];
    const client = server.attachClient({ kind, remote: 'test', send(text) { responses.push(JSON.parse(text)); }, close() {} });
    let id = 0;
    const rpc = async (method: string, params: object) => {
      await client.receive(JSON.stringify({ id: ++id, method, params })); return responses.find(r => r.id === id);
    };
    assert.equal((await rpc('files.list', { agent: 'codex', cwd })).result.entries.length, 1);
    const response = await rpc('files.read', { cwd, path: 'test.txt' });
    assert.equal(response.result.eof, false); assert.equal(Buffer.from(response.result.data, 'base64').length, 512 * 1024);
    assert.ok(Buffer.byteLength(Buffer.from(JSON.stringify(response)).toString('base64')) < 1024 * 1024 - 200);
    assert.equal((await rpc('files.read', { cwd, path: 'test.txt', offset: 512 * 1024 })).result.eof, true);
    assert.match((await rpc('files.read', { cwd, path: '.env' })).error.message, /secrets/);
    assert.match((await rpc('files.list', { agent: 'codex', cwd: '/unknown/private' })).error.message, /Unknown project/);
    cfg.disabledAgents = ['codex'];
    for (const method of ['files.list', 'files.read']) assert.match((await rpc(method, { agent: 'codex', cwd, path: 'test.txt' })).error.message, /turned off/);
    cfg.disabledAgents = [];
    client.disconnect();
  }
  assert.ok(logs.every(line => !line.includes(cwd) && !line.includes('secret-do-not-log') && !line.includes('/unknown/private')));
});
