import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface Frontmatter {
  title: string;
  created: string;
  updated: string;
  duration: number;
  language: string;
  liveModel: string;
  refineModel: string;
  app: string;
}

export interface BlockRef {
  index: number;
  startSec: number;
  endSec: number;
}

export interface DocumentSummary {
  file: string;
  title: string;
  created: string;
}

export interface SearchHit {
  file: string;
  line: number;
  text: string;
}

export type ReplaceOutcome = 'replaced' | 'skipped-edited' | 'missing';

export function blockMarker(block: BlockRef): string {
  return `<!-- dw:block ${block.index} t=${block.startSec}-${block.endSec} -->`;
}

export function formatFrontmatter(fm: Frontmatter): string {
  const lines = Object.entries(fm).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

export function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  if (!content.startsWith('---\n')) {
    return { frontmatter: {}, body: content };
  }
  const end = content.indexOf('\n---', 4);
  if (end === -1) {
    return { frontmatter: {}, body: content };
  }
  const frontmatter: Record<string, string> = {};
  for (const line of content.slice(4, end).split('\n')) {
    const separator = line.indexOf(':');
    if (separator > 0) {
      frontmatter[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }
  return { frontmatter, body: content.slice(end + 4).replace(/^\n+/, '') };
}

export function hashText(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex');
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'untitled';
}

const BLOCK_LINE = /^<!-- dw:block (\d+) t=(\d+)-(\d+) -->$/;

export class DocumentStore {
  constructor(private readonly vaultPath: string) {}

  private read(file: string): string {
    return fs.readFileSync(file, 'utf8');
  }

  private write(file: string, content: string): void {
    fs.writeFileSync(file, content);
  }

  // Used by listDocuments/search, which scan the whole vault: a single locked,
  // permission-denied, or since-deleted file (common when Obsidian/sync is also
  // touching the vault) must not abort the scan for every other document.
  private tryRead(file: string): string | null {
    try {
      return this.read(file);
    } catch (error) {
      console.error(`Could not read ${file}:`, error);
      return null;
    }
  }

  createDocument(id: string, fm: Frontmatter): string {
    fs.mkdirSync(this.vaultPath, { recursive: true });
    const file = path.join(this.vaultPath, `${id}-${slugify(fm.title)}.md`);
    this.write(file, `${formatFrontmatter(fm)}\n`);
    return file;
  }

  appendLine(file: string, line: string): void {
    const content = this.read(file);
    const separator = content.endsWith('\n') ? '' : '\n';
    this.write(file, `${content}${separator}${line}\n`);
  }

  openBlock(file: string, block: BlockRef, heading?: string): void {
    this.appendLine(file, `\n${blockMarker(block)}`);
    if (heading) {
      this.appendLine(file, heading);
    }
  }

  // Segments join with a space so a block reads as prose, not one line per utterance.
  appendSegment(file: string, text: string): void {
    const content = this.read(file);
    const trimmed = content.replace(/\s+$/, '');
    const lastLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1);
    const continuing = lastLine.length > 0 && !lastLine.startsWith('<!--') && !lastLine.startsWith('#');
    this.write(file, `${trimmed}${continuing ? ' ' : '\n'}${text.trim()}\n`);
  }

  private blockBounds(file: string, index: number): { startLine: number; endLine: number; lines: string[] } | null {
    const lines = this.read(file).split('\n');
    const startLine = lines.findIndex((line) => {
      const match = BLOCK_LINE.exec(line.trim());
      return match !== null && Number(match[1]) === index;
    });
    if (startLine === -1) return null;
    let endLine = lines.length;
    for (let i = startLine + 1; i < lines.length; i++) {
      if (BLOCK_LINE.test(lines[i].trim())) {
        endLine = i;
        break;
      }
    }
    return { startLine, endLine, lines };
  }

  readBlockText(file: string, index: number): string | null {
    const bounds = this.blockBounds(file, index);
    if (!bounds) return null;
    return bounds.lines
      .slice(bounds.startLine + 1, bounds.endLine)
      .filter((line) => !line.trim().startsWith('#') && line.trim() !== '<!-- dw:gap -->')
      .join('\n')
      .trim();
  }

  replaceBlock(file: string, index: number, text: string, expectedHash: string): ReplaceOutcome {
    const bounds = this.blockBounds(file, index);
    if (!bounds) return 'missing';
    const current = this.readBlockText(file, index) ?? '';
    if (hashText(current) !== expectedHash) return 'skipped-edited';

    const headings = bounds.lines
      .slice(bounds.startLine + 1, bounds.endLine)
      .filter((line) => line.trim().startsWith('#'));
    const replacement = [...headings, text.trim(), ''];
    const next = [...bounds.lines.slice(0, bounds.startLine + 1), ...replacement, ...bounds.lines.slice(bounds.endLine)];
    this.write(file, next.join('\n'));
    return 'replaced';
  }

  updateFrontmatter(file: string, patch: Partial<Frontmatter>): void {
    const { frontmatter, body } = parseFrontmatter(this.read(file));
    for (const [key, value] of Object.entries(patch)) {
      frontmatter[key] = String(value);
    }
    const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`);
    this.write(file, `---\n${lines.join('\n')}\n---\n\n${body}`);
  }

  private markdownFiles(dir = this.vaultPath): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...this.markdownFiles(full));
      else if (entry.name.toLowerCase().endsWith('.md')) files.push(full);
    }
    return files;
  }

  listDocuments(): DocumentSummary[] {
    const summaries: DocumentSummary[] = [];
    for (const file of this.markdownFiles()) {
      const content = this.tryRead(file);
      if (content === null) continue;
      const { frontmatter } = parseFrontmatter(content);
      summaries.push({
        file,
        title: frontmatter.title ?? path.basename(file, '.md'),
        created: frontmatter.created ?? '',
      });
    }
    return summaries;
  }

  search(query: string): SearchHit[] {
    const needle = query.toLowerCase();
    if (needle.length === 0) return [];
    const hits: SearchHit[] = [];
    for (const file of this.markdownFiles()) {
      const content = this.tryRead(file);
      if (content === null) continue;
      content.split('\n').forEach((text, i) => {
        if (text.toLowerCase().includes(needle)) {
          hits.push({ file, line: i + 1, text: text.trim() });
        }
      });
    }
    return hits;
  }

  renameDocument(file: string, title: string): string {
    const dir = path.dirname(file);
    const prefix = path.basename(file, '.md').split('-').slice(0, 4).join('-');
    let target = path.join(dir, `${prefix}-${slugify(title)}.md`);
    let attempt = 2;
    while (fs.existsSync(target) && target !== file) {
      target = path.join(dir, `${prefix}-${slugify(title)}-${attempt}.md`);
      attempt++;
    }
    if (target !== file) fs.renameSync(file, target);
    this.updateFrontmatter(target, { title });
    return target;
  }

  deleteDocument(file: string): void {
    fs.rmSync(file, { force: true });
  }

  // Lets callers notice an edit made outside the app between two of our own writes.
  fileHash(file: string): string {
    try {
      return hashText(this.read(file));
    } catch {
      return '';
    }
  }
}
