import type { BlockEvent, SessionStatusView } from '../shared/api';
import {
  applyBlock,
  applySegment,
  applyStatus,
  BLOCK_LABELS,
  blockTime,
  clearPendingText,
  documentBlocks,
  emptySessionModel,
  isSessionRunning,
  sessionDetailRows,
  sessionSummary,
  sessionTitle,
  stateLabel,
} from '../renderer/sessionModel';
import { getState, subscribe, update } from '../renderer/state';

const status = (overrides: Partial<SessionStatusView> = {}): SessionStatusView => ({
  sessionId: 's1',
  kind: 'session',
  state: 'recording',
  documentPath: 'C:/v/a.md',
  documentFile: 'a.md',
  folder: '',
  blockIndex: 1,
  durationSec: 0,
  refining: 0,
  muted: false,
  microphone: 'Mic',
  liveModel: 'base',
  refineModel: 'turbo',
  messages: [],
  blocks: [],
  earlier: [],
  ...overrides,
});

const block = (blockIndex: number, state: BlockEvent['state'], sessionId = 's1'): BlockEvent => ({
  sessionId,
  blockIndex,
  startSec: (blockIndex - 1) * 120,
  endSec: blockIndex * 120,
  clock: '',
  state,
});

describe('sessionModel', () => {
  it('takes blocks from the status and keeps them in order', () => {
    const model = applyStatus(emptySessionModel(), status({ blocks: [block(2, 'live'), block(1, 'queued')] }));
    expect(model.blocks.map((b) => b.blockIndex)).toEqual([1, 2]);
  });

  it('moves a block forward through its states but never back', () => {
    let model = applyStatus(emptySessionModel(), status());
    model = applyBlock(model, block(1, 'queued'));
    model = applyBlock(model, block(1, 'refined'));
    model = applyBlock(model, block(1, 'refining'));
    expect(model.blocks).toEqual([block(1, 'refined')]);
  });

  it('ignores block events from another session', () => {
    const model = applyStatus(emptySessionModel(), status());
    expect(applyBlock(model, block(1, 'live', 'other'))).toBe(model);
  });

  it('resets when a new session starts', () => {
    let model = applyStatus(emptySessionModel(), status({ blocks: [block(1, 'refined')] }));
    model = applySegment(model, { text: 'hi', blockIndex: 1 });
    model = applyStatus(model, status({ sessionId: 's2', blocks: [] }));
    expect(model.blocks).toEqual([]);
    expect(model.pendingText.size).toBe(0);
  });

  it('collects live text per block until the document is read again', () => {
    let model = applyStatus(emptySessionModel(), status());
    model = applySegment(model, { text: ' hello ', blockIndex: 1 });
    model = applySegment(model, { text: 'world', blockIndex: 1 });
    model = applySegment(model, { text: 'next', blockIndex: 2 });
    expect([...model.pendingText]).toEqual([
      [1, 'hello world'],
      [2, 'next'],
    ]);
    expect(clearPendingText(model).pendingText.size).toBe(0);
  });

  it('names the run and its state', () => {
    expect(sessionTitle(status())).toBe('Session');
    expect(sessionTitle(status({ kind: 'quick-note' }))).toBe('Quick Note');
    expect(stateLabel(status())).toBe('Recording');
    expect(stateLabel(status({ state: 'paused', muted: true }))).toBe('Paused (mic muted)');
    expect(stateLabel(status({ state: 'stopped' }))).toBe('Stopped');
    expect(BLOCK_LABELS.queued).toBe('pending');
  });

  it('lists the run details', () => {
    expect(sessionDetailRows(status({ durationSec: 161, refining: 2, muted: true, folder: 'Work' }))).toEqual([
      ['Microphone', 'Mic (muted)'],
      ['Live model', 'base'],
      ['Refine model', 'turbo'],
      ['Elapsed time', '02:41'],
      ['Waiting to refine', '2'],
      ['Folder', 'Work'],
    ]);
    expect(sessionDetailRows(status({ microphone: '' }))[0]).toEqual(['Microphone', 'System default']);
    expect(sessionDetailRows(status())[5]).toEqual(['Folder', 'Vault root']);
  });

  it('shows a paragraph by its clock time, else its start', () => {
    expect(blockTime({ ...block(1, 'refined'), clock: '**2026-09-16 14:32**' })).toBe('14:32');
    expect(blockTime({ ...block(2, 'refined'), clock: '' })).toBe('02:00');
  });

  it('knows when a session is running', () => {
    expect(isSessionRunning(null)).toBe(false);
    expect(isSessionRunning(status({ state: 'paused' }))).toBe(true);
    expect(isSessionRunning(status({ state: 'starting' }))).toBe(true);
    expect(isSessionRunning(status({ state: 'stopped' }))).toBe(false);
    expect(isSessionRunning(status({ state: 'idle' }))).toBe(false);
  });

  it('summarises the session', () => {
    expect(sessionSummary(status({ state: 'paused', muted: true, durationSec: 75 }))).toBe('Paused (mic muted) · 01:15');
    expect(sessionSummary(status({ state: 'recording', durationSec: 3725 }))).toBe('Recording · 1:02:05');
    expect(sessionSummary(status({ state: 'idle' }))).toBe('No session');
  });

  it('treats a removed paragraph as finished', () => {
    expect(BLOCK_LABELS.removed).toBe('removed — no speech');
    let model = applyStatus(emptySessionModel(), status());
    model = applyBlock(model, block(1, 'removed'));
    model = applyBlock(model, block(1, 'refining'));
    expect(model.blocks).toEqual([block(1, 'removed')]);
  });

  it('keeps an earlier recording that is still refining, and its document shows its states', () => {
    const earlier = { sessionId: 'old', documentFile: 'Notes/old.md', blocks: [block(1, 'queued', 'old')] };
    let model = applyStatus(emptySessionModel(), status({ earlier: [earlier] }));
    model = applyBlock(model, block(1, 'refining', 'old'));
    model = applyBlock(model, block(2, 'queued', 'old'));
    expect(documentBlocks(model, 'Notes/old.md')).toEqual([block(1, 'refining', 'old'), block(2, 'queued', 'old')]);
    expect(documentBlocks(model, 'C:/v/a.md')).toEqual([]);

    // A status snapshot taken before those events must not move the blocks back.
    model = applyStatus(model, status({ earlier: [earlier] }));
    expect(documentBlocks(model, 'Notes/old.md')[0].state).toBe('refining');

    // Once it has finished refining, main stops listing it.
    model = applyStatus(model, status());
    expect(documentBlocks(model, 'Notes/old.md')).toEqual([]);
  });

  it('merges the current and an earlier recording writing to the same document', () => {
    let model = applyStatus(
      emptySessionModel(),
      status({ documentFile: 'Quick Notes/day.md', earlier: [{ sessionId: 'old', documentFile: 'Quick Notes/day.md', blocks: [block(1, 'refining', 'old')] }] }),
    );
    model = applyBlock(model, block(2, 'live'));
    expect(documentBlocks(model, 'Quick Notes/day.md').map((b) => [b.blockIndex, b.state])).toEqual([
      [1, 'refining'],
      [2, 'live'],
    ]);
  });
});

describe('state', () => {
  it('merges patches and reports which keys changed', () => {
    const seen: string[][] = [];
    subscribe((_state, changed) => seen.push([...changed]));
    update({ selectedFile: 'a.md', search: 'x' });
    expect(getState().selectedFile).toBe('a.md');
    expect(getState().search).toBe('x');
    expect(getState().selectedFolder).toBe('');
    expect(seen).toEqual([['selectedFile', 'search']]);
  });
});
