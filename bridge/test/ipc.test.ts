import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createAccountServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { AccountClient, AccountError } from '../src/account.ts';
import { loadConfig, saveAccount, writePrivateFile } from '../src/config.ts';
import { createIpcController, ipcError, parseCommand, redactLog, startupFailure } from '../src/ipc.ts';
import { authorizeUpgrade } from '../src/server.ts';
import type { Adapter } from '../src/types.ts';
import { access, config, json, publicKeyPem, ticket } from './accountHelpers.ts';

const listen = { skip: process.env.AA_TEST_LISTEN !== '1' ? 'Requires listening permission; run AA_TEST_LISTEN=1 npm test outside the sandbox' : false, timeout: 30_000 };

test('IPC parses commands and rejects malformed envelopes', () => {
  assert.deepEqual(parseCommand('{"id":0,"method":"status"}'), { id: 0, method: 'status', params: {} });
  assert.equal(parseCommand('{"id":"a","method":"config.set","params":{"name":"Mac"}}').params.name, 'Mac');
  for (const line of ['bad', 'null', '[]', '{}', '{"id":null,"method":"status"}', '{"id":1,"method":3}', '{"id":1,"method":"status","params":[]}', '{"id":1,"method":"status","params":null}'])
    assert.throws(() => parseCommand(line), error => ipcError(error).code === 'invalid_params');
});

test('network events and subsequent status/rotation share the updated hosts', async t => {
  const f = await fixture(t);
  const hosts = [{ address: '192.0.2.20', kind: 'lan' as const }];
  f.controller.updateNetwork(hosts);
  const event = f.events.find(e => e.event === 'network');
  assert.ok(event);
  assert.deepEqual(event.data.hosts, hosts);
  assert.equal(event.data.pairingUrl, f.controller.status().pairingUrl);
  assert.deepEqual(f.controller.status().hosts, hosts);
  assert.equal(new URL(event.data.pairingUrl).searchParams.get('hosts'), '192.0.2.20');
  const rotated = await f.controller.execute('pairing.rotate', {}) as { pairingUrl: string };
  assert.equal(new URL(rotated.pairingUrl).searchParams.get('hosts'), '192.0.2.20');
});

test('IPC errors preserve service codes/retryAfter and hide arbitrary exception text', () => {
  assert.deepEqual(ipcError(new AccountError(429, 'rate_limited', 42)), { code: 'rate_limited', message: 'Account request failed (429, rate_limited)', retryAfter: 42 });
  assert.deepEqual(ipcError(new Error(config.token)), { code: 'internal_error', message: 'Bridge operation failed' });
});

test('log redaction removes current/retired tokens, encoded tokens and whole pairing URLs', () => {
  const safe = redactLog('old-secret new/secret\nagentanywhere://pair?token=future&name=Mac\ntoken=unknown new%2Fsecret', ['old-secret', 'new/secret']);
  for (const secret of ['old-secret', 'new/secret', 'new%2Fsecret', 'future', 'unknown', 'agentanywhere://pair']) assert.ok(!safe.includes(secret));
  assert.equal(JSON.stringify({ event: 'log', data: { message: safe } }).split('\n').length, 1);
});

test('startup failure includes the cause and redacts pairing secrets', () => {
  const failure = startupFailure(new Error(`Cannot load ${config.token}; agentanywhere://pair?token=other-secret&name=Mac`), [config.token]);
  assert.equal(failure.code, 'startup_failed');
  assert.match(failure.message, /Cannot load/);
  assert.ok(!failure.message.includes(config.token));
  assert.ok(!failure.message.includes('other-secret'));
  assert.ok(!failure.message.includes('agentanywhere://pair'));
  assert.deepEqual(startupFailure(null), { code: 'startup_failed', message: 'Bridge startup failed: Unknown startup error' });
});

