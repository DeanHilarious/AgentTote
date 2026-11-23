import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { clientIp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { fixture, keys, secret } from './helpers.ts';

test('trust proxy configuration defaults off and only accepts 1 or true', t => {
  const dir = mkdtempSync(join(tmpdir(), 'aa-proxy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = {
    AA_DATA_DIR: dir, AA_SERVER_SECRET: secret,
    AA_SIGNING_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
  assert.equal(loadConfig(env).trustProxy, false);
  for (const value of ['1', 'true', '0', 'false', '', 'TRUE']) {
    assert.equal(loadConfig({ ...env, AA_TRUST_PROXY: value }).trustProxy, value === '1' || value === 'true');
  }
});

test('clientIp uses the last trimmed XFF address and falls back to the socket', t => {
  const socket = new Socket();
  t.after(() => socket.destroy());
  Object.defineProperty(socket, 'remoteAddress', { value: '192.0.2.10' });
  const req = new IncomingMessage(socket);
  for (const value of [undefined, '', '   ', '198.51.100.1, ']) {
    req.headers['x-forwarded-for'] = value;
    assert.equal(clientIp(req, true), '192.0.2.10');
  }
  req.headers['x-forwarded-for'] = '198.51.100.1,  2001:db8::1  ';
  assert.equal(clientIp(req, true), '2001:db8::1');
  assert.equal(clientIp(req, false), '192.0.2.10');
  req.headers['x-forwarded-for'] = ['198.51.100.1', '198.51.100.2, 203.0.113.5 '];
  assert.equal(clientIp(req, true), '203.0.113.5');
});

test('untrusted XFF cannot bypass the per-IP quota', async t => {
  const f = await fixture(t, new Map(), undefined, { trustProxy: false });
  for (let i = 0; i < 31; i++) {
    const response = await f.request('POST', '/auth/code', { purpose: 'register', channel: 'email', target: `untrusted-${i}@example.com` },
      { headers: { 'x-forwarded-for': `198.51.100.${i + 1}` } });
    assert.equal(response.status, i < 30 ? 200 : 429);
    if (i === 30) {
      assert.equal(response.body.error.code, 'rate_limited');
      assert.equal(response.body.error.retryAfter, 3600);
    }
  }
  const ips = f.db.prepare('SELECT DISTINCT ip FROM codes').all();
  assert.equal(ips.length, 1);
  assert.ok(!String(ips[0].ip).startsWith('198.51.100.'));
});

test('trusted XFF counts different final addresses separately and shares quota despite forged prefixes', async t => {
  const f = await fixture(t, new Map(), undefined, { trustProxy: true });
  for (let i = 0; i < 31; i++) {
    for (const ip of ['203.0.113.1', '203.0.113.2']) {
      const response = await f.request('POST', '/auth/code', { purpose: 'register', channel: 'email', target: `trusted-${ip}-${i}@example.com` },
        { headers: { 'x-forwarded-for': `198.51.100.${i + 1},  ${ip}  ` } });
      assert.equal(response.status, i < 30 ? 200 : 429);
      if (i === 30) assert.equal(response.body.error.retryAfter, 3600);
    }
  }
  const counts = f.db.prepare('SELECT ip, count(*) AS n FROM codes GROUP BY ip ORDER BY ip').all();
  assert.deepEqual(counts.map(row => ({ ...row })), [{ ip: '203.0.113.1', n: 30 }, { ip: '203.0.113.2', n: 30 }]);
});

test('createApp reads AA_TRUST_PROXY without changing the startup entry point', async t => {
  const previous = process.env.AA_TRUST_PROXY;
  process.env.AA_TRUST_PROXY = 'true';
  try {
    const f = await fixture(t);
    const response = await f.request('POST', '/auth/code', { purpose: 'register', channel: 'email', target: 'proxy-env@example.com' },
      { headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.3' } });
    assert.equal(response.status, 200);
    assert.equal(f.db.prepare('SELECT ip FROM codes').get()!.ip, '203.0.113.3');
  } finally {
    if (previous === undefined) delete process.env.AA_TRUST_PROXY;
    else process.env.AA_TRUST_PROXY = previous;
  }
});
