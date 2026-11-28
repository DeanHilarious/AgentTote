import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { AccountClient } from '../src/account.ts';
import {
  AgentFlowStore,
  computeCacheHitRate,
  normalizeAgentId,
  normalizeEventStatus,
  normalizeUsage,
} from '../src/agentFlow.ts';
import { createIpcController, ipcError } from '../src/ipc.ts';
import { startServer } from '../src/server.ts';
import { AGENT_KINDS, type Adapter, type AgentInfo, type PushMessage, type TaskInfo, type TaskSink } from '../src/types.ts';
import { config } from './accountHelpers.ts';

async function makeTempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('events.jsonl parsing, usage normalization, round deduplication, multi-round sum and spec truncation', async t => {
  assert.equal(normalizeAgentId('brain'), 'antigravity');
  assert.equal(normalizeAgentId('agy'), 'antigravity');
  assert.equal(normalizeAgentId('agy2'), 'agy2');
  assert.equal(normalizeAgentId('neon'), 'agy2');
  assert.equal(normalizeAgentId('gpt-5'), 'codex');
  assert.equal(normalizeAgentId('buddy'), 'codebuddy');
  assert.equal(normalizeAgentId('workbuddy'), 'workbuddy');
  assert.equal(normalizeAgentId('ark'), 'arkcli');

  assert.equal(normalizeEventStatus('started'), 'dispatched');
  assert.equal(normalizeEventStatus('submitted'), 'delivered');
  assert.equal(normalizeEventStatus('completed'), 'accepted');
  assert.equal(normalizeEventStatus('failed'), 'rejected');
  assert.equal(normalizeEventStatus('custom_note'), 'event');

  assert.equal(computeCacheHitRate(1000, 750), 75);
  assert.equal(computeCacheHitRate(250, 750), 75);

  const snake = normalizeUsage({
    input_tokens: 1000,
    output_tokens: 200,
    thinking_tokens: 50,
    cache_read_tokens: 600,
    total_tokens: 1250,
  }, 'events');
  assert.deepEqual(snake, {
    inputTokens: 1000,
    outputTokens: 200,
    thinkingTokens: 50,
    cacheReadTokens: 600,
    totalTokens: 1250,
    cacheHitRate: 60,
    source: 'events',
  });

  const camel = normalizeUsage({
    inputTokens: 400,
    outputTokens: 100,
    thinkingTokens: 25,
    cached: 200,
  }, 'events');
  assert.deepEqual(camel, {
    inputTokens: 400,
    outputTokens: 100,
    thinkingTokens: 25,
    cacheReadTokens: 200,
    totalTokens: 525,
    cacheHitRate: 50,
    source: 'events',
  });

  const root = await makeTempDir(t, 'af-primary-');
  const runDir = join(root, 'demo-run');
  await mkdir(runDir, { recursive: true });

  const lines = [
    '{malformed-json-line',
    JSON.stringify({
      t: '2026-11-26T10:00:00+0800',
      sub: 'step-1',
      event: 'dispatched',
      agent: 'agy2',
      model: 'gemini-4-neon',
      effort: 'high',
      round: 1,
      summary: 'Start step 1',
      usage: { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 500, total_tokens: 1100 },
    }),
    // Same round (1) with updated fuller usage -> replaces earlier round-1 usage instead of double-counting
    JSON.stringify({
      t: '2026-11-26T10:01:00+0800',
      sub: 'step-1',
      event: 'delivered',
      agent: 'neon',
      round: 1,
      summary: 'Delivered round 1',
      artifacts: ['a.ts'],
      usage: { inputTokens: 1200, outputTokens: 300, thinkingTokens: 100, cacheReadTokens: 600, totalTokens: 1600 },
    }),
    // Distinct round (2) -> summed with round 1
    JSON.stringify({
      t: '2026-11-26T10:02:00+0800',
      sub: 'step-1',
      event: 'accepted',
      round: 2,
      summary: 'Accepted round 2',
      artifacts: ['b.ts'],
      usage: { input: 800, output: 200, cached: 400, total: 1000 },
    }),
    JSON.stringify({
      t: '2026-11-26T10:03:00+0800',
      sub: 'step-2',
      event: 'accepted',
      agent: 'brain',
      model: 'orchestrator',
      round: 1,
      summary: 'Final review',
    }),
  ];
  await writeFile(join(runDir, 'events.jsonl'), lines.join('\n') + '\n', 'utf8');
  // Large spec (> 64 KB) to test truncation
  await writeFile(join(runDir, 'spec.md'), 'A'.repeat(70_000), 'utf8');

  const store = new AgentFlowStore({
    primaryRunsDir: root,
    codexRunsDir: join(root, 'no-codex-runs'),
    codexSessionsDir: join(root, 'no-codex-sessions'),
    probeBinary: () => undefined,
  });

  const snap = await store.snapshot();
  assert.equal(snap.summary.totalRuns, 1);
  assert.equal(snap.summary.acceptedRuns, 1);
  assert.equal(snap.summary.activeRuns, 0);
  assert.equal(snap.runs.length, 1);
  assert.equal(snap.runs[0]!.id, 'demo-run');
  assert.equal(snap.runs[0]!.source, 'agent-flow');
  assert.equal(snap.runs[0]!.status, 'accepted');
  assert.equal(snap.runs[0]!.nodeCount, 2);
  assert.equal(snap.runs[0]!.acceptedCount, 2);
  assert.equal(snap.runs[0]!.eventCount, 4);
  assert.equal(snap.runs[0]!.hasSpec, true);
  assert.deepEqual(snap.runs[0]!.artifacts, ['a.ts', 'b.ts']);
  // Round 1 (1200 in, 300 out, 100 think, 600 cache, 1600 total) + Round 2 (800 in, 200 out, 0 think, 400 cache, 1000 total)
  assert.deepEqual(snap.runs[0]!.usage, {
    inputTokens: 2000,
    outputTokens: 500,
    thinkingTokens: 100,
    cacheReadTokens: 1000,
    totalTokens: 2600,
    cacheHitRate: 50,
    source: 'events',
  });

  const detail = await store.getRun('demo-run');
  assert.equal(detail.nodes.length, 2);
  assert.equal(detail.nodes[0]!.agent, 'agy2');
  assert.equal(detail.nodes[0]!.durationMs, 120_000);
  assert.equal(detail.nodes[1]!.agent, 'antigravity');
  assert.ok(detail.spec && detail.spec.endsWith('[truncated]'));
  assert.ok(Buffer.byteLength(detail.spec, 'utf8') < 66_000);
});

