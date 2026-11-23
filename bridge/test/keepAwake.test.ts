import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { CAFFEINATE_PATH, KeepAwake } from '../src/keepAwake.ts';

function fixture() {
  const children: (EventEmitter & { kill(signal: string): boolean; signals: string[] })[] = [];
  const calls: unknown[] = [], logs: string[] = [], changes: boolean[] = [];
  const awake = new KeepAwake({ platform: 'darwin', pid: 123, log: s => logs.push(s), onChange: a => changes.push(a),
    spawn: (command, args, options) => {
      calls.push([command, args, options]);
      const child = Object.assign(new EventEmitter(), { signals: [] as string[], kill(signal: string) { this.signals.push(signal); return true; } });
      children.push(child);
      return child;
    } });
  return { awake, calls, children, logs, changes };
}

test('modes use absolute caffeinate, bridge PID and exact power/idle assertions; transitions retire before relaunch', t => {
  const f = fixture();
  t.after(() => { f.awake.stop(); f.children.at(-1)?.emit('close'); });
  f.awake.setMode('off');
  assert.equal(f.calls.length, 0);
  f.awake.setMode('onPower');
  assert.deepEqual(f.calls[0], [CAFFEINATE_PATH, ['-s', '-w', '123'], { stdio: 'ignore' }]);
  f.children[0].emit('spawn');
  assert.equal(f.awake.active, true);
  f.awake.setMode('onPower');
  assert.equal(f.calls.length, 1);
  f.awake.setMode('always');
  assert.equal(f.awake.active, false);
  assert.deepEqual(f.children[0].signals, ['SIGTERM']);
  assert.equal(f.calls.length, 1);
  f.children[0].emit('close');
  assert.deepEqual(f.calls[1], [CAFFEINATE_PATH, ['-i', '-w', '123'], { stdio: 'ignore' }]);
  f.children[1].emit('spawn');
  f.awake.stop();
  f.children[1].emit('close');
  assert.deepEqual(f.changes, [true, false, true, false]);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.logs, []);
});

test('unexpected error/close logs once and retries no faster than 30 seconds with backoff; off cancels retry', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.awake.setMode('always');
  f.children[0].emit('spawn');
  f.children[0].emit('error', new Error('failed'));
  f.children[0].emit('close');
  assert.equal(f.awake.active, false);
  assert.deepEqual(f.logs, ['caffeinate exited unexpectedly; retrying in 30s']);
  t.mock.timers.tick(29_999);
  assert.equal(f.calls.length, 1);
  t.mock.timers.tick(1);
  assert.equal(f.calls.length, 2);
  f.children[1].emit('close');
  assert.match(f.logs[1], /60s/);
  t.mock.timers.tick(59_999);
  assert.equal(f.calls.length, 2);
  f.awake.stop();
  t.mock.timers.tick(300_000);
  assert.equal(f.calls.length, 2);
});

test('synchronous spawn failures back off and non-macOS never launches', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const logs: string[] = [];
  const awake = new KeepAwake({ platform: 'darwin', log: s => logs.push(s), spawn: () => { calls++; throw new Error('ENOENT'); } });
  awake.setMode('onPower');
  assert.equal(calls, 1);
  t.mock.timers.tick(30_000);
  assert.equal(calls, 2);
  assert.equal(logs.length, 2);
  awake.stop();
  const other = new KeepAwake({ platform: 'linux', log: () => {}, spawn: () => { throw new Error('must not spawn'); } });
  other.setMode('always');
  assert.equal(other.active, false);
});

test('stubborn helpers are killed and rapid changes converge on the latest mode without overlap', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.awake.setMode('always');
  f.children[0].emit('spawn');
  f.awake.setMode('off');
  f.awake.setMode('onPower');
  f.awake.setMode('always');
  assert.equal(f.calls.length, 1);
  t.mock.timers.tick(2_000);
  assert.deepEqual(f.children[0].signals, ['SIGTERM', 'SIGKILL']);
  f.children[0].emit('close');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1], [CAFFEINATE_PATH, ['-i', '-w', '123'], { stdio: 'ignore' }]);
  f.awake.stop();
  f.children[1].emit('close');
  t.mock.timers.tick(300_000);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.logs, []);
});

test('CLI remembers keep-awake without starting a server in pair-only mode', async t => {
  const entries = ['src/index.ts'];
  if (process.env.AA_TEST_BUNDLE === '1') entries.push('dist/bridge.mjs');
  for (const entry of entries) {
    const directory = await mkdtemp(join(tmpdir(), 'aa-awake-cli-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const run = (mode: string) => spawnSync(process.execPath, ['--no-warnings', entry, '--pair-only', '--keep-awake', mode], {
      cwd: new URL('..', import.meta.url), env: { ...process.env, AGENTANYWHERE_HOME: directory }, stdio: 'ignore', timeout: 5_000,
    });
    for (const mode of ['always', 'off', 'onPower']) {
      assert.equal(run(mode).status, 0);
      assert.equal(JSON.parse(await readFile(join(directory, 'bridge.json'), 'utf8')).keepAwake, mode);
    }
    assert.notEqual(run('invalid').status, 0);
    assert.equal(JSON.parse(await readFile(join(directory, 'bridge.json'), 'utf8')).keepAwake, 'onPower');
  }
});
