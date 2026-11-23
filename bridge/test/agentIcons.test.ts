import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import { AgentIcons, type IconDependencies } from '../src/agentIcons.ts';
import { CodexAdapter } from '../src/adapters/codex.ts';

// Generated transparent PNG, with no vendor artwork or binary fixtures.
function fakePNG(): Buffer {
  function chunk(name: string, data: Buffer) {
    const payload = Buffer.concat([Buffer.from(name), data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const header = Buffer.alloc(4), trailer = Buffer.alloc(4);
    header.writeUInt32BE(data.length); trailer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, payload, trailer]);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(5))), chunk('IEND', Buffer.alloc(0))]);
}
function harness() {
  const files = new Map<string, Buffer>();
  const calls: { file: string; args: string[] }[] = [], removed: string[] = [];
  let mtimeMs = 1, missing = false, failSips = false, large = false;
  let spotlight = '/Users/me/ChatGPT.app\n/Applications/ChatGPT.app\n';
  const io: IconDependencies = {
    async run(file, args) {
      calls.push({ file, args });
      if (file.endsWith('/mdfind')) return spotlight;
      if (file.endsWith('/plutil')) return args.at(-1)!.includes('Claude') ? 'electron.icns' : 'icon.icns';
      if (file.endsWith('/sips')) {
        if (failSips) throw new Error('sips failed');
        files.set(args.at(-1)!, large && args[4] === '192' ? Buffer.alloc(70_000) : fakePNG()); return '';
      }
      throw new Error('Unexpected command');
    },
    async read(path) { const data = files.get(path); if (!data) throw new Error('missing'); return data; },
    async stat() { if (missing) throw new Error('missing'); return { mtimeMs }; },
    async mkdir() {}, async temporary() { return '/tmp/fake-icon'; },
    async write(path, data) { files.set(path, data); }, async remove(path) { removed.push(path); },
  };
  return { io, calls, removed, files, icons: new AgentIcons('/cache', io), changed() { mtimeMs++; },
    missing() { missing = true; }, fail() { failSips = true; }, noSpotlight() { spotlight = ''; }, large() { large = true; } };
}
test('finds app, prefers /Applications, selects only ChatGPT artwork and removes temporary files', async () => {
  const h = harness(), result = await h.icons.get('codex');
  assert.ok(result);
  const sips = h.calls.find(c => c.file.endsWith('/sips'))!;
  assert.deepEqual(sips.args.slice(0, 5), ['-s', 'format', 'png', '-Z', '192']);
  assert.equal(sips.args[5], '/Applications/ChatGPT.app/Contents/Resources/icon-chatgpt.icns');
  assert.match(h.calls[0].args[0], /com.openai.codex/);
  assert.deepEqual(h.removed, ['/tmp/fake-icon']);
  assert.equal(result.iconHash, createHash('sha256').update(fakePNG()).digest('hex').slice(0, 16));
  assert.match(result.iconPath!, /^\/cache\/codex-[a-f0-9]{12}\.png$/);
  assert.equal(new CodexAdapter().name, 'ChatGPT');
});
test('uses confirmed Claude, WorkBuddy and Cursor bundle IDs and CFBundleIconFile', async () => {
  for (const [agent, bundle, icon] of [['claude', 'com.anthropic.claudefordesktop', 'electron.icns'], ['workbuddy', 'com.tencent.workbuddy.mac', 'icon.icns'], ['cursor', 'com.todesktop.230313mzl4w4u92', 'icon.icns']] as const) {
    const h = harness(); h.noSpotlight(); assert.ok(await h.icons.get(agent));
    assert.ok(h.calls[0].args[0].includes(bundle));
    assert.ok(h.calls.some(c => c.file.endsWith('/plutil') && c.args[1] === 'CFBundleIconFile'));
    assert.ok(h.calls.some(c => c.file.endsWith('/sips') && c.args[5].endsWith(icon)));
  }
});
test('missing app, missing icns and failed sips fall back', async () => {
  for (const noSpotlight of [false, true]) {
    const h = harness(); h.missing(); if (noSpotlight) h.noSpotlight();
    assert.equal(await h.icons.get('codex'), undefined);
    assert.ok(!h.calls.some(c => c.file.endsWith('/sips')));
  }
  const h = harness(); h.fail(); assert.equal(await h.icons.get('codex'), undefined);
  assert.deepEqual(h.removed, ['/tmp/fake-icon']);
});
test('memory, concurrent and restart cache hits; mtime changes reconvert; content hash is stable', async () => {
  const h = harness();
  const [first, concurrent] = await Promise.all([h.icons.get('codex'), h.icons.get('codex')]);
  assert.deepEqual(first, concurrent); assert.deepEqual(await h.icons.get('codex'), first);
  assert.deepEqual(await new AgentIcons('/cache', h.io).get('codex'), first);
  assert.equal(h.calls.filter(c => c.file.endsWith('/sips')).length, 1);
  h.changed(); const updated = await h.icons.get('codex');
  assert.equal(h.calls.filter(c => c.file.endsWith('/sips')).length, 2);
  assert.equal(updated!.iconHash, first!.iconHash); assert.notEqual(updated!.iconPath, first!.iconPath);
});
test('oversized output retries at 128px and respects the 64KB limit', async () => {
  const h = harness(); h.large(); assert.ok((await h.icons.get('codex'))!.png.length < 64 * 1024);
  assert.deepEqual(h.calls.filter(c => c.file.endsWith('/sips')).map(c => c.args[4]), ['192', '128']);
});
test('read-only disk cache still supplies artwork to phones', async () => {
  const h = harness(); h.io.write = async () => { throw new Error('read only'); };
  const icon = await h.icons.get('codex'); assert.ok(icon?.iconHash); assert.equal(icon?.iconPath, undefined);
});