test('historical codex-runs backfill token usage from log-*.txt and rollout-*.jsonl', async t => {
  const base = await makeTempDir(t, 'af-codex-');
  const codexRunsDir = join(base, 'codex-runs');
  const codexSessionsDir = join(base, 'codex-sessions');
  const runDir = join(codexRunsDir, 'legacy-fix');
  const sessionSubDir = join(codexSessionsDir, '2026', '11', '26');
  await mkdir(runDir, { recursive: true });
  await mkdir(sessionSubDir, { recursive: true });

  const uuid1 = '11111111-2222-3333-4444-555555555555';
  const uuid2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  await writeFile(
    join(runDir, 'events.jsonl'),
    [
      JSON.stringify({ t: '2026-11-26T09:00:00Z', sub: 's1', event: 'dispatched', agent: 'codex', model: 'gpt-5' }),
      JSON.stringify({ t: '2026-11-26T09:05:00Z', sub: 's1', event: 'accepted', agent: 'codex', summary: 'Done' }),
    ].join('\n') + '\n',
    'utf8',
  );
  await writeFile(join(runDir, 'log-s1.txt'), `Codex CLI\nsession id: ${uuid1}\nworking...\n`, 'utf8');
  await writeFile(join(runDir, 'log-s1-fix1.txt'), `Retry\nsession id: ${uuid2}\n`, 'utf8');

  await writeFile(
    join(sessionSubDir, `rollout-2026-11-26-${uuid1}.jsonl`),
    [
      JSON.stringify({ payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } } }),
      // Last token_count wins
      JSON.stringify({
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 5000,
              cached_input_tokens: 3000,
              output_tokens: 500,
              reasoning_output_tokens: 200,
              total_tokens: 5700,
            },
          },
        },
      }),
    ].join('\n') + '\n',
    'utf8',
  );

  await writeFile(
    join(sessionSubDir, `rollout-2026-11-26-${uuid2}.jsonl`),
    JSON.stringify({
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 600,
            output_tokens: 100,
            total_tokens: 1100,
          },
        },
      },
    }) + '\n',
    'utf8',
  );

  const store = new AgentFlowStore({
    primaryRunsDir: join(base, 'missing-primary'),
    codexRunsDir,
    codexSessionsDir,
    probeBinary: () => undefined,
  });

  const detail = await store.getRun('codex:legacy-fix');
  assert.equal(detail.id, 'codex:legacy-fix');
  assert.equal(detail.source, 'codex-runs');
  assert.equal(detail.nodes.length, 1);
  assert.deepEqual(detail.nodes[0]!.usage, {
    inputTokens: 6000,
    outputTokens: 600,
    thinkingTokens: 200,
    cacheReadTokens: 3600,
    totalTokens: 6800,
    cacheHitRate: 60,
    source: 'codex-session',
  });
  assert.deepEqual(detail.usage, detail.nodes[0]!.usage);
});

