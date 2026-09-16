import { BlockRef, changedBlocks, DocumentStore, ReplaceOutcome } from './documentStore';
import type { SessionStoreLike } from './sessionService';

// Called with the indexes of the blocks whose text another program changed (possibly none,
// e.g. an edit to the frontmatter).
export type OutsideEditListener = (changedBlocks: number[]) => void;

// Wraps the document store for one session. Before every read or write it compares the file with
// what we last wrote (spec §5.3). An outside change becomes the new baseline, and the listener
// learns which blocks changed: finished blocks are protected by their own hash when refined, and
// the session marks the block still being recorded so it is never refined over the edit.
// A file that cannot be read at the moment (a sync client holding it) is not an edit.
export class GuardedStore implements SessionStoreLike {
  private lastContent: string | null = null;

  constructor(
    private readonly store: DocumentStore,
    private readonly onOutsideEdit: OutsideEditListener,
  ) {}

  private checkForOutsideEdit(file: string): void {
    if (this.lastContent === null) return;
    const current = this.store.readContent(file);
    if (current === null || current === this.lastContent) return;
    const changed = changedBlocks(this.lastContent, current);
    this.lastContent = current;
    this.onOutsideEdit(changed);
  }

  noteWrite(file: string): void {
    this.lastContent = this.store.readContent(file);
  }

  openBlock(file: string, block: BlockRef, heading?: string): void {
    this.checkForOutsideEdit(file);
    this.store.openBlock(file, block, heading);
    this.noteWrite(file);
  }

  appendSegment(file: string, text: string): void {
    this.checkForOutsideEdit(file);
    this.store.appendSegment(file, text);
    this.noteWrite(file);
  }

  appendLine(file: string, line: string): void {
    this.checkForOutsideEdit(file);
    this.store.appendLine(file, line);
    this.noteWrite(file);
  }

  readBlockText(file: string, index: number): string | null {
    this.checkForOutsideEdit(file);
    return this.store.readBlockText(file, index);
  }

  replaceBlock(file: string, index: number, text: string, expectedHash: string): ReplaceOutcome {
    this.checkForOutsideEdit(file);
    const outcome = this.store.replaceBlock(file, index, text, expectedHash);
    this.noteWrite(file);
    return outcome;
  }

  updateFrontmatter(file: string, patch: { duration: number }): void {
    this.checkForOutsideEdit(file);
    this.store.updateFrontmatter(file, patch);
    this.noteWrite(file);
  }
}
