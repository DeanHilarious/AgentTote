import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { AccountClient, AccountError } from '../src/account.ts';
import { login } from '../src/accountCli.ts';
import { loadAccount, saveAccount } from '../src/config.ts';
import { access, config, json, nowMs, nowSeconds, publicKeyPem, ticket } from './accountHelpers.ts';
import { authorizeUpgrade } from '../src/server.ts';

async function fixture(t: TestContext, fetcher: typeof fetch, options: { saved?: boolean; deviceInfo?: () => { name: string; hosts: string[]; port: number; bridgeVersion: string } } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'aa-client-'));
  const logs: string[] = [];
  let time = nowMs;
  if (options.saved) await saveAccount({ serverUrl: config.serverUrl, refreshToken: 'old-refresh', user: { id: 'user-1', email: 'user@example.com' } }, directory);
  const client = new AccountClient({ config, bridgeVersion: '0.1.0', directory, fetch: fetcher, now: () => time, log: message => logs.push(message), deviceInfo: options.deviceInfo });
  t.after(async () => { client.stop(); await rm(directory, { recursive: true, force: true }); });
  await client.initialize();
  return { client, directory, logs, setTime: (value: number) => { time = value; } };
}

test('login sends Mac label and saves user/refresh token without persisting access token', async t => {
  const calls: { url: string; body: unknown }[] = [];
  const { client, directory } = await fixture(t, async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    if (String(input).endsWith('/code')) return json({ expiresIn: 300, resendAfter: 60 });
    return json({ accessToken: access(), refreshToken: 'login-refresh', user: { id: 'user-1', email: 'user@example.com' } });
  });
  await client.sendCode('user@example.com', 'register');
  await client.login('user@example.com', 'password123');
  assert.deepEqual(calls[1].body, { email: 'user@example.com', password: 'password123', deviceLabel: config.name });
  assert.deepEqual(await loadAccount(directory), { serverUrl: config.serverUrl, refreshToken: 'login-refresh', user: { id: 'user-1', email: 'user@example.com' } });
  assert.equal((await stat(join(directory, 'account.json'))).mode & 0o777, 0o600);
  assert.equal((await readFile(join(directory, 'account.json'), 'utf8')).includes('accessToken'), false);
});

