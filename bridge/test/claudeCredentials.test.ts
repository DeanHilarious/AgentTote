import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import { ClaudeCredentials, CLAUDE_LOGIN_REQUIRED, keychainHasClaudeCredentials } from '../src/adapters/claudeCredentials.ts';
import { ClaudeApiProxy } from '../src/adapters/claudeProxy.ts';

const absent = { env: {}, readSettings: async () => '{}', credentialsExist: async () => false, keychainExists: async () => false };

test('each credential source independently establishes Claude sign-in', async () => {
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
    assert.equal(await new ClaudeCredentials({ ...absent, env: { [key]: 'test' } }).hasCredentials(), true);
    assert.equal(await new ClaudeCredentials({ ...absent, readSettings: async () => JSON.stringify({ env: { [key]: 'test' } }) }).hasCredentials(), true);
    for (const value of ['', '  ', null, 42]) {
      assert.equal(await new ClaudeCredentials({ ...absent, readSettings: async () => JSON.stringify({ env: { [key]: value } }) }).hasCredentials(), false);
    }
    assert.equal(await new ClaudeCredentials({ ...absent, env: { [key]: '   ' } }).hasCredentials(), false);
  }
  assert.equal(await new ClaudeCredentials({ ...absent, readSettings: async () => '{"apiKeyHelper":"my-helper"}' }).hasCredentials(), true);
  assert.equal(await new ClaudeCredentials({ ...absent, credentialsExist: async () => true }).hasCredentials(), true);
  assert.equal(await new ClaudeCredentials({ ...absent, keychainExists: async () => true }).hasCredentials(), true);
});

test('missing or malformed settings tolerate other credential sources; no source means signed out', async () => {
  for (const readSettings of [async () => { throw Error('ENOENT'); }, ...['{bad', 'null', '{}', '{"env":null}', '{"apiKeyHelper":" "}'].map(value => async () => value)]) {
    assert.equal(await new ClaudeCredentials({ ...absent, readSettings }).hasCredentials(), false);
    assert.equal(await new ClaudeCredentials({ ...absent, readSettings, credentialsExist: async () => true }).hasCredentials(), true);
    assert.equal(await new ClaudeCredentials({ ...absent, readSettings, keychainExists: async () => true }).hasCredentials(), true);
  }
});

test('positive, negative and concurrent detections share the 30-second cache', async () => {
  let now = 0, present = false, checks = 0;
  const credentials = new ClaudeCredentials({ ...absent, now: () => now, keychainExists: async () => { checks++; return present; } });
  assert.deepEqual(await Promise.all([credentials.hasCredentials(), credentials.hasCredentials()]), [false, false]);
  assert.equal(checks, 1);
  present = true;
  now = 29_999;
  assert.equal(await credentials.hasCredentials(), false);
  now = 30_000;
  assert.equal(await credentials.hasCredentials(), true);
  present = false;
  now = 59_999;
  assert.equal(await credentials.hasCredentials(), true);
  now = 60_000;
  assert.equal(await credentials.hasCredentials(), false);
  assert.equal(checks, 3);
});

test('Keychain existence probe uses only exit status and discards all output', async t => {
  let code = 0;
  const probe = t.mock.method(childProcess, 'spawn', ((command: string, args: string[], options: unknown) => {
    assert.equal(command, '/usr/bin/security');
    assert.deepEqual(args, ['find-generic-password', '-s', 'Claude Code-credentials']);
    assert.deepEqual(options, { stdio: 'ignore', timeout: 3_000 });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', code));
    return child;
  }) as any);
  syncBuiltinESMExports();
  t.after(() => { probe.mock.restore(); syncBuiltinESMExports(); });
  assert.equal(await keychainHasClaudeCredentials(), true);
  code = 44;
  assert.equal(await keychainHasClaudeCredentials(), false);
});

test('signed-out detection and task starts show the same guidance without starting a CLI', async t => {
  const proxy = new ClaudeApiProxy({ env: {}, readSettings: async () => '{}' });
  const credentials = new ClaudeCredentials(absent);
  const adapter = new ClaudeAdapter(proxy, credentials);
  t.mock.method(childProcess, 'execFile', ((...args: any[]) => {
    assert.equal(args[0], 'ps');
    queueMicrotask(() => args.at(-1)(null, '', ''));
    return {};
  }) as any);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const binary = t.mock.method(adapter as any, 'resolveBinary', async () => ({ bin: '/must-not-spawn', version: '2.1' }));
  const info = await adapter.detect();
  assert.equal(info.status, 'needsLogin');
  assert.equal(info.detail, CLAUDE_LOGIN_REQUIRED);
  const outcomes: unknown[] = [];
  await adapter.startTask({ cwd: '/tmp', prompt: 'hello', permissionMode: 'readOnly' }, {
    finish: outcome => outcomes.push(outcome), emit() {}, delta() {}, setSession() {},
  });
  assert.deepEqual(outcomes, [{ status: 'failed', error: CLAUDE_LOGIN_REQUIRED }]);
  assert.equal(binary.mock.callCount(), 1);
  const signedIn = new ClaudeAdapter(proxy, new ClaudeCredentials({ ...absent, credentialsExist: async () => true }));
  t.mock.method(signedIn as any, 'resolveBinary', async () => ({ bin: '/must-not-spawn', version: '2.1' }));
  assert.equal((await signedIn.detect()).status, 'ready');
});
