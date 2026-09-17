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

// A block's clock line (spec §3.2): **14:32**, or **2026-09-16 14:32** for the first block of a run.
export const CLOCK_LINE = /^\*\*(\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}\*\*$/;

export function isClockLine(line: string): boolean {
  return CLOCK_LINE.test(line.trim());
}

const pad2 = (value: number) => String(value).padStart(2, '0');

export function localDateStamp(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function formatClockLine(date: Date, withDate: boolean): string {
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return withDate ? `**${localDateStamp(date)} ${time}**` : `**${time}**`;
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'untitled';
}

const BLOCK_LINE = /^<!-- dw:block (\d+) t=(\d+)-(\d+) -->$/;

function blockLineRange(lines: string[], index: number): { start: number; end: number } | null {
  const start = lines.findIndex((line) => {
    const match = BLOCK_LINE.exec(line.trim());
    return match !== null && Number(match[1]) === index;
  });
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (BLOCK_LINE.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  return { start, end };
}

// The text of one block as refinement sees it: no marker, headings, clock line or gap markers.
export function blockTextFrom(content: string, index: number): string | null {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const range = blockLineRange(lines, index);
  if (!range) return null;
  return lines
    .slice(range.start + 1, range.end)
    .filter((line) => !line.trim().startsWith('#') && line.trim() !== '<!-- dw:gap -->' && !isClockLine(line))
    .join('\n')
    .trim();
}

function blockIndexes(content: string): number[] {
  const indexes: number[] = [];
  for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
    const match = BLOCK_LINE.exec(line.trim());
    if (match) indexes.push(Number(match[1]));
  }
  return indexes;
}

// The index for the first block appended to an existing document.
export function nextBlockIndex(content: string): number {
  return Math.max(0, ...blockIndexes(content)) + 1;
}

// Blocks whose text differs between two versions of a document, in ascending order.
export function changedBlocks(before: string, after: string): number[] {
  const all = new Set([...blockIndexes(before), ...blockIndexes(after)]);
  return [...all]
    .filter((index) => blockTextFrom(before, index) !== blockTextFrom(after, index))
    .sort((a, b) => a - b);
}

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

  createDocument(id: string, fm: Frontmatter, folder = ''): string {
    const dir = path.join(this.vaultPath, folder);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}-${slugify(fm.title)}.md`);
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

  // A block's end is only known when it closes; the marker is rewritten then.
  setBlockRange(file: string, block: BlockRef): void {
    const lines = this.read(file).split('\n');
    const range = blockLineRange(lines, block.index);
    if (!range) return;
    const ending = lines[range.start].endsWith('\r') ? '\r' : '';
    lines[range.start] = `${blockMarker(block)}${ending}`;
    this.write(file, lines.join('\n'));
  }

  // The daily quick note: created with its folder and frontmatter if missing, otherwise left as
  // it is. Returns the file's content.
  openOrCreate(file: string, fm: Frontmatter): string {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(file, `${formatFrontmatter(fm)}\n`, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return this.read(file);
  }

  // Segments join with a space so a block reads as prose, not one line per utterance.
  appendSegment(file: string, text: string): void {
    const content = this.read(file);
    const trimmed = content.replace(/\s+$/, '');
    const lastLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1);
    const continuing =
      lastLine.length > 0 && !lastLine.startsWith('<!--') && !lastLine.startsWith('#') && !isClockLine(lastLine);
    this.write(file, `${trimmed}${continuing ? ' ' : '\n'}${text.trim()}\n`);
  }

  private blockBounds(file: string, index: number): { startLine: number; endLine: number; lines: string[] } | null {
    const lines = this.read(file).split('\n');
    const range = blockLineRange(lines, index);
    return range ? { startLine: range.start, endLine: range.end, lines } : null;
  }

  readBlockText(file: string, index: number): string | null {
    return blockTextFrom(this.read(file), index);
  }

  replaceBlock(file: string, index: number, text: string, expectedHash: string): ReplaceOutcome {
    const bounds = this.blockBounds(file, index);
    if (!bounds) return 'missing';
    const current = this.readBlockText(file, index) ?? '';
    if (hashText(current) !== expectedHash) return 'skipped-edited';

    const headings = bounds.lines
      .slice(bounds.startLine + 1, bounds.endLine)
      .filter((line) => line.trim().startsWith('#') || isClockLine(line));
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

  // The whole file, or null if it cannot be read right now (e.g. a sync client holds it).
  readContent(file: string): string | null {
    try {
      return this.read(file);
    } catch {
      return null;
    }
  }

}
