import { EventEmitter } from 'events';
import * as path from 'path';
import { WhisperServer, ServerProcess } from '../services/whisperServer';
import type { Backend } from '../services/serverPaths';

class FakeProcess implements ServerProcess {
  pid = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  private exitListener: ((code: number | null) => void) | null = null;

  onExit(listener: (code: number | null) => void): void {
    this.exitListener = listener;
  }

  kill(): void {
    this.killed = true;
  }

  log(line: string): void {
    this.stderr.emit('data', Buffer.from(`${line}\n`));
  }

  exit(code: number | null): void {
    this.exitListener?.(code);
  }
}

function setup() {
  const procs: FakeProcess[] = [];
  let fallback = false;
  const deps = {
    resolveBinary: jest.fn((b: Backend): string | null => `/bin/${b}/whisper-server.exe`),
    spawnServer: jest.fn((_binary: string, _args: string[], _cwd: string) => {
      const p = new FakeProcess();
      procs.push(p);
      return p;
    }),
    findFreePort: jest.fn(async () => 5000 + procs.length),
    checkHealth: jest.fn(async (_port: number) => false),
    killStaleProcess: jest.fn(async () => undefined),
    writePid: jest.fn(),
    clearPid: jest.fn(),
    writeLog: jest.fn(),
    getGpuFallback: jest.fn(() => fallback),
    setGpuFallback: jest.fn((v: boolean) => {
      fallback = v;
    }),
    now: () => Date.now(),
  };
  const server = new WhisperServer(deps);
  return { server, deps, procs };
}

const MODEL = ['ggml-tiny.en.bin', '/models/ggml-tiny.en.bin'] as const;
const flush = () => jest.advanceTimersByTimeAsync(0);

