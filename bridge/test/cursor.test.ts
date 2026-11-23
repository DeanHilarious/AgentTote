import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CursorAdapter, parseCursorModels, type CursorOptions } from '../src/adapters/cursor.ts';
import { rememberSecret } from '../src/secrets.ts';
import type { RunningTask, StartTaskOptions, TaskEventBody, TaskSink } from '../src/types.ts';

const NEW_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_ID = '00000000-0000-4000-8000-000000000000';
const TOKEN = 'tc-test-token';

const FAKE_CURSOR = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const scenario = process.env.FAKE_CURSOR_SCENARIO || 'ok';
const sid = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : process.env.FAKE_CURSOR_SID;
const out = event => process.stdout.write(JSON.stringify(event) + '\\n');
if (args[0] === '--version') { console.log('2026.11.13-eacade1'); process.exit(0); }
if (args[0] === 'status') {
  if (scenario === 'logged-out') { console.error('Not logged in'); process.exit(1); }
  if (scenario === 'status-error') { console.error('service down for person@example.com ${TOKEN}'); process.exit(2); }
  if (scenario === 'status-odd') { console.log('something else'); process.exit(0); }
  console.log('✓ Logged in as person@example.com');
  process.exit(0);
}
if (args[0] === 'models') {
  if (scenario === 'logged-out') { console.error('Not logged in'); process.exit(1); }
  console.log('Available models');
  console.log('');
  console.log('auto - Auto (default)');
  console.log('gpt-5.2-high - GPT-5.2 High');
  console.log('');
  console.log('Tip: use --model <id> to switch');
  process.exit(0);
}
fs.writeFileSync(process.env.FAKE_CURSOR_ARGS, JSON.stringify({ args, cwd: process.cwd(), pid: process.pid }));
const text = (s, extra) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: s }] }, ...extra });
const tool = (subtype, id, name, args, result) => out({ type: 'tool_call', subtype, call_id: id, tool_call: { [name]: result ? { args, result } : { args }, toolCallId: id } });
const final = extra => out({ type: 'result', subtype: 'success', is_error: false, result: 'Hello', session_id: sid, ...extra });
out({ type: 'system', subtype: 'init', session_id: sid, model: 'Auto', cwd: process.cwd() });
if (scenario === 'hang' || scenario === 'ignore-term') {
  if (scenario === 'ignore-term') process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (scenario === 'malformed') {
  console.log('not json');
} else if (scenario === 'no-result') {
  process.exit(0);
} else if (scenario === 'nonzero') {
  final();
  process.exit(3);
} else if (scenario === 'duplicate') {
  final();
  final();
} else if (scenario === 'conflict') {
  final({ session_id: '${OTHER_ID}' });
} else if (scenario === 'error-result') {
  out({ type: 'result', subtype: 'error', is_error: true, result: 'quota exhausted ${TOKEN}', session_id: sid });
} else {
  out(text('Hel', { timestamp_ms: 1 }));
  out(text('lo', { timestamp_ms: 2 }));
  out(text('Hello', { timestamp_ms: 3, model_call_id: 'm1' }));
  out(text('Hello'));
  tool('started', 'c1', 'readToolCall', { path: 'a.txt' });
  tool('completed', 'c1', 'readToolCall', { path: 'a.txt' }, { success: { content: 'x' } });
  tool('started', 'c2', 'writeToolCall', { path: 'new.txt' });
  tool('completed', 'c2', 'writeToolCall', { path: 'new.txt' }, { success: {} });
  tool('started', 'c3', 'editToolCall', { path: 'old.txt' });
  tool('completed', 'c3', 'editToolCall', { path: 'old.txt' }, { success: {} });
  tool('started', 'c4', 'writeToolCall', { path: 'bad.txt' });
  tool('completed', 'c4', 'writeToolCall', { path: 'bad.txt' }, { error: { message: 'permission denied' } });
  tool('started', 'c5', 'fooToolCall', { command: 'echo hi' });
  tool('completed', 'c5', 'fooToolCall', { command: 'echo hi' }, {});
  final();
}
`;

interface Outcome {
  status: string;
  result?: string;
  error?: string;
}

interface Run {
  events: TaskEventBody[];
  deltas: string[];
  sessions: string[];
  finishes: Outcome[];
  done: Promise<Outcome>;
  task: RunningTask;
}

interface Fixture {
  dir: string;
  work: string;
  cli: string;
  argsFile: string;
  directory: string;
  configDir: string;
  adapter(extra?: CursorOptions): CursorAdapter;
}

async function fixture(t: TestContext, scenario = 'ok'): Promise<Fixture> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'aa-cursor-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const work = join(dir, 'work');
  await mkdir(work);
  const cli = join(dir, 'fake-cursor-agent');
  await writeFile(cli, FAKE_CURSOR);
  await chmod(cli, 0o755);
  const argsFile = join(dir, 'args.json');
  const saved = { ...process.env };
  Object.assign(process.env, { FAKE_CURSOR_SCENARIO: scenario, FAKE_CURSOR_SID: NEW_ID, FAKE_CURSOR_ARGS: argsFile });
  t.after(() => {
    for (const key of ['FAKE_CURSOR_SCENARIO', 'FAKE_CURSOR_SID', 'FAKE_CURSOR_ARGS']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  const directory = join(dir, 'history');
  const configDir = join(dir, 'cursor-config');
  rememberSecret(TOKEN);
  return { dir, work, cli, argsFile, directory, configDir, adapter: extra => new CursorAdapter({ cli, directory, configDir, processCount: async () => 0, ...extra }) };
}

async function begin(adapter: CursorAdapter, opts: StartTaskOptions): Promise<Run> {
  const run: Omit<Run, 'done' | 'task'> = { events: [], deltas: [], sessions: [], finishes: [] };
  let resolveDone!: (outcome: Outcome) => void;
  const done = new Promise<Outcome>(resolve => { resolveDone = resolve; });
  const sink: TaskSink = {
    emit: event => run.events.push(event),
    delta: (_id, text) => run.deltas.push(text),
    setSession: id => run.sessions.push(id),
    finish: outcome => {
      run.finishes.push(outcome);
      resolveDone(outcome);
    },
  };
  const task = await adapter.startTask(opts, sink);
  return { ...run, done, task };
}

async function execute(adapter: CursorAdapter, opts: StartTaskOptions): Promise<{ run: Run; outcome: Outcome }> {
  const run = await begin(adapter, opts);
  const outcome = await run.done;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(run.finishes.length, 1, 'finish must fire exactly once');
  return { run, outcome };
}

async function recordedArgs(file: string): Promise<{ args: string[]; cwd: string }> {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(condition(), 'timed out waiting');
}

test('detect reports readiness without leaking account details', async t => {
  const fx = await fixture(t);
  const ready = await fx.adapter({ processCount: async () => 3 }).detect();
  assert.deepEqual(
    { status: ready.status, version: ready.version, runningProcesses: ready.runningProcesses, detail: ready.detail },
    { status: 'ready', version: '2026.11.13-eacade1', runningProcesses: 3, detail: undefined },
  );
  assert.equal((await fx.adapter().detect()).runningProcesses, 0);

  const missing = await new CursorAdapter({ cli: join(fx.dir, 'nope'), directory: fx.directory }).detect();
  assert.equal(missing.status, 'unavailable');
  assert.match(missing.detail ?? '', /not found/);

  process.env.FAKE_CURSOR_SCENARIO = 'logged-out';
  assert.equal((await fx.adapter().detect()).status, 'needsLogin');

  process.env.FAKE_CURSOR_SCENARIO = 'status-error';
  const broken = await fx.adapter().detect();
  assert.equal(broken.status, 'unavailable');
  assert.match(broken.detail ?? '', /exit 2/);
  assert.doesNotMatch(broken.detail ?? '', /person@example\.com|tc-test-token/);

  process.env.FAKE_CURSOR_SCENARIO = 'status-odd';
  const odd = await fx.adapter().detect();
  assert.equal(odd.status, 'unavailable');
  assert.match(odd.detail ?? '', /Unexpected/);
});

test('model listing ignores headings and footers', async t => {
  const fx = await fixture(t);
  const expected = [
    { id: 'auto', name: 'Auto', isDefault: true },
    { id: 'gpt-5.2-high', name: 'GPT-5.2 High', isDefault: false },
  ];
  assert.deepEqual(await fx.adapter().listModels(), expected);
  assert.deepEqual(parseCursorModels('Models\n\n\u001b[1mfast - Fast One\u001b[0m\nfast - Duplicate\nTip: a - b\n'), [
    { id: 'fast', name: 'Fast One', isDefault: true },
  ]);
  process.env.FAKE_CURSOR_SCENARIO = 'logged-out';
  await assert.rejects(fx.adapter().listModels(), /cursor-agent login/);
});

test('new task streams once, persists history across restart, and resumes explicitly', async t => {
  const fx = await fixture(t);
  const first = await execute(fx.adapter(), { cwd: fx.work, prompt: '-dash prompt', permissionMode: 'readOnly', model: 'auto' });
  assert.equal(first.outcome.status, 'completed');
  assert.equal(first.outcome.result, 'Hello');
  assert.deepEqual(first.run.sessions, [NEW_ID]);
  assert.deepEqual(first.run.deltas, ['Hel', 'lo']);
  assert.deepEqual(first.run.events.filter(e => e.kind === 'text'), [{ kind: 'text', text: 'Hello' }]);
  assert.deepEqual(first.run.events.filter(e => e.kind === 'tool').map(e => e.kind === 'tool' && [e.name, e.detail]), [
    ['read', 'a.txt'], ['write', 'new.txt'], ['edit', 'old.txt'], ['write', 'bad.txt'], ['foo', 'echo hi'],
  ]);
  assert.deepEqual(first.run.events.filter(e => e.kind === 'file'), [
    { kind: 'file', path: join(fx.work, 'new.txt'), change: 'created' },
    { kind: 'file', path: join(fx.work, 'old.txt'), change: 'modified' },
  ]);
  const statuses = first.run.events.filter(e => e.kind === 'status').map(e => e.kind === 'status' && e.text);
  assert.deepEqual(statuses, ['write failed: error: permission denied', 'foo failed: Cursor reported an empty result']);
  assert.deepEqual((await recordedArgs(fx.argsFile)).args, [
    '--print', '--output-format', 'stream-json', '--stream-partial-output', '--workspace', fx.work, '--trust',
    '--mode', 'plan', '--model', 'auto', '--', '-dash prompt',
  ]);
  assert.equal((await stat(join(fx.directory, `${NEW_ID}.json`))).mode & 0o777, 0o600);

  const restarted = fx.adapter();
  const sessions = await restarted.listSessions(10);
  assert.equal(sessions.length, 1);
  assert.deepEqual(
    { id: sessions[0].id, agent: sessions[0].agent, title: sessions[0].title, cwd: sessions[0].cwd, running: sessions[0].running },
    { id: NEW_ID, agent: 'cursor', title: '-dash prompt', cwd: fx.work, running: false },
  );
  assert.deepEqual((await restarted.getMessages(NEW_ID, 10)).map(m => [m.role, m.text]), [['user', '-dash prompt'], ['assistant', 'Hello']]);

  const elsewhere = join(fx.dir, 'elsewhere');
  await mkdir(elsewhere);
  const second = await execute(restarted, { sessionId: NEW_ID, cwd: elsewhere, prompt: 'again', permissionMode: 'full' });
  assert.equal(second.outcome.status, 'completed');
  const resumed = await recordedArgs(fx.argsFile);
  assert.equal(resumed.cwd, fx.work, 'resume uses the saved directory, not the request cwd');
  assert.deepEqual(resumed.args.slice(-5), ['--force', '--resume', NEW_ID, '--', 'again']);
  assert.equal((await restarted.getMessages(NEW_ID, 10)).length, 4);
  assert.deepEqual((await restarted.getMessages(NEW_ID, 1)).map(m => m.role), ['assistant']);
  assert.equal((await restarted.listSessions(0)).length, 0);
});

test('permission modes map to flags and never inherit unrestricted approval', async t => {
  const fx = await fixture(t);
  const flags = async (permissionMode: StartTaskOptions['permissionMode']): Promise<string[]> => {
    const { outcome } = await execute(fx.adapter(), { cwd: fx.work, prompt: 'p', permissionMode });
    assert.equal(outcome.status, 'completed');
    return (await recordedArgs(fx.argsFile)).args;
  };
  const accept = await flags('acceptEdits');
  assert.deepEqual(accept.slice(7, 9), ['--sandbox', 'enabled']);
  assert.ok(!accept.includes('--force') && !accept.includes('--approve-mcps') && !accept.includes('--mode'));
  const full = await flags('full');
  assert.ok(full.includes('--force') && !full.includes('--sandbox') && !full.includes('--approve-mcps'));

  await mkdir(fx.configDir);
  const configFile = join(fx.configDir, 'cli-config.json');
  await writeFile(configFile, JSON.stringify({ approvalMode: 'unrestricted', note: TOKEN }));
  await rm(fx.argsFile);
  const refused = await execute(fx.adapter(), { cwd: fx.work, prompt: 'p', permissionMode: 'acceptEdits' });
  assert.equal(refused.outcome.status, 'failed');
  assert.match(refused.outcome.error ?? '', /Full access/);
  assert.doesNotMatch(refused.outcome.error ?? '', /tc-test-token/);
  await assert.rejects(readFile(fx.argsFile), { code: 'ENOENT' });
  assert.deepEqual(await readFile(configFile, 'utf8'), JSON.stringify({ approvalMode: 'unrestricted', note: TOKEN }), 'config untouched');
  assert.ok((await flags('readOnly')).includes('plan'));
  assert.ok((await flags('full')).includes('--force'));

  await writeFile(configFile, '{ not json');
  const invalid = await execute(fx.adapter(), { cwd: fx.work, prompt: 'p', permissionMode: 'acceptEdits' });
  assert.equal(invalid.outcome.status, 'failed');
  assert.match(invalid.outcome.error ?? '', /not valid JSON/);
  await writeFile(configFile, JSON.stringify({ approvalMode: 'allowlist' }));
  assert.equal((await execute(fx.adapter(), { cwd: fx.work, prompt: 'p', permissionMode: 'acceptEdits' })).outcome.status, 'completed');
});

test('unsupported options and unknown sessions fail clearly without spawning', async t => {
  const fx = await fixture(t);
  const adapter = fx.adapter();
  const effort = await execute(adapter, { cwd: fx.work, prompt: 'p', permissionMode: 'readOnly', effort: 'high' });
  assert.match(effort.outcome.error ?? '', /encode reasoning effort/);
  const fork = await execute(adapter, { cwd: fx.work, prompt: 'p', permissionMode: 'readOnly', fork: true });
  assert.match(fork.outcome.error ?? '', /only supported for ChatGPT/);
  const badModel = await execute(adapter, { cwd: fx.work, prompt: 'p', permissionMode: 'readOnly', model: '--force' });
  assert.match(badModel.outcome.error ?? '', /Invalid Cursor model/);
  await assert.rejects(readFile(fx.argsFile), { code: 'ENOENT' });

  await assert.rejects(begin(adapter, { sessionId: NEW_ID, prompt: 'p', permissionMode: 'readOnly' }), /not found/);
  await assert.rejects(begin(adapter, { sessionId: '../etc/passwd', prompt: 'p', permissionMode: 'readOnly' }), /not found/);
  await assert.rejects(begin(adapter, { prompt: 'p', permissionMode: 'readOnly' }), /working directory is required/);
  await assert.rejects(begin(adapter, { cwd: join(fx.dir, 'gone'), prompt: 'p', permissionMode: 'readOnly' }), /does not exist/);
  await assert.rejects(begin(new CursorAdapter({ cli: join(fx.dir, 'nope') }), { cwd: fx.work, prompt: 'p', permissionMode: 'readOnly' }), /not installed/);

  await execute(adapter, { cwd: fx.work, prompt: 'p', permissionMode: 'readOnly' });
  await rm(fx.work, { recursive: true });
  await assert.rejects(begin(adapter, { sessionId: NEW_ID, prompt: 'p', permissionMode: 'readOnly' }), /does not exist/);
});

test('cancel stops the process group, escalates to SIGKILL, and guards concurrent resumes', async t => {
  const fx = await fixture(t);
  const adapter = fx.adapter({ killGraceMs: 150 });
  await execute(adapter, { cwd: fx.work, prompt: 'seed', permissionMode: 'readOnly' });

  process.env.FAKE_CURSOR_SCENARIO = 'hang';
  const run = await begin(adapter, { sessionId: NEW_ID, prompt: 'slow', permissionMode: 'readOnly' });
  await waitFor(() => run.sessions.length > 0);
  assert.equal((await adapter.listSessions(5))[0].running, true);
  await assert.rejects(begin(adapter, { sessionId: NEW_ID, prompt: 'again', permissionMode: 'readOnly' }), /already running/);
  run.task.cancel();
  run.task.cancel();
  assert.equal((await run.done).status, 'cancelled');
  assert.equal((await adapter.listSessions(5))[0].running, false);
  assert.equal((await adapter.getMessages(NEW_ID, 10)).length, 2, 'cancelled turns are not saved');

  process.env.FAKE_CURSOR_SCENARIO = 'ignore-term';
  const stubborn = await begin(adapter, { cwd: fx.work, prompt: 'stubborn', permissionMode: 'readOnly' });
  await waitFor(() => stubborn.sessions.length > 0);
  const started = Date.now();
  stubborn.task.cancel();
  assert.equal((await stubborn.done).status, 'cancelled');
  assert.ok(Date.now() - started < 3000);
});

test('malformed, incomplete, failing, duplicate and conflicting runs fail and are not saved', async t => {
  const fx = await fixture(t);
  const cases: Array<[string, RegExp]> = [
    ['malformed', /malformed stream-json/],
    ['no-result', /without a final result/],
    ['nonzero', /exited with code 3/],
    ['duplicate', /more than one final result/],
    ['conflict', /conflicting session id/],
    ['error-result', /Cursor reported an error: quota exhausted \[redacted\]/],
  ];
  for (const [scenario, pattern] of cases) {
    process.env.FAKE_CURSOR_SCENARIO = scenario;
    const { run, outcome } = await execute(fx.adapter(), { cwd: fx.work, prompt: 'p', permissionMode: 'readOnly' });
    assert.equal(outcome.status, 'failed', scenario);
    assert.match(outcome.error ?? '', pattern, scenario);
    assert.doesNotMatch(outcome.error ?? '', /tc-test-token/);
    assert.ok(run.events.some(e => e.kind === 'result' && e.isError), scenario);
    assert.deepEqual(await fx.adapter().listSessions(10), [], `${scenario} must not persist`);
  }
});

test('storage failure fails the task instead of completing', async t => {
  const fx = await fixture(t);
  await writeFile(fx.directory, 'a file where the history directory should be');
  const { outcome, run } = await execute(fx.adapter(), { cwd: fx.work, prompt: 'p', permissionMode: 'readOnly' });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error ?? '', /Could not save the Cursor session/);
  assert.ok(!run.events.some(e => e.kind === 'result' && !e.isError));
});

test('bridge exit kills a detached Cursor process even when it ignores graceful cancellation', async t => {
  const fx = await fixture(t, 'ignore-term');
  const adapterUrl = new URL('../src/adapters/cursor.ts', import.meta.url).href;
  let childPid: number | undefined;
  t.after(() => {
    if (childPid === undefined) return;
    try { process.kill(-childPid, 'SIGKILL'); } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  });
  const driver = `
    import { CursorAdapter } from ${JSON.stringify(adapterUrl)};
    const adapter = new CursorAdapter(${JSON.stringify({ cli: fx.cli, directory: fx.directory, configDir: fx.configDir })});
    let task;
    task = await adapter.startTask(${JSON.stringify({ cwd: fx.work, prompt: 'wait', permissionMode: 'readOnly' })}, {
      emit() {}, delta() {}, finish() {},
      setSession() { setTimeout(() => { task.cancel(); process.exit(0); }, 50); }
    });
  `;
  await promisify(execFile)(process.execPath, ['--no-warnings', '--input-type=module', '-e', driver], { timeout: 5000 });
  const invocation: unknown = JSON.parse(await readFile(fx.argsFile, 'utf8'));
  assert.ok(typeof invocation === 'object' && invocation !== null && 'pid' in invocation
    && typeof invocation.pid === 'number');
  childPid = invocation.pid;
  let alive = true;
  for (let attempt = 0; attempt < 40 && alive; attempt++) {
    try { process.kill(childPid, 0); } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') alive = false;
      else throw error;
    }
    if (alive) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(alive, false, 'Cursor must not outlive the bridge after shutdown');
});
