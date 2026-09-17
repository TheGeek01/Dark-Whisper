import type { BlockEvent, BlockState, SegmentEvent, SessionStatusView } from '../shared/api.js';
import { clockOf, clockParts } from './documentView.js';
import { formatClock } from './format.js';

export interface SessionModel {
  status: SessionStatusView | null;
  blocks: BlockEvent[];
  // Live text received since the document was last read, by block.
  pendingText: Map<number, string>;
}

// Events can arrive out of order (a status snapshot after a newer block event): never go back.
const RANK: Record<BlockState, number> = {
  live: 0,
  empty: 1,
  queued: 1,
  refining: 2,
  refined: 3,
  skipped: 3,
  failed: 3,
};

export const BLOCK_LABELS: Record<BlockState, string> = {
  live: 'live',
  empty: 'no speech',
  queued: 'pending',
  refining: 'refining…',
  refined: 'refined',
  skipped: 'skipped',
  failed: 'failed',
};

const RUNNING_STATES: SessionStatusView['state'][] = ['starting', 'recording', 'paused', 'error'];

export function emptySessionModel(): SessionModel {
  return { status: null, blocks: [], pendingText: new Map() };
}

export function isSessionRunning(status: SessionStatusView | null): boolean {
  return status !== null && RUNNING_STATES.includes(status.state);
}

function upsert(blocks: BlockEvent[], event: BlockEvent): BlockEvent[] {
  const existing = blocks.find((b) => b.blockIndex === event.blockIndex);
  if (existing && RANK[event.state] < RANK[existing.state]) return blocks;
  const next = blocks.filter((b) => b.blockIndex !== event.blockIndex);
  next.push(event);
  return next.sort((a, b) => a.blockIndex - b.blockIndex);
}

export function applyStatus(model: SessionModel, status: SessionStatusView): SessionModel {
  const sameSession = model.status !== null && model.status.sessionId === status.sessionId;
  let blocks = sameSession ? model.blocks : [];
  for (const event of status.blocks) blocks = upsert(blocks, event);
  return { status, blocks, pendingText: sameSession ? model.pendingText : new Map() };
}

export function applyBlock(model: SessionModel, event: BlockEvent): SessionModel {
  if (!model.status || model.status.sessionId !== event.sessionId) return model;
  return { ...model, blocks: upsert(model.blocks, event) };
}

export function applySegment(model: SessionModel, segment: SegmentEvent): SessionModel {
  const text = segment.text.trim();
  if (text === '') return model;
  const pendingText = new Map(model.pendingText);
  const before = pendingText.get(segment.blockIndex);
  pendingText.set(segment.blockIndex, before ? `${before} ${text}` : text);
  return { ...model, pendingText };
}

// Main sends segment events after writing them and answers reads in order, so a document read
// already contains every segment that arrived before its reply.
export function clearPendingText(model: SessionModel): SessionModel {
  return model.pendingText.size === 0 ? model : { ...model, pendingText: new Map() };
}

export function stateLabel(status: SessionStatusView): string {
  if (status.state === 'idle') return 'No session';
  if (status.state === 'paused' && status.muted) return 'Paused (mic muted)';
  return status.state.charAt(0).toUpperCase() + status.state.slice(1);
}

export function sessionSummary(status: SessionStatusView): string {
  if (status.state === 'idle') return 'No session';
  return `${stateLabel(status)} · ${formatClock(status.durationSec)}`;
}

export function sessionTitle(status: SessionStatusView): string {
  return status.kind === 'quick-note' ? 'Quick Note' : 'Session';
}

export function sessionDetailRows(status: SessionStatusView): [string, string][] {
  const microphone = status.microphone || 'System default';
  return [
    ['Microphone', status.muted === true ? `${microphone} (muted)` : microphone],
    ['Live model', status.liveModel],
    ['Refine model', status.refineModel],
    ['Elapsed time', formatClock(status.durationSec)],
    ['Waiting to refine', String(status.refining)],
    ['Folder', status.folder || 'Vault root'],
  ];
}

export function blockTime(block: BlockEvent): string {
  return clockParts(clockOf(block.clock)).time || formatClock(block.startSec);
}