test('live bridge tasks synthesis, run sorting, limit summary, and unified team roster deduplication', async t => {
  const root = await makeTempDir(t, 'af-live-');
  const olderDir = join(root, 'older-done');
  const activeDir = join(root, 'active-disk');
  await mkdir(olderDir, { recursive: true });
  await mkdir(activeDir, { recursive: true });

  await writeFile(
    join(olderDir, 'events.jsonl'),
    JSON.stringify({ t: 2_000_000, sub: 'a', event: 'accepted', agent: 'claude' }) + '\n',
    'utf8',
  );
  await writeFile(
    join(activeDir, 'events.jsonl'),
    JSON.stringify({ t: 1_000_000, sub: 'b', event: 'dispatched', agent: 'agy2' }) + '\n',
    'utf8',
  );

  const bridgeAgents: AgentInfo[] = [
    { kind: 'claude', name: 'Claude Code', status: 'ready', runningProcesses: 2, version: '1.2.3', detail: 'ok' },
    { kind: 'codex', name: 'Codex', status: 'ready', runningProcesses: 1, version: '0.5.0' },
    { kind: 'workbuddy', name: 'WorkBuddy', status: 'needsLogin', runningProcesses: 0 },
    { kind: 'antigravity', name: 'Antigravity', status: 'ready', runningProcesses: 1 },
    { kind: 'cursor', name: 'Cursor', status: 'unavailable', runningProcesses: 0 },
  ];

  const liveTasks: TaskInfo[] = [
    {
      id: 'task-1',
      agent: 'claude',
      cwd: '/repo',
      prompt: 'Fix the flaky test',
      permissionMode: 'acceptEdits',
      model: 'claude-sonnet',
      status: 'running',
      startedAt: 1_500_000,
    },
    {
      id: 'task-2',
      agent: 'codex',
      cwd: '/repo',
      prompt: 'Audit security',
      permissionMode: 'readOnly',
      status: 'completed',
      startedAt: 1_400_000,
      endedAt: 1_450_000,
      result: 'Clean',
    },
    {
      id: 'task-3',
      agent: 'cursor',
      cwd: '/repo',
      prompt: 'Broken build',
      permissionMode: 'full',
      status: 'failed',
      startedAt: 1_300_000,
      endedAt: 1_310_000,
      error: 'Compile error',
    },
  ];

  const store = new AgentFlowStore({
    primaryRunsDir: root,
    codexRunsDir: join(root, 'none'),
    codexSessionsDir: join(root, 'none-s'),
    getBridgeAgents: () => bridgeAgents,
    getBridgeTasks: () => liveTasks,
    probeBinary: (names) => (names.includes('agy2') ? '/opt/homebrew/bin/agy2' : undefined),
  });

  // Limit to 2 runs, verify summary still reflects all 3 runs
  const snap = await store.snapshot(2);
  assert.equal(snap.summary.totalRuns, 3);
  assert.equal(snap.summary.activeRuns, 2);
  assert.equal(snap.summary.acceptedRuns, 1);
  assert.equal(snap.summary.liveTasksCount, 3);
  assert.equal(snap.liveTasks.length, 3);
  assert.equal(snap.runs.length, 2);
  // Running bridge-live must be first, followed by active-disk
  assert.equal(snap.runs[0]!.id, 'bridge-live');
  assert.equal(snap.runs[0]!.source, 'bridge-live');
  assert.equal(snap.runs[0]!.status, 'dispatched');
  assert.equal(snap.runs[1]!.id, 'active-disk');

  const liveDetail = await store.getRun('bridge-live');
  assert.equal(liveDetail.nodes.length, 3);
  assert.equal(liveDetail.nodes.find(n => n.id === 'task-1')?.status, 'dispatched');
  assert.equal(liveDetail.nodes.find(n => n.id === 'task-2')?.status, 'accepted');
  assert.equal(liveDetail.nodes.find(n => n.id === 'task-3')?.status, 'rejected');
  assert.equal(liveDetail.events.length, 5); // 1 for running + 2 each for completed/failed
  assert.equal(liveDetail.spec, null);

  // Team roster checks: no duplicate IDs (especially codex & antigravity)
  const ids = snap.team.map(m => m.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    ids.sort(),
    ['agy2', 'antigravity', 'arkcli', 'claude', 'codebuddy', 'codex', 'cursor', 'workbuddy'],
  );
  const antigravity = snap.team.find(m => m.id === 'antigravity')!;
  assert.equal(antigravity.tier, 'orchestrator');
  assert.equal(antigravity.isBridgeAgent, true);
  assert.equal(antigravity.accent, '#A78BFA');
  const codex = snap.team.find(m => m.id === 'codex')!;
  assert.equal(codex.isBridgeAgent, true);
  assert.equal(codex.tier, 'bridge');
  assert.equal(codex.version, '0.5.0');
  assert.equal(codex.accent, '#34D399');
  const agy2 = snap.team.find(m => m.id === 'agy2')!;
  assert.equal(agy2.isBridgeAgent, false);
  assert.equal(agy2.status, 'ready');
  assert.equal(agy2.detail, '/opt/homebrew/bin/agy2');
  assert.equal(snap.summary.totalMembers, 8);
  assert.equal(snap.summary.onlineMembers, 4); // claude, codex, antigravity, agy2

  // Fallback antigravity probe when bridge agents omit antigravity
  const fallbackStore = new AgentFlowStore({
    primaryRunsDir: root,
    getBridgeAgents: () => [{ kind: 'claude', name: 'Claude', status: 'ready', runningProcesses: 0 }],
    probeBinary: (names) => (names.includes('agy') ? '/usr/local/bin/agy' : undefined),
  });
  const fallbackTeam = await fallbackStore.getTeam();
  const fallbackBrain = fallbackTeam.find(m => m.id === 'antigravity')!;
  assert.equal(fallbackBrain.isBridgeAgent, false);
  assert.equal(fallbackBrain.tier, 'orchestrator');
  assert.equal(fallbackBrain.status, 'ready');
  assert.equal(fallbackBrain.detail, '/usr/local/bin/agy');
});

