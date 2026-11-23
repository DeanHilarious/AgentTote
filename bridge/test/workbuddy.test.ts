import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { AccountClient } from '../src/account.ts';
import { WorkBuddyAdapter } from '../src/adapters/workbuddy.ts';
import { createIpcController, ipcError, redactLog } from '../src/ipc.ts';
import { deleteWorkBuddyKey, isWorkBuddyAuthFailure, loadWorkBuddyKey, normalizeWorkBuddyKey, saveWorkBuddyKey, verifyWorkBuddyKey, workbuddyEnv, WORKBUDDY_CONNECT_DETAIL, WORKBUDDY_CONNECT_ERROR } from '../src/workbuddyKey.ts';
import { configureWorkBuddyKey } from '../src/workbuddyKeyCli.ts';
import type { TaskEventBody, TaskSink } from '../src/types.ts';
import { config } from './accountHelpers.ts';

const key = 'test-workbuddy-key/123456789';
async function fixture(t: TestContext, source = '') {
  const directory = await mkdtemp(join(tmpdir(), 'aa-workbuddy-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = join(directory, 'fake-cli.cjs');
  await writeFile(cli, source);
  return { directory, cli, processCount: async () => 0 };
}
const success = `console.log(JSON.stringify({type:'result',subtype:'success',result:'OK'}));`;
const invalid = `console.error('HTTP 401 Unauthorized ' + process.env.CODEBUDDY_API_KEY); process.exit(1);`;

async function task(adapter: WorkBuddyAdapter, cwd: string) {
  const events: TaskEventBody[] = [];
  let finish!: TaskSink['finish'];
  const finished = new Promise<Parameters<TaskSink['finish']>[0]>(resolve => { finish = resolve; });
  await adapter.startTask({ cwd, prompt: 'test', permissionMode: 'readOnly' }, {
    delta: () => {},
    emit: e => events.push(e), setSession: () => {}, finish,
  });
  return { outcome: await finished, events };
}

test('private key storage is 0600, default/null environments survive and retired keys remain redacted', async t => {
  const f = await fixture(t);
  assert.equal(await loadWorkBuddyKey(f.directory), undefined);
  await saveWorkBuddyKey({ apiKey: key }, f.directory);
  assert.deepEqual(await loadWorkBuddyKey(f.directory), { apiKey: key, environment: 'internal' });
  assert.equal((await stat(join(f.directory, 'workbuddy.json'))).mode & 0o777, 0o600);
  await writeFile(join(f.directory, 'workbuddy.json'), '{}');
  assert.equal(await loadWorkBuddyKey(f.directory), undefined);
  await rm(join(f.directory, 'workbuddy.json'));
  await writeFile(join(f.directory, 'workbuddy.json'), '{}', { mode: 0o644 });
  const second = 'second-workbuddy-key-123456';
  await saveWorkBuddyKey({ apiKey: second, environment: null }, f.directory);
  assert.equal((await stat(join(f.directory, 'workbuddy.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await loadWorkBuddyKey(f.directory), { apiKey: second, environment: null });
  await deleteWorkBuddyKey(f.directory);
  await deleteWorkBuddyKey(f.directory);
  assert.equal(await loadWorkBuddyKey(f.directory), undefined);
  assert.equal(redactLog(`${key} ${encodeURIComponent(key)} ${second}`, []), '[redacted] [redacted] [redacted]');
  assert.ok(!(await readdir(f.directory)).some(file => file.endsWith('.tmp')));
});

test('key format trims input, accepts 16/512 boundaries and rejects whitespace/nonstrings', () => {
  assert.equal(normalizeWorkBuddyKey('  ' + 'x'.repeat(16) + '\n'), 'x'.repeat(16));
  assert.equal(normalizeWorkBuddyKey('x'.repeat(512)), 'x'.repeat(512));
  for (const value of [undefined, null, 123, {}, '', 'x'.repeat(15), 'x'.repeat(513), '12345678 12345678', '12345678\t12345678', '12345678\n12345678', '12345678\u00a012345678']) assert.equal(normalizeWorkBuddyKey(value), undefined);
});

test('environment stays unchanged without key and overrides/unsets site with key', () => {
  const before = process.env.CODEBUDDY_INTERNET_ENVIRONMENT;
  const previousKey = process.env.CODEBUDDY_API_KEY;
  try {
    process.env.CODEBUDDY_INTERNET_ENVIRONMENT = 'external';
    delete process.env.CODEBUDDY_API_KEY;
    assert.equal(workbuddyEnv().CODEBUDDY_INTERNET_ENVIRONMENT, 'external');
    assert.equal(workbuddyEnv().CODEBUDDY_API_KEY, undefined);
    assert.equal(workbuddyEnv({ apiKey: key }).CODEBUDDY_INTERNET_ENVIRONMENT, 'internal');
    assert.equal(workbuddyEnv({ apiKey: key, environment: 'internal' }).CODEBUDDY_API_KEY, key);
    assert.equal(workbuddyEnv({ apiKey: key, environment: null }).CODEBUDDY_INTERNET_ENVIRONMENT, undefined);
    assert.ok(workbuddyEnv().CODEBUDDY_CONFIG_DIR?.endsWith('/.workbuddy'));
  } finally {
    if (before === undefined) delete process.env.CODEBUDDY_INTERNET_ENVIRONMENT; else process.env.CODEBUDDY_INTERNET_ENVIRONMENT = before;
    if (previousKey === undefined) delete process.env.CODEBUDDY_API_KEY; else process.env.CODEBUDDY_API_KEY = previousKey;
  }
});

test('verification uses isolated empty cwd, plan permissions and removes temporary directory', async t => {
  const record = await fixture(t);
  const f = await fixture(t, `const fs=require('fs'); const assert=require('assert/strict');
    assert.equal(process.env.CODEBUDDY_API_KEY, ${JSON.stringify(key)});
    assert.equal(process.env.CODEBUDDY_INTERNET_ENVIRONMENT, 'internal');
    assert.deepEqual(fs.readdirSync(process.cwd()), []);
    assert.equal(fs.realpathSync(require('path').dirname(process.env.CODEBUDDY_CONFIG_DIR)), process.cwd());
    assert.deepEqual(process.argv.slice(2), ['-p','Reply with OK','--output-format','stream-json','--permission-mode','plan']);
    fs.writeFileSync(${JSON.stringify(join(record.directory, 'cwd'))}, process.cwd()); ${success}`);
  assert.deepEqual(await verifyWorkBuddyKey(key, 'internal', { cli: f.cli }), { ok: true, environment: 'internal' });
  const cwd = await readFile(join(record.directory, 'cwd'), 'utf8');
  await assert.rejects(stat(cwd), { code: 'ENOENT' });
});

test('verification retries domestic auth failure once, persists unset site, never retries other failures', async t => {
  const f = await fixture(t, `if (process.env.CODEBUDDY_INTERNET_ENVIRONMENT === 'internal') { require('fs').writeFileSync('first-attempt', 'site configuration'); ${invalid} } else { require('assert/strict').deepEqual(require('fs').readdirSync(process.cwd()), []); ${success} }`);
  assert.deepEqual(await verifyWorkBuddyKey(key, 'internal', { cli: f.cli }), { ok: true, environment: null });
  await writeFile(f.cli, invalid);
  const bad = await verifyWorkBuddyKey(key, 'internal', { cli: f.cli });
  assert.equal((bad as { code: string }).code, 'invalid_key');
  assert.ok(!JSON.stringify(bad).includes(key));
  await writeFile(f.cli, `if (process.env.CODEBUDDY_INTERNET_ENVIRONMENT === 'internal') { console.error(process.env.CODEBUDDY_API_KEY); process.exit(2); } else { ${success} }`);
  assert.equal((await verifyWorkBuddyKey(key, 'internal', { cli: f.cli }) as { code: string }).code, 'verify_failed');
});

test('verification timeout, missing CLI and error/missing result produce safe verify_failed', async t => {
  const f = await fixture(t, 'setInterval(() => {}, 1000);');
  assert.deepEqual(await verifyWorkBuddyKey(key, 'internal', { cli: f.cli, timeoutMs: 150 }), { ok: false, code: 'verify_failed', reason: 'Verification timed out.' });
  for (const source of ['', `console.log(JSON.stringify({type:'result',subtype:'success',result:''}));`, `console.log(JSON.stringify({type:'result',subtype:'error',is_error:true,result:process.env.CODEBUDDY_API_KEY}));`]) {
    await writeFile(f.cli, source);
    const failure = await verifyWorkBuddyKey(key, 'internal', { cli: f.cli });
    assert.equal((failure as { code: string }).code, 'verify_failed');
    assert.ok(!JSON.stringify(failure).includes(key));
  }
  assert.equal((await verifyWorkBuddyKey(key, null, { cli: join(f.directory, 'missing') }) as { code: string }).code, 'verify_failed');
});

test('adapter saved/absent keys control spawned environment and ready/needsLogin detection', async t => {
  const f = await fixture(t, `const assert=require('assert/strict'); assert.equal(process.env.CODEBUDDY_API_KEY, ${JSON.stringify(key)}); assert.equal(process.env.CODEBUDDY_INTERNET_ENVIRONMENT,'internal'); ${success}`);
  const adapter = new WorkBuddyAdapter(f);
  assert.equal((await adapter.detect()).status, 'needsLogin');
  assert.equal((await adapter.detect()).detail, WORKBUDDY_CONNECT_DETAIL);
  await saveWorkBuddyKey({ apiKey: key, environment: 'internal' }, f.directory);
  assert.equal((await adapter.detect()).status, 'ready');
  assert.equal((await task(adapter, f.directory)).outcome.status, 'completed');
  await saveWorkBuddyKey({ apiKey: key, environment: null }, f.directory);
  await writeFile(f.cli, `const assert=require('assert/strict'); assert.equal(process.env.CODEBUDDY_INTERNET_ENVIRONMENT,undefined); ${success}`);
  assert.equal((await task(adapter, f.directory)).outcome.status, 'completed');
  await deleteWorkBuddyKey(f.directory);
  assert.equal((await adapter.detect()).status, 'needsLogin');
  await writeFile(f.cli, `const assert=require('assert/strict'); assert.equal(process.env.CODEBUDDY_API_KEY, ${JSON.stringify(process.env.CODEBUDDY_API_KEY)}); ${success}`);
  assert.equal((await task(adapter, f.directory)).outcome.status, 'completed');
});

test('authentication failures in result/plain stdout/split stderr fail clearly, set needsLogin and hide keys', async t => {
  for (const source of [
    `console.log(JSON.stringify({type:'result',subtype:'success',result:'Authentication required. Please use /login command to sign in to your account ' + process.env.CODEBUDDY_API_KEY}));`,
    `console.log('Authentication required ' + process.env.CODEBUDDY_API_KEY);`,
    invalid,
    `process.stderr.write('Authentication '); setTimeout(()=>{process.stderr.write('required'); process.exit(1)},20);`,
    `console.log(JSON.stringify({type:'result',subtype:'error',is_error:true,errors:[{status:401,message:'auth failed'}]}));`,
  ]) {
    const f = await fixture(t, source);
    await saveWorkBuddyKey({ apiKey: key }, f.directory);
    const adapter = new WorkBuddyAdapter(f);
    const result = await task(adapter, f.directory);
    assert.equal(result.outcome.status, 'failed');
    assert.equal(result.outcome.error, WORKBUDDY_CONNECT_ERROR);
    assert.equal((await adapter.detect()).status, 'needsLogin');
    assert.ok(!JSON.stringify(result).includes(key));
    adapter.credentialsChanged();
    assert.equal((await adapter.detect()).status, 'ready');
  }
  assert.equal(isWorkBuddyAuthFailure('API Error: 401 bad credentials'), true);
  assert.equal(isWorkBuddyAuthFailure('HTTP 500 server failure'), false);
});

test('adapter redacts keys in text/tools/results and nonauthentication crash diagnostics', async t => {
  const f = await fixture(t, `console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:process.env.CODEBUDDY_API_KEY},{type:'tool_use',name:'test',input:{command:process.env.CODEBUDDY_API_KEY}}]}})); console.log(JSON.stringify({type:'result',subtype:'success',result:process.env.CODEBUDDY_API_KEY}));`);
  await saveWorkBuddyKey({ apiKey: key }, f.directory);
  const adapter = new WorkBuddyAdapter(f);
  const result = await task(adapter, f.directory);
  assert.equal(result.outcome.status, 'completed');
  assert.equal(result.outcome.result, '[redacted]');
  assert.ok(!JSON.stringify(result).includes(key));
  await writeFile(f.cli, `const line=JSON.stringify({type:'result',subtype:'success',result:process.env.CODEBUDDY_API_KEY}); console.log(line.replaceAll('t', String.fromCharCode(92)+'u0074'));`);
  const escaped = await task(adapter, f.directory);
  assert.equal(escaped.outcome.result, '[redacted]');
  assert.ok(!JSON.stringify(escaped).includes(key));
  await writeFile(f.cli, 'console.error(process.env.CODEBUDDY_API_KEY); process.exit(2);');
  const failure = await task(adapter, f.directory);
  assert.equal(failure.outcome.status, 'failed');
  assert.ok(!JSON.stringify(failure).includes(key));
  assert.equal((await adapter.detect()).status, 'ready');
  await writeFile(f.cli, `console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'HTTP 401 Unauthorized means an invalid API key.'}]}})); console.log(JSON.stringify({type:'result',subtype:'success',result:'HTTP 401 Unauthorized means an invalid API key.'}));`);
  assert.equal((await task(adapter, f.directory)).outcome.status, 'completed');
});

test('IPC validates before verifying, saves successful environment, refreshes agents and preserves old key on failure', async t => {
  const f = await fixture(t, success);
  const account = new AccountClient({ config: { ...config }, bridgeVersion: 'test', directory: f.directory });
  const adapter = new WorkBuddyAdapter(f);
  const events: unknown[] = [], remembered: string[] = [];
  let verificationCalls = 0;
  const controller = createIpcController({ cfg: { ...config }, account, adapters: [adapter],
    server: { clientCount: () => 0, disconnectPairing: () => {} },
    emit: (event, data) => events.push({ event, data }), rememberToken: value => remembered.push(value),
    workbuddy: {
      verify: (apiKey, environment) => { verificationCalls++; return verifyWorkBuddyKey(apiKey, environment, { cli: f.cli }); },
      save: value => saveWorkBuddyKey(value, f.directory), clear: () => deleteWorkBuddyKey(f.directory),
    },
  });
  await controller.refresh();
  for (const apiKey of [undefined, 5, '', 'too-short', 'x'.repeat(513), 'whitespace in the middle']) await assert.rejects(controller.execute('workbuddy.setKey', { apiKey }), error => ipcError(error).code === 'invalid_params');
  assert.equal(verificationCalls, 0);
  assert.deepEqual(await controller.execute('workbuddy.setKey', { apiKey: `  ${key}\n` }), { ok: true });
  assert.equal(controller.status().agents[0].status, 'ready');
  assert.deepEqual(await loadWorkBuddyKey(f.directory), { apiKey: key, environment: 'internal' });
  assert.equal(remembered[0], key);
  assert.ok(!JSON.stringify(events).includes(key));
  assert.ok(!JSON.stringify(controller.status()).includes(key));
  await writeFile(f.cli, invalid);
  await assert.rejects(controller.execute('workbuddy.setKey', { apiKey: 'other-invalid-key-123456' }), error => {
    assert.equal(ipcError(error).code, 'invalid_key');
    assert.ok(!JSON.stringify(ipcError(error)).includes('other-invalid-key-123456')); return true;
  });
  assert.equal((await loadWorkBuddyKey(f.directory))?.apiKey, key);
  await writeFile(f.cli, `console.error(process.env.CODEBUDDY_API_KEY); process.exit(2);`);
  await assert.rejects(controller.execute('workbuddy.setKey', { apiKey: key }), error => ipcError(error).code === 'verify_failed');
  await writeFile(f.cli, `if(process.env.CODEBUDDY_INTERNET_ENVIRONMENT==='internal'){${invalid}}else{${success}}`);
  await controller.execute('workbuddy.setKey', { apiKey: key });
  assert.equal((await loadWorkBuddyKey(f.directory))?.environment, null);
  assert.deepEqual(await controller.execute('workbuddy.clearKey', {}), { ok: true });
  assert.equal(controller.status().agents[0].status, 'needsLogin');
  assert.equal(await loadWorkBuddyKey(f.directory), undefined);
  const count = events.length;
  await controller.execute('workbuddy.clearKey', {});
  assert.equal(events.length, count + 1);
  assert.ok(!JSON.stringify(events).includes(key));
});

test('CLI reads piped key without echo, and clear deletes saved key', async t => {
  const f = await fixture(t, success);
  let output = '';
  const sink = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
  assert.equal(await configureWorkBuddyKey(false, {
    input: Readable.from([`  ${key}\n`]), output: sink,
    verify: (apiKey, environment) => verifyWorkBuddyKey(apiKey, environment, { cli: f.cli }),
    save: value => saveWorkBuddyKey(value, f.directory),
  }), true);
  assert.ok(!output.includes(key));
  assert.match(output, /https:\/\/www.codebuddy.cn\/profile\/keys/);
  assert.equal((await loadWorkBuddyKey(f.directory))?.apiKey, key);
  assert.equal(await configureWorkBuddyKey(true, { output: sink, remove: () => deleteWorkBuddyKey(f.directory) }), true);
  assert.equal(await loadWorkBuddyKey(f.directory), undefined);
  assert.equal(await configureWorkBuddyKey(false, { input: Readable.from([]), output: sink }), false);
});

test('CLI TTY input is hidden while reading and restoring terminal mode', async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false,
    setRawMode(raw: boolean) { this.isRaw = raw; } });
  let output = '';
  const sink = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
  const configuring = configureWorkBuddyKey(false, { input, output: sink,
    verify: async apiKey => { assert.equal(apiKey, key); return { ok: true, environment: 'internal' }; },
    save: async () => {},
  });
  input.write(key + '\r');
  assert.equal(await configuring, true);
  assert.ok(!output.includes(key));
  assert.equal(input.isRaw, false);
});
