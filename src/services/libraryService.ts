import * as fs from 'fs';
import * as path from 'path';
import type { DocumentContent, FolderNode, LibraryDocument, LibrarySearchHit, LibraryTree } from '../shared/api';
import { DocumentStore, isSameFile, parseFrontmatter, slugify } from './documentStore';
import { isHiddenPath } from './libraryWatch';

export class LibraryPathError extends Error {}

const FORBIDDEN_NAME = /[\\/:*?"<>|]/;
// Session documents are named <YYYY-MM-DD-HHmm>-<slug>.md; renaming keeps that prefix.
const SESSION_NAME = /^\d{4}-\d{2}-\d{2}-\d{4}/;
const HEAD_BYTES = 4096;

export function toRelative(vaultPath: string, absolute: string): string {
  return path.relative(vaultPath, absolute).split(path.sep).join('/');
}

export function sanitizeFolderName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '' || trimmed === '.' || trimmed === '..' || FORBIDDEN_NAME.test(trimmed)) {
    throw new LibraryPathError(`"${name}" is not a valid folder name`);
  }
  return trimmed;
}

// Frontmatter sits at the top of the file, so the library never reads whole documents to list them.
async function readHead(file: string): Promise<string> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

// Scans run in Electron's main process, so they use async I/O (the tray, shortcuts and recording
// keep running) and open at most this many files at once, however large the vault.
const READ_CONCURRENCY = 16;

async function mapLimited<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, worker));
  return results;
}

export class LibraryService {
  private readonly store: DocumentStore;

  constructor(readonly vaultPath: string) {
    this.store = new DocumentStore(vaultPath);
  }

  exists(): boolean {
    try {
      return fs.statSync(this.vaultPath).isDirectory();
    } catch {
      return false;
    }
  }