test('getRun rejects path traversal, malformed IDs, and symlink escapes', async t => {
  const base = await makeTempDir(t, 'af-sec-');
  const primaryRunsDir = join(base, 'runs');
  const outsideDir = join(base, 'outside');
  await mkdir(primaryRunsDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, 'events.jsonl'), JSON.stringify({ event: 'accepted' }) + '\n', 'utf8');
  await symlink(outsideDir, join(primaryRunsDir, 'escaped-link'));

  const store = new AgentFlowStore({
    primaryRunsDir,
    codexRunsDir: join(base, 'codex-runs'),
    probeBinary: () => undefined,
  });

  for (const badId of ['', ' ', '../etc/passwd', 'codex:../../etc', 'a/b', 'a\\b', 'codex:', '.hidden', 'ok\0bad', 'escaped-link']) {
    await assert.rejects(() => store.getRun(badId), /Invalid Agent-Flow run id|Unknown Agent-Flow run/);
  }
  await assert.rejects(() => store.getRun('does-not-exist'), /Unknown Agent-Flow run: does-not-exist/);
  await assert.rejects(() => store.getRun('bridge-live'), /Unknown Agent-Flow run: bridge-live/);
});

test('createIpcController handles agentFlow.snapshot, agentFlow.run, and Hub RPC allowlist', async t => {
  const dir = await makeTempDir(t, 'af-ipc-');
  const runsDir = join(dir, 'runs');
  await mkdir(join(runsDir, 'run-1'), { recursive: true });
  await writeFile(
    join(runsDir, 'run-1', 'events.jsonl'),
    JSON.stringify({ t: 1_700_000_000_000, sub: 'n1', event: 'accepted', agent: 'codex' }) + '\n',
    'utf8',
  );

  const flow = new AgentFlowStore({
    primaryRunsDir: runsDir,
    codexRunsDir: join(dir, 'none'),
    probeBinary: () => undefined,
  });

  const cfg = { ...config };
  const account = new AccountClient({ config: cfg, bridgeVersion: 'test', directory: dir });
  t.after(() => account.stop());

  const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const controller = createIpcController({
    cfg,
    account,
    adapters: [],
    server: { clientCount: () => 0, disconnectPairing() {} },
    emit() {},
    rememberToken() {},
    agentFlow: flow,
    callRpc: async (method, params) => {
      rpcCalls.push({ method, params });
      if (method === 'tasks.cancel') throw new Error(`Failed with ${cfg.token}`);
      return { ok: true, method, params };
    },
  });

  const snap = await controller.execute('agentFlow.snapshot', { limit: 10 }) as { runs: { id: string }[] };
  assert.equal(snap.runs.length, 1);
  assert.equal(snap.runs[0]!.id, 'run-1');

  for (const badLimit of [0, -5, 101, 1.5, '10', null]) {
    await assert.rejects(
      () => controller.execute('agentFlow.snapshot', { limit: badLimit }),
      err => ipcError(err).code === 'invalid_params',
    );
  }

  const run = await controller.execute('agentFlow.run', { id: 'run-1' }) as { id: string };
  assert.equal(run.id, 'run-1');

  await assert.rejects(
    () => controller.execute('agentFlow.run', {}),
    err => ipcError(err).code === 'invalid_params',
  );
  await assert.rejects(
    () => controller.execute('agentFlow.run', { id: 'missing-run' }),
    err => ipcError(err).code === 'not_found',
  );
  await assert.rejects(
    () => controller.execute('agentFlow.run', { id: '../etc/passwd' }),
    err => ipcError(err).code === 'invalid_params',
  );

  for (const method of ['agents.models', 'sessions.list', 'sessions.messages', 'projects.recent', 'tasks.start', 'tasks.list', 'tasks.get']) {
    const res = await controller.execute(method, { agent: 'claude' }) as { ok: boolean; method: string };
    assert.equal(res.ok, true);
    assert.equal(res.method, method);
  }
  assert.equal(rpcCalls.length, 7);

  await assert.rejects(
    () => controller.execute('tasks.cancel', { taskId: 'x' }),
    err => {
      const mapped = ipcError(err);
      assert.equal(mapped.code, 'rpc_error');
      assert.match(mapped.message, /Failed with/);
      return true;
    },
  );

  await assert.rejects(
    () => controller.execute('files.read', { path: '/etc/passwd' }),
    err => ipcError(err).code === 'unknown_method',
  );

  // Without callRpc, allowlisted methods return unavailable
  const noRpc = createIpcController({
    cfg,
    account,
    adapters: [],
    server: { clientCount: () => 0, disconnectPairing() {} },
    emit() {},
    rememberToken() {},
  });
  await assert.rejects(
    () => noRpc.execute('tasks.list', {}),
    err => ipcError(err).code === 'unavailable',
  );
});

