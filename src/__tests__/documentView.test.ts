import type { BlockEvent } from '../shared/api';
import {
  absolutePath,
  clockOf,
  clockParts,
  documentDetailRows,
  documentTitle,
  DocumentPart,
  frontmatterRows,
  hitNeedle,
  lineIndexContaining,
  mergeLiveText,
  normalizeText,
  parseDocument,
  partIndexForLine,
  plainText,
} from '../renderer/documentView';
import { formatDate } from '../renderer/format';

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
  clock: '',
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
  const blocks: BlockEvent[] = [{ sessionId: 's', blockIndex: 4, startSec: 360, endSec: 480, state: 'live', clock: '' }];

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

  it('lists the known frontmatter fields, showing a created time locally', () => {
    expect(frontmatterRows({ created: 'x', duration: '250', title: 't', other: 'y' })).toEqual([
      { label: 'Created', value: 'x' },
      { label: 'Duration', value: '04:10' },
    ]);
    expect(frontmatterRows({ created: '2026-09-16T17:52:00Z' })).toEqual([
      { label: 'Created', value: formatDate('2026-09-16T17:52:00Z', 0) },
    ]);
  });

  it('adds the path after the created time', () => {
    expect(documentDetailRows({ created: 'x', language: 'en' }, 'Testing/test doc.md')).toEqual([
      { label: 'Created', value: 'x' },
      { label: 'Path', value: 'Testing/test doc.md' },
      { label: 'Language', value: 'en' },
    ]);
    expect(documentDetailRows({}, 'a.md')).toEqual([{ label: 'Path', value: 'a.md' }]);
  });
});

describe('clock lines', () => {
  const content = [
    '---',
    'title: Day',
    '---',
    '',
    '<!-- dw:block 1 t=0-4 -->',
    '**2026-09-16 14:32**',
    'First note.',
    '',
    '<!-- dw:block 2 t=10-14 -->',
    '**14:35**',
    'Second note.',
    'Another line.',
    '',
  ].join('\n');

  it('moves each clock line out of the text into its paragraph', () => {
    const parts = parseDocument(content).parts;
    expect(parts.map((p) => [p.index, p.clock, p.markdown, p.line])).toEqual([
      [1, '2026-09-16 14:32', 'First note.', 5],
      [2, '14:35', 'Second note.\nAnother line.', 9],
    ]);
  });

  it('keeps bold text and late clock lines as text', () => {
    expect(parseDocument('<!-- dw:block 1 t=0-0 -->\n**Agenda**\nx').parts[0]).toMatchObject({ clock: '', markdown: '**Agenda**\nx' });
    expect(parseDocument('<!-- dw:block 1 t=0-0 -->\nhello\n**14:32**').parts[0]).toMatchObject({ clock: '', markdown: 'hello\n**14:32**' });
  });

  it('reads and splits clocks', () => {
    expect(clockOf('**14:32**')).toBe('14:32');
    expect(clockOf(' **2026-09-16 14:32** ')).toBe('2026-09-16 14:32');
    expect(clockOf('**later**')).toBe('');
    expect(clockParts('2026-09-16 14:32')).toEqual({ date: '2026-09-16', time: '14:32' });
    expect(clockParts('14:32')).toEqual({ date: '', time: '14:32' });
    expect(clockParts('')).toEqual({ date: '', time: '' });
  });

  it('gives a live paragraph the read has not seen yet the clock of its event', () => {
    const merged = mergeLiveText([], new Map([[3, 'hi']]), [
      { sessionId: 's', blockIndex: 3, startSec: 5, endSec: 5, state: 'live', clock: '**14:40**' },
    ]);
    expect(merged).toEqual([part({ index: 3, startSec: 5, endSec: 5, line: 0, clock: '14:40', markdown: 'hi' })]);
  });
});

describe('search hits', () => {
  it('reads the matched line without Markdown syntax', () => {
    const text = '# Title\n\n- **Budget** line two\n> quoted [link](http://x) here\n';
    expect(hitNeedle(text, 3)).toBe('budget line two');
    expect(hitNeedle(text, 4)).toBe('quoted link here');
    expect(hitNeedle(text, 1)).toBe('title');
    expect(hitNeedle(text, 99)).toBe('');
    expect(hitNeedle('a\r\nb  c\r\n', 2)).toBe('b c');
    expect(normalizeText('  The *Big*   `plan` ')).toBe('the big plan');
  });

  it('finds the rendered line that holds the match', () => {
    expect(lineIndexContaining(['Alpha line', 'The Budget line two', 'gamma'], 'budget line two')).toBe(1);
    expect(lineIndexContaining(['Alpha'], 'missing')).toBe(-1);
    expect(lineIndexContaining(['Alpha'], '')).toBe(-1);
  });

  it('builds the absolute path of a vault file', () => {
    expect(absolutePath('C:\\Vault\\', 'Work/a b.md')).toBe('C:\\Vault\\Work\\a b.md');
    expect(absolutePath('C:\\Vault', 'a.md')).toBe('C:\\Vault\\a.md');
  });
});
