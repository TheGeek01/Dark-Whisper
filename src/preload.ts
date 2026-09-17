import { contextBridge, ipcRenderer } from 'electron';
import type { DarkWhisperApi } from './shared/api';

function on<T>(channel: string, callback: (payload: T) => void): void {
  ipcRenderer.on(channel, (_event, payload: T) => callback(payload));
}

const api: DarkWhisperApi = {
  onError: (callback) => on('error', callback),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),

  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  getServerStatus: () => ipcRenderer.invoke('get-server-status'),
  restartServer: () => ipcRenderer.invoke('restart-server'),
  openServerLog: () => ipcRenderer.invoke('open-server-log'),
  listModels: () => ipcRenderer.invoke('list-models'),
  downloadModel: (id) => ipcRenderer.invoke('download-model', id),
  downloadCustomModel: (url) => ipcRenderer.invoke('download-custom-model', url),
  cancelDownload: () => ipcRenderer.invoke('cancel-download'),
  deleteModel: (id) => ipcRenderer.invoke('delete-model', id),
  selectModel: (id) => ipcRenderer.invoke('select-model', id),
  onServerStatus: (callback) => on('server-status', callback),
  onDownloadProgress: (callback) => on('download-progress', callback),
  onOpenModels: (callback) => on('open-models', () => callback()),

  startSession: (request) => ipcRenderer.invoke('session-start', request),
  toggleQuickNote: () => ipcRenderer.invoke('quick-note-toggle'),
  pauseSession: () => ipcRenderer.invoke('session-pause'),
  resumeSession: () => ipcRenderer.invoke('session-resume'),
  stopSession: () => ipcRenderer.invoke('session-stop'),
  getSessionStatus: () => ipcRenderer.invoke('session-status'),
  listCaptureDevices: () => ipcRenderer.invoke('list-capture-devices'),
  openVault: () => ipcRenderer.invoke('open-vault'),
  revealDocument: () => ipcRenderer.invoke('reveal-document'),
  onSessionStatus: (callback) => on('session-status', callback),
  onSessionSegment: (callback) => on('session-segment', callback),
  onSessionBlock: (callback) => on('session-block', callback),
  onSessionLevel: (callback) => on('session-level', callback),

  getLibraryTree: () => ipcRenderer.invoke('library-tree'),
  searchLibrary: (query) => ipcRenderer.invoke('library-search', query),
  readDocument: (file) => ipcRenderer.invoke('document-read', file),
  renameDocument: (file, title) => ipcRenderer.invoke('document-rename', file, title),
  moveDocument: (file, folder) => ipcRenderer.invoke('document-move', file, folder),
  deleteDocument: (file) => ipcRenderer.invoke('document-delete', file),
  createFolder: (parent, name) => ipcRenderer.invoke('folder-create', parent, name),
  openDocumentExternally: (file) => ipcRenderer.invoke('document-open-external', file),
  revealLibraryDocument: (file) => ipcRenderer.invoke('document-reveal', file),
  chooseVault: () => ipcRenderer.invoke('choose-vault'),
  onLibraryChanged: (callback) => on('library-changed', callback),
};

contextBridge.exposeInMainWorld('api', api);

declare global {
  interface Window {
    api: DarkWhisperApi;
  }
}
