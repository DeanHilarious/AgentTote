import { spawn } from 'node:child_process';
import type { KeepAwakeMode } from './config.ts';

export const CAFFEINATE_PATH = '/usr/bin/caffeinate';
type Child = { once(event: string, listener: () => void): unknown; kill(signal: NodeJS.Signals): boolean };

/** Own exactly one assertion helper. -w also bounds its lifetime after a forced bridge exit. */
export class KeepAwake {
  private mode: KeepAwakeMode = 'off';
  private child?: Child;
  private retiring = false;
  private retry?: ReturnType<typeof setTimeout>;
  private killTimer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private running = false;
  private readonly options: {
    log: (message: string) => void;
    onChange?: (active: boolean) => void;
    spawn?: (command: string, args: string[], options: { stdio: 'ignore' }) => Child;
    platform?: string;
    pid?: number;
  };

  constructor(options: KeepAwake['options']) { this.options = options; }
  get active(): boolean { return this.running; }

  setMode(mode: KeepAwakeMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.attempt = 0;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    if (this.child) {
      if (!this.retiring) {
        this.retiring = true;
        this.setActive(false);
        const child = this.child;
        child.kill('SIGTERM');
        this.killTimer = setTimeout(() => { if (this.child === child) child.kill('SIGKILL'); }, 2_000);
        this.killTimer.unref();
      }
    } else this.launch();
  }

  stop(): void { this.setMode('off'); }

  private setActive(active: boolean): void {
    if (this.running === active) return;
    this.running = active;
    this.options.onChange?.(active);
  }

  private failed(): void {
    if (this.mode === 'off') return;
    // Even repeated ENOENT/spawn failures cannot form a tight loop.
    const delay = Math.min(300_000, 30_000 * 2 ** Math.min(this.attempt++, 4));
    this.options.log(`caffeinate exited unexpectedly; retrying in ${delay / 1_000}s`);
    this.retry = setTimeout(() => { this.retry = undefined; this.launch(); }, delay);
    this.retry.unref();
  }

  private launch(): void {
    if (this.mode === 'off' || this.child) return;
    if ((this.options.platform ?? process.platform) !== 'darwin') return;
    let child: Child;
    try {
      child = (this.options.spawn ?? spawn)(CAFFEINATE_PATH,
        [this.mode === 'onPower' ? '-s' : '-i', '-w', String(this.options.pid ?? process.pid)], { stdio: 'ignore' });
    } catch { this.failed(); return; }
    this.child = child;
    child.once('spawn', () => { if (this.child === child && !this.retiring) this.setActive(true); });
    const finished = () => {
      if (this.child !== child) return; // error + close must produce just one retry/log.
      this.child = undefined;
      if (this.killTimer) clearTimeout(this.killTimer);
      this.killTimer = undefined;
      this.setActive(false);
      const intentional = this.retiring;
      this.retiring = false;
      if (intentional) this.launch(); else this.failed();
    };
    child.once('error', finished);
    child.once('close', finished);
  }
}
