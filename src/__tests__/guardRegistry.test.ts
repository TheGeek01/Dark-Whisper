import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DocumentStore } from '../services/documentStore';
import { GuardRegistry } from '../services/guardRegistry';

describe('GuardRegistry', () => {
  let vault: string;
  let documents: DocumentStore;
  let registry: GuardRegistry;
  let file: string;
  let other: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-guards-'));
    documents = new DocumentStore(vault);
    registry = new GuardRegistry();
    file = path.join(vault, 'day.md');
    other = path.join(vault, 'other.md');
    fs.writeFileSync(file, '---\ntitle: day\n---\n\n');
    fs.writeFileSync(other, '---\ntitle: other\n---\n\n');
  });

  afterEach(() => fs.rmSync(vault, { recursive: true, force: true }));

  it('shares one guard per file, ignoring case', () => {
    const guard = registry.acquire(file, documents);
    expect(registry.acquire(file.toUpperCase(), documents)).toBe(guard);
    expect(registry.acquire(other, documents)).not.toBe(guard);
    expect(registry.size()).toBe(2);
  });

  it('starts a new guard from the file as it is, then reports outside edits', () => {
    fs.appendFileSync(file, '<!-- dw:block 1 t=0-0 -->\nbefore\n');
    const guard = registry.acquire(file, documents);
    const reports: number[][] = [];
    guard.onOutsideEdit((changed) => reports.push(changed));
    expect(guard.readBlockText(file, 1)).toBe('before');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('before', 'after'));
    expect(guard.readBlockText(file, 1)).toBe('after');
    expect(reports).toEqual([[1]]);
  });

  it('forgets a file once its last user releases it', () => {
    const guard = registry.acquire(file, documents);
    registry.acquire(file, documents);
    registry.release(file);
    expect(registry.acquire(file, documents)).toBe(guard);
    registry.release(file);
    registry.release(file);
    expect(registry.size()).toBe(0);
    registry.release(file);
    expect(registry.acquire(file, documents)).not.toBe(guard);
  });

  it('follows a moved file without reporting the move as an edit', () => {
    const guard = registry.acquire(file, documents);
    const reports: number[][] = [];
    guard.onOutsideEdit((changed) => reports.push(changed));
    const moved = path.join(vault, 'Work', 'day.md');
    fs.mkdirSync(path.dirname(moved));
    fs.renameSync(file, moved);
    fs.writeFileSync(moved, fs.readFileSync(moved, 'utf8').replace('title: day', 'title: renamed'));

    registry.moved(file, moved);

    expect(registry.acquire(moved, documents)).toBe(guard);
    guard.readBlockText(moved, 1);
    expect(reports).toEqual([]);
  });
});
