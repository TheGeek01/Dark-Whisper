import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DocumentStore, Frontmatter } from '../services/documentStore';
import { parseStartRequest, prepareQuickNote, quickNotePath, startRefusal } from '../services/quickNotes';

const FM: Omit<Frontmatter, 'title'> = {
  created: '2026-09-16T12:00:00Z',
  updated: '2026-09-16T12:00:00Z',
  duration: 0,
  language: 'en',
  liveModel: 'ggml-base.en.bin',
  refineModel: 'ggml-large-v3-turbo-q5_0.bin',
  app: 'dark-whisper 1.3.0',
};

describe('quick notes', () => {
  let vault: string;
  let store: DocumentStore;
  const day = new Date(2026, 8, 16, 23, 59);

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-quick-'));
    store = new DocumentStore(vault);
  });

  afterEach(() => fs.rmSync(vault, { recursive: true, force: true }));

  it('names the file after the local date', () => {
    expect(quickNotePath(vault, day)).toBe(path.join(vault, 'Quick Notes', '2026-09-16.md'));
  });

  it('creates the folder and the day file, titled with the date', () => {
    const target = prepareQuickNote(store, vault, day, FM);
    expect(target).toEqual({
      documentPath: path.join(vault, 'Quick Notes', '2026-09-16.md'),
      folder: 'Quick Notes',
      firstBlockIndex: 1,
      baseDurationSec: 0,
    });
    const content = fs.readFileSync(target.documentPath, 'utf8');
    expect(content.startsWith('---\ntitle: 2026-09-16\n')).toBe(true);
  });

  it('continues numbering and duration from an existing day file', () => {
    const file = quickNotePath(vault, day);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      '---\r\ntitle: 2026-09-16\r\nduration: 125\r\n---\r\n\r\n<!-- dw:block 1 t=0-4 -->\r\n**2026-09-16 09:00**\r\nfirst\r\n\r\n<!-- dw:block 2 t=10-14 -->\r\n**09:01**\r\nsecond\r\n',
    );
    const target = prepareQuickNote(store, vault, day, FM);
    expect(target.firstBlockIndex).toBe(3);
    expect(target.baseDurationSec).toBe(125);
    expect(fs.readFileSync(file, 'utf8')).toContain('second');
  });

  it('accepts a day file written by hand', () => {
    const file = quickNotePath(vault, day);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# My notes\n\nremember milk\n');
    const target = prepareQuickNote(store, vault, day, FM);
    expect(target.firstBlockIndex).toBe(1);
    expect(target.baseDurationSec).toBe(0);
  });

  it('explains when the day file cannot be opened', () => {
    fs.mkdirSync(quickNotePath(vault, day), { recursive: true });
    expect(() => prepareQuickNote(store, vault, day, FM)).toThrow(/^Could not open today's quick note \(Quick Notes[\\/]2026-09-16\.md\): /);
  });

  it('refuses to start one mode while the other records', () => {
    expect(startRefusal(null, 'quick-note')).toBeNull();
    expect(startRefusal(null, 'session')).toBeNull();
    expect(startRefusal('session', 'quick-note')).toBe('Stop the session before starting a quick note.');
    expect(startRefusal('quick-note', 'session')).toBe('Stop the quick note before starting a session.');
    expect(startRefusal('session', 'session')).toBe('A session is already recording.');
    expect(startRefusal('quick-note', 'quick-note')).toBe('A quick note is already recording.');
  });

  it('reads a start request from the renderer defensively', () => {
    expect(parseStartRequest({ kind: 'quick-note' })).toEqual({ kind: 'quick-note' });
    expect(parseStartRequest({ kind: 'session', folder: 'Work' })).toEqual({ kind: 'session', folder: 'Work' });
    expect(parseStartRequest({ kind: 'session' })).toEqual({ kind: 'session', folder: '' });
    expect(parseStartRequest('Work')).toEqual({ kind: 'session', folder: 'Work' });
    expect(parseStartRequest(undefined)).toEqual({ kind: 'session', folder: '' });
    expect(parseStartRequest({ kind: 'other', folder: 3 })).toEqual({ kind: 'session', folder: '' });
  });
});
