import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import { Agent, createServer, request as httpRequest, type IncomingMessage, type ClientRequest } from 'node:http';
import { WebPreviews, parseListeners, cleanHeaders, PREVIEW_CHUNK, EXCLUDED_PORTS, DEVELOPMENT_RUNTIMES, blockedProcess, probeWebServer, PREVIEW_PROBE_TTL } from '../src/preview.ts';
const row = (port: number, name = 'node') => `${name} 123 user 4u IPv4 0 0 TCP 127.0.0.1:${port} (LISTEN)`;

test('preview discovery requires trusted process provenance AND HTML; blacklist wins over task URLs', async t => {
  // Real desktop process families, including lsof's truncation and escaped spaces.
  const desktop = ['WeChat', 'WeChatApp', 'Feishu', 'Lark', 'DingTalk', 'ToDesk', 'TeamViewe',
    'wpsclouds', 'netdisk', 'logioptio', 'idea', 'webstorm', 'pycharm', String.raw`Code\x20Help`,
    String.raw`Code\x20H`, 'language_', 'QoderCN', 'Antigravi', 'XTerminal', 'Electron',
    'AppHelper', 'AppHelpe', 'claude', 'ChatGPT', 'codex', 'clash-ver', 'verge-mih', 'mihomo',
    'Surge', 'Shadowsoc', 'Tailscale', 'ssh', 'sshd', 'ControlCe', 'rapportd', 'sharingd', 'sandbox'];
  const desktopRows = desktop.map((name, i) => row(10000 + i, name));
  const output = [row(3000), row(3001, 'python3.1'), row(3002, 'Python'), row(3003, 'node'), row(3004, 'python'),
    ...desktopRows, ...[...EXCLUDED_PORTS, 80, 9999].map(port => row(port)),
    row(3010).replace(' 123 ', ` ${process.pid} `),
    row(3011), row(3011, String.raw`Code\x20Help`)].join('\n');
  const probed: number[] = [];
  const previews = new WebPreviews(() => 9999, async () => output, 30_000, Date.now, httpRequest, async port => {
    probed.push(port); return port !== 3003 && port !== 3004;
  }); t.after(() => previews.close());
  // Force task attribution onto each blacklisted process and forbidden port.
  for (const [i, name] of desktop.entries()) if (blockedProcess(name, 123)) previews.observe('task', `http://localhost:${10000 + i}/ `);
  for (const port of [...EXCLUDED_PORTS, 3010, 3011, 9999, 80, 4321]) previews.observe('task', `http://localhost:${port}/ `);
  previews.observe('task', 'http://local'); previews.observe('task', 'host:3000/');
  const targets = await previews.targets();
  assert.deepEqual(targets.map(t => [t.port, t.process, t.source]), [[3000, 'node', 'task'], [3001, 'python3.1', 'lsof'], [3002, 'Python', 'lsof']]);
  assert.deepEqual(targets[0]?.taskIds, ['task']);
  assert.deepEqual(probed.sort((a, b) => a - b), [3000, 3001, 3002, 3003, 3004], 'Untrusted/blacklisted processes are not even probed');
  assert.equal(parseListeners(row(4000, String.raw`Code\x20Help`), 9999)[0]?.process, 'Code Help');
  for (const name of ['WECHAT', 'Feishu Helper', 'Code Help', String.raw`Code\x20Helper`, 'SomeHelpe', 'ControlCe', 'language_', 'Antigravi']) assert.equal(blockedProcess(name, 123), true, name);
  for (const port of [...EXCLUDED_PORTS, 3010, 3011, 10000, 9999, 80, 4321]) {
    await assert.rejects(previews.request({ port, method: 'GET', path: '/' }, {}), /not available/, `Direct RPC must reject ${port}`);
  }
  assert.deepEqual(cleanHeaders({ Connection: 'x-private', 'X-Private': 'hidden', Host: 'evil', 'Transfer-Encoding': 'chunked', 'X-Test': 'ok', 'Set-Cookie': ['a=b', 'c=d'] }), { 'x-test': 'ok', 'set-cookie': ['a=b', 'c=d'] });
});

test('runtime whitelist is exact; a custom task server still needs a live non-blacklisted owner and HTML', async t => {
  for (const name of ['node', 'bun', 'deno', 'python', 'Python', 'python3', 'python3.1', 'python3.12', 'ruby', 'php', 'java', 'hugo', 'caddy', 'http-server', 'http-serv', 'vite', 'esbuild', 'dotnet']) assert.ok(DEVELOPMENT_RUNTIMES.test(name), name);
  for (const name of ['nodeHelper', 'python-helper', 'python2', 'javac', 'node-debug', 'Code Help']) assert.ok(!DEVELOPMENT_RUNTIMES.test(name), name);
  let output = row(4000, 'my-web'); let html = true;
  const previews = new WebPreviews(() => 9999, async () => output, 30_000, Date.now, httpRequest, async () => html); t.after(() => previews.close());
  assert.deepEqual(await previews.targets(), []);
  previews.observe('task', 'http://127.0.0.1:4000/');
  assert.equal((await previews.targets())[0]?.source, 'task');
  output = row(4000, 'ssh');
  assert.deepEqual(await previews.targets(), [], 'A cached HTML result cannot override a newly blacklisted process');
  output = row(4000, 'my-web'); html = false;
  assert.deepEqual(await previews.targets(), [], 'Task source alone does not bypass the probe');
  output = '';
  assert.deepEqual(await previews.targets(), [], 'A historical task URL cannot resurrect a missing listener');
});

