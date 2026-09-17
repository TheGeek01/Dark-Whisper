import type { BlockEvent, SessionStatusView } from '../shared/api';
import {
  applyBlock,
  applySegment,
  applyStatus,
  clearPendingText,
  emptySessionModel,
  isSessionRunning,
  sessionSummary,
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
