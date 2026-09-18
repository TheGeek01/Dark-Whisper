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
function readHead(file: string): string {
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const bytes = fs.readSync(handle, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytes).toString('utf8');
  } finally {
    fs.closeSync(handle);
  }
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

  tree(): LibraryTree {
    const exists = this.exists();
    const documents: LibraryDocument[] = [];
    const walk = (dir: string, rel: string): FolderNode[] => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      const folders: FolderNode[] = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue; // .obsidian, .trash, .git
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          folders.push({ path: childRel, name: entry.name, children: walk(full, childRel) });
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          documents.push(this.describe(full, childRel, rel));
        }
      }
      return folders.sort((a, b) => a.name.localeCompare(b.name));
    };
    const folders = exists ? walk(this.vaultPath, '') : [];
    return { root: this.vaultPath, exists, folders, documents };
  }

  private describe(full: string, file: string, folder: string): LibraryDocument {
    const fallbackTitle = path.basename(file, path.extname(file));
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {
      // Vanished between listing and stat-ing; the next change event reloads the tree.
    }
    try {
      const { frontmatter } = parseFrontmatter(readHead(full).replace(/\r\n/g, '\n'));
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

  search(query: string, limit = 200): LibrarySearchHit[] {
    const needle = query.trim().toLowerCase();
    if (needle === '') return [];
    const hits: LibrarySearchHit[] = [];
    for (const doc of this.tree().documents) {
      let content: string;
      try {
        content = fs.readFileSync(this.resolve(doc.file, 'document'), 'utf8');
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trimStart().startsWith('<!--') || !line.toLowerCase().includes(needle)) continue;
        hits.push({ file: doc.file, line: i + 1, text: line.trim() });
        if (hits.length >= limit) return hits;
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
