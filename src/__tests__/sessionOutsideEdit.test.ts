import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DocumentStore, Frontmatter } from '../services/documentStore';
import { GuardedStore } from '../services/guardedStore';
import { RefineJob, SessionBlockEvent, SessionService } from '../services/sessionService';

// A real document store, guard and session wired together the way sessionRuntime does it.

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

function wire() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-outside-edit-'));
  const documents = new DocumentStore(vault);
  const file = documents.createDocument('2026-09-16-1903', FM);
  const jobs: RefineJob[] = [];
  const events: SessionBlockEvent[] = [];
  const reports: number[][] = [];
  const holder: { service: SessionService | null } = { service: null };
  const store = new GuardedStore(documents, (changed) => {
    reports.push(changed);
    holder.service?.noteOutsideEdit(changed);
  });
  store.noteWrite(file);
  const service = new SessionService({
    store,
    enqueueRefine: (job) => jobs.push(job),
    blockMinutes: 2,
    timestampHeadings: false,
  });
  holder.service = service;
  service.onBlock((event) => events.push(event));
  service.begin({ id: 's1', documentPath: file });
  const edit = (from: string, to: string) => {
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(from, to));
  };
  return { file, service, jobs, events, reports, edit };
}

describe('outside edits during a session', () => {
  it('never queues the live block an outside editor changed', () => {
    const w = wire();
    w.service.segment({ text: 'take us to the limit', atMs: 5_000 });
    w.edit('take us', 'hell o take us');
    w.service.segment({ text: 'next block', atMs: 125_000 });

    expect(w.jobs).toEqual([]);
    expect(w.events).toContainEqual({ blockIndex: 1, startSec: 0, endSec: 120, state: 'edited' });
    expect(fs.readFileSync(w.file, 'utf8')).toContain('hell o take us to the limit');
  });

  it('protects the live block edited just before Stop', () => {
    const w = wire();
    w.service.segment({ text: 'last words', atMs: 5_000 });
    w.edit('last words', 'last words, fixed');
    w.service.end();

    expect(w.jobs).toEqual([]);
    expect(w.events).toContainEqual({ blockIndex: 1, startSec: 0, endSec: 5, state: 'edited' });
  });

  it('still refines untouched blocks and skips a finished block edited later', () => {
    const w = wire();
    w.service.segment({ text: 'one', atMs: 5_000 });
    w.service.segment({ text: 'two', atMs: 125_000 });
    w.service.segment({ text: 'three', atMs: 245_000 });
    w.edit('one', 'one corrected');
    w.service.segment({ text: 'four', atMs: 250_000 });
    w.service.end();

    expect(w.reports).toEqual([[1]]);
    expect(w.jobs.map((job) => job.blockIndex)).toEqual([1, 2, 3]);
    expect(w.service.applyRefinement(1, 'One.')).toBe('skipped-edited');
    expect(w.service.applyRefinement(2, 'Two.')).toBe('replaced');
    expect(w.service.applyRefinement(3, 'Three four.')).toBe('replaced');
    const content = fs.readFileSync(w.file, 'utf8');
    expect(content).toContain('one corrected');
    expect(content).toContain('Two.');
    expect(content).toContain('Three four.');
  });

  it('relies on the block hash once the session has stopped', () => {
    const w = wire();
    w.service.segment({ text: 'one', atMs: 5_000 });
    w.service.end();
    w.edit('one', 'uno');

    expect(w.service.applyRefinement(1, 'One.')).toBe('skipped-edited');
    expect(w.reports).toEqual([[1]]);
    expect(fs.readFileSync(w.file, 'utf8')).toContain('uno');
  });

  it('reports no blocks for a line-ending-only resave', () => {
    const w = wire();
    w.service.segment({ text: 'one', atMs: 5_000 });
    fs.writeFileSync(w.file, fs.readFileSync(w.file, 'utf8').replace(/\n/g, '\r\n'));
    w.service.segment({ text: 'more', atMs: 6_000 });
    w.service.end();

    expect(w.reports).toEqual([[]]);
    expect(w.jobs.map((job) => job.blockIndex)).toEqual([1]);
  });
});
