import type { HostAddress } from './config.ts';

function addressSet(hosts: HostAddress[]): string {
  return JSON.stringify([...new Set(hosts.map(h => `${h.kind}:${h.address}`))].sort());
}

/** Poll interfaces without depending on the server, account client or real timers. */
export class NetworkMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private addresses: string;
  private readonly options: {
    read: () => HostAddress[];
    onChange: (hosts: HostAddress[]) => void;
    initialHosts?: HostAddress[];
    setInterval?: typeof setInterval;
    clearInterval?: typeof clearInterval;
  };

  constructor(options: NetworkMonitor['options']) {
    this.options = options;
    this.addresses = addressSet(options.initialHosts ?? options.read());
  }

  check(): void {
    const hosts = this.options.read();
    const addresses = addressSet(hosts);
    if (addresses === this.addresses) return;
    this.addresses = addresses;
    this.options.onChange(hosts);
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = (this.options.setInterval ?? setInterval)(() => this.check(), 3_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) (this.options.clearInterval ?? clearInterval)(this.timer);
    this.timer = undefined;
  }
}

export function networkDescription(hosts: HostAddress[]): string {
  return hosts.map(h => `${h.address} (${h.kind === 'lan' ? 'LAN' : 'Tailscale'})`).join(', ') || 'no reachable addresses';
}

/** Node can report IPv4 sockets with an IPv6-mapped prefix. Keep all loopback clients. */
export function staleLocalAddress(localAddress: string | undefined, hosts: HostAddress[]): boolean {
  if (!localAddress) return false;
  const address = localAddress.replace(/^::ffff:/i, '');
  if (address === '::1' || address.startsWith('127.')) return false;
  return !hosts.some(h => h.address === address);
}
