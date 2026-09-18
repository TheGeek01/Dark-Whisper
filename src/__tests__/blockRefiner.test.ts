import {
  RefineQueue,
  RefineDeps,
  RefineEvent,
  shouldRefineDuringRecording,
  CONCURRENT_MODEL_BUDGET_BYTES,
} from '../services/blockRefiner';
import { RefineJob } from '../services/sessionService';

const JOB: RefineJob = { blockIndex: 1, startSec: 0, endSec: 120, hash: 'abc' };

function setup(overrides: Partial<RefineDeps> = {}) {
  const events: RefineEvent[] = [];
  const cleaned: string[] = [];
  const deps: RefineDeps = {
    sliceAudio: jest.fn(async () => 'C:/tmp/block-1.wav'),
    transcribe: jest.fn(async () => 'refined text'),
    cleanup: (wav) => cleaned.push(wav),
    apply: jest.fn(() => 'replaced' as const),
    report: (event) => events.push(event),
    ...overrides,
  };
  return { queue: new RefineQueue(deps), deps, events, cleaned };
}

describe('shouldRefineDuringRecording', () => {
  it('always refines in always mode and never in afterStop mode', () => {
    expect(shouldRefineDuringRecording('always', 3e9, 3e9)).toBe(true);
    expect(shouldRefineDuringRecording('afterStop', 1, 1)).toBe(false);
  });

  it('auto refines only when both models fit the budget', () => {
    expect(CONCURRENT_MODEL_BUDGET_BYTES).toBe(2_147_483_648);
    expect(shouldRefineDuringRecording('auto', 150_000_000, 574_041_195)).toBe(true);
    expect(shouldRefineDuringRecording('auto', 150_000_000, 2_100_000_000)).toBe(false);
  });
});

describe('RefineQueue', () => {
  it('runs a job and applies the text', async () => {
    const ctx = setup();
    ctx.queue.enqueue(JOB);
    await ctx.queue.drain();

    expect(ctx.deps.sliceAudio).toHaveBeenCalledWith(JOB);
    expect(ctx.deps.transcribe).toHaveBeenCalledWith('C:/tmp/block-1.wav');
    expect(ctx.deps.apply).toHaveBeenCalledWith(1, 'refined text');
    expect(ctx.events).toEqual([
      { kind: 'started', blockIndex: 1 },
      { kind: 'replaced', blockIndex: 1 },
    ]);
    expect(ctx.cleaned).toEqual(['C:/tmp/block-1.wav']);
  });

  it('holds jobs while refinement is not allowed, then runs them in order', async () => {
    const ctx = setup();
    ctx.queue.setAllowed(false);
    ctx.queue.enqueue({ ...JOB, blockIndex: 1 });
    ctx.queue.enqueue({ ...JOB, blockIndex: 2 });
    expect(ctx.queue.pending()).toBe(2);
    expect(ctx.deps.sliceAudio).not.toHaveBeenCalled();

    ctx.queue.setAllowed(true);
    await ctx.queue.drain();
    expect(ctx.events.filter((e) => e.kind === 'replaced').map((e) => e.blockIndex)).toEqual([1, 2]);
  });

  it('skips a block whose audio is gone', async () => {
    const ctx = setup({ sliceAudio: jest.fn(async () => null) });
    ctx.queue.enqueue(JOB);
    await ctx.queue.drain();

    expect(ctx.deps.transcribe).not.toHaveBeenCalled();
    expect(ctx.events).toContainEqual({ kind: 'skipped', blockIndex: 1, message: 'no audio for this block' });
  });

  it('reports a skipped apply when the user edited the block', async () => {
    const ctx = setup({ apply: jest.fn(() => 'skipped-edited' as const) });
    ctx.queue.enqueue(JOB);
    await ctx.queue.drain();
    expect(ctx.events).toContainEqual({ kind: 'skipped', blockIndex: 1, message: 'block edited since transcription' });
  });

  it('reports a skipped apply when refinement heard no speech', async () => {
    const ctx = setup({ apply: jest.fn(() => 'no-speech' as const) });
    ctx.queue.enqueue(JOB);
    await ctx.queue.drain();
    expect(ctx.events).toContainEqual({ kind: 'skipped', blockIndex: 1, message: 'no speech heard; live text kept' });
  });

  it('reports a paragraph removed for having no speech', async () => {
    const ctx = setup({ apply: jest.fn(() => 'removed' as const) });
    ctx.queue.enqueue(JOB);
    await ctx.queue.drain();
    expect(ctx.events).toContainEqual({ kind: 'removed', blockIndex: 1 });
  });

  it('retries once, then fails without stopping the queue', async () => {
    const transcribe = jest
      .fn<Promise<string>, [string]>()
      .mockRejectedValueOnce(new Error('server busy'))
      .mockResolvedValueOnce('second attempt worked');
    const ctx = setup({ transcribe });
    ctx.queue.enqueue(JOB);
    await ctx.queue.drain();
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(ctx.events).toContainEqual({ kind: 'replaced', blockIndex: 1 });

    const always = setup({ transcribe: jest.fn(async () => { throw new Error('still broken'); }) });
    always.queue.enqueue({ ...JOB, blockIndex: 4 });
    always.queue.enqueue({ ...JOB, blockIndex: 5 });
    await always.queue.drain();
    expect(always.events).toContainEqual({ kind: 'failed', blockIndex: 4, message: 'still broken' });
    expect(always.events.filter((e) => e.blockIndex === 5)).not.toHaveLength(0);
  });

  it('always cleans up the temporary slice, even on failure', async () => {
    const ctx = setup({ transcribe: jest.fn(async () => { throw new Error('boom'); }) });
    ctx.queue.enqueue(JOB);
    await ctx.queue.drain();
    expect(ctx.cleaned).toEqual(['C:/tmp/block-1.wav', 'C:/tmp/block-1.wav']);
  });

  it('reports pending and running state', async () => {
    const ctx = setup();
    expect(ctx.queue.isRunning()).toBe(false);
    ctx.queue.enqueue(JOB);
    expect(ctx.queue.isRunning()).toBe(true);
    await ctx.queue.drain();
    expect(ctx.queue.pending()).toBe(0);
    expect(ctx.queue.isRunning()).toBe(false);
  });
});
