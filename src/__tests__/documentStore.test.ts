import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DocumentStore, Frontmatter, blockMarker, blockTextFrom, changedBlocks, hashText, parseFrontmatter, slugify } from '../services/documentStore';

const FM: Frontmatter = {
  title: 'untitled',
  created: '2026-09-15T14:32:04Z',
  updated: '2026-09-15T14:32:04Z',
  duration: 0,
  language: 'en',
  liveModel: 'ggml-base.en.bin',
  refineModel: 'ggml-large-v3-turbo-q5_0.bin',
  app: 'dark-whisper 1.2.0',
};

describe('documentStore helpers', () => {
  it('formats block markers exactly as the spec requires', () => {
    expect(blockMarker({ index: 3, startSec: 240, endSec: 360 })).toBe('<!-- dw:block 3 t=240-360 -->');
  });

  it('round-trips frontmatter', () => {
    const parsed = parseFrontmatter('---\ntitle: hello\nduration: 12\n---\n\nbody text\n');
    expect(parsed.frontmatter).toEqual({ title: 'hello', duration: '12' });
    expect(parsed.body.trim()).toBe('body text');
  });

  it('treats a file without frontmatter as all body', () => {
    expect(parseFrontmatter('just text').frontmatter).toEqual({});
    expect(parseFrontmatter('just text').body).toBe('just text');
  });

  it('slugifies titles for filenames', () => {
    expect(slugify('Board meeting: Q3 results!')).toBe('board-meeting-q3-results');
    expect(slugify('   ')).toBe('untitled');
  });
});

