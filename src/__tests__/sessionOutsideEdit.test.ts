import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DocumentStore, Frontmatter } from '../services/documentStore';
import { SilenceTracker } from '../services/audioLevel';
import { GuardedStore } from '../services/guardedStore';
import { GuardRegistry } from '../services/guardRegistry';
import { prepareQuickNote } from '../services/quickNotes';
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

const CLOCK = '**2026-09-16 14:32**';

const DETAILS: Omit<Frontmatter, 'title'> = {
  created: FM.created,
  updated: FM.updated,
  duration: 0,
  language: FM.language,
  liveModel: FM.liveModel,
  refineModel: FM.refineModel,
  app: FM.app,
};

function wire() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-outside-edit-'));
  const documents = new DocumentStore(vault);
  const file = documents.createDocument('2026-09-16-1903', FM);
  const jobs: RefineJob[] = [];
  const events: SessionBlockEvent[] = [];
  const reports: number[][] = [];
  const holder: { service: SessionService | null } = { service: null };
  const store = new GuardedStore(documents);
  store.noteWrite(file);
  store.onOutsideEdit((changed) => {
    reports.push(changed);
    holder.service?.noteOutsideEdit(changed);
  });
  const service = new SessionService({
    store,
    enqueueRefine: (job) => jobs.push(job),
    blockMinutes: 10,
    silenceGapSec: 5,
    // No audio: paragraphs split when segments arrive at least 5 s apart.
    silence: new SilenceTracker(),
    now: () => new Date(2026, 8, 16, 14, 32),
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
    expect(w.events).toContainEqual({ blockIndex: 1, startSec: 0, endSec: 5, state: 'edited', clock: CLOCK });
    expect(fs.readFileSync(w.file, 'utf8')).toContain('hell o take us to the limit');
  });

  it('protects the live block edited just before Stop', () => {
    const w = wire();
    w.service.segment({ text: 'last words', atMs: 5_000 });
    w.edit('last words', 'last words, fixed');
    w.service.end();

    expect(w.jobs).toEqual([]);
    expect(w.events).toContainEqual({ blockIndex: 1, startSec: 0, endSec: 5, state: 'edited', clock: CLOCK });
  });

  it('still refines untouched blocks and skips a finished block edited later', () => {
    const w = wire();
    w.service.segment({ text: 'one', atMs: 5_000 });
    w.service.segment({ text: 'two', atMs: 125_000 });
    w.service.segment({ text: 'three', atMs: 245_000 });
    w.edit('one', 'one corrected');
    w.service.segment({ text: 'four', atMs: 247_000 });
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

describe('two quick-note runs on one day file', () => {
  it('share the guard, so only a real outside edit is reported and only its paragraph is skipped', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-two-runs-'));
    const documents = new DocumentStore(vault);
    const registry = new GuardRegistry();
    const day = new Date(2026, 8, 16, 14, 32);

    function startRun(id: string) {
      const target = prepareQuickNote(documents, vault, day, DETAILS);
      const store = registry.acquire(target.documentPath, documents);
      const jobs: RefineJob[] = [];
      const reports: number[][] = [];
      const service = new SessionService({
        store,
        enqueueRefine: (job) => jobs.push(job),
        blockMinutes: 10,
        silenceGapSec: 5,
        silence: new SilenceTracker(),
        now: () => day,
      });
      store.onOutsideEdit((changed) => {
        reports.push(changed);
        service.noteOutsideEdit(changed);
      });
      service.begin({
        id,
        documentPath: target.documentPath,
        firstBlockIndex: target.firstBlockIndex,
        baseDurationSec: target.baseDurationSec,
      });
      return { service, jobs, reports, file: target.documentPath };
    }

    const first = startRun('a');
    first.service.segment({ text: 'alpha', atMs: 2_000 });
    first.service.end(3_000);
    expect(first.jobs.map((job) => job.blockIndex)).toEqual([1]);

    const second = startRun('b');
    second.service.segment({ text: 'bravo', atMs: 2_000 });
    expect(first.service.applyRefinement(1, 'Alpha.')).toBe('replaced');
    second.service.segment({ text: 'and more', atMs: 3_000 });
    expect(first.reports).toEqual([]);
    expect(second.reports).toEqual([]);

    fs.writeFileSync(second.file, fs.readFileSync(second.file, 'utf8').replace('bravo', 'bravo fixed'));
    second.service.segment({ text: 'charlie', atMs: 20_000 });
    second.service.end(21_000);

    expect(first.reports).toEqual([[2]]);
    expect(second.reports).toEqual([[2]]);
    expect(second.jobs.map((job) => job.blockIndex)).toEqual([3]);
    const content = fs.readFileSync(second.file, 'utf8');
    expect(content).toContain('Alpha.');
    expect(content).toContain('bravo fixed and more');
    expect(content.match(/\*\*2026-09-16 14:32\*\*/g)).toHaveLength(2);
    expect(content).toContain('<!-- dw:block 3 t=3-21 -->\n**14:32**\ncharlie');
    expect(content).toMatch(/duration: 24\n/);
  });
});
