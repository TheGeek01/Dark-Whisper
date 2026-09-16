import type { DocumentContent, LibraryTree } from '../shared/api.js';
import { emptySessionModel, type SessionModel } from './sessionModel.js';

export interface AppState {
  tree: LibraryTree | null;
  expanded: Set<string>;
  selectedFile: string | null;
  selectedFolder: string; // target folder for the next session
  document: DocumentContent | null;
  session: SessionModel;
  search: string;
  scrollToLine: number | null;
  scrollToBlock: number | null;
}

type Listener = (state: AppState, changed: ReadonlySet<keyof AppState>) => void;

const state: AppState = {
  tree: null,
  expanded: new Set(),
  selectedFile: null,
  selectedFolder: '',
  document: null,
  session: emptySessionModel(),
  search: '',
  scrollToLine: null,
  scrollToBlock: null,
};

const listeners = new Set<Listener>();

export function getState(): AppState {
  return state;
}

export function update(patch: Partial<AppState>): void {
  const changed = new Set(Object.keys(patch) as (keyof AppState)[]);
  Object.assign(state, patch);
  for (const listener of listeners) listener(state, changed);
}

export function subscribe(listener: Listener): void {
  listeners.add(listener);
}
