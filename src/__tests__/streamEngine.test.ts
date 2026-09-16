import { EventEmitter } from 'events';
import { StreamEngine, StreamProcess, buildStreamArgs } from '../services/streamEngine';

class FakeProcess implements StreamProcess {
  pid = 909;
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
  out(line: string): void {
    this.stdout.emit('data', Buffer.from(`${line}\n`));
  }
  err(line: string): void {
    this.stderr.emit('data', Buffer.from(`${line}\n`));
  }
  exit(code: number | null): void {
    this.exitListener?.(code);
  }
}

const OPTS = {
  modelPath: 'C:/models/ggml-base.en.bin',
  language: 'en',
  captureId: 1,
  forceCpu: false,
  cwd: 'C:/sessions/s1',
  threads: 4,
};

function setup() {
  const procs: FakeProcess[] = [];
  const deps = {
    resolveBinary: jest.fn((): string | null => 'C:/whisper/cpu/whisper-stream.exe'),
    spawnStream: jest.fn((_binary: string, _args: string[], _cwd: string) => {
      const p = new FakeProcess();
      procs.push(p);
      return p;
    }),
    writeLog: jest.fn(),
    now: () => Date.now(),
  };
  const engine = new StreamEngine(deps);
  const segments: { text: string; atMs: number }[] = [];
  const launches: { atMs: number }[] = [];
  engine.onSegment((s) => segments.push(s));
  engine.onLaunch((l) => launches.push(l));
  return { engine, deps, procs, segments, launches };
}

describe('buildStreamArgs', () => {
  it('uses VAD mode, the model, language, and device', () => {
    expect(buildStreamArgs(OPTS)).toEqual([
      '-m', 'C:/models/ggml-base.en.bin',
      '--step', '0',
      '--length', '10000',
      '-vth', '0.6',
      '-t', '4',
      '-l', 'en',
      '-c', '1',
      '-f', 'live.txt',
    ]);
  });

  it('omits the device flag for the default device and adds -ng when CPU is forced', () => {
    const args = buildStreamArgs({ ...OPTS, captureId: null, forceCpu: true });
    expect(args).not.toContain('-c');
    expect(args).toContain('-ng');
    expect(args).not.toContain('-sa');
  });
});

