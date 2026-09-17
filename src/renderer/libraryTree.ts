import type { FolderNode, LibraryDocument, LibraryTree } from '../shared/api.js';

export interface FolderView {
  path: string;
  name: string;
  depth: number;
  expanded: boolean;
  folders: FolderView[];
  documents: LibraryDocument[];
}

export type VisibleRow =
  | { kind: 'folder'; path: string; depth: number }
  | { kind: 'document'; file: string; depth: number };

export function documentTime(doc: LibraryDocument): number {
  const created = Date.parse(doc.created);
  return Number.isNaN(created) ? doc.mtimeMs : created;
}

export function sortDocuments(documents: readonly LibraryDocument[]): LibraryDocument[] {
  return [...documents].sort((a, b) => documentTime(b) - documentTime(a) || a.file.localeCompare(b.file));
}

// The root is always expanded. While a title filter is active, only folders holding a match
// are kept, and they are all expanded.
export function buildTree(tree: LibraryTree, expanded: ReadonlySet<string>, titleFilter = ''): FolderView {
  const needle = titleFilter.trim().toLowerCase();
  const byFolder = new Map<string, LibraryDocument[]>();
  for (const doc of tree.documents) {
    if (needle !== '' && !doc.title.toLowerCase().includes(needle) && !doc.file.toLowerCase().includes(needle)) {
      continue;
    }
    const list = byFolder.get(doc.folder) ?? [];
    list.push(doc);
    byFolder.set(doc.folder, list);
  }

  const build = (node: FolderNode, depth: number): FolderView | null => {
    const folders = node.children
      .map((child) => build(child, depth + 1))
      .filter((folder): folder is FolderView => folder !== null);
    const documents = sortDocuments(byFolder.get(node.path) ?? []);
    if (depth > 0 && needle !== '' && folders.length === 0 && documents.length === 0) return null;
    return {
      path: node.path,
      name: node.name,
      depth,
      expanded: depth === 0 || needle !== '' || expanded.has(node.path),
      folders,
      documents,
    };
  };

  return build({ path: '', name: 'Vault', children: tree.folders }, 0) as FolderView;
}

export function visibleRows(root: FolderView): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const walk = (folder: FolderView) => {
    rows.push({ kind: 'folder', path: folder.path, depth: folder.depth });
    if (!folder.expanded) return;
    for (const child of folder.folders) walk(child);
    for (const doc of folder.documents) rows.push({ kind: 'document', file: doc.file, depth: folder.depth + 1 });
  };
  walk(root);
  return rows;
}

export function folderChoices(tree: LibraryTree): { value: string; label: string }[] {
  const choices = [{ value: '', label: 'Vault (root)' }];
  const walk = (nodes: FolderNode[]) => {
    for (const node of nodes) {
      choices.push({ value: node.path, label: node.path });
      walk(node.children);
    }
  };
  walk(tree.folders);
  return choices;
}

export function parentFolder(file: string): string {
  const slash = file.lastIndexOf('/');
  return slash === -1 ? '' : file.slice(0, slash);
}

export function expandTo(expanded: ReadonlySet<string>, folder: string): Set<string> {
  const next = new Set(expanded);
  const parts = folder.split('/').filter((part) => part !== '');
  for (let i = 1; i <= parts.length; i++) next.add(parts.slice(0, i).join('/'));
  return next;
}

export const QUICK_NOTES_FOLDER = 'Quick Notes';

// Documents per folder, counting subfolders; '' holds the whole vault.
export function folderCounts(tree: LibraryTree): Map<string, number> {
  const counts = new Map<string, number>();
  for (const doc of tree.documents) {
    const parts = doc.folder === '' ? [] : doc.folder.split('/');
    for (let i = 0; i <= parts.length; i++) {
      const key = parts.slice(0, i).join('/');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

export function recentDocuments(tree: LibraryTree, limit = 5): LibraryDocument[] {
  return [...tree.documents].sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file)).slice(0, limit);
}

// Quick Notes is always the first folder under the vault, even before it exists (spec §4.2).
export function pinQuickNotes(root: FolderView): FolderView {
  const existing = root.folders.find((folder) => folder.path === QUICK_NOTES_FOLDER);
  const quick: FolderView = existing ?? {
    path: QUICK_NOTES_FOLDER,
    name: QUICK_NOTES_FOLDER,
    depth: 1,
    expanded: false,
    folders: [],
    documents: [],
  };
  return { ...root, folders: [quick, ...root.folders.filter((folder) => folder !== existing)] };
}