describe('DocumentStore', () => {
  let vault: string;
  let store: DocumentStore;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-vault-'));
    store = new DocumentStore(vault);
  });

  afterEach(() => fs.rmSync(vault, { recursive: true, force: true }));

  it('creates a document with frontmatter', () => {
    const file = store.createDocument('2026-09-15-1432', FM);
    expect(file).toBe(path.join(vault, '2026-09-15-1432-untitled.md'));
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('title: untitled');
    expect(content).toContain('liveModel: ggml-base.en.bin');
  });

  it('appends segments and blocks in order', () => {
    const file = store.createDocument('s1', FM);
    store.openBlock(file, { index: 1, startSec: 0, endSec: 120 });
    store.appendSegment(file, 'hello world');
    store.appendSegment(file, 'second segment');
    store.openBlock(file, { index: 2, startSec: 120, endSec: 240 });
    store.appendSegment(file, 'third segment');

    expect(store.readBlockText(file, 1)).toBe('hello world second segment');
    expect(store.readBlockText(file, 2)).toBe('third segment');
    expect(store.readBlockText(file, 3)).toBeNull();
  });

  it('writes an optional timestamp heading', () => {
    const file = store.createDocument('s1', FM);
    store.openBlock(file, { index: 2, startSec: 120, endSec: 240 }, '## 00:02:00');
    expect(fs.readFileSync(file, 'utf8')).toContain('## 00:02:00');
  });

  it('replaces a block when the text is untouched', () => {
    const file = store.createDocument('s1', FM);
    store.openBlock(file, { index: 1, startSec: 0, endSec: 120 });
    store.appendSegment(file, 'rough live text');
    const hash = hashText(store.readBlockText(file, 1)!);

    expect(store.replaceBlock(file, 1, 'Polished refined text.', hash)).toBe('replaced');
    expect(store.readBlockText(file, 1)).toBe('Polished refined text.');
  });

  it('refuses to replace a block the user edited', () => {
    const file = store.createDocument('s1', FM);
    store.openBlock(file, { index: 1, startSec: 0, endSec: 120 });
    store.appendSegment(file, 'rough live text');
    const staleHash = hashText('something else entirely');

    expect(store.replaceBlock(file, 1, 'Polished.', staleHash)).toBe('skipped-edited');
    expect(store.readBlockText(file, 1)).toBe('rough live text');
  });

  it('reports a missing block', () => {
    const file = store.createDocument('s1', FM);
    expect(store.replaceBlock(file, 7, 'x', hashText(''))).toBe('missing');
  });

  it('keeps later blocks intact when replacing an earlier one', () => {
    const file = store.createDocument('s1', FM);
    store.openBlock(file, { index: 1, startSec: 0, endSec: 120 });
    store.appendSegment(file, 'block one');
    store.openBlock(file, { index: 2, startSec: 120, endSec: 240 });
    store.appendSegment(file, 'block two');

    store.replaceBlock(file, 1, 'BLOCK ONE REFINED', hashText('block one'));
    expect(store.readBlockText(file, 1)).toBe('BLOCK ONE REFINED');
    expect(store.readBlockText(file, 2)).toBe('block two');
  });

  it('updates frontmatter without touching the body', () => {
    const file = store.createDocument('s1', FM);
    store.openBlock(file, { index: 1, startSec: 0, endSec: 120 });
    store.appendSegment(file, 'body stays');
    store.updateFrontmatter(file, { duration: 97, title: 'Board meeting' });

    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('duration: 97');
    expect(content).toContain('title: Board meeting');
    expect(store.readBlockText(file, 1)).toBe('body stays');
  });

  it('lists documents including subfolders', () => {
    fs.mkdirSync(path.join(vault, 'projects'));
    const a = store.createDocument('s1', FM);
    fs.writeFileSync(path.join(vault, 'projects', 'nested.md'), '---\ntitle: nested\ncreated: 2026-01-01T00:00:00Z\n---\n\ntext\n');

    const titles = store.listDocuments().map((d) => d.title).sort();
    expect(titles).toEqual(['nested', 'untitled']);
    expect(store.listDocuments().some((d) => d.file === a)).toBe(true);
  });

  it('searches document contents case-insensitively', () => {
    const file = store.createDocument('s1', FM);
    store.openBlock(file, { index: 1, startSec: 0, endSec: 120 });
    store.appendSegment(file, 'The Quarterly Review went well');

    const hits = store.search('quarterly');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file, text: expect.stringContaining('Quarterly Review') });
    expect(store.search('nothing here')).toEqual([]);
  });

  // `import * as fs from 'fs'` compiles (esModuleInterop + module:node20 in this
  // repo's tsconfig) to a namespace object whose members are non-configurable
  // getter bindings, so `jest.spyOn(fs, 'readFileSync')` throws
  // "Cannot redefine property: readFileSync" here. The plain CommonJS module
  // object returned by `require('fs')` is the real, mutable target those
  // getters read from live, and it stays a normal writable/configurable data
  // property under Jest on both Windows and Linux, so patching it directly
  // (and restoring it afterwards) is what actually intercepts the read from
  // inside documentStore.ts without touching the filesystem's real permissions.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const rawFs = require('fs') as any;

  function makeUnreadable(target: string): () => void {
    const original = rawFs.readFileSync;
    rawFs.readFileSync = (file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (file === target) {
        throw new Error(`EPERM: operation not permitted, open '${target}'`);
      }
      return original(file, ...rest);
    };
    return () => {
      rawFs.readFileSync = original;
    };
  }

  it('omits an unreadable file from listDocuments but keeps the good ones', () => {
    const good = store.createDocument('s1', FM);
    const bad = path.join(vault, 'bad.md');
    fs.writeFileSync(bad, '---\ntitle: bad\n---\n\ntext\n');

    const restore = makeUnreadable(bad);
    try {
      const docs = store.listDocuments();
      expect(docs.some((d) => d.file === good)).toBe(true);
      expect(docs.some((d) => d.file === bad)).toBe(false);
    } finally {
      restore();
    }
  });

  it('skips an unreadable file during search but still finds hits elsewhere', () => {
    const good = store.createDocument('s1', FM);
    store.openBlock(good, { index: 1, startSec: 0, endSec: 120 });
    store.appendSegment(good, 'The Quarterly Review went well');
    const bad = path.join(vault, 'bad.md');
    fs.writeFileSync(bad, '---\ntitle: bad\n---\n\nquarterly numbers too\n');

    const restore = makeUnreadable(bad);
    try {
      const hits = store.search('quarterly');
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ file: good, text: expect.stringContaining('Quarterly Review') });
    } finally {
      restore();
    }
  });

  it('renames a document and its file', () => {
    const file = store.createDocument('2026-09-15-1432', FM);
    const renamed = store.renameDocument(file, 'Board meeting');
    expect(path.basename(renamed)).toBe('2026-09-15-1432-board-meeting.md');
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(renamed, 'utf8')).toContain('title: Board meeting');
  });

  it('avoids clobbering an existing filename on rename', () => {
    const first = store.createDocument('2026-09-15-1432', FM);
    fs.writeFileSync(path.join(vault, '2026-09-15-1432-notes.md'), 'x');
    expect(path.basename(store.renameDocument(first, 'notes'))).toBe('2026-09-15-1432-notes-2.md');
  });

  it('deletes a document', () => {
    const file = store.createDocument('s1', FM);
    store.deleteDocument(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('hashes the whole file so outside edits can be detected', () => {
    const file = store.createDocument('s1', FM);
    const before = store.fileHash(file);
    expect(store.fileHash(file)).toBe(before);

    store.appendSegment(file, 'our own write');
    const afterOurs = store.fileHash(file);
    expect(afterOurs).not.toBe(before);

    fs.appendFileSync(file, 'someone edited this in Obsidian\n');
    expect(store.fileHash(file)).not.toBe(afterOurs);
  });
});

describe('DocumentStore.createDocument folders', () => {
  it('creates a document inside a vault folder', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-store-folder-'));
    const file = new DocumentStore(vault).createDocument('2026-09-16-0706', FM, 'Clients/Acme');
    expect(file).toBe(path.join(vault, 'Clients', 'Acme', '2026-09-16-0706-untitled.md'));
    expect(fs.readFileSync(file, 'utf8')).toContain('title: untitled');
  });
});