test('hello/list/icon RPC and IPC share hashes, keep paths local, update hashes and reject missing/disabled icons', async t => {
  const { Server } = await import('node:http');
  const { startServer } = await import('../src/server.ts');
  const { createIpcController } = await import('../src/ipc.ts');
  const { config } = await import('./accountHelpers.ts');
  t.mock.method(Server.prototype, 'listen', function (this: InstanceType<typeof Server>, ...args: any[]) {
    queueMicrotask(args.at(-1)); return this;
  });
  const cfg = { ...config, disabledAgents: [...config.disabledAgents] };
  const adapter: import('../src/types.ts').Adapter = {
    kind: 'codex', name: 'ChatGPT',
    async detect() { return { kind: this.kind, name: this.name, status: 'ready', runningProcesses: 0 }; },
    async listSessions() { return []; }, async getMessages() { return []; }, async startTask() { throw new Error('unused'); },
  };
  let icon: import('../src/agentIcons.ts').AgentIconData | undefined = {
    png: fakePNG(), iconHash: '0123456789abcdef', iconPath: '/cache/codex-fake.png',
  };
  const icons = { async get() { return icon; } };
  const server = await startServer(cfg, [adapter], () => {}, undefined, undefined, undefined, icons);
  t.after(() => server.shutdown().catch(() => {}));
  const received: any[] = [], events: any[] = [];
  const phone = server.attachClient({ kind: 'local', remote: 'test', send: text => received.push(JSON.parse(text)), close() {} });
  let id = 0;
  async function rpc(method: string, params = {}) {
    const requestId = ++id;
    await phone.receive(JSON.stringify({ id: requestId, method, params }));
    return received.find(r => r.id === requestId);
  }
  const hello = (await rpc('hello')).result;
  const list = (await rpc('agents.list')).result;
  assert.deepEqual(hello.agents, list);
  assert.equal(list[0].name, 'ChatGPT'); assert.equal(list[0].kind, 'codex');
  assert.equal(list[0].iconHash, icon.iconHash); assert.equal(list[0].iconPath, undefined);
  assert.deepEqual((await rpc('agents.icon', { agent: 'codex' })).result,
    { agent: 'codex', iconHash: icon.iconHash, png: fakePNG().toString('base64') });
  const account = { status: { authenticated: false } } as unknown as import('../src/account.ts').AccountClient;
  const controller = createIpcController({ cfg, account, adapters: [adapter], server, icons,
    emit: (event, data) => events.push({ event, data }), rememberToken() {}, persist: async () => {} });
  await controller.refresh();
  assert.equal(events[0].data[0].iconPath, icon.iconPath);
  assert.equal(controller.status().agents[0].iconHash, icon.iconHash);
  assert.equal(received.find(r => r.event === 'agents.updated').data[0].iconPath, undefined);
  icon = { ...icon, iconHash: 'fedcba9876543210' };
  await controller.refresh();
  assert.equal(events.at(-1).data[0].iconHash, icon.iconHash);
  assert.equal(received.filter(r => r.event === 'agents.updated').at(-1).data[0].iconHash, icon.iconHash);
  icon = undefined;
  await controller.refresh();
  assert.equal(events.at(-1).data[0].iconHash, undefined);
  assert.equal(events.at(-1).data[0].iconPath, undefined);
  assert.equal((await rpc('agents.icon', { agent: 'codex' })).error.message, 'No icon');
  await controller.execute('config.set', { disabledAgents: ['codex'] });
  assert.equal((await rpc('agents.icon', { agent: 'codex' })).error.message, 'ChatGPT is turned off on this Mac.');
  assert.match((await rpc('agents.icon', { agent: 'other' })).error.message, /Unknown agent/);
});
