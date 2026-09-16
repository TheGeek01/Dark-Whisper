import type { LibraryDocument, LibraryTree } from '../shared/api';
import { ChangeBatcher, diffSnapshots, isHiddenPath, snapshotTree } from '../services/libraryWatch';

describe('ChangeBatcher', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('emits once, after the last change, with unique sorted forward-slash paths', () => {
    const emitted: string[][] = [];
    const batcher = new ChangeBatcher(300, (paths) => emitted.push(paths));
    batcher.add('b.md');
    jest.advanceTimersByTime(200);
    batcher.add('Work\\a.md');
    batcher.add('b.md');
    jest.advanceTimersByTime(299);
    expect(emitted).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(emitted).toEqual([['Work/a.md', 'b.md']]);
  });

  it('drops pending changes on cancel', () => {
    const emitted: string[][] = [];
    const batcher = new ChangeBatcher(300, (paths) => emitted.push(paths));
    batcher.add('a.md');
    batcher.cancel();
    jest.advanceTimersByTime(1000);
    expect(emitted).toEqual([]);
  });
});

const d = (file: string, mtimeMs: number): LibraryDocument => ({
  file,
  folder: '',
  title: file,
  created: '',
  mtimeMs,
  readable: true,
});

const tree = (overrides: Partial<LibraryTree>): LibraryTree => ({
  root: 'v',
  exists: true,
  folders: [],
  documents: [],
  ...overrides,
});

describe('diffSnapshots', () => {
  it('reports added, removed and modified documents and folders', () => {
    const before = snapshotTree(
      tree({
        folders: [{ path: 'Work', name: 'Work', children: [{ path: 'Work/Old', name: 'Old', children: [] }] }],
        documents: [d('a.md', 1), d('b.md', 1)],
      }),
    );
    const after = snapshotTree(
      tree({
        folders: [{ path: 'Home', name: 'Home', children: [] }],
        documents: [d('a.md', 2), d('c.md', 1)],
      }),
    );
    expect(diffSnapshots(before, after)).toEqual(['Home', 'Work', 'Work/Old', 'a.md', 'b.md', 'c.md']);
  });

  it('is empty when nothing changed', () => {
    const snapshot = snapshotTree(tree({ documents: [d('a.md', 1)] }));
    expect(diffSnapshots(snapshot, snapshotTree(tree({ documents: [d('a.md', 1)] })))).toEqual([]);
  });

  it('reports the vault appearing', () => {
    const before = snapshotTree(tree({ exists: false }));
    expect(diffSnapshots(before, snapshotTree(tree({})))).toEqual(['']);
  });
});

describe('isHiddenPath', () => {
  it.each([
    ['.obsidian/workspace.json', true],
    ['Work/.trash/a.md', true],
    ['Work/a.md', false],
    ['', false],
    ['a\\.git\\x', true],
  ])('%j -> %p', (relative, expected) => {
    expect(isHiddenPath(relative)).toBe(expected);
  });
});
