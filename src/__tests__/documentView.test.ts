import type { BlockEvent } from '../shared/api';
import {
  blockCaption,
  documentTitle,
  DocumentPart,
  frontmatterRows,
  mergeLiveText,
  parseDocument,
  partIndexForLine,
  plainText,
} from '../renderer/documentView';

const DOC = [
  '---',
  'title: Team sync',
  'created: 2026-09-16T10:06:12Z',
  'duration: 250',
  '---',
  '',
  'Preamble written by hand.',
  '',
  '<!-- dw:block 1 t=0-120 -->',
  '## 00:00:00',
  'First block text.',
  '',
  '<!-- dw:block 2 t=120-240 -->',
  'Before the gap.',
  '<!-- dw:gap -->',
  '*(recording interrupted and resumed)*',
  'After the gap.',
  '',
  '<!-- dw:block 3 t=240-360 -->',
  '',
].join('\n');

const part = (overrides: Partial<DocumentPart>): DocumentPart => ({
  kind: 'block',
  index: 0,
  startSec: 0,
  endSec: 0,
  continued: false,
  line: 1,
  markdown: '',
  ...overrides,
});

describe('parseDocument', () => {
  it('splits frontmatter, intro, blocks and gaps with their file lines', () => {
    const parsed = parseDocument(DOC);
    expect(parsed.frontmatter).toEqual({ title: 'Team sync', created: '2026-09-16T10:06:12Z', duration: '250' });
    expect(parsed.parts).toEqual([
      part({ kind: 'intro', line: 7, markdown: 'Preamble written by hand.' }),
      part({ index: 1, startSec: 0, endSec: 120, line: 9, markdown: '## 00:00:00\nFirst block text.' }),
      part({ index: 2, startSec: 120, endSec: 240, line: 13, markdown: 'Before the gap.' }),
      part({ kind: 'gap', line: 15 }),
      part({ index: 2, startSec: 120, endSec: 240, continued: true, line: 17, markdown: 'After the gap.' }),
      part({ index: 3, startSec: 240, endSec: 360, line: 19, markdown: '' }),
    ]);
  });

  it('treats a note without frontmatter or markers as plain Markdown', () => {
    expect(parseDocument('# Notes\r\n\r\nplain text\r\n')).toEqual({
      frontmatter: {},
      parts: [part({ kind: 'intro', line: 1, markdown: '# Notes\n\nplain text' })],
    });
  });

  it('keeps malformed markers and unterminated frontmatter as text', () => {
    const parsed = parseDocument('---\ntitle: x\n<!-- dw:block x t=1-2 -->');
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.parts).toEqual([
      part({ kind: 'intro', line: 1, markdown: '---\ntitle: x\n<!-- dw:block x t=1-2 -->' }),
    ]);
  });
});

describe('mergeLiveText', () => {
  const blocks: BlockEvent[] = [{ sessionId: 's', blockIndex: 4, startSec: 360, endSec: 480, state: 'live' }];

  it('appends pending text to the last part of its block', () => {
    const parts = parseDocument(DOC).parts;
    const merged = mergeLiveText(parts, new Map([[2, 'more words']]), []);
    expect(merged[4].markdown).toBe('After the gap. more words');
    expect(merged[2].markdown).toBe('Before the gap.');
    expect(parts[4].markdown).toBe('After the gap.');
  });

  it('starts a new line after a heading and fills empty blocks', () => {
    const merged = mergeLiveText(
      [part({ index: 1, markdown: '## 00:00:00' }), part({ index: 3, markdown: '' })],
      new Map([
        [1, 'hello'],
        [3, 'there'],
      ]),
      [],
    );
    expect(merged.map((p) => p.markdown)).toEqual(['## 00:00:00\nhello', 'there']);
  });

  it('adds a block the last read did not contain yet, using its event range', () => {
    const merged = mergeLiveText([part({ index: 3, markdown: 'x' })], new Map([[4, 'new block']]), blocks);
    expect(merged[1]).toEqual(part({ index: 4, startSec: 360, endSec: 480, line: 0, markdown: 'new block' }));
  });
});

describe('document helpers', () => {
  const parsed = parseDocument(DOC);

  it('finds the part that contains a file line', () => {
    expect(partIndexForLine(parsed.parts, 11)).toBe(1);
    expect(partIndexForLine(parsed.parts, 16)).toBe(2);
    expect(partIndexForLine(parsed.parts, 17)).toBe(4);
    expect(partIndexForLine(parsed.parts, 3)).toBe(-1);
  });

  it('copies the body without frontmatter, markers or gap notes', () => {
    expect(plainText(parsed.parts)).toBe(
      'Preamble written by hand.\n\n## 00:00:00\nFirst block text.\n\nBefore the gap.\n\nAfter the gap.',
    );
  });

  it('names a document by its title, else its file name', () => {
    expect(documentTitle(parsed.frontmatter, 'x.md')).toBe('Team sync');
    expect(documentTitle({}, 'Work/ideas.md')).toBe('ideas');
  });

  it('captions a block with its time range', () => {
    expect(blockCaption(part({ index: 2, startSec: 120, endSec: 240 }))).toBe('Block 2 · 02:00–04:00');
  });

  it('lists the known frontmatter fields', () => {
    expect(frontmatterRows({ created: 'x', duration: '250', title: 't', other: 'y' })).toEqual([
      { label: 'Created', value: 'x' },
      { label: 'Duration', value: '04:10' },
    ]);
  });
});
