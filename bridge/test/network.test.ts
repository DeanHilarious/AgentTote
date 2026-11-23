import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { HostAddress } from '../src/config.ts';
import { reachableAddresses } from '../src/config.ts';
import { NetworkMonitor, networkDescription, staleLocalAddress } from '../src/network.ts';

test('network polling compares address/kind sets, ignores ordering and stops cleanly', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let hosts: HostAddress[] = [{ address: '192.168.1.20', kind: 'lan' }, { address: '100.64.1.2', kind: 'tailscale' }];
  const changes: HostAddress[][] = [];
  let intervals = 0, cleared = 0;
  const monitor = new NetworkMonitor({ read: () => hosts, onChange: next => changes.push(next),
    setInterval: ((callback: () => void, delay: number) => {
      intervals++;
      assert.equal(delay, 3_000);
      return setInterval(callback, delay);
    }) as typeof setInterval,
    clearInterval: timer => { cleared++; clearInterval(timer); } });
  monitor.start();
  monitor.start();
  hosts = [...hosts].reverse();
  t.mock.timers.tick(3_000);
  assert.equal(changes.length, 0);
  hosts = [...hosts, hosts[0]];
  t.mock.timers.tick(3_000);
  assert.equal(changes.length, 0);
  hosts = [{ address: '192.168.1.21', kind: 'lan' }];
  t.mock.timers.tick(2_999);
  assert.equal(changes.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(changes, [hosts]);
  hosts = [{ address: '192.168.1.21', kind: 'tailscale' }];
  t.mock.timers.tick(3_000);
  assert.equal(changes.length, 2);
  hosts = [];
  t.mock.timers.tick(3_000);
  assert.deepEqual(changes[2], []);
  monitor.stop();
  monitor.stop();
  hosts = [{ address: '192.168.1.22', kind: 'lan' }];
  t.mock.timers.tick(6_000);
  assert.equal(changes.length, 3);
  assert.equal(intervals, 1);
  assert.equal(cleared, 1);
  monitor.start();
  t.mock.timers.tick(3_000);
  assert.equal(changes.length, 4);
  hosts[0].address = '192.168.1.23';
  t.mock.timers.tick(3_000);
  assert.equal(changes.length, 5);
  monitor.stop();
});

test('stale connections normalize mapped IPv4 and preserve all loopback connections', () => {
  const hosts: HostAddress[] = [{ address: '192.168.1.20', kind: 'lan' }];
  for (const address of ['192.168.1.20', '::ffff:192.168.1.20', '127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1', undefined]) {
    assert.equal(staleLocalAddress(address, hosts), false, address);
  }
  for (const address of ['192.168.1.19', '::ffff:192.168.1.19', '100.64.1.2']) {
    assert.equal(staleLocalAddress(address, hosts), true, address);
  }
  assert.equal(networkDescription(hosts), '192.168.1.20 (LAN)');
  assert.equal(networkDescription([{ address: '100.64.1.2', kind: 'tailscale' }]), '100.64.1.2 (Tailscale)');
  assert.equal(networkDescription([]), 'no reachable addresses');
});

test('test-only extra host file can add, change and remove an address without restarting', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aa-network-'));
  const savedExtra = process.env.AA_TEST_EXTRA_HOST;
  const savedFile = process.env.AA_TEST_EXTRA_HOST_FILE;
  t.after(async () => {
    if (savedExtra === undefined) delete process.env.AA_TEST_EXTRA_HOST; else process.env.AA_TEST_EXTRA_HOST = savedExtra;
    if (savedFile === undefined) delete process.env.AA_TEST_EXTRA_HOST_FILE; else process.env.AA_TEST_EXTRA_HOST_FILE = savedFile;
    await rm(directory, { recursive: true, force: true });
  });
  process.env.AA_TEST_EXTRA_HOST = '192.0.2.123';
  assert.ok(reachableAddresses().some(h => h.address === '192.0.2.123' && h.kind === 'lan'));
  const file = join(directory, 'host');
  process.env.AA_TEST_EXTRA_HOST_FILE = file;
  await writeFile(file, '100.64.1.123\n');
  assert.ok(reachableAddresses().some(h => h.address === '100.64.1.123' && h.kind === 'tailscale'));
  assert.ok(!reachableAddresses().some(h => h.address === '192.0.2.123'));
  await writeFile(file, '192.0.2.124');
  assert.ok(reachableAddresses().some(h => h.address === '192.0.2.124'));
  assert.ok(!reachableAddresses().some(h => h.address === '100.64.1.123'));
  for (const value of ['', 'invalid', '192.0.2.124\n192.0.2.125']) {
    await writeFile(file, value);
    assert.ok(!reachableAddresses().some(h => h.address === '192.0.2.124'));
  }
});
