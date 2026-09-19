import { CHECK_INTERVAL_MS, FIRST_CHECK_MS, UpdateDeps, UpdateService } from '../services/updateService';

function setup(overrides: Partial<UpdateDeps> = {}) {
  let auto = true;
  let recording = false;
  const deps: UpdateDeps = {
    supported: true,
    currentVersion: '1.4.0',
    check: jest.fn(async () => undefined),
    install: jest.fn(),
    isAuto: () => auto,
    isRecording: () => recording,
    ...overrides,
  };
  const service = new UpdateService(deps);
  const seen: string[] = [];
  service.onChange((status) => seen.push(status.state));
  return {
    service,
    deps,
    seen,
    setAuto: (value: boolean) => (auto = value),
    setRecording: (value: boolean) => (recording = value),
  };
}

describe('UpdateService', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('checks shortly after start-up and then every 6 hours', async () => {
    const ctx = setup();
    ctx.service.start();
    expect(ctx.deps.check).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(ctx.deps.check).toHaveBeenCalledTimes(1);
    ctx.service.onNotAvailable();
    await jest.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(ctx.deps.check).toHaveBeenCalledTimes(2);
    ctx.service.stop();
    await jest.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(ctx.deps.check).toHaveBeenCalledTimes(2);
  });

  it('skips the automatic checks when automatic updates are off, but still checks on request', async () => {
    const ctx = setup();
    ctx.setAuto(false);
    ctx.service.start();
    await jest.advanceTimersByTimeAsync(FIRST_CHECK_MS + CHECK_INTERVAL_MS);
    expect(ctx.deps.check).not.toHaveBeenCalled();
    await ctx.service.checkNow();
    expect(ctx.deps.check).toHaveBeenCalledTimes(1);
  });

  it('follows a found update from download to ready', () => {
    const ctx = setup();
    ctx.service.onChecking();
    ctx.service.onAvailable('1.5.0');
    ctx.service.onProgress(42.4);
    expect(ctx.service.getStatus()).toEqual({ state: 'downloading', currentVersion: '1.4.0', version: '1.5.0', percent: 42 });
    ctx.service.onDownloaded('1.5.0');
    expect(ctx.service.getStatus()).toEqual({ state: 'ready', currentVersion: '1.4.0', version: '1.5.0' });
    expect(ctx.seen).toEqual(['checking', 'downloading', 'downloading', 'ready']);
  });

  it('does not check again while downloading or once an update is ready', async () => {
    const ctx = setup();
    ctx.service.onAvailable('1.5.0');
    await ctx.service.checkNow();
    ctx.service.onDownloaded('1.5.0');
    await ctx.service.checkNow();
    expect(ctx.deps.check).not.toHaveBeenCalled();
  });

  it('reports a failed check, and a later check can succeed', async () => {
    const ctx = setup({ check: jest.fn(async () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED'))) });
    const status = await ctx.service.checkNow();
    expect(status).toMatchObject({ state: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' });
    ctx.deps.check = jest.fn(async () => undefined);
    ctx.service.onNotAvailable();
    expect(ctx.service.getStatus().state).toBe('up-to-date');
  });

  it('installs only a ready update, and never during a recording', () => {
    const ctx = setup();
    expect(() => ctx.service.install()).toThrow('No update is ready');
    ctx.service.onDownloaded('1.5.0');
    ctx.setRecording(true);
    expect(() => ctx.service.install()).toThrow('Stop recording before updating');
    expect(ctx.deps.install).not.toHaveBeenCalled();
    ctx.setRecording(false);
    ctx.service.install();
    expect(ctx.deps.install).toHaveBeenCalledTimes(1);
  });

  it('does nothing outside the installed app', async () => {
    const ctx = setup({ supported: false });
    ctx.service.start();
    await jest.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(await ctx.service.checkNow()).toMatchObject({ state: 'unsupported' });
    expect(ctx.deps.check).not.toHaveBeenCalled();
  });
});
