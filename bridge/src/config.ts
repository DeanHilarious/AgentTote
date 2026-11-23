import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { HOME } from './util.ts';
import { AGENT_KINDS, type AgentKind } from './types.ts';

export function validateDisabledAgents(value: unknown): AgentKind[] {
  if (!Array.isArray(value) || value.some(kind => !AGENT_KINDS.includes(kind))) throw new Error('Expected disabledAgents to contain valid agent kinds');
  const disabled = AGENT_KINDS.filter(kind => value.includes(kind));
  if (disabled.length === AGENT_KINDS.length) throw new Error('Keep at least one agent turned on.');
  return disabled;
}

export const SCUTIL_PATH = '/usr/sbin/scutil';

export type KeepAwakeMode = 'off' | 'onPower' | 'always';
export function isKeepAwakeMode(value: unknown): value is KeepAwakeMode {
  return value === 'off' || value === 'onPower' || value === 'always';
}

export interface BridgeConfig {
  disabledAgents: AgentKind[];
  keepAwake: KeepAwakeMode;
  token: string;
  port: number;
  name: string;
  deviceId: string;
  serverUrl: string;
  publicKey?: string;
}

export function configDirectory(): string {
  return process.env.AGENTANYWHERE_HOME ?? join(HOME, '.agentanywhere');
}

function computerName(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(SCUTIL_PATH, ['--get', 'ComputerName'], { timeout: 2_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function defaultName(getComputerName: () => Promise<string>): Promise<string> {
  try {
    // DHCP can replace hostname(); ComputerName is the name the Mac's owner chose.
    const name = (await getComputerName()).trim();
    if (name) return name;
  } catch {
    // scutil is unavailable outside macOS or may fail in a restricted environment.
  }
  return hostname().replace(/\.local$/, '');
}

export async function loadConfig(opts: {
  rotateToken?: boolean; port?: number; keepAwake?: string; disableAgent?: string; enableAgent?: string; directory?: string; getComputerName?: () => Promise<string>;
} = {}): Promise<BridgeConfig> {
  if (opts.keepAwake !== undefined && !isKeepAwakeMode(opts.keepAwake)) throw new Error('Expected --keep-awake off, onPower or always');
  const dir = opts.directory ?? configDirectory();
  const file = join(dir, 'bridge.json');
  let cfg: Partial<BridgeConfig> = {};
  try {
    cfg = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // First run.
  }
  let disabledAgents = validateDisabledAgents(cfg.disabledAgents ?? []);
  for (const kind of [opts.disableAgent, opts.enableAgent]) {
    if (kind !== undefined && !AGENT_KINDS.includes(kind as AgentKind)) throw new Error(`Unknown agent "${kind}"`);
  }
  if (opts.enableAgent) disabledAgents = disabledAgents.filter(kind => kind !== opts.enableAgent);
  if (opts.disableAgent) disabledAgents = validateDisabledAgents([...disabledAgents, opts.disableAgent]);
  const next: BridgeConfig = {
    ...cfg,
    disabledAgents,
    keepAwake: (opts.keepAwake as KeepAwakeMode | undefined) ?? (isKeepAwakeMode(cfg.keepAwake) ? cfg.keepAwake : 'onPower'),
    token: !cfg.token || opts.rotateToken ? randomBytes(24).toString('base64url') : cfg.token,
    port: opts.port ?? cfg.port ?? 8787,
    name: cfg.name ?? await defaultName(opts.getComputerName ?? computerName),
    deviceId: cfg.deviceId ?? randomUUID(),
    serverUrl: process.env.AA_SERVER_URL ?? cfg.serverUrl ?? 'https://agent-anywhere.nuts-claw.tech',
  };
  if (JSON.stringify(next) !== JSON.stringify(cfg)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  }
  return next;
}

export interface AccountUser {
  hasPassword?: boolean;
  id: string;
  phone?: string;
  email?: string;
}

export interface AccountConfig {
  serverUrl: string;
  refreshToken: string;
  user: AccountUser;
}

export async function loadAccount(directory = configDirectory()): Promise<AccountConfig | undefined> {
  try {
    const value = JSON.parse(await readFile(join(directory, 'account.json'), 'utf8'));
    if (typeof value?.serverUrl !== 'string' || typeof value.refreshToken !== 'string' || !value.refreshToken ||
        typeof value.user?.id !== 'string' || !value.user.id) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export async function writePrivateFile(file: string, content: string, directory = configDirectory()): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${file}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, join(directory, file));
  } finally {
    await rm(temporary, { force: true });
  }
}

export function saveAccount(account: AccountConfig, directory = configDirectory()): Promise<void> {
  return writePrivateFile('account.json', JSON.stringify(account, null, 2) + '\n', directory);
}

export function deleteAccount(directory = configDirectory()): Promise<void> {
  return rm(join(directory, 'account.json'), { force: true });
}

export interface HostAddress {
  address: string;
  kind: 'lan' | 'tailscale';
}

/** IPv4 addresses the phone may reach us on: LAN first, then Tailscale (100.64.0.0/10). */
export function reachableAddresses(): HostAddress[] {
  const out: HostAddress[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [o1, o2] = a.address.split('.').map(Number);
      const tailscale = o1 === 100 && o2 >= 64 && o2 <= 127;
      if (a.address.startsWith('169.254.')) continue; // link-local
      out.push({ address: a.address, kind: tailscale ? 'tailscale' : 'lan' });
    }
  }
  // Test-only: edit the file while running to exercise network-change publication.
  let extra = process.env.AA_TEST_EXTRA_HOST;
  if (process.env.AA_TEST_EXTRA_HOST_FILE) {
    try { extra = readFileSync(process.env.AA_TEST_EXTRA_HOST_FILE, 'utf8').trim(); }
    catch { extra = undefined; }
  }
  if (extra && isIPv4(extra) && !out.some(h => h.address === extra)) {
    const [o1, o2] = extra.split('.').map(Number);
    out.push({ address: extra, kind: o1 === 100 && o2 >= 64 && o2 <= 127 ? 'tailscale' : 'lan' });
  }
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'lan' ? -1 : 1));
}

/** The URL encoded in the pairing QR code; the iOS app parses it in PairingLink.swift. */
export function pairingUrl(cfg: Pick<BridgeConfig, 'name' | 'port' | 'token' | 'deviceId' | 'publicKey'>, hosts: HostAddress[]): string {
  const q = new URLSearchParams({
    name: cfg.name,
    port: String(cfg.port),
    token: cfg.token,
    hosts: hosts.map(h => h.address).join(','),
    device: cfg.deviceId,
  });
  if (cfg.publicKey) q.set('pk', cfg.publicKey);
  return `agentanywhere://pair?${q}`;
}
