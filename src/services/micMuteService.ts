import { parseMuteOutput, buildShimArgs } from './micMuteOutput';

export interface MicMuteDeps {
  readMute(): Promise<boolean | null>;
  writeMute(muted: boolean): Promise<void>;
  pollMs: number;
}

export class MicMuteService {
  private muted: boolean | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(muted: boolean) => void>();

  constructor(private readonly deps: MicMuteDeps) {}

  isMuted(): boolean | null {
    return this.muted;
  }

  onChange(listener: (muted: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (this.timer) return;
    this.schedule();
  }

  // Forgets the last reading, so the first poll after the next start() always reports.
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.muted = null;
  }

  async setMuted(muted: boolean): Promise<void> {
    await this.deps.writeMute(muted);
    this.update(muted);
  }

  private schedule(): void {
    const timer = setTimeout(() => {
      void this.poll(timer);
    }, this.deps.pollMs);
    this.timer = timer;
  }

  private async poll(timer: ReturnType<typeof setTimeout>): Promise<void> {
    try {
      const value = await this.deps.readMute();
      if (value !== null) this.update(value);
    } catch (error) {
      console.error('Could not read the microphone mute state:', error);
    }
    // Only the loop that owns the current timer continues; a stop() or restart mid-poll ends this one.
    if (this.timer === timer) this.schedule();
  }

  private update(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    for (const l of this.listeners) l(muted);
  }
}

// Real dependencies live in the runtime layer; exported here so the wiring is obvious.
export { buildShimArgs, parseMuteOutput };
