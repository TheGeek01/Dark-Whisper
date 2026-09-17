import type { LibraryDocument, LibrarySearchHit } from '../shared/api.js';
import { ask, confirmAction } from './dialogs.js';
import { byId, el, icon } from './dom.js';
import { formatDate, relativeTime } from './format.js';
import {
  buildTree,
  expandTo,
  folderChoices,
  folderCounts,
  parentFolder,
  pinQuickNotes,
  QUICK_NOTES_FOLDER,
  recentDocuments,
  visibleRows,
  type FolderView,
  type VisibleRow,
} from './libraryTree.js';
import { isSessionRunning } from './sessionModel.js';
import { getState, subscribe, update, type AppState } from './state.js';
import { reportError, toast } from './toast.js';

const LIBRARY_KEYS = new Set<keyof AppState>(['tree', 'expanded', 'selectedFile', 'selectedFolder', 'search']);
const INDENT_PX = 16;
const RECENT_REFRESH_MS = 60_000;

let searchHits: LibrarySearchHit[] | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let focusedRow: string | null = null;
let lastRecording: string | null = null;

interface MenuAction {
  label: string;
  run: () => Promise<void> | void;
  danger?: boolean;
}

const rowKey = (row: VisibleRow) => (row.kind === 'folder' ? `folder:${row.path}` : `doc:${row.file}`);

// The document a session or quick note is writing right now.
export function recordingFile(): string | null {
  const status = getState().session.status;
  return status && isSessionRunning(status) ? status.documentFile : null;
}

export async function reloadTree(): Promise<void> {
  try {
    const tree = await window.api.getLibraryTree();
    const { selectedFile } = getState();
    const gone = selectedFile !== null && !tree.documents.some((d) => d.file === selectedFile);
    update(gone ? { tree, selectedFile: null, document: null } : { tree });
  } catch (error) {
    reportError(error);
  }
}

export function openDocument(file: string, line?: number): void {
  focusedRow = `doc:${file}`;
  update({
    selectedFile: file,
    expanded: expandTo(getState().expanded, parentFolder(file)),
    scrollToLine: line ?? null,
  });
}

function selectFolder(path: string, expand?: boolean): void {
  const expanded = new Set(getState().expanded);
  if (expand === true) expanded.add(path);
  if (expand === false) expanded.delete(path);
  focusedRow = `folder:${path}`;
  update({ selectedFolder: path, expanded });
}

// The tree as shown: Quick Notes is pinned unless a title filter is active.
function libraryRoot(): FolderView | null {
  const { tree, expanded, search } = getState();
  if (!tree) return null;
  const root = buildTree(tree, expanded, search);
  return search.trim() === '' ? pinQuickNotes(root) : root;
}

// ---- Document actions (also used by the document pane)

export async function renameDocument(doc: { file: string; title: string }): Promise<void> {
  const title = await ask({ title: 'Rename document', value: doc.title, confirmLabel: 'Rename' });
  if (title === null || title.trim() === '' || title.trim() === doc.title) return;
  try {
    const next = await window.api.renameDocument(doc.file, title.trim());
    if (getState().selectedFile === doc.file) update({ selectedFile: next });
  } finally {
    await reloadTree();
  }
}

async function moveDocument(doc: LibraryDocument): Promise<void> {
  const tree = getState().tree;
  if (!tree) return;
  const choices = folderChoices(tree).filter((choice) => choice.value !== doc.folder);
  if (choices.length === 0) {
    toast('Create a folder first.');
    return;
  }
  const folder = await ask({ title: `Move "${doc.title}"`, choices, confirmLabel: 'Move' });
  if (folder === null) return;
  try {
    const next = await window.api.moveDocument(doc.file, folder);
    if (getState().selectedFile === doc.file) {
      update({ selectedFile: next, expanded: expandTo(getState().expanded, folder) });
    }
  } finally {
    await reloadTree();
  }
}

async function deleteDocument(doc: LibraryDocument): Promise<void> {
  if (!(await confirmAction('Delete document', `Move "${doc.title}" to the Recycle Bin?`, 'Delete'))) return;
  try {
    await window.api.deleteDocument(doc.file);
    if (getState().selectedFile === doc.file) update({ selectedFile: null, document: null });
  } finally {
    await reloadTree();
  }
}

