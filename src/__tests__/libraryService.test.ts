import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LibraryPathError, LibraryService, sanitizeFolderName } from '../services/libraryService';

function vault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-lib-'));
  const write = (rel: string, content: string) => {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  return { root, write, service: new LibraryService(root) };
}

const doc = (title: string, created: string) => `---\ntitle: ${title}\ncreated: ${created}\n---\n\nbody\n`;

describe('LibraryService.tree', () => {
  it('lists folders and markdown documents relative to the vault', async () => {
    const v = vault();
    v.write('2026-09-16-0706-untitled.md', doc('untitled', '2026-09-16T07:06:00Z'));
    v.write('Clients/Acme/kickoff.md', doc('Kickoff', '2026-09-10T09:00:00Z'));
    v.write('Clients/notes.txt', 'not markdown');
    v.write('.obsidian/workspace.md', 'hidden');
    fs.mkdirSync(path.join(v.root, 'Empty'));

    const tree = await v.service.tree();
    expect(tree.exists).toBe(true);
    expect(tree.root).toBe(v.root);
    expect(tree.folders).toEqual([
      { path: 'Clients', name: 'Clients', children: [{ path: 'Clients/Acme', name: 'Acme', children: [] }] },
      { path: 'Empty', name: 'Empty', children: [] },
    ]);
    expect(tree.documents.map((d) => [d.file, d.folder, d.title, d.created, d.readable]).sort()).toEqual([
      ['2026-09-16-0706-untitled.md', '', 'untitled', '2026-09-16T07:06:00Z', true],
      ['Clients/Acme/kickoff.md', 'Clients/Acme', 'Kickoff', '2026-09-10T09:00:00Z', true],
    ]);
    expect(tree.documents.every((d) => d.mtimeMs > 0)).toBe(true);
  });

  it('falls back to the file name and reads Windows line endings', async () => {
    const v = vault();
    v.write('plain.md', 'just text');
    v.write('crlf.md', '---\r\ntitle: Windows\r\ncreated: 2026-01-01T00:00:00Z\r\n---\r\n\r\nbody');
    const byFile = new Map((await v.service.tree()).documents.map((d) => [d.file, d]));
    expect(byFile.get('plain.md')).toMatchObject({ title: 'plain', created: '' });
    expect(byFile.get('crlf.md')).toMatchObject({ title: 'Windows', created: '2026-01-01T00:00:00Z' });
  });

  it('reports a missing vault', async () => {
    const missing = path.join(os.tmpdir(), `dw-missing-${Date.now()}`);
    expect(await new LibraryService(missing).tree()).toEqual({ root: missing, exists: false, folders: [], documents: [] });
  });

  // The scan runs in Electron's main process, so a large or slow (synced, network) vault must not
  // stop the tray, shortcuts and recording while it is read.
  it('lets other work run while the vault is scanned', async () => {
    const v = vault();
    for (let i = 0; i < 40; i++) v.write(`Notes/n${i}.md`, doc(`n${i}`, 'x'));
    let ticks = 0;
    let scanning = true;
    const tick = () => {
      ticks++;
      if (scanning) setImmediate(tick);
    };
    setImmediate(tick);
    const pending = v.service.tree();
    const scan = await pending;
    scanning = false;
    expect(scan.documents).toHaveLength(40);
    expect(ticks).toBeGreaterThan(0);
    const hits = v.service.search('title');
    ticks = 0;
    scanning = true;
    setImmediate(tick);
    expect(await hits).toHaveLength(40);
    scanning = false;
    expect(ticks).toBeGreaterThan(0);
  });
});

describe('LibraryService.resolve', () => {
  it('accepts documents and folders inside the vault', () => {
    const v = vault();
    expect(v.service.resolve('Clients/a.md', 'document')).toBe(path.join(v.root, 'Clients', 'a.md'));
    expect(v.service.resolve('', 'folder')).toBe(path.resolve(v.root));
    expect(v.service.resolve('Clients', 'folder')).toBe(path.join(v.root, 'Clients'));
  });

  it.each(['../x.md', 'Clients/../../x.md', '/etc/passwd.md', 'C:/Windows/x.md', 'C:x.md'])('rejects %s', (p) => {
    expect(() => vault().service.resolve(p, 'document')).toThrow(LibraryPathError);
  });

  it('rejects non-markdown documents and the vault itself as a document', () => {
    const v = vault();
    expect(() => v.service.resolve('a.txt', 'document')).toThrow(LibraryPathError);
    expect(() => v.service.resolve('', 'document')).toThrow(LibraryPathError);
    expect(() => v.service.resolve('../elsewhere', 'folder')).toThrow(LibraryPathError);
  });

  it('rejects hidden segments and paths containing a colon, but accepts ordinary paths', () => {
    const v = vault();
    expect(() => v.service.resolve('.obsidian/x.md', 'document')).toThrow(LibraryPathError);
    expect(() => v.service.resolve('a.txt:x.md', 'document')).toThrow(LibraryPathError);
    expect(() => v.service.resolve('Work/.trash/a.md', 'document')).toThrow(LibraryPathError);
    expect(v.service.resolve('Clients/a.md', 'document')).toBe(path.join(v.root, 'Clients', 'a.md'));
  });

  it('rejects a relative path that escapes the vault on Windows', () => {
    if (process.platform !== 'win32') return;
    expect(() => vault().service.resolve('..\\x.md', 'document')).toThrow(LibraryPathError);
  });
});

