// Types shared by the main process, the preload bridge and the renderer.
// Types only, importing nothing but other shared/ modules: the renderer build must never pull in
// main-process modules.

import type { ShortcutAction, ShortcutResult } from './shortcuts';

export type ServerMode = 'builtin' | 'external';
export type RefineMode = 'auto' | 'always' | 'afterStop';
export type ThemeName = 'dark' | 'light';

export interface ServerStatusView {
  state: 'no-model' | 'starting' | 'ready' | 'error' | 'stopped';
  mode: ServerMode;
  text: string;
  modelId: string | null;
  gpu: boolean;
  vad: boolean;
  message?: string;
}

export interface ModelEntryView {
  id: string;
  name: string;
  label: string;
  sizeBytes: number | null;
  installed: boolean;
  custom: boolean;
  recommended: boolean;
}

export interface ModelListView {
  models: ModelEntryView[];
  activeModelId: string | null;
  downloading: boolean;
  disk: { usedBytes: number; freeBytes: number };
}

export interface DownloadProgressView {
  id: string;
  receivedBytes: number;
  totalBytes: number | null;
  bytesPerSec: number;
  state: 'downloading' | 'verifying' | 'done' | 'error' | 'cancelled';
  error?: string;
}

export interface SettingsView {
  shortcut: string;
  recordShortcut: string;
  pauseShortcut: string;
  stopShortcut: string;
  apiUrl: string;
  apiToken: string;
  serverMode: ServerMode;
  modelId: string | null;
  forceCpu: boolean;
  liveModelId: string;
  language: string;
  vaultPath: string;
  refineDuringRecording: RefineMode;
  refineWithExternalApi: boolean;
  refineVad: boolean;
  blockMinutes: number;
  keepSessionAudio: boolean;
  silenceGapSeconds: number;
  theme: ThemeName;
  captureDeviceName: string;
}

export interface CaptureDeviceView {
  index: number;
  name: string;
}

export type SessionState = 'idle' | 'starting' | 'recording' | 'paused' | 'stopped' | 'error';
export type BlockState = 'live' | 'empty' | 'queued' | 'refining' | 'refined' | 'removed' | 'skipped' | 'failed';
export type SessionKind = 'session' | 'quick-note';
export type SessionStartRequest = { kind: 'session'; folder: string } | { kind: 'quick-note' };

export interface BlockEvent {
  sessionId: string;
  blockIndex: number;
  startSec: number;
  endSec: number;
  clock: string; // the block's clock line, e.g. **14:32**; '' when unknown
  state: BlockState;
  message?: string;
}

export interface SessionStatusView {
  sessionId: string | null;
  kind: SessionKind;
  state: SessionState;
  documentPath: string | null; // absolute
  documentFile: string | null; // relative to the vault the session was started in
  folder: string; // relative target folder, '' = vault root
  blockIndex: number;
  durationSec: number;
  refining: number;
  message?: string;
  muted: boolean | null;
  microphone: string;
  liveModel: string;
  refineModel: string;
  messages: string[]; // newest first
  blocks: BlockEvent[]; // latest event per block, by blockIndex
  // Recordings that stopped before this one and are still refining.
  earlier: EarlierRun[];
}

export interface EarlierRun {
  sessionId: string;
  documentFile: string; // relative to the vault it was started in
  blocks: BlockEvent[];
}

export interface SegmentEvent {
  text: string;
  blockIndex: number;
}

export interface FolderNode {
  path: string;
  name: string;
  children: FolderNode[];
}

export interface LibraryDocument {
  file: string;
  folder: string;
  title: string;
  created: string;
  mtimeMs: number;
  readable: boolean;
}

export interface LibraryTree {
  root: string; // absolute, for display
  exists: boolean;
  folders: FolderNode[];
  documents: LibraryDocument[];
}

export interface LibrarySearchHit {
  file: string;
  line: number;
  text: string;
}

export interface DocumentContent {
  file: string;
  content: string;
  mtimeMs: number;
}

export interface LibraryChange {
  paths: string[];
}

export interface DarkWhisperApi {
  // Errors raised outside a renderer call (e.g. the Quick Note shortcut)
  onError(callback: (data: { message: string }) => void): void;
  copyText(text: string): Promise<void>;
  // Settings, server, models
  getSettings(): Promise<SettingsView>;
  // Saving re-registers the global shortcuts and reports how each one went.
  saveSettings(settings: Partial<SettingsView>): Promise<{ success: boolean; shortcuts: Record<ShortcutAction, ShortcutResult> }>;
  getShortcutStatus(): Promise<Record<ShortcutAction, ShortcutResult>>;
  // While a Settings field records keys, the global shortcuts must not swallow them.
  suspendShortcuts(suspended: boolean): void;
  // The Record shortcut starts a session in the folder selected in the sidebar.
  setSelectedFolder(folder: string): void;
  getServerStatus(): Promise<ServerStatusView>;
  restartServer(): Promise<void>;
  openServerLog(): Promise<void>;
  listModels(): Promise<ModelListView>;
  downloadModel(id: string): Promise<void>;
  downloadCustomModel(url: string): Promise<void>;
  cancelDownload(): Promise<void>;
  deleteModel(id: string): Promise<void>;
  selectModel(id: string): Promise<void>;
  onServerStatus(callback: (status: ServerStatusView) => void): void;
  onDownloadProgress(callback: (progress: DownloadProgressView) => void): void;
  onOpenModels(callback: () => void): void;
  // Sessions
  startSession(request: SessionStartRequest): Promise<SessionStatusView>;
  toggleQuickNote(): Promise<void>;
  pauseSession(): Promise<void>;
  resumeSession(): Promise<void>;
  stopSession(): Promise<void>;
  getSessionStatus(): Promise<SessionStatusView>;
  listCaptureDevices(): Promise<CaptureDeviceView[]>;
  openVault(): Promise<void>;
  revealDocument(): Promise<void>;
  onSessionStatus(callback: (view: SessionStatusView) => void): void;
  onSessionSegment(callback: (segment: SegmentEvent) => void): void;
  onSessionBlock(callback: (event: BlockEvent) => void): void;
  onSessionLevel(callback: (level: number) => void): void;
  // Library
  getLibraryTree(): Promise<LibraryTree>;
  searchLibrary(query: string): Promise<LibrarySearchHit[]>;
  readDocument(file: string): Promise<DocumentContent>;
  renameDocument(file: string, title: string): Promise<string>;
  moveDocument(file: string, folder: string): Promise<string>;
  deleteDocument(file: string): Promise<void>;
  createFolder(parent: string, name: string): Promise<string>;
  openDocumentExternally(file: string): Promise<void>;
  revealLibraryDocument(file: string): Promise<void>;
  chooseVault(): Promise<string | null>;
  onLibraryChanged(callback: (change: LibraryChange) => void): void;
}
