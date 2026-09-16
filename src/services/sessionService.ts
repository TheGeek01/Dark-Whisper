import { blockRange, formatTimestampHeading } from './blockMath';
import { BlockRef, hashText, ReplaceOutcome } from './documentStore';

export type SessionState = 'recording' | 'paused' | 'stopped';

export interface RefineJob {
  blockIndex: number;
  startSec: number;
  endSec: number;
  hash: string;
}

export type SessionBlockState = 'live' | 'empty' | 'queued';

export interface SessionBlockEvent {
  blockIndex: number;
  startSec: number;
  endSec: number;
  state: SessionBlockState;
}

export interface SessionInfo {
  id: string;
  documentPath: string;
  state: SessionState;
  blockIndex: number;
  durationSec: number;
}

export interface SessionStoreLike {
  openBlock(file: string, block: BlockRef, heading?: string): void;
  appendSegment(file: string, text: string): void;
  appendLine(file: string, line: string): void;
  readBlockText(file: string, index: number): string | null;
  replaceBlock(file: string, index: number, text: string, expectedHash: string): ReplaceOutcome;
  updateFrontmatter(file: string, patch: { duration: number }): void;
}

export interface SessionDeps {
  store: SessionStoreLike;
  enqueueRefine(job: RefineJob): void;
  blockMinutes: number;
  timestampHeadings: boolean;
}

export class SessionService {
  private info: SessionInfo = { id: '', documentPath: '', state: 'stopped', blockIndex: 0, durationSec: 0 };
  private readonly listeners = new Set<(info: SessionInfo) => void>();
  private readonly blockListeners = new Set<(event: SessionBlockEvent) => void>();
  private readonly hashes = new Map<number, string>();
  private launches = 0;

  constructor(private readonly deps: SessionDeps) {}

  getInfo(): SessionInfo {
    return { ...this.info };
  }

  onInfo(listener: (info: SessionInfo) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onBlock(listener: (event: SessionBlockEvent) => void): () => void {
    this.blockListeners.add(listener);
    return () => {
      this.blockListeners.delete(listener);
    };
  }

  private emitBlock(event: SessionBlockEvent): void {
    for (const l of this.blockListeners) l(event);
  }

  // The runtime renames or moves a finished session's document while its blocks may still refine.
  setDocumentPath(documentPath: string): void {
    this.info = { ...this.info, documentPath };
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getInfo();
    for (const l of this.listeners) l(snapshot);
  }

  begin(args: { id: string; documentPath: string }): void {
    this.hashes.clear();
    this.launches = 0;
    this.info = { id: args.id, documentPath: args.documentPath, state: 'recording', blockIndex: 1, durationSec: 0 };
    this.openBlock(1);
  }

  private openBlock(index: number): void {
    const range = blockRange(index, this.deps.blockMinutes);
    const block: BlockRef = { index, startSec: range.startSec, endSec: range.endSec };
    const heading = this.deps.timestampHeadings ? formatTimestampHeading(range.startSec) : undefined;
    this.deps.store.openBlock(this.info.documentPath, block, heading);
    this.emitBlock({ blockIndex: index, startSec: range.startSec, endSec: range.endSec, state: 'live' });
  }

  // A block with no speech in it has nothing to refine, so it is closed without a job.
  // 'queued' is reported before the job is enqueued: the queue may start it synchronously.
  private closeBlock(index: number, endSec: number): void {
    const range = blockRange(index, this.deps.blockMinutes);
    const text = this.deps.store.readBlockText(this.info.documentPath, index) ?? '';
    if (text.trim().length === 0) {
      this.emitBlock({ blockIndex: index, startSec: range.startSec, endSec, state: 'empty' });
      return;
    }
    const hash = hashText(text);
    this.hashes.set(index, hash);
    this.emitBlock({ blockIndex: index, startSec: range.startSec, endSec, state: 'queued' });
    this.deps.enqueueRefine({ blockIndex: index, startSec: range.startSec, endSec, hash });
  }

  segment(s: { text: string; atMs: number }): void {
    if (this.info.state !== 'recording') return;
    const atSec = s.atMs / 1000;

    while (atSec >= blockRange(this.info.blockIndex, this.deps.blockMinutes).endSec) {
      const closing = this.info.blockIndex;
      this.closeBlock(closing, blockRange(closing, this.deps.blockMinutes).endSec);
      this.info = { ...this.info, blockIndex: closing + 1 };
      this.openBlock(this.info.blockIndex);
    }

    this.deps.store.appendSegment(this.info.documentPath, s.text);
    this.info = { ...this.info, durationSec: Math.max(this.info.durationSec, atSec) };
    this.emit();
  }

  launch(_l: { atMs: number }): void {
    this.launches++;
    if (this.launches <= 1) return;
    this.deps.store.appendLine(this.info.documentPath, '<!-- dw:gap -->');
    this.deps.store.appendLine(this.info.documentPath, '*(recording interrupted and resumed)*');
  }

  setPaused(paused: boolean): void {
    if (this.info.state === 'stopped') return;
    const next: SessionState = paused ? 'paused' : 'recording';
    if (next === this.info.state) return;
    this.info = { ...this.info, state: next };
    this.emit();
  }

  end(): void {
    if (this.info.state === 'stopped') return;
    const duration = Math.round(this.info.durationSec);
    this.closeBlock(this.info.blockIndex, duration);
    this.deps.store.updateFrontmatter(this.info.documentPath, { duration });
    this.info = { ...this.info, state: 'stopped' };
    this.emit();
  }

  applyRefinement(blockIndex: number, text: string): ReplaceOutcome {
    const hash = this.hashes.get(blockIndex);
    if (hash === undefined) return 'missing';
    const outcome = this.deps.store.replaceBlock(this.info.documentPath, blockIndex, text, hash);
    if (outcome === 'replaced') {
      this.hashes.set(blockIndex, hashText(text));
    }
    return outcome;
  }
}