describe('LibraryService changes', () => {
  it('renames a session document and updates its title', () => {
    const v = vault();
    v.write('2026-09-16-0706-untitled.md', doc('untitled', 'x'));
    const next = v.service.rename('2026-09-16-0706-untitled.md', 'Team sync');
    expect(next).toBe('2026-09-16-0706-team-sync.md');
    expect(fs.readFileSync(path.join(v.root, next), 'utf8')).toContain('title: Team sync');
  });

  it('renames any other note without touching its content', () => {
    const v = vault();
    v.write('ideas.md', 'plain');
    expect(v.service.rename('ideas.md', 'Big Ideas')).toBe('big-ideas.md');
    expect(fs.readFileSync(path.join(v.root, 'big-ideas.md'), 'utf8')).toBe('plain');
    expect(() => v.service.rename('big-ideas.md', '   ')).toThrow(LibraryPathError);
  });

  it('renames a note whose name differs only in letter case without a suffix', () => {
    const v = vault();
    v.write('Ideas.md', 'plain');
    expect(v.service.rename('Ideas.md', 'Ideas')).toBe('ideas.md');
    expect(fs.readdirSync(v.root)).toEqual(['ideas.md']);
    v.write('other.md', 'other');
    expect(v.service.rename('other.md', 'IDEAS')).toBe('ideas-2.md');
  });

  it('moves a document into a folder, suffixing on a clash, and back to the root', () => {
    const v = vault();
    v.write('a.md', '1');
    v.write('Work/a.md', '2');
    expect(v.service.move('a.md', 'Work')).toBe('Work/a-2.md');
    expect(fs.existsSync(path.join(v.root, 'a.md'))).toBe(false);
    expect(v.service.move('Work/a-2.md', '')).toBe('a-2.md');
    expect(v.service.move('a-2.md', '')).toBe('a-2.md');
  });

  it('refuses to move into a missing folder', () => {
    const v = vault();
    v.write('a.md', '1');
    expect(() => v.service.move('a.md', 'Nowhere')).toThrow(LibraryPathError);
  });

  it('creates folders with sanitised names', () => {
    const v = vault();
    expect(v.service.createFolder('', '  Clients ')).toBe('Clients');
    expect(v.service.createFolder('Clients', 'Acme')).toBe('Clients/Acme');
    expect(fs.statSync(path.join(v.root, 'Clients', 'Acme')).isDirectory()).toBe(true);
    expect(() => v.service.createFolder('', 'Clients')).toThrow('already exists');
    expect(() => v.service.createFolder('Missing', 'x')).toThrow(LibraryPathError);
  });

  it.each(['', '  ', '.', '..', 'a/b', 'a\\b', 'what?', 'x:y'])('rejects folder name %j', (name) => {
    expect(() => sanitizeFolderName(name)).toThrow(LibraryPathError);
  });
});

describe('LibraryService.search and read', () => {
  it('finds lines across documents, skipping markers and hidden folders', async () => {
    const v = vault();
    v.write('a.md', '---\ntitle: a\n---\n\n<!-- dw:block 1 t=0-120 budget -->\nThe quarterly budget\n');
    v.write('Work/b.md', 'Budget review\r\nnothing\r\n');
    v.write('.trash/c.md', 'budget');
    const hits = await v.service.search('BUDGET');
    expect(hits).toHaveLength(2);
    expect(hits).toEqual(
      expect.arrayContaining([
        { file: 'a.md', line: 6, text: 'The quarterly budget' },
        { file: 'Work/b.md', line: 1, text: 'Budget review' },
      ]),
    );
  });

  it('returns nothing for a blank query and caps the results', async () => {
    const v = vault();
    v.write('many.md', Array.from({ length: 300 }, () => 'x').join('\n'));
    expect(await v.service.search('   ')).toEqual([]);
    expect(await v.service.search('x')).toHaveLength(200);
  });

  it('reads a document with its modification time', () => {
    const v = vault();
    v.write('a.md', 'hello');
    const content = v.service.read('a.md');
    expect(content.file).toBe('a.md');
    expect(content.content).toBe('hello');
    expect(content.mtimeMs).toBeGreaterThan(0);
    expect(() => v.service.read('../a.md')).toThrow(LibraryPathError);
  });
});
