import type { SpeechAudio } from './audioLevel';
import { BlockRef, formatClockLine, hashText, ReplaceOutcome } from './documentStore';
import { isNoiseSegment } from './streamOutput';

// whisper-stream transcribes its last 10 s of audio each time it hears a pause; allow for the
// time that takes.
const LIVE_WINDOW_SEC = 12;
// The lines of one transcribed window arrive together.
const SAME_WINDOW_SEC = 0.5;

export type RefineOutcome = ReplaceOutcome | 'no-speech';

export type SessionState = 'recording' | 'paused' | 'stopped';

export interface RefineJob {
  blockIndex: number;
  startSec: number;
  endSec: number;
  hash: string;
}

export type SessionBlockState = 'live' | 'empty' | 'queued' | 'edited';

export interface SessionBlockEvent {
  blockIndex: number;
  startSec: number;
  endSec: number;
  state: SessionBlockState;
  clock: string;
}

export interface SessionInfo {
  id: string;
  documentPath: string;
  state: SessionState;
  // The paragraph being written, or 0 between paragraphs.
  blockIndex: number;
  durationSec: number;
}

export interface SessionStoreLike {
  openBlock(file: string, block: BlockRef, heading?: string): void;
  setBlockRange(file: string, block: BlockRef): void;
  appendSegment(file: string, text: string): void;
  readBlockText(file: string, index: number): string | null;
  replaceBlock(file: string, index: number, text: string, expectedHash: string): ReplaceOutcome;
  updateFrontmatter(file: string, patch: { duration: number }): void;
}

export interface SessionDeps {
  store: SessionStoreLike;
  enqueueRefine(job: RefineJob): void;
  // A paragraph closes after this long even without a pause.
  blockMinutes: number;
  silenceGapSec: number;
  silence: SpeechAudio;
  now(): Date;
}

interface OpenBlock {
  index: number;
  startSec: number;
  clock: string;
  lastSegmentSec: number;
}

// One recording run (a session, or one quick note) writing paragraphs into a document (spec §3.1).
// A paragraph is a block: it opens with a clock line when its first words arrive and closes at a
// pause in speech, on Pause, on an engine relaunch, at the length cap, or on Stop. Times are on
// the run's audio clock (seconds since the recorder started).
export class SessionService {
  private info: SessionInfo = { id: '', documentPath: '', state: 'stopped', blockIndex: 0, durationSec: 0 };
  private readonly listeners = new Set<(info: SessionInfo) => void>();
  private readonly blockListeners = new Set<(event: SessionBlockEvent) => void>();
  private readonly hashes = new Map<number, string>();
  // Blocks someone changed outside the app before they closed: their text is not ours to replace.
  private readonly editedBlocks = new Set<number>();
  private open: OpenBlock | null = null;
  // Where the next paragraph's audio begins.
  private nextStartSec = 0;
  private nextIndex = 1;
  private openedAny = false;
  private baseDurationSec = 0;
  private launches = 0;
  private lastArrivalSec: number | null = null;
  private lastArrivalKept = true;

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

  // A quick note appends to a document that already has blocks: numbering continues after them,
  // and the frontmatter duration adds this run to what was recorded before.
  begin(args: { id: string; documentPath: string; firstBlockIndex?: number; baseDurationSec?: number }): void {
    this.hashes.clear();
    this.editedBlocks.clear();
    this.open = null;
    this.nextStartSec = 0;
    this.nextIndex = args.firstBlockIndex ?? 1;
    this.openedAny = false;
    this.baseDurationSec = args.baseDurationSec ?? 0;
    this.launches = 0;
    this.lastArrivalSec = null;
    this.lastArrivalKept = true;
    this.info = { id: args.id, documentPath: args.documentPath, state: 'recording', blockIndex: 0, durationSec: 0 };
  }

  // The first paragraph of a run carries the date as well as the time (spec §3.2).
  private openBlock(atSec: number): OpenBlock {
    const startSec = Math.min(this.nextStartSec, atSec);
    const index = this.nextIndex++;
    const clock = formatClockLine(this.deps.now(), !this.openedAny);
    this.openedAny = true;
    const block: OpenBlock = { index, startSec, clock, lastSegmentSec: atSec };
    this.open = block;
    this.info = { ...this.info, blockIndex: index };
    const marker = Math.floor(startSec);
    this.deps.store.openBlock(this.info.documentPath, { index, startSec: marker, endSec: marker }, clock);
    this.emitBlock({ blockIndex: index, startSec, endSec: startSec, state: 'live', clock });
    return block;
  }

  markEdited(blockIndex: number): void {
    this.editedBlocks.add(blockIndex);
  }

  // Another program changed these blocks. The open paragraph has no hash yet, so it is marked;
  // closed paragraphs are protected by their hash when refined. While a paragraph closes, it is
  // still `open`, so an edit noticed by the closing reads is caught too.
  noteOutsideEdit(changed: readonly number[]): void {
    if (this.open && changed.includes(this.open.index)) {
      this.markEdited(this.open.index);
    }
  }

