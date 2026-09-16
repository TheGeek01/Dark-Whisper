import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DocumentStore, Frontmatter, hashText } from '../services/documentStore';
import { GuardedStore } from '../services/guardedStore';

const FM: Frontmatter = {
  title: 'untitled',
  created: '2026-09-16T19:03:24Z',
  updated: '2026-09-16T19:03:24Z',
  duration: 0,
  language: 'en',
  liveModel: 'ggml-base.en.bin',
  refineModel: 'ggml-large-v3-turbo-q5_0.bin',
  app: 'dark-whisper 1.2.1',
};

function setup() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-guard-'));
  const documents = new DocumentStore(vault);
  const file = documents.createDocument('2026-09-16-1903', FM);
  const reports: number[][] = [];
  const guard = new GuardedStore(documents, (changed) => reports.push(changed));
  guard.noteWrite(file);
  return { documents, file, reports, guard };
}

const block = (index: number, startSec: number) => ({ index, startSec, endSec: startSec + 120 });

describe('GuardedStore', () => {
  it('never reports its own writes as outside edits', () => {
    const ctx = setup();
    ctx.guard.openBlock(ctx.file, block(1, 0));
    ctx.guard.appendSegment(ctx.file, 'hello there');
    ctx.guard.appendLine(ctx.file, '<!-- dw:gap -->');
    ctx.guard.updateFrontmatter(ctx.file, { duration: 5 });
    expect(ctx.guard.readBlockText(ctx.file, 1)).toBe('hello there');
    expect(ctx.reports).toEqual([]);
  });

  it('reports the block an outside editor changed, once, before the next read', () => {
    const ctx = setup();
    ctx.guard.openBlock(ctx.file, block(1, 0));
    ctx.guard.appendSegment(ctx.file, 'take us to the limit');
    fs.writeFileSync(ctx.file, fs.readFileSync(ctx.file, 'utf8').replace('take us', 'hell o take us'));

    expect(ctx.guard.readBlockText(ctx.file, 1)).toBe('hell o take us to the limit');
    expect(ctx.reports).toEqual([[1]]);

    ctx.guard.appendSegment(ctx.file, 'more words');
    expect(ctx.reports).toEqual([[1]]);
  });

  it('reports an edit before the next write, and keeps the outside text', () => {
    const ctx = setup();
    ctx.guard.openBlock(ctx.file, block(1, 0));
    ctx.guard.appendSegment(ctx.file, 'first');
    fs.appendFileSync(ctx.file, 'typed in another editor\n');

    ctx.guard.openBlock(ctx.file, block(2, 120));
    expect(ctx.reports).toEqual([[1]]);
    const content = fs.readFileSync(ctx.file, 'utf8');
    expect(content).toContain('typed in another editor');
    expect(content).toContain('<!-- dw:block 2 t=120-240 -->');
  });

  it('reports a change outside any block with no block indexes', () => {
    const ctx = setup();
    ctx.guard.openBlock(ctx.file, block(1, 0));
    fs.writeFileSync(ctx.file, fs.readFileSync(ctx.file, 'utf8').replace('title: untitled', 'title: renamed'));
    ctx.guard.appendSegment(ctx.file, 'words');
    expect(ctx.reports).toEqual([[]]);
  });

  it('keeps refining untouched blocks after another block was edited', () => {
    const ctx = setup();
    ctx.guard.openBlock(ctx.file, block(1, 0));
    ctx.guard.appendSegment(ctx.file, 'block one');
    ctx.guard.openBlock(ctx.file, block(2, 120));
    ctx.guard.appendSegment(ctx.file, 'block two');
    const hashOne = hashText(ctx.guard.readBlockText(ctx.file, 1) ?? '');
    const hashTwo = hashText(ctx.guard.readBlockText(ctx.file, 2) ?? '');

    fs.writeFileSync(ctx.file, fs.readFileSync(ctx.file, 'utf8').replace('block one', 'block one, corrected'));

    expect(ctx.guard.replaceBlock(ctx.file, 2, 'Block two.', hashTwo)).toBe('replaced');
    expect(ctx.guard.replaceBlock(ctx.file, 1, 'Block one.', hashOne)).toBe('skipped-edited');
    expect(ctx.reports).toEqual([[1]]);
    const content = fs.readFileSync(ctx.file, 'utf8');
    expect(content).toContain('Block two.');
    expect(content).toContain('block one, corrected');
  });

  it('does not treat a file it cannot read as edited', () => {
    const ctx = setup();
    ctx.guard.openBlock(ctx.file, block(1, 0));
    jest.spyOn(ctx.documents, 'readContent').mockReturnValueOnce(null);
    ctx.guard.appendSegment(ctx.file, 'words');
    expect(ctx.reports).toEqual([]);
    ctx.guard.appendSegment(ctx.file, 'more');
    expect(ctx.reports).toEqual([]);
  });
});