test('probe caches success and failure for 15 seconds, coalesces refreshes, and invalidates on PID change', async t => {
  let now = 0, calls = 0, pid = 123;
  const previews = new WebPreviews(() => 9999, async () => [row(3000).replace(' 123 ', ` ${pid} `), row(3001)].join('\n'), 30_000, () => now, httpRequest,
    async port => { calls++; return port === 3000; }); t.after(() => previews.close());
  await Promise.all([previews.targets(), previews.targets()]); assert.equal(calls, 2);
  now = PREVIEW_PROBE_TTL - 1; await previews.targets(); assert.equal(calls, 2);
  now = PREVIEW_PROBE_TTL; await previews.targets(); assert.equal(calls, 4);
  pid = 456; await previews.targets(); assert.equal(calls, 5, 'Changed owner cannot reuse an old HTML probe');
});

test('probe timeouts, errors and failed listener scans fail closed', async t => {
  const previews = new WebPreviews(() => 9999, async () => row(3000), 30_000, Date.now, httpRequest,
    async () => new Promise<boolean>(() => {})); t.after(() => previews.close());
  assert.deepEqual(await previews.targets(), []);
  const failed = new WebPreviews(() => 9999, async () => { throw new Error('lsof failed'); }, 30_000, Date.now, httpRequest,
    async () => { assert.fail('Do not probe without a process inventory'); }); t.after(() => failed.close());
  failed.observe('task', 'http://localhost:3000/'); assert.deepEqual(await failed.targets(), []);
});

test('HTTP probe uses loopback GET /, requires 2xx/3xx HTML, never follows redirects or consumes a body', async () => {
  for (const [status, type, expected] of [[200, 'text/html; charset=utf-8', true], [204, 'TEXT/HTML', true],
    [302, 'text/html', true], [302, '', false], [200, 'application/json', false], [404, 'text/html', false], [500, 'text/html', false]] as const) {
    let destroyed = false, calls = 0;
    const response = new PassThrough() as unknown as IncomingMessage;
    response.statusCode = status; response.headers = { 'content-type': type, location: 'http://localhost:63342/private' };
    const transport = ((options: any, callback: (r: IncomingMessage) => void) => {
      calls++; assert.equal(options.hostname, '127.0.0.1'); assert.equal(options.method, 'GET'); assert.equal(options.path, '/');
      const request = new EventEmitter() as ClientRequest;
      request.destroy = (() => { destroyed = true; return request; }) as typeof request.destroy;
      request.end = (() => { queueMicrotask(() => callback(response)); return request; }) as typeof request.end;
      return request;
    }) as typeof httpRequest;
    assert.equal(await probeWebServer(3000, transport), expected, `${status} ${type}`);
    assert.equal(calls, 1); assert.equal(destroyed, true); assert.equal(response.destroyed, true);
    assert.equal(response.listenerCount('data'), 0, 'Headers-only probe consumes no response body');
  }
  let destroyed = false;
  const silent = (() => {
    const request = new EventEmitter() as ClientRequest;
    request.destroy = (() => { destroyed = true; return request; }) as typeof request.destroy;
    request.end = (() => request) as typeof request.end;
    return request;
  }) as typeof httpRequest;
  assert.equal(await probeWebServer(3000, silent), false); assert.equal(destroyed, true, '800 ms timeout closes the socket');
});

