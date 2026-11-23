import { KeepAwake } from './keepAwake.ts';
import { loadIdentity } from './identity.ts';
import { RelayClient } from './relay.ts';
import { parseArgs } from 'node:util';
// @ts-expect-error qrcode-terminal ships no types
import qrcode from 'qrcode-terminal';
import { AccountClient } from './account.ts';
import { login } from './accountCli.ts';
import { redactLog, runIpc, startupFailure } from './ipc.ts';
import { ClaudeAdapter } from './adapters/claude.ts';
import { CodexAdapter } from './adapters/codex.ts';
import { WorkBuddyAdapter } from './adapters/workbuddy.ts';
import { AntigravityAdapter } from './adapters/antigravity.ts';
import { CursorAdapter } from './adapters/cursor.ts';
import { configureWorkBuddyKey } from './workbuddyKeyCli.ts';
import { loadWorkBuddyKey } from './workbuddyKey.ts';
import { loadConfig, pairingUrl, reachableAddresses } from './config.ts';
import { installLoginItem, uninstallLoginItem } from './loginItem.ts';
import { BRIDGE_VERSION, startServer } from './server.ts';
import { NetworkMonitor, networkDescription } from './network.ts';
import { BonjourPublisher } from './bonjour.ts';

const parseOptions = () => parseArgs({
  options: {
    port: { type: 'string' },
    'keep-awake': { type: 'string' },
    'disable-agent': { type: 'string' },
    'enable-agent': { type: 'string' },
    ipc: { type: 'boolean' },
    'rotate-token': { type: 'boolean' },
    'pair-only': { type: 'boolean' },
    login: { type: 'boolean' },
    logout: { type: 'boolean' },
    'workbuddy-key': { type: 'boolean' },
    clear: { type: 'boolean' },
    'install-login-item': { type: 'boolean' },
    'uninstall-login-item': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const { values } = await (async () => {
  try { return parseOptions(); } catch (error) {
    if (!process.argv.includes('--ipc')) throw error;
    await new Promise<void>(resolve => process.stdout.write(JSON.stringify({
      event: 'fatal', data: startupFailure(error),
    }) + '\n', () => resolve()));
    process.exit(1);
  }
})();

if (values.help && !values.ipc) {
  console.log(`agentanywhere-bridge ${BRIDGE_VERSION}

Lets the AgentTote iPhone app drive Claude Code, ChatGPT, WorkBuddy, Antigravity and Cursor on this Mac.

  --ipc               Control the bridge with stdin/stdout NDJSON
  --port <n>          Listen port (default 8787, remembered)
  --keep-awake <off|onPower|always>  Keep Mac awake (remembered; default onPower)
  --disable-agent <kind>  Turn off claude, codex, workbuddy, antigravity or cursor (remembered)
  --enable-agent <kind>   Turn an agent back on (remembered)
  --rotate-token      Issue a new pairing token; paired phones must re-scan
  --pair-only         Print the pairing QR code and exit
  --login             用手机号或邮箱验证码登录账号，并注册本机
  --logout            退出账号登录（二维码配对继续可用）
  --workbuddy-key     Paste and verify a CodeBuddy API key (hidden input)
  --workbuddy-key --clear  Disconnect WorkBuddy and delete its API key
  --install-login-item    Start the bridge automatically at login (launchd)
  --uninstall-login-item  Remove that login item`);
  process.exit(0);
}

if (values.ipc) {
  await runIpc([new ClaudeAdapter(), new CodexAdapter(), new WorkBuddyAdapter(), new AntigravityAdapter(), new CursorAdapter()], {
    disableAgent: values['disable-agent'], enableAgent: values['enable-agent'], keepAwake: values['keep-awake'], rotateToken: values['rotate-token'], port: values.port ? Number(values.port) : undefined,
  });
} else if (values.login || values.logout) {
  const config = await loadConfig();
  if (values.login) config.publicKey = (await loadIdentity()).publicKey;
  const account = new AccountClient({ config, bridgeVersion: BRIDGE_VERSION });
  await account.initialize();
  if (values.logout) {
    try {
      await account.logout();
      console.log('已退出账号登录');
    } catch {
      console.error('无法删除 account.json，请检查目录权限');
      process.exitCode = 1;
    }
  } else if (!await login(account)) process.exitCode = 1;
} else if (values['install-login-item']) {
  await installLoginItem();
} else if (values['uninstall-login-item']) {
  await uninstallLoginItem();
} else if (values['workbuddy-key']) {
  if (!await configureWorkBuddyKey(values.clear)) process.exitCode = 1;
} else {
  await main();
}

async function main() {
  await loadWorkBuddyKey();
  const cfg = await loadConfig({ disableAgent: values['disable-agent'], enableAgent: values['enable-agent'], keepAwake: values['keep-awake'], rotateToken: values['rotate-token'], port: values.port ? Number(values.port) : undefined });
  const identity = await loadIdentity();
  cfg.publicKey = identity.publicKey;
  const hosts = reachableAddresses();
  const url = pairingUrl(cfg, hosts);

  const printPairing = () => {
    console.log('\nScan with AgentTote on your iPhone (Add Mac → Scan QR):\n');
    qrcode.generate(url, { small: true });
    console.log(`Name:  ${cfg.name}`);
    for (const h of hosts) console.log(`Host:  ${h.address}:${cfg.port}  (${h.kind === 'tailscale' ? 'Tailscale — works from anywhere' : 'local network'})`);
    if (!hosts.some(h => h.kind === 'tailscale')) console.log('Tip:   install Tailscale on the Mac and iPhone to connect away from home.');
    console.log(`Token: ${cfg.token}`);
    console.log(`Link:  ${url}\n`);
  };

  if (values['pair-only']) {
    printPairing();
    return;
  }

  const log = (msg: string) => console.log(`[${new Date().toLocaleTimeString()}] ${redactLog(msg, [])}`);
  const account = new AccountClient({ config: cfg, bridgeVersion: BRIDGE_VERSION, log });
  await account.initialize();
  const adapters = [new ClaudeAdapter(), new CodexAdapter(), new WorkBuddyAdapter(), new AntigravityAdapter(), new CursorAdapter()];
  try {
    const server = await startServer(cfg, adapters, log, () => ({ userId: account.user?.id, publicKeyPem: account.publicKeyPem }), undefined, account);
    const relay = new RelayClient({ config: cfg, identity, account, attachClient: server.attachClient, log,
      onChange: state => log(`中转: ${state.state} · ${state.channels} phones`) });
    const awake = new KeepAwake({ log });
    awake.setMode(cfg.keepAwake);
    relay.start();
    const bonjour = new BonjourPublisher({ registration: { name: cfg.name, port: cfg.port, deviceId: cfg.deviceId, version: BRIDGE_VERSION }, log });
    bonjour.start();
    const network = new NetworkMonitor({ read: reachableAddresses, initialHosts: hosts, onChange: next => {
      log(`Network changed: ${networkDescription(next)}`);
      console.log(`Reachable: ${next.map(h => `${h.address}:${cfg.port}`).join(', ') || 'none'}`);
      if (account.user) void account.registerDevice(true);
      server.disconnectStale(next);
    } });
    network.start();
    server.on('close', () => { awake.stop(); relay.stop(); account.stop(); network.stop(); void bonjour.stop(); });
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      awake.stop();
      relay.stop();
      account.stop();
      network.stop();
      await Promise.all([bonjour.stop(), server.shutdown()]);
      process.exit(0);
    };
    process.once('SIGINT', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });
    process.once('exit', () => { awake.stop(); void bonjour.stop(); });
  } catch (err) {
    console.error(`Could not listen on port ${cfg.port}: ${(err as Error).message}`);
    process.exit(1);
  }
  console.log(`AgentTote bridge ${BRIDGE_VERSION} listening on port ${cfg.port}`);
  account.start();
  for (const info of await Promise.all(adapters.filter(a => !cfg.disabledAgents.includes(a.kind)).map(a => a.detect()))) {
    const mark = info.status === 'ready' ? '✓' : info.status === 'needsLogin' ? '!' : '✗';
    console.log(`  ${mark} ${info.name}${info.version ? ' ' + info.version : ''}${info.detail ? ' — ' + info.detail : ''}`);
  }
  console.log(account.user ? `账号：已登录为 ${account.user.phone ?? account.user.email ?? account.user.id}` : '账号：未登录，运行 npm run login');
  printPairing();
}
