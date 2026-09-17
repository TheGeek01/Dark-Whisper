import * as path from 'path';
import type { SessionKind, SessionStartRequest } from '../shared/api';
import { DocumentStore, Frontmatter, localDateStamp, nextBlockIndex, parseFrontmatter } from './documentStore';

export const QUICK_NOTES_FOLDER = 'Quick Notes';

export interface QuickNoteTarget {
  documentPath: string;
  folder: string;
  firstBlockIndex: number;
  baseDurationSec: number;
}

export function quickNotePath(vaultPath: string, date: Date): string {
  return path.join(vaultPath, QUICK_NOTES_FOLDER, `${localDateStamp(date)}.md`);
}

// Today's quick note (spec §3.4): created if missing, else appended to after its last block.
export function prepareQuickNote(
  store: DocumentStore,
  vaultPath: string,
  date: Date,
  fm: Omit<Frontmatter, 'title'>,
): QuickNoteTarget {
  const documentPath = quickNotePath(vaultPath, date);
  let content: string;
  try {
    content = store.openOrCreate(documentPath, { title: localDateStamp(date), ...fm });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const name = path.join(QUICK_NOTES_FOLDER, `${localDateStamp(date)}.md`);
    throw new Error(`Could not open today's quick note (${name}): ${reason}`);
  }
  const duration = Number(parseFrontmatter(content.replace(/\r\n/g, '\n')).frontmatter.duration);
  return {
    documentPath,
    folder: QUICK_NOTES_FOLDER,
    firstBlockIndex: nextBlockIndex(content),
    baseDurationSec: Number.isFinite(duration) && duration > 0 ? duration : 0,
  };
}

const KIND_NAMES: Record<SessionKind, string> = { session: 'session', 'quick-note': 'quick note' };

// Sessions and quick notes share one microphone and one live engine: only one records at a time.
export function startRefusal(running: SessionKind | null, requested: SessionKind): string | null {
  if (running === null) return null;
  if (running === requested) return `A ${KIND_NAMES[running]} is already recording.`;
  return `Stop the ${KIND_NAMES[running]} before starting a ${KIND_NAMES[requested]}.`;
}

export function parseStartRequest(value: unknown): SessionStartRequest {
  if (typeof value === 'string') return { kind: 'session', folder: value };
  if (value && typeof value === 'object') {
    const request = value as { kind?: unknown; folder?: unknown };
    if (request.kind === 'quick-note') return { kind: 'quick-note' };
    if (request.kind === 'session') {
      return { kind: 'session', folder: typeof request.folder === 'string' ? request.folder : '' };
    }
  }
  return { kind: 'session', folder: '' };
}