async function fixture(t: TestContext, fetcher: typeof fetch = async () => json({})) {
  const directory = await mkdtemp(join(tmpdir(), 'aa-ipc-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cfg = { ...config };
  const events: { event: string; data: any }[] = [];
  const account = new AccountClient({ config: cfg, bridgeVersion: '0.1.0', directory, fetch: fetcher, log: () => {}, onChange: data => events.push({ event: 'account', data }) });
  await account.initialize();
  t.after(() => account.stop());
  let disconnected = 0, detections = 0, detail = 'first';
  const adapters = [{ detect: async () => {
    detections++;
    return { kind: 'claude', name: 'Claude', status: 'ready', runningProcesses: 0, detail };
  } }] as Adapter[];
  const persisted: typeof cfg[] = [], tokens: string[] = [], names: string[] = [];
  const controller = createIpcController({ cfg, account, adapters,
    server: { clientCount: () => 2, disconnectPairing: () => { disconnected++; } },
    emit: (event, data) => events.push({ event, data }), rememberToken: token => tokens.push(token),
    onNameChange: name => names.push(name),
    persist: async next => { persisted.push(next); } });
  return { cfg, account, events, directory, controller, persisted, tokens, names,
    disconnected: () => disconnected, detections: () => detections, changeAgents: () => { detail = 'second'; } };
}

test('configuration preserves pending port across rename/rotation and status reports live port', async t => {
  const f = await fixture(t);
  assert.equal(f.controller.status().clients, 2);
  assert.deepEqual(f.controller.status().account, { user: null, serverUrl: config.serverUrl, state: 'signedOut' });
  assert.deepEqual(await f.controller.execute('config.set', { port: 9999 }), { restartRequired: true });
  await f.controller.execute('config.set', { name: 'New Mac' });
  assert.deepEqual(f.names, ['New Mac']);
  const result = await f.controller.execute('pairing.rotate', {}) as { pairingUrl: string };
  assert.equal(f.disconnected(), 1);
  assert.notEqual(f.cfg.token, config.token);
  assert.deepEqual(f.tokens, [config.token, f.cfg.token]);
  const url = new URL(result.pairingUrl);
  assert.equal(url.searchParams.get('name'), 'New Mac');
  assert.equal(url.searchParams.get('port'), String(config.port));
  assert.equal(f.persisted.at(-1)?.port, 9999);
  assert.equal(f.persisted.at(-1)?.token, f.cfg.token);
  assert.equal(f.controller.status().port, config.port);
  for (const params of [{}, { port: 0 }, { port: '123' }, { port: 65536 }, { name: '' }, { port: 1.5 }])
    await assert.rejects(f.controller.execute('config.set', params), error => ipcError(error).code === 'invalid_params');
  await assert.rejects(f.controller.execute('missing', {}), error => ipcError(error).code === 'unknown_method');
  for (const params of [{ channel: 'other', target: 'a' }, { channel: 'email', target: '' }])
    await assert.rejects(f.controller.execute('account.sendCode', params), error => ipcError(error).code === 'invalid_params');
});

test('agents refresh deduplicates concurrent detection and emits only changes', async t => {
  const f = await fixture(t);
  await Promise.all([f.controller.refresh(), f.controller.refresh()]);
  assert.equal(f.detections(), 1);
  await f.controller.execute('agents.refresh', {});
  assert.equal(f.events.filter(e => e.event === 'agents').length, 1);
  f.changeAgents();
  await f.controller.refresh();
  assert.equal(f.events.filter(e => e.event === 'agents').length, 2);
});

test('IPC login registers device, loads ticket key, starts heartbeat and supports logout/server selection', async t => {
  let registrations = 0;
  const f = await fixture(t, async input => {
    if (String(input).endsWith('/code')) return json({ expiresIn: 300, resendAfter: 60 });
    if (String(input).endsWith('/register')) return json({ accessToken: access(Math.floor(Date.now() / 1000) + 900), refreshToken: 'refresh', user: { id: 'user-1' } });
    if (String(input).endsWith('/keys')) return json({ ed25519PublicKey: publicKeyPem });
    if (String(input).includes('/devices/')) registrations++;
    return json({ ok: true });
  });
  assert.deepEqual(await f.controller.execute('account.sendCode', { email: 'a@b.com', purpose: 'register' }), { expiresIn: 300, resendAfter: 60 });
  assert.deepEqual(await f.controller.execute('account.register', { email: 'a@b.com', code: '123456', password: 'password123' }), { id: 'user-1' });
  assert.ok(registrations >= 1);
  assert.equal(f.account.isHeartbeating, true);
  const now = Math.floor(Date.now() / 1000);
  assert.equal(authorizeUpgrade(ticket({ iat: now, exp: now + 300 }), { pairingToken: f.cfg.token, deviceId: f.cfg.deviceId, userId: f.account.user?.id, publicKeyPem: f.account.publicKeyPem }), 'account');
  await assert.rejects(f.controller.execute('account.setServer', { url: 'https://other.test' }), error => ipcError(error).code === 'signed_in');
  await f.account.registerDevice();
  await f.controller.execute('account.logout', {});
  assert.equal(f.account.status.state, 'signedOut');
  assert.equal(f.account.isHeartbeating, false);
  await f.controller.execute('account.setServer', { url: 'https://other.test/' });
  assert.equal(f.cfg.serverUrl, 'https://other.test');
  for (const url of ['garbage', 'file:///tmp', 'https://user:pass@example.test'])
    await assert.rejects(f.controller.execute('account.setServer', { url }), error => ipcError(error).code === 'invalid_params');
  assert.ok(f.events.some(e => e.event === 'account' && e.data.state === 'online'));
});

test('account events cover outage/recovery, repeated 401 and ownership conflict', async t => {
  for (const status of [401, 409]) {
    let offline = false, rejectDevice = false;
    const f = await fixture(t, async input => {
      if (offline) throw new TypeError('offline');
      if (String(input).endsWith('/password') || String(input).endsWith('/refresh')) return json({ accessToken: access(Math.floor(Date.now() / 1000) + 900), refreshToken: 'refresh', user: { id: 'user-1' } });
      if (String(input).endsWith('/keys')) return json({ ed25519PublicKey: publicKeyPem });
      if (rejectDevice) return json({ error: { code: 'rejected' } }, status);
      return json({ ok: true });
    });
    await f.account.login('a@b.com', 'password123');
    offline = true;
    await f.account.registerDevice();
    assert.equal(f.account.status.state, 'unreachable');
    offline = false;
    await f.account.registerDevice();
    assert.equal(f.account.status.state, 'online');
    rejectDevice = true;
    await f.account.registerDevice();
    assert.equal(f.account.status.state, 'revoked');
    assert.equal(f.account.isHeartbeating, false);
    assert.equal(f.account.user?.id, status === 401 ? undefined : 'user-1');
    assert.ok(f.events.some(e => e.event === 'account' && e.data.state === 'unreachable'));
  }
});

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

async function launch(t: TestContext, port: number, entry = 'src/index.ts', savedAccount = false, testNetwork = false) {
  const directory = await mkdtemp(join(tmpdir(), 'aa-ipc-process-'));
  const cfg = await loadConfig({ directory, port, getComputerName: async () => 'IPC Mac' });
  const registrations: { hosts: string[] }[] = [];
  const extraHostFile = join(directory, 'extra-host');
  if (testNetwork) await writeFile(extraHostFile, '');
  if (savedAccount) {
    const fake = createAccountServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        if (req.method === 'PUT' && req.url?.startsWith('/v1/devices/')) registrations.push(JSON.parse(body));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.url === '/v1/auth/refresh'
          ? { accessToken: access(Math.floor(Date.now() / 1000) + 900), refreshToken: 'fake' }
          : req.url === '/v1/keys' ? { ed25519PublicKey: publicKeyPem } : { ok: true }));
      });
    });
    fake.listen(0, '127.0.0.1');
    await once(fake, 'listening');
    const address = fake.address();
    assert.ok(address && typeof address !== 'string');
    cfg.serverUrl = `http://127.0.0.1:${address.port}`;
    await writePrivateFile('bridge.json', JSON.stringify(cfg), directory);
    t.after(() => new Promise<void>(resolve => { fake.close(() => resolve()); fake.closeAllConnections(); }));
  }
  if (savedAccount) {
    await saveAccount({ serverUrl: cfg.serverUrl, refreshToken: 'fake', user: { id: 'user-1' } }, directory);
    await writePrivateFile('server-key.pem', publicKeyPem, directory);
  }
  const child = spawn(process.execPath, ['--no-warnings', entry, '--ipc'], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, AA_DISABLE_BONJOUR: '1', AGENTANYWHERE_HOME: directory, AA_SERVER_URL: cfg.serverUrl,
      ...(testNetwork ? { AA_TEST_EXTRA_HOST_FILE: extraHostFile } : {}) }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'close');
  const messages: any[] = [];
  const waiters: { predicate: (message: any) => boolean; resolve: (message: any) => void }[] = [];
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    messages.push(message);
    for (const waiter of [...waiters]) if (waiter.predicate(message)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  });
  const wait = (predicate: (message: any) => boolean): Promise<any> => {
    const previous = messages.find(predicate);
    return previous ? Promise.resolve(previous) : new Promise(resolve => waiters.push({ predicate, resolve }));
  };
  let id = 0;
  const command = (method: string, params?: unknown) => {
    const requestId = ++id;
    child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n');
    return wait(message => message.id === requestId);
  };
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await rm(directory, { recursive: true, force: true });
  });
  return { child, exited, messages, wait, command, directory, cfg, registrations, extraHostFile, stderr: () => stderr };
}

