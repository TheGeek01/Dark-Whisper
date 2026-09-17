import { BlockRef, hashText } from '../services/documentStore';
import { RefineJob, SessionBlockEvent, SessionService, SessionStoreLike } from '../services/sessionService';

type SplitFn = (afterSec: number, beforeSec: number, gapSec: number) => number | null;
type SpeechFn = (fromSec: number, toSec: number) => boolean | null;

const DATE_CLOCK = '**2026-09-16 14:32**';

function fakeStore() {
  const blocks = new Map<number, string>();
  const opened: { block: BlockRef; heading?: string }[] = [];
  const ranges: BlockRef[] = [];
  let duration = -1;
  let last = 0;
  const store: SessionStoreLike = {
    openBlock: (_file, block, heading) => {
      blocks.set(block.index, '');
      opened.push({ block, heading });
      last = block.index;
    },
    setBlockRange: (_file, block) => {
      ranges.push(block);
    },
    appendSegment: (_file, text) => {
      const current = blocks.get(last) ?? '';
      blocks.set(last, current ? `${current} ${text}` : text);
    },
    readBlockText: (_file, index) => blocks.get(index) ?? null,
    replaceBlock: (_file, index, text, expectedHash) => {
      const current = blocks.get(index);
      if (current === undefined) return 'missing';
      if (hashText(current) !== expectedHash) return 'skipped-edited';
      blocks.set(index, text);
      return 'replaced';
    },
    updateFrontmatter: (_file, patch) => {
      duration = patch.duration;
    },
  };
  return { store, blocks, opened, ranges, getDuration: () => duration };
}

function setup(
  options: { blockMinutes?: number; split?: SplitFn; speech?: SpeechFn; firstBlockIndex?: number; baseDurationSec?: number } = {},
) {
  const fake = fakeStore();
  const jobs: RefineJob[] = [];
  const events: SessionBlockEvent[] = [];
  const calls: [number, number, number][] = [];
  const clock = { now: new Date(2026, 8, 16, 14, 32) };
  const split = options.split ?? (() => null);
  const speechCalls: [number, number][] = [];
  const speech = options.speech ?? (() => null);
  const service = new SessionService({
    store: fake.store,
    enqueueRefine: (job) => jobs.push(job),
    blockMinutes: options.blockMinutes ?? 2,
    silenceGapSec: 5,
    silence: {
      splitPoint: (afterSec, beforeSec, gapSec) => {
        calls.push([afterSec, beforeSec, gapSec]);
        return split(afterSec, beforeSec, gapSec);
      },
      hasSpeech: (fromSec, toSec) => {
        speechCalls.push([fromSec, toSec]);
        return speech(fromSec, toSec);
      },
    },
    now: () => clock.now,
  });
  service.onBlock((event) => events.push(event));
  service.begin({
    id: 's1',
    documentPath: 'C:/vault/s1.md',
    firstBlockIndex: options.firstBlockIndex,
    baseDurationSec: options.baseDurationSec,
  });
  return { service, jobs, events, calls, speechCalls, clock, ...fake };
}

