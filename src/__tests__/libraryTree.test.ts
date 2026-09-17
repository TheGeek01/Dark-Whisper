import type { LibraryDocument, LibraryTree } from '../shared/api';
import {
  buildTree,
  expandTo,
  folderChoices,
  folderCounts,
  parentFolder,
  pinQuickNotes,
  QUICK_NOTES_FOLDER,
  recentDocuments,
  visibleRows,
} from '../renderer/libraryTree';

const d = (file: string, title: string, created: string, mtimeMs = 0): LibraryDocument => ({
  file,
  folder: parentFolder(file),
  title,
  created,
  mtimeMs,
  readable: true,
});

const TREE: LibraryTree = {
  root: 'C:/vault',
  exists: true,
  folders: [
    { path: 'Clients', name: 'Clients', children: [{ path: 'Clients/Acme', name: 'Acme', children: [] }] },
    { path: 'Notes', name: 'Notes', children: [] },
  ],
  documents: [
    d('old.md', 'Old', '2026-09-01T10:00:00Z'),
    d('new.md', 'New', '2026-09-16T10:00:00Z'),
    d('nodate.md', 'No date', '', Date.parse('2026-09-10T00:00:00Z')),
    d('Clients/Acme/kickoff.md', 'Kickoff budget', '2026-09-12T09:00:00Z'),
    d('Notes/todo.md', 'Todo', '2026-09-11T09:00:00Z'),
  ],
};

describe('buildTree', () => {
  it('sorts documents newest first, using the file time when created is missing', () => {
    const root = buildTree(TREE, new Set());
    expect(root.documents.map((x) => x.file)).toEqual(['new.md', 'nodate.md', 'old.md']);
    expect(root.folders.map((f) => f.name)).toEqual(['Clients', 'Notes']);
    expect(root.expanded).toBe(true);
    expect(root.folders[0].expanded).toBe(false);
    expect(root.folders[0].folders[0].documents.map((x) => x.file)).toEqual(['Clients/Acme/kickoff.md']);
  });

  it('filters by title, keeping and expanding the folders that contain matches', () => {
    const root = buildTree(TREE, new Set(), 'BUDGET');
    expect(visibleRows(root)).toEqual([
      { kind: 'folder', path: '', depth: 0 },
      { kind: 'folder', path: 'Clients', depth: 1 },
      { kind: 'folder', path: 'Clients/Acme', depth: 2 },
      { kind: 'document', file: 'Clients/Acme/kickoff.md', depth: 3 },
    ]);
  });

  it('returns an empty root when nothing matches', () => {
    const root = buildTree(TREE, new Set(), 'zzz');
    expect(root.folders).toEqual([]);
    expect(root.documents).toEqual([]);
  });
});

describe('visibleRows', () => {
  it('lists only the rows of expanded folders', () => {
    expect(visibleRows(buildTree(TREE, new Set(['Clients'])))).toEqual([
      { kind: 'folder', path: '', depth: 0 },
      { kind: 'folder', path: 'Clients', depth: 1 },
      { kind: 'folder', path: 'Clients/Acme', depth: 2 },
      { kind: 'folder', path: 'Notes', depth: 1 },
      { kind: 'document', file: 'new.md', depth: 1 },
      { kind: 'document', file: 'nodate.md', depth: 1 },
      { kind: 'document', file: 'old.md', depth: 1 },
    ]);
  });
});

describe('folder helpers', () => {
  it('offers every folder as a move target', () => {
    expect(folderChoices(TREE)).toEqual([
      { value: '', label: 'Vault (root)' },
      { value: 'Clients', label: 'Clients' },
      { value: 'Clients/Acme', label: 'Clients/Acme' },
      { value: 'Notes', label: 'Notes' },
    ]);
  });

  it('expands every ancestor of a folder', () => {
    expect([...expandTo(new Set(['Notes']), 'Clients/Acme')].sort()).toEqual(['Clients', 'Clients/Acme', 'Notes']);
    expect(expandTo(new Set(), '').size).toBe(0);
  });

  it('finds the parent folder of a file', () => {
    expect(parentFolder('a.md')).toBe('');
    expect(parentFolder('Clients/Acme/k.md')).toBe('Clients/Acme');
  });
});

describe('sidebar helpers', () => {
  const doc = (file: string, mtimeMs: number) => ({
    file,
    folder: file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '',
    title: file,
    created: '',
    mtimeMs,
    readable: true,
  });
  const tree = {
    root: 'C:\\Vault',
    exists: true,
    folders: [
      { path: 'Work', name: 'Work', children: [{ path: 'Work/Acme', name: 'Acme', children: [] }] },
      { path: 'Archive', name: 'Archive', children: [] },
    ],
    documents: [doc('a.md', 5), doc('Work/b.md', 50), doc('Work/Acme/c.md', 20), doc('Work/Acme/d.md', 40), doc('Archive/e.md', 10), doc('Archive/f.md', 30)],
  };

  it('counts documents per folder including subfolders', () => {
    const counts = folderCounts(tree);
    expect(counts.get('')).toBe(6);
    expect(counts.get('Work')).toBe(3);
    expect(counts.get('Work/Acme')).toBe(2);
    expect(counts.get('Archive')).toBe(2);
    expect(counts.get('Nope')).toBeUndefined();
  });

  it('lists the most recently changed documents first', () => {
    expect(recentDocuments(tree).map((d) => d.file)).toEqual(['Work/b.md', 'Work/Acme/d.md', 'Archive/f.md', 'Work/Acme/c.md', 'Archive/e.md']);
    expect(recentDocuments(tree, 2).map((d) => d.file)).toEqual(['Work/b.md', 'Work/Acme/d.md']);
  });

  it('pins Quick Notes first, adding it when the folder does not exist yet', () => {
    const pinned = pinQuickNotes(buildTree(tree, new Set()));
    expect(pinned.folders.map((f) => f.path)).toEqual([QUICK_NOTES_FOLDER, 'Work', 'Archive']);
    expect(pinned.folders[0]).toEqual({ path: 'Quick Notes', name: 'Quick Notes', depth: 1, expanded: false, folders: [], documents: [] });

    const withQuick = {
      ...tree,
      folders: [...tree.folders, { path: 'Quick Notes', name: 'Quick Notes', children: [] }],
      documents: [...tree.documents, doc('Quick Notes/2026-09-16.md', 60)],
    };
    const again = pinQuickNotes(buildTree(withQuick, new Set(['Quick Notes'])));
    expect(again.folders.map((f) => f.path)).toEqual(['Quick Notes', 'Work', 'Archive']);
    expect(again.folders[0].documents.map((d) => d.file)).toEqual(['Quick Notes/2026-09-16.md']);
    expect(again.folders[0].expanded).toBe(true);
  });
});