async function connect(t: TestContext, port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${encodeURIComponent(token)}`);
  t.after(() => ws.terminate());
  await once(ws, 'open');
  return ws;
}

test('network polling updates IPC/account within seconds and preserves loopback clients (source and optional bundle)', listen, async t => {
  const entries = ['src/index.ts'];
  if (process.env.AA_TEST_BUNDLE === '1') entries.push('dist/bridge.mjs');
  for (const entry of entries) {
    const f = await launch(t, await freePort(), entry, true, true);
    await f.wait(message => message.event === 'ready');
    const ws = await connect(t, f.cfg.port, f.cfg.token);
    const waitForRegistration = async (hasExtra: boolean) => {
      const deadline = Date.now() + 5_000;
      while (!f.registrations.length || f.registrations.at(-1)!.hosts.includes('192.0.2.123') !== hasExtra) {
        assert.ok(Date.now() < deadline, 'Expected a fresh registration within five seconds');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    await waitForRegistration(false);
    await writeFile(f.extraHostFile, '192.0.2.123');
    const added = await f.wait(message => message.event === 'network' && message.data.hosts.some((h: any) => h.address === '192.0.2.123'));
    await waitForRegistration(true);
    const status = (await f.command('status')).result;
    assert.deepEqual(status.hosts, added.data.hosts);
    assert.equal(status.pairingUrl, added.data.pairingUrl);
    assert.equal(ws.readyState, WebSocket.OPEN);
    await writeFile(f.extraHostFile, '');
    await f.wait(message => message.event === 'network' && !message.data.hosts.some((h: any) => h.address === '192.0.2.123'));
    await waitForRegistration(false);
    assert.equal(ws.readyState, WebSocket.OPEN);
    for (const message of f.messages.filter(m => m.event === 'log')) assert.ok(!JSON.stringify(message).includes(f.cfg.token));
    await f.command('shutdown');
    assert.equal((await f.exited)[0], 0, f.stderr());
  }
});

test('IPC process ready/status/rotation/rename/EOF lifecycle (source and optional bundle)', listen, async t => {
  const entries = ['src/index.ts'];
  if (process.env.AA_TEST_BUNDLE === '1') entries.push('dist/bridge.mjs');
  for (const entry of entries) {
    const f = await launch(t, await freePort(), entry, true);
    const ready = await f.wait(message => message.event === 'ready');
    const status = (await f.command('status')).result;
    const relayStates = ['off', 'connecting', 'online', 'error'];
    assert.ok(relayStates.includes(ready.data.relay.state));
    assert.ok(relayStates.includes(status.relay.state));
    const { relay: _readyRelay, keepAwakeActive: _readyAwake, ...readySnapshot } = ready.data;
    const { relay: _statusRelay, keepAwakeActive: _statusAwake, ...statusSnapshot } = status;
    assert.deepEqual(statusSnapshot, readySnapshot);
    assert.equal(ready.data.keepAwake, 'onPower');
    assert.equal(typeof status.keepAwakeActive, 'boolean');
    await f.command('config.set', { keepAwake: 'off' });
    assert.equal((await f.command('status')).result.keepAwake, 'off');
    assert.equal(status.deviceId, f.cfg.deviceId);
    const old = await connect(t, status.port, f.cfg.token);
    const now = Math.floor(Date.now() / 1000);
    const accountSocket = await connect(t, status.port, ticket({ dev: f.cfg.deviceId, iat: now, exp: now + 300 }));
    const closed = once(old, 'close');
    const rotated = await f.command('pairing.rotate');
    await closed;
    await f.wait(message => message.event === 'log' && message.data.message.includes('Phone disconnected (127.0.0.1)'));
    assert.equal(accountSocket.readyState, WebSocket.OPEN);
    const newToken = new URL(rotated.result.pairingUrl).searchParams.get('token')!;
    assert.notEqual(newToken, f.cfg.token);
    const fresh = await connect(t, status.port, newToken);
    const rejected = new WebSocket(`ws://127.0.0.1:${status.port}?token=${f.cfg.token}`);
    const [error] = await once(rejected, 'error');
    assert.match(String(error), /401/);
    await f.command('config.set', { name: 'Renamed Mac', port: status.port === 65535 ? 65534 : status.port + 1 });
    fresh.send(JSON.stringify({ id: 1, method: 'hello' }));
    const [hello] = await once(fresh, 'message');
    assert.equal(JSON.parse(String(hello)).result.name, 'Renamed Mac');
    assert.equal((await f.command('status')).result.port, status.port);
    const persisted = JSON.parse(await readFile(join(f.directory, 'bridge.json'), 'utf8'));
    assert.equal(persisted.name, 'Renamed Mac');
    assert.equal(persisted.token, newToken);
    assert.notEqual(persisted.port, status.port);
    assert.equal((await f.command('bad-method')).error.code, 'unknown_method');
    assert.equal((await f.command('config.set', { port: -1 })).error.code, 'invalid_params');
    f.child.stdin.end();
    assert.equal((await f.exited)[0], 0, f.stderr());
    assert.ok(f.messages.some(message => message.event === 'clients' && message.data.count === 1));
    for (const message of f.messages.filter(m => m.event === 'log')) {
      assert.ok(!JSON.stringify(message).includes(f.cfg.token));
      assert.ok(!JSON.stringify(message).includes(newToken));
    }
  }
});