for (const listen of [false, true]) test(`HTTP forwarding, chunks, ownership, expiry, redirects, headers, size and timeout (${listen ? 'TCP' : 'in-memory HTTP'})`, { skip: listen && !process.env.AA_TEST_LISTEN }, async t => {
  const server = createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>dev server</html>'); return; }
    if (req.url === '/slow') return;
    if (req.url === '/gzip') { res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/html' }); res.end(gzipSync('<html>hello</html>')); return; }
    if (req.url === '/head') { res.writeHead(200, { 'content-length': '12345' }); res.end(); return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: `http://localhost:${port}/target`, 'set-cookie': ['a=b', 'c=d'] }); res.end(); return; }
    if (req.url === '/large') { res.end(Buffer.alloc(PREVIEW_CHUNK + 10, 97)); return; }
    if (req.url === '/oversize') { res.end(Buffer.alloc(50 * 1024 * 1024 + 1)); return; }
    const body: Buffer[] = []; req.on('data', b => body.push(b)); req.on('end', () => res.end(JSON.stringify({ method: req.method, headers: req.headers, body: Buffer.concat(body).toString(), path: req.url })));
  });
  if (listen) await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = listen ? (server.address() as { port: number }).port : 43210;
  const transport: typeof httpRequest = ((options: any, callback: any) => {
    assert.ok(['127.0.0.1', '::1'].includes(options.hostname));
    if (listen) return httpRequest(options, callback);
    let clientSide: Duplex, serverSide: Duplex;
    clientSide = new Duplex({ read() {}, write(chunk, _encoding, done) { serverSide.push(chunk); done(); }, final(done) { serverSide.push(null); done(); } });
    serverSide = new Duplex({ read() {}, write(chunk, _encoding, done) { clientSide.push(chunk); done(); }, final(done) { clientSide.push(null); done(); } });
    server.emit('connection', serverSide);
    const agent = new Agent();
    agent.createConnection = (() => clientSide) as typeof agent.createConnection;
    return httpRequest({ ...options, agent }, callback);
  }) as typeof httpRequest;
  t.after(() => { server.closeAllConnections(); server.close(); });
  let now = 0;
  const previews = new WebPreviews(() => 1, async () => row(port), 500, () => now, transport); t.after(() => previews.close()); const owner = {};
  const response = await previews.request({ port, method: 'POST', path: '/echo?q=1', headers: { host: 'evil', connection: 'x-remove', 'x-remove': 'bad', cookie: 'a=b', Origin: 'http://127.0.0.1:1234/token', Referer: 'http://127.0.0.1:1234/secret/path' }, body: Buffer.from('hello').toString('base64') }, owner);
  const echo = JSON.parse(Buffer.from(response.data, 'base64').toString());
  assert.equal(echo.method, 'POST'); assert.equal(echo.body, 'hello'); assert.equal(echo.path, '/echo?q=1'); assert.equal(echo.headers.host, `localhost:${port}`); assert.equal(echo.headers['x-remove'], undefined); assert.equal(echo.headers.cookie, 'a=b');
  assert.equal(echo.headers.origin, `http://localhost:${port}`); assert.equal(echo.headers.referer, `http://localhost:${port}`);
  const uploaded = previews.upload({ data: Buffer.alloc(PREVIEW_CHUNK, 97).toString('base64'), offset: 0 }, owner);
  assert.throws(() => previews.upload({ ...uploaded, data: 'YQ==' }, {}), /expired/);
  const finished = previews.upload({ ...uploaded, data: 'Yg==' }, owner);
  assert.equal(finished.offset, PREVIEW_CHUNK + 1);
  const uploadResponse = await previews.request({ port, method: 'POST', path: '/echo', bodyId: finished.bodyId }, owner);
  let uploadBody = Buffer.from(uploadResponse.data, 'base64');
  if (!uploadResponse.eof) uploadBody = Buffer.concat([uploadBody, Buffer.from(previews.chunk(uploadResponse.streamId!, owner).data, 'base64')]);
  assert.equal(JSON.parse(uploadBody.toString()).body, 'a'.repeat(PREVIEW_CHUNK) + 'b');
  await assert.rejects(previews.request({ port, method: 'POST', path: '/echo', bodyId: finished.bodyId }, owner), /expired/);
  const zipped = await previews.request({ port, method: 'GET', path: '/gzip' }, owner);
  assert.equal(Buffer.from(zipped.data, 'base64').toString(), '<html>hello</html>'); assert.equal(zipped.headers['content-encoding'], undefined);
  const head = await previews.request({ port, method: 'HEAD', path: '/head' }, owner);
  assert.equal(head.headers['content-length'], '12345'); assert.equal(head.data, '');
  const redirect = await previews.request({ port, method: 'GET', path: '/redirect' }, owner);
  assert.equal(redirect.status, 302); assert.equal(redirect.headers.location, `http://localhost:${port}/target`); assert.deepEqual(redirect.headers['set-cookie'], ['a=b', 'c=d']);
  const first = await previews.request({ port, method: 'GET', path: '/large' }, owner); assert.equal(first.eof, false); assert.equal(Buffer.from(first.data, 'base64').length, PREVIEW_CHUNK);
  // Even the encrypted relay's outer base64 envelope stays below 1 MiB.
  assert.ok(Buffer.byteLength(Buffer.from(JSON.stringify(first)).toString('base64')) < 1024 * 1024);
  assert.throws(() => previews.chunk(first.streamId!, {}), /expired/);
  const end = previews.chunk(first.streamId!, owner); assert.equal(end.eof, true); assert.equal(Buffer.from(end.data, 'base64').length, 10);
  const stale = await previews.request({ port, method: 'GET', path: '/large' }, owner); now = 60_001; assert.throws(() => previews.chunk(stale.streamId!, owner), /expired/);
  await assert.rejects(previews.request({ port, method: 'GET', path: '/slow' }, owner), /timed out/);
  for (const method of ['CONNECT', 'TRACE', 'TRACK', 'GET\r\nPOST', 'GET\n']) await assert.rejects(previews.request({ port, method, path: '/' }, owner), /method/);
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal((await previews.request({ port, method, path: '/' }, owner)).status, 200);
  await assert.rejects(previews.request({ port, method: 'GET', path: '//evil' }, owner), /path/);
  await assert.rejects(previews.request({ port, method: 'GET', path: '/oversize' }, owner), /50 MiB|interrupted/);
});
