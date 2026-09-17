import { RefineJob } from './sessionService';

// A live model plus a refine model resident at once; above this, refinement waits for the session to end.
export const CONCURRENT_MODEL_BUDGET_BYTES = 2_147_483_648;

export type RefineMode = 'auto' | 'always' | 'afterStop';

export function shouldRefineDuringRecording(mode: RefineMode, liveModelBytes: number, refineModelBytes: number): boolean {
  if (mode === 'always') return true;
  if (mode === 'afterStop') return false;
  return liveModelBytes + refineModelBytes <= CONCURRENT_MODEL_BUDGET_BYTES;
}

export type RefineEvent = {
  kind: 'started' | 'replaced' | 'skipped' | 'failed';
  blockIndex: number;
  message?: string;
};

export interface RefineDeps {
  sliceAudio(job: RefineJob): Promise<string | null>;
  transcribe(wavPath: string): Promise<string>;
  cleanup(wavPath: string): void;
  apply(blockIndex: number, text: string): 'replaced' | 'skipped-edited' | 'missing' | 'no-speech';
  report(event: RefineEvent): void;
}

const MAX_ATTEMPTS = 2;

export class RefineQueue {
  private readonly jobs: RefineJob[] = [];
  private allowed = true;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: RefineDeps) {}

  enqueue(job: RefineJob): void {
    this.jobs.push(job);
    this.kick();
  }

  setAllowed(allowed: boolean): void {
    this.allowed = allowed;
    this.kick();
  }

  pending(): number {
    return this.jobs.length;
  }

  isRunning(): boolean {
    return this.running !== null || this.jobs.length > 0;
  }

  async drain(): Promise<void> {
    while (this.running) {
      await this.running;
    }
  }

  private kick(): void {
    if (!this.allowed || this.running || this.jobs.length === 0) return;
    this.running = this.run().finally(() => {
      this.running = null;
      // A job may have been queued while this one ran.
      this.kick();
    });
  }

  private async run(): Promise<void> {
    while (this.allowed && this.jobs.length > 0) {
      const job = this.jobs.shift()!;
      this.deps.report({ kind: 'started', blockIndex: job.blockIndex });
      await this.runJob(job);
    }
  }

  private async runJob(job: RefineJob): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let wavPath: string | null = null;
      try {
        wavPath = await this.deps.sliceAudio(job);
        if (wavPath === null) {
          this.deps.report({ kind: 'skipped', blockIndex: job.blockIndex, message: 'no audio for this block' });
          return;
        }
        const text = await this.deps.transcribe(wavPath);
        const outcome = this.deps.apply(job.blockIndex, text);
        if (outcome === 'replaced') {
          this.deps.report({ kind: 'replaced', blockIndex: job.blockIndex });
        } else if (outcome === 'no-speech') {
          this.deps.report({ kind: 'skipped', blockIndex: job.blockIndex, message: 'no speech heard; live text kept' });
        } else if (outcome === 'skipped-edited') {
          this.deps.report({ kind: 'skipped', blockIndex: job.blockIndex, message: 'block edited since transcription' });
        } else {
          this.deps.report({ kind: 'skipped', blockIndex: job.blockIndex, message: 'block no longer in the document' });
        }
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === MAX_ATTEMPTS) {
          this.deps.report({ kind: 'failed', blockIndex: job.blockIndex, message });
        }
      } finally {
        if (wavPath !== null) this.deps.cleanup(wavPath);
      }
    }
  }
}