describe('block text helpers', () => {
  const DOC = [
    '---',
    'title: t',
    '---',
    '',
    '<!-- dw:block 1 t=0-120 -->',
    '## 00:00:00',
    'first block',
    '',
    '<!-- dw:block 2 t=120-240 -->',
    'second block',
    '',
  ].join('\n');

  it('extracts one block without its heading', () => {
    expect(blockTextFrom(DOC, 1)).toBe('first block');
    expect(blockTextFrom(DOC, 2)).toBe('second block');
    expect(blockTextFrom(DOC, 3)).toBeNull();
  });

  it('matches what DocumentStore.readBlockText returns', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-block-text-'));
    const file = path.join(vault, 'doc.md');
    fs.writeFileSync(file, DOC);
    const store = new DocumentStore(vault);
    expect(store.readBlockText(file, 1)).toBe(blockTextFrom(DOC, 1));
    expect(store.readBlockText(file, 2)).toBe(blockTextFrom(DOC, 2));
  });

  it('lists the blocks whose text changed, including removed and added blocks', () => {
    const edited = DOC.replace('second block', 'second block, edited').replace('first block', 'first block');
    expect(changedBlocks(DOC, edited)).toEqual([2]);
    expect(changedBlocks(DOC, DOC + 'more text for block two\n')).toEqual([2]);
    expect(changedBlocks(DOC, DOC.replace('<!-- dw:block 2 t=120-240 -->\n', ''))).toEqual([1, 2]);
    expect(changedBlocks(DOC, DOC.replace('title: t', 'title: renamed'))).toEqual([]);
    expect(changedBlocks(DOC, `${DOC}\n<!-- dw:block 3 t=240-360 -->\nthird\n`)).toEqual([3]);
  });
});
