export type ServerLineEvent = 'model-load-failed' | 'bind-failed' | 'gpu-backend' | 'no-gpu';

// Strings from whisper.cpp b5130 (examples/server/server.cpp, src/whisper.cpp). Re-check when bumping whisper.version.
export function classifyServerLine(line: string): ServerLineEvent | null {
  if (line.includes('failed to initialize whisper context')) return 'model-load-failed';
  if (line.includes("couldn't bind to server socket")) return 'bind-failed';
  if (line.includes('whisper_backend_init_gpu: no GPU found')) return 'no-gpu';
  if (/whisper_backend_init_gpu: using \S+ backend/.test(line)) return 'gpu-backend';
  return null;
}

export const RESTART_DELAYS_MS: readonly number[] = [1000, 5000, 15000];

export function restartDelay(crashCount: number): number | null {
  return crashCount >= 1 && crashCount <= RESTART_DELAYS_MS.length ? RESTART_DELAYS_MS[crashCount - 1] : null;
}

export class LineBuffer {
  private partial = '';
  private readonly buffer: string[] = [];

  constructor(private readonly max = 500) {}

  push(chunk: string): string[] {
    const parts = (this.partial + chunk).split(/\r?\n/);
    this.partial = parts.pop() ?? '';
    const complete = parts.filter((l) => l.length > 0);
    for (const line of complete) {
      this.buffer.push(line);
      if (this.buffer.length > this.max) this.buffer.shift();
    }
    return complete;
  }

  lines(): string[] {
    const all = this.partial ? [...this.buffer, this.partial] : [...this.buffer];
    return all.slice(-this.max);
  }
}

export function parseTasklistImage(output: string): string | null {
  const line = output.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  const match = line ? /^"([^"]+)"/.exec(line) : null;
  return match ? match[1] : null;
}

export function isWhisperServerImage(name: string | null): boolean {
  return name?.toLowerCase() === 'whisper-server.exe';
}
