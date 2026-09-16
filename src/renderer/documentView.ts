import type { BlockEvent } from '../shared/api.js';
import { formatClock } from './format.js';

// Mirrors the formats written by src/services/documentStore.ts and sessionService.ts.
const BLOCK_LINE = /^<!-- dw:block (\d+) t=(\d+)-(\d+) -->$/;
const GAP_LINE = '<!-- dw:gap -->';
const GAP_NOTE = '*(recording interrupted and resumed)*';

export interface DocumentPart {
  kind: 'intro' | 'block' | 'gap';
  index: number;
  startSec: number;
  endSec: number;
  continued: boolean;
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
        line: bodyStart + i,
        markdown: '',
      };
      continue;
    }
    if (trimmed === GAP_LINE) {
      flush();
      parts.push({ kind: 'gap', index: 0, startSec: 0, endSec: 0, continued: false, line: bodyStart + i, markdown: '' });
      if (lines[i + 1] !== undefined && lines[i + 1].trim() === GAP_NOTE) i++;
      // Text after a gap still belongs to the block the gap interrupted.
      current = { ...current, continued: current.kind === 'block', line: bodyStart + i + 1 };
      continue;
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

export function blockCaption(part: DocumentPart): string {
  return `Block ${part.index} · ${formatClock(part.startSec)}–${formatClock(part.endSec)}`;
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
    ([key, label]) => ({
      label,
      value: key === 'duration' ? formatClock(Number(frontmatter[key]) || 0) : frontmatter[key],
    }),
  );
}
