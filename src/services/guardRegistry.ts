import * as path from 'path';
import { DocumentStore } from './documentStore';
import { GuardedStore } from './guardedStore';

interface Entry {
  guard: GuardedStore;
  users: number;
}

// One guard per document, shared by every run that writes to it (spec §3.5): a quick note can
// start while an earlier run on the same day file is still refining, and neither may mistake the
// other's writes for an outside edit.
export class GuardRegistry {
  private readonly entries = new Map<string, Entry>();

  private static key(file: string): string {
    return path.resolve(file).toLowerCase();
  }

  // A new guard starts from the file as it is now.
  acquire(file: string, documents: DocumentStore): GuardedStore {
    const key = GuardRegistry.key(file);
    const existing = this.entries.get(key);
    if (existing) {
      existing.users++;
      return existing.guard;
    }
    const guard = new GuardedStore(documents);
    guard.noteWrite(file);
    this.entries.set(key, { guard, users: 1 });
    return guard;
  }

  release(file: string): void {
    const key = GuardRegistry.key(file);
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.users--;
    if (entry.users <= 0) this.entries.delete(key);
  }

  // The library renamed or moved a document. A rename rewrites the title in the frontmatter,
  // which is our own write, not an outside edit.
  moved(from: string, to: string): void {
    const fromKey = GuardRegistry.key(from);
    const entry = this.entries.get(fromKey);
    if (!entry) return;
    this.entries.delete(fromKey);
    this.entries.set(GuardRegistry.key(to), entry);
    entry.guard.noteWrite(to);
  }

  size(): number {
    return this.entries.size;
  }
}
