import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeApiProxy, settingsBaseUrl } from '../src/adapters/claudeProxy.ts';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import { runStreamJson } from '../src/adapters/streamJson.ts';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

test('Claude settings parsing tolerates missing env, malformed JSON and non-string endpoints', async () => {
  for (const text of ['', '{broken', '{}', 'null', '{"env":null}', '{"env":{"ANTHROPIC_BASE_URL":1}}']) {
    assert.equal(settingsBaseUrl(text), undefined);
  }
  assert.equal(settingsBaseUrl('{"env":{"ANTHROPIC_BASE_URL":"http://localhost:15721","ANTHROPIC_API_KEY":"secret"}}'), 'http://localhost:15721');
  const proxy = new ClaudeApiProxy({ env: {}, readSettings: async () => { throw Error('ENOENT'); }, connect: async () => { throw Error('must not probe'); } });
  assert.equal(await proxy.failure(), undefined);
});

test('process endpoint takes precedence, loopback TCP probes cache 10s and task starts bypass the cache', async () => {
  let now = 0, reachable = false, reads = 0;
  const calls: unknown[] = [];
  const proxy = new ClaudeApiProxy({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721/path' }, now: () => now,
    readSettings: async () => { reads++; return '{"env":{"ANTHROPIC_BASE_URL":"https://external.example"}}'; },
    connect: async (...args) => { calls.push(args); return reachable; } });
  const detail = "Claude Code's API proxy at 127.0.0.1:15721 isn't running. Start it on your Mac (for example cc-switch).";
  assert.equal(await proxy.failure(), detail);
  reachable = true;
  now = 9999;
  assert.equal(await proxy.failure(), detail);
  assert.equal(calls.length, 1);
  now = 10_000;
  assert.equal(await proxy.failure(), undefined);
  reachable = false;
  assert.equal(await proxy.failure(true), detail);
  assert.deepEqual(calls, Array(3).fill(['127.0.0.1', 15721, 1000]));
  assert.equal(reads, 0);
});

test('only loopback endpoints probe; endpoint changes invalidate cache and diagnostics exclude credentials', async () => {
  const env: NodeJS.ProcessEnv = {};
  const calls: unknown[] = [];
  const proxy = new ClaudeApiProxy({ env, readSettings: async () => '{"env":{"ANTHROPIC_BASE_URL":"http://localhost:1234"}}',
    connect: async (...args) => { calls.push(args); return false; } });
  assert.match((await proxy.failure())!, /localhost:1234/);
  env.ANTHROPIC_BASE_URL = 'https://user:secret@[::1]/private?key=secret';
  assert.equal(await proxy.failure(), "Claude Code's API proxy at [::1]:443 isn't running. Start it on your Mac (for example cc-switch).");
  assert.deepEqual(calls, [['localhost', 1234, 1000], ['::1', 443, 1000]]);
  for (const address of ['https://api.anthropic.com', 'http://192.168.1.1:1234', 'bad url', 'file://localhost/private']) {
    env.ANTHROPIC_BASE_URL = address;
    assert.equal(await proxy.failure(), undefined);
  }
  assert.equal(calls.length, 2);
});

test('unreachable Claude proxy marks detection needsLogin and finishes tasks before resolving/spawning the CLI', async t => {
  const ps = t.mock.method(childProcess, 'execFile', ((...args: any[]) => {
    assert.equal(args[0], 'ps');
    queueMicrotask(() => args.at(-1)(null, '', ''));
    return {};
  }) as any);
  syncBuiltinESMExports();
  t.after(() => { ps.mock.restore(); syncBuiltinESMExports(); });
  const proxy = new ClaudeApiProxy({ env: { ANTHROPIC_BASE_URL: 'http://localhost:1234' }, connect: async () => false });
  const adapter = new ClaudeAdapter(proxy);
  const resolve = t.mock.method(adapter as any, 'resolveBinary', async () => ({ bin: '/must-not-spawn', version: '2.1.295' }));
  const info = await adapter.detect();
  assert.equal(info.status, 'needsLogin');
  assert.match(info.detail!, /localhost:1234 isn't running/);
  const outcomes: any[] = [];
  await adapter.startTask({ cwd: '/tmp', prompt: 'test', permissionMode: 'readOnly' }, {
    finish: outcome => outcomes.push(outcome), emit() {}, delta() {}, setSession() {},
  });
  assert.deepEqual(outcomes, [{ status: 'failed', error: info.detail }]);
  assert.equal(resolve.mock.callCount(), 1, 'startTask did not resolve or start a binary');
});

test('Claude api_retry and stderr fallback report one safe status while preserving normal completion', async () => {
  for (const stderrOnly of [false, true]) {
    const events: any[] = [];
    const script = stderrOnly ? 'console.error("ECONNREFUSED; retrying"); console.error("retrying again");' :
      'for(let i=0;i<3;i++) console.log(JSON.stringify({type:"system",subtype:"api_retry",attempt:i,max_retries:10,retry_delay_ms:500,error:"unknown"}));';
    const outcome: any = await new Promise(resolve => {
      runStreamJson({ command: process.execPath, args: ['-e', script + 'setTimeout(()=>console.log(JSON.stringify({type:"result",subtype:"success",result:"ok"})),30)'],
        cwd: '/tmp', env: process.env, reportApiRetries: true }, {
        emit: e => events.push(e), delta() {}, setSession() {}, finish: resolve,
      });
    });
    assert.equal(outcome.status, 'completed');
    assert.deepEqual(events.filter(e => e.kind === 'status'), [{ kind: 'status', text: "Claude Code can't reach its API — retrying…" }]);
  }
});
