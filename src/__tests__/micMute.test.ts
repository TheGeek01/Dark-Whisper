import { parseMuteOutput, buildShimArgs, MUTE_SHIM_SCRIPT, shimEnv, MIC_NAME_ENV } from '../services/micMuteOutput';
import { MicMuteService } from '../services/micMuteService';

describe('parseMuteOutput', () => {
  it('reads the shim contract', () => {
    expect(parseMuteOutput('muted:true\n')).toBe(true);
    expect(parseMuteOutput('muted:false')).toBe(false);
    expect(parseMuteOutput('  muted:TRUE  ')).toBe(true);
  });

  it('returns null for anything unexpected', () => {
    expect(parseMuteOutput('')).toBeNull();
    expect(parseMuteOutput('Exception calling GetMute')).toBeNull();
    expect(parseMuteOutput('muted:maybe')).toBeNull();
  });
});

describe('buildShimArgs', () => {
  it('passes the action to the inline PowerShell script', () => {
    const args = buildShimArgs('get');
    expect(args[0]).toBe('-NoProfile');
    expect(args).toContain('-Command');
    expect(args[args.length - 1]).toContain('get');
    expect(MUTE_SHIM_SCRIPT).toContain('IAudioEndpointVolume');
  });
});

describe('shimEnv', () => {
  // Pause mutes the session's own microphone, not whichever one Windows calls the default.
  it('names the session microphone in the environment, never in the command', () => {
    const name = "Microphone (Bob's \"USB\" Mic)";
    const env = shimEnv(name, { PATH: 'x' });
    expect(env[MIC_NAME_ENV]).toBe(name);
    expect(env.PATH).toBe('x');
    expect(buildShimArgs('mute').join(' ')).not.toContain('Bob');
  });

  it('leaves the name empty for the system default', () => {
    expect(shimEnv('', {})[MIC_NAME_ENV]).toBe('');
  });

  it('finds the named device among the active capture endpoints, falling back to the default', () => {
    expect(MUTE_SHIM_SCRIPT).toContain('EnumAudioEndpoints');
    expect(MUTE_SHIM_SCRIPT).toContain(`$env:${MIC_NAME_ENV}`);
    expect(MUTE_SHIM_SCRIPT).toContain('GetDefaultAudioEndpoint');
  });
});

describe('MicMuteService', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function setup(initial: boolean | null = false) {
    let current = initial;
    const deps = {
      readMute: jest.fn(async () => current),
      writeMute: jest.fn(async (muted: boolean) => {
        current = muted;
      }),
      pollMs: 1000,
    };
    const service = new MicMuteService(deps);
    const changes: boolean[] = [];
    service.onChange((muted) => changes.push(muted));
    return { service, deps, changes, set: (v: boolean | null) => (current = v) };
  }

  it('polls and reports the first reading', async () => {
    const ctx = setup(false);
    ctx.service.start();
    await jest.advanceTimersByTimeAsync(1000);
    expect(ctx.service.isMuted()).toBe(false);
    expect(ctx.changes).toEqual([false]);
  });

  it('reports only changes, not every poll', async () => {
    const ctx = setup(false);
    ctx.service.start();
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);
    ctx.set(true);
    await jest.advanceTimersByTimeAsync(1000);
    expect(ctx.changes).toEqual([false, true]);
  });

  it('setMuted writes through and reports immediately', async () => {
    const ctx = setup(false);
    await ctx.service.setMuted(true);
    expect(ctx.deps.writeMute).toHaveBeenCalledWith(true);
    expect(ctx.service.isMuted()).toBe(true);
    expect(ctx.changes).toEqual([true]);
  });

  it('treats an unreadable state as unknown and never reports it', async () => {
    const ctx = setup(null);
    ctx.service.start();
    await jest.advanceTimersByTimeAsync(3000);
    expect(ctx.service.isMuted()).toBeNull();
    expect(ctx.changes).toEqual([]);
  });

  it('stops polling on stop', async () => {
    const ctx = setup(false);
    ctx.service.start();
    await jest.advanceTimersByTimeAsync(1000);
    ctx.service.stop();
    ctx.set(true);
    await jest.advanceTimersByTimeAsync(5000);
    expect(ctx.changes).toEqual([false]);
    expect(ctx.deps.readMute).toHaveBeenCalledTimes(1);
  });

  it('does not double the poll loop when restarted mid-poll', async () => {
    const ctx = setup(false);
    let release: () => void = () => undefined;
    ctx.deps.readMute.mockImplementationOnce(
      () => new Promise<boolean | null>((resolve) => (release = () => resolve(false))),
    );
    ctx.service.start();
    await jest.advanceTimersByTimeAsync(1000);
    ctx.service.stop();
    ctx.service.start();
    release();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(1000);
    expect(ctx.deps.readMute).toHaveBeenCalledTimes(2);
  });

  it('reports the first reading again after a restart', async () => {
    const ctx = setup(true);
    ctx.service.start();
    await jest.advanceTimersByTimeAsync(1000);
    ctx.service.stop();
    expect(ctx.service.isMuted()).toBeNull();
    ctx.service.start();
    await jest.advanceTimersByTimeAsync(1000);
    expect(ctx.changes).toEqual([true, true]);
  });

  it('survives a rejecting shim', async () => {
    const ctx = setup(false);
    ctx.deps.readMute.mockRejectedValueOnce(new Error('powershell missing'));
    ctx.service.start();
    await jest.advanceTimersByTimeAsync(2000);
    expect(ctx.changes).toEqual([false]);
  });
});
