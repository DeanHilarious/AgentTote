import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAssistantText, claudeUserText } from '../src/adapters/claude.ts';
import { runStreamJson } from '../src/adapters/streamJson.ts';
import { pairingUrl } from '../src/config.ts';
import { bridgeHello, BRIDGE_VERSION } from '../src/server.ts';
import { config } from './accountHelpers.ts';
import type { TaskEventBody, TaskSink } from '../src/types.ts';

test('claudeUserText keeps typed prompts and skips tool results, reminders and sidechains', () => {
  assert.equal(claudeUserText({ type: 'user', message: { content: 'fix the bug' } }), 'fix the bug');
  assert.equal(claudeUserText({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }), undefined);
  assert.equal(claudeUserText({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }), undefined);
  assert.equal(claudeUserText({ type: 'user', isSidechain: true, message: { content: 'sub-agent' } }), undefined);
  assert.equal(
    claudeUserText({ type: 'user', message: { content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }, { type: 'text', text: 'real ask' }] } }),
    'real ask',
  );
});

test('claudeAssistantText joins text blocks and ignores thinking/tool_use', () => {
  const entry = { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Done.' }, { type: 'tool_use', name: 'Bash' }] } };
  assert.equal(claudeAssistantText(entry), 'Done.');
});

test('pairingUrl carries everything the phone needs', () => {
  const url = new URL(pairingUrl({ ...config, name: 'My Mac', port: 8787, token: 'tok_123', publicKey: 'pinned-public-key' }, [{ address: '192.168.1.2', kind: 'lan' }, { address: '100.100.1.1', kind: 'tailscale' }]));
  assert.equal(url.protocol, 'agentanywhere:');
  assert.equal(url.searchParams.get('pk'), 'pinned-public-key');
  assert.equal(url.searchParams.get('name'), 'My Mac');
  assert.equal(url.searchParams.get('token'), 'tok_123');
  assert.equal(url.searchParams.get('hosts'), '192.168.1.2,100.100.1.1');
  assert.equal(url.searchParams.get('device'), config.deviceId);
  assert.equal(url.searchParams.get('port'), '8787');
});

test('hello identifies same-named bridges by stable deviceId', async () => {
  const first = await bridgeHello(config, []);
  const otherId = '201af8d6-9829-4347-809d-978bc860ed53';
  const second = await bridgeHello({ ...config, deviceId: otherId }, []);
  assert.equal(first.name, second.name);
  assert.equal(first.deviceId, config.deviceId);
  assert.equal(second.deviceId, otherId);
  assert.equal(first.version, BRIDGE_VERSION);
  assert.deepEqual(first.agents, []);
  assert.equal((await bridgeHello({ ...config, name: 'Renamed Mac' }, [])).deviceId, first.deviceId);
});

function collectingSink() {
  const events: TaskEventBody[] = [];
  let session: string | undefined;
  let outcome: Parameters<TaskSink['finish']>[0] | undefined;
  let resolveDone: () => void;
  const done = new Promise<void>(r => (resolveDone = r));
  const sink: TaskSink = {
    delta: () => {},
    emit: e => events.push(e),
    setSession: id => (session = id),
    finish: o => {
      outcome = o;
      resolveDone();
    },
  };
  return { sink, events, done, get session() { return session; }, get outcome() { return outcome; } };
}

async function fakeAgent(lines: object[], exitCode = 0): Promise<string> {
  const path = join(tmpdir(), `fake-agent-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(path, `for (const l of ${JSON.stringify(lines.map(l => JSON.stringify(l)))}) console.log(l);\nprocess.exit(${exitCode});\n`);
  return path;
}

test('runStreamJson maps a successful stream-json run to task events', async () => {
  const script = await fakeAgent([
    { type: 'system', subtype: 'init', session_id: 'sess-1' },
    { type: 'assistant', session_id: 'sess-1', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/a.txt' } }] } },
    { type: 'assistant', session_id: 'sess-1', message: { content: [{ type: 'text', text: 'All good' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'All good', total_cost_usd: 0.01, session_id: 'sess-1' },
  ]);
  const c = collectingSink();
  runStreamJson({ command: process.execPath, args: [script], cwd: tmpdir(), env: process.env }, c.sink);
  await c.done;
  assert.equal(c.session, 'sess-1');
  assert.deepEqual(c.events[0], { kind: 'tool', name: 'Read', detail: '/tmp/a.txt' });
  assert.deepEqual(c.events.at(-1), { kind: 'result', text: 'All good', isError: false });
  assert.equal(c.outcome?.status, 'completed');
  assert.equal(c.outcome?.costUsd, 0.01);
});

test('runStreamJson reports a crash without a result as failed', async () => {
  const script = await fakeAgent([{ type: 'system', subtype: 'init', session_id: 's' }], 3);
  const c = collectingSink();
  runStreamJson({ command: process.execPath, args: [script], cwd: tmpdir(), env: process.env }, c.sink);
  await c.done;
  assert.equal(c.outcome?.status, 'failed');
  assert.match(c.outcome?.error ?? '', /code 3/);
});
