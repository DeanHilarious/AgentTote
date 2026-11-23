import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { BONJOUR_TYPE, BonjourPublisher, DNS_SD_PATH } from '../src/bonjour.ts';

class FakeChild extends EventEmitter {
  signals: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals) { this.signals.push(signal); return true; }
}

function fixture() {
  const children: FakeChild[] = [];
  const calls: { command: string; args: string[]; options: { stdio: 'ignore' } }[] = [];
  const logs: string[] = [];
  let now = 0;
  const options = {
    registration: { name: 'Mac "with spaces"', port: 8787, deviceId: 'device-id', version: '0.1.0' },
    log: (message: string) => logs.push(message), platform: 'darwin', exists: () => true, disabled: false,
    now: () => now,
    spawn: (command: string, args: string[], options: { stdio: 'ignore' }) => {
      calls.push({ command, args, options });
      const child = new FakeChild();
      children.push(child);
      return child as unknown as Pick<ChildProcess, 'once' | 'kill'>;
    },
  };
  return { options, children, calls, logs, advance: (time: number) => { now += time; } };
}

test('Bonjour registers only public identity/version with absolute dns-sd path and no stdout', async () => {
  const f = fixture();
  const publisher = new BonjourPublisher(f.options);
  publisher.start();
  publisher.start();
  assert.deepEqual(f.calls, [{ command: DNS_SD_PATH,
    args: ['-R', 'Mac "with spaces"', BONJOUR_TYPE, 'local', '8787', 'device=device-id', 'v=0.1.0'],
    options: { stdio: 'ignore' } }]);
  const stopped = publisher.stop();
  assert.deepEqual(f.children[0].signals, ['SIGTERM']);
  f.children[0].emit('close', 0, 'SIGTERM');
  await stopped;
});

test('Bonjour renaming retires the old registration before starting the latest name', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const publisher = new BonjourPublisher(f.options);
  publisher.start();
  publisher.rename(f.options.registration.name);
  assert.deepEqual(f.children[0].signals, []);
  publisher.rename('Renamed');
  publisher.rename('Latest');
  assert.deepEqual(f.children[0].signals, ['SIGTERM']);
  assert.equal(f.calls.length, 1);
  f.children[0].emit('close', 0, 'SIGTERM');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].args[1], 'Latest');
  // Retired process callbacks must not disturb the replacement.
  f.children[0].emit('error', new Error('late error'));
  t.mock.timers.tick(30_000);
  assert.equal(f.calls.length, 2);
  const stopped = publisher.stop();
  f.children[1].emit('close', 0, 'SIGTERM');
  await stopped;
});

test('Bonjour unexpected exits back off to 30 seconds and stop cancels pending restart', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const publisher = new BonjourPublisher(f.options);
  publisher.start();
  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    const count = f.calls.length;
    f.children.at(-1)!.emit('close', 1, null);
    t.mock.timers.tick(delay - 1);
    assert.equal(f.calls.length, count);
    t.mock.timers.tick(1);
    assert.equal(f.calls.length, count + 1);
  }
  f.children.at(-1)!.emit('close', 1, null);
  await publisher.stop();
  const count = f.calls.length;
  t.mock.timers.tick(60_000);
  assert.equal(f.calls.length, count);
});

test('Bonjour resets restart backoff after a healthy minute and escalates stubborn shutdown', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const publisher = new BonjourPublisher(f.options);
  publisher.start();
  f.children[0].emit('close', 1, null);
  t.mock.timers.tick(1_000);
  f.advance(60_000);
  f.children[1].emit('close', 1, null);
  t.mock.timers.tick(1_000);
  assert.equal(f.children.length, 3);
  const stopped = publisher.stop();
  t.mock.timers.tick(1_999);
  assert.deepEqual(f.children[2].signals, ['SIGTERM']);
  t.mock.timers.tick(1);
  assert.deepEqual(f.children[2].signals, ['SIGTERM', 'SIGKILL']);
  f.children[2].emit('close', null, 'SIGKILL');
  await stopped;
  t.mock.timers.tick(60_000);
  assert.equal(f.children.length, 3);
});

test('Bonjour skips unsupported platforms, missing executable and test disable without spawning', async () => {
  for (const patch of [{ platform: 'linux' }, { exists: () => false }, { disabled: true }]) {
    const f = fixture();
    const publisher = new BonjourPublisher({ ...f.options, ...patch });
    publisher.start();
    publisher.start();
    assert.equal(f.calls.length, 0);
    assert.equal(f.logs.length, 'disabled' in patch ? 0 : 1);
    await publisher.stop();
  }
});

test('Bonjour handles spawn errors and close only once, including executable removal after access check', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const publisher = new BonjourPublisher(f.options);
  publisher.start();
  f.children[0].emit('error', Object.assign(new Error('spawn'), { code: 'EACCES' }));
  f.children[0].emit('close', -1, null);
  t.mock.timers.tick(1_000);
  assert.equal(f.calls.length, 2);
  f.children[1].emit('error', Object.assign(new Error('spawn'), { code: 'ENOENT' }));
  f.children[1].emit('close', -1, null);
  t.mock.timers.tick(60_000);
  assert.equal(f.calls.length, 2);
  assert.equal(f.logs.filter(line => line.includes('unavailable')).length, 1);
  await publisher.stop();

  const thrown = fixture();
  const missing = new BonjourPublisher({ ...thrown.options, spawn: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
  missing.start();
  assert.equal(thrown.logs.length, 1);
  await missing.stop();
});