  // A paragraph with no words left has nothing to refine, and neither does one edited outside
  // the app. Reading the text may itself detect such an edit, so the edited check comes after.
  // 'queued' is reported before the job is enqueued: the queue may start it synchronously.
  private closeOpen(atSec: number): void {
    const block = this.open;
    if (!block) return;
    const endSec = Math.max(atSec, block.startSec);
    const file = this.info.documentPath;
    this.deps.store.setBlockRange(file, { index: block.index, startSec: Math.floor(block.startSec), endSec: Math.ceil(endSec) });
    const text = this.deps.store.readBlockText(file, block.index) ?? '';
    this.open = null;
    this.info = { ...this.info, blockIndex: 0 };
    this.nextStartSec = endSec;

    const event = { blockIndex: block.index, startSec: block.startSec, endSec, clock: block.clock };
    if (this.editedBlocks.has(block.index)) {
      this.emitBlock({ ...event, state: 'edited' });
      return;
    }
    if (text.trim().length === 0) {
      this.emitBlock({ ...event, state: 'empty' });
      return;
    }
    const hash = hashText(text);
    this.hashes.set(block.index, hash);
    this.emitBlock({ ...event, state: 'queued' });
    this.deps.enqueueRefine({ blockIndex: block.index, startSec: block.startSec, endSec, hash });
  }

  // Where the open paragraph should end before a segment that arrived at atSec, or null.
  private splitPoint(block: OpenBlock, atSec: number): number | null {
    if (atSec - block.startSec >= this.deps.blockMinutes * 60) return block.lastSegmentSec;
    const split = this.deps.silence.splitPoint(block.lastSegmentSec, atSec, this.deps.silenceGapSec);
    return split === null ? null : Math.min(atSec, Math.max(block.lastSegmentSec, split));
  }

  // whisper-stream sometimes transcribes silence ("Thank you.", "you") or repeats words it
  // already sent. Live text is kept only if someone spoke since the previous text; lines of one
  // window share that decision. With no audio to judge by, everything is kept.
  private heardSpeech(atSec: number): boolean {
    const previous = this.lastArrivalSec;
    if (previous !== null && atSec - previous < SAME_WINDOW_SEC) return this.lastArrivalKept;
    const from = Math.max(previous ?? 0, atSec - LIVE_WINDOW_SEC, 0);
    return this.deps.silence.hasSpeech(from, atSec) !== false;
  }

  // Returns whether the text was written.
  segment(s: { text: string; atMs: number }): boolean {
    if (this.info.state !== 'recording') return false;
    const atSec = s.atMs / 1000;
    const kept = this.heardSpeech(atSec);
    this.lastArrivalSec = atSec;
    this.lastArrivalKept = kept;
    if (!kept) return false;
    if (this.open) {
      const split = this.splitPoint(this.open, atSec);
      if (split !== null) this.closeOpen(split);
    }
    const block = this.open ?? this.openBlock(atSec);
    this.deps.store.appendSegment(this.info.documentPath, s.text);
    block.lastSegmentSec = atSec;
    this.info = { ...this.info, durationSec: Math.max(this.info.durationSec, atSec) };
    this.emit();
    return true;
  }

  // whisper-stream crashed and came back: the paragraph ends where the engine stopped hearing.
  launch(l: { atMs: number }): void {
    this.launches++;
    if (this.launches <= 1) return;
    this.closeOpen(l.atMs / 1000);
  }

  setPaused(paused: boolean, atMs: number): void {
    if (this.info.state === 'stopped') return;
    const next: SessionState = paused ? 'paused' : 'recording';
    if (next === this.info.state) return;
    const atSec = atMs / 1000;
    if (paused) this.closeOpen(atSec);
    else this.nextStartSec = atSec;
    this.info = { ...this.info, state: next };
    this.emit();
  }

  end(atMs?: number): void {
    if (this.info.state === 'stopped') return;
    const endSec = Math.max(this.info.durationSec, (atMs ?? 0) / 1000);
    this.closeOpen(endSec);
    this.deps.store.updateFrontmatter(this.info.documentPath, {
      duration: Math.round(this.baseDurationSec + endSec),
    });
    this.info = { ...this.info, state: 'stopped', durationSec: endSec };
    this.emit();
  }

  // A refinement that heard nothing (silence, a stray ".") keeps the live text. whisper-server
  // starts each line after the first with a space; those are trimmed.
  applyRefinement(blockIndex: number, text: string): RefineOutcome {
    const hash = this.hashes.get(blockIndex);
    if (hash === undefined) return 'missing';
    if (isNoiseSegment(text)) return 'no-speech';
    const clean = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .join('\n');
    const outcome = this.deps.store.replaceBlock(this.info.documentPath, blockIndex, clean, hash);
    if (outcome === 'replaced') {
      this.hashes.set(blockIndex, hashText(clean));
    }
    return outcome;
  }
}