test('occupied port emits fatal port_in_use and exits 2', listen, async t => {
  const occupied = createServer();
  occupied.listen(0, '0.0.0.0');
  await once(occupied, 'listening');
  t.after(() => new Promise<void>(resolve => occupied.close(() => resolve())));
  const address = occupied.address();
  assert.ok(address && typeof address !== 'string');
  const f = await launch(t, address.port);
  assert.equal((await f.wait(message => message.event === 'fatal')).data.code, 'port_in_use');
  assert.equal((await f.exited)[0], 2);
});

test('shutdown command and SIGTERM exit cleanly', listen, async t => {
  for (const signal of [false, true]) {
    const f = await launch(t, await freePort());
    await f.wait(message => message.event === 'ready');
    if (signal) f.child.kill('SIGTERM');
    else assert.equal((await f.command('shutdown')).result, null);
    assert.equal((await f.exited)[0], 0);
  }
});


test('startup failure emits fatal startup_failed and exits 1 without listening', { timeout: 5_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aa-ipc-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const entry of ['src/index.ts', ...(process.env.AA_TEST_BUNDLE === '1' ? ['dist/bridge.mjs'] : [])]) {
    const child = spawn(process.execPath, ['--no-warnings', entry, '--ipc', '--port=-1'], {
      cwd: new URL('..', import.meta.url), env: { ...process.env, AGENTANYWHERE_HOME: directory }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const exited = once(child, 'close');
    const messages: any[] = [];
    createInterface({ input: child.stdout }).on('line', line => messages.push(JSON.parse(line)));
    assert.equal((await exited)[0], 1);
    const fatal = messages.find(message => message.event === 'fatal');
    assert.equal(fatal?.data.code, 'startup_failed');
    assert.match(fatal.data.message, /options\.port.*-1/);
    assert.ok(!messages.some(message => message.event === 'ready'));
  }
});

test('EOF during initialization exits cleanly without ever listening (source and optional bundle)', { timeout: 5_000 }, async t => {
  for (const entry of ['src/index.ts', ...(process.env.AA_TEST_BUNDLE === '1' ? ['dist/bridge.mjs'] : [])]) {
    // Invalid port guarantees this test cannot open a listening socket even if startup races EOF.
    const f = await launch(t, -1, entry);
    f.child.stdin.end();
    assert.equal((await f.exited)[0], 0, f.stderr());
    assert.ok(!f.messages.some(message => message.event === 'ready' || message.event === 'fatal'));
  }
});

test('account command rate limits retain retryAfter; absent retryAfter is omitted', async t => {
  const f = await fixture(t, async () => json({ error: { code: 'rate_limited', retryAfter: 42 } }, 429));
  await assert.rejects(f.controller.execute('account.sendCode', { email: 'a@b.com', purpose: 'register' }), error => ipcError(error).retryAfter === 42);
  const other = await fixture(t, async () => json({ error: { code: 'invalid_code' } }, 400));
  await assert.rejects(other.controller.execute('account.register', { email: 'a@b.com', code: '123456', password: 'password123' }), error => {
    assert.deepEqual(ipcError(error), { code: 'invalid_code', message: 'Account request failed (400, invalid_code)' });
    return true;
  });
});

test('account fetch failures map to network errors without exposing underlying diagnostics', async t => {
  const failures = [
    new TypeError('fetch failed', { cause: new Error(`ECONNREFUSED ${config.token}`) }),
    new TypeError('fetch failed', { cause: new Error('ENOTFOUND account.test') }),
    new DOMException('Request timed out', 'TimeoutError'),
    new DOMException('Request aborted', 'AbortError'),
  ];
  for (const failure of failures) {
    const f = await fixture(t, async () => { throw failure; });
    for (const [method, params] of [
      ['account.sendCode', { email: 'a@b.co', purpose: 'register' }],
      ['account.register', { email: 'a@b.co', code: '123456', password: 'password123' }],
    ] as const) {
      await assert.rejects(f.controller.execute(method, params), error => {
        assert.deepEqual(ipcError(error), { code: 'network', message: "Can't reach the account server" });
        return true;
      });
    }
  }
});

test('email IPC login/register/reset preserve secrets and start heartbeat; old commands are rejected', async t => {
  for (const method of ['account.login', 'account.register', 'account.resetPassword']) {
    const password = '  IPC password  ', code = '654321';
    const f = await fixture(t, async (input, init) => {
      const path = String(input);
      if (path.endsWith(method === 'account.login' ? '/password' : method === 'account.register' ? '/register' : '/reset')) {
        assert.deepEqual(JSON.parse(String(init?.body)), { email: 'user@example.com', password,
          ...(method === 'account.login' ? {} : { code }), deviceLabel: config.name });
        return json({ accessToken: access(Math.floor(Date.now() / 1000) + 900), refreshToken: 'ipc-refresh', user: { id: 'u', email: 'user@example.com', hasPassword: true } });
      }
      if (path.endsWith('/keys')) return json({ ed25519PublicKey: publicKeyPem });
      return json({ ok: true });
    });
    await f.controller.execute(method, { email: 'user@example.com', password, code });
    assert.equal(f.account.isHeartbeating, true);
    for (const secret of [password, code]) {
      assert.ok(!JSON.stringify(f.events).includes(secret));
      assert.ok(!(await readFile(join(f.directory, 'account.json'), 'utf8')).includes(secret));
      assert.ok(!redactLog(secret, []).includes(secret));
    }
    await assert.rejects(f.controller.execute('account.verify', {}), { code: 'unknown_method' });
    await assert.rejects(f.controller.execute('account.sendCode', { email: 'user@example.com', purpose: 'login' }), { code: 'invalid_params' });
    await assert.rejects(f.controller.execute(method, { phone: '13800000000', password }), { code: 'invalid_params' });
  }
});

test('IPC keepAwake validates and persists before applying; status exposes the live mode', async t => {
  const f = await fixture(t);
  const applied: string[] = [];
  const controller = createIpcController({ cfg: f.cfg, account: f.account, adapters: [],
    server: { clientCount: () => 0, disconnectPairing() {} }, emit() {}, rememberToken() {},
    keepAwake: { active: true, setMode: mode => applied.push(mode) }, persist: async next => { f.persisted.push(next); } });
  for (const keepAwake of ['off', 'always', 'onPower']) {
    assert.deepEqual(await controller.execute('config.set', { keepAwake }), { restartRequired: false });
    assert.equal(controller.status().keepAwake, keepAwake);
    assert.equal(f.persisted.at(-1)?.keepAwake, keepAwake);
  }
  assert.equal(controller.status().keepAwakeActive, true);
  assert.deepEqual(applied, ['off', 'always', 'onPower']);
  for (const keepAwake of ['bad', null, 1]) await assert.rejects(controller.execute('config.set', { keepAwake }), e => ipcError(e).code === 'invalid_params');
  const failing = createIpcController({ cfg: f.cfg, account: f.account, adapters: [],
    server: { clientCount: () => 0, disconnectPairing() {} }, emit() {}, rememberToken() {},
    keepAwake: { active: false, setMode: mode => applied.push(mode) }, persist: async () => { throw new Error('disk full'); } });
  await assert.rejects(failing.execute('config.set', { keepAwake: 'off' }));
  assert.equal(f.cfg.keepAwake, 'onPower');
  assert.equal(applied.length, 3);
});
