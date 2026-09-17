import { BlockRef, changedBlocks, DocumentStore, ReplaceOutcome } from './documentStore';
import type { SessionStoreLike } from './sessionService';

// Called with the indexes of the blocks whose text another program changed (possibly none,
// e.g. an edit to the frontmatter).
export type OutsideEditListener = (changedBlocks: number[]) => void;

// Wraps the document store for one document. Before every read or write it compares the file
// with what we last wrote (spec §5.3). An outside change becomes the new baseline, and every
// listener learns which blocks changed: closed blocks are protected by their own hash when
// refined, and each run marks the block it is still writing so it is never refined over the edit.
// Every run writing to the document shares this guard (spec §3.5, GuardRegistry).
// A file that cannot be read at the moment (a sync client holding it) is not an edit.
export class GuardedStore implements SessionStoreLike {
  private lastContent: string | null = null;
  private readonly listeners = new Set<OutsideEditListener>();

  constructor(private readonly store: DocumentStore) {}

  onOutsideEdit(listener: OutsideEditListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private checkForOutsideEdit(file: string): void {
    if (this.lastContent === null) return;
    const current = this.store.readContent(file);
    if (current === null || current === this.lastContent) return;
    const changed = changedBlocks(this.lastContent, current);
    this.lastContent = current;
    for (const listener of [...this.listeners]) listener(changed);
  }

  noteWrite(file: string): void {
    this.lastContent = this.store.readContent(file);
  }

  openBlock(file: string, block: BlockRef, heading?: string): void {
    this.checkForOutsideEdit(file);
    this.store.openBlock(file, block, heading);
    this.noteWrite(file);
  }

  setBlockRange(file: string, block: BlockRef): void {
    this.checkForOutsideEdit(file);
    this.store.setBlockRange(file, block);
    this.noteWrite(file);
  }

  appendSegment(file: string, text: string): void {
    this.checkForOutsideEdit(file);
    this.store.appendSegment(file, text);
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
