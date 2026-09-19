import type { UpdateStatusView } from '../shared/api';

// Checks for a new release shortly after start-up and then every 6 hours (the app lives in the
// tray for days). A found update downloads straight away; it installs when the user restarts from
// the header or tray, or on the next quit.
export const FIRST_CHECK_MS = 10_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// electron-updater, injected so the rules can be tested without Electron.
export interface UpdateDeps {
  // False in a development run: only the installed app has something to update.
  supported: boolean;
  currentVersion: string;
  // Starts a check; electron-updater reports the outcome through the on* events.
  check(): Promise<void>;
  // Quits, installs the downloaded update and starts the new version.
  install(): void;
  isAuto(): boolean;
  isRecording(): boolean;
}

export class UpdateService {
  private status: UpdateStatusView;
  private readonly listeners = new Set<(status: UpdateStatusView) => void>();
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(private readonly deps: UpdateDeps) {
    this.status = { state: deps.supported ? 'idle' : 'unsupported', currentVersion: deps.currentVersion };
  }

  getStatus(): UpdateStatusView {
    return this.status;
  }

  onChange(listener: (status: UpdateStatusView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (!this.deps.supported || this.timers.length > 0) return;
    const automatic = () => {
      if (this.deps.isAuto()) void this.checkNow();
    };
    this.timers.push(setTimeout(automatic, FIRST_CHECK_MS), setInterval(automatic, CHECK_INTERVAL_MS));
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  // Manual checks run even with automatic updates off; a found update still downloads.
  async checkNow(): Promise<UpdateStatusView> {
    if (!this.deps.supported || this.busy()) return this.status;
    this.set({ state: 'checking' });
    try {
      await this.deps.check();
    } catch (error) {
      this.onError(error instanceof Error ? error.message : String(error));
    }
    return this.status;
  }

  install(): void {
    if (this.status.state !== 'ready') throw new Error('No update is ready');
    if (this.deps.isRecording()) throw new Error('Stop recording before updating');
    this.deps.install();
  }

  onChecking(): void {
    if (!this.busy()) this.set({ state: 'checking' });
  }

  onAvailable(version: string): void {
    this.set({ state: 'downloading', version, percent: 0 });
  }

  onNotAvailable(): void {
    this.set({ state: 'up-to-date' });
  }

  onProgress(percent: number): void {
    if (this.status.state !== 'downloading') return;
    this.set({ state: 'downloading', version: this.status.version, percent: Math.floor(percent) });
  }

  onDownloaded(version: string): void {
    this.set({ state: 'ready', version });
  }

  // A failed check or download is shown in Settings only; the next check tries again.
  onError(message: string): void {
    if (this.status.state === 'ready') return;
    this.set({ state: 'error', message });
  }

  private busy(): boolean {
    return this.status.state === 'downloading' || this.status.state === 'ready';
  }

  private set(next: Omit<UpdateStatusView, 'currentVersion'>): void {
    this.status = { ...next, currentVersion: this.deps.currentVersion };
    for (const listener of this.listeners) listener(this.status);
  }
}
