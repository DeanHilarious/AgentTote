import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { configDirectory, loadAccount, loadConfig, saveAccount, SCUTIL_PATH } from '../src/config.ts';

test('ComputerName lookup uses scutil by absolute path for LaunchServices environments', () => {
  assert.equal(SCUTIL_PATH, '/usr/sbin/scutil');
});

test('legacy bridge config gains stable deviceId and serverUrl without changing existing fields', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aa-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const oldUrl = process.env.AA_SERVER_URL;
  delete process.env.AA_SERVER_URL;
  t.after(() => { if (oldUrl === undefined) delete process.env.AA_SERVER_URL; else process.env.AA_SERVER_URL = oldUrl; });
  const original = { token: 'existing-token', port: 9000, name: 'Existing Mac', extra: 'preserved' };
  await writeFile(join(directory, 'bridge.json'), JSON.stringify(original));
  let nameCalls = 0;
  const first = await loadConfig({ directory, getComputerName: async () => { nameCalls++; return 'Changed Mac'; } });
  assert.equal(nameCalls, 0);
  assert.match(first.deviceId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  assert.equal(first.serverUrl, 'https://agent-anywhere.nuts-claw.tech');
  const disk = JSON.parse(await readFile(join(directory, 'bridge.json'), 'utf8'));
  for (const [key, value] of Object.entries(original)) assert.equal(disk[key], value);
  assert.deepEqual(await loadConfig({ directory }), first);
  process.env.AA_SERVER_URL = 'http://override.test';
  const overridden = await loadConfig({ directory });
  assert.equal(overridden.serverUrl, 'http://override.test');
  assert.equal(overridden.deviceId, first.deviceId);
  delete process.env.AA_SERVER_URL;
  assert.equal((await loadConfig({ directory })).serverUrl, 'http://override.test');
});

test('account config is atomically replaced with 0600 permissions, including an existing permissive file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aa-account-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'account.json'), '{}', { mode: 0o644 });
  const account = { serverUrl: 'http://account.test', refreshToken: 'old-refresh', user: { id: 'user-1', email: 'user@example.com' } };
  await saveAccount(account, directory);
  assert.equal((await stat(join(directory, 'account.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await loadAccount(directory), account);
  await saveAccount({ ...account, refreshToken: 'new-refresh' }, directory);
  assert.equal((await loadAccount(directory))?.refreshToken, 'new-refresh');
  assert.deepEqual(await readdir(directory), ['account.json']);
});

test('AGENTANYWHERE_HOME redirects both configuration files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aa-home-'));
  const oldHome = process.env.AGENTANYWHERE_HOME;
  process.env.AGENTANYWHERE_HOME = directory;
  t.after(async () => {
    if (oldHome === undefined) delete process.env.AGENTANYWHERE_HOME; else process.env.AGENTANYWHERE_HOME = oldHome;
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(configDirectory(), directory);
  await loadConfig({ getComputerName: async () => 'Test Mac' });
  await saveAccount({ serverUrl: 'http://account.test', refreshToken: 'refresh', user: { id: 'user-1' } });
  assert.deepEqual((await readdir(directory)).sort(), ['account.json', 'bridge.json']);
});

test('new bridge config prefers trimmed ComputerName and preserves it on later loads', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aa-computer-name-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await loadConfig({ directory, getComputerName: async () => '  我的 MacBook Pro\n' });
  assert.equal(first.name, '我的 MacBook Pro');
  assert.equal(JSON.parse(await readFile(join(directory, 'bridge.json'), 'utf8')).name, first.name);
  let nameCalls = 0;
  const second = await loadConfig({ directory, getComputerName: async () => { nameCalls++; return 'Another Mac'; } });
  assert.equal(second.name, first.name);
  assert.equal(nameCalls, 0);
});

test('new bridge config falls back to hostname when ComputerName is empty or fails', async t => {
  for (const getComputerName of [async () => ' \n', async (): Promise<string> => { throw new Error('scutil failed'); }]) {
    const directory = await mkdtemp(join(tmpdir(), 'aa-name-fallback-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const config = await loadConfig({ directory, getComputerName });
    assert.equal(config.name, hostname().replace(/\.local$/, ''));
  }
});

test('keepAwake defaults, persists CLI overrides and rejects invalid input', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aa-awake-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal((await loadConfig({ directory })).keepAwake, 'onPower');
  for (const keepAwake of ['always', 'off', 'onPower']) {
    assert.equal((await loadConfig({ directory, keepAwake })).keepAwake, keepAwake);
    assert.equal((await loadConfig({ directory })).keepAwake, keepAwake);
  }
  await assert.rejects(loadConfig({ directory, keepAwake: 'sometimes' }), /Expected --keep-awake/);
});
