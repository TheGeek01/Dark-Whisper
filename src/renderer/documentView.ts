import type { BlockEvent } from '../shared/api.js';
import { formatClock, formatDate } from './format.js';

// Mirrors the formats written by src/services/documentStore.ts and sessionService.ts.
const BLOCK_LINE = /^<!-- dw:block (\d+) t=(\d+)-(\d+) -->$/;
const GAP_LINE = '<!-- dw:gap -->';
const GAP_NOTE = '*(recording interrupted and resumed)*';

// A block's clock line (written by sessionService, spec §3.2).
const CLOCK_LINE = /^\*\*((?:\d{4}-\d{2}-\d{2} )?\d{2}:\d{2})\*\*$/;

// The clock inside a clock line, or '' if the line is not one.
export function clockOf(line: string): string {
  return CLOCK_LINE.exec(line.trim())?.[1] ?? '';
}

export function clockParts(clock: string): { date: string; time: string } {
  const match = /^(?:(\d{4}-\d{2}-\d{2}) )?(\d{2}:\d{2})$/.exec(clock);
  return match ? { date: match[1] ?? '', time: match[2] } : { date: '', time: '' };
}

export interface DocumentPart {
  kind: 'intro' | 'block' | 'gap';
  index: number;
  startSec: number;
  endSec: number;
  continued: boolean;
  clock: string;
  line: number;
  markdown: string;
}

export interface ParsedDocument {
  frontmatter: Record<string, string>;
  parts: DocumentPart[];
}

export function splitFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  if (!text.startsWith('---\n')) return { frontmatter: {}, body: text };
  const end = text.indexOf('\n---', 4);
  if (end === -1) return { frontmatter: {}, body: text };
  const frontmatter: Record<string, string> = {};
  for (const line of text.slice(4, end).split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) frontmatter[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { frontmatter, body: text.slice(end + 4).replace(/^\n+/, '') };
}

export function parseDocument(content: string): ParsedDocument {
  const text = content.replace(/\r\n/g, '\n');
  const { frontmatter, body } = splitFrontmatter(text);
  const bodyStart = text.slice(0, text.length - body.length).split('\n').length;
  const lines = body.split('\n');
  const parts: DocumentPart[] = [];
  let current: DocumentPart = {
    kind: 'intro',
    index: 0,
    startSec: 0,
    endSec: 0,
    continued: false,
    clock: '',
    line: bodyStart,
    markdown: '',
  };
  let buffer: string[] = [];
  const flush = () => {
    const markdown = buffer.join('\n').trim();
    if (current.kind === 'block' || markdown !== '') parts.push({ ...current, markdown });
    buffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const block = BLOCK_LINE.exec(trimmed);
    if (block) {
      flush();
      current = {
        kind: 'block',
        index: Number(block[1]),
        startSec: Number(block[2]),
        endSec: Number(block[3]),
        continued: false,
        clock: '',
        line: bodyStart + i,
        markdown: '',
      };
      continue;
    }
    if (trimmed === GAP_LINE) {
      flush();
      parts.push({ kind: 'gap', index: 0, startSec: 0, endSec: 0, continued: false, clock: '', line: bodyStart + i, markdown: '' });
      if (lines[i + 1] !== undefined && lines[i + 1].trim() === GAP_NOTE) i++;
      // Text after a gap still belongs to the block the gap interrupted.
      current = { ...current, continued: current.kind === 'block', line: bodyStart + i + 1 };
      continue;
    }
    // The first non-blank line of a block may be its clock line: it goes to the margin.
    if (current.kind === 'block' && current.clock === '' && buffer.every((line) => line.trim() === '')) {
      const clock = clockOf(trimmed);
      if (clock !== '') {
        current = { ...current, clock };
        continue;
      }
    }
    buffer.push(lines[i]);
  }
  flush();
  return { frontmatter, parts };
}

// Live segments arrive faster than the file is re-read; show them at the end of their block.
export function mergeLiveText(
  parts: readonly DocumentPart[],
  pending: ReadonlyMap<number, string>,
  blocks: readonly BlockEvent[],
): DocumentPart[] {
  const result = parts.map((p) => ({ ...p }));
  const lastPart = new Map<number, number>();
  result.forEach((p, i) => {
    if (p.kind === 'block') lastPart.set(p.index, i);
  });
  const missing = [...pending.keys()].filter((index) => !lastPart.has(index)).sort((a, b) => a - b);
  for (const index of missing) {
    const event = blocks.find((b) => b.blockIndex === index);
    result.push({
      kind: 'block',
      index,
      startSec: event ? event.startSec : 0,
      endSec: event ? event.endSec : 0,
      continued: false,
      clock: event ? clockOf(event.clock) : '',
      line: 0,
      markdown: '',
    });
    lastPart.set(index, result.length - 1);
  }
  for (const [index, text] of pending) {
    const target = result[lastPart.get(index) as number];
    const lastLine = target.markdown.slice(target.markdown.lastIndexOf('\n') + 1);
    const separator = target.markdown === '' ? '' : lastLine.startsWith('#') ? '\n' : ' ';
    target.markdown = `${target.markdown}${separator}${text}`;
  }
  return result;
}

export function partIndexForLine(parts: readonly DocumentPart[], line: number): number {
  let found = -1;
  parts.forEach((p, i) => {
    if (p.kind !== 'gap' && p.line > 0 && p.line <= line) found = i;
  });
  return found;
}

export function plainText(parts: readonly DocumentPart[]): string {
  return parts
    .map((p) => p.markdown)
    .filter((markdown) => markdown !== '')
    .join('\n\n');
}

export function documentTitle(frontmatter: Record<string, string>, file: string): string {
  return frontmatter.title || file.slice(file.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}

const FRONTMATTER_FIELDS: [string, string][] = [
  ['created', 'Created'],
  ['duration', 'Duration'],
  ['language', 'Language'],
  ['liveModel', 'Live model'],
  ['refineModel', 'Refine model'],
  ['app', 'App'],
];

export function frontmatterRows(frontmatter: Record<string, string>): { label: string; value: string }[] {
  return FRONTMATTER_FIELDS.filter(([key]) => frontmatter[key] !== undefined && frontmatter[key] !== '').map(
    ([key, label]) => {
      const raw = frontmatter[key];
      if (key === 'duration') return { label, value: formatClock(Number(raw) || 0) };
      if (key === 'created' && !Number.isNaN(Date.parse(raw))) return { label, value: formatDate(raw, 0) };
      return { label, value: raw };
    },
  );
}

// The panel's Document section: the frontmatter, with the vault path after the created time.
export function documentDetailRows(frontmatter: Record<string, string>, file: string): { label: string; value: string }[] {
  const rows = frontmatterRows(frontmatter);
  const created = rows.findIndex((row) => row.label === 'Created');
  rows.splice(created + 1, 0, { label: 'Path', value: file });
  return rows;
}

// Search hits carry a source line; the rendered text has no Markdown syntax, so both sides are
// compared without it, case-insensitively.
export function normalizeText(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function hitNeedle(content: string, line: number): string {
  const raw = content.replace(/\r\n/g, '\n').split('\n')[line - 1] ?? '';
  return normalizeText(raw.replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/, ''));
}

export function lineIndexContaining(texts: readonly string[], needle: string): number {
  if (needle === '') return -1;
  return texts.findIndex((text) => normalizeText(text).includes(needle));
}

export function absolutePath(root: string, file: string): string {
  return `${root.replace(/[\\/]+$/, '')}\\${file.replace(/\//g, '\\')}`;
}
