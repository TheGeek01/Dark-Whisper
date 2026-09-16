import type { FolderNode, LibraryTree } from '../shared/api';

// Collects file-system events and reports them once the vault has been quiet for delayMs.
export class ChangeBatcher {
  private readonly pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly delayMs: number,
    private readonly emit: (paths: string[]) => void,
  ) {}

  add(relativePath: string): void {
    this.pending.add(relativePath.split('\\').join('/'));
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.size === 0) return;
    const paths = [...this.pending].sort();
    this.pending.clear();
    this.emit(paths);
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }
}

// Polling fallback: compare what the vault looked like on two passes.
// Keys: '' for the vault itself, 'folder/' for folders, the relative path for documents.
export type Snapshot = Map<string, number>;

export function snapshotTree(tree: LibraryTree): Snapshot {
  const snapshot: Snapshot = new Map();
  if (tree.exists) snapshot.set('', 0);
  const addFolders = (nodes: FolderNode[]) => {
    for (const node of nodes) {
      snapshot.set(`${node.path}/`, 0);
      addFolders(node.children);
    }
  };
  addFolders(tree.folders);
  for (const doc of tree.documents) snapshot.set(doc.file, doc.mtimeMs);
  return snapshot;
}

// True when any '/'- or '\'-separated segment starts with '.' (e.g. .obsidian, .trash, .git).
export function isHiddenPath(relative: string): boolean {
  return relative.split(/[\\/]/).some((segment) => segment.startsWith('.'));
}

export function diffSnapshots(before: Snapshot, after: Snapshot): string[] {
  const changed = new Set<string>();
  for (const [key, value] of after) {
    if (before.get(key) !== value) changed.add(key);
  }
  for (const key of before.keys()) {
    if (!after.has(key)) changed.add(key);
  }
  return [...changed].map((key) => (key.endsWith('/') ? key.slice(0, -1) : key)).sort();
}