  // Every path the renderer supplies goes through here: relative, inside the vault,
  // and a Markdown file when it names a document.
  resolve(relative: string, kind: 'document' | 'folder'): string {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) {
      throw new LibraryPathError(`Not a vault path: ${String(relative)}`);
    }
    if (isHiddenPath(relative)) {
      throw new LibraryPathError(`Hidden path: ${relative}`);
    }
    if (relative.includes(':')) {
      throw new LibraryPathError(`Not a vault path: ${relative}`);
    }
    const absolute = path.resolve(this.vaultPath, relative);
    const back = path.relative(this.vaultPath, absolute);
    if (back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
      throw new LibraryPathError(`Outside the vault: ${relative}`);
    }
    if (kind === 'document' && (back === '' || !back.toLowerCase().endsWith('.md'))) {
      throw new LibraryPathError(`Not a Markdown document: ${relative}`);
    }
    return absolute;
  }

  relative(absolute: string): string {
    return toRelative(this.vaultPath, absolute);
  }

  async tree(): Promise<LibraryTree> {
    const exists = await this.existsAsync();
    type DocRef = { full: string; file: string; folder: string };
    // Documents keep readdir order, with a folder's documents where the folder appears.
    const walk = async (dir: string, rel: string): Promise<{ folders: FolderNode[]; docs: DocRef[] }> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return { folders: [], docs: [] };
      }
      const parts = await Promise.all(
        entries.map(async (entry) => {
          if (entry.name.startsWith('.')) return null; // .obsidian, .trash, .git
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const child = await walk(full, childRel);
            return { folder: { path: childRel, name: entry.name, children: child.folders }, docs: child.docs };
          }
          if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
            return { folder: null, docs: [{ full, file: childRel, folder: rel }] };
          }
          return null;
        }),
      );
      const folders: FolderNode[] = [];
      const docs: DocRef[] = [];
      for (const part of parts) {
        if (!part) continue;
        if (part.folder) folders.push(part.folder);
        docs.push(...part.docs);
      }
      return { folders: folders.sort((a, b) => a.name.localeCompare(b.name)), docs };
    };
    const { folders, docs } = exists ? await walk(this.vaultPath, '') : { folders: [], docs: [] };
    const documents = await mapLimited(docs, (d) => this.describe(d.full, d.file, d.folder));
    return { root: this.vaultPath, exists, folders, documents };
  }

  private async existsAsync(): Promise<boolean> {
    try {
      return (await fs.promises.stat(this.vaultPath)).isDirectory();
    } catch {
      return false;
    }
  }

  private async describe(full: string, file: string, folder: string): Promise<LibraryDocument> {
    const fallbackTitle = path.basename(file, path.extname(file));
    let mtimeMs = 0;
    try {
      mtimeMs = (await fs.promises.stat(full)).mtimeMs;
    } catch {
      // Vanished between listing and stat-ing; the next change event reloads the tree.
    }
    try {
      const { frontmatter } = parseFrontmatter((await readHead(full)).replace(/\r\n/g, '\n'));
      return {
        file,
        folder,
        title: frontmatter.title || fallbackTitle,
        created: frontmatter.created ?? '',
        mtimeMs,
        readable: true,
      };
    } catch {
      return { file, folder, title: fallbackTitle, created: '', mtimeMs, readable: false };
    }
  }

  async search(query: string, limit = 200): Promise<LibrarySearchHit[]> {
    const needle = query.trim().toLowerCase();
    if (needle === '') return [];
    const hits: LibrarySearchHit[] = [];
    const { documents } = await this.tree();
    // Read a batch at a time, but match in document order so the cap keeps the same hits.
    for (let start = 0; start < documents.length; start += READ_CONCURRENCY) {
      const batch = documents.slice(start, start + READ_CONCURRENCY);
      const contents = await mapLimited(batch, (doc) =>
        fs.promises.readFile(this.resolve(doc.file, 'document'), 'utf8').catch(() => null),
      );
      for (const [n, content] of contents.entries()) {
        if (content === null) continue;
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.trimStart().startsWith('<!--') || !line.toLowerCase().includes(needle)) continue;
          hits.push({ file: batch[n].file, line: i + 1, text: line.trim() });
          if (hits.length >= limit) return hits;
        }
      }
    }
    return hits;
  }

  read(file: string): DocumentContent {
    const full = this.resolve(file, 'document');
    const content = fs.readFileSync(full, 'utf8');
    return { file, content, mtimeMs: fs.statSync(full).mtimeMs };
  }

  rename(file: string, title: string): string {
    const full = this.resolve(file, 'document');
    const clean = title.trim();
    if (clean === '') throw new LibraryPathError('A title is required');
    if (SESSION_NAME.test(path.basename(full))) {
      return this.relative(this.store.renameDocument(full, clean));
    }
    // Other notes (e.g. written in Obsidian) are renamed without touching their content.
    const target = this.freePath(path.dirname(full), slugify(clean), full);
    if (target !== full) fs.renameSync(full, target);
    return this.relative(target);
  }

  move(file: string, folder: string): string {
    const full = this.resolve(file, 'document');
    const dir = this.resolve(folder, 'folder');
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new LibraryPathError(`No such folder: ${folder}`);
    }
    if (path.dirname(full) === dir) return this.relative(full);
    const target = this.freePath(dir, path.basename(full, path.extname(full)));
    fs.renameSync(full, target);
    return this.relative(target);
  }

  createFolder(parent: string, name: string): string {
    const parentDir = this.resolve(parent, 'folder');
    if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) {
      throw new LibraryPathError(`No such folder: ${parent}`);
    }
    const clean = sanitizeFolderName(name);
    const target = path.join(parentDir, clean);
    if (fs.existsSync(target)) throw new LibraryPathError(`"${clean}" already exists`);
    fs.mkdirSync(target);
    return this.relative(target);
  }

  private freePath(dir: string, stem: string, current?: string): string {
    let candidate = path.join(dir, `${stem}.md`);
    for (let n = 2; fs.existsSync(candidate) && !(current && isSameFile(candidate, current)); n++) {
      candidate = path.join(dir, `${stem}-${n}.md`);
    }
    return candidate;
  }
}
