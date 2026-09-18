import { BrowserWindow, dialog, ipcMain, OpenDialogOptions, shell } from 'electron';
import * as fs from 'fs';
import type { LibraryChange } from '../shared/api';
import { LibraryService } from './libraryService';
import { ChangeBatcher, diffSnapshots, isHiddenPath, Snapshot, snapshotTree } from './libraryWatch';
import { addSessionNotice, clearSessionNotice, documentMoved, isRecordingDocument } from './sessionRuntime';
import { getSettings } from './settingsService';

const DEBOUNCE_MS = 300;
const POLL_MS = 5000;
export const POLLING_NOTICE = `Watching the vault by polling every ${POLL_MS / 1000} s`;

const changeListeners = new Set<(change: LibraryChange) => void>();
let watcher: fs.FSWatcher | null = null;
let poller: ReturnType<typeof setInterval> | null = null;
let watchedVault: string | null = null;

function notify(paths: string[]): void {
  for (const l of changeListeners) l({ paths });
}

const batcher = new ChangeBatcher(DEBOUNCE_MS, notify);

function library(): LibraryService {
  return new LibraryService(getSettings().vaultPath);
}

export function onLibraryChanged(listener: (change: LibraryChange) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export function stopWatching(): void {
  batcher.cancel();
  watcher?.close();
  watcher = null;
  if (poller) clearInterval(poller);
  poller = null;
  watchedVault = null;
}

// Recursive fs.watch is unreliable on network drives and some sync folders (and throws when the
// vault does not exist yet); polling the tree is the fallback.
function startPolling(vault: string, reason: unknown): void {
  watcher?.close();
  watcher = null;
  const detail = reason instanceof Error ? reason.message : String(reason);
  console.warn(`Vault watcher unavailable for ${vault}; polling instead: ${detail}`);
  addSessionNotice(POLLING_NOTICE);
  const service = new LibraryService(vault);
  let previous: Snapshot | null = null;
  let scanning = false;
  // A slow vault can take longer than POLL_MS to scan: never run two scans at once, and drop a
  // scan that finishes after polling stopped (the vault setting changed).
  const poll = async (timer: ReturnType<typeof setInterval>) => {
    if (scanning) return;
    scanning = true;
    try {
      const next = snapshotTree(await service.tree());
      if (poller !== timer) return;
      const changed = previous ? diffSnapshots(previous, next) : [];
      previous = next;
      if (changed.length > 0) notify(changed);
    } catch (error) {
      console.error('Could not poll the vault:', error);
    } finally {
      scanning = false;
    }
  };
  const timer = setInterval(() => void poll(timer), POLL_MS);
  poller = timer;
  void poll(timer);
}

// Starts watching the configured vault, or restarts when the vault setting changed.
export function watchVault(): void {
  const vault = getSettings().vaultPath;
  if (vault === watchedVault) return;
  stopWatching();
  watchedVault = vault;
  try {
    watcher = fs.watch(vault, { recursive: true }, (_event, filename) => {
      if (filename && isHiddenPath(String(filename))) return;
      batcher.add(filename ? String(filename) : '');
    });
    watcher.on('error', (error) => startPolling(vault, error));
    clearSessionNotice(POLLING_NOTICE);
  } catch (error) {
    startPolling(vault, error);
  }
}

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be text`);
  return value;
}

function unlockedDocument(service: LibraryService, file: string): string {
  const absolute = service.resolve(file, 'document');
  if (isRecordingDocument(absolute)) {
    throw new Error('This document is being recorded. Stop recording first.');
  }
  return absolute;
}

export function registerLibraryIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('library-tree', () => library().tree());

  ipcMain.handle('library-search', (_event, query: unknown) => library().search(asString(query, 'query')));

  ipcMain.handle('document-read', (_event, file: unknown) => library().read(asString(file, 'file')));

  ipcMain.handle('document-rename', (_event, file: unknown, title: unknown) => {
    const service = library();
    const from = unlockedDocument(service, asString(file, 'file'));
    const next = service.rename(asString(file, 'file'), asString(title, 'title'));
    documentMoved(from, service.resolve(next, 'document'));
    return next;
  });

  ipcMain.handle('document-move', (_event, file: unknown, folder: unknown) => {
    const service = library();
    const from = unlockedDocument(service, asString(file, 'file'));
    const next = service.move(asString(file, 'file'), asString(folder, 'folder'));
    documentMoved(from, service.resolve(next, 'document'));
    return next;
  });

  ipcMain.handle('document-delete', async (_event, file: unknown) => {
    const absolute = unlockedDocument(library(), asString(file, 'file'));
    await shell.trashItem(absolute);
  });

  ipcMain.handle('folder-create', (_event, parent: unknown, name: unknown) =>
    library().createFolder(asString(parent, 'parent'), asString(name, 'name')),
  );

  ipcMain.handle('document-open-external', async (_event, file: unknown) => {
    const failure = await shell.openPath(library().resolve(asString(file, 'file'), 'document'));
    if (failure) throw new Error(failure);
  });

  ipcMain.handle('document-reveal', (_event, file: unknown) => {
    shell.showItemInFolder(library().resolve(asString(file, 'file'), 'document'));
  });

  ipcMain.handle('choose-vault', async () => {
    const options: OpenDialogOptions = {
      title: 'Choose the vault folder',
      defaultPath: getSettings().vaultPath,
      properties: ['openDirectory', 'createDirectory'],
    };
    const window = getWindow();
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });
}