async function newFolder(): Promise<void> {
  const parent = getState().selectedFolder;
  const name = await ask({ title: parent ? `New folder in ${parent}` : 'New folder', value: '', confirmLabel: 'Create' });
  if (name === null || name.trim() === '') return;
  try {
    const created = await window.api.createFolder(parent, name);
    update({ expanded: expandTo(getState().expanded, created), selectedFolder: created });
    await reloadTree();
  } catch (error) {
    reportError(error);
  }
}

async function chooseVault(): Promise<void> {
  try {
    const chosen = await window.api.chooseVault();
    if (!chosen) return;
    await window.api.saveSettings({ vaultPath: chosen });
    await reloadTree();
  } catch (error) {
    reportError(error);
  }
}

// ---- Menus

function hideMenu(): void {
  byId('rowMenu').hidden = true;
}

function showMenu(anchor: HTMLElement, actions: MenuAction[]): void {
  const menu = byId('rowMenu');
  menu.replaceChildren(
    ...actions.map((action) => {
      const item = el('button', action.danger ? 'menu-item danger' : 'menu-item', action.label);
      item.setAttribute('role', 'menuitem');
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        hideMenu();
        Promise.resolve()
          .then(action.run)
          .catch(reportError);
      });
      return item;
    }),
  );
  const rect = anchor.getBoundingClientRect();
  menu.hidden = false;
  menu.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(rect.bottom + 2, window.innerHeight - menu.offsetHeight - 4))}px`;
  (menu.firstElementChild as HTMLElement | null)?.focus();
}

function showDocumentMenu(doc: LibraryDocument, anchor: HTMLElement): void {
  const recording = doc.file === recordingFile();
  const actions: MenuAction[] = [];
  if (!recording) {
    actions.push({ label: 'Rename…', run: () => renameDocument(doc) });
    actions.push({ label: 'Move to…', run: () => moveDocument(doc) });
  }
  actions.push({ label: 'Open in editor', run: () => window.api.openDocumentExternally(doc.file) });
  actions.push({ label: 'Reveal in Explorer', run: () => window.api.revealLibraryDocument(doc.file) });
  if (!recording) actions.push({ label: 'Delete', run: () => deleteDocument(doc), danger: true });
  showMenu(anchor, actions);
}

function showVaultMenu(): void {
  showMenu(byId('vaultMenuBtn'), [
    { label: 'New folder…', run: () => newFolder() },
    { label: 'Change vault…', run: () => chooseVault() },
    { label: 'Show vault in Explorer', run: () => window.api.openVault() },
  ]);
}

// ---- Rendering

function folderRow(folder: FolderView, counts: ReadonlyMap<string, number>): HTMLElement {
  const { selectedFolder } = getState();
  const key = `folder:${folder.path}`;
  const root = folder.depth === 0;
  const row = el('div', root ? 'row folder root' : 'row folder');
  if (!root) row.style.paddingLeft = `${10 + (folder.depth - 1) * INDENT_PX}px`;
  row.dataset.key = key;
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-expanded', String(folder.expanded));
  row.classList.toggle('target', selectedFolder === folder.path);
  row.classList.toggle('focused', focusedRow === key);
  if (root) {
    row.title = 'New sessions go to the vault root';
    row.append(icon('chevron-down', 'twisty'), el('span', 'name', 'Vault'));
  } else {
    const hasChildren = folder.folders.length > 0 || folder.documents.length > 0;
    const quick = folder.path === QUICK_NOTES_FOLDER;
    row.append(
      icon(folder.expanded ? 'chevron-down' : 'chevron-right', hasChildren ? 'twisty' : 'twisty none'),
      quick ? icon('note', 'kind quick') : icon('folder', 'kind'),
      el('span', 'name', folder.name),
      el('span', 'count', String(counts.get(folder.path) ?? 0)),
    );
  }
  row.addEventListener('click', () => selectFolder(folder.path, root ? undefined : !folder.expanded));
  return row;
}

function documentRow(doc: LibraryDocument, depth: number): HTMLElement {
  const key = `doc:${doc.file}`;
  const row = el('div', 'row doc');
  row.style.paddingLeft = `${10 + Math.max(0, depth - 1) * INDENT_PX}px`;
  row.dataset.key = key;
  row.setAttribute('role', 'treeitem');
  row.classList.toggle('selected', getState().selectedFile === doc.file);
  row.classList.toggle('focused', focusedRow === key);
  row.append(icon('file', 'kind'));
  const name = el('span', 'name', doc.title);
  name.title = doc.file;
  row.append(name);
  if (doc.file === recordingFile()) {
    const dot = el('span', 'dot rec rec-dot');
    dot.title = 'Recording';
    row.append(dot);
  }
  if (!doc.readable) {
    const warn = el('span', 'warn', '⚠');
    warn.title = 'This file could not be read';
    row.append(warn);
  }
  const menu = el('button', 'icon row-menu');
  menu.title = 'Actions';
  menu.append(icon('more'));
  menu.addEventListener('click', (event) => {
    event.stopPropagation();
    showDocumentMenu(doc, menu);
  });
  row.append(el('span', 'date', formatDate(doc.created, doc.mtimeMs)), menu);
  row.addEventListener('click', () => openDocument(doc.file));
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    showDocumentMenu(doc, row);
  });
  return row;
}

function folderRows(folder: FolderView, counts: ReadonlyMap<string, number>): HTMLElement[] {
  const rows = [folderRow(folder, counts)];
  if (!folder.expanded) return rows;
  for (const child of folder.folders) rows.push(...folderRows(child, counts));
  for (const doc of folder.documents) rows.push(documentRow(doc, folder.depth + 1));
  return rows;
}

function recentRows(): HTMLElement[] {
  const { tree, selectedFile } = getState();
  if (!tree || tree.documents.length === 0) return [];
  const now = Date.now();
  const title = el('div', 'section-title');
  title.append(icon('clock'), el('span', '', 'Recent'));
  const rows = recentDocuments(tree).map((doc) => {
    const row = el('div', 'row recent');
    row.dataset.recent = doc.file;
    row.classList.toggle('selected', selectedFile === doc.file);
    const name = el('span', 'name', doc.title);
    name.title = doc.file;
    row.append(icon('file', 'kind'), name, el('span', 'date', relativeTime(doc.mtimeMs, now)));
    row.addEventListener('click', () => openDocument(doc.file));
    return row;
  });
  return [title, ...rows];
}

function hitRows(hits: LibrarySearchHit[]): HTMLElement[] {
  if (hits.length === 0) return [el('p', 'muted pad', 'No matches')];
  const titles = new Map((getState().tree?.documents ?? []).map((d) => [d.file, d.title]));
  return hits.map((hit) => {
    const row = el('div', 'row hit');
    row.append(el('span', 'name', titles.get(hit.file) ?? hit.file), el('span', 'snippet', hit.text));
    row.addEventListener('click', () => openDocument(hit.file, hit.line));
    return row;
  });
}

function renderFooter(): void {
  const { tree, selectedFolder } = getState();
  const count = tree?.documents.length ?? 0;
  byId('docCount').textContent = `${count} ${count === 1 ? 'document' : 'documents'}`;
  const button = byId<HTMLButtonElement>('newSessionBtn');
  button.title = `Start a session in ${selectedFolder || 'the vault root'}`;
  button.disabled = recordingFile() !== null || tree?.exists === false;
}

function renderLibrary(): void {
  const body = byId('libraryBody');
  const { tree, search } = getState();
  renderFooter();
  if (!tree) {
    body.replaceChildren(el('p', 'muted pad', 'Loading…'));
    return;
  }
  if (!tree.exists) {
    const choose = el('button', 'btn', 'Choose folder…');
    choose.addEventListener('click', () => void chooseVault());
    body.replaceChildren(el('p', 'pad', `Vault not found: ${tree.root}`), choose);
    return;
  }
  if (searchHits) {
    body.replaceChildren(...hitRows(searchHits));
    return;
  }
  const root = libraryRoot() as FolderView;
  body.replaceChildren(...folderRows(root, folderCounts(tree)));
  const filtering = search.trim() !== '';
  if (tree.documents.length === 0) {
    body.append(el('p', 'muted pad', 'No documents yet. Start a session or a quick note to begin.'));
  } else if (filtering && root.folders.length === 0 && root.documents.length === 0) {
    body.append(el('p', 'muted pad', 'No matches'));
  }
  if (!filtering) body.append(...recentRows());
}

// ---- Search

function searchInput(): HTMLInputElement {
  return byId<HTMLInputElement>('librarySearch');
}

async function runSearch(query: string): Promise<void> {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = null;
  if (query.trim() === '') return;
  try {
    const hits = await window.api.searchLibrary(query);
    if (searchInput().value !== query) return; // superseded by further typing
    searchHits = hits;
    renderLibrary();
  } catch (error) {
    reportError(error);
  }
}

function onSearchInput(): void {
  const query = searchInput().value;
  searchHits = null;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = query.trim().length >= 2 ? setTimeout(() => void runSearch(query), 300) : null;
  update({ search: query });
}

// ---- Keyboard

function onTreeKey(event: KeyboardEvent): void {
  const { tree } = getState();
  const root = libraryRoot();
  if (!tree || !root || searchHits) return;
  const rows = visibleRows(root);
  const keys = rows.map(rowKey);
  const index = focusedRow ? keys.indexOf(focusedRow) : -1;
  const row = rows[index];
  const doc = row?.kind === 'document' ? tree.documents.find((d) => d.file === row.file) : undefined;

  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      const next = event.key === 'ArrowDown' ? Math.min(rows.length - 1, index + 1) : Math.max(0, index - 1);
      focusedRow = keys[next] ?? null;
      renderLibrary();
      byId('libraryBody').querySelector('.focused')?.scrollIntoView({ block: 'nearest' });
      break;
    }
    case 'ArrowRight':
      if (row?.kind === 'folder') selectFolder(row.path, true);
      break;
    case 'ArrowLeft':
      if (row?.kind === 'folder' && row.depth > 0) selectFolder(row.path, false);
      else if (row?.kind === 'document') selectFolder(parentFolder(row.file));
      break;
    case 'Enter':
      if (row?.kind === 'document') openDocument(row.file);
      else if (row) selectFolder(row.path, true);
      break;
    case 'F2':
      if (doc && doc.file !== recordingFile()) renameDocument(doc).catch(reportError);
      break;
    case 'Delete':
      if (doc && doc.file !== recordingFile()) deleteDocument(doc).catch(reportError);
      break;
    case 'ContextMenu':
    case 'F10': {
      if (event.key === 'F10' && !event.shiftKey) return;
      if (!doc) return;
      const anchor = byId('libraryBody').querySelector<HTMLElement>(`[data-key="doc:${doc.file}"]`);
      if (anchor) showDocumentMenu(doc, anchor);
      break;
    }
    default:
      return;
  }
  event.preventDefault();
}

// ---- Wiring

export function initLibrary(): void {
  const search = searchInput();
  search.addEventListener('input', onSearchInput);
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void runSearch(search.value);
    if (event.key === 'Escape') {
      search.value = '';
      onSearchInput();
    }
  });
  byId('libraryBody').addEventListener('keydown', onTreeKey);
  byId('newSessionBtn').addEventListener('click', () => {
    window.api.startSession({ kind: 'session', folder: getState().selectedFolder }).catch(reportError);
  });
  byId('vaultMenuBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    showVaultMenu();
  });
  document.addEventListener('click', hideMenu);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideMenu();
    const key = event.key.toLowerCase();
    if (event.ctrlKey && (key === 'f' || key === 'k')) {
      event.preventDefault();
      search.focus();
      search.select();
    }
  });
  window.api.onLibraryChanged(({ paths }) => {
    // Main sends an empty paths list after the vault setting changes: the old tree's folders
    // no longer mean anything, so drop the selected folder and expansion state before reloading.
    if (paths.length === 0) update({ selectedFolder: '', expanded: new Set() });
    void reloadTree();
  });
  // "2m ago" goes stale.
  setInterval(() => {
    if (!searchHits && getState().search.trim() === '') renderLibrary();
  }, RECENT_REFRESH_MS);

  subscribe((_state, changed) => {
    const recording = recordingFile();
    const recordingChanged = recording !== lastRecording;
    lastRecording = recording;
    if (recordingChanged && recording) {
      // A new run's document: show it (the watcher may not have reported it yet).
      void reloadTree().then(() => openDocument(recording));
    }
    if (recordingChanged || [...changed].some((key) => LIBRARY_KEYS.has(key))) renderLibrary();
    else if (changed.has('session')) renderFooter();
  });

  renderLibrary();
  void reloadTree();
}
