import { LineBuffer, restartDelay } from './serverOutput';
import { CaptureDevice, isNoiseSegment, parseStreamLine, StreamSource } from './streamOutput';

export type StreamState = 'idle' | 'starting' | 'listening' | 'paused' | 'stopped' | 'error';

export interface StreamStatus {
  state: StreamState;
  devices: CaptureDevice[];
  captureId: number | null;
  message?: string;
}

interface DataSource {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

export interface StreamProcess {
  pid: number | undefined;
  stdout: DataSource;
  stderr: DataSource;
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
}

export interface StreamLaunchOptions {
  modelPath: string;
  language: string;
  captureId: number | null;
  forceCpu: boolean;
  cwd: string;
  threads: number;
}

export interface StreamEngineDeps {
  resolveBinary(): string | null;
  spawnStream(binary: string, args: string[], cwd: string): StreamProcess;
  writeLog(lines: string[]): void;
  now(): number;
}

export const STREAM_READY_TIMEOUT_MS = 60_000;
export const STREAM_WINDOW_MS = 10_000;
export const STREAM_VAD_THRESHOLD = '0.6';
export const LIVE_TEXT_SINK = 'live.txt';

export function buildStreamArgs(opts: StreamLaunchOptions): string[] {
  const args = [
    '-m', opts.modelPath,
    '--step', '0',
    '--length', String(STREAM_WINDOW_MS),
    '-vth', STREAM_VAD_THRESHOLD,
    '-t', String(opts.threads),
    '-l', opts.language,
  ];
  if (opts.captureId !== null) {
    args.push('-c', String(opts.captureId));
  }
  if (opts.forceCpu) {
    args.push('-ng');
  }
  args.push('-sa', '-f', LIVE_TEXT_SINK);
  return args;
}

export class StreamEngine {
  private status: StreamStatus = { state: 'idle', devices: [], captureId: null };
  private readonly statusListeners = new Set<(s: StreamStatus) => void>();
  private readonly segmentListeners = new Set<(s: { text: string; atMs: number }) => void>();
  private readonly launchListeners = new Set<(l: { atMs: number }) => void>();
  private readonly stdoutLines = new LineBuffer(500);
  private readonly stderrLines = new LineBuffer(500);
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private proc: StreamProcess | null = null;
  private generation = 0;
  private crashCount = 0;
  private opts: StreamLaunchOptions | null = null;
  private startedAt = 0;
  private paused = false;
  private fatal: string | null = null;

  constructor(private readonly deps: StreamEngineDeps) {}

  getStatus(): StreamStatus {
    return { ...this.status, devices: [...this.status.devices] };
  }

  onStatus(listener: (s: StreamStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  onSegment(listener: (s: { text: string; atMs: number }) => void): () => void {
    this.segmentListeners.add(listener);
    return () => {
      this.segmentListeners.delete(listener);
    };
  }

  onLaunch(listener: (l: { atMs: number }) => void): () => void {
    this.launchListeners.add(listener);
    return () => {
      this.launchListeners.delete(listener);
    };
  }

  async start(opts: StreamLaunchOptions): Promise<void> {
    this.halt();
    this.opts = opts;
    this.crashCount = 0;
    this.paused = false;
    this.fatal = null;
    this.startedAt = this.deps.now();
    this.setStatus({ state: 'starting', devices: [], captureId: opts.captureId });
    await this.launch();
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (this.status.state === 'listening' || this.status.state === 'paused') {
      this.setStatus({ ...this.status, state: paused ? 'paused' : 'listening' });
    }
  }

  stop(): void {
    this.halt();
    this.setStatus({ ...this.status, state: 'stopped', message: undefined });
  }

  private halt(): void {
    this.generation++;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  private schedule(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private setStatus(next: StreamStatus): void {
    this.status = next;
    this.deps.writeLog([...this.stderrLines.lines(), ...this.stdoutLines.lines()]);
    const snapshot = this.getStatus();
    for (const l of this.statusListeners) l(snapshot);
  }

  private fail(message: string): void {
    this.setStatus({ ...this.status, state: 'error', message });
  }

  private elapsed(): number {
    return this.deps.now() - this.startedAt;
  }

  private async launch(): Promise<void> {
    const opts = this.opts;
    if (!opts) return;
    const generation = ++this.generation;
    const binary = this.deps.resolveBinary();
    if (!binary) {
      this.fail('Live transcription is not installed (whisper-stream.exe is missing)');
      return;
    }

    const proc = this.deps.spawnStream(binary, buildStreamArgs(opts), opts.cwd);
    this.proc = proc;

    // Each stream gets its own buffer: whisper-stream writes transcript text to stdout and
    // every diagnostic to stderr, and interleaving them would corrupt partial lines.
    const handle = (source: StreamSource, buffer: LineBuffer) => (chunk: Buffer | string) => {
      for (const line of buffer.push(String(chunk))) {
        if (generation !== this.generation) return;
        this.handleLine(line, source);
      }
    };
    proc.stdout.on('data', handle('stdout', this.stdoutLines));
    proc.stderr.on('data', handle('stderr', this.stderrLines));
    proc.onExit((code) => this.handleExit(generation, code));

    const deadline = this.deps.now() + STREAM_READY_TIMEOUT_MS;
    this.pollReady(generation, deadline);
  }

  private pollReady(generation: number, deadline: number): void {
    this.schedule(() => {
      if (generation !== this.generation || this.status.state !== 'starting') return;
      if (this.deps.now() >= deadline) {
        this.halt();
        this.fail('Live transcription did not start within 60 seconds');
        return;
      }
      this.pollReady(generation, deadline);
    }, 500);
  }

  private handleLine(line: string, source: StreamSource): void {
    const event = parseStreamLine(line, source);
    if (!event) return;

    switch (event.kind) {
      case 'ready':
        if (this.status.state === 'starting') {
          this.setStatus({ ...this.status, state: this.paused ? 'paused' : 'listening', message: undefined });
          const atMs = this.elapsed();
          for (const l of this.launchListeners) l({ atMs });
        }
        return;
      case 'device': {
        const devices = this.status.devices.filter((d) => d.index !== event.device.index).concat(event.device);
        devices.sort((a, b) => a.index - b.index);
        this.setStatus({ ...this.status, devices });
        return;
      }
      case 'capture-failed':
        this.fatal = 'Could not open the microphone for live transcription';
        return;
      case 'model-load-failed':
        this.fatal = 'Live model failed to load — try re-downloading it';
        return;
      case 'segment': {
        if (this.status.state !== 'listening' || isNoiseSegment(event.text)) return;
        const segment = { text: event.text, atMs: this.elapsed() };
        for (const l of this.segmentListeners) l(segment);
        return;
      }
    }
  }

  private handleExit(generation: number, code: number | null): void {
    if (generation !== this.generation) return;
    this.proc = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();

    if (this.fatal) {
      this.fail(this.fatal);
      return;
    }

    this.crashCount++;
    const delay = restartDelay(this.crashCount);
    if (delay === null) {
      this.fail(`Live transcription crashed repeatedly (exit code ${code})`);
      return;
    }
    this.setStatus({ ...this.status, state: 'starting', message: `Live transcription restarting in ${delay / 1000}s` });
    this.schedule(() => {
      if (generation === this.generation) void this.launch();
    }, delay);
  }
}