describe('StreamEngine', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('starts idle', () => {
    expect(setup().engine.getStatus()).toEqual({ state: 'idle', devices: [], captureId: null });
  });

  it('spawns and reaches listening on the ready marker', async () => {
    const { engine, deps, procs } = setup();
    await engine.start(OPTS);
    expect(deps.spawnStream).toHaveBeenCalledWith('C:/whisper/cpu/whisper-stream.exe', buildStreamArgs(OPTS), 'C:/sessions/s1');
    expect(engine.getStatus().state).toBe('starting');

    procs[0].out('[Start speaking]');
    expect(engine.getStatus()).toMatchObject({ state: 'listening', captureId: 1 });
  });

  it('reports the launch so the caller can track audio files', async () => {
    const ctx = setup();
    await ctx.engine.start(OPTS);
    ctx.procs[0].out('[Start speaking]');
    expect(ctx.launches).toEqual([{ atMs: 0 }]);
  });

  it('emits segments once listening, dropping noise annotations', async () => {
    const ctx = setup();
    await ctx.engine.start(OPTS);
    ctx.procs[0].out('[Start speaking]');
    await jest.advanceTimersByTimeAsync(1500);
    ctx.procs[0].out('[00:00:00.000 --> 00:00:02.000]  hello world');
    ctx.procs[0].out('[BLANK_AUDIO]');
    ctx.procs[0].out('second line');
    expect(ctx.segments).toEqual([
      { text: 'hello world', atMs: 1500 },
      { text: 'second line', atMs: 1500 },
    ]);
  });

  it('ignores segments that arrive before ready and while paused', async () => {
    const ctx = setup();
    await ctx.engine.start(OPTS);
    ctx.procs[0].out('too early');
    ctx.procs[0].out('[Start speaking]');
    ctx.engine.setPaused(true);
    expect(ctx.engine.getStatus().state).toBe('paused');
    ctx.procs[0].out('while paused');
    ctx.engine.setPaused(false);
    expect(ctx.engine.getStatus().state).toBe('listening');
    ctx.procs[0].out('after resume');
    expect(ctx.segments.map((s) => s.text)).toEqual(['after resume']);
  });

  it('collects the capture device list from stderr', async () => {
    const ctx = setup();
    await ctx.engine.start(OPTS);
    ctx.procs[0].err("init:    - Capture device #0: 'Microphone (Realtek Audio)'");
    ctx.procs[0].err("init:    - Capture device #1: 'Headset (Jabra)'");
    expect(ctx.engine.getStatus().devices).toEqual([
      { index: 0, name: 'Microphone (Realtek Audio)' },
      { index: 1, name: 'Headset (Jabra)' },
    ]);
  });

  it('errors without retry when the model fails to load', async () => {
    const ctx = setup();
    await ctx.engine.start(OPTS);
    ctx.procs[0].err('error: failed to initialize whisper context');
    ctx.procs[0].exit(3);
    await jest.advanceTimersByTimeAsync(0);
    expect(ctx.deps.spawnStream).toHaveBeenCalledTimes(1);
    expect(ctx.engine.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(/Live model failed to load/) });
  });

  it('errors without retry when the microphone cannot be opened', async () => {
    const ctx = setup();
    await ctx.engine.start(OPTS);
    ctx.procs[0].err("init: couldn't open an audio device for capture: No such device!");
    ctx.procs[0].exit(1);
    await jest.advanceTimersByTimeAsync(0);
    expect(ctx.deps.spawnStream).toHaveBeenCalledTimes(1);
    expect(ctx.engine.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(/microphone/i) });
  });

  it('errors when the engine never becomes ready', async () => {
    const ctx = setup();
    await ctx.engine.start(OPTS);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(ctx.engine.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(/60 seconds/) });
    expect(ctx.procs[0].killed).toBe(true);
  });

  it('restarts a crash with 1s/5s/15s backoff and reports each relaunch', async () => {
    const ctx = setup();
    await ctx.engine.start(OPTS);
    ctx.procs[0].out('[Start speaking]');

    for (const delay of [1000, 5000, 15000]) {
      const count = ctx.procs.length;
      ctx.procs[count - 1].exit(1);
      await jest.advanceTimersByTimeAsync(0);
      expect(ctx.engine.getStatus().state).toBe('starting');
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(ctx.procs).toHaveLength(count);
      await jest.advanceTimersByTimeAsync(1);
      expect(ctx.procs).toHaveLength(count + 1);
      ctx.procs[count].out('[Start speaking]');
      expect(ctx.engine.getStatus().state).toBe('listening');
    }

    ctx.procs[ctx.procs.length - 1].exit(1);
    await jest.advanceTimersByTimeAsync(0);
    expect(ctx.engine.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(/repeatedly/) });
    expect(ctx.launches).toHaveLength(4);
    expect(ctx.launches[1].atMs).toBeGreaterThan(0);
  });

  it('stop kills the process, reports stopped, and ignores the late exit', async () => {
    const ctx = setup();
    await ctx.engine.start(OPTS);
    ctx.procs[0].out('[Start speaking]');
    ctx.engine.stop();
    expect(ctx.procs[0].killed).toBe(true);
    expect(ctx.engine.getStatus().state).toBe('stopped');
    ctx.procs[0].exit(0);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(ctx.deps.spawnStream).toHaveBeenCalledTimes(1);
  });

  it('errors when the binary is missing', async () => {
    const ctx = setup();
    ctx.deps.resolveBinary.mockReturnValue(null);
    await ctx.engine.start(OPTS);
    expect(ctx.deps.spawnStream).not.toHaveBeenCalled();
    expect(ctx.engine.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(/stream\.exe/) });
  });
});
