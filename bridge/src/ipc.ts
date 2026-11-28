import { agentIcons, withAgentIcon, type IconProvider } from './agentIcons.ts';
import type { AgentFlowStore } from './agentFlow.ts';
import { KeepAwake } from './keepAwake.ts';
import { loadIdentity } from './identity.ts';
import { RelayClient } from './relay.ts';
import type { RelayStatus } from './relay.ts';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { AccountClient, AccountError, AccountNetworkError } from './account.ts';
import type { BridgeConfig, HostAddress } from './config.ts';
import { NetworkMonitor, networkDescription } from './network.ts';
import { BonjourPublisher } from './bonjour.ts';
import { validateDisabledAgents, isKeepAwakeMode, loadConfig, pairingUrl, reachableAddresses, writePrivateFile } from './config.ts';
import { BRIDGE_VERSION, startServer } from './server.ts';
import type { Adapter, AgentInfo } from './types.ts';
import { WorkBuddyAdapter } from './adapters/workbuddy.ts';
import { deleteWorkBuddyKey, loadWorkBuddyKey, normalizeWorkBuddyKey, saveWorkBuddyKey, verifyWorkBuddyKey } from './workbuddyKey.ts';
import { redactSecrets, rememberSecret } from './secrets.ts';

export class IpcError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export function ipcError(error: unknown) {
  if (error instanceof AccountNetworkError) return { code: 'network', message: "Can't reach the account server" };
  if (error instanceof AccountError) return { code: redactSecrets(error.code), message: redactSecrets(error.message),
    ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }) };
  if (error instanceof IpcError) return { code: error.code, message: error.message };
  return { code: 'internal_error', message: 'Bridge operation failed' };
}

