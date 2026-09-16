import { SessionBlockEvent, SessionService, SessionStoreLike, RefineJob } from '../services/sessionService';
import { hashText } from '../services/documentStore';

function fakeStore() {
  const blocks = new Map<number, string>();
  const lines: string[] = [];
  const headings: (string | undefined)[] = [];
  let duration = 0;
  const store: SessionStoreLike = {
    openBlock: (_file, block, heading) => {
      blocks.set(block.index, '');
      headings.push(heading);
    },
    appendSegment: (_file, text) => {
      const current = [...blocks.keys()].pop() ?? 1;
      blocks.set(current, `${blocks.get(current) ?? ''}${blocks.get(current) ? ' ' : ''}${text}`);
    },
    appendLine: (_file, line) => lines.push(line),
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
  return { store, blocks, lines, headings, getDuration: () => duration };
}

function setup(overrides: { blockMinutes?: number; timestampHeadings?: boolean } = {}) {
  const fake = fakeStore();
  const jobs: RefineJob[] = [];
  const service = new SessionService({
    store: fake.store,
    enqueueRefine: (job) => jobs.push(job),
    blockMinutes: overrides.blockMinutes ?? 2,
    timestampHeadings: overrides.timestampHeadings ?? false,
  });
  service.begin({ id: 's1', documentPath: 'C:/vault/s1.md' });
  return { service, jobs, ...fake };
}

describe('SessionService', () => {
  it('opens the first block and reports recording', () => {
    const ctx = setup();
    expect(ctx.service.getInfo()).toEqual({
      id: 's1',
      documentPath: 'C:/vault/s1.md',
      state: 'recording',
      blockIndex: 1,
      durationSec: 0,
    });
    expect(ctx.blocks.has(1)).toBe(true);
  });

  it('appends segments and tracks duration', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'hello', atMs: 1_000 });
    ctx.service.segment({ text: 'world', atMs: 4_500 });
    expect(ctx.blocks.get(1)).toBe('hello world');
    expect(ctx.service.getInfo().durationSec).toBe(4.5);
  });

  it('closes a block at the boundary and queues it for refinement', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'first block', atMs: 10_000 });
    ctx.service.segment({ text: 'second block', atMs: 121_000 });

    expect(ctx.jobs).toEqual([
      { blockIndex: 1, startSec: 0, endSec: 120, hash: hashText('first block') },
    ]);
    expect(ctx.blocks.get(1)).toBe('first block');
    expect(ctx.blocks.get(2)).toBe('second block');
    expect(ctx.service.getInfo().blockIndex).toBe(2);
  });

  it('skips empty blocks when someone is silent for minutes', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'talking again', atMs: 400_000 });
    expect(ctx.jobs).toEqual([]);
    expect(ctx.service.getInfo().blockIndex).toBe(4);
    expect(ctx.blocks.get(4)).toBe('talking again');
  });

  it('writes timestamp headings when enabled', () => {
    const ctx = setup({ timestampHeadings: true });
    ctx.service.segment({ text: 'x', atMs: 121_000 });
    expect(ctx.headings).toEqual(['## 00:00:00', '## 00:02:00']);
  });

  it('marks an interruption when the engine relaunches', () => {
    const ctx = setup();
    ctx.service.launch({ atMs: 0 });
    ctx.service.launch({ atMs: 65_000 });
    expect(ctx.lines).toEqual(['<!-- dw:gap -->', '*(recording interrupted and resumed)*']);
  });

  it('ignores segments while paused', () => {
    const ctx = setup();
    ctx.service.setPaused(true);
    expect(ctx.service.getInfo().state).toBe('paused');
    ctx.service.segment({ text: 'muted words', atMs: 5_000 });
    ctx.service.setPaused(false);
    ctx.service.segment({ text: 'heard this', atMs: 6_000 });
    expect(ctx.blocks.get(1)).toBe('heard this');
  });

  it('queues the final partial block and records duration on end', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'a bit of speech', atMs: 30_000 });
    ctx.service.end();

    expect(ctx.jobs).toEqual([{ blockIndex: 1, startSec: 0, endSec: 30, hash: hashText('a bit of speech') }]);
    expect(ctx.getDuration()).toBe(30);
    expect(ctx.service.getInfo().state).toBe('stopped');
  });

  it('does not queue an empty final block, and end is idempotent', () => {
    const ctx = setup();
    ctx.service.end();
    ctx.service.end();
    expect(ctx.jobs).toEqual([]);
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
    ctx.service.setPaused(true);
    ctx.service.setPaused(false);
    ctx.service.end();
    expect(states).toEqual(['paused', 'recording', 'stopped']);
  });

  it('reports block lifecycle events, queued before the job is enqueued', () => {
    const fake = fakeStore();
    const events: SessionBlockEvent[] = [];
    const order: string[] = [];
    const service = new SessionService({
      store: fake.store,
      enqueueRefine: (job) => order.push(`job ${job.blockIndex}`),
      blockMinutes: 2,
      timestampHeadings: false,
    });
    service.onBlock((event) => {
      events.push(event);
      order.push(`${event.state} ${event.blockIndex}`);
    });
    service.begin({ id: 's1', documentPath: 'C:/vault/s1.md' });
    service.segment({ text: 'hello', atMs: 1_000 });
    service.segment({ text: 'later', atMs: 250_000 });
    service.end();

    expect(order).toEqual(['live 1', 'queued 1', 'job 1', 'live 2', 'empty 2', 'live 3', 'queued 3', 'job 3']);
    expect(events[0]).toEqual({ blockIndex: 1, startSec: 0, endSec: 120, state: 'live' });
    expect(events[1]).toEqual({ blockIndex: 1, startSec: 0, endSec: 120, state: 'queued' });
    expect(events[3]).toEqual({ blockIndex: 2, startSec: 120, endSec: 240, state: 'empty' });
    expect(events[5]).toEqual({ blockIndex: 3, startSec: 240, endSec: 250, state: 'queued' });
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
});