test('an access token within 60 seconds of expiry refreshes and persists before the authenticated request', async t => {
  let refreshes = 0;
  let directory = '';
  const f = await fixture(t, async (input, init) => {
    if (String(input).endsWith('/password')) return json({ accessToken: access(nowSeconds + 59), refreshToken: 'old-refresh', user: { id: 'user-1' } });
    if (String(input).endsWith('/refresh')) {
      refreshes++;
      assert.deepEqual(JSON.parse(String(init?.body)), { refreshToken: refreshes === 1 ? 'old-refresh' : 'new-refresh' });
      return json({ accessToken: access(), refreshToken: refreshes === 1 ? 'new-refresh' : 'latest-refresh' });
    }
    assert.equal((await loadAccount(directory))?.refreshToken, refreshes === 1 ? 'new-refresh' : 'latest-refresh');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${access()}`);
    return json({ id: 'user-1' });
  });
  directory = f.directory;
  await f.client.login('user@example.com', 'password123');
  assert.deepEqual(await f.client.authorizedRequest('/me'), { id: 'user-1' });
  assert.equal(refreshes, 1);
  f.setTime(nowMs + 901_000);
  await f.client.authorizedRequest('/me');
  assert.equal(refreshes, 2);
});

test('concurrent requests with an expiring access token share exactly one refresh', async t => {
  let refreshes = 0;
  const { client, directory } = await fixture(t, async input => {
    if (String(input).endsWith('/refresh')) {
      refreshes++;
      await new Promise<void>(resolve => setImmediate(resolve));
      return json({ accessToken: access(), refreshToken: 'new-refresh' });
    }
    return json({ ok: true });
  }, { saved: true });
  const results = await Promise.all([client.authorizedRequest('/me'), client.authorizedRequest('/devices')]);
  assert.deepEqual(results, [{ ok: true }, { ok: true }]);
  assert.equal(refreshes, 1);
  assert.equal((await loadAccount(directory))?.refreshToken, 'new-refresh');
});

test('a late concurrent 401 retries the current token instead of rotating again', async t => {
  const initial = access(nowSeconds + 800);
  let refreshes = 0;
  let releaseSecond!: (response: Response) => void;
  const delayed = new Promise<Response>(resolve => { releaseSecond = resolve; });
  const { client } = await fixture(t, async (input, init) => {
    if (String(input).endsWith('/password')) return json({ accessToken: initial, refreshToken: 'old-refresh', user: { id: 'user-1' } });
    if (String(input).endsWith('/refresh')) {
      refreshes++;
      return json({ accessToken: access(), refreshToken: 'new-refresh' });
    }
    if (new Headers(init?.headers).get('authorization') === `Bearer ${initial}`) {
      if (String(input).endsWith('/second')) return delayed;
      return json({ error: { code: 'unauthorized' } }, 401);
    }
    return json({ ok: true });
  });
  await client.login('user@example.com', 'password123');
  const second = client.authorizedRequest('/second');
  assert.deepEqual(await client.authorizedRequest('/first'), { ok: true });
  releaseSecond(json({ error: { code: 'unauthorized' } }, 401));
  assert.deepEqual(await second, { ok: true });
  assert.equal(refreshes, 1);
});

test('refresh 401 signs out once, deletes persisted credentials and stops heartbeat without rejecting callers', async t => {
  let calls = 0;
  const { client, directory, logs } = await fixture(t, async () => {
    calls++;
    return json({ error: { code: 'unauthorized' } }, 401);
  }, { saved: true });
  client.start();
  await client.registerDevice();
  assert.equal(await client.authorizedRequest('/me'), undefined);
  assert.equal(client.user, undefined);
  assert.equal(client.isHeartbeating, false);
  assert.equal(await loadAccount(directory), undefined);
  assert.deepEqual(logs, ['账号登录已失效，请运行 npm run login 重新登录']);
  assert.equal(calls, 1);
});

test('heartbeat 409 stops scheduling and subsequent registrations', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let deviceCalls = 0;
  const { client, logs } = await fixture(t, async input => {
    if (String(input).endsWith('/refresh')) return json({ accessToken: access(), refreshToken: 'new-refresh' });
    if (String(input).endsWith('/keys')) return json({ ed25519PublicKey: publicKeyPem });
    deviceCalls++;
    return json({ error: { code: 'conflict' } }, 409);
  }, { saved: true });
  client.start();
  assert.equal(await client.registerDevice(), false);
  assert.equal(client.isHeartbeating, false);
  t.mock.timers.tick(180_000);
  client.start();
  assert.equal(await client.registerDevice(), false);
  assert.equal(deviceCalls, 1);
  assert.match(logs[0], /设备已属于其他账号.*停止心跳/);
});

test('a device API failure still refreshes the key for offline ticket verification', async t => {
  const { client, directory } = await fixture(t, async input => {
    if (String(input).endsWith('/refresh')) return json({ accessToken: access(), refreshToken: 'new-refresh' });
    if (String(input).endsWith('/keys')) return json({ ed25519PublicKey: publicKeyPem });
    return json({ error: { code: 'internal_error' } }, 500);
  }, { saved: true });
  assert.equal(await client.registerDevice(), false);
  assert.equal(client.publicKeyPem, publicKeyPem);
  assert.equal(await readFile(join(directory, 'server-key.pem'), 'utf8'), publicKeyPem);
});

test('heartbeat runs immediately and every 60 seconds with freshly collected addresses', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const bodies: unknown[] = [];
  let hosts = ['192.168.1.2'];
  const { client } = await fixture(t, async (input, init) => {
    if (String(input).endsWith('/refresh')) return json({ accessToken: access(), refreshToken: 'new-refresh' });
    if (String(input).endsWith('/keys')) return json({ ed25519PublicKey: publicKeyPem });
    assert.equal(init?.method, 'PUT');
    assert.ok(String(input).endsWith(`/devices/${config.deviceId}`));
    bodies.push(JSON.parse(String(init?.body)));
    return json({ id: config.deviceId });
  }, { saved: true, deviceInfo: () => ({ name: config.name, hosts, port: config.port, bridgeVersion: '0.1.0' }) });
  client.start();
  await client.registerDevice();
  assert.equal(bodies.length, 1);
  hosts = ['100.100.1.2'];
  t.mock.timers.tick(59_999);
  assert.equal(bodies.length, 1);
  t.mock.timers.tick(1);
  await client.registerDevice();
  assert.deepEqual(bodies, [
    { name: config.name, hosts: ['192.168.1.2'], port: config.port, bridgeVersion: '0.1.0' },
    { name: config.name, hosts: ['100.100.1.2'], port: config.port, bridgeVersion: '0.1.0' },
  ]);
});

test('network errors are contained and only outage/recovery transitions are logged', async t => {
  let offline = true;
  const { client, logs } = await fixture(t, async input => {
    if (offline) throw new TypeError('fetch failed');
    if (String(input).endsWith('/refresh')) return json({ accessToken: access(), refreshToken: 'new-refresh' });
    if (String(input).endsWith('/keys')) return json({ ed25519PublicKey: publicKeyPem });
    return json({ ok: true });
  }, { saved: true });
  client.start();
  assert.equal(await client.registerDevice(), false);
  assert.equal(await client.registerDevice(), false);
  assert.equal(client.isHeartbeating, true);
  offline = false;
  assert.equal(await client.registerDevice(), true);
  assert.equal(await client.registerDevice(), true);
  offline = true;
  assert.equal(await client.registerDevice(), false);
  assert.deepEqual(logs, ['账号服务不可达', '账号服务已恢复', '账号服务不可达']);
  assert.equal(client.user?.id, 'user-1');
});

test('network changes during an in-flight heartbeat coalesce into one fresh registration', async t => {
  let hosts = ['192.0.2.1'];
  const bodies: any[] = [];
  let release!: (response: Response) => void;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const held = new Promise<Response>(resolve => { release = resolve; });
  const { client } = await fixture(t, async (input, init) => {
    if (String(input).endsWith('/refresh')) return json({ accessToken: access(), refreshToken: 'new-refresh' });
    if (String(input).endsWith('/keys')) return json({ ed25519PublicKey: publicKeyPem });
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) { began(); return held; }
    return json({ id: config.deviceId });
  }, { saved: true, deviceInfo: () => ({ name: config.name, hosts, port: config.port, bridgeVersion: '0.1.0' }) });
  const first = client.registerDevice();
  await started;
  hosts = ['192.0.2.2'];
  assert.equal(client.registerDevice(true), first);
  hosts = ['192.0.2.3'];
  assert.equal(client.registerDevice(true), first);
  assert.equal(bodies.length, 1);
  release(json({ id: config.deviceId }));
  await first;
  await client.registerDevice();
  assert.deepEqual(bodies.map(body => body.hosts), [['192.0.2.1'], ['192.0.2.3']]);
});

test('startup loads a cached key without network and retains offline ticket validation', async t => {
  const { client, directory } = await fixture(t, async () => { throw new TypeError('offline'); }, { saved: true });
  await writeFile(join(directory, 'server-key.pem'), publicKeyPem);
  await client.initialize();
  assert.equal(client.publicKeyPem, publicKeyPem);
  await client.refreshKeys();
  assert.equal(client.publicKeyPem, publicKeyPem);
  assert.equal(authorizeUpgrade(ticket(), { pairingToken: config.token, deviceId: config.deviceId, userId: client.user?.id, publicKeyPem: client.publicKeyPem, now: () => nowMs }), 'account');
});

test('online key refresh persists valid Ed25519 keys and rejects malformed replacements', async t => {
  let pem = publicKeyPem;
  const { client, directory } = await fixture(t, async () => json({ ed25519PublicKey: pem }), { saved: true });
  await client.refreshKeys();
  assert.equal(await readFile(join(directory, 'server-key.pem'), 'utf8'), publicKeyPem);
  pem = 'bad key';
  await client.refreshKeys();
  assert.equal(client.publicKeyPem, publicKeyPem);
  assert.equal(await readFile(join(directory, 'server-key.pem'), 'utf8'), publicKeyPem);
});

test('logout revokes the current rotated token; network failure still removes local credentials', async t => {
  let logoutBody: unknown;
  const { client, directory } = await fixture(t, async (input, init) => {
    if (String(input).endsWith('/refresh')) return json({ accessToken: access(), refreshToken: 'new-refresh' });
    if (String(input).endsWith('/logout')) {
      logoutBody = JSON.parse(String(init?.body));
      throw new TypeError('offline');
    }
    return json({ ok: true });
  }, { saved: true });
  await client.authorizedRequest('/me');
  await client.logout();
  assert.deepEqual(logoutBody, { refreshToken: 'new-refresh' });
  assert.equal(client.user, undefined);
  assert.equal(await loadAccount(directory), undefined);
});

test('an unlogged client never starts heartbeat or performs authenticated network requests', async t => {
  let calls = 0;
  const { client } = await fixture(t, async () => { calls++; throw new Error('must not fetch'); });
  client.start();
  assert.equal(client.isHeartbeating, false);
  assert.equal(await client.registerDevice(), false);
  assert.equal(await client.authorizedRequest('/me'), undefined);
  assert.equal(calls, 0);
});

test('changing servers disables the saved session and cached key, while logout revokes on the original server', async t => {
  const urls: string[] = [];
  const { directory } = await fixture(t, async () => json({}), { saved: true });
  await writeFile(join(directory, 'server-key.pem'), publicKeyPem);
  const client = new AccountClient({ config: { ...config, serverUrl: 'http://different.test' }, bridgeVersion: '0.1.0', directory, fetch: async input => { urls.push(String(input)); return json({ ok: true }); } });
  await client.initialize();
  assert.equal(client.user, undefined);
  assert.equal(client.publicKeyPem, undefined);
  assert.equal(await client.authorizedRequest('/me'), undefined);
  await client.logout();
  assert.deepEqual(urls, [`${config.serverUrl}/v1/auth/logout`]);
});

test('failed token persistence cannot cause reuse of the previous refresh token', async t => {
  const used: string[] = [];
  const { client, directory } = await fixture(t, async (input, init) => {
    if (String(input).endsWith('/refresh')) {
      const token = JSON.parse(String(init?.body)).refreshToken;
      used.push(token);
      return json({ accessToken: access(), refreshToken: token === 'old-refresh' ? 'new-refresh' : 'latest-refresh' });
    }
    return json({ ok: true });
  }, { saved: true });
  await rm(join(directory, 'account.json'));
  await mkdir(join(directory, 'account.json'));
  assert.equal(await client.registerDevice(), false);
  assert.deepEqual(used, ['old-refresh']);
  await rm(join(directory, 'account.json'), { recursive: true });
  assert.deepEqual(await client.authorizedRequest('/me'), { ok: true });
  assert.deepEqual(used, ['old-refresh', 'new-refresh']);
  assert.equal((await loadAccount(directory))?.refreshToken, 'latest-refresh');
});

test('code rate limits preserve retryAfter for the CLI', async t => {
  const { client } = await fixture(t, async () => json({ error: { code: 'rate_limited', retryAfter: 42 } }, 429));
  await assert.rejects(client.sendCode('user@example.com', 'register'), error => error instanceof AccountError && error.status === 429 && error.retryAfter === 42);
});

test('CLI displays verification and rate-limit failures without exposing secrets', async t => {
  for (const limited of [false, true]) {
    const { client } = await fixture(t, async input => {
      if (String(input).endsWith('/code') && !limited) return json({ expiresIn: 300, resendAfter: 60 });
      return json({ error: { code: limited ? 'rate_limited' : 'invalid_code', ...(limited ? { retryAfter: 37 } : {}) } }, limited ? 429 : 400);
    });
    const answers = ['r', 'user@example.com', '123456', 'password123', 'password123'];
    const logs: string[] = [];
    assert.equal(await login(client, { question: async () => answers.shift()!, log: message => logs.push(message) }), false);
    assert.equal(logs.at(-1), limited ? '请求过于频繁，请在 37 秒后再试' : '登录失败：invalid_code');
    assert.ok(!JSON.stringify(logs).includes('123456'));
    assert.ok(!JSON.stringify(logs).includes('password123'));
  }
});

test('interactive login does not report success if initial registration reveals a revoked refresh token', async t => {
  const { client } = await fixture(t, async input => {
    if (String(input).endsWith('/code')) return json({ expiresIn: 300, resendAfter: 60 });
    if (String(input).endsWith('/password')) return json({ accessToken: access(nowSeconds + 30), refreshToken: 'revoked-refresh', user: { id: 'user-1' } });
    return json({ error: { code: 'unauthorized' } }, 401);
  });
  const answers = ['user@example.com', 'password123'];
  const logs: string[] = [];
  assert.equal(await login(client, { question: async () => answers.shift()!, log: message => logs.push(message) }), false);
  assert.ok(logs.every(message => !message.startsWith('已登录')));
});

test('default login reader buffers all piped lines across prompts and requests', { timeout: 2_000 }, async t => {
  const { client } = await fixture(t, async (input, init) => {
    if (String(input).endsWith('/password')) {
      assert.deepEqual(JSON.parse(String(init?.body)), { email: 'a@b.com', password: 'password123', deviceLabel: config.name });
      return json({ accessToken: access(), refreshToken: 'refresh', user: { id: 'u', email: 'a@b.com' } });
    }
    if (String(input).endsWith('/keys')) return json({ ed25519PublicKey: publicKeyPem });
    return json({ ok: true });
  });
  let prompts = '';
  const output = new Writable({ write(chunk, _encoding, done) { prompts += chunk.toString(); done(); } });
  assert.equal(await login(client, { input: Readable.from(['a@b.com\n', 'password123\n']), output, log() {} }), true);
  assert.equal(prompts, '邮箱（输入 r 注册，f 重置密码）：密码：');
});

test('default login reader fails clearly without hanging when piped input ends early', { timeout: 2_000 }, async t => {
  for (const lines of [[], ['r\n'], ['r\n', 'a@b.com\n']]) {
    const { client, directory } = await fixture(t, async input => {
      assert.ok(String(input).endsWith('/code'));
      return json({ expiresIn: 300, resendAfter: 60 });
    });
    const logs: string[] = [];
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    assert.equal(await login(client, { input: Readable.from(lines), output, log: message => logs.push(message) }), false);
    assert.equal(logs.at(-1), '输入已结束，登录未完成');
    assert.equal(await loadAccount(directory), undefined);
  }
});

test('relay token accessor refreshes and subscribers observe logout immediately', async t => {
  let refreshes = 0;
  const { client } = await fixture(t, async input => {
    if (String(input).endsWith('/refresh')) {
      refreshes++;
      return json({ accessToken: access(), refreshToken: `refresh-${refreshes}` });
    }
    return json({ ok: true });
  }, { saved: true });
  assert.equal(await client.getAccessToken(), access());
  assert.equal(await client.getAccessToken(), access());
  assert.equal(refreshes, 1);
  await client.getAccessToken(true);
  assert.equal(refreshes, 2);
  const states: string[] = [];
  const unsubscribe = client.subscribe(() => states.push(client.status.state));
  const logout = client.logout();
  assert.equal(states[0], 'signedOut');
  assert.equal(await client.getAccessToken(), undefined);
  await logout; unsubscribe();
});

test('device registration publishes the bridge identity public key', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aa-registration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pk = Buffer.alloc(32, 7).toString('base64url');
  let body: any;
  const client = new AccountClient({ config: { ...config, publicKey: pk }, directory, bridgeVersion: '0.1.0', now: () => nowMs,
    fetch: async (input, init) => {
      if (String(input).endsWith('/password')) return json({ accessToken: access(), refreshToken: 'refresh', user: { id: 'user-1' } });
      if (String(input).endsWith('/keys')) return json({ ed25519PublicKey: publicKeyPem });
      body = JSON.parse(String(init?.body)); return json({ ok: true });
    },
  });
  await client.login('user@example.com', 'password123');
  assert.equal(await client.registerDevice(), true);
  assert.equal(body.publicKey, pk);
});

test('password login and registration reuse session persistence without saving the password', async t => {
  const calls: { path: string; body: unknown }[] = [];
  const password = '  private password  ';
  const { client, directory } = await fixture(t, async (input, init) => {
    calls.push({ path: String(input), body: JSON.parse(String(init?.body)) });
    return json({ accessToken: access(), refreshToken: 'password-refresh', user: { id: 'phone-user', phone: '+8613800000000', hasPassword: true } });
  });
  await client.login('user@example.com', password);
  await client.register('user@example.com', '123456', password);
  assert.ok(calls[0].path.endsWith('/auth/password'));
  assert.ok(calls[1].path.endsWith('/auth/register'));
  assert.deepEqual(calls[0].body, { email: 'user@example.com', password, deviceLabel: config.name });
  assert.equal(client.user?.id, 'phone-user');
  assert.equal(client.status.state, 'online');
  assert.ok(await client.getAccessToken());
  assert.ok(!(await readFile(join(directory, 'account.json'), 'utf8')).includes(password));
});

test('email CLI register/reset verifies codes and confirms passwords without persisting secrets', async t => {
  for (const flow of ['r', 'f']) {
    const password = '  pass word  ';
    const { client, directory } = await fixture(t, async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (String(input).endsWith('/code')) {
        assert.deepEqual(body, { channel: 'email', target: 'user@example.com', purpose: flow === 'r' ? 'register' : 'reset' });
        return json({ expiresIn: 300, resendAfter: 60 });
      }
      if (String(input).endsWith(flow === 'r' ? '/register' : '/reset')) {
        assert.deepEqual(body, { email: 'user@example.com', code: '123456', password, deviceLabel: config.name });
        return json({ accessToken: access(), refreshToken: 'refresh', user: { id: 'u', email: 'user@example.com' } });
      }
      if (String(input).endsWith('/keys')) return json({ ed25519PublicKey: publicKeyPem });
      return json({ ok: true });
    });
    const answers = [flow, 'user@example.com', '123456', password, password];
    const logs: string[] = [];
    assert.equal(await login(client, { question: async () => answers.shift()!, log: value => logs.push(value) }), true);
    const stored = await readFile(join(directory, 'account.json'), 'utf8');
    for (const secret of [password, '123456']) {
      assert.ok(!JSON.stringify(logs).includes(secret));
      assert.ok(!stored.includes(secret));
    }
  }
});

test('CLI rejects mismatched passwords before registration', async t => {
  const { client } = await fixture(t, async input => {
    assert.ok(String(input).endsWith('/code'));
    return json({ expiresIn: 300, resendAfter: 60 });
  });
  const answers = ['r', 'user@example.com', '123456', 'password1', 'password2'];
  const logs: string[] = [];
  assert.equal(await login(client, { question: async () => answers.shift()!, log: value => logs.push(value) }), false);
  assert.match(logs.at(-1)!, /不一致/);
});

test('TTY password prompts suppress readline echo and restore normal output', async t => {
  const { PassThrough } = await import('node:stream');
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode(_value: boolean) {} });
  let display = '';
  const password = 'secret-tty-password';
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) {
    const text = chunk.toString();
    display += text;
    const answer = text.includes('邮箱（') ? 'user@example.com' : text === '密码：' ? password : undefined;
    if (answer !== undefined) setImmediate(() => input.write(answer + '\r'));
    done();
  } }), { isTTY: true });
  const { client } = await fixture(t, async (url, init) => {
    if (String(url).endsWith('/password')) {
      assert.equal(JSON.parse(String(init?.body)).password, password);
      return json({ accessToken: access(), refreshToken: 'tty-refresh', user: { id: 'tty-user' } });
    }
    if (String(url).endsWith('/keys')) return json({ ed25519PublicKey: publicKeyPem });
    return json({ id: config.deviceId });
  });
  assert.equal(await login(client, { input, output, log: () => {} }), true);
  assert.ok(display.includes('user@example.com'));
  assert.ok(!display.includes(password));
  input.destroy(); output.destroy();
});