/** Redact whole pairing URLs as well as current and retired token literals. */
export function redactLog(message: string, tokens: Iterable<string>): string {
  let safe = message.replace(/agentanywhere:\/\/pair[^\s"'<>]*/gi, '[pairing URL redacted]')
    .replace(/\btoken(?:=|%3d)[^\s&"'<>]+/gi, 'token=[redacted]');
  for (const token of tokens) {
    if (!token) continue;
    safe = safe.split(token).join('[redacted]').split(encodeURIComponent(token)).join('[redacted]');
  }
  return redactSecrets(safe);
}

export function startupFailure(error: unknown, tokens: Iterable<string> = []) {
  const reason = error instanceof Error ? error.message : 'Unknown startup error';
  return { code: 'startup_failed', message: `Bridge startup failed: ${redactLog(reason, tokens)}` };
}

export function parseCommand(line: string): { id: string | number; method: string; params: Record<string, unknown> } {
  let value: any;
  try { value = JSON.parse(line); } catch { throw new IpcError('invalid_params', 'Expected a JSON command'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !(typeof value.id === 'string' || typeof value.id === 'number' && Number.isFinite(value.id)) ||
      typeof value.method !== 'string' || !value.method ||
      (value.params !== undefined && (!value.params || typeof value.params !== 'object' || Array.isArray(value.params)))) {
    throw new IpcError('invalid_params', 'Expected id, method and optional object params');
  }
  return { id: value.id, method: value.method, params: value.params ?? {} };
}

function invalid(message: string): never { throw new IpcError('invalid_params', message); }
function text(p: Record<string, unknown>, key: string): string {
  const value = p[key];
  return typeof value === 'string' && value.trim() ? value.trim() : invalid(`Expected ${key}`);
}
export function createIpcController(options: {
  icons?: IconProvider;
  cfg: BridgeConfig; account: AccountClient; adapters: Adapter[];
  server: { clientCount(): number; disconnectPairing(): void; agentsUpdated?(agents: AgentInfo[]): void };
  emit: (event: string, data: unknown) => void;
  rememberToken: (token: string) => void;
  persist?: (cfg: BridgeConfig) => Promise<void>;
  hosts?: HostAddress[];
  relayStatus?: () => RelayStatus;
  keepAwake?: Pick<KeepAwake, 'active' | 'setMode'>;
  onNameChange?: (name: string) => void;
  workbuddy?: {
    verify: typeof verifyWorkBuddyKey;
    save: typeof saveWorkBuddyKey;
    clear: typeof deleteWorkBuddyKey;
  };
  agentFlow?: Pick<AgentFlowStore, 'snapshot' | 'getRun'>;
  callRpc?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}) {
  const { cfg, account, adapters, server, emit } = options;
  let hosts = options.hosts ?? reachableAddresses();
  // Keep the pending port separate from the running server's config.
  let persisted = { ...cfg };
  let agents: (AgentInfo & { enabled: boolean; iconPath?: string })[] = [];
  let refreshPromise: Promise<AgentInfo[]> | undefined;
  const persist = options.persist ?? (next => writePrivateFile('bridge.json', JSON.stringify(next, null, 2) + '\n'));
  const workbuddy = options.workbuddy ?? { verify: verifyWorkBuddyKey, save: saveWorkBuddyKey, clear: deleteWorkBuddyKey };
  const update = async (patch: Partial<BridgeConfig>) => {
    const next = { ...persisted, ...patch };
    await persist(next);
    persisted = next;
  };
  const refresh = (): Promise<AgentInfo[]> => {
    if (refreshPromise) return refreshPromise;
    refreshPromise = Promise.all(adapters.map(async a => {
      const enabled = !cfg.disabledAgents.includes(a.kind);
      const info = enabled ? await a.detect() : agents.find(info => info.kind === a.kind) ??
        { kind: a.kind, name: a.name, status: 'unavailable' as const, runningProcesses: 0, detail: 'Turned off on this Mac.' };
      return { ...await withAgentIcon(info, options.icons ?? agentIcons, true), enabled };
    })).then(next => {
      if (JSON.stringify(next) !== JSON.stringify(agents)) {
        agents = next;
        emit('agents', agents);
        server.agentsUpdated?.(agents.filter(a => a.enabled).map(({ enabled: _enabled, iconPath: _iconPath, ...info }) => info));
      }
      return agents;
    }).finally(() => { refreshPromise = undefined; });
    return refreshPromise;
  };
  const status = () => {
    return { disabledAgents: cfg.disabledAgents, keepAwake: cfg.keepAwake, keepAwakeActive: options.keepAwake?.active ?? false, version: BRIDGE_VERSION, name: cfg.name, port: cfg.port, deviceId: cfg.deviceId,
      pairingUrl: pairingUrl(cfg, hosts), hosts, clients: server.clientCount(), agents, account: account.status, relay: options.relayStatus?.() ?? { state: 'off', channels: 0 } };
  };
  const execute = async (method: string, p: Record<string, unknown>): Promise<unknown> => {
    switch (method) {
      case 'status': return status();
      case 'workbuddy.setKey': {
        const apiKey = normalizeWorkBuddyKey(p.apiKey);
        if (!apiKey) invalid('Expected an API key of 16–512 characters without whitespace');
        rememberSecret(apiKey);
        options.rememberToken(apiKey);
        const result = await workbuddy.verify(apiKey, 'internal');
        if (!result.ok) throw new IpcError(result.code, redactSecrets(result.reason));
        await workbuddy.save({ apiKey, environment: result.environment });
        await refreshWorkBuddy();
        return { ok: true };
      }
      case 'workbuddy.clearKey':
        await workbuddy.clear();
        await refreshWorkBuddy();
        return { ok: true };
      case 'pairing.rotate': {
        const token = randomBytes(24).toString('base64url');
        await update({ token });
        options.rememberToken(cfg.token);
        options.rememberToken(token);
        cfg.token = token;
        server.disconnectPairing();
        return { pairingUrl: pairingUrl(cfg, hosts) };
      }
      case 'account.sendCode': {
        if (p.purpose !== 'register' && p.purpose !== 'reset' && p.purpose !== 'bind') invalid('Expected register, reset or bind purpose');
        return account.sendCode(text(p, 'email'), p.purpose);
      }
      case 'account.login':
      case 'account.register':
      case 'account.resetPassword': {
        if (typeof p.password === 'string') rememberSecret(p.password);
        if (typeof p.code === 'string') rememberSecret(p.code);
        const email = text(p, 'email');
        if (typeof p.password !== 'string') invalid('Expected password');
        let code = '';
        if (method !== 'account.login') {
          code = text(p, 'code');
          if (!/^\d{6}$/.test(code)) invalid('Expected a six digit code');
        }
        const user = method === 'account.login' ? await account.login(email, p.password) :
          method === 'account.register' ? await account.register(email, code, p.password) :
          await account.resetPassword(email, code, p.password);
        await account.registerDevice();
        if (!account.user) throw new IpcError('unauthorized', 'Account session was revoked');
        account.start();
        return user;
      }
      case 'account.logout': await account.logout(); return null;
      case 'account.setServer': {
        if (account.user) throw new IpcError('signed_in', 'Sign out before changing account servers');
        const url = text(p, 'url');
        try {
          const parsed = new URL(url);
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) invalid('Expected an HTTP(S) server URL');
        } catch { invalid('Expected an HTTP(S) server URL'); }
        await update({ serverUrl: url.replace(/\/+$/, '') });
        cfg.serverUrl = persisted.serverUrl;
        account.publicKeyPem = undefined;
        account.notifyStatus();
        return null;
      }
      case 'config.set': {
        if (p.name === undefined && p.port === undefined && p.keepAwake === undefined && p.disabledAgents === undefined) invalid('Expected name, port, keepAwake or disabledAgents');
        const patch: Partial<BridgeConfig> = {};
        if (p.name !== undefined) patch.name = text(p, 'name');
        if (p.port !== undefined) {
          if (typeof p.port !== 'number' || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535) invalid('Expected port from 1 to 65535');
          patch.port = p.port;
        }
        if (p.keepAwake !== undefined) {
          if (!isKeepAwakeMode(p.keepAwake)) invalid('Expected keepAwake off, onPower or always');
          patch.keepAwake = p.keepAwake;
        }
        if (p.disabledAgents !== undefined) {
          try { patch.disabledAgents = validateDisabledAgents(p.disabledAgents); }
          catch (error) { invalid((error as Error).message); }
        }
        await update(patch);
        if (patch.disabledAgents !== undefined && JSON.stringify(cfg.disabledAgents) !== JSON.stringify(patch.disabledAgents)) {
          // A periodic detection may have started while persistence was awaiting disk.
          await refreshPromise;
          cfg.disabledAgents = patch.disabledAgents;
          await refresh();
        }
        if (patch.keepAwake !== undefined) {
          cfg.keepAwake = patch.keepAwake;
          options.keepAwake?.setMode(cfg.keepAwake);
        }
        if (patch.name !== undefined) { cfg.name = patch.name; options.onNameChange?.(cfg.name); }
        return { restartRequired: patch.port !== undefined };
      }
      case 'agents.refresh': return refresh();
      case 'agentFlow.snapshot': {
        let limit: number | undefined;
        if (p.limit !== undefined) {
          if (typeof p.limit !== 'number' || !Number.isInteger(p.limit) || p.limit < 1 || p.limit > 100) {
            invalid('Expected limit from 1 to 100');
          }
          limit = p.limit;
        }
        if (options.agentFlow) return options.agentFlow.snapshot(limit);
        if (options.callRpc) {
          try { return await options.callRpc('agentFlow.snapshot', p); }
          catch (err) {
            if (err instanceof IpcError) throw err;
            throw new IpcError('rpc_error', redactSecrets((err as Error).message));
          }
        }
        throw new IpcError('unavailable', 'Bridge RPC is unavailable');
      }
      case 'agentFlow.run': {
        const id = text(p, 'id');
        try {
          if (options.agentFlow) return await options.agentFlow.getRun(id);
          if (options.callRpc) return await options.callRpc('agentFlow.run', { ...p, id });
          throw new IpcError('unavailable', 'Bridge RPC is unavailable');
        } catch (err) {
          if (err instanceof IpcError) throw err;
          const message = redactSecrets((err as Error).message);
          if (message.startsWith('Unknown Agent-Flow run:')) throw new IpcError('not_found', message);
          if (message.startsWith('Invalid Agent-Flow run')) throw new IpcError('invalid_params', message);
          throw new IpcError('rpc_error', message);
        }
      }
      case 'agents.models':
      case 'sessions.list':
      case 'sessions.messages':
      case 'projects.recent':
      case 'tasks.start':
      case 'tasks.cancel':
      case 'tasks.list':
      case 'tasks.get': {
        if (!options.callRpc) throw new IpcError('unavailable', 'Bridge RPC is unavailable');
        try { return await options.callRpc(method, p); }
        catch (err) {
          if (err instanceof IpcError) throw err;
          throw new IpcError('rpc_error', redactSecrets((err as Error).message));
        }
      }
      case 'shutdown': return null;
      default: throw new IpcError('unknown_method', 'Unknown IPC method');
    }
  };
  const updateNetwork = (next: HostAddress[]) => {
    hosts = next;
    emit('network', { hosts, pairingUrl: pairingUrl(cfg, hosts) });
  };
  const refreshWorkBuddy = async () => {
    // Wait out an earlier detection, which may still be reading the old credential.
    await refreshPromise;
    for (const adapter of adapters) if (adapter instanceof WorkBuddyAdapter) adapter.credentialsChanged();
    const previous = agents;
    await refresh();
    if (agents === previous) emit('agents', agents);
  };
  return { status, refresh, execute, updateNetwork };
}

export async function runIpc(adapters: Adapter[], configOptions: Parameters<typeof loadConfig>[0] = {}) {
  const tokens = new Set<string>();
  const emit = (event: string, data: unknown) => process.stdout.write(JSON.stringify({ event, data }) + '\n');
  const log = (message: string) => emit('log', { time: new Date().toISOString(), message: redactLog(message, tokens) });
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let account: AccountClient | undefined;
  let relay: RelayClient | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let network: NetworkMonitor | undefined;
  let bonjour: BonjourPublisher | undefined;
  let awake: KeepAwake | undefined;
  let unsubBroadcast: (() => void) | undefined;
  let closing = false;
  const input = createInterface({ input: process.stdin, terminal: false });
  // Subscribe synchronously: Process may send commands or EOF while startup is awaiting disk/network.
  const finish = async (code = 0) => {
    if (closing) return;
    closing = true;
    unsubBroadcast?.();
    awake?.stop();
    if (timer) clearInterval(timer);
    relay?.stop();
    account?.stop();
    network?.stop();
    void bonjour?.stop();
    input.close();
    const deadline = setTimeout(() => process.exit(code), 5_000);
    await boot.catch(() => undefined);
    unsubBroadcast?.();
    awake?.stop();
    relay?.stop();
    account?.stop();
    network?.stop();
    if (timer) clearInterval(timer);
    await server?.shutdown().catch(() => undefined);
    await bonjour?.stop();
    process.stdout.write('', () => { clearTimeout(deadline); process.exit(code); });
  };
  const boot = (async () => {
    await loadWorkBuddyKey(); // Register the stored key for redaction before any logging.
    const cfg = await loadConfig(configOptions);
    const identity = await loadIdentity();
    cfg.publicKey = identity.publicKey;
    tokens.add(cfg.token);
    account = new AccountClient({ config: cfg, bridgeVersion: BRIDGE_VERSION, log,
      onChange: state => emit('account', state) });
    await account.initialize();
    if (closing) return undefined;
    server = await startServer(cfg, adapters, log,
      () => ({ userId: account!.user?.id, publicKeyPem: account!.publicKeyPem }),
      count => emit('clients', { count }), account);
    unsubBroadcast = server.onBroadcast(msg => {
      if (msg.event === 'task.updated' || msg.event === 'task.event' || msg.event === 'task.delta') {
        emit(msg.event, msg.data);
      }
    });
    relay = new RelayClient({ config: cfg, identity, account, attachClient: server.attachClient, log,
      onChange: state => emit('relay', state) });
    bonjour = new BonjourPublisher({ registration: { name: cfg.name, port: cfg.port, deviceId: cfg.deviceId, version: BRIDGE_VERSION }, log });
    awake = new KeepAwake({ log, onChange: active => emit('keepAwake', { keepAwake: cfg.keepAwake, active }) });
    const controller = createIpcController({ cfg, account, adapters, server, emit, rememberToken: token => tokens.add(token),
      keepAwake: awake,
      relayStatus: () => relay!.status,
      onNameChange: name => bonjour!.rename(name),
      agentFlow: server.agentFlow,
      callRpc: server.callLocal });
    if (closing) return controller;
    await controller.refresh();
    if (closing) return controller;
    awake.setMode(cfg.keepAwake);
    emit('ready', controller.status());
    bonjour.start();
    relay.start();
    account.start();
    network = new NetworkMonitor({ read: reachableAddresses, initialHosts: controller.status().hosts,
      onChange: hosts => {
        log(`Network changed: ${networkDescription(hosts)}`);
        controller.updateNetwork(hosts);
        if (account!.user) void account!.registerDevice(true);
        server!.disconnectStale(hosts);
      } });
    network.start();
    timer = setInterval(() => { void controller.refresh().catch(() => log('Agent detection failed')); }, 60_000);
    return controller;
  })();
  let queue = Promise.resolve();
  input.on('line', line => {
    queue = queue.then(async () => {
      if (closing) return;
      let id: string | number | null = null;
      try {
        // Preserve a valid request id even when the envelope has invalid params.
        try { const value = JSON.parse(line); if (typeof value?.id === 'string' || typeof value?.id === 'number') id = value.id; } catch {}
        const command = parseCommand(line);
        const controller = await boot;
        if (closing || !controller) return;
        const result = await controller.execute(command.method, command.params);
        process.stdout.write(JSON.stringify({ id: command.id, result }) + '\n');
        if (command.method === 'shutdown') await finish();
      } catch (error) {
        if (!closing) process.stdout.write(JSON.stringify({ id, error: ipcError(error) }) + '\n');
      }
    });
  });
  input.once('close', () => { void finish(); });
  process.once('SIGTERM', () => { void finish(); });
  process.once('SIGINT', () => { void finish(); });
  process.once('exit', () => { awake?.stop(); void bonjour?.stop(); });
  try { await boot; } catch (error) {
    const portInUse = (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
    emit('fatal', portInUse ? { code: 'port_in_use', message: 'Bridge port is already in use' } : startupFailure(error, tokens));
    await finish(portInUse ? 2 : 1);
  }
}
