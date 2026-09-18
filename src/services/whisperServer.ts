import * as path from 'path';
import { classifyServerLine, LineBuffer, restartDelay, ServerLineEvent } from './serverOutput';
import type { Backend } from './serverPaths';

export type ServerState = 'no-model' | 'starting' | 'ready' | 'error' | 'stopped';

export interface ServerStatus {
  state: ServerState;
  modelId: string | null;
  backend: Backend | null;
  gpu: boolean;
  vad: boolean;
  port: number | null;
  message?: string;
}

interface DataSource {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

export interface ServerProcess {
  pid: number | undefined;
  stdout: DataSource;
  stderr: DataSource;
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
}

export interface WhisperServerDeps {
  resolveBinary(backend: Backend): string | null;
  spawnServer(binary: string, args: string[], cwd: string): ServerProcess;
  findFreePort(): Promise<number>;
  checkHealth(port: number): Promise<boolean>;
  killStaleProcess(): Promise<void>;
  writePid(pid: number): void;
  clearPid(): void;
  writeLog(lines: string[]): void;
  getGpuFallback(): boolean;
  setGpuFallback(value: boolean): void;
  now(): number;
}

export const READY_TIMEOUT_MS = 120_000;
export const HEALTH_POLL_MS = 500;
export const STABLE_RESET_MS = 300_000;
export const INFERENCE_PATH = '/v1/audio/transcriptions';

export class WhisperServer {
  private status: ServerStatus = { state: 'no-model', modelId: null, backend: null, gpu: false, vad: false, port: null };
  private readonly listeners = new Set<(s: ServerStatus) => void>();
  private readonly log = new LineBuffer(500);
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private proc: ServerProcess | null = null;
  // Incremented whenever a process is launched or abandoned; callbacks from older generations are ignored.
  private generation = 0;
  private events = new Set<ServerLineEvent>();
  private crashCount = 0;
  private modelId: string | null = null;
  private modelPath: string | null = null;
  private forceCpu = false;
  private vadModelPath: string | null = null;
  // Set when the server could not load the VAD model; cleared by start().
  private vadFailed = false;
  private launchedWithVad = false;

  constructor(private readonly deps: WhisperServerDeps) {}

  getStatus(): ServerStatus {
    return { ...this.status };
  }

  getBaseUrl(): string | null {
    return this.status.state === 'ready' && this.status.port !== null ? `http://127.0.0.1:${this.status.port}` : null;
  }

