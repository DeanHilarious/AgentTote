import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

export const DNS_SD_PATH = '/usr/bin/dns-sd';
export const BONJOUR_TYPE = '_agentanywhere._tcp';

type Registration = { name: string; port: number; deviceId: string; version: string };
type BonjourChild = Pick<ChildProcess, 'once' | 'kill'>;

/** Own the native registration process; never forward its output into IPC stdout. */
export class BonjourPublisher {
  private readonly options: {
    registration: Registration;
    log: (message: string) => void;
    spawn?: (command: string, args: string[], options: { stdio: 'ignore' }) => BonjourChild;
    platform?: string;
    exists?: (path: string) => boolean;
    disabled?: boolean;
    now?: () => number;
  };
  private child?: BonjourChild;
  private retry?: ReturnType<typeof setTimeout>;
  private killTimer?: ReturnType<typeof setTimeout>;
  private active = false;
  private retiring = false;
  private attempt = 0;
  private unavailableLogged = false;
  private stopped: (() => void)[] = [];

  constructor(options: BonjourPublisher['options']) { this.options = options; }

  start(): void {
    if (this.active || (this.options.disabled ?? process.env.AA_DISABLE_BONJOUR === '1')) return;
    if ((this.options.platform ?? process.platform) !== 'darwin' || !(this.options.exists ?? existsSync)(DNS_SD_PATH)) {
      this.unavailable();
      return;
    }
    this.active = true;
    if (!this.child) this.launch();
  }

  rename(name: string): void {
    if (name === this.options.registration.name) return;
    this.options.registration.name = name;
    this.attempt = 0;
    if (!this.active) return;
    this.clearRetry();
    if (this.child) this.retire(); else this.launch();
  }

  stop(): Promise<void> {
    this.active = false;
    this.clearRetry();
    if (!this.child) return Promise.resolve();
    const stopped = new Promise<void>(resolve => this.stopped.push(resolve));
    this.retire();
    return stopped;
  }

  private unavailable(): void {
    if (this.unavailableLogged) return;
    this.unavailableLogged = true;
    this.options.log('Bonjour unavailable; continuing without LAN discovery');
  }

  private clearRetry(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
  }

  private retire(): void {
    if (!this.child || this.retiring) return;
    this.retiring = true;
    const child = this.child;
    child.kill('SIGTERM');
    this.killTimer = setTimeout(() => { if (this.child === child) child.kill('SIGKILL'); }, 2_000);
    this.killTimer.unref();
  }

  private scheduleRetry(): void {
    if (!this.active || this.retry) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempt++, 5));
    this.options.log(`Bonjour registration stopped; retrying in ${delay / 1_000}s`);
    this.retry = setTimeout(() => { this.retry = undefined; if (this.active) this.launch(); }, delay);
    this.retry.unref();
  }

  private launch(): void {
    if (!this.active || this.child) return;
    const { name, port, deviceId, version } = this.options.registration;
    const started = (this.options.now ?? Date.now)();
    let child: BonjourChild;
    try {
      child = (this.options.spawn ?? spawn)(DNS_SD_PATH,
        ['-R', name, BONJOUR_TYPE, 'local', String(port), `device=${deviceId}`, `v=${version}`], { stdio: 'ignore' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.active = false; this.unavailable(); }
      else this.scheduleRetry();
      return;
    }
    this.child = child;
    const finished = () => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.killTimer) clearTimeout(this.killTimer);
      this.killTimer = undefined;
      const intentional = this.retiring;
      this.retiring = false;
      for (const resolve of this.stopped.splice(0)) resolve();
      if (!this.active) return;
      if (intentional) this.launch();
      else {
        if ((this.options.now ?? Date.now)() - started >= 60_000) this.attempt = 0;
        this.scheduleRetry();
      }
    };
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (this.child !== child) return;
      if (error.code === 'ENOENT') { this.active = false; this.unavailable(); }
      finished();
    });
    child.once('close', finished);
  }
}