test('startServer exposes agentFlow RPCs, callLocal without incrementing clientCount, and onBroadcast', async t => {
  t.mock.method(Server.prototype, 'listen', function (this: Server, ...args: any[]) {
    queueMicrotask(args.at(-1));
    return this;
  });

  const runsDir = await makeTempDir(t, 'af-server-');
  await mkdir(join(runsDir, 'srv-run'), { recursive: true });
  await writeFile(
    join(runsDir, 'srv-run', 'events.jsonl'),
    JSON.stringify({ t: 1_700_000_000_000, sub: 'build', event: 'accepted', agent: 'codex', summary: 'Built' }) + '\n',
    'utf8',
  );

  const sinks = new Map<string, TaskSink>();
  const adapters: Adapter[] = AGENT_KINDS.map(kind => ({
    kind,
    name: kind,
    async detect() { return { kind, name: kind, status: 'ready', runningProcesses: 0 }; },
    async listSessions() { return [{ id: `${kind}-s1`, agent: kind, title: kind, cwd: '/work', running: false, updatedAt: 100 }]; },
    async getMessages() { return []; },
    async startTask(_opts, sink) { sinks.set(kind, sink); return { cancel() {} }; },
  }));

  const server = await startServer(
    { ...config, disabledAgents: [] },
    adapters,
    () => {},
    () => ({}),
    () => {},
    undefined,
    undefined,
    { primaryRunsDir: runsDir, codexRunsDir: join(runsDir, 'no-codex'), probeBinary: () => undefined },
  );
  t.after(() => server.shutdown().catch(() => {}));

  const broadcasts: PushMessage[] = [];
  const unsub = server.onBroadcast(msg => broadcasts.push(msg));

  assert.equal(server.clientCount(), 0);
  const initialTasks = await server.callLocal('tasks.list') as TaskInfo[];
  assert.deepEqual(initialTasks, []);
  assert.equal(server.clientCount(), 0);

  // Start a task through callLocal (including non-legacy agent kind like cursor)
  const started = await server.callLocal('tasks.start', {
    agent: 'cursor',
    cwd: '/work',
    prompt: 'Run local hub task',
  }) as TaskInfo;
  assert.equal(started.agent, 'cursor');
  assert.equal(server.clientCount(), 0);
  assert.ok(broadcasts.some(b => b.event === 'task.updated' && b.data.id === started.id));

  // Snapshot via callLocal sees both srv-run and synthesized bridge-live
  const localSnap = await server.callLocal('agentFlow.snapshot', { limit: 10 }) as { runs: { id: string }[] };
  assert.equal(localSnap.runs[0]!.id, 'bridge-live');
  assert.ok(localSnap.runs.some(r => r.id === 'srv-run'));

  // WebSocket client RPC via attachClient
  const inbox: any[] = [];
  const client = server.attachClient({ kind: 'local', remote: 'test-ws', send: text => inbox.push(JSON.parse(text)), close() {} });
  assert.equal(server.clientCount(), 1);
  await client.receive(JSON.stringify({ id: 1, method: 'agentFlow.snapshot', params: { limit: 5 } }));
  const wsSnap = inbox.find(m => m.id === 1);
  assert.equal(wsSnap.error, undefined);
  assert.ok(wsSnap.result.runs.some((r: any) => r.id === 'srv-run'));

  await client.receive(JSON.stringify({ id: 2, method: 'agentFlow.run', params: { id: 'srv-run' } }));
  const wsRun = inbox.find(m => m.id === 2);
  assert.equal(wsRun.error, undefined);
  assert.equal(wsRun.result.id, 'srv-run');
  assert.equal(wsRun.result.nodes.length, 1);

  // Finish task and verify broadcast stops after unsubscribe
  const beforeFinish = broadcasts.length;
  sinks.get('cursor')!.finish({ status: 'completed', result: 'ok' });
  assert.ok(broadcasts.length > beforeFinish);
  assert.ok(broadcasts.slice(beforeFinish).some(b => b.event === 'task.updated' && b.data.status === 'completed'));

  unsub();
  const afterUnsub = broadcasts.length;
  server.agentsUpdated([{ kind: 'claude', name: 'claude', status: 'ready', runningProcesses: 0 }]);
  assert.equal(broadcasts.length, afterUnsub);

  client.disconnect();
  assert.equal(server.clientCount(), 0);
});