  onStatus(listener: (s: ServerStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(modelId: string, modelPath: string, opts: { forceCpu: boolean; vadModelPath?: string | null }): Promise<void> {
    this.halt();
    this.modelId = modelId;
    this.modelPath = modelPath;
    this.forceCpu = opts.forceCpu;
    this.vadModelPath = opts.vadModelPath ?? null;
    this.vadFailed = false;
    this.crashCount = 0;
    const generation = this.generation;
    try {
      await this.deps.killStaleProcess();
    } catch {
      // Stale-process cleanup is best-effort; continue launching regardless.
    }
    if (generation !== this.generation) return;
    const backend: Backend = opts.forceCpu || this.deps.getGpuFallback() ? 'cpu' : 'vulkan';
    await this.launch(backend, false);
  }

  async restart(): Promise<void> {
    if (this.modelId && this.modelPath) {
      await this.start(this.modelId, this.modelPath, {
        forceCpu: this.forceCpu,
        vadModelPath: this.vadFailed ? null : this.vadModelPath,
      });
    }
  }

  stop(): void {
    this.halt();
    this.setStatus({ state: 'stopped', modelId: this.modelId, backend: null, gpu: false, vad: false, port: null });
  }

  setNoModel(): void {
    this.halt();
    this.modelId = null;
    this.modelPath = null;
    this.setStatus({ state: 'no-model', modelId: null, backend: null, gpu: false, vad: false, port: null });
  }

  private halt(): void {
    this.generation++;
    this.clearTimers();
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
      this.deps.clearPid();
    }
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private schedule(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private setStatus(next: ServerStatus): void {
    this.status = next;
    this.deps.writeLog(this.log.lines());
    const snapshot = this.getStatus();
    for (const l of this.listeners) l(snapshot);
  }

  private fail(message: string): void {
    this.setStatus({ ...this.status, state: 'error', port: null, gpu: false, vad: false, message });
  }

  private async launch(backend: Backend, portRetried: boolean): Promise<void> {
    const generation = ++this.generation;
    const modelPath = this.modelPath;
    if (modelPath === null) return;
    const binary = this.deps.resolveBinary(backend);
    if (!binary) {
      if (backend === 'vulkan') return this.launch('cpu', portRetried);
      this.fail('Transcription server is not installed (whisper-server.exe is missing)');
      return;
    }
    let port: number;
    try {
      port = await this.deps.findFreePort();
    } catch {
      if (generation === this.generation) this.fail('Could not find a free local port for the transcription server');
      return;
    }
    if (generation !== this.generation) return;

    this.events = new Set();
    this.setStatus({ state: 'starting', modelId: this.modelId, backend, gpu: false, vad: false, port });
    this.launchedWithVad = this.vadModelPath !== null && !this.vadFailed;
    // Like the model, the VAD model is passed relative to the working directory (non-ASCII paths).
    const vadArgs = this.launchedWithVad
      ? ['--vad', '-vm', path.relative(path.dirname(modelPath), this.vadModelPath as string)]
      : [];
    const proc = this.deps.spawnServer(binary, [
      '-m', path.basename(modelPath), '--host', '127.0.0.1', '--port', String(port), '--inference-path', INFERENCE_PATH,
      ...vadArgs,
    ], path.dirname(modelPath));
    this.proc = proc;
    if (proc.pid !== undefined) this.deps.writePid(proc.pid);

    const onData = (chunk: Buffer | string) => {
      for (const line of this.log.push(String(chunk))) {
        const event = classifyServerLine(line);
        if (!event || generation !== this.generation) continue;
        if (event === 'vad-failed') {
          this.onVadFailed(generation, backend);
          continue;
        }
        this.events.add(event);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.onExit((code) => this.handleExit(generation, backend, portRetried, code));
    this.pollHealth(generation, this.deps.now() + READY_TIMEOUT_MS);
  }

  // b5130 loads the VAD model per request; if it cannot, every request fails. Carry on without it.
  private onVadFailed(generation: number, backend: Backend): void {
    if (!this.launchedWithVad || this.vadFailed || generation !== this.generation) return;
    this.vadFailed = true;
    console.error('whisper-server could not load the VAD model; restarting without VAD');
    this.halt();
    void this.launch(backend, false);
  }

  private pollHealth(generation: number, deadline: number): void {
    this.schedule(() => {
      void this.checkHealthOnce(generation, deadline);
    }, HEALTH_POLL_MS);
  }

  private async checkHealthOnce(generation: number, deadline: number): Promise<void> {
    const port = this.status.port;
    if (generation !== this.generation || port === null) return;
    let healthy: boolean;
    try {
      healthy = await this.deps.checkHealth(port);
    } catch {
      healthy = false;
    }
    if (generation !== this.generation) return;

    if (healthy) {
      const gpu = this.status.backend === 'vulkan' && this.events.has('gpu-backend');
      this.setStatus({ ...this.status, state: 'ready', gpu, vad: this.launchedWithVad, message: undefined });
      this.schedule(() => {
        if (generation === this.generation) this.crashCount = 0;
      }, STABLE_RESET_MS);
      return;
    }
    if (this.deps.now() >= deadline) {
      this.halt();
      this.fail('Transcription server did not become ready within 120 seconds');
      return;
    }
    this.pollHealth(generation, deadline);
  }

  private handleExit(generation: number, backend: Backend, portRetried: boolean, code: number | null): void {
    if (generation !== this.generation) return;
    this.proc = null;
    this.deps.clearPid();
    this.clearTimers();

    if (this.status.state !== 'ready') {
      if (this.events.has('model-load-failed')) {
        this.fail('Model failed to load — try re-downloading it, or enable Force CPU in Settings');
      } else if (this.events.has('bind-failed')) {
        if (portRetried) this.fail('Transcription server could not bind to a local port');
        else void this.launch(backend, true);
      } else if (backend === 'vulkan') {
        this.deps.setGpuFallback(true);
        void this.launch('cpu', portRetried);
      } else {
        this.fail(`Transcription server exited during startup (exit code ${code})`);
      }
      return;
    }

    this.crashCount++;
    const delay = restartDelay(this.crashCount);
    if (delay === null) {
      this.fail(`Transcription server crashed repeatedly (exit code ${code}) — try enabling Force CPU in Settings`);
      return;
    }
    this.setStatus({ ...this.status, state: 'starting', port: null, gpu: false, vad: false, message: `Server crashed, restarting in ${delay / 1000}s` });
    this.schedule(() => {
      if (generation === this.generation) void this.launch(backend, false);
    }, delay);
  }
}