describe('WhisperServer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function startReady(ctx: ReturnType<typeof setup>) {
    await ctx.server.start(...MODEL, { forceCpu: false });
    ctx.deps.checkHealth.mockResolvedValue(true);
    await jest.advanceTimersByTimeAsync(500);
  }

  it('starts with no-model state', () => {
    expect(setup().server.getStatus()).toEqual({ state: 'no-model', modelId: null, backend: null, gpu: false, vad: false, port: null });
  });

  it('spawns the vulkan build and becomes ready with a base url', async () => {
    const { server, deps, procs } = setup();
    const seen: string[] = [];
    server.onStatus((s) => seen.push(s.state));
    await server.start(...MODEL, { forceCpu: false });

    expect(deps.killStaleProcess).toHaveBeenCalledTimes(1);
    expect(deps.spawnServer).toHaveBeenCalledWith('/bin/vulkan/whisper-server.exe', [
      '-m', 'ggml-tiny.en.bin', '--host', '127.0.0.1', '--port', '5000', '--inference-path', '/v1/audio/transcriptions',
    ], path.dirname('/models/ggml-tiny.en.bin'));
    expect(deps.writePid).toHaveBeenCalledWith(4242);
    expect(server.getStatus()).toMatchObject({ state: 'starting', backend: 'vulkan', port: 5000, modelId: 'ggml-tiny.en.bin' });
    expect(server.getBaseUrl()).toBeNull();

    procs[0].log('whisper_backend_init_gpu: using Vulkan0 backend');
    deps.checkHealth.mockResolvedValue(true);
    await jest.advanceTimersByTimeAsync(500);

    expect(deps.checkHealth).toHaveBeenCalledWith(5000);
    expect(server.getStatus()).toMatchObject({ state: 'ready', gpu: true });
    expect(server.getBaseUrl()).toBe('http://127.0.0.1:5000');
    expect(seen).toEqual(['starting', 'ready']);
    expect(deps.writeLog).toHaveBeenCalled();
  });

  it('reports CPU when the vulkan build finds no GPU', async () => {
    const ctx = setup();
    await ctx.server.start(...MODEL, { forceCpu: false });
    ctx.procs[0].log('whisper_backend_init_gpu: no GPU found');
    ctx.deps.checkHealth.mockResolvedValue(true);
    await jest.advanceTimersByTimeAsync(500);
    expect(ctx.server.getStatus()).toMatchObject({ state: 'ready', backend: 'vulkan', gpu: false });
  });

  it('uses the CPU build when forced or after a remembered fallback', async () => {
    const forced = setup();
    await forced.server.start(...MODEL, { forceCpu: true });
    expect(forced.deps.spawnServer.mock.calls[0][0]).toBe('/bin/cpu/whisper-server.exe');

    const remembered = setup();
    remembered.deps.getGpuFallback.mockReturnValue(true);
    await remembered.server.start(...MODEL, { forceCpu: false });
    expect(remembered.deps.spawnServer.mock.calls[0][0]).toBe('/bin/cpu/whisper-server.exe');
  });

  it('uses CPU when the vulkan binary is missing and errors when no binary exists', async () => {
    const noVulkan = setup();
    noVulkan.deps.resolveBinary.mockImplementation((b: Backend) => (b === 'cpu' ? '/bin/cpu/whisper-server.exe' : null));
    await noVulkan.server.start(...MODEL, { forceCpu: false });
    expect(noVulkan.deps.spawnServer.mock.calls[0][0]).toBe('/bin/cpu/whisper-server.exe');

    const none = setup();
    none.deps.resolveBinary.mockReturnValue(null);
    await none.server.start(...MODEL, { forceCpu: false });
    expect(none.deps.spawnServer).not.toHaveBeenCalled();
    expect(none.server.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(/missing/) });
  });

  it('falls back to CPU and remembers it when vulkan exits during startup', async () => {
    const { server, deps, procs } = setup();
    await server.start(...MODEL, { forceCpu: false });
    procs[0].exit(3221225781);
    await flush();
    expect(deps.setGpuFallback).toHaveBeenCalledWith(true);
    expect(deps.clearPid).toHaveBeenCalled();
    expect(deps.spawnServer).toHaveBeenCalledTimes(2);
    expect(deps.spawnServer.mock.calls[1][0]).toBe('/bin/cpu/whisper-server.exe');
    expect(server.getStatus()).toMatchObject({ state: 'starting', backend: 'cpu' });
  });

  it('does not fall back when the model fails to load', async () => {
    const { server, deps, procs } = setup();
    await server.start(...MODEL, { forceCpu: false });
    procs[0].log('error: failed to initialize whisper context');
    procs[0].exit(3);
    await flush();
    expect(deps.spawnServer).toHaveBeenCalledTimes(1);
    expect(deps.setGpuFallback).not.toHaveBeenCalled();
    expect(server.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(/Model failed to load/) });
  });

  it('retries once on a port bind failure, then errors', async () => {
    const { server, deps, procs } = setup();
    await server.start(...MODEL, { forceCpu: false });
    procs[0].log("couldn't bind to server socket: hostname=127.0.0.1 port=5000");
    procs[0].exit(1);
    await flush();
    expect(deps.spawnServer).toHaveBeenCalledTimes(2);
    expect(deps.spawnServer.mock.calls[1][0]).toBe('/bin/vulkan/whisper-server.exe');
    expect(deps.spawnServer.mock.calls[1][1]).toContain('5001');

    procs[1].log("couldn't bind to server socket: hostname=127.0.0.1 port=5001");
    procs[1].exit(1);
    await flush();
    expect(deps.spawnServer).toHaveBeenCalledTimes(2);
    expect(server.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(/bind/) });
  });

  it('restarts after crashes with 1s, 5s, 15s backoff, then errors', async () => {
    const ctx = setup();
    await startReady(ctx);

    for (const delay of [1000, 5000, 15000]) {
      const count = ctx.procs.length;
      ctx.procs[count - 1].exit(1);
      await flush();
      expect(ctx.server.getStatus().state).toBe('starting');
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(ctx.procs).toHaveLength(count);
      await jest.advanceTimersByTimeAsync(1);
      expect(ctx.procs).toHaveLength(count + 1);
      await jest.advanceTimersByTimeAsync(500);
      expect(ctx.server.getStatus().state).toBe('ready');
    }

    ctx.procs[ctx.procs.length - 1].exit(1);
    await flush();
    expect(ctx.server.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(/crashed repeatedly/) });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(ctx.procs).toHaveLength(4);
  });

  it('resets the crash counter after 5 minutes of stable running', async () => {
    const ctx = setup();
    await startReady(ctx);
    ctx.procs[0].exit(1);
    await flush();
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(500);
    expect(ctx.server.getStatus().state).toBe('ready');

    await jest.advanceTimersByTimeAsync(300_000);
    ctx.procs[1].exit(1);
    await flush();
    await jest.advanceTimersByTimeAsync(999);
    expect(ctx.procs).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(ctx.procs).toHaveLength(3);
  });

  it('errors and kills the process when not ready within 120 seconds', async () => {
    const { server, procs } = setup();
    await server.start(...MODEL, { forceCpu: false });
    await jest.advanceTimersByTimeAsync(120_000);
    expect(server.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(/120 seconds/) });
    expect(procs[0].killed).toBe(true);
  });

  it('stop kills the process, clears the pid, and ignores the late exit', async () => {
    const ctx = setup();
    await startReady(ctx);
    ctx.server.stop();
    expect(ctx.procs[0].killed).toBe(true);
    expect(ctx.deps.clearPid).toHaveBeenCalled();
    expect(ctx.server.getStatus().state).toBe('stopped');
    expect(ctx.server.getBaseUrl()).toBeNull();

    ctx.procs[0].exit(0);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(ctx.deps.spawnServer).toHaveBeenCalledTimes(1);
    expect(ctx.server.getStatus().state).toBe('stopped');
  });

  it('setNoModel kills the process and reports no-model', async () => {
    const ctx = setup();
    await startReady(ctx);
    ctx.server.setNoModel();
    expect(ctx.procs[0].killed).toBe(true);
    expect(ctx.server.getStatus()).toEqual({ state: 'no-model', modelId: null, backend: null, gpu: false, vad: false, port: null });
  });

  it('restart relaunches the same model', async () => {
    const ctx = setup();
    await startReady(ctx);
    await ctx.server.restart();
    expect(ctx.procs[0].killed).toBe(true);
    expect(ctx.deps.spawnServer).toHaveBeenCalledTimes(2);
    expect(ctx.deps.spawnServer.mock.calls[1][1]).toContain('ggml-tiny.en.bin');
    expect(ctx.deps.spawnServer.mock.calls[1][2]).toBe(path.dirname('/models/ggml-tiny.en.bin'));
  });

  it('passes only the model file name and runs in the model directory', async () => {
    const { server, deps } = setup();
    const modelPath = path.join('/Users', 'José', 'models', 'ggml-base.en.bin');
    await server.start('ggml-base.en.bin', modelPath, { forceCpu: false });

    const [, args, cwd] = deps.spawnServer.mock.calls[0];
    expect(args[1]).toBe('ggml-base.en.bin');
    for (const arg of args) {
      expect(arg).not.toContain('José');
    }
    expect(cwd).toBe(path.join('/Users', 'José', 'models'));
  });

  it('errors instead of hanging when no free port can be found', async () => {
    const ctx = setup();
    ctx.deps.findFreePort.mockRejectedValue(new Error('EACCES'));
    await expect(ctx.server.start(...MODEL, { forceCpu: false })).resolves.toBeUndefined();
    expect(ctx.server.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(/free local port/) });
    expect(ctx.deps.spawnServer).not.toHaveBeenCalled();
  });

  it('still launches when stale process cleanup fails', async () => {
    const ctx = setup();
    ctx.deps.killStaleProcess.mockRejectedValue(new Error('tasklist failed'));
    await expect(ctx.server.start(...MODEL, { forceCpu: false })).resolves.toBeUndefined();
    expect(ctx.deps.spawnServer).toHaveBeenCalledTimes(1);
    expect(ctx.server.getStatus().state).toBe('starting');
  });

  it('adds VAD with a path relative to the model directory', async () => {
    const ctx = setup();
    await ctx.server.start('ggml-tiny.en.bin', path.join('/models', 'ggml-tiny.en.bin'), {
      forceCpu: false,
      vadModelPath: path.join('/models', 'ggml-silero-v6.2.0.bin'),
    });
    const args = ctx.deps.spawnServer.mock.calls[0][1];
    expect(args.slice(-3)).toEqual(['--vad', '-vm', 'ggml-silero-v6.2.0.bin']);
    ctx.deps.checkHealth.mockResolvedValue(true);
    await jest.advanceTimersByTimeAsync(500);
    expect(ctx.server.getStatus()).toMatchObject({ state: 'ready', vad: true });
  });

  it('reaches a VAD model above a custom model directory', async () => {
    const ctx = setup();
    await ctx.server.start('custom/owner__repo__m.bin', path.join('/models', 'custom', 'owner__repo__m.bin'), {
      forceCpu: false,
      vadModelPath: path.join('/models', 'ggml-silero-v6.2.0.bin'),
    });
    expect(ctx.deps.spawnServer.mock.calls[0][1].slice(-1)).toEqual([path.join('..', 'ggml-silero-v6.2.0.bin')]);
  });

  it('runs without VAD when no VAD model is given', async () => {
    const ctx = setup();
    await startReady(ctx);
    expect(ctx.deps.spawnServer.mock.calls[0][1]).not.toContain('--vad');
    expect(ctx.server.getStatus().vad).toBe(false);
  });

  it('relaunches without VAD when the server cannot load the VAD model, and keeps it off on restart', async () => {
    const ctx = setup();
    await ctx.server.start(...MODEL, { forceCpu: false, vadModelPath: '/models/ggml-silero-v6.2.0.bin' });
    ctx.deps.checkHealth.mockResolvedValue(true);
    await jest.advanceTimersByTimeAsync(500);
    ctx.procs[0].log('whisper_vad: failed to initialize VAD context');
    await flush();
    expect(ctx.procs[0].killed).toBe(true);
    expect(ctx.deps.spawnServer).toHaveBeenCalledTimes(2);
    expect(ctx.deps.spawnServer.mock.calls[1][1]).not.toContain('--vad');
    await jest.advanceTimersByTimeAsync(500);
    expect(ctx.server.getStatus()).toMatchObject({ state: 'ready', vad: false });

    ctx.procs[1].log('whisper_vad: failed to initialize VAD context');
    await flush();
    expect(ctx.deps.spawnServer).toHaveBeenCalledTimes(2);

    await ctx.server.restart();
    expect(ctx.deps.spawnServer.mock.calls[2][1]).not.toContain('--vad');
  });

  it('tries VAD again when started afresh', async () => {
    const ctx = setup();
    await ctx.server.start(...MODEL, { forceCpu: false, vadModelPath: '/models/ggml-silero-v6.2.0.bin' });
    ctx.procs[0].log('whisper_vad: failed to initialize VAD context');
    await flush();
    await ctx.server.start(...MODEL, { forceCpu: false, vadModelPath: '/models/ggml-silero-v6.2.0.bin' });
    const last = ctx.deps.spawnServer.mock.calls[ctx.deps.spawnServer.mock.calls.length - 1][1];
    expect(last).toContain('--vad');
  });
});