describe('SessionService', () => {
  it('starts recording without writing anything until words arrive', () => {
    const ctx = setup();
    expect(ctx.service.getInfo()).toEqual({
      id: 's1',
      documentPath: 'C:/vault/s1.md',
      state: 'recording',
      blockIndex: 0,
      durationSec: 0,
    });
    expect(ctx.opened).toEqual([]);
    expect(ctx.events).toEqual([]);
  });

  it('opens the first paragraph with the date and time when the first words arrive', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'hello', atMs: 1_000 });
    ctx.service.segment({ text: 'world', atMs: 4_500 });
    expect(ctx.opened).toEqual([{ block: { index: 1, startSec: 0, endSec: 0 }, heading: DATE_CLOCK }]);
    expect(ctx.blocks.get(1)).toBe('hello world');
    expect(ctx.service.getInfo()).toMatchObject({ blockIndex: 1, durationSec: 4.5 });
    expect(ctx.events).toEqual([{ blockIndex: 1, startSec: 0, endSec: 0, state: 'live', clock: DATE_CLOCK }]);
  });

  it('asks about the pause between the last two segments of the open paragraph', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'one', atMs: 4_000 });
    ctx.service.segment({ text: 'two', atMs: 6_000 });
    ctx.service.segment({ text: 'three', atMs: 9_000 });
    expect(ctx.calls).toEqual([
      [4, 6, 5],
      [6, 9, 5],
    ]);
    expect(ctx.blocks.get(1)).toBe('one two three');
    expect(ctx.jobs).toEqual([]);
  });

  it('ends a paragraph at a pause and starts the next with the time', () => {
    const ctx = setup({ split: (after, before) => (after === 4 && before === 12.5 ? 6.5 : null) });
    ctx.service.segment({ text: 'one', atMs: 4_000 });
    ctx.clock.now = new Date(2026, 8, 16, 14, 35);
    ctx.service.segment({ text: 'two', atMs: 12_500 });

    expect(ctx.ranges).toEqual([{ index: 1, startSec: 0, endSec: 7 }]);
    expect(ctx.jobs).toEqual([{ blockIndex: 1, startSec: 0, endSec: 6.5, hash: hashText('one') }]);
    expect(ctx.opened[1]).toEqual({ block: { index: 2, startSec: 6, endSec: 6 }, heading: '**14:35**' });
    expect(ctx.blocks.get(2)).toBe('two');
    expect(ctx.events.map((e) => `${e.state} ${e.blockIndex}`)).toEqual(['live 1', 'queued 1', 'live 2']);
    expect(ctx.events[1]).toEqual({ blockIndex: 1, startSec: 0, endSec: 6.5, state: 'queued', clock: DATE_CLOCK });
  });

  it('keeps a split between the two segments', () => {
    const late = setup({ split: () => 100 });
    late.service.segment({ text: 'a', atMs: 1_000 });
    late.service.segment({ text: 'b', atMs: 8_000 });
    expect(late.jobs[0].endSec).toBe(8);

    const early = setup({ split: () => 0 });
    early.service.segment({ text: 'a', atMs: 1_000 });
    early.service.segment({ text: 'b', atMs: 8_000 });
    expect(early.jobs[0].endSec).toBe(1);
  });

  it('ends a paragraph that reaches the length cap at its last segment', () => {
    const ctx = setup({ blockMinutes: 2 });
    ctx.service.segment({ text: 'first', atMs: 10_000 });
    ctx.service.segment({ text: 'second', atMs: 125_000 });
    expect(ctx.jobs).toEqual([{ blockIndex: 1, startSec: 0, endSec: 10, hash: hashText('first') }]);
    expect(ctx.opened[1].block).toEqual({ index: 2, startSec: 10, endSec: 10 });
    expect(ctx.calls).toEqual([]);
  });

  it('ends a paragraph on pause and starts the next one on resume', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'before', atMs: 2_000 });
    ctx.service.setPaused(true, 3_000);
    ctx.service.segment({ text: 'muted words', atMs: 5_000 });
    ctx.clock.now = new Date(2026, 8, 16, 14, 40);
    ctx.service.setPaused(false, 10_000);
    expect(ctx.opened).toHaveLength(1);
    ctx.service.segment({ text: 'after', atMs: 12_000 });

    expect(ctx.jobs).toEqual([{ blockIndex: 1, startSec: 0, endSec: 3, hash: hashText('before') }]);
    expect(ctx.opened[1]).toEqual({ block: { index: 2, startSec: 10, endSec: 10 }, heading: '**14:40**' });
    expect(ctx.blocks.get(2)).toBe('after');
    expect([...ctx.blocks.values()].join(' ')).not.toContain('muted');
  });

  it('writes no empty paragraph for a pause before any words', () => {
    const ctx = setup();
    ctx.service.setPaused(true, 1_000);
    ctx.service.setPaused(false, 4_000);
    ctx.service.segment({ text: 'first words', atMs: 6_000 });
    expect(ctx.opened).toEqual([{ block: { index: 1, startSec: 4, endSec: 4 }, heading: DATE_CLOCK }]);
    expect(ctx.events.map((e) => e.state)).toEqual(['live']);
  });

  it('reports a paragraph whose words were removed as empty', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'gone', atMs: 1_000 });
    ctx.blocks.set(1, '');
    ctx.service.end();
    expect(ctx.jobs).toEqual([]);
    expect(ctx.events[1]).toMatchObject({ blockIndex: 1, state: 'empty' });
  });

  it('ends the paragraph when the engine relaunches', () => {
    const ctx = setup();
    ctx.service.launch({ atMs: 0 });
    ctx.service.segment({ text: 'before the crash', atMs: 3_000 });
    ctx.service.launch({ atMs: 7_000 });
    ctx.service.segment({ text: 'after', atMs: 9_000 });
    expect(ctx.jobs).toEqual([{ blockIndex: 1, startSec: 0, endSec: 7, hash: hashText('before the crash') }]);
    expect(ctx.opened[1].block).toEqual({ index: 2, startSec: 7, endSec: 7 });
  });

  it('queues the last paragraph on end and adds the run to the recorded duration', () => {
    const ctx = setup({ baseDurationSec: 100 });
    ctx.service.segment({ text: 'a bit of speech', atMs: 30_000 });
    ctx.service.end(31_400);
    expect(ctx.jobs).toEqual([{ blockIndex: 1, startSec: 0, endSec: 31.4, hash: hashText('a bit of speech') }]);
    expect(ctx.ranges).toEqual([{ index: 1, startSec: 0, endSec: 32 }]);
    expect(ctx.getDuration()).toBe(131);
    expect(ctx.service.getInfo()).toMatchObject({ state: 'stopped', blockIndex: 0 });
  });

  it('ends at the last words when no stop time is given', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'x', atMs: 30_000 });
    ctx.service.end();
    expect(ctx.jobs[0].endSec).toBe(30);
    expect(ctx.getDuration()).toBe(30);
  });

  it('records the duration of a run without words, and end is idempotent', () => {
    const ctx = setup();
    ctx.service.end(12_000);
    ctx.service.end(20_000);
    expect(ctx.jobs).toEqual([]);
    expect(ctx.getDuration()).toBe(12);
  });

  it('numbers a run after the blocks already in the document', () => {
    const ctx = setup({ firstBlockIndex: 4 });
    ctx.service.segment({ text: 'a', atMs: 1_000 });
    ctx.service.setPaused(true, 2_000);
    ctx.service.setPaused(false, 3_000);
    ctx.service.segment({ text: 'b', atMs: 4_000 });
    expect(ctx.opened.map((o) => [o.block.index, o.heading])).toEqual([
      [4, DATE_CLOCK],
      [5, '**14:32**'],
    ]);
  });

  it('applies refinement through the recorded hash', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'rough text', atMs: 10_000 });
    ctx.service.end();
    expect(ctx.service.applyRefinement(1, 'Polished text.')).toBe('replaced');
    expect(ctx.blocks.get(1)).toBe('Polished text.');
  });

  it('reports a skipped refinement when the block was edited', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'rough text', atMs: 10_000 });
    ctx.service.end();
    ctx.blocks.set(1, 'the user rewrote this');
    expect(ctx.service.applyRefinement(1, 'Polished text.')).toBe('skipped-edited');
    expect(ctx.blocks.get(1)).toBe('the user rewrote this');
  });

  it('notifies listeners on every state change', () => {
    const ctx = setup();
    const states: string[] = [];
    ctx.service.onInfo((info) => states.push(info.state));
    ctx.service.setPaused(true, 0);
    ctx.service.setPaused(false, 0);
    ctx.service.end();
    expect(states).toEqual(['paused', 'recording', 'stopped']);
  });

  it('reports queued before the job is enqueued', () => {
    const fake = fakeStore();
    const order: string[] = [];
    const service = new SessionService({
      store: fake.store,
      enqueueRefine: (job) => order.push(`job ${job.blockIndex}`),
      blockMinutes: 2,
      silenceGapSec: 5,
      silence: { splitPoint: () => null, hasSpeech: () => null },
      now: () => new Date(2026, 8, 16, 14, 32),
    });
    service.onBlock((event) => order.push(`${event.state} ${event.blockIndex}`));
    service.begin({ id: 's1', documentPath: 'C:/vault/s1.md' });
    service.segment({ text: 'hello', atMs: 1_000 });
    service.segment({ text: 'later', atMs: 250_000 });
    service.end();
    expect(order).toEqual(['live 1', 'queued 1', 'job 1', 'live 2', 'queued 2', 'job 2']);
  });

  it('follows its document to a new path', () => {
    const ctx = setup();
    const paths: string[] = [];
    ctx.service.onInfo((info) => paths.push(info.documentPath));
    ctx.service.segment({ text: 'rough', atMs: 1_000 });
    ctx.service.end();
    const replace = jest.spyOn(ctx.store, 'replaceBlock');

    ctx.service.setDocumentPath('C:/vault/Work/s1.md');

    expect(ctx.service.getInfo().documentPath).toBe('C:/vault/Work/s1.md');
    expect(paths[paths.length - 1]).toBe('C:/vault/Work/s1.md');
    expect(ctx.service.applyRefinement(1, 'Better')).toBe('replaced');
    expect(replace).toHaveBeenCalledWith('C:/vault/Work/s1.md', 1, 'Better', expect.any(String));
  });

  it('does not queue a paragraph edited outside the app, and says so', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'live words', atMs: 10_000 });
    ctx.service.markEdited(1);
    ctx.service.segment({ text: 'next block', atMs: 130_000 });

    expect(ctx.jobs).toEqual([]);
    expect(ctx.events).toContainEqual({ blockIndex: 1, startSec: 0, endSec: 10, state: 'edited', clock: DATE_CLOCK });
    expect(ctx.service.applyRefinement(1, 'Refined')).toBe('missing');
  });

  it('still queues the paragraphs that were not edited', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'one', atMs: 10_000 });
    ctx.service.markEdited(1);
    ctx.service.segment({ text: 'two', atMs: 130_000 });
    ctx.service.end();
    expect(ctx.jobs.map((job) => job.blockIndex)).toEqual([2]);
  });

  it('forgets edited blocks when a new run begins', () => {
    const ctx = setup();
    ctx.service.markEdited(1);
    ctx.service.begin({ id: 's2', documentPath: 'C:/vault/s2.md' });
    ctx.service.segment({ text: 'fresh', atMs: 10_000 });
    ctx.service.end();
    expect(ctx.jobs.map((job) => job.blockIndex)).toEqual([1]);
  });

  it('marks only the open paragraph as edited by another program', () => {
    const ctx = setup();
    ctx.service.noteOutsideEdit([1]);
    ctx.service.segment({ text: 'one', atMs: 1_000 });
    ctx.service.setPaused(true, 2_000);
    ctx.service.noteOutsideEdit([1]);
    ctx.service.setPaused(false, 3_000);
    ctx.service.segment({ text: 'two', atMs: 4_000 });
    ctx.service.noteOutsideEdit([1, 2]);
    ctx.service.end();
    expect(ctx.jobs.map((job) => job.blockIndex)).toEqual([1]);
    expect(ctx.events.filter((e) => e.state === 'edited').map((e) => e.blockIndex)).toEqual([2]);
  });

  it('drops live text when nobody spoke since the previous text', () => {
    const ctx = setup({ speech: (from) => from < 2 });
    expect(ctx.service.segment({ text: 'real words', atMs: 4_000 })).toBe(true);
    expect(ctx.service.segment({ text: 'Thank you.', atMs: 15_000 })).toBe(false);
    expect(ctx.blocks.get(1)).toBe('real words');
    expect(ctx.opened).toHaveLength(1);
    expect(ctx.speechCalls).toEqual([
      [0, 4],
      [4, 15],
    ]);
  });

  it('looks back no further than the live engine window', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'one', atMs: 2_000 });
    ctx.service.segment({ text: 'two', atMs: 40_000 });
    expect(ctx.speechCalls[1]).toEqual([28, 40]);
  });

  it('keeps or drops all lines of one live window together', () => {
    const ctx = setup({ speech: (from) => from < 1 });
    expect(ctx.service.segment({ text: 'first line', atMs: 3_000 })).toBe(true);
    expect(ctx.service.segment({ text: 'second line', atMs: 3_200 })).toBe(true);
    expect(ctx.service.segment({ text: 'again', atMs: 9_000 })).toBe(false);
    expect(ctx.service.segment({ text: 'and again', atMs: 9_100 })).toBe(false);
    expect(ctx.speechCalls).toHaveLength(2);
    expect(ctx.blocks.get(1)).toBe('first line second line');
  });

  it('keeps live text when there is no audio to judge by', () => {
    const ctx = setup();
    expect(ctx.service.segment({ text: 'kept', atMs: 1_000 })).toBe(true);
    expect(ctx.blocks.get(1)).toBe('kept');
  });

  it('keeps the live text when refinement hears nothing, and tidies refined lines', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'rough', atMs: 1_000 });
    ctx.service.setPaused(true, 2_000);
    ctx.service.setPaused(false, 3_000);
    ctx.service.segment({ text: 'more', atMs: 4_000 });
    ctx.service.end();
    expect(ctx.service.applyRefinement(1, ' . ')).toBe('no-speech');
    expect(ctx.blocks.get(1)).toBe('rough');
    expect(ctx.service.applyRefinement(2, ' More words.\n  And a second line. \n')).toBe('replaced');
    expect(ctx.blocks.get(2)).toBe('More words.\nAnd a second line.');
  });
});
