# Dark-Whisper Three-Pane Workspace Implementation Plan (Stage 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-column window and the temporary session strip with a workspace: a vault library (folders, search), a read-only document view that follows a live session, and a session panel with per-block refinement state.

**Architecture:** The renderer moves to vanilla TypeScript under `src/renderer/`, compiled by a second tsconfig to ES modules in `public/js/`. View logic lives in DOM-free modules tested by Jest; thin DOM modules render the panes from one state object. The main process gains an Electron-free `libraryService` (vault tree, folders, moves, path guard), a `libraryWatch` helper (debounce, polling diff), and a `libraryRuntime` that wires IPC and the vault watcher. `sessionRuntime` gains a target folder, block events and a richer status view.

**Tech Stack:** Electron 44, TypeScript 6 (main: CommonJS `node20`; renderer: ES2022 modules), Jest 30 + ts-jest, `marked` 18.0.13 and `dompurify` 3.4.15 loaded as classic scripts (UMD globals).

**Spec:** `docs/superpowers/specs/2026-09-16-dark-whisper-workspace-design.md` (builds on `2026-09-15-dark-whisper-live-sessions-design.md`).

**Verified before writing this plan:** ES module scripts load from `file://` in Electron 44 under `script-src 'self'`; `marked.umd.js` and `purify.min.js` expose `marked` and `DOMPurify` as globals under the same CSP, and `DOMPurify.sanitize(marked.parse(...))` strips `onerror`. No bundler is needed.

## Global Constraints

- **Commits:** one commit per task, authored with `git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit`, message ending with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Work on a branch `feature/workspace` created from `main`. Never push.
- **Verification after every task:** `npm run build`, `npm test`, `npm run lint` (0 errors; the 23 pre-existing warnings may remain, no new ones).
- Jest cannot load Electron: files under `src/__tests__/` must never import `electron`, `electron-store`, `settingsService`, `whisperRuntime`, `streamRuntime`, `sessionRuntime`, `libraryRuntime`, `appIdentity` or `main`.
- **Renderer rules:**
  - `src/renderer/` and `src/shared/` may import only each other; imports use `.js` extensions (`import { x } from './format.js'`); types use `import type`.
  - Pure renderer modules (`format`, `libraryTree`, `documentView`, `sessionModel`, `state`) must not touch `window`/`document` and must only use ES2020 library features (they are also compiled by the main tsconfig through the tests).
  - `src/shared/api.ts` contains types only and imports nothing.
  - The only `innerHTML` assignment in `src/renderer/` is in `document.ts`, and it takes `DOMPurify.sanitize(...)` output.
  - `public/index.html` contains no inline `style` attributes and no inline scripts (CSP: `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'`).
- All `file`/`folder` values crossing IPC are relative to the vault with forward slashes; `''` is the vault root.
- Hidden entries (names starting with `.`, e.g. `.obsidian`, `.trash`) are not part of the library.
- Delete moves files to the Recycle Bin (`shell.trashItem`). Rename, move and delete of the document a session is recording are refused.
- Window: 1200×760 default, 900×560 minimum, still starts hidden.
- **Live app checks** use `scripts/dev-cdp.mjs` (Task 5) against `npx electron . --remote-debugging-port=9333`. Point the vault at a temporary folder for the check and restore the original `vaultPath` afterwards. **Never leave a session paused**: pausing mutes the real Windows microphone. Stop the test instance only by its own PID tree (`taskkill /PID <pid> /T /F`); an installed copy of the app may be running and must not be touched.
- npm 12 on the dev machine skips dependency install scripts: if `node_modules/node-mic/sox-win32/sox.exe` is missing after an install, run `node scripts/postinstall.js` inside `node_modules/node-mic`; run `npx install-electron` if `node_modules/electron/dist/electron.exe` is missing.

## File Map

| File | Status | Responsibility |
|---|---|---|
| `tsconfig.renderer.json` | Create | Renderer build: `src/renderer` + `src/shared` → `public/js` (ES2022 modules, DOM lib) |
| `scripts/copy-vendor.js` | Create | Copy `marked.umd.js` and `purify.min.js` to `public/vendor/` |
| `src/shared/api.ts` | Create | Types shared by main, preload and renderer; `DarkWhisperApi` |
| `src/services/sharedTypeChecks.ts` | Create | Compile-time check that main-process types match the shared shapes |
| `src/services/libraryService.ts` | Create | Electron-free vault access: tree, search, read, rename, move, folders, path guard |
| `src/services/libraryWatch.ts` | Create | `ChangeBatcher` (debounce) and snapshot diffing for polling |
| `src/services/libraryRuntime.ts` | Create | Library IPC, vault watcher with polling fallback, trash/open/reveal, vault picker |
| `src/services/sessionService.ts` | Modify | Block lifecycle events; `setDocumentPath` |
| `src/services/documentStore.ts` | Modify | `createDocument` takes a folder |
| `src/services/sessionRuntime.ts` | Modify | Target folder, block events, notices, richer status, rename/move retargeting |
| `src/main.ts` | Modify | Window size and navigation guard, library wiring, `copy-text`, session-start folder, vault-change rule |
| `src/preload.ts` | Modify | Typed `DarkWhisperApi` bridge |
| `src/renderer/globals.d.ts` | Create | `window.api`, `marked`, `DOMPurify` declarations |
| `src/renderer/format.ts` | Create | Pure: clock, bytes, dates, IPC error text |
| `src/renderer/libraryTree.ts` | Create | Pure: tree view model, filter, visible rows, move targets |
| `src/renderer/documentView.ts` | Create | Pure: frontmatter/blocks/gaps split, live-text merge, captions |
| `src/renderer/sessionModel.ts` | Create | Pure: session status, block states, pending live text |
| `src/renderer/state.ts` | Create | The app state object and change subscription |
| `src/renderer/dom.ts` | Create | `byId`, `el` helpers |
| `src/renderer/toast.ts` | Create | Toast notifications |
| `src/renderer/dialogs.ts` | Create | Ask/confirm dialog, Settings dialog, Models dialog |
| `src/renderer/header.ts` | Create | Server status, quick dictation, session controls |
| `src/renderer/library.ts` | Create | Library pane, row menu, document actions, keyboard |
| `src/renderer/document.ts` | Create | Document pane: render, follow live text, reload rules |
| `src/renderer/sessionPanel.ts` | Create | Session panel |
| `src/renderer/app.ts` | Create | Entry point |
| `public/index.html` | Rewrite | Markup only |
| `public/app.css` | Create | Dark theme |
| `scripts/dev-cdp.mjs` | Create | Evaluate an expression in the running app over CDP |
| `scripts/workspace-smoke.mjs` | Create | End-to-end smoke test of the workspace |
| `package.json`, `jest.config.js`, `eslint.config.js`, `tsconfig.json`, `electron-builder.yml`, `.gitignore` | Modify | Build and test plumbing |
| `README.md`, `QUICKSTART.md`, `DEVELOPMENT.md`, `SETUP_SUMMARY.txt`, `.claude` | Modify | Documentation |

---

### Task 1: Renderer build pipeline and shared types

**Files:**
- Create: `tsconfig.renderer.json`, `scripts/copy-vendor.js`, `src/shared/api.ts`, `src/services/sharedTypeChecks.ts`, `src/renderer/globals.d.ts`, `src/renderer/format.ts`
- Modify: `package.json`, `tsconfig.json`, `jest.config.js`, `eslint.config.js`, `electron-builder.yml`, `.gitignore`
- Test: `src/__tests__/format.test.ts`

**Interfaces:**
- Produces: every type in `src/shared/api.ts` (below, used by all later tasks); `formatClock(totalSec: number): string`, `formatBytes(bytes: number | null | undefined): string`, `formatDate(iso: string, fallbackMs: number): string`, `cleanIpcError(error: unknown): string`; the `build:renderer` script.

- [ ] **Step 1: Branch and dependencies**

```bash
git checkout -b feature/workspace
npm install --save-dev marked@18.0.13 dompurify@3.4.15
```

- [ ] **Step 2: Write the failing test**

Create `src/__tests__/format.test.ts`:

```ts
import { cleanIpcError, formatBytes, formatClock, formatDate } from '../renderer/format';

describe('formatClock', () => {
  it('formats minutes and seconds, adding hours only when needed', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(75)).toBe('01:15');
    expect(formatClock(59.9)).toBe('00:59');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(-5)).toBe('00:00');
  });
});

describe('formatBytes', () => {
  it('uses the largest sensible unit', () => {
    expect(formatBytes(null)).toBe('');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(574_041_195)).toBe('547 MB');
  });
});

describe('formatDate', () => {
  it('shows local date and time, falling back to the file time', () => {
    expect(formatDate(new Date(2026, 8, 16, 7, 6).toISOString(), 0)).toBe('2026-09-16 07:06');
    expect(formatDate('', new Date(2026, 0, 2, 3, 4).getTime())).toBe('2026-01-02 03:04');
    expect(formatDate('not a date', new Date(2026, 0, 2, 3, 4).getTime())).toBe('2026-01-02 03:04');
  });
});

describe('cleanIpcError', () => {
  it('strips the Electron IPC prefix', () => {
    const error = new Error("Error invoking remote method 'session-start': Error: A session is already recording");
    expect(cleanIpcError(error)).toBe('A session is already recording');
    expect(cleanIpcError('plain')).toBe('plain');
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx jest src/__tests__/format.test.ts`
Expected: FAIL — `Cannot find module '../renderer/format'`.

- [ ] **Step 4: Write `src/renderer/format.ts`**

```ts
// Pure formatting helpers shared by the renderer panes.

export function formatClock(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const hours = Math.floor(sec / 3600);
  const minutes = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const seconds = String(sec % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDate(iso: string, fallbackMs: number): string {
  const parsed = Date.parse(iso);
  const date = new Date(Number.isNaN(parsed) ? fallbackMs : parsed);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function cleanIpcError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
```

- [ ] **Step 5: Write `src/shared/api.ts`**

```ts
// Types shared by the main process, the preload bridge and the renderer.
// Types only, and no imports: the renderer build must never pull in main-process modules.

export type ServerMode = 'builtin' | 'external';
export type RefineMode = 'auto' | 'always' | 'afterStop';

export interface ServerStatusView {
  state: 'no-model' | 'starting' | 'ready' | 'error' | 'stopped';
  mode: ServerMode;
  text: string;
  modelId: string | null;
  gpu: boolean;
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
  apiUrl: string;
  apiToken: string;
  autoMuteAudio: boolean;
  micDevice: string;
  serverMode: ServerMode;
  modelId: string | null;
  forceCpu: boolean;
  liveModelId: string;
  language: string;
  vaultPath: string;
  refineDuringRecording: RefineMode;
  refineWithExternalApi: boolean;
  blockMinutes: number;
  keepSessionAudio: boolean;
  timestampHeadings: boolean;
  captureDeviceName: string;
}

export interface CaptureDeviceView {
  index: number;
  name: string;
}

export type SessionState = 'idle' | 'starting' | 'recording' | 'paused' | 'stopped' | 'error';
export type BlockState = 'live' | 'empty' | 'queued' | 'refining' | 'refined' | 'skipped' | 'failed';

export interface BlockEvent {
  sessionId: string;
  blockIndex: number;
  startSec: number;
  endSec: number;
  state: BlockState;
  message?: string;
}

export interface SessionStatusView {
  sessionId: string | null;
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
  // Quick dictation
  onTranscriptionComplete(callback: (data: { transcription: string }) => void): void;
  onError(callback: (data: { message: string }) => void): void;
  onRecordingStarted(callback: () => void): void;
  onRecordingStopped(callback: () => void): void;
  getStatus(callback: (data: { isRecording: boolean }) => void): void;
  startRecording(): Promise<void>;
  stopRecording(): Promise<void>;
  copyToClipboard(): Promise<{ success: boolean; message?: string }>;
  copyText(text: string): Promise<void>;
  // Settings, server, models
  getSettings(): Promise<SettingsView>;
  saveSettings(settings: Partial<SettingsView>): Promise<{ success: boolean }>;
  getAudioDevices(): Promise<Array<{ id: string; name: string }>>;
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
  startSession(folder?: string): Promise<SessionStatusView>;
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
```

- [ ] **Step 6: Write `src/services/sharedTypeChecks.ts`**

```ts
// Compile-time only: the build fails if a main-process type drifts from the shape the renderer relies on.
import type {
  DownloadProgressView,
  ModelEntryView,
  ServerStatusView as SharedServerStatusView,
  SettingsView,
} from '../shared/api';
import type { DownloadProgress, ModelEntry } from './modelManager';
import type { ServerStatusView } from './serverGate';
import type { Settings } from './settingsService';

type Assignable<From, To> = From extends To ? true : false;

export type SharedTypeChecks = [
  Assignable<ModelEntry, ModelEntryView>,
  Assignable<DownloadProgress, DownloadProgressView>,
  Assignable<ServerStatusView, SharedServerStatusView>,
  Assignable<Settings, SettingsView>,
];

export const sharedTypeChecks: SharedTypeChecks = [true, true, true, true];
```

- [ ] **Step 7: Write `src/renderer/globals.d.ts`**

```ts
import type { DarkWhisperApi } from '../shared/api.js';

// marked and DOMPurify are loaded as classic scripts by public/index.html (UMD globals).
declare global {
  interface Window {
    api: DarkWhisperApi;
  }
  const marked: {
    parse(markdown: string, options?: { async?: false; gfm?: boolean; breaks?: boolean }): string;
  };
  const DOMPurify: {
    sanitize(dirty: string, config?: Record<string, unknown>): string;
  };
}

export {};
```

- [ ] **Step 8: Write `tsconfig.renderer.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": [],
    "rootDir": "./src",
    "outDir": "./public/js",
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "sourceMap": false
  },
  "include": ["src/renderer/**/*", "src/shared/**/*"]
}
```

Output lands in `public/js/renderer/*.js` and `public/js/shared/api.js`.

- [ ] **Step 9: Write `scripts/copy-vendor.js`**

```js
// Copies the browser builds the renderer loads as classic scripts (see public/index.html).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const target = path.join(root, 'public', 'vendor');
const files = [
  ['node_modules/marked/lib/marked.umd.js', 'marked.umd.js'],
  ['node_modules/dompurify/dist/purify.min.js', 'purify.min.js'],
];

fs.mkdirSync(target, { recursive: true });
for (const [from, to] of files) {
  fs.copyFileSync(path.join(root, from), path.join(target, to));
}
console.log(`Copied ${files.length} vendor scripts to public/vendor`);
```

- [ ] **Step 10: Wire the plumbing**

`package.json` scripts — replace `build`, `watch`, `dev`, `build:windows` and add two:

```json
"build": "tsc && npm run build:renderer",
"build:renderer": "tsc -p tsconfig.renderer.json && node scripts/copy-vendor.js",
"watch": "tsc --watch",
"watch:renderer": "tsc -p tsconfig.renderer.json --watch",
"dev": "install-electron && npm run build:renderer && concurrently \"npm run watch\" \"npm run watch:renderer\" \"wait-on dist/main.js && electron .\"",
"build:windows": "npm run sync-version && npm run ensure-mac-perms && tsc -p tsconfig.prod.json && npm run build:renderer && npm run clean-build && electron-builder --win"
```

`tsconfig.json` — exclude the renderer (its pure modules are still compiled when tests import them):

```json
"exclude": ["node_modules", "dist", "src/renderer"]
```

`jest.config.js` — map `.js` import specifiers back to TypeScript sources, inside `moduleNameMapper`:

```js
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
```

`electron-builder.yml` — under `files:` after `"!dist/**/*.map"` add:

```yaml
  - "!dist/renderer"
```

`.gitignore` — append:

```
public/js/
public/vendor/
```

`eslint.config.js` — replace the whole file:

```js
const js = require('@eslint/js');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');

const sharedRules = {
  ...js.configs.recommended.rules,
  ...tsPlugin.configs.recommended.rules,
  '@typescript-eslint/no-unused-vars': [
    'warn',
    {
      argsIgnorePattern: '^_',
    },
  ],
  '@typescript-eslint/no-explicit-any': 'warn',
  'no-console': [
    'warn',
    {
      allow: ['warn', 'error'],
    },
  ],
  'prefer-const': 'warn',
  'no-var': 'warn',
};

module.exports = [
  {
    ignores: ['dist', 'out', 'release', 'node_modules', 'public'],
  },
  {
    files: ['src/**/*.ts', 'src/__tests__/**/*.ts'],
    ignores: ['src/renderer/**'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        project: './tsconfig.json',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        NodeJS: 'readonly',
        AbortSignal: 'readonly',
        AbortController: 'readonly',
        require: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        jest: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: sharedRules,
  },
  {
    // Browser code: TypeScript checks names, so no-undef would only misfire on DOM types.
    files: ['src/renderer/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        project: './tsconfig.renderer.json',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...sharedRules,
      'no-undef': 'off',
    },
  },
];
```

- [ ] **Step 11: Verify**

```bash
npx jest src/__tests__/format.test.ts
npm run build
ls public/js/renderer/format.js public/js/shared/api.js public/vendor/marked.umd.js public/vendor/purify.min.js
npm test && npm run lint
git status --short
```

Expected: 4 tests pass; build succeeds; the four files exist; all suites pass; 0 lint errors and no new warnings; `public/js` and `public/vendor` do not appear in `git status`.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.renderer.json jest.config.js eslint.config.js electron-builder.yml .gitignore scripts/copy-vendor.js src/shared/api.ts src/services/sharedTypeChecks.ts src/renderer/globals.d.ts src/renderer/format.ts src/__tests__/format.test.ts
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Add a TypeScript build for the renderer" -m "Renderer code compiles to ES modules in public/js, marked and DOMPurify are copied to public/vendor, and the types shared with the main process live in src/shared/api.ts, checked against the main-process types at build time." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Library service

**Files:**
- Create: `src/services/libraryService.ts`
- Test: `src/__tests__/libraryService.test.ts`

**Interfaces:**
- Consumes: `DocumentStore`, `parseFrontmatter`, `slugify` from `documentStore.ts`; shared types from Task 1.
- Produces:
  - `class LibraryPathError extends Error`
  - `toRelative(vaultPath: string, absolute: string): string`
  - `sanitizeFolderName(name: string): string`
  - `class LibraryService` with `constructor(vaultPath: string)`, `readonly vaultPath: string`, `exists(): boolean`, `resolve(relative: string, kind: 'document' | 'folder'): string`, `relative(absolute: string): string`, `tree(): LibraryTree`, `search(query: string, limit?: number): LibrarySearchHit[]`, `read(file: string): DocumentContent`, `rename(file: string, title: string): string`, `move(file: string, folder: string): string`, `createFolder(parent: string, name: string): string`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/libraryService.test.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LibraryPathError, LibraryService, sanitizeFolderName } from '../services/libraryService';

function vault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-lib-'));
  const write = (rel: string, content: string) => {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  return { root, write, service: new LibraryService(root) };
}

const doc = (title: string, created: string) => `---\ntitle: ${title}\ncreated: ${created}\n---\n\nbody\n`;

describe('LibraryService.tree', () => {
  it('lists folders and markdown documents relative to the vault', () => {
    const v = vault();
    v.write('2026-09-16-0706-untitled.md', doc('untitled', '2026-09-16T07:06:00Z'));
    v.write('Clients/Acme/kickoff.md', doc('Kickoff', '2026-09-10T09:00:00Z'));
    v.write('Clients/notes.txt', 'not markdown');
    v.write('.obsidian/workspace.md', 'hidden');
    fs.mkdirSync(path.join(v.root, 'Empty'));

    const tree = v.service.tree();
    expect(tree.exists).toBe(true);
    expect(tree.root).toBe(v.root);
    expect(tree.folders).toEqual([
      { path: 'Clients', name: 'Clients', children: [{ path: 'Clients/Acme', name: 'Acme', children: [] }] },
      { path: 'Empty', name: 'Empty', children: [] },
    ]);
    expect(tree.documents.map((d) => [d.file, d.folder, d.title, d.created, d.readable]).sort()).toEqual([
      ['2026-09-16-0706-untitled.md', '', 'untitled', '2026-09-16T07:06:00Z', true],
      ['Clients/Acme/kickoff.md', 'Clients/Acme', 'Kickoff', '2026-09-10T09:00:00Z', true],
    ]);
    expect(tree.documents.every((d) => d.mtimeMs > 0)).toBe(true);
  });

  it('falls back to the file name and reads Windows line endings', () => {
    const v = vault();
    v.write('plain.md', 'just text');
    v.write('crlf.md', '---\r\ntitle: Windows\r\ncreated: 2026-01-01T00:00:00Z\r\n---\r\n\r\nbody');
    const byFile = new Map(v.service.tree().documents.map((d) => [d.file, d]));
    expect(byFile.get('plain.md')).toMatchObject({ title: 'plain', created: '' });
    expect(byFile.get('crlf.md')).toMatchObject({ title: 'Windows', created: '2026-01-01T00:00:00Z' });
  });

  it('reports a missing vault', () => {
    const missing = path.join(os.tmpdir(), `dw-missing-${Date.now()}`);
    expect(new LibraryService(missing).tree()).toEqual({ root: missing, exists: false, folders: [], documents: [] });
  });
});

describe('LibraryService.resolve', () => {
  it('accepts documents and folders inside the vault', () => {
    const v = vault();
    expect(v.service.resolve('Clients/a.md', 'document')).toBe(path.join(v.root, 'Clients', 'a.md'));
    expect(v.service.resolve('', 'folder')).toBe(path.resolve(v.root));
    expect(v.service.resolve('Clients', 'folder')).toBe(path.join(v.root, 'Clients'));
  });

  it.each(['../x.md', 'Clients/../../x.md', '/etc/passwd.md', 'C:/Windows/x.md', 'C:x.md'])('rejects %s', (p) => {
    expect(() => vault().service.resolve(p, 'document')).toThrow(LibraryPathError);
  });

  it('rejects non-markdown documents and the vault itself as a document', () => {
    const v = vault();
    expect(() => v.service.resolve('a.txt', 'document')).toThrow(LibraryPathError);
    expect(() => v.service.resolve('', 'document')).toThrow(LibraryPathError);
    expect(() => v.service.resolve('../elsewhere', 'folder')).toThrow(LibraryPathError);
  });
});

describe('LibraryService changes', () => {
  it('renames a session document and updates its title', () => {
    const v = vault();
    v.write('2026-09-16-0706-untitled.md', doc('untitled', 'x'));
    const next = v.service.rename('2026-09-16-0706-untitled.md', 'Team sync');
    expect(next).toBe('2026-09-16-0706-team-sync.md');
    expect(fs.readFileSync(path.join(v.root, next), 'utf8')).toContain('title: Team sync');
  });

  it('renames any other note without touching its content', () => {
    const v = vault();
    v.write('ideas.md', 'plain');
    expect(v.service.rename('ideas.md', 'Big Ideas')).toBe('big-ideas.md');
    expect(fs.readFileSync(path.join(v.root, 'big-ideas.md'), 'utf8')).toBe('plain');
    expect(() => v.service.rename('big-ideas.md', '   ')).toThrow(LibraryPathError);
  });

  it('moves a document into a folder, suffixing on a clash, and back to the root', () => {
    const v = vault();
    v.write('a.md', '1');
    v.write('Work/a.md', '2');
    expect(v.service.move('a.md', 'Work')).toBe('Work/a-2.md');
    expect(fs.existsSync(path.join(v.root, 'a.md'))).toBe(false);
    expect(v.service.move('Work/a-2.md', '')).toBe('a-2.md');
    expect(v.service.move('a-2.md', '')).toBe('a-2.md');
  });

  it('refuses to move into a missing folder', () => {
    const v = vault();
    v.write('a.md', '1');
    expect(() => v.service.move('a.md', 'Nowhere')).toThrow(LibraryPathError);
  });

  it('creates folders with sanitised names', () => {
    const v = vault();
    expect(v.service.createFolder('', '  Clients ')).toBe('Clients');
    expect(v.service.createFolder('Clients', 'Acme')).toBe('Clients/Acme');
    expect(fs.statSync(path.join(v.root, 'Clients', 'Acme')).isDirectory()).toBe(true);
    expect(() => v.service.createFolder('', 'Clients')).toThrow('already exists');
    expect(() => v.service.createFolder('Missing', 'x')).toThrow(LibraryPathError);
  });

  it.each(['', '  ', '.', '..', 'a/b', 'a\\b', 'what?', 'x:y'])('rejects folder name %j', (name) => {
    expect(() => sanitizeFolderName(name)).toThrow(LibraryPathError);
  });
});

describe('LibraryService.search and read', () => {
  it('finds lines across documents, skipping markers and hidden folders', () => {
    const v = vault();
    v.write('a.md', '---\ntitle: a\n---\n\n<!-- dw:block 1 t=0-120 budget -->\nThe quarterly budget\n');
    v.write('Work/b.md', 'Budget review\r\nnothing\r\n');
    v.write('.trash/c.md', 'budget');
    const hits = v.service.search('BUDGET');
    expect(hits).toHaveLength(2);
    expect(hits).toEqual(
      expect.arrayContaining([
        { file: 'a.md', line: 6, text: 'The quarterly budget' },
        { file: 'Work/b.md', line: 1, text: 'Budget review' },
      ]),
    );
  });

  it('returns nothing for a blank query and caps the results', () => {
    const v = vault();
    v.write('many.md', Array.from({ length: 300 }, () => 'x').join('\n'));
    expect(v.service.search('   ')).toEqual([]);
    expect(v.service.search('x')).toHaveLength(200);
  });

  it('reads a document with its modification time', () => {
    const v = vault();
    v.write('a.md', 'hello');
    const content = v.service.read('a.md');
    expect(content.file).toBe('a.md');
    expect(content.content).toBe('hello');
    expect(content.mtimeMs).toBeGreaterThan(0);
    expect(() => v.service.read('../a.md')).toThrow(LibraryPathError);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx jest src/__tests__/libraryService.test.ts`
Expected: FAIL — `Cannot find module '../services/libraryService'`.

- [ ] **Step 3: Write `src/services/libraryService.ts`**

```ts
import * as fs from 'fs';
import * as path from 'path';
import type { DocumentContent, FolderNode, LibraryDocument, LibrarySearchHit, LibraryTree } from '../shared/api';
import { DocumentStore, parseFrontmatter, slugify } from './documentStore';

export class LibraryPathError extends Error {}

const FORBIDDEN_NAME = /[\\/:*?"<>|]/;
// Session documents are named <YYYY-MM-DD-HHmm>-<slug>.md; renaming keeps that prefix.
const SESSION_NAME = /^\d{4}-\d{2}-\d{2}-\d{4}/;
const HEAD_BYTES = 4096;

export function toRelative(vaultPath: string, absolute: string): string {
  return path.relative(vaultPath, absolute).split(path.sep).join('/');
}

export function sanitizeFolderName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '' || trimmed === '.' || trimmed === '..' || FORBIDDEN_NAME.test(trimmed)) {
    throw new LibraryPathError(`"${name}" is not a valid folder name`);
  }
  return trimmed;
}

// Frontmatter sits at the top of the file, so the library never reads whole documents to list them.
function readHead(file: string): string {
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const bytes = fs.readSync(handle, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytes).toString('utf8');
  } finally {
    fs.closeSync(handle);
  }
}

export class LibraryService {
  private readonly store: DocumentStore;

  constructor(readonly vaultPath: string) {
    this.store = new DocumentStore(vaultPath);
  }

  exists(): boolean {
    try {
      return fs.statSync(this.vaultPath).isDirectory();
    } catch {
      return false;
    }
  }

  // Every path the renderer supplies goes through here: relative, inside the vault,
  // and a Markdown file when it names a document.
  resolve(relative: string, kind: 'document' | 'folder'): string {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) {
      throw new LibraryPathError(`Not a vault path: ${String(relative)}`);
    }
    const absolute = path.resolve(this.vaultPath, relative);
    const back = path.relative(this.vaultPath, absolute);
    if (back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
      throw new LibraryPathError(`Outside the vault: ${relative}`);
    }
    if (kind === 'document' && (back === '' || !back.toLowerCase().endsWith('.md'))) {
      throw new LibraryPathError(`Not a Markdown document: ${relative}`);
    }
    return absolute;
  }

  relative(absolute: string): string {
    return toRelative(this.vaultPath, absolute);
  }

  tree(): LibraryTree {
    const exists = this.exists();
    const documents: LibraryDocument[] = [];
    const walk = (dir: string, rel: string): FolderNode[] => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      const folders: FolderNode[] = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue; // .obsidian, .trash, .git
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          folders.push({ path: childRel, name: entry.name, children: walk(full, childRel) });
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          documents.push(this.describe(full, childRel, rel));
        }
      }
      return folders.sort((a, b) => a.name.localeCompare(b.name));
    };
    const folders = exists ? walk(this.vaultPath, '') : [];
    return { root: this.vaultPath, exists, folders, documents };
  }

  private describe(full: string, file: string, folder: string): LibraryDocument {
    const fallbackTitle = path.basename(file, path.extname(file));
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {
      // Vanished between listing and stat-ing; the next change event reloads the tree.
    }
    try {
      const { frontmatter } = parseFrontmatter(readHead(full).replace(/\r\n/g, '\n'));
      return {
        file,
        folder,
        title: frontmatter.title || fallbackTitle,
        created: frontmatter.created ?? '',
        mtimeMs,
        readable: true,
      };
    } catch {
      return { file, folder, title: fallbackTitle, created: '', mtimeMs, readable: false };
    }
  }

  search(query: string, limit = 200): LibrarySearchHit[] {
    const needle = query.trim().toLowerCase();
    if (needle === '') return [];
    const hits: LibrarySearchHit[] = [];
    for (const doc of this.tree().documents) {
      let content: string;
      try {
        content = fs.readFileSync(this.resolve(doc.file, 'document'), 'utf8');
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trimStart().startsWith('<!--') || !line.toLowerCase().includes(needle)) continue;
        hits.push({ file: doc.file, line: i + 1, text: line.trim() });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }

  read(file: string): DocumentContent {
    const full = this.resolve(file, 'document');
    const content = fs.readFileSync(full, 'utf8');
    return { file, content, mtimeMs: fs.statSync(full).mtimeMs };
  }

  rename(file: string, title: string): string {
    const full = this.resolve(file, 'document');
    const clean = title.trim();
    if (clean === '') throw new LibraryPathError('A title is required');
    if (SESSION_NAME.test(path.basename(full))) {
      return this.relative(this.store.renameDocument(full, clean));
    }
    // Other notes (e.g. written in Obsidian) are renamed without touching their content.
    const target = this.freePath(path.dirname(full), slugify(clean), full);
    if (target !== full) fs.renameSync(full, target);
    return this.relative(target);
  }

  move(file: string, folder: string): string {
    const full = this.resolve(file, 'document');
    const dir = this.resolve(folder, 'folder');
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new LibraryPathError(`No such folder: ${folder}`);
    }
    if (path.dirname(full) === dir) return this.relative(full);
    const target = this.freePath(dir, path.basename(full, path.extname(full)));
    fs.renameSync(full, target);
    return this.relative(target);
  }

  createFolder(parent: string, name: string): string {
    const parentDir = this.resolve(parent, 'folder');
    if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) {
      throw new LibraryPathError(`No such folder: ${parent}`);
    }
    const clean = sanitizeFolderName(name);
    const target = path.join(parentDir, clean);
    if (fs.existsSync(target)) throw new LibraryPathError(`"${clean}" already exists`);
    fs.mkdirSync(target);
    return this.relative(target);
  }

  private freePath(dir: string, stem: string, current?: string): string {
    let candidate = path.join(dir, `${stem}.md`);
    for (let n = 2; fs.existsSync(candidate) && candidate !== current; n++) {
      candidate = path.join(dir, `${stem}-${n}.md`);
    }
    return candidate;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/__tests__/libraryService.test.ts`
Expected: PASS. Then `npm run build && npm test && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/services/libraryService.ts src/__tests__/libraryService.test.ts
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Add a library service over the vault" -m "Lists folders and documents, searches, reads, renames, moves and creates folders, with every renderer-supplied path checked to stay inside the vault." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Vault change batching and snapshot diffing

**Files:**
- Create: `src/services/libraryWatch.ts`
- Test: `src/__tests__/libraryWatch.test.ts`

**Interfaces:**
- Consumes: `LibraryTree` (Task 1).
- Produces: `class ChangeBatcher` with `constructor(delayMs: number, emit: (paths: string[]) => void)`, `add(relativePath: string): void`, `flush(): void`, `cancel(): void`; `type Snapshot = Map<string, number>`; `snapshotTree(tree: LibraryTree): Snapshot`; `diffSnapshots(before: Snapshot, after: Snapshot): string[]`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/libraryWatch.test.ts`:

```ts
import type { LibraryDocument, LibraryTree } from '../shared/api';
import { ChangeBatcher, diffSnapshots, snapshotTree } from '../services/libraryWatch';

describe('ChangeBatcher', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('emits once, after the last change, with unique sorted forward-slash paths', () => {
    const emitted: string[][] = [];
    const batcher = new ChangeBatcher(300, (paths) => emitted.push(paths));
    batcher.add('b.md');
    jest.advanceTimersByTime(200);
    batcher.add('Work\\a.md');
    batcher.add('b.md');
    jest.advanceTimersByTime(299);
    expect(emitted).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(emitted).toEqual([['Work/a.md', 'b.md']]);
  });

  it('drops pending changes on cancel', () => {
    const emitted: string[][] = [];
    const batcher = new ChangeBatcher(300, (paths) => emitted.push(paths));
    batcher.add('a.md');
    batcher.cancel();
    jest.advanceTimersByTime(1000);
    expect(emitted).toEqual([]);
  });
});

const d = (file: string, mtimeMs: number): LibraryDocument => ({
  file,
  folder: '',
  title: file,
  created: '',
  mtimeMs,
  readable: true,
});

const tree = (overrides: Partial<LibraryTree>): LibraryTree => ({
  root: 'v',
  exists: true,
  folders: [],
  documents: [],
  ...overrides,
});

describe('diffSnapshots', () => {
  it('reports added, removed and modified documents and folders', () => {
    const before = snapshotTree(
      tree({
        folders: [{ path: 'Work', name: 'Work', children: [{ path: 'Work/Old', name: 'Old', children: [] }] }],
        documents: [d('a.md', 1), d('b.md', 1)],
      }),
    );
    const after = snapshotTree(
      tree({
        folders: [{ path: 'Home', name: 'Home', children: [] }],
        documents: [d('a.md', 2), d('c.md', 1)],
      }),
    );
    expect(diffSnapshots(before, after)).toEqual(['Home', 'Work', 'Work/Old', 'a.md', 'b.md', 'c.md']);
  });

  it('is empty when nothing changed', () => {
    const snapshot = snapshotTree(tree({ documents: [d('a.md', 1)] }));
    expect(diffSnapshots(snapshot, snapshotTree(tree({ documents: [d('a.md', 1)] })))).toEqual([]);
  });

  it('reports the vault appearing', () => {
    const before = snapshotTree(tree({ exists: false }));
    expect(diffSnapshots(before, snapshotTree(tree({})))).toEqual(['']);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx jest src/__tests__/libraryWatch.test.ts`
Expected: FAIL — `Cannot find module '../services/libraryWatch'`.

- [ ] **Step 3: Write `src/services/libraryWatch.ts`**

```ts
import type { FolderNode, LibraryTree } from '../shared/api';

// Collects file-system events and reports them once the vault has been quiet for delayMs.
export class ChangeBatcher {
  private readonly pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly delayMs: number,
    private readonly emit: (paths: string[]) => void,
  ) {}

  add(relativePath: string): void {
    this.pending.add(relativePath.split('\\').join('/'));
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.size === 0) return;
    const paths = [...this.pending].sort();
    this.pending.clear();
    this.emit(paths);
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }
}

// Polling fallback: compare what the vault looked like on two passes.
// Keys: '' for the vault itself, 'folder/' for folders, the relative path for documents.
export type Snapshot = Map<string, number>;

export function snapshotTree(tree: LibraryTree): Snapshot {
  const snapshot: Snapshot = new Map();
  if (tree.exists) snapshot.set('', 0);
  const addFolders = (nodes: FolderNode[]) => {
    for (const node of nodes) {
      snapshot.set(`${node.path}/`, 0);
      addFolders(node.children);
    }
  };
  addFolders(tree.folders);
  for (const doc of tree.documents) snapshot.set(doc.file, doc.mtimeMs);
  return snapshot;
}

export function diffSnapshots(before: Snapshot, after: Snapshot): string[] {
  const changed = new Set<string>();
  for (const [key, value] of after) {
    if (before.get(key) !== value) changed.add(key);
  }
  for (const key of before.keys()) {
    if (!after.has(key)) changed.add(key);
  }
  return [...changed].map((key) => (key.endsWith('/') ? key.slice(0, -1) : key)).sort();
}
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/__tests__/libraryWatch.test.ts`
Expected: PASS. Then `npm run build && npm test && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/services/libraryWatch.ts src/__tests__/libraryWatch.test.ts
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Batch vault changes and diff polling snapshots" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---
### Task 4: Session block events and document folders

**Files:**
- Modify: `src/services/sessionService.ts`, `src/services/documentStore.ts`
- Test: `src/__tests__/sessionService.test.ts`, `src/__tests__/documentStore.test.ts`

**Interfaces:**
- Consumes: existing `SessionService`, `DocumentStore`.
- Produces:
  - `type SessionBlockState = 'live' | 'empty' | 'queued'`
  - `interface SessionBlockEvent { blockIndex: number; startSec: number; endSec: number; state: SessionBlockState }`
  - `SessionService.onBlock(listener: (event: SessionBlockEvent) => void): () => void`
  - `SessionService.setDocumentPath(documentPath: string): void`
  - `DocumentStore.createDocument(id: string, fm: Frontmatter, folder?: string): string` (`folder` relative, default `''`)

- [ ] **Step 1: Write the failing tests**

In `src/__tests__/sessionService.test.ts`, change the first import line to:

```ts
import { SessionBlockEvent, SessionService, SessionStoreLike, RefineJob } from '../services/sessionService';
```

and add inside the `describe('SessionService', ...)` block, before its closing `});`:

```ts
  it('reports block lifecycle events, queued before the job is enqueued', () => {
    const fake = fakeStore();
    const events: SessionBlockEvent[] = [];
    const order: string[] = [];
    const service = new SessionService({
      store: fake.store,
      enqueueRefine: (job) => order.push(`job ${job.blockIndex}`),
      blockMinutes: 2,
      timestampHeadings: false,
    });
    service.onBlock((event) => {
      events.push(event);
      order.push(`${event.state} ${event.blockIndex}`);
    });
    service.begin({ id: 's1', documentPath: 'C:/vault/s1.md' });
    service.segment({ text: 'hello', atMs: 1_000 });
    service.segment({ text: 'later', atMs: 250_000 });
    service.end();

    expect(order).toEqual(['live 1', 'queued 1', 'job 1', 'live 2', 'empty 2', 'live 3', 'queued 3', 'job 3']);
    expect(events[0]).toEqual({ blockIndex: 1, startSec: 0, endSec: 120, state: 'live' });
    expect(events[1]).toEqual({ blockIndex: 1, startSec: 0, endSec: 120, state: 'queued' });
    expect(events[3]).toEqual({ blockIndex: 2, startSec: 120, endSec: 240, state: 'empty' });
    expect(events[5]).toEqual({ blockIndex: 3, startSec: 240, endSec: 250, state: 'queued' });
  });

  it('follows its document to a new path', () => {
    const ctx = setup();
    const paths: string[] = [];
    ctx.service.onInfo((info) => paths.push(info.documentPath));
    ctx.service.segment({ text: 'rough', atMs: 1_000 });
    ctx.service.end();
    const replace = jest.spyOn(ctx.store, 'replaceBlock');

    ctx.service.setDocumentPath('C:/vault/Work/s1.md');

    expect(ctx.service.getInfo().documentPath).toBe('C:/vault/Work/s1.md');
    expect(paths[paths.length - 1]).toBe('C:/vault/Work/s1.md');
    expect(ctx.service.applyRefinement(1, 'Better')).toBe('replaced');
    expect(replace).toHaveBeenCalledWith('C:/vault/Work/s1.md', 1, 'Better', expect.any(String));
  });
```

In `src/__tests__/documentStore.test.ts`, add a new `describe` at the end of the file:

```ts
describe('DocumentStore.createDocument folders', () => {
  it('creates a document inside a vault folder', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-store-folder-'));
    const file = new DocumentStore(vault).createDocument('2026-09-16-0706', FM, 'Clients/Acme');
    expect(file).toBe(path.join(vault, 'Clients', 'Acme', '2026-09-16-0706-untitled.md'));
    expect(fs.readFileSync(file, 'utf8')).toContain('title: untitled');
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx jest src/__tests__/sessionService.test.ts src/__tests__/documentStore.test.ts`
Expected: FAIL — `onBlock` / `setDocumentPath` do not exist, and the document is created in the vault root.

- [ ] **Step 3: Implement**

In `src/services/sessionService.ts`, after the `RefineJob` interface add:

```ts
export type SessionBlockState = 'live' | 'empty' | 'queued';

export interface SessionBlockEvent {
  blockIndex: number;
  startSec: number;
  endSec: number;
  state: SessionBlockState;
}
```

In the class, add a field next to `listeners`:

```ts
  private readonly blockListeners = new Set<(event: SessionBlockEvent) => void>();
```

Add these methods after `onInfo`:

```ts
  onBlock(listener: (event: SessionBlockEvent) => void): () => void {
    this.blockListeners.add(listener);
    return () => {
      this.blockListeners.delete(listener);
    };
  }

  private emitBlock(event: SessionBlockEvent): void {
    for (const l of this.blockListeners) l(event);
  }

  // The runtime renames or moves a finished session's document while its blocks may still refine.
  setDocumentPath(documentPath: string): void {
    this.info = { ...this.info, documentPath };
    this.emit();
  }
```

Replace `openBlock` and `closeBlock` with:

```ts
  private openBlock(index: number): void {
    const range = blockRange(index, this.deps.blockMinutes);
    const block: BlockRef = { index, startSec: range.startSec, endSec: range.endSec };
    const heading = this.deps.timestampHeadings ? formatTimestampHeading(range.startSec) : undefined;
    this.deps.store.openBlock(this.info.documentPath, block, heading);
    this.emitBlock({ blockIndex: index, startSec: range.startSec, endSec: range.endSec, state: 'live' });
  }

  // A block with no speech in it has nothing to refine, so it is closed without a job.
  // 'queued' is reported before the job is enqueued: the queue may start it synchronously.
  private closeBlock(index: number, endSec: number): void {
    const range = blockRange(index, this.deps.blockMinutes);
    const text = this.deps.store.readBlockText(this.info.documentPath, index) ?? '';
    if (text.trim().length === 0) {
      this.emitBlock({ blockIndex: index, startSec: range.startSec, endSec, state: 'empty' });
      return;
    }
    const hash = hashText(text);
    this.hashes.set(index, hash);
    this.emitBlock({ blockIndex: index, startSec: range.startSec, endSec, state: 'queued' });
    this.deps.enqueueRefine({ blockIndex: index, startSec: range.startSec, endSec, hash });
  }
```

In `src/services/documentStore.ts`, replace the first three lines of `createDocument`:

```ts
  createDocument(id: string, fm: Frontmatter, folder = ''): string {
    const dir = path.join(this.vaultPath, folder);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}-${slugify(fm.title)}.md`);
```

(the `this.write(...)` and `return file;` lines stay).

- [ ] **Step 4: Run the tests**

Run: `npx jest src/__tests__/sessionService.test.ts src/__tests__/documentStore.test.ts`
Expected: PASS (all earlier tests too). Then `npm run build && npm test && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/services/sessionService.ts src/services/documentStore.ts src/__tests__/sessionService.test.ts src/__tests__/documentStore.test.ts
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Report block lifecycle events and create documents in folders" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Session runtime — folders, block events, richer status

**Files:**
- Modify: `src/services/sessionRuntime.ts`, `src/main.ts`, `src/preload.ts`
- Create: `scripts/dev-cdp.mjs`

**Interfaces:**
- Consumes: `SessionBlockEvent`, `setDocumentPath` (Task 4); `LibraryService`, `toRelative` (Task 2); `BlockEvent`, `BlockState`, `SessionStatusView` (Task 1); `RefineEvent` from `blockRefiner.ts`.
- Produces (from `sessionRuntime.ts`):
  - `startSession(folder?: string): Promise<SessionStatusView>` (folder relative to the vault)
  - `onSessionBlock(listener: (event: BlockEvent) => void): () => void`
  - `addSessionNotice(text: string): void` — app-wide notices shown in `messages`
  - `isRecordingDocument(absolute: string): boolean`
  - `documentMoved(from: string, to: string): void` (absolute paths)
  - `export type { SessionStatusView }` (now the shared type)
- IPC: `session-start` takes an optional folder; new event `session-block`.
- `scripts/dev-cdp.mjs`: `connect(port?: number, attempts?: number): Promise<{ evaluate(expression: string): Promise<unknown>; close(): void }>`; CLI `node scripts/dev-cdp.mjs "<expression>"` prints the JSON result.

This task has no unit tests (it imports Electron); it is verified by the build, the existing suites, and a live check.

- [ ] **Step 1: Imports and types in `sessionRuntime.ts`**

Replace the `blockRefiner` and `sessionService` import lines, and add two imports:

```ts
import { RefineEvent, RefineQueue, shouldRefineDuringRecording } from './blockRefiner';
import { RefineJob, SessionService, SessionStoreLike } from './sessionService';
import type { BlockEvent, BlockState, SessionStatusView } from '../shared/api';
import { LibraryService, toRelative } from './libraryService';
```

Delete the local `export interface SessionStatusView { ... }` block and put in its place:

```ts
export type { SessionStatusView };

const MAX_MESSAGES = 50;

const REFINE_STATE: Record<RefineEvent['kind'], BlockState> = {
  started: 'refining',
  replaced: 'refined',
  skipped: 'skipped',
  failed: 'failed',
};
```

- [ ] **Step 2: Context, listeners and helpers**

Replace the `SessionContext` interface with:

```ts
interface SessionContext {
  id: string;
  vaultPath: string;
  folder: string;
  documentPath: string;
  service: SessionService;
  queue: RefineQueue;
  store: GuardedStore;
  stopped: boolean;
  audioRemoved: boolean;
  pausedByApp: boolean;
  microphone: string;
  liveModel: string;
  refineModel: string;
  messages: string[];
  blocks: Map<number, BlockEvent>;
}
```

After `const segmentListeners = ...` add:

```ts
const blockListeners = new Set<(event: BlockEvent) => void>();
// App-wide notices (e.g. the vault watcher falling back to polling), newest first.
const notices: string[] = [];
```

After `onSessionSegment` add:

```ts
export function onSessionBlock(listener: (event: BlockEvent) => void): () => void {
  blockListeners.add(listener);
  return () => blockListeners.delete(listener);
}

function addMessage(ctx: SessionContext, text: string): void {
  statusMessage = text;
  ctx.messages.unshift(text);
  ctx.messages.splice(MAX_MESSAGES);
}

export function addSessionNotice(text: string): void {
  if (notices[0] === text) return;
  notices.unshift(text);
  notices.splice(MAX_MESSAGES);
  emit();
}

function recordBlock(
  ctx: SessionContext,
  blockIndex: number,
  state: BlockState,
  message?: string,
  range?: { startSec: number; endSec: number },
): void {
  const previous = ctx.blocks.get(blockIndex);
  const event: BlockEvent = {
    sessionId: ctx.id,
    blockIndex,
    startSec: range?.startSec ?? previous?.startSec ?? 0,
    endSec: range?.endSec ?? previous?.endSec ?? 0,
    state,
    ...(message ? { message } : {}),
  };
  ctx.blocks.set(blockIndex, event);
  for (const l of blockListeners) l(event);
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

export function isRecordingDocument(absolute: string): boolean {
  return isSessionActive() && current !== null && samePath(current.documentPath, absolute);
}

// The library renamed or moved a document; a finished session may still be refining it.
export function documentMoved(from: string, to: string): void {
  for (const ctx of liveContexts()) {
    if (!samePath(ctx.documentPath, from)) continue;
    ctx.documentPath = to;
    ctx.service.setDocumentPath(to);
    // A rename rewrites the title in the frontmatter; that is our own write, not an outside edit.
    ctx.store.noteWrite(to);
  }
  emit();
}
```

- [ ] **Step 3: The status view**

Replace the whole `sessionStatus()` function with:

```ts
export function sessionStatus(): SessionStatusView {
  const engine = streamEngine.getStatus();
  const ctx = current;
  const info = ctx?.service.getInfo();
  let state: SessionStatusView['state'] = 'idle';
  if (isSessionActive() && engine.state === 'error') state = 'error';
  else if (isSessionActive() && engine.state === 'starting') state = 'starting';
  else if (info) state = info.state;

  let refining = 0;
  for (const c of liveContexts()) refining += c.queue.pending();

  return {
    sessionId: ctx?.id ?? null,
    state,
    documentPath: ctx?.documentPath ?? null,
    documentFile: ctx ? toRelative(ctx.vaultPath, ctx.documentPath) : null,
    folder: ctx?.folder ?? '',
    blockIndex: info?.blockIndex ?? 0,
    durationSec: info?.durationSec ?? 0,
    refining,
    message: (isSessionActive() ? engine.message : undefined) ?? statusMessage,
    muted: micMute.isMuted(),
    microphone: ctx?.microphone ?? '',
    liveModel: ctx?.liveModel ?? '',
    refineModel: ctx?.refineModel ?? '',
    messages: [...(ctx?.messages ?? []), ...notices],
    blocks: ctx ? [...ctx.blocks.values()].sort((a, b) => a.blockIndex - b.blockIndex) : [],
  };
}
```

- [ ] **Step 4: Starting a session in a folder**

Replace `uniqueDocumentId` and `startSession` with:

```ts
function uniqueDocumentId(dir: string, base: string): string {
  let id = base;
  for (let n = 2; fs.existsSync(path.join(dir, `${id}-untitled.md`)); n++) {
    id = `${base}-${n}`;
  }
  return id;
}

// A missing or invalid target folder falls back to the vault root, with a message.
function resolveTargetFolder(library: LibraryService, folder: string): { folder: string; message?: string } {
  if (!folder) return { folder: '' };
  try {
    const dir = library.resolve(folder, 'folder');
    if (fs.statSync(dir).isDirectory()) return { folder: library.relative(dir) };
  } catch {
    // Reported below.
  }
  return { folder: '', message: `Folder "${folder}" not found — the session was saved in the vault root` };
}

export async function startSession(folder = ''): Promise<SessionStatusView> {
  if (isSessionActive()) throw new Error('A session is already recording');
  if (current && !current.audioRemoved) finishing.add(current);

  const settings = getSettings();
  const documents = new DocumentStore(settings.vaultPath);
  const library = new LibraryService(settings.vaultPath);
  const target = resolveTargetFolder(library, folder);
  const id = newSessionId(new Date());
  statusMessage = undefined;

  const created = new Date().toISOString();
  const frontmatter: Frontmatter = {
    title: 'untitled',
    created,
    updated: created,
    duration: 0,
    language: settings.language,
    liveModel: settings.liveModelId,
    refineModel: settings.modelId ?? 'none',
    app: `dark-whisper ${app.getVersion()}`,
  };
  const base = id.replace(/^(\d{4})(\d{2})(\d{2})-(\d{4})\d{2}$/, '$1-$2-$3-$4');
  const targetDir = path.join(settings.vaultPath, target.folder);
  const documentPath = documents.createDocument(uniqueDocumentId(targetDir, base), frontmatter, target.folder);

  let ctx: SessionContext | null = null;
  const store = new GuardedStore(documents, () => {
    if (ctx) addMessage(ctx, EXTERNAL_EDIT_MESSAGE);
    ctx?.queue.setAllowed(false);
    emit();
  });
  store.noteWrite(documentPath);

  const service = new SessionService({
    store,
    enqueueRefine: (job) => ctx?.queue.enqueue(job),
    blockMinutes: settings.blockMinutes,
    timestampHeadings: settings.timestampHeadings,
  });

  const queue = new RefineQueue({
    sliceAudio: (job) => (ctx ? sliceAudio(ctx, job) : Promise.resolve(null)),
    transcribe: (wav) => transcribeAudio(wav),
    cleanup: (wav) => fs.rmSync(wav, { force: true }),
    apply: (blockIndex, text) => service.applyRefinement(blockIndex, text),
    report: (event) => {
      if (ctx) {
        recordBlock(ctx, event.blockIndex, REFINE_STATE[event.kind], event.message);
        if (event.kind === 'failed') {
          addMessage(ctx, `Refinement failed for block ${event.blockIndex}${event.message ? `: ${event.message}` : ''}`);
        }
      }
      emit();
    },
  });

  const device = settings.captureDeviceName
    ? lastDevices.find((d) => d.name === settings.captureDeviceName)
    : undefined;

  ctx = {
    id,
    vaultPath: settings.vaultPath,
    folder: target.folder,
    documentPath,
    service,
    queue,
    store,
    stopped: false,
    audioRemoved: false,
    pausedByApp: false,
    microphone: device?.name ?? 'System default',
    liveModel: settings.liveModelId,
    refineModel: settings.serverMode === 'external' ? 'External API' : settings.modelId ?? 'none',
    messages: [],
    blocks: new Map(),
  };
  current = ctx;
  if (target.message) addMessage(ctx, target.message);
  if (settings.captureDeviceName && !device) {
    addMessage(ctx, `Microphone "${settings.captureDeviceName}" not found — using the default device`);
  }

  const owner = ctx;
  service.onBlock((event) => recordBlock(owner, event.blockIndex, event.state, undefined, event));
  queue.setAllowed(refinementAllowed(ctx));
  service.begin({ id, documentPath });
  service.onInfo(() => emit());

  // The first poll reports the current mute state, so a session started muted begins paused.
  micMute.start();
  try {
    await startLiveEngine({ sessionId: id, captureId: device?.index ?? null, deviceName: device?.name });
  } catch (error) {
    await stopSession();
    throw error;
  }
  emit();
  return sessionStatus();
}
```

Check that `statusMessage` is now only assigned in two places:

Run: `grep -n "statusMessage =" src/services/sessionRuntime.ts`
Expected: exactly two lines — `statusMessage = undefined;` in `startSession`, and `statusMessage = text;` in `addMessage`.

- [ ] **Step 5: Main process and preload**

In `src/main.ts`, add `onSessionBlock` to the `./services/sessionRuntime` import list. In the `ready` handler, after the `onSessionSegment(...)` line, add:

```ts
  onSessionBlock((event) => mainWindow?.webContents.send('session-block', event));
```

Replace the `session-start` handler with:

```ts
ipcMain.handle('session-start', async (_event, folder?: unknown) => {
  if (isRecording) {
    throw new Error('Quick dictation is recording. Stop it before starting a session.');
  }
  return startSession(typeof folder === 'string' ? folder : '');
});
```

In `src/preload.ts` (fully retyped in Task 6), add `import type { BlockEvent } from './shared/api';` at the top. In the bridge object, change the `startSession` entry and add `onSessionBlock` after `onSessionSegment`:

```ts
  startSession: (folder?: string): Promise<SessionStatusView> => ipcRenderer.invoke('session-start', folder),
  onSessionBlock: (callback: (event: BlockEvent) => void) => {
    ipcRenderer.on('session-block', (_event, payload: BlockEvent) => callback(payload));
  },
```

and mirror them in the `declare global` block:

```ts
      startSession: (folder?: string) => Promise<SessionStatusView>;
      onSessionBlock: (callback: (event: BlockEvent) => void) => void;
```

- [ ] **Step 6: Write `scripts/dev-cdp.mjs`**

```js
// Dev helper: evaluate an expression in the running app's window over the DevTools protocol.
//   npx electron . --remote-debugging-port=9333
//   node scripts/dev-cdp.mjs "window.api.getSessionStatus()"
import { pathToFileURL } from 'url';

export async function connect(port = 9333, attempts = 60) {
  let targets = [];
  for (let i = 0; i < attempts; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch {
      // The app is not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error(`No app window on port ${port}`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (message) => {
    const data = JSON.parse(message.data);
    const done = pending.get(data.id);
    if (done) {
      pending.delete(data.id);
      done(data);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  return {
    async evaluate(expression) {
      const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      const details = reply.result?.exceptionDetails;
      if (details) throw new Error(details.exception?.description ?? details.text);
      return reply.result?.result?.value;
    },
    close() {
      ws.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await connect();
  try {
    console.log(JSON.stringify(await app.evaluate(process.argv[2]), null, 2));
  } finally {
    app.close();
  }
}
```

- [ ] **Step 7: Verify**

```bash
npm run build && npm test && npm run lint
grep -n "require(" dist/preload.js
```

Expected: clean; only `require("electron")` in the preload.

Live check. First make sure no dev instance of this app is running (the single-instance lock would make the new one quit). Then, in Git Bash:

```bash
V="$TEMP/dw-vault-t5"; mkdir -p "$V/Smoke"; VW=$(cygpath -w "$V" | sed 's/\\/\\\\/g')
(npx electron . --remote-debugging-port=9333 > "$TEMP/dw-t5.log" 2>&1 &)
node scripts/dev-cdp.mjs "window.api.getSettings().then(s => s.vaultPath)"
node scripts/dev-cdp.mjs "window.api.saveSettings({ vaultPath: '$VW' })"
node scripts/dev-cdp.mjs "window.api.startSession('Smoke').then(s => ({ folder: s.folder, file: s.documentFile, blocks: s.blocks, mic: s.microphone }))"
node scripts/dev-cdp.mjs "window.api.startSession('Smoke').catch(e => e.message)"
node scripts/dev-cdp.mjs "window.api.stopSession().then(() => window.api.getSessionStatus()).then(s => ({ state: s.state, blocks: s.blocks }))"
node scripts/dev-cdp.mjs "window.api.startSession('Nowhere').then(s => ({ folder: s.folder, messages: s.messages }))"
node scripts/dev-cdp.mjs "window.api.stopSession()"
```

Keep the vault path printed by the first `dev-cdp` call, and restore it before finishing (double each backslash inside the quotes):

```bash
node scripts/dev-cdp.mjs "window.api.saveSettings({ vaultPath: 'C:\\Users\\...\\Dark-Whisper' })"
```

Expected:
- First start: `folder: "Smoke"`, `file` like `"Smoke/2026-09-16-HHmm-untitled.md"`, `blocks` holding one entry with `blockIndex: 1, state: "live", startSec: 0, endSec: 120`, and a microphone name.
- Second start: an error message ending `A session is already recording`.
- After stop: `state: "stopped"`, block 1 has `state: "empty"` (nobody spoke).
- `Nowhere`: `folder: ""` and the message `Folder "Nowhere" not found — the session was saved in the vault root`.

Stop the test instance (PowerShell) and confirm nothing is left running:

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.CommandLine -like '*--remote-debugging-port=9333*' -and $_.CommandLine -notlike '*--type=*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }
Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'electron.exe','whisper-stream.exe','sox.exe' } | Select-Object ProcessId, Name
```

Expected: the second command lists no process from this repository.

- [ ] **Step 8: Commit**

```bash
git add src/services/sessionRuntime.ts src/main.ts src/preload.ts scripts/dev-cdp.mjs
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Start sessions in a folder and report block states" -m "The session status now carries the session id, the document relative to the vault, the target folder, microphone, models, messages and the latest state of every block; each block change is also sent as a session-block event. A renamed or moved document keeps receiving its refinements." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Library runtime, main-process wiring and the typed preload

**Files:**
- Create: `src/services/libraryRuntime.ts`
- Modify: `src/main.ts`, `src/preload.ts`

**Interfaces:**
- Consumes: `LibraryService`, `LibraryPathError` (Task 2); `ChangeBatcher`, `snapshotTree`, `diffSnapshots`, `Snapshot` (Task 3); `documentMoved`, `isRecordingDocument`, `addSessionNotice` (Task 5); `DarkWhisperApi`, `LibraryChange` (Task 1).
- Produces:
  - `libraryRuntime.ts`: `registerLibraryIpc(getWindow: () => BrowserWindow | null): void`, `watchVault(): void`, `stopWatching(): void`, `onLibraryChanged(listener: (change: LibraryChange) => void): () => void`
  - IPC (invoke): `library-tree`, `library-search`, `document-read`, `document-rename`, `document-move`, `document-delete`, `folder-create`, `document-open-external`, `document-reveal`, `choose-vault`, `copy-text`
  - IPC (event): `library-changed` `{ paths: string[] }`
  - `preload.ts` exposes exactly `DarkWhisperApi`.

No unit tests (Electron); verified by build, the suites and a live check.

- [ ] **Step 1: Write `src/services/libraryRuntime.ts`**

```ts
import { BrowserWindow, dialog, ipcMain, OpenDialogOptions, shell } from 'electron';
import * as fs from 'fs';
import type { LibraryChange } from '../shared/api';
import { LibraryService } from './libraryService';
import { ChangeBatcher, diffSnapshots, Snapshot, snapshotTree } from './libraryWatch';
import { addSessionNotice, documentMoved, isRecordingDocument } from './sessionRuntime';
import { getSettings } from './settingsService';

const DEBOUNCE_MS = 300;
const POLL_MS = 5000;

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
  addSessionNotice(`Watching the vault by polling every ${POLL_MS / 1000} s`);
  const service = new LibraryService(vault);
  let previous: Snapshot = snapshotTree(service.tree());
  poller = setInterval(() => {
    const next = snapshotTree(service.tree());
    const changed = diffSnapshots(previous, next);
    previous = next;
    if (changed.length > 0) notify(changed);
  }, POLL_MS);
}

// Starts watching the configured vault, or restarts when the vault setting changed.
export function watchVault(): void {
  const vault = getSettings().vaultPath;
  if (vault === watchedVault) return;
  stopWatching();
  watchedVault = vault;
  try {
    watcher = fs.watch(vault, { recursive: true }, (_event, filename) => {
      batcher.add(filename ? String(filename) : '');
    });
    watcher.on('error', (error) => startPolling(vault, error));
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
    throw new Error('This document is being recorded. Stop the session first.');
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
```

- [ ] **Step 2: Wire it into `src/main.ts`**

1. Change the Electron import to include `clipboard` and `shell`:

```ts
import { app, BrowserWindow, clipboard, Menu, Tray, ipcMain, Notification, shell } from 'electron';
```

2. Add an import after the `sessionRuntime` import:

```ts
import { onLibraryChanged, registerLibraryIpc, stopWatching, watchVault } from './services/libraryRuntime';
```

3. Replace the `mainWindow = new BrowserWindow({...});` statement in `createWindow` and add the navigation guard right after `loadFile`:

```ts
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#15151b',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../public/index.html'));

  // Documents can contain links: never navigate the app window; open web links in the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalLink(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === mainWindow?.webContents.getURL()) return;
    event.preventDefault();
    openExternalLink(url);
  });
```

(remove the old `// Load the app (we'll create an index.html)` comment and the old `loadFile` line), and add this function above `createWindow`:

```ts
const openExternalLink = (url: string) => {
  if (/^https?:\/\//i.test(url)) {
    void shell.openExternal(url);
  }
};
```

4. In the `ready` handler, after the `onSessionBlock(...)` line, add:

```ts
  watchVault();
  onLibraryChanged((change) => mainWindow?.webContents.send('library-changed', change));
```

5. In `before-quit`, after `whisperServer.stop();` add `stopWatching();`.

6. Replace the start of the `save-settings` handler so a vault change is refused during a session and restarts the watcher:

```ts
ipcMain.handle('save-settings', async (_event, settings: any) => {
  const before = getSettings();
  if (typeof settings?.vaultPath === 'string' && settings.vaultPath !== before.vaultPath && isSessionActive()) {
    throw new Error('Stop the recording session before changing the vault.');
  }
  saveSettings(settings);
  const after = getSettings();

  if (before.vaultPath !== after.vaultPath) {
    watchVault();
    mainWindow?.webContents.send('library-changed', { paths: [] });
  }
```

(the rest of the handler is unchanged).

7. At the end of the file add:

```ts
registerLibraryIpc(() => mainWindow);

ipcMain.handle('copy-text', async (_event, text: unknown) => {
  if (typeof text !== 'string') throw new Error('text must be text');
  await clipboard.writeText(text);
});
```

- [ ] **Step 3: Replace `src/preload.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron';
import type { DarkWhisperApi } from './shared/api';

function on<T>(channel: string, callback: (payload: T) => void): void {
  ipcRenderer.on(channel, (_event, payload: T) => callback(payload));
}

const api: DarkWhisperApi = {
  onTranscriptionComplete: (callback) => on('transcription-complete', callback),
  onError: (callback) => on('error', callback),
  onRecordingStarted: (callback) => on('recording-started', () => callback()),
  onRecordingStopped: (callback) => on('recording-stopped', () => callback()),
  getStatus: (callback) => {
    void ipcRenderer.invoke('get-status').then(callback);
  },
  startRecording: () => ipcRenderer.invoke('start-recording'),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  copyToClipboard: () => ipcRenderer.invoke('copy-to-clipboard'),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),

  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  getAudioDevices: () => ipcRenderer.invoke('get-audio-devices'),
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

  startSession: (folder) => ipcRenderer.invoke('session-start', folder),
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
```

The old `public/index.html` keeps working with this bridge until Task 10 replaces it (it calls `getAudioDevices(): Promise<...>` and `getStatus(callback)`, both unchanged).

- [ ] **Step 4: Verify**

```bash
npm run build && npm test && npm run lint
grep -n "require(" dist/preload.js
```

Expected: clean; only `require("electron")`.

Live check (see Task 5 Step 7 for launching, restoring the vault, and stopping the instance). Prepare a vault first:

```bash
V="$TEMP/dw-vault-t6"; rm -rf "$V"; mkdir -p "$V/Clients"
printf -- '---\ntitle: Kickoff\ncreated: 2026-09-01T09:00:00Z\n---\n\nThe quarterly budget\n' > "$V/2026-09-01-0900-kickoff.md"
printf 'plain note\n' > "$V/Clients/acme.md"
VW=$(cygpath -w "$V" | sed 's/\\/\\\\/g')
(npx electron . --remote-debugging-port=9333 > "$TEMP/dw-t6.log" 2>&1 &)
node scripts/dev-cdp.mjs "window.api.getSettings().then(s => s.vaultPath)"
node scripts/dev-cdp.mjs "window.api.saveSettings({ vaultPath: '$VW' })"
node scripts/dev-cdp.mjs "window.api.getLibraryTree().then(t => ({ exists: t.exists, folders: t.folders, docs: t.documents.map(d => d.file + ' | ' + d.title) }))"
node scripts/dev-cdp.mjs "window.api.searchLibrary('budget')"
node scripts/dev-cdp.mjs "window.api.readDocument('../x.md').catch(e => e.message)"
node scripts/dev-cdp.mjs "window.__changes = []; window.api.onLibraryChanged(c => window.__changes.push(c)); window.api.createFolder('', 'Archive')"
node scripts/dev-cdp.mjs "window.api.moveDocument('Clients/acme.md', 'Archive')"
node scripts/dev-cdp.mjs "window.api.renameDocument('2026-09-01-0900-kickoff.md', 'Team kickoff')"
node scripts/dev-cdp.mjs "window.api.deleteDocument('Archive/acme.md')"
node scripts/dev-cdp.mjs "window.__changes"
node scripts/dev-cdp.mjs "window.api.copyText('hello from the workspace')"
```

Expected: `exists: true`; folders `[Clients]`; two documents with titles `Kickoff` and `acme`; one search hit `{ file: '2026-09-01-0900-kickoff.md', line: 6, text: 'The quarterly budget' }`; the `../x.md` read fails with `Outside the vault`; `Archive`; `Archive/acme.md`; `2026-09-01-0900-team-kickoff.md`; delete resolves (the note is in the Recycle Bin); `__changes` holds at least one entry whose `paths` include `Archive`; the clipboard holds `hello from the workspace` (paste it somewhere to check). Restore the vault setting and stop the instance.

- [ ] **Step 5: Commit**

```bash
git add src/services/libraryRuntime.ts src/main.ts src/preload.ts
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Expose the vault library to the window" -m "Library IPC for the tree, search, reading, renaming, moving, deleting to the Recycle Bin and folders, a vault watcher that falls back to polling, a vault picker, and a typed preload bridge. The window grows to 1200x760 and never navigates away; web links open in the browser." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Library tree view model

**Files:**
- Create: `src/renderer/libraryTree.ts`
- Test: `src/__tests__/libraryTree.test.ts`

**Interfaces:**
- Consumes: `FolderNode`, `LibraryDocument`, `LibraryTree` (Task 1).
- Produces:
  - `interface FolderView { path: string; name: string; depth: number; expanded: boolean; folders: FolderView[]; documents: LibraryDocument[] }`
  - `type VisibleRow = { kind: 'folder'; path: string; depth: number } | { kind: 'document'; file: string; depth: number }`
  - `documentTime(doc: LibraryDocument): number`
  - `sortDocuments(documents: readonly LibraryDocument[]): LibraryDocument[]`
  - `buildTree(tree: LibraryTree, expanded: ReadonlySet<string>, titleFilter?: string): FolderView`
  - `visibleRows(root: FolderView): VisibleRow[]`
  - `folderChoices(tree: LibraryTree): { value: string; label: string }[]`
  - `parentFolder(file: string): string`
  - `expandTo(expanded: ReadonlySet<string>, folder: string): Set<string>`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/libraryTree.test.ts`:

```ts
import type { LibraryDocument, LibraryTree } from '../shared/api';
import { buildTree, expandTo, folderChoices, parentFolder, visibleRows } from '../renderer/libraryTree';

const d = (file: string, title: string, created: string, mtimeMs = 0): LibraryDocument => ({
  file,
  folder: parentFolder(file),
  title,
  created,
  mtimeMs,
  readable: true,
});

const TREE: LibraryTree = {
  root: 'C:/vault',
  exists: true,
  folders: [
    { path: 'Clients', name: 'Clients', children: [{ path: 'Clients/Acme', name: 'Acme', children: [] }] },
    { path: 'Notes', name: 'Notes', children: [] },
  ],
  documents: [
    d('old.md', 'Old', '2026-09-01T10:00:00Z'),
    d('new.md', 'New', '2026-09-16T10:00:00Z'),
    d('nodate.md', 'No date', '', Date.parse('2026-09-10T00:00:00Z')),
    d('Clients/Acme/kickoff.md', 'Kickoff budget', '2026-09-12T09:00:00Z'),
    d('Notes/todo.md', 'Todo', '2026-09-11T09:00:00Z'),
  ],
};

describe('buildTree', () => {
  it('sorts documents newest first, using the file time when created is missing', () => {
    const root = buildTree(TREE, new Set());
    expect(root.documents.map((x) => x.file)).toEqual(['new.md', 'nodate.md', 'old.md']);
    expect(root.folders.map((f) => f.name)).toEqual(['Clients', 'Notes']);
    expect(root.expanded).toBe(true);
    expect(root.folders[0].expanded).toBe(false);
    expect(root.folders[0].folders[0].documents.map((x) => x.file)).toEqual(['Clients/Acme/kickoff.md']);
  });

  it('filters by title, keeping and expanding the folders that contain matches', () => {
    const root = buildTree(TREE, new Set(), 'BUDGET');
    expect(visibleRows(root)).toEqual([
      { kind: 'folder', path: '', depth: 0 },
      { kind: 'folder', path: 'Clients', depth: 1 },
      { kind: 'folder', path: 'Clients/Acme', depth: 2 },
      { kind: 'document', file: 'Clients/Acme/kickoff.md', depth: 3 },
    ]);
  });

  it('returns an empty root when nothing matches', () => {
    const root = buildTree(TREE, new Set(), 'zzz');
    expect(root.folders).toEqual([]);
    expect(root.documents).toEqual([]);
  });
});

describe('visibleRows', () => {
  it('lists only the rows of expanded folders', () => {
    expect(visibleRows(buildTree(TREE, new Set(['Clients'])))).toEqual([
      { kind: 'folder', path: '', depth: 0 },
      { kind: 'folder', path: 'Clients', depth: 1 },
      { kind: 'folder', path: 'Clients/Acme', depth: 2 },
      { kind: 'folder', path: 'Notes', depth: 1 },
      { kind: 'document', file: 'new.md', depth: 1 },
      { kind: 'document', file: 'nodate.md', depth: 1 },
      { kind: 'document', file: 'old.md', depth: 1 },
    ]);
  });
});

describe('folder helpers', () => {
  it('offers every folder as a move target', () => {
    expect(folderChoices(TREE)).toEqual([
      { value: '', label: 'Vault (root)' },
      { value: 'Clients', label: 'Clients' },
      { value: 'Clients/Acme', label: 'Clients/Acme' },
      { value: 'Notes', label: 'Notes' },
    ]);
  });

  it('expands every ancestor of a folder', () => {
    expect([...expandTo(new Set(['Notes']), 'Clients/Acme')].sort()).toEqual(['Clients', 'Clients/Acme', 'Notes']);
    expect(expandTo(new Set(), '').size).toBe(0);
  });

  it('finds the parent folder of a file', () => {
    expect(parentFolder('a.md')).toBe('');
    expect(parentFolder('Clients/Acme/k.md')).toBe('Clients/Acme');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx jest src/__tests__/libraryTree.test.ts`
Expected: FAIL — `Cannot find module '../renderer/libraryTree'`.

- [ ] **Step 3: Write `src/renderer/libraryTree.ts`**

```ts
import type { FolderNode, LibraryDocument, LibraryTree } from '../shared/api.js';

export interface FolderView {
  path: string;
  name: string;
  depth: number;
  expanded: boolean;
  folders: FolderView[];
  documents: LibraryDocument[];
}

export type VisibleRow =
  | { kind: 'folder'; path: string; depth: number }
  | { kind: 'document'; file: string; depth: number };

export function documentTime(doc: LibraryDocument): number {
  const created = Date.parse(doc.created);
  return Number.isNaN(created) ? doc.mtimeMs : created;
}

export function sortDocuments(documents: readonly LibraryDocument[]): LibraryDocument[] {
  return [...documents].sort((a, b) => documentTime(b) - documentTime(a) || a.file.localeCompare(b.file));
}

// The root is always expanded. While a title filter is active, only folders holding a match
// are kept, and they are all expanded.
export function buildTree(tree: LibraryTree, expanded: ReadonlySet<string>, titleFilter = ''): FolderView {
  const needle = titleFilter.trim().toLowerCase();
  const byFolder = new Map<string, LibraryDocument[]>();
  for (const doc of tree.documents) {
    if (needle !== '' && !doc.title.toLowerCase().includes(needle) && !doc.file.toLowerCase().includes(needle)) {
      continue;
    }
    const list = byFolder.get(doc.folder) ?? [];
    list.push(doc);
    byFolder.set(doc.folder, list);
  }

  const build = (node: FolderNode, depth: number): FolderView | null => {
    const folders = node.children
      .map((child) => build(child, depth + 1))
      .filter((folder): folder is FolderView => folder !== null);
    const documents = sortDocuments(byFolder.get(node.path) ?? []);
    if (depth > 0 && needle !== '' && folders.length === 0 && documents.length === 0) return null;
    return {
      path: node.path,
      name: node.name,
      depth,
      expanded: depth === 0 || needle !== '' || expanded.has(node.path),
      folders,
      documents,
    };
  };

  return build({ path: '', name: 'Vault', children: tree.folders }, 0) as FolderView;
}

export function visibleRows(root: FolderView): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const walk = (folder: FolderView) => {
    rows.push({ kind: 'folder', path: folder.path, depth: folder.depth });
    if (!folder.expanded) return;
    for (const child of folder.folders) walk(child);
    for (const doc of folder.documents) rows.push({ kind: 'document', file: doc.file, depth: folder.depth + 1 });
  };
  walk(root);
  return rows;
}

export function folderChoices(tree: LibraryTree): { value: string; label: string }[] {
  const choices = [{ value: '', label: 'Vault (root)' }];
  const walk = (nodes: FolderNode[]) => {
    for (const node of nodes) {
      choices.push({ value: node.path, label: node.path });
      walk(node.children);
    }
  };
  walk(tree.folders);
  return choices;
}

export function parentFolder(file: string): string {
  const slash = file.lastIndexOf('/');
  return slash === -1 ? '' : file.slice(0, slash);
}

export function expandTo(expanded: ReadonlySet<string>, folder: string): Set<string> {
  const next = new Set(expanded);
  const parts = folder.split('/').filter((part) => part !== '');
  for (let i = 1; i <= parts.length; i++) next.add(parts.slice(0, i).join('/'));
  return next;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/__tests__/libraryTree.test.ts`
Expected: PASS. Then `npm run build && npm test && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/libraryTree.ts src/__tests__/libraryTree.test.ts
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Model the library tree for the renderer" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Document view model

**Files:**
- Create: `src/renderer/documentView.ts`
- Test: `src/__tests__/documentView.test.ts`

**Interfaces:**
- Consumes: `formatClock` (Task 1); `BlockEvent` (Task 1).
- Produces:
  - `interface DocumentPart { kind: 'intro' | 'block' | 'gap'; index: number; startSec: number; endSec: number; continued: boolean; line: number; markdown: string }` (`line` is the 1-based file line where the part starts; `continued` marks block text that follows a gap)
  - `interface ParsedDocument { frontmatter: Record<string, string>; parts: DocumentPart[] }`
  - `splitFrontmatter(text: string): { frontmatter: Record<string, string>; body: string }`
  - `parseDocument(content: string): ParsedDocument`
  - `mergeLiveText(parts: readonly DocumentPart[], pending: ReadonlyMap<number, string>, blocks: readonly BlockEvent[]): DocumentPart[]`
  - `partIndexForLine(parts: readonly DocumentPart[], line: number): number`
  - `plainText(parts: readonly DocumentPart[]): string`
  - `documentTitle(frontmatter: Record<string, string>, file: string): string`
  - `blockCaption(part: DocumentPart): string`
  - `frontmatterRows(frontmatter: Record<string, string>): { label: string; value: string }[]`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/documentView.test.ts`:

```ts
import type { BlockEvent } from '../shared/api';
import {
  blockCaption,
  documentTitle,
  DocumentPart,
  frontmatterRows,
  mergeLiveText,
  parseDocument,
  partIndexForLine,
  plainText,
} from '../renderer/documentView';

const DOC = [
  '---',
  'title: Team sync',
  'created: 2026-09-16T10:06:12Z',
  'duration: 250',
  '---',
  '',
  'Preamble written by hand.',
  '',
  '<!-- dw:block 1 t=0-120 -->',
  '## 00:00:00',
  'First block text.',
  '',
  '<!-- dw:block 2 t=120-240 -->',
  'Before the gap.',
  '<!-- dw:gap -->',
  '*(recording interrupted and resumed)*',
  'After the gap.',
  '',
  '<!-- dw:block 3 t=240-360 -->',
  '',
].join('\n');

const part = (overrides: Partial<DocumentPart>): DocumentPart => ({
  kind: 'block',
  index: 0,
  startSec: 0,
  endSec: 0,
  continued: false,
  line: 1,
  markdown: '',
  ...overrides,
});

describe('parseDocument', () => {
  it('splits frontmatter, intro, blocks and gaps with their file lines', () => {
    const parsed = parseDocument(DOC);
    expect(parsed.frontmatter).toEqual({ title: 'Team sync', created: '2026-09-16T10:06:12Z', duration: '250' });
    expect(parsed.parts).toEqual([
      part({ kind: 'intro', line: 7, markdown: 'Preamble written by hand.' }),
      part({ index: 1, startSec: 0, endSec: 120, line: 9, markdown: '## 00:00:00\nFirst block text.' }),
      part({ index: 2, startSec: 120, endSec: 240, line: 13, markdown: 'Before the gap.' }),
      part({ kind: 'gap', line: 15 }),
      part({ index: 2, startSec: 120, endSec: 240, continued: true, line: 17, markdown: 'After the gap.' }),
      part({ index: 3, startSec: 240, endSec: 360, line: 19, markdown: '' }),
    ]);
  });

  it('treats a note without frontmatter or markers as plain Markdown', () => {
    expect(parseDocument('# Notes\r\n\r\nplain text\r\n')).toEqual({
      frontmatter: {},
      parts: [part({ kind: 'intro', line: 1, markdown: '# Notes\n\nplain text' })],
    });
  });

  it('keeps malformed markers and unterminated frontmatter as text', () => {
    const parsed = parseDocument('---\ntitle: x\n<!-- dw:block x t=1-2 -->');
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.parts).toEqual([
      part({ kind: 'intro', line: 1, markdown: '---\ntitle: x\n<!-- dw:block x t=1-2 -->' }),
    ]);
  });
});

describe('mergeLiveText', () => {
  const blocks: BlockEvent[] = [{ sessionId: 's', blockIndex: 4, startSec: 360, endSec: 480, state: 'live' }];

  it('appends pending text to the last part of its block', () => {
    const parts = parseDocument(DOC).parts;
    const merged = mergeLiveText(parts, new Map([[2, 'more words']]), []);
    expect(merged[4].markdown).toBe('After the gap. more words');
    expect(merged[2].markdown).toBe('Before the gap.');
    expect(parts[4].markdown).toBe('After the gap.');
  });

  it('starts a new line after a heading and fills empty blocks', () => {
    const merged = mergeLiveText(
      [part({ index: 1, markdown: '## 00:00:00' }), part({ index: 3, markdown: '' })],
      new Map([
        [1, 'hello'],
        [3, 'there'],
      ]),
      [],
    );
    expect(merged.map((p) => p.markdown)).toEqual(['## 00:00:00\nhello', 'there']);
  });

  it('adds a block the last read did not contain yet, using its event range', () => {
    const merged = mergeLiveText([part({ index: 3, markdown: 'x' })], new Map([[4, 'new block']]), blocks);
    expect(merged[1]).toEqual(part({ index: 4, startSec: 360, endSec: 480, line: 0, markdown: 'new block' }));
  });
});

describe('document helpers', () => {
  const parsed = parseDocument(DOC);

  it('finds the part that contains a file line', () => {
    expect(partIndexForLine(parsed.parts, 11)).toBe(1);
    expect(partIndexForLine(parsed.parts, 16)).toBe(2);
    expect(partIndexForLine(parsed.parts, 17)).toBe(4);
    expect(partIndexForLine(parsed.parts, 3)).toBe(-1);
  });

  it('copies the body without frontmatter, markers or gap notes', () => {
    expect(plainText(parsed.parts)).toBe(
      'Preamble written by hand.\n\n## 00:00:00\nFirst block text.\n\nBefore the gap.\n\nAfter the gap.',
    );
  });

  it('names a document by its title, else its file name', () => {
    expect(documentTitle(parsed.frontmatter, 'x.md')).toBe('Team sync');
    expect(documentTitle({}, 'Work/ideas.md')).toBe('ideas');
  });

  it('captions a block with its time range', () => {
    expect(blockCaption(part({ index: 2, startSec: 120, endSec: 240 }))).toBe('Block 2 · 02:00–04:00');
  });

  it('lists the known frontmatter fields', () => {
    expect(frontmatterRows({ created: 'x', duration: '250', title: 't', other: 'y' })).toEqual([
      { label: 'Created', value: 'x' },
      { label: 'Duration', value: '04:10' },
    ]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx jest src/__tests__/documentView.test.ts`
Expected: FAIL — `Cannot find module '../renderer/documentView'`.

- [ ] **Step 3: Write `src/renderer/documentView.ts`**

```ts
import type { BlockEvent } from '../shared/api.js';
import { formatClock } from './format.js';

// Mirrors the formats written by src/services/documentStore.ts and sessionService.ts.
const BLOCK_LINE = /^<!-- dw:block (\d+) t=(\d+)-(\d+) -->$/;
const GAP_LINE = '<!-- dw:gap -->';
const GAP_NOTE = '*(recording interrupted and resumed)*';

export interface DocumentPart {
  kind: 'intro' | 'block' | 'gap';
  index: number;
  startSec: number;
  endSec: number;
  continued: boolean;
  line: number;
  markdown: string;
}

export interface ParsedDocument {
  frontmatter: Record<string, string>;
  parts: DocumentPart[];
}

export function splitFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  if (!text.startsWith('---\n')) return { frontmatter: {}, body: text };
  const end = text.indexOf('\n---', 4);
  if (end === -1) return { frontmatter: {}, body: text };
  const frontmatter: Record<string, string> = {};
  for (const line of text.slice(4, end).split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) frontmatter[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { frontmatter, body: text.slice(end + 4).replace(/^\n+/, '') };
}

export function parseDocument(content: string): ParsedDocument {
  const text = content.replace(/\r\n/g, '\n');
  const { frontmatter, body } = splitFrontmatter(text);
  const bodyStart = text.slice(0, text.length - body.length).split('\n').length;
  const lines = body.split('\n');
  const parts: DocumentPart[] = [];
  let current: DocumentPart = {
    kind: 'intro',
    index: 0,
    startSec: 0,
    endSec: 0,
    continued: false,
    line: bodyStart,
    markdown: '',
  };
  let buffer: string[] = [];
  const flush = () => {
    const markdown = buffer.join('\n').trim();
    if (current.kind === 'block' || markdown !== '') parts.push({ ...current, markdown });
    buffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const block = BLOCK_LINE.exec(trimmed);
    if (block) {
      flush();
      current = {
        kind: 'block',
        index: Number(block[1]),
        startSec: Number(block[2]),
        endSec: Number(block[3]),
        continued: false,
        line: bodyStart + i,
        markdown: '',
      };
      continue;
    }
    if (trimmed === GAP_LINE) {
      flush();
      parts.push({ kind: 'gap', index: 0, startSec: 0, endSec: 0, continued: false, line: bodyStart + i, markdown: '' });
      if (lines[i + 1] !== undefined && lines[i + 1].trim() === GAP_NOTE) i++;
      // Text after a gap still belongs to the block the gap interrupted.
      current = { ...current, continued: current.kind === 'block', line: bodyStart + i + 1 };
      continue;
    }
    buffer.push(lines[i]);
  }
  flush();
  return { frontmatter, parts };
}

// Live segments arrive faster than the file is re-read; show them at the end of their block.
export function mergeLiveText(
  parts: readonly DocumentPart[],
  pending: ReadonlyMap<number, string>,
  blocks: readonly BlockEvent[],
): DocumentPart[] {
  const result = parts.map((p) => ({ ...p }));
  const lastPart = new Map<number, number>();
  result.forEach((p, i) => {
    if (p.kind === 'block') lastPart.set(p.index, i);
  });
  const missing = [...pending.keys()].filter((index) => !lastPart.has(index)).sort((a, b) => a - b);
  for (const index of missing) {
    const event = blocks.find((b) => b.blockIndex === index);
    result.push({
      kind: 'block',
      index,
      startSec: event ? event.startSec : 0,
      endSec: event ? event.endSec : 0,
      continued: false,
      line: 0,
      markdown: '',
    });
    lastPart.set(index, result.length - 1);
  }
  for (const [index, text] of pending) {
    const target = result[lastPart.get(index) as number];
    const lastLine = target.markdown.slice(target.markdown.lastIndexOf('\n') + 1);
    const separator = target.markdown === '' ? '' : lastLine.startsWith('#') ? '\n' : ' ';
    target.markdown = `${target.markdown}${separator}${text}`;
  }
  return result;
}

export function partIndexForLine(parts: readonly DocumentPart[], line: number): number {
  let found = -1;
  parts.forEach((p, i) => {
    if (p.kind !== 'gap' && p.line > 0 && p.line <= line) found = i;
  });
  return found;
}

export function plainText(parts: readonly DocumentPart[]): string {
  return parts
    .map((p) => p.markdown)
    .filter((markdown) => markdown !== '')
    .join('\n\n');
}

export function documentTitle(frontmatter: Record<string, string>, file: string): string {
  return frontmatter.title || file.slice(file.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}

export function blockCaption(part: DocumentPart): string {
  return `Block ${part.index} · ${formatClock(part.startSec)}–${formatClock(part.endSec)}`;
}

const FRONTMATTER_FIELDS: [string, string][] = [
  ['created', 'Created'],
  ['duration', 'Duration'],
  ['language', 'Language'],
  ['liveModel', 'Live model'],
  ['refineModel', 'Refine model'],
  ['app', 'App'],
];

export function frontmatterRows(frontmatter: Record<string, string>): { label: string; value: string }[] {
  return FRONTMATTER_FIELDS.filter(([key]) => frontmatter[key] !== undefined && frontmatter[key] !== '').map(
    ([key, label]) => ({
      label,
      value: key === 'duration' ? formatClock(Number(frontmatter[key]) || 0) : frontmatter[key],
    }),
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/__tests__/documentView.test.ts`
Expected: PASS. Then `npm run build && npm test && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/documentView.ts src/__tests__/documentView.test.ts
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Split session documents into blocks for display" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Session view model and app state

**Files:**
- Create: `src/renderer/sessionModel.ts`, `src/renderer/state.ts`
- Test: `src/__tests__/sessionModel.test.ts`

**Interfaces:**
- Consumes: `BlockEvent`, `BlockState`, `SegmentEvent`, `SessionStatusView`, `LibraryTree`, `DocumentContent` (Task 1); `formatClock` (Task 1).
- Produces:
  - `sessionModel.ts`: `interface SessionModel { status: SessionStatusView | null; blocks: BlockEvent[]; pendingText: Map<number, string> }`, `emptySessionModel()`, `isSessionRunning(status: SessionStatusView | null): boolean`, `applyStatus(model, status)`, `applyBlock(model, event)`, `applySegment(model, segment)`, `clearPendingText(model)`, `sessionSummary(status: SessionStatusView): string`, `BLOCK_LABELS: Record<BlockState, string>`
  - `state.ts`: `interface AppState { tree: LibraryTree | null; expanded: Set<string>; selectedFile: string | null; selectedFolder: string; document: DocumentContent | null; session: SessionModel; search: string; scrollToLine: number | null; scrollToBlock: number | null }`, `getState(): AppState`, `update(patch: Partial<AppState>): void`, `subscribe(listener: (state: AppState, changed: ReadonlySet<keyof AppState>) => void): void`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/sessionModel.test.ts`:

```ts
import type { BlockEvent, SessionStatusView } from '../shared/api';
import {
  applyBlock,
  applySegment,
  applyStatus,
  clearPendingText,
  emptySessionModel,
  isSessionRunning,
  sessionSummary,
} from '../renderer/sessionModel';
import { getState, subscribe, update } from '../renderer/state';

const status = (overrides: Partial<SessionStatusView> = {}): SessionStatusView => ({
  sessionId: 's1',
  state: 'recording',
  documentPath: 'C:/v/a.md',
  documentFile: 'a.md',
  folder: '',
  blockIndex: 1,
  durationSec: 0,
  refining: 0,
  muted: false,
  microphone: 'Mic',
  liveModel: 'base',
  refineModel: 'turbo',
  messages: [],
  blocks: [],
  ...overrides,
});

const block = (blockIndex: number, state: BlockEvent['state'], sessionId = 's1'): BlockEvent => ({
  sessionId,
  blockIndex,
  startSec: (blockIndex - 1) * 120,
  endSec: blockIndex * 120,
  state,
});

describe('sessionModel', () => {
  it('takes blocks from the status and keeps them in order', () => {
    const model = applyStatus(emptySessionModel(), status({ blocks: [block(2, 'live'), block(1, 'queued')] }));
    expect(model.blocks.map((b) => b.blockIndex)).toEqual([1, 2]);
  });

  it('moves a block forward through its states but never back', () => {
    let model = applyStatus(emptySessionModel(), status());
    model = applyBlock(model, block(1, 'queued'));
    model = applyBlock(model, block(1, 'refined'));
    model = applyBlock(model, block(1, 'refining'));
    expect(model.blocks).toEqual([block(1, 'refined')]);
  });

  it('ignores block events from another session', () => {
    const model = applyStatus(emptySessionModel(), status());
    expect(applyBlock(model, block(1, 'live', 'other'))).toBe(model);
  });

  it('resets when a new session starts', () => {
    let model = applyStatus(emptySessionModel(), status({ blocks: [block(1, 'refined')] }));
    model = applySegment(model, { text: 'hi', blockIndex: 1 });
    model = applyStatus(model, status({ sessionId: 's2', blocks: [] }));
    expect(model.blocks).toEqual([]);
    expect(model.pendingText.size).toBe(0);
  });

  it('collects live text per block until the document is read again', () => {
    let model = applyStatus(emptySessionModel(), status());
    model = applySegment(model, { text: ' hello ', blockIndex: 1 });
    model = applySegment(model, { text: 'world', blockIndex: 1 });
    model = applySegment(model, { text: 'next', blockIndex: 2 });
    expect([...model.pendingText]).toEqual([
      [1, 'hello world'],
      [2, 'next'],
    ]);
    expect(clearPendingText(model).pendingText.size).toBe(0);
  });

  it('knows when a session is running', () => {
    expect(isSessionRunning(null)).toBe(false);
    expect(isSessionRunning(status({ state: 'paused' }))).toBe(true);
    expect(isSessionRunning(status({ state: 'starting' }))).toBe(true);
    expect(isSessionRunning(status({ state: 'stopped' }))).toBe(false);
    expect(isSessionRunning(status({ state: 'idle' }))).toBe(false);
  });

  it('summarises the session', () => {
    expect(sessionSummary(status({ state: 'paused', muted: true, durationSec: 75 }))).toBe('Paused (mic muted) · 01:15');
    expect(sessionSummary(status({ state: 'recording', durationSec: 3725 }))).toBe('Recording · 1:02:05');
    expect(sessionSummary(status({ state: 'idle' }))).toBe('No session');
  });
});

describe('state', () => {
  it('merges patches and reports which keys changed', () => {
    const seen: string[][] = [];
    subscribe((_state, changed) => seen.push([...changed]));
    update({ selectedFile: 'a.md', search: 'x' });
    expect(getState().selectedFile).toBe('a.md');
    expect(getState().search).toBe('x');
    expect(getState().selectedFolder).toBe('');
    expect(seen).toEqual([['selectedFile', 'search']]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx jest src/__tests__/sessionModel.test.ts`
Expected: FAIL — `Cannot find module '../renderer/sessionModel'`.

- [ ] **Step 3: Write `src/renderer/sessionModel.ts`**

```ts
import type { BlockEvent, BlockState, SegmentEvent, SessionStatusView } from '../shared/api.js';
import { formatClock } from './format.js';

export interface SessionModel {
  status: SessionStatusView | null;
  blocks: BlockEvent[];
  // Live text received since the document was last read, by block.
  pendingText: Map<number, string>;
}

// Events can arrive out of order (a status snapshot after a newer block event): never go back.
const RANK: Record<BlockState, number> = {
  live: 0,
  empty: 1,
  queued: 1,
  refining: 2,
  refined: 3,
  skipped: 3,
  failed: 3,
};

export const BLOCK_LABELS: Record<BlockState, string> = {
  live: 'live',
  empty: 'no speech',
  queued: 'waiting',
  refining: 'refining…',
  refined: 'refined',
  skipped: 'skipped',
  failed: 'failed',
};

const RUNNING_STATES: SessionStatusView['state'][] = ['starting', 'recording', 'paused', 'error'];

export function emptySessionModel(): SessionModel {
  return { status: null, blocks: [], pendingText: new Map() };
}

export function isSessionRunning(status: SessionStatusView | null): boolean {
  return status !== null && RUNNING_STATES.includes(status.state);
}

function upsert(blocks: BlockEvent[], event: BlockEvent): BlockEvent[] {
  const existing = blocks.find((b) => b.blockIndex === event.blockIndex);
  if (existing && RANK[event.state] < RANK[existing.state]) return blocks;
  const next = blocks.filter((b) => b.blockIndex !== event.blockIndex);
  next.push(event);
  return next.sort((a, b) => a.blockIndex - b.blockIndex);
}

export function applyStatus(model: SessionModel, status: SessionStatusView): SessionModel {
  const sameSession = model.status !== null && model.status.sessionId === status.sessionId;
  let blocks = sameSession ? model.blocks : [];
  for (const event of status.blocks) blocks = upsert(blocks, event);
  return { status, blocks, pendingText: sameSession ? model.pendingText : new Map() };
}

export function applyBlock(model: SessionModel, event: BlockEvent): SessionModel {
  if (!model.status || model.status.sessionId !== event.sessionId) return model;
  return { ...model, blocks: upsert(model.blocks, event) };
}

export function applySegment(model: SessionModel, segment: SegmentEvent): SessionModel {
  const text = segment.text.trim();
  if (text === '') return model;
  const pendingText = new Map(model.pendingText);
  const before = pendingText.get(segment.blockIndex);
  pendingText.set(segment.blockIndex, before ? `${before} ${text}` : text);
  return { ...model, pendingText };
}

// Main sends segment events after writing them and answers reads in order, so a document read
// already contains every segment that arrived before its reply.
export function clearPendingText(model: SessionModel): SessionModel {
  return model.pendingText.size === 0 ? model : { ...model, pendingText: new Map() };
}

export function sessionSummary(status: SessionStatusView): string {
  if (status.state === 'idle') return 'No session';
  const label =
    status.state === 'paused' && status.muted
      ? 'Paused (mic muted)'
      : status.state.charAt(0).toUpperCase() + status.state.slice(1);
  return `${label} · ${formatClock(status.durationSec)}`;
}
```

- [ ] **Step 4: Write `src/renderer/state.ts`**

```ts
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
```

- [ ] **Step 5: Run the tests**

Run: `npx jest src/__tests__/sessionModel.test.ts`
Expected: PASS. Then `npm run build && npm test && npm run lint`.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/sessionModel.ts src/renderer/state.ts src/__tests__/sessionModel.test.ts
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Model session state and the app state for the renderer" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Workspace shell — markup, theme, header and dialogs

**Files:**
- Rewrite: `public/index.html`
- Create: `public/app.css`, `src/renderer/dom.ts`, `src/renderer/toast.ts`, `src/renderer/dialogs.ts`, `src/renderer/header.ts`, `src/renderer/app.ts`

**Interfaces:**
- Consumes: `DarkWhisperApi` and view types (Task 1); `formatBytes`, `cleanIpcError` (Task 1); `isSessionRunning`, `applyStatus`, `applyBlock`, `applySegment` (Task 9); `getState`, `update`, `subscribe` (Task 9).
- Produces:
  - `dom.ts`: `byId<T extends HTMLElement = HTMLElement>(id: string): T`, `el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K]`
  - `toast.ts`: `toast(message: string, kind?: 'info' | 'error'): void`, `reportError(error: unknown): void`
  - `dialogs.ts`: `ask(options: AskOptions): Promise<string | null>`, `confirmAction(title: string, message: string, confirmLabel: string): Promise<boolean>`, `openSettings(): Promise<void>`, `openModels(): void`, `startModelDownload(id: string): void`, `initDialogs(hooks: { onSettingsSaved(settings: SettingsView): void }): void` where `interface AskOptions { title: string; message?: string; value?: string; choices?: { value: string; label: string }[]; confirmLabel?: string; danger?: boolean }` (`value` present → text input; `choices` present → select; neither → confirmation that resolves `'ok'`)
  - `header.ts`: `initHeader(): void`, `setShortcut(value: string): void`
  - `app.ts`: entry point; later tasks add `initLibrary()`, `initDocument()`, `initSessionPanel()` calls to it.
- Element ids later tasks rely on: `libraryBody`, `librarySearch`, `newFolderBtn`, `libraryTarget`, `rowMenu`, `docTitle`, `docRenameBtn`, `docCopyBtn`, `docOpenBtn`, `docBody`, `jumpLiveBtn`, `workspace`, `sessionPanel`, `panelBody`, `panelToggleBtn`, `toasts`, `askDialog`, `askTitle`, `askMessage`, `askInput`, `askSelect`, `askOkBtn`.

- [ ] **Step 1: Replace `public/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'">
  <title>Dark-Whisper</title>
  <link rel="stylesheet" href="app.css">
  <script src="vendor/marked.umd.js"></script>
  <script src="vendor/purify.min.js"></script>
  <script type="module" src="js/renderer/app.js"></script>
</head>
<body>
  <header class="topbar">
    <div class="brand">Dark-Whisper</div>
    <div class="server">
      <span class="dot" id="serverDot"></span>
      <span id="serverText">Checking transcription server…</span>
      <button class="link" id="serverRestartBtn" hidden>Restart</button>
      <button class="link" id="serverLogBtn" hidden>Open log</button>
    </div>
    <div class="dictation">
      <button class="btn" id="dictateBtn">🎤 Dictate</button>
      <span class="muted" id="dictateState">Ctrl+Q</span>
      <span class="last" id="lastText"></span>
      <button class="icon" id="copyLastBtn" title="Copy the last dictation" disabled>⧉</button>
    </div>
    <div class="session-controls">
      <button class="btn primary" id="sessionStartBtn">● Start session</button>
      <button class="btn" id="sessionPauseBtn" hidden>⏸ Pause</button>
      <button class="btn danger" id="sessionStopBtn" hidden>■ Stop</button>
    </div>
    <div class="tools">
      <button class="icon" id="modelsBtn" title="Speech models">🧠</button>
      <button class="icon" id="settingsBtn" title="Settings">⚙️</button>
    </div>
  </header>

  <div class="banner" id="setupBanner" hidden>
    <span>No speech model installed yet.</span>
    <button class="btn primary" id="setupDownloadBtn">Download recommended model (547 MB)</button>
  </div>

  <main class="workspace" id="workspace">
    <aside class="library" aria-label="Library">
      <input type="search" id="librarySearch" placeholder="Search the vault (Ctrl+F)">
      <div class="library-body" id="libraryBody" tabindex="0" role="tree"></div>
      <div class="library-footer">
        <button class="link" id="newFolderBtn">+ folder</button>
        <span class="muted" id="libraryTarget"></span>
      </div>
    </aside>

    <section class="document" aria-label="Document">
      <div class="doc-bar">
        <h1 id="docTitle">Select a document</h1>
        <button class="icon" id="docRenameBtn" title="Rename" hidden>✎</button>
        <button class="icon" id="docCopyBtn" title="Copy all" hidden>⧉</button>
        <button class="icon" id="docOpenBtn" title="Open in editor" hidden>↗</button>
      </div>
      <div class="doc-body" id="docBody"></div>
      <button class="btn jump" id="jumpLiveBtn" hidden>Jump to live ↓</button>
    </section>

    <aside class="panel" id="sessionPanel" aria-label="Session">
      <button class="icon collapse" id="panelToggleBtn" title="Hide the panel">⟩</button>
      <div class="panel-body" id="panelBody"></div>
    </aside>
  </main>

  <div class="menu" id="rowMenu" role="menu" hidden></div>
  <div class="toasts" id="toasts" aria-live="polite"></div>

  <dialog id="askDialog">
    <form method="dialog">
      <h2 id="askTitle"></h2>
      <p id="askMessage"></p>
      <input type="text" id="askInput">
      <select id="askSelect"></select>
      <div class="actions">
        <button class="btn primary" id="askOkBtn" value="ok">OK</button>
        <button class="btn" value="cancel" formnovalidate>Cancel</button>
      </div>
    </form>
  </dialog>

  <dialog id="settingsDialog" class="wide">
    <form method="dialog">
      <h2>Settings</h2>

      <h3>Quick dictation</h3>
      <label for="shortcutInput">Keyboard shortcut</label>
      <input type="text" id="shortcutInput" placeholder="e.g. Ctrl+Q, Alt+R">
      <label for="micDeviceInput">Microphone</label>
      <select id="micDeviceInput"></select>
      <label class="check"><input type="checkbox" id="autoMuteInput"> Mute system audio while recording</label>

      <h3>Transcription server</h3>
      <label class="check"><input type="radio" name="serverMode" id="serverModeBuiltin" value="builtin"> Built-in</label>
      <label class="check"><input type="radio" name="serverMode" id="serverModeExternal" value="external"> External API</label>
      <div id="builtinOptions">
        <label class="check"><input type="checkbox" id="forceCpuInput"> Force CPU (use if GPU transcription fails)</label>
      </div>
      <div id="externalOptions">
        <label for="apiUrlInput">API endpoint</label>
        <input type="text" id="apiUrlInput" placeholder="http://127.0.0.1:4444">
        <label for="apiTokenInput">API token (optional)</label>
        <input type="password" id="apiTokenInput" placeholder="Leave empty for a local API">
        <label class="check"><input type="checkbox" id="refineExternalInput"> Refine session blocks through this API (sends session audio to it)</label>
      </div>

      <h3>Sessions</h3>
      <label for="vaultPathInput">Vault folder</label>
      <div class="row-input">
        <input type="text" id="vaultPathInput" readonly>
        <button type="button" class="btn" id="chooseVaultBtn">Choose folder…</button>
      </div>
      <label for="captureDeviceInput">Session microphone</label>
      <select id="captureDeviceInput"></select>
      <p class="hint">The list fills in once a session has started.</p>
      <label for="liveModelInput">Live model (fast)</label>
      <input type="text" id="liveModelInput" placeholder="ggml-base.en.bin">
      <label for="languageInput">Language</label>
      <input type="text" id="languageInput" placeholder="en">
      <label for="blockMinutesInput">Minutes per block</label>
      <input type="number" id="blockMinutesInput" min="1" max="30">
      <label for="refineModeInput">Refine during recording</label>
      <select id="refineModeInput">
        <option value="auto">Auto (wait when models are large)</option>
        <option value="always">Always</option>
        <option value="afterStop">After stopping</option>
      </select>
      <label class="check"><input type="checkbox" id="timestampHeadingsInput"> Write timestamp headings in the document</label>
      <label class="check"><input type="checkbox" id="keepAudioInput"> Keep session audio after refinement</label>

      <div class="actions">
        <button type="button" class="btn primary" id="settingsSaveBtn">Save</button>
        <button class="btn" value="cancel" formnovalidate>Cancel</button>
      </div>
    </form>
  </dialog>

  <dialog id="modelsDialog" class="wide">
    <form method="dialog">
      <div class="dialog-head">
        <h2>Speech models</h2>
        <span class="muted" id="diskInfo"></span>
      </div>
      <div class="model-list" id="modelList"></div>
      <label for="customModelUrl">Custom model (Hugging Face .bin URL)</label>
      <div class="row-input">
        <input type="text" id="customModelUrl" placeholder="https://huggingface.co/owner/repo/resolve/main/model.bin">
        <button type="button" class="btn primary" id="customModelBtn">Download</button>
      </div>
      <div class="row-input">
        <span class="muted" id="customModelStatus"></span>
        <button type="button" class="link" id="customCancelBtn" hidden>Cancel</button>
      </div>
      <div class="actions">
        <button class="btn" value="close">Close</button>
      </div>
    </form>
  </dialog>
</body>
</html>
```

- [ ] **Step 2: Write `public/app.css`**

```css
:root {
  --bg: #15151b;
  --bg-raised: #1d1d25;
  --bg-hover: #262631;
  --bg-selected: #2f2f3d;
  --border: #2c2c38;
  --text: #e8e8ef;
  --muted: #9a9aab;
  --accent: #8b7bff;
  --danger: #ff6b6b;
  --ok: #4cc38a;
  --warn: #f5b942;
  --info: #5aa9ff;
  font-family: 'Segoe UI', system-ui, sans-serif;
  font-size: 14px;
  color-scheme: dark;
}

* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--text); display: flex; flex-direction: column; overflow: hidden; }
button { font: inherit; color: inherit; }
[hidden] { display: none !important; }
.muted { color: var(--muted); }

.btn { background: var(--bg-raised); border: 1px solid var(--border); border-radius: 6px; padding: 5px 12px; cursor: pointer; white-space: nowrap; }
.btn:hover:not(:disabled) { background: var(--bg-hover); }
.btn:disabled { opacity: 0.45; cursor: default; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.danger { border-color: var(--danger); color: var(--danger); }
.btn.primary.danger { background: var(--danger); color: #fff; }
.icon { background: none; border: none; border-radius: 6px; padding: 4px 8px; cursor: pointer; font-size: 15px; }
.icon:hover:not(:disabled) { background: var(--bg-hover); }
.icon:disabled { opacity: 0.4; cursor: default; }
.link { background: none; border: none; color: var(--accent); cursor: pointer; padding: 2px 4px; }

/* Header */
.topbar { display: flex; align-items: center; gap: 16px; padding: 8px 14px; border-bottom: 1px solid var(--border); background: var(--bg-raised); flex-wrap: wrap; }
.brand { font-weight: 600; letter-spacing: 0.02em; }
.server { display: flex; align-items: center; gap: 6px; color: var(--muted); min-width: 0; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); flex: none; }
.dot.ready { background: var(--ok); }
.dot.starting { background: var(--warn); }
.dot.error { background: var(--danger); }
.dot.external { background: var(--info); }
.dictation { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 200px; }
.last { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.session-controls, .tools { display: flex; align-items: center; gap: 6px; }
.banner { display: flex; align-items: center; gap: 12px; padding: 8px 14px; background: #2a2440; border-bottom: 1px solid var(--border); }

/* Workspace */
.workspace { flex: 1; display: grid; grid-template-columns: 260px 1fr 280px; min-height: 0; }
.workspace.panel-collapsed { grid-template-columns: 260px 1fr 36px; }
.workspace.panel-collapsed .panel-body { display: none; }

.library { display: flex; flex-direction: column; border-right: 1px solid var(--border); min-height: 0; }
.library input[type='search'] { margin: 10px; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-raised); color: var(--text); }
.library-body { flex: 1; overflow-y: auto; outline: none; padding-bottom: 8px; }
.library-footer { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-top: 1px solid var(--border); min-height: 34px; }
.library-footer .muted { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row { display: flex; align-items: center; gap: 6px; padding: 4px 8px; cursor: pointer; min-height: 28px; }
.row:hover { background: var(--bg-hover); }
.row.selected { background: var(--bg-selected); }
.row.target > .name { color: var(--accent); }
.library-body:focus .row.focused { outline: 1px solid var(--accent); outline-offset: -1px; }
.row .twisty { width: 12px; color: var(--muted); flex: none; }
.row .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .date { color: var(--muted); font-size: 12px; flex: none; }
.row .rec-dot { color: var(--danger); flex: none; }
.row .warn { color: var(--warn); flex: none; }
.row .row-menu { visibility: hidden; padding: 0 6px; }
.row:hover .row-menu, .row.selected .row-menu { visibility: visible; }
.row.hit { flex-direction: column; align-items: stretch; gap: 2px; }
.row.hit .snippet { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pad { padding: 8px 12px; margin: 0; }

.menu { position: fixed; z-index: 20; min-width: 180px; background: var(--bg-raised); border: 1px solid var(--border); border-radius: 8px; padding: 4px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45); }
.menu-item { display: block; width: 100%; text-align: left; background: none; border: none; padding: 6px 10px; border-radius: 5px; cursor: pointer; }
.menu-item:hover, .menu-item:focus { background: var(--bg-hover); outline: none; }
.menu-item.danger { color: var(--danger); }

.document { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.doc-bar { display: flex; align-items: center; gap: 4px; padding: 10px 18px; border-bottom: 1px solid var(--border); }
.doc-bar h1 { font-size: 17px; font-weight: 600; margin: 0 8px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.doc-body { flex: 1; overflow-y: auto; padding: 16px 28px 48px; line-height: 1.6; }
.doc-body .intro, .doc-body .block { margin-bottom: 14px; border-radius: 6px; }
.doc-body .caption { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; margin-bottom: 2px; }
.doc-body .md > :first-child { margin-top: 0; }
.doc-body .md > :last-child { margin-bottom: 0; }
.doc-body .md a { color: var(--accent); }
.doc-body .md pre, .doc-body .md code { background: var(--bg-raised); border-radius: 4px; }
.doc-body .md pre { padding: 8px 10px; overflow-x: auto; }
.doc-body .md blockquote { border-left: 3px solid var(--border); margin-left: 0; padding-left: 12px; color: var(--muted); }
.doc-body .gap { color: var(--muted); font-size: 12px; text-align: center; border-top: 1px dashed var(--border); margin: 12px 0; padding-top: 4px; }
.doc-body .cursor { color: var(--accent); animation: blink 1s steps(1) infinite; }
.doc-body .flash { animation: flash 1.6s ease-out; }
.doc-body .empty-state, .doc-body .error-state { color: var(--muted); margin-top: 40px; text-align: center; }
.doc-body .error-state { color: var(--danger); }
.jump { position: absolute; right: 24px; bottom: 18px; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4); }
@keyframes blink { 50% { opacity: 0; } }
@keyframes flash { from { background: rgba(139, 123, 255, 0.28); } to { background: transparent; } }

.badge { font-size: 11px; border-radius: 10px; padding: 1px 8px; background: var(--bg-hover); color: var(--muted); }
.badge.live { color: var(--danger); }
.badge.queued { color: var(--warn); }
.badge.refining { color: var(--info); }
.badge.refined { color: var(--ok); }
.badge.failed, .badge.skipped { color: var(--danger); }

.panel { position: relative; border-left: 1px solid var(--border); overflow-y: auto; min-height: 0; }
.panel .collapse { position: absolute; top: 6px; right: 6px; }
.panel-body { padding: 10px 14px 20px; }
.panel h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 14px 0 6px; }
.panel h2:first-child { margin-top: 4px; }
.details { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; margin: 0; }
.details dt { color: var(--muted); }
.details dd { margin: 0; overflow-wrap: anywhere; }
.blocks { list-style: none; margin: 0; padding: 0; }
.block-row { display: grid; grid-template-columns: 24px 1fr auto; gap: 6px; align-items: center; padding: 3px 4px; border-radius: 5px; cursor: pointer; }
.block-row:hover { background: var(--bg-hover); }
.block-row .num { color: var(--muted); }
.block-row .msg { grid-column: 2 / 4; color: var(--muted); font-size: 12px; }
.messages { margin: 0; padding-left: 16px; color: var(--muted); }

/* Toasts */
.toasts { position: fixed; right: 16px; bottom: 16px; display: flex; flex-direction: column; gap: 8px; z-index: 30; max-width: 420px; }
.toast { display: flex; align-items: flex-start; gap: 8px; background: var(--bg-raised); border: 1px solid var(--border); border-left: 4px solid var(--info); border-radius: 6px; padding: 8px 10px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4); }
.toast.error { border-left-color: var(--danger); }
.toast > span { flex: 1; }

/* Dialogs */
dialog { background: var(--bg-raised); color: var(--text); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; width: 380px; max-height: 85vh; overflow-y: auto; }
dialog.wide { width: 560px; }
dialog::backdrop { background: rgba(0, 0, 0, 0.55); }
dialog h2 { margin: 0 0 12px; font-size: 17px; }
dialog h3 { margin: 18px 0 6px; font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
dialog label { display: block; margin: 8px 0 3px; }
dialog label.check { display: flex; align-items: center; gap: 8px; }
dialog input[type='text'], dialog input[type='password'], dialog input[type='number'], dialog select {
  width: 100%; padding: 6px 9px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text);
}
dialog .row-input { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
dialog .row-input input { flex: 1; }
dialog .hint { color: var(--muted); font-size: 12px; margin: 3px 0 0; }
dialog .actions { display: flex; flex-direction: row-reverse; gap: 8px; margin-top: 18px; }
.dialog-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.model-list { display: flex; flex-direction: column; gap: 6px; margin: 10px 0 14px; }
.model-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; }
.model-name { font-weight: 600; }
.model-meta { color: var(--muted); font-size: 12px; }
.model-error { color: var(--danger); font-size: 12px; }
.model-actions { display: flex; align-items: center; gap: 6px; flex: none; }
.badge-active { color: var(--ok); font-size: 12px; }
.progress { width: 90px; height: 6px; background: var(--bg); border-radius: 3px; overflow: hidden; }
.progress-bar { height: 100%; background: var(--accent); width: 0; }
```

- [ ] **Step 3: Write `src/renderer/dom.ts` and `src/renderer/toast.ts`**

```ts
// src/renderer/dom.ts
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
```

```ts
// src/renderer/toast.ts
import { byId, el } from './dom.js';
import { cleanIpcError } from './format.js';

export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const node = el('div', `toast ${kind}`);
  const close = el('button', 'icon', '✕');
  close.title = 'Dismiss';
  close.addEventListener('click', () => node.remove());
  node.append(el('span', '', message), close);
  byId('toasts').append(node);
  setTimeout(() => node.remove(), kind === 'error' ? 10_000 : 4_000);
}

export function reportError(error: unknown): void {
  console.error(error);
  toast(cleanIpcError(error), 'error');
}
```

- [ ] **Step 4: Write `src/renderer/dialogs.ts`**

```ts
import type { DownloadProgressView, ModelEntryView, ModelListView, RefineMode, SettingsView } from '../shared/api.js';
import { byId, el } from './dom.js';
import { formatBytes } from './format.js';
import { reportError, toast } from './toast.js';

// ---- Ask / confirm: Electron does not implement window.prompt.

export interface AskOptions {
  title: string;
  message?: string;
  value?: string;
  choices?: { value: string; label: string }[];
  confirmLabel?: string;
  danger?: boolean;
}

export function ask(options: AskOptions): Promise<string | null> {
  const dialog = byId<HTMLDialogElement>('askDialog');
  const input = byId<HTMLInputElement>('askInput');
  const select = byId<HTMLSelectElement>('askSelect');
  const ok = byId<HTMLButtonElement>('askOkBtn');
  const wantsText = options.value !== undefined;
  const wantsChoice = options.choices !== undefined;

  byId('askTitle').textContent = options.title;
  byId('askMessage').textContent = options.message ?? '';
  byId('askMessage').hidden = !options.message;
  ok.textContent = options.confirmLabel ?? 'OK';
  ok.classList.toggle('danger', options.danger === true);
  input.hidden = !wantsText;
  input.value = options.value ?? '';
  select.hidden = !wantsChoice;
  select.replaceChildren(...(options.choices ?? []).map((choice) => new Option(choice.label, choice.value)));

  return new Promise((resolve) => {
    dialog.returnValue = '';
    dialog.addEventListener(
      'close',
      () => {
        if (dialog.returnValue !== 'ok') resolve(null);
        else if (wantsText) resolve(input.value);
        else if (wantsChoice) resolve(select.value);
        else resolve('ok');
      },
      { once: true },
    );
    dialog.showModal();
    if (wantsText) {
      input.focus();
      input.select();
    } else if (wantsChoice) {
      select.focus();
    } else {
      ok.focus();
    }
  });
}

export async function confirmAction(title: string, message: string, confirmLabel: string): Promise<boolean> {
  return (await ask({ title, message, confirmLabel, danger: true })) !== null;
}

// ---- Settings

let onSettingsSaved: (settings: SettingsView) => void = () => undefined;

function settingsFields() {
  return {
    shortcut: byId<HTMLInputElement>('shortcutInput'),
    micDevice: byId<HTMLSelectElement>('micDeviceInput'),
    autoMute: byId<HTMLInputElement>('autoMuteInput'),
    builtin: byId<HTMLInputElement>('serverModeBuiltin'),
    external: byId<HTMLInputElement>('serverModeExternal'),
    forceCpu: byId<HTMLInputElement>('forceCpuInput'),
    apiUrl: byId<HTMLInputElement>('apiUrlInput'),
    apiToken: byId<HTMLInputElement>('apiTokenInput'),
    refineExternal: byId<HTMLInputElement>('refineExternalInput'),
    vaultPath: byId<HTMLInputElement>('vaultPathInput'),
    captureDevice: byId<HTMLSelectElement>('captureDeviceInput'),
    liveModel: byId<HTMLInputElement>('liveModelInput'),
    language: byId<HTMLInputElement>('languageInput'),
    blockMinutes: byId<HTMLInputElement>('blockMinutesInput'),
    refineMode: byId<HTMLSelectElement>('refineModeInput'),
    timestampHeadings: byId<HTMLInputElement>('timestampHeadingsInput'),
    keepAudio: byId<HTMLInputElement>('keepAudioInput'),
  };
}

function syncServerMode(): void {
  const external = byId<HTMLInputElement>('serverModeExternal').checked;
  byId('externalOptions').hidden = !external;
  byId('builtinOptions').hidden = external;
}

async function fillMicDevices(selected: string): Promise<void> {
  const select = byId<HTMLSelectElement>('micDeviceInput');
  try {
    const devices = await window.api.getAudioDevices();
    select.replaceChildren(...devices.map((device) => new Option(device.name, device.id)));
  } catch (error) {
    console.error('Failed to load audio devices:', error);
    select.replaceChildren(new Option('System Default Microphone', 'default'));
  }
  select.value = selected || 'default';
}

// Session microphones come from the live engine; keep a saved name even when it is not listed.
async function fillCaptureDevices(selected: string): Promise<void> {
  const select = byId<HTMLSelectElement>('captureDeviceInput');
  const names = (await window.api.listCaptureDevices().catch(() => [])).map((device) => device.name);
  if (selected && !names.includes(selected)) names.push(selected);
  select.replaceChildren(new Option('System default', ''), ...names.map((name) => new Option(name, name)));
  select.value = selected;
}

export async function openSettings(): Promise<void> {
  const f = settingsFields();
  const settings = await window.api.getSettings();
  f.shortcut.value = settings.shortcut;
  f.autoMute.checked = settings.autoMuteAudio !== false;
  f.builtin.checked = settings.serverMode !== 'external';
  f.external.checked = settings.serverMode === 'external';
  f.forceCpu.checked = settings.forceCpu;
  f.apiUrl.value = settings.apiUrl;
  f.apiToken.value = settings.apiToken;
  f.refineExternal.checked = settings.refineWithExternalApi;
  f.vaultPath.value = settings.vaultPath;
  f.liveModel.value = settings.liveModelId;
  f.language.value = settings.language;
  f.blockMinutes.value = String(settings.blockMinutes);
  f.refineMode.value = settings.refineDuringRecording;
  f.timestampHeadings.checked = settings.timestampHeadings;
  f.keepAudio.checked = settings.keepSessionAudio;
  syncServerMode();
  await Promise.all([fillMicDevices(settings.micDevice), fillCaptureDevices(settings.captureDeviceName)]);
  byId<HTMLDialogElement>('settingsDialog').showModal();
}

async function saveSettingsFromDialog(): Promise<void> {
  const f = settingsFields();
  try {
    await window.api.saveSettings({
      shortcut: f.shortcut.value.trim() || 'Ctrl+Q',
      micDevice: f.micDevice.value || 'default',
      autoMuteAudio: f.autoMute.checked,
      serverMode: f.external.checked ? 'external' : 'builtin',
      forceCpu: f.forceCpu.checked,
      apiUrl: f.apiUrl.value.trim() || 'http://127.0.0.1:4444',
      apiToken: f.apiToken.value,
      refineWithExternalApi: f.refineExternal.checked,
      vaultPath: f.vaultPath.value || undefined,
      captureDeviceName: f.captureDevice.value,
      liveModelId: f.liveModel.value.trim() || 'ggml-base.en.bin',
      language: f.language.value.trim() || 'en',
      blockMinutes: Math.max(1, Math.min(30, Number(f.blockMinutes.value) || 2)),
      refineDuringRecording: f.refineMode.value as RefineMode,
      timestampHeadings: f.timestampHeadings.checked,
      keepSessionAudio: f.keepAudio.checked,
    });
    byId<HTMLDialogElement>('settingsDialog').close();
    toast('Settings saved. Shortcut changes apply after a restart.');
    onSettingsSaved(await window.api.getSettings());
  } catch (error) {
    reportError(error);
  }
}

// ---- Models

let modelsState: ModelListView = { models: [], activeModelId: null, downloading: false, disk: { usedBytes: 0, freeBytes: 0 } };
const progressById = new Map<string, DownloadProgressView>();
const errorById = new Map<string, string>();

function actionButton(text: string, className: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const button = el('button', `btn ${className}`, text);
  button.type = 'button';
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

function progressText(progress: DownloadProgressView): string {
  if (progress.state === 'verifying') return 'Verifying…';
  if (!progress.totalBytes) return formatBytes(progress.receivedBytes);
  const percent = Math.floor((progress.receivedBytes / progress.totalBytes) * 100);
  return `${percent}% · ${formatBytes(progress.bytesPerSec)}/s`;
}

function renderModelRow(model: ModelEntryView): HTMLElement {
  const row = el('div', 'model-row');
  const info = el('div', 'model-info');
  const meta = [formatBytes(model.sizeBytes), model.label].filter(Boolean).join(' · ');
  info.append(el('div', 'model-name', model.name), el('div', 'model-meta', meta));
  const error = errorById.get(model.id);
  if (error) info.append(el('div', 'model-error', error));

  const actions = el('div', 'model-actions');
  const progress = progressById.get(model.id);
  if (progress) {
    const bar = el('div', 'progress');
    const fill = el('div', 'progress-bar');
    fill.style.width = progress.totalBytes ? `${Math.floor((progress.receivedBytes / progress.totalBytes) * 100)}%` : '0%';
    bar.append(fill);
    actions.append(
      bar,
      el('span', 'model-meta', progressText(progress)),
      actionButton('Cancel', '', () => void window.api.cancelDownload()),
    );
  } else if (model.installed) {
    if (model.id === modelsState.activeModelId) {
      actions.append(el('span', 'badge-active', 'Active'));
    } else {
      actions.append(actionButton('Use', 'primary', () => void selectModel(model.id)));
    }
    actions.append(actionButton('Delete', 'danger', () => void deleteModel(model)));
  } else {
    actions.append(
      actionButton(error ? 'Retry' : 'Download', 'primary', () => startModelDownload(model.id), modelsState.downloading),
    );
  }
  row.append(info, actions);
  return row;
}

function renderModels(): void {
  const disk = modelsState.disk;
  byId('diskInfo').textContent = `Disk: ${formatBytes(disk.usedBytes)} used · ${formatBytes(disk.freeBytes)} free`;
  byId('modelList').replaceChildren(...modelsState.models.map(renderModelRow));
  byId<HTMLButtonElement>('customModelBtn').disabled = modelsState.downloading;
}

async function refreshModels(): Promise<void> {
  try {
    modelsState = await window.api.listModels();
    renderModels();
  } catch (error) {
    reportError(error);
  }
}

export function openModels(): void {
  const dialog = byId<HTMLDialogElement>('modelsDialog');
  if (!dialog.open) dialog.showModal();
  void refreshModels();
}

export function startModelDownload(id: string): void {
  errorById.delete(id);
  progressById.set(id, { id, receivedBytes: 0, totalBytes: null, bytesPerSec: 0, state: 'downloading' });
  modelsState.downloading = true;
  renderModels();
  window.api.downloadModel(id).catch(reportError);
}

async function selectModel(id: string): Promise<void> {
  try {
    await window.api.selectModel(id);
  } catch (error) {
    reportError(error);
  }
  await refreshModels();
}

async function deleteModel(model: ModelEntryView): Promise<void> {
  if (!(await confirmAction('Delete model', `Delete ${model.name}?`, 'Delete'))) return;
  try {
    await window.api.deleteModel(model.id);
  } catch (error) {
    reportError(error);
  }
  await refreshModels();
}

function onDownloadProgress(progress: DownloadProgressView): void {
  const active = progress.state === 'downloading' || progress.state === 'verifying';
  if (progress.id.startsWith('custom')) {
    const status = byId('customModelStatus');
    byId('customCancelBtn').hidden = !active;
    status.className = progress.state === 'error' ? 'model-error' : 'muted';
    const labels: Record<string, string> = { done: 'Downloaded', cancelled: 'Cancelled', error: progress.error ?? 'Failed' };
    status.textContent = active ? progressText(progress) : labels[progress.state] ?? '';
  } else if (active) {
    progressById.set(progress.id, progress);
  } else {
    progressById.delete(progress.id);
    if (progress.state === 'error') errorById.set(progress.id, progress.error ?? 'Download failed');
  }
  modelsState.downloading = active;
  if (active) renderModels();
  else void refreshModels();
}

// ---- Wiring

export function initDialogs(hooks: { onSettingsSaved(settings: SettingsView): void }): void {
  onSettingsSaved = hooks.onSettingsSaved;

  byId('serverModeBuiltin').addEventListener('change', syncServerMode);
  byId('serverModeExternal').addEventListener('change', syncServerMode);
  byId('settingsSaveBtn').addEventListener('click', () => void saveSettingsFromDialog());
  byId('chooseVaultBtn').addEventListener('click', async () => {
    try {
      const chosen = await window.api.chooseVault();
      if (chosen) byId<HTMLInputElement>('vaultPathInput').value = chosen;
    } catch (error) {
      reportError(error);
    }
  });

  byId('customModelBtn').addEventListener('click', () => {
    const url = byId<HTMLInputElement>('customModelUrl').value.trim();
    if (!url) return;
    const status = byId('customModelStatus');
    status.className = 'muted';
    status.textContent = 'Starting…';
    modelsState.downloading = true;
    renderModels();
    window.api.downloadCustomModel(url).catch(reportError);
  });
  byId('customCancelBtn').addEventListener('click', () => void window.api.cancelDownload());
  window.api.onDownloadProgress(onDownloadProgress);
  window.api.onOpenModels(openModels);
}
```

- [ ] **Step 5: Write `src/renderer/header.ts`**

```ts
import type { ServerStatusView } from '../shared/api.js';
import { openModels, openSettings, startModelDownload } from './dialogs.js';
import { byId } from './dom.js';
import { isSessionRunning } from './sessionModel.js';
import { getState, subscribe } from './state.js';
import { reportError, toast } from './toast.js';

const RECOMMENDED_MODEL_ID = 'ggml-large-v3-turbo-q5_0.bin';

// Main reports quick dictation as started → stopped → complete (or an error at any point).
type DictationState = 'idle' | 'recording' | 'transcribing';
let dictation: DictationState = 'idle';
let shortcut = 'Ctrl+Q';

function renderServer(view: ServerStatusView): void {
  byId('serverText').textContent = view.text;
  byId('serverDot').className = `dot ${view.mode === 'external' ? 'external' : view.state}`;
  const failed = view.mode === 'builtin' && view.state === 'error';
  byId('serverRestartBtn').hidden = !failed;
  byId('serverLogBtn').hidden = !failed;
  byId('setupBanner').hidden = !(view.mode === 'builtin' && view.state === 'no-model');
}

function renderControls(): void {
  const { session, tree } = getState();
  const status = session.status;
  const running = isSessionRunning(status);

  const dictate = byId<HTMLButtonElement>('dictateBtn');
  dictate.textContent = dictation === 'recording' ? '■ Stop dictation' : '🎤 Dictate';
  dictate.disabled = running || dictation === 'transcribing';
  byId('dictateState').textContent =
    dictation === 'recording' ? 'Recording…' : dictation === 'transcribing' ? 'Transcribing…' : shortcut;

  const start = byId<HTMLButtonElement>('sessionStartBtn');
  start.hidden = running;
  start.disabled = dictation !== 'idle' || tree?.exists === false;
  const pause = byId<HTMLButtonElement>('sessionPauseBtn');
  pause.hidden = !running || status?.state === 'error';
  pause.textContent = status?.state === 'paused' ? '▶ Resume' : '⏸ Pause';
  byId('sessionStopBtn').hidden = !running;
}

export function setShortcut(value: string): void {
  shortcut = value;
  renderControls();
}

export function initHeader(): void {
  window.api.onServerStatus(renderServer);
  window.api.getServerStatus().then(renderServer, reportError);
  byId('serverRestartBtn').addEventListener('click', () => window.api.restartServer().catch(reportError));
  byId('serverLogBtn').addEventListener('click', () => window.api.openServerLog().catch(reportError));
  byId('setupDownloadBtn').addEventListener('click', () => {
    openModels();
    startModelDownload(RECOMMENDED_MODEL_ID);
  });

  window.api.onRecordingStarted(() => {
    dictation = 'recording';
    renderControls();
  });
  window.api.onRecordingStopped(() => {
    dictation = 'transcribing';
    renderControls();
  });
  window.api.onTranscriptionComplete(({ transcription }) => {
    dictation = 'idle';
    const last = byId('lastText');
    last.textContent = transcription;
    last.title = transcription;
    byId<HTMLButtonElement>('copyLastBtn').disabled = false;
    renderControls();
  });
  window.api.onError(({ message }) => {
    dictation = 'idle';
    toast(message, 'error');
    renderControls();
  });
  window.api.getStatus(({ isRecording }) => {
    dictation = isRecording ? 'recording' : 'idle';
    renderControls();
  });
  window.api.getSettings().then((settings) => setShortcut(settings.shortcut), reportError);

  byId('dictateBtn').addEventListener('click', () => {
    const action = dictation === 'recording' ? window.api.stopRecording() : window.api.startRecording();
    action.catch(reportError);
  });
  byId('copyLastBtn').addEventListener('click', async () => {
    const result = await window.api.copyToClipboard();
    if (result.success) toast('Copied');
    else toast(result.message ?? 'Could not copy', 'error');
  });
  byId('sessionStartBtn').addEventListener('click', () => {
    window.api.startSession(getState().selectedFolder).catch(reportError);
  });
  byId('sessionPauseBtn').addEventListener('click', () => {
    const paused = getState().session.status?.state === 'paused';
    (paused ? window.api.resumeSession() : window.api.pauseSession()).catch(reportError);
  });
  byId('sessionStopBtn').addEventListener('click', () => window.api.stopSession().catch(reportError));
  byId('modelsBtn').addEventListener('click', openModels);
  byId('settingsBtn').addEventListener('click', () => openSettings().catch(reportError));

  subscribe((_state, changed) => {
    if (changed.has('session') || changed.has('tree')) renderControls();
  });
  renderControls();
}
```

- [ ] **Step 6: Write `src/renderer/app.ts`**

```ts
import { initDialogs } from './dialogs.js';
import { initHeader, setShortcut } from './header.js';
import { applyBlock, applySegment, applyStatus } from './sessionModel.js';
import { getState, update } from './state.js';
import { reportError } from './toast.js';

function initSession(): void {
  window.api.onSessionStatus((status) => update({ session: applyStatus(getState().session, status) }));
  window.api.onSessionBlock((event) => update({ session: applyBlock(getState().session, event) }));
  window.api.onSessionSegment((segment) => update({ session: applySegment(getState().session, segment) }));
  window.api.getSessionStatus().then((status) => update({ session: applyStatus(getState().session, status) }), reportError);
}

initDialogs({ onSettingsSaved: (settings) => setShortcut(settings.shortcut) });
initHeader();
initSession();
```

- [ ] **Step 7: Verify**

```bash
npm run build && npm test && npm run lint
grep -rn "innerHTML" src/renderer public/index.html
grep -n "style=" public/index.html
node -e "const h=require('fs').readFileSync('public/index.html','utf8');const src=require('fs').readdirSync('src/renderer').filter(f=>f.endsWith('.ts')).map(f=>require('fs').readFileSync('src/renderer/'+f,'utf8')).join('\n');const ids=[...src.matchAll(/byId(?:<[^>]+>)?\('([^']+)'\)/g)].map(m=>m[1]);const missing=[...new Set(ids)].filter(id=>!h.includes('id=\"'+id+'\"'));console.log(missing.length?'MISSING ids: '+missing.join(', '):'all ids present')"
```

Expected: clean build/tests/lint; no `innerHTML` and no `style=` matches; `all ids present`.

Live check (launch as in Task 5 Step 7):

```bash
node scripts/dev-cdp.mjs "({ server: document.getElementById('serverText').textContent, start: !document.getElementById('sessionStartBtn').hidden, dictate: document.getElementById('dictateState').textContent })"
node scripts/dev-cdp.mjs "document.getElementById('settingsBtn').click(); new Promise(r => setTimeout(r, 800)).then(() => ({ open: document.getElementById('settingsDialog').open, vault: document.getElementById('vaultPathInput').value, mics: document.getElementById('micDeviceInput').options.length }))"
node scripts/dev-cdp.mjs "document.getElementById('settingsDialog').close(); document.getElementById('modelsBtn').click(); new Promise(r => setTimeout(r, 800)).then(() => document.querySelectorAll('#modelList .model-row').length)"
node scripts/dev-cdp.mjs "document.getElementById('modelsDialog').close(); const p = (async () => { const { ask } = await import('./js/renderer/dialogs.js'); return ask({ title: 'Name?', value: 'x' }); })(); setTimeout(() => { document.getElementById('askInput').value = 'typed'; document.getElementById('askOkBtn').click(); }, 300); p"
```

Expected: the server text is not `Checking transcription server…`, the start button is visible, and the dictation hint shows the shortcut; the settings dialog is open, showing the vault path and at least one microphone; several model rows; the ask dialog resolves `"typed"`. Stop the instance.

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/app.css src/renderer/dom.ts src/renderer/toast.ts src/renderer/dialogs.ts src/renderer/header.ts src/renderer/app.ts
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Replace the window with the workspace shell" -m "A dark three-pane layout with a header for server status, quick dictation and session controls. Settings and Models become dialogs ported to TypeScript, the vault is chosen with a folder picker, and an in-app ask dialog replaces window.prompt. The temporary session strip is gone." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Library pane

**Files:**
- Create: `src/renderer/library.ts`
- Modify: `src/renderer/app.ts`

**Interfaces:**
- Consumes: `buildTree`, `visibleRows`, `folderChoices`, `expandTo`, `parentFolder`, `FolderView`, `VisibleRow` (Task 7); `ask`, `confirmAction` (Task 10); `formatDate` (Task 1); `isSessionRunning` (Task 9); state (Task 9).
- Produces: `initLibrary(): void`, `reloadTree(): Promise<void>`, `openDocument(file: string, line?: number): void`, `renameDocument(doc: { file: string; title: string }): Promise<void>`, `recordingFile(): string | null`.

Behaviour (spec §3.2): the root is always open; clicking a folder selects it as the next session's target and toggles it; clicking a document opens it; ⋯ or right-click opens the row menu (Rename, Move to, Open in editor, Reveal in Explorer, Delete — the first, second and last are omitted for the recording document); typing filters titles; Enter, or a 300 ms pause with 2+ characters, runs a full-text search whose hits replace the tree; Escape clears; ↑/↓/←/→/Enter/F2/Delete work while the tree has focus; Ctrl+F focuses search. When a session starts, its document is selected and its folder expanded.

- [ ] **Step 1: Write `src/renderer/library.ts`**

```ts
import type { LibraryDocument, LibrarySearchHit } from '../shared/api.js';
import { ask, confirmAction } from './dialogs.js';
import { byId, el } from './dom.js';
import { formatDate } from './format.js';
import { buildTree, expandTo, folderChoices, parentFolder, visibleRows, type FolderView, type VisibleRow } from './libraryTree.js';
import { isSessionRunning } from './sessionModel.js';
import { getState, subscribe, update, type AppState } from './state.js';
import { reportError, toast } from './toast.js';

const LIBRARY_KEYS = new Set<keyof AppState>(['tree', 'expanded', 'selectedFile', 'selectedFolder', 'search']);
const INDENT_PX = 14;

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

// ---- Document actions (also used by the document pane)

export async function renameDocument(doc: { file: string; title: string }): Promise<void> {
  const title = await ask({ title: 'Rename document', value: doc.title, confirmLabel: 'Rename' });
  if (title === null || title.trim() === '' || title.trim() === doc.title) return;
  const next = await window.api.renameDocument(doc.file, title.trim());
  if (getState().selectedFile === doc.file) update({ selectedFile: next });
  await reloadTree();
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
  const next = await window.api.moveDocument(doc.file, folder);
  if (getState().selectedFile === doc.file) {
    update({ selectedFile: next, expanded: expandTo(getState().expanded, folder) });
  }
  await reloadTree();
}

async function deleteDocument(doc: LibraryDocument): Promise<void> {
  if (!(await confirmAction('Delete document', `Move "${doc.title}" to the Recycle Bin?`, 'Delete'))) return;
  await window.api.deleteDocument(doc.file);
  if (getState().selectedFile === doc.file) update({ selectedFile: null, document: null });
  await reloadTree();
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

// ---- Row menu

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
  menu.style.top = `${Math.min(rect.bottom + 2, window.innerHeight - menu.offsetHeight - 4)}px`;
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

// ---- Rendering

function folderRow(folder: FolderView): HTMLElement {
  const { selectedFolder } = getState();
  const key = `folder:${folder.path}`;
  const row = el('div', 'row folder');
  row.style.paddingLeft = `${8 + folder.depth * INDENT_PX}px`;
  row.dataset.key = key;
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-expanded', String(folder.expanded));
  row.classList.toggle('target', selectedFolder === folder.path);
  row.classList.toggle('focused', focusedRow === key);
  const twisty = folder.depth === 0 ? '' : folder.expanded ? '▾' : '▸';
  row.append(el('span', 'twisty', twisty), el('span', 'name', folder.depth === 0 ? 'Vault' : folder.name));
  row.addEventListener('click', () => selectFolder(folder.path, folder.depth === 0 ? undefined : !folder.expanded));
  return row;
}

function documentRow(doc: LibraryDocument, depth: number): HTMLElement {
  const key = `doc:${doc.file}`;
  const row = el('div', 'row doc');
  row.style.paddingLeft = `${8 + depth * INDENT_PX}px`;
  row.dataset.key = key;
  row.setAttribute('role', 'treeitem');
  row.classList.toggle('selected', getState().selectedFile === doc.file);
  row.classList.toggle('focused', focusedRow === key);
  if (doc.file === recordingFile()) {
    const dot = el('span', 'rec-dot', '●');
    dot.title = 'Recording';
    row.append(dot);
  }
  if (!doc.readable) {
    const warn = el('span', 'warn', '⚠');
    warn.title = 'This file could not be read';
    row.append(warn);
  }
  const name = el('span', 'name', doc.title);
  name.title = doc.file;
  const menu = el('button', 'icon row-menu', '⋯');
  menu.title = 'Actions';
  menu.addEventListener('click', (event) => {
    event.stopPropagation();
    showDocumentMenu(doc, menu);
  });
  row.append(name, el('span', 'date', formatDate(doc.created, doc.mtimeMs)), menu);
  row.addEventListener('click', () => openDocument(doc.file));
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    showDocumentMenu(doc, row);
  });
  return row;
}

function folderRows(folder: FolderView): HTMLElement[] {
  const rows = [folderRow(folder)];
  if (!folder.expanded) return rows;
  for (const child of folder.folders) rows.push(...folderRows(child));
  for (const doc of folder.documents) rows.push(documentRow(doc, folder.depth + 1));
  return rows;
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

function renderLibrary(): void {
  const body = byId('libraryBody');
  const { tree, expanded, search, selectedFolder } = getState();
  byId('libraryTarget').textContent = selectedFolder ? `New sessions → ${selectedFolder}` : '';
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
  const root = buildTree(tree, expanded, search);
  body.replaceChildren(...folderRows(root));
  if (tree.documents.length === 0) {
    body.append(el('p', 'muted pad', 'No documents yet. Start a session to begin.'));
  } else if (search.trim() !== '' && root.folders.length === 0 && root.documents.length === 0) {
    body.append(el('p', 'muted pad', 'No matches'));
  }
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
  const { tree, expanded, search } = getState();
  if (!tree || searchHits) return;
  const rows = visibleRows(buildTree(tree, expanded, search));
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
  byId('newFolderBtn').addEventListener('click', () => void newFolder());
  document.addEventListener('click', hideMenu);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideMenu();
    if (event.ctrlKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      search.focus();
      search.select();
    }
  });
  window.api.onLibraryChanged(() => void reloadTree());

  subscribe((_state, changed) => {
    const recording = recordingFile();
    const recordingChanged = recording !== lastRecording;
    lastRecording = recording;
    if (recordingChanged && recording) {
      // A new session's document: show it (the watcher may not have reported it yet).
      void reloadTree().then(() => openDocument(recording));
    }
    if (recordingChanged || [...changed].some((key) => LIBRARY_KEYS.has(key))) renderLibrary();
  });

  renderLibrary();
  void reloadTree();
}
```

- [ ] **Step 2: Wire it into `src/renderer/app.ts`**

Add the import and the call (after `initHeader();`):

```ts
import { initLibrary } from './library.js';
```

```ts
initLibrary();
```

- [ ] **Step 3: Verify**

```bash
npm run build && npm test && npm run lint
grep -rn "innerHTML" src/renderer
```

Expected: clean; no `innerHTML` yet.

Live check with the Task 6 vault layout (recreate it: `2026-09-01-0900-kickoff.md` with the budget line, `Clients/acme.md`), launched and pointed at it as in Task 5 Step 7; wait ~1 s after changing the vault:

```bash
node scripts/dev-cdp.mjs "[...document.querySelectorAll('#libraryBody .row')].map(r => r.dataset.key)"
node scripts/dev-cdp.mjs "document.querySelector('[data-key=\"folder:Clients\"]').click(); [...document.querySelectorAll('#libraryBody .row')].map(r => r.dataset.key)"
node scripts/dev-cdp.mjs "const s = document.getElementById('librarySearch'); s.value = 'budget'; s.dispatchEvent(new Event('input')); new Promise(r => setTimeout(r, 900)).then(() => [...document.querySelectorAll('#libraryBody .row.hit')].map(r => r.textContent))"
node scripts/dev-cdp.mjs "const s = document.getElementById('librarySearch'); s.value = ''; s.dispatchEvent(new Event('input')); document.querySelector('[data-key=\"folder:\"]').click(); document.getElementById('newFolderBtn').click(); setTimeout(() => { document.getElementById('askInput').value = 'Archive'; document.getElementById('askOkBtn').click(); }, 300); new Promise(r => setTimeout(r, 1500)).then(() => [...document.querySelectorAll('#libraryBody .row')].map(r => r.dataset.key))"
node scripts/dev-cdp.mjs "document.querySelector('[data-key=\"doc:Clients/acme.md\"] .row-menu').click(); [...document.querySelectorAll('#rowMenu .menu-item')].map(b => b.textContent)"
node scripts/dev-cdp.mjs "[...document.querySelectorAll('#rowMenu .menu-item')].find(b => b.textContent === 'Move to…').click(); setTimeout(() => { document.getElementById('askSelect').value = 'Archive'; document.getElementById('askOkBtn').click(); }, 300); new Promise(r => setTimeout(r, 1500)).then(() => [...document.querySelectorAll('#libraryBody .row')].map(r => r.dataset.key))"
```

Expected:
1. `folder:`, `folder:Clients`, `doc:2026-09-01-0900-kickoff.md`.
2. After the click, `doc:Clients/acme.md` also appears.
3. One hit whose text contains `Kickoff` and `The quarterly budget`.
4. The rows include `folder:Archive`, and `New sessions → Archive` shows in the footer.
5. The menu offers Rename…, Move to…, Open in editor, Reveal in Explorer, Delete.
6. `doc:Archive/acme.md` appears, and `Clients/acme.md` is gone from disk.

Restore the vault setting and stop the instance.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/library.ts src/renderer/app.ts
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Add the library pane" -m "A folder tree of the vault with title filtering and full-text search, a row menu to rename, move, open, reveal or delete a document, new folders, keyboard navigation, and the selected folder as the next session's target." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Document pane

**Files:**
- Create: `src/renderer/document.ts`
- Modify: `src/renderer/app.ts`

**Interfaces:**
- Consumes: `parseDocument`, `mergeLiveText`, `partIndexForLine`, `plainText`, `documentTitle`, `blockCaption`, `DocumentPart` (Task 8); `BLOCK_LABELS`, `isSessionRunning`, `clearPendingText` (Task 9); `renameDocument`, `recordingFile` (Task 11); state (Task 9).
- Produces: `initDocument(): void`.

Behaviour (spec §3.3, §6): reads the selected document; re-reads it when the watcher reports it (unless it is the recording document), when one of its blocks becomes `refined`, and once when its session stops. The recording document shows pending live text at the end of its block with a cursor, follows new text while scrolled to the bottom, and offers **Jump to live** otherwise. `scrollToLine` / `scrollToBlock` scroll to and flash the matching part.

- [ ] **Step 1: Write `src/renderer/document.ts`**

```ts
import type { BlockEvent } from '../shared/api.js';
import {
  blockCaption,
  documentTitle,
  mergeLiveText,
  parseDocument,
  partIndexForLine,
  plainText,
  type DocumentPart,
} from './documentView.js';
import { byId, el } from './dom.js';
import { recordingFile, renameDocument } from './library.js';
import { BLOCK_LABELS, clearPendingText, isSessionRunning } from './sessionModel.js';
import { getState, subscribe, update, type AppState } from './state.js';
import { reportError, toast } from './toast.js';

const FOLLOW_THRESHOLD_PX = 40;

let readSeq = 0;
let shownFile: string | null = null;
let follow = true;
let readError: string | null = null;
let refinedSignature = '';
let wasRunning = false;

function isLiveDocument(): boolean {
  const file = getState().selectedFile;
  return file !== null && file === recordingFile();
}

// The selected document belongs to the current session (running, or stopped and still refining).
function isSessionDocument(): boolean {
  const { selectedFile, session } = getState();
  return selectedFile !== null && session.status !== null && session.status.documentFile === selectedFile;
}

async function loadDocument(): Promise<void> {
  const file = getState().selectedFile;
  const seq = ++readSeq;
  if (!file) {
    readError = null;
    update({ document: null });
    return;
  }
  try {
    const document = await window.api.readDocument(file);
    if (seq !== readSeq) return;
    readError = null;
    const session = isLiveDocument() ? clearPendingText(getState().session) : getState().session;
    update({ document, session });
  } catch (error) {
    if (seq !== readSeq) return;
    readError = error instanceof Error ? error.message : String(error);
    update({ document: null });
  }
}

// The only innerHTML in the renderer: marked output, always sanitised first.
function renderMarkdown(target: HTMLElement, markdown: string): void {
  target.innerHTML = DOMPurify.sanitize(marked.parse(markdown, { async: false, gfm: true, breaks: true }));
}

function renderPart(part: DocumentPart, blocks: readonly BlockEvent[], liveIndex: number | null, isLastOfLive: boolean): HTMLElement {
  if (part.kind === 'gap') {
    const gap = el('div', 'gap', 'recording interrupted');
    gap.dataset.line = String(part.line);
    return gap;
  }
  const section = el('section', part.kind === 'block' ? 'block' : 'intro');
  section.dataset.line = String(part.line);
  if (part.kind === 'block') {
    section.dataset.block = String(part.index);
    if (!part.continued) {
      const caption = el('div', 'caption', blockCaption(part));
      const event = blocks.find((b) => b.blockIndex === part.index);
      if (event) {
        const badge = el('span', `badge ${event.state}`, BLOCK_LABELS[event.state]);
        if (event.message) badge.title = event.message;
        caption.append(badge);
      }
      section.append(caption);
    }
  }
  const content = el('div', 'md');
  renderMarkdown(content, part.markdown);
  if (part.kind === 'block' && part.index === liveIndex && isLastOfLive) content.append(el('span', 'cursor', '▌'));
  section.append(content);
  return section;
}

function setBarVisible(visible: boolean): void {
  for (const id of ['docRenameBtn', 'docCopyBtn', 'docOpenBtn']) byId(id).hidden = !visible;
}

function currentParts(): DocumentPart[] {
  const { document, session } = getState();
  if (!document) return [];
  const parts = parseDocument(document.content).parts;
  return isLiveDocument() ? mergeLiveText(parts, session.pendingText, session.blocks) : parts;
}

function renderDocument(): void {
  const { selectedFile, document, session, tree } = getState();
  const body = byId('docBody');
  const title = byId('docTitle');
  const jump = byId('jumpLiveBtn');

  if (!selectedFile) {
    title.textContent = 'Select a document';
    setBarVisible(false);
    jump.hidden = true;
    const hint = tree && tree.exists && tree.documents.length === 0 ? 'Start a session to begin.' : '';
    body.replaceChildren(el('p', 'empty-state', hint));
    return;
  }
  if (!document || document.file !== selectedFile) {
    setBarVisible(false);
    jump.hidden = true;
    if (readError) {
      title.textContent = selectedFile;
      body.replaceChildren(el('p', 'error-state', `Could not open this document: ${readError}`));
    } else {
      title.textContent = 'Loading…';
    }
    return;
  }

  const parsed = parseDocument(document.content);
  const live = isLiveDocument();
  const parts = currentParts();
  const blocks = isSessionDocument() ? session.blocks : [];
  const liveIndex = live && session.status ? session.status.blockIndex : null;
  const lastOfLive = liveIndex === null ? -1 : parts.map((p) => p.kind === 'block' && p.index === liveIndex).lastIndexOf(true);

  const previousTop = body.scrollTop;
  title.textContent = documentTitle(parsed.frontmatter, document.file);
  setBarVisible(true);
  body.replaceChildren(...parts.map((part, i) => renderPart(part, blocks, liveIndex, i === lastOfLive)));

  if (live && follow) body.scrollTop = body.scrollHeight;
  else body.scrollTop = previousTop;
  jump.hidden = !live || follow;
  applyPendingScroll(parts);
}

function flash(target: Element | null): void {
  if (!target) return;
  target.scrollIntoView({ block: 'start' });
  target.classList.remove('flash');
  void (target as HTMLElement).offsetWidth; // restart the animation
  target.classList.add('flash');
}

function applyPendingScroll(parts: DocumentPart[]): void {
  const { scrollToLine, scrollToBlock } = getState();
  if (scrollToLine === null && scrollToBlock === null) return;
  const body = byId('docBody');
  follow = false;
  if (scrollToLine !== null) {
    const index = partIndexForLine(parts, scrollToLine);
    flash(index === -1 ? body.firstElementChild : body.children[index]);
  } else {
    flash(body.querySelector(`[data-block="${scrollToBlock}"]`));
  }
  // Clear after this render so the scroll happens once.
  setTimeout(() => update({ scrollToLine: null, scrollToBlock: null }), 0);
}

function onStateChange(state: AppState, changed: ReadonlySet<keyof AppState>): void {
  if (changed.has('selectedFile') && state.selectedFile !== shownFile) {
    shownFile = state.selectedFile;
    follow = true;
    readError = null;
    void loadDocument();
  }
  if (changed.has('session')) {
    const running = isSessionRunning(state.session.status);
    const signature = state.session.blocks
      .filter((b) => b.state === 'refined')
      .map((b) => b.blockIndex)
      .join(',');
    const stoppedNow = wasRunning && !running;
    if (isSessionDocument() && (signature !== refinedSignature || stoppedNow)) void loadDocument();
    refinedSignature = signature;
    wasRunning = running;
  }
  if (
    changed.has('document') ||
    changed.has('session') ||
    changed.has('tree') ||
    changed.has('selectedFile') ||
    changed.has('scrollToLine') ||
    changed.has('scrollToBlock')
  ) {
    renderDocument();
  }
}

function onScroll(): void {
  if (!isLiveDocument()) return;
  const body = byId('docBody');
  follow = body.scrollHeight - body.scrollTop - body.clientHeight < FOLLOW_THRESHOLD_PX;
  byId('jumpLiveBtn').hidden = follow;
}

export function initDocument(): void {
  byId('docRenameBtn').addEventListener('click', () => {
    const { selectedFile, tree } = getState();
    const doc = tree?.documents.find((d) => d.file === selectedFile);
    if (!doc) return;
    if (doc.file === recordingFile()) {
      toast('Stop the session before renaming its document.');
      return;
    }
    renameDocument(doc).catch(reportError);
  });
  byId('docCopyBtn').addEventListener('click', () => {
    window.api.copyText(plainText(currentParts())).then(() => toast('Copied'), reportError);
  });
  byId('docOpenBtn').addEventListener('click', () => {
    const file = getState().selectedFile;
    if (file) window.api.openDocumentExternally(file).catch(reportError);
  });
  byId('jumpLiveBtn').addEventListener('click', () => {
    follow = true;
    const body = byId('docBody');
    body.scrollTop = body.scrollHeight;
    byId('jumpLiveBtn').hidden = true;
  });
  byId('docBody').addEventListener('scroll', onScroll);
  window.api.onLibraryChanged(({ paths }) => {
    const file = getState().selectedFile;
    if (file && !isLiveDocument() && (paths.length === 0 || paths.includes(file))) void loadDocument();
  });
  subscribe(onStateChange);
  renderDocument();
}
```

- [ ] **Step 2: Wire it into `src/renderer/app.ts`**

```ts
import { initDocument } from './document.js';
```

and call `initDocument();` after `initLibrary();`.

- [ ] **Step 3: Verify**

```bash
npm run build && npm test && npm run lint
grep -rn "innerHTML" src/renderer
```

Expected: clean; exactly one `innerHTML` match, in `document.ts`, assigned from `DOMPurify.sanitize(...)`.

Live check (Task 6 vault layout, launched and pointed at it as in Task 5 Step 7). Also create a hostile note first:

```bash
printf '# Hostile\n\n<img src=x onerror="window.__pwned=1">\n<script>window.__pwned=2</script>\n[web](https://example.com)\n' > "$V/hostile.md"
```

```bash
node scripts/dev-cdp.mjs "document.querySelector('[data-key=\"doc:2026-09-01-0900-kickoff.md\"]').click(); new Promise(r => setTimeout(r, 800)).then(() => ({ title: document.getElementById('docTitle').textContent, sections: document.querySelectorAll('#docBody section').length, text: document.getElementById('docBody').textContent.trim() }))"
```

Then change the file on disk (Git Bash) and check that the view follows it:

```bash
printf -- '---\ntitle: Kickoff\ncreated: 2026-09-01T09:00:00Z\n---\n\nThe quarterly budget\n\nEdited outside\n' > "$V/2026-09-01-0900-kickoff.md"
node scripts/dev-cdp.mjs "new Promise(r => setTimeout(r, 1500)).then(() => document.getElementById('docBody').textContent.includes('Edited outside'))"
node scripts/dev-cdp.mjs "document.querySelector('[data-key=\"doc:hostile.md\"]').click(); new Promise(r => setTimeout(r, 800)).then(() => ({ pwned: window.__pwned ?? null, scripts: document.querySelectorAll('#docBody script').length, onerror: document.querySelectorAll('#docBody [onerror]').length, link: document.querySelector('#docBody a')?.getAttribute('href') }))"
node scripts/dev-cdp.mjs "const s = document.getElementById('librarySearch'); s.value = 'Edited'; s.dispatchEvent(new Event('keydown')); s.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); new Promise(r => setTimeout(r, 800)).then(() => { document.querySelector('#libraryBody .row.hit').click(); return new Promise(r => setTimeout(r, 800)); }).then(() => document.querySelector('#docBody .flash')?.textContent)"
```

Expected:
1. Title `Kickoff`; 1 section; text `The quarterly budget`.
2. `true`.
3. `pwned: null`, `scripts: 0`, `onerror: 0`, and `link` is `https://example.com`.
4. The flashed section's text contains `Edited outside`.

Clicking a web link in the app window (manually, with `npm start`) opens the browser and leaves the app on its page.

Session check, in the same instance: select the root folder, start a session, and check it is shown live; do not pause:

```bash
node scripts/dev-cdp.mjs "document.querySelector('[data-key=\"folder:\"]').click(); document.getElementById('sessionStartBtn').click(); new Promise(r => setTimeout(r, 6000)).then(() => ({ title: document.getElementById('docTitle').textContent, caption: document.querySelector('#docBody .caption')?.textContent, rec: document.querySelectorAll('#libraryBody .rec-dot').length }))"
node scripts/dev-cdp.mjs "document.getElementById('sessionStopBtn').click(); new Promise(r => setTimeout(r, 2000)).then(() => document.querySelector('#docBody .caption')?.textContent)"
```

Expected: title `untitled`, caption `Block 1 · 00:00–02:00live`, one recording dot; after stopping, the caption ends in `no speech`. Restore the vault setting and stop the instance.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/document.ts src/renderer/app.ts
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Add the document pane" -m "Renders the selected document with block captions and refinement badges, follows a live session's text as it arrives, re-reads the file when it changes on disk or a block is refined, and scrolls to search hits. Markdown is sanitised with DOMPurify before it is shown." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: Session panel

**Files:**
- Create: `src/renderer/sessionPanel.ts`
- Modify: `src/renderer/app.ts`

**Interfaces:**
- Consumes: `BLOCK_LABELS`, `isSessionRunning`, `sessionSummary` (Task 9); `parseDocument`, `frontmatterRows` (Task 8); `formatClock` (Task 1); `openDocument` (Task 11); state (Task 9).
- Produces: `initSessionPanel(): void`.

Behaviour (spec §3.4): with a current session, show Session (state and duration, microphone and mute, models, folder, blocks waiting), Blocks (click to scroll the document to a block) and Messages. When the selected document is not the running session's, also show its frontmatter under Document. App-wide notices appear under Messages even without a session. The panel collapses to a narrow strip; the choice is remembered per machine.

- [ ] **Step 1: Write `src/renderer/sessionPanel.ts`**

```ts
import type { BlockEvent } from '../shared/api.js';
import { frontmatterRows, parseDocument } from './documentView.js';
import { byId, el } from './dom.js';
import { formatClock } from './format.js';
import { openDocument } from './library.js';
import { BLOCK_LABELS, isSessionRunning, sessionSummary } from './sessionModel.js';
import { getState, subscribe, update } from './state.js';

const COLLAPSED_KEY = 'dark-whisper.panelCollapsed';

function details(rows: [string, string][]): HTMLElement {
  const list = el('dl', 'details');
  for (const [label, value] of rows) list.append(el('dt', '', label), el('dd', '', value));
  return list;
}

function jumpToBlock(index: number): void {
  const file = getState().session.status?.documentFile;
  if (!file) return;
  if (getState().selectedFile !== file) openDocument(file);
  update({ scrollToBlock: index });
}

function blockList(blocks: readonly BlockEvent[]): HTMLElement {
  if (blocks.length === 0) return el('p', 'muted', 'No blocks yet');
  const list = el('ol', 'blocks');
  for (const block of blocks) {
    const item = el('li', `block-row ${block.state}`);
    item.append(
      el('span', 'num', String(block.blockIndex)),
      el('span', 'range', `${formatClock(block.startSec)}–${formatClock(block.endSec)}`),
      el('span', `badge ${block.state}`, BLOCK_LABELS[block.state]),
    );
    if (block.message) item.append(el('div', 'msg', block.message));
    item.addEventListener('click', () => jumpToBlock(block.blockIndex));
    list.append(item);
  }
  return list;
}

function renderPanel(): void {
  const { session, document, selectedFile } = getState();
  const status = session.status;
  const nodes: HTMLElement[] = [];

  if (status && status.sessionId) {
    const mic = status.muted === true ? `${status.microphone} (muted)` : status.microphone;
    nodes.push(
      el('h2', '', 'Session'),
      details([
        ['State', sessionSummary(status)],
        ['Microphone', mic],
        ['Live model', status.liveModel],
        ['Refine model', status.refineModel],
        ['Folder', status.folder || 'Vault root'],
        ['Waiting to refine', String(status.refining)],
      ]),
      el('h2', '', 'Blocks'),
      blockList(session.blocks),
    );
  }

  if (status && status.messages.length > 0) {
    const list = el('ul', 'messages');
    for (const message of status.messages) list.append(el('li', '', message));
    nodes.push(el('h2', '', 'Messages'), list);
  }

  const showsLiveDocument = status !== null && isSessionRunning(status) && status.documentFile === selectedFile;
  if (document && document.file === selectedFile && !showsLiveDocument) {
    const rows = frontmatterRows(parseDocument(document.content).frontmatter);
    nodes.push(
      el('h2', '', 'Document'),
      rows.length > 0 ? details(rows.map((row) => [row.label, row.value])) : el('p', 'muted', 'No details recorded'),
    );
  }

  if (nodes.length === 0) nodes.push(el('p', 'muted', 'No session yet.'));
  byId('panelBody').replaceChildren(...nodes);
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function setCollapsed(collapsed: boolean): void {
  byId('workspace').classList.toggle('panel-collapsed', collapsed);
  const toggle = byId('panelToggleBtn');
  toggle.textContent = collapsed ? '⟨' : '⟩';
  toggle.title = collapsed ? 'Show the panel' : 'Hide the panel';
  try {
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Storage unavailable: the choice lasts for this window only.
  }
}

export function initSessionPanel(): void {
  setCollapsed(readCollapsed());
  byId('panelToggleBtn').addEventListener('click', () => {
    setCollapsed(!byId('workspace').classList.contains('panel-collapsed'));
  });
  subscribe((_state, changed) => {
    if (changed.has('session') || changed.has('document') || changed.has('selectedFile')) renderPanel();
  });
  renderPanel();
}
```

- [ ] **Step 2: Wire it into `src/renderer/app.ts`**

```ts
import { initSessionPanel } from './sessionPanel.js';
```

and call `initSessionPanel();` after `initDocument();`.

- [ ] **Step 3: Verify**

```bash
npm run build && npm test && npm run lint
```

Live check (Task 6 vault, launched and pointed at it):

```bash
node scripts/dev-cdp.mjs "document.querySelector('[data-key=\"doc:2026-09-01-0900-kickoff.md\"]').click(); new Promise(r => setTimeout(r, 800)).then(() => document.getElementById('panelBody').textContent)"
node scripts/dev-cdp.mjs "document.getElementById('sessionStartBtn').click(); new Promise(r => setTimeout(r, 6000)).then(() => document.getElementById('panelBody').textContent)"
node scripts/dev-cdp.mjs "document.querySelector('#panelBody .block-row').click(); new Promise(r => setTimeout(r, 500)).then(() => document.querySelector('#docBody .flash')?.dataset.block)"
node scripts/dev-cdp.mjs "document.getElementById('sessionStopBtn').click(); document.getElementById('panelToggleBtn').click(); ({ collapsed: document.getElementById('workspace').classList.contains('panel-collapsed') })"
node scripts/dev-cdp.mjs "document.getElementById('panelToggleBtn').click(); document.getElementById('workspace').classList.contains('panel-collapsed')"
```

Expected:
1. Contains `Document`, `Created`, `2026-09-01T09:00:00Z`.
2. Contains `Session`, `Recording ·` (or `Starting ·`), a microphone name, `Blocks`, `1`, `live`.
3. `"1"`.
4. `collapsed: true`.
5. `false`.

Restore the vault setting and stop the instance.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/sessionPanel.ts src/renderer/app.ts
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Add the session panel" -m "Shows the session's state, microphone, models, folder and each block's refinement state, the session's messages, and the selected document's details; blocks scroll the document, and the panel can be collapsed." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 14: Smoke test, documentation and final verification

**Files:**
- Create: `scripts/workspace-smoke.mjs`
- Modify: `package.json`, `README.md`, `QUICKSTART.md`, `DEVELOPMENT.md`, `SETUP_SUMMARY.txt`, `.claude`

**Interfaces:**
- Consumes: `connect` from `scripts/dev-cdp.mjs` (Task 5); the element ids from Task 10; everything above.
- Produces: `npm run smoke:workspace` (exit code 0 when every check passes).

- [ ] **Step 1: Write `scripts/workspace-smoke.mjs`**

```js
// End-to-end check of the workspace against a throwaway vault:  npm run build && npm run smoke:workspace
// It launches its own app instance (close any running dev instance first, because of the
// single-instance lock), never pauses a session (pausing mutes the real microphone), and restores
// the vault setting when done. The delete check sends one small test note to the Recycle Bin.
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { connect } from './dev-cdp.mjs';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9334;
const ROWS = "[...document.querySelectorAll('#libraryBody .row')].map((r) => r.dataset.key).join('|')";
const js = (value) => JSON.stringify(value);

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-smoke-'));
const vaultFile = (rel) => path.join(vault, ...rel.split('/'));
function write(rel, content) {
  fs.mkdirSync(path.dirname(vaultFile(rel)), { recursive: true });
  fs.writeFileSync(vaultFile(rel), content);
}
write('2026-09-01-0900-kickoff.md', '---\ntitle: Kickoff\ncreated: 2026-09-01T09:00:00Z\n---\n\n<!-- dw:block 1 t=0-120 -->\nThe quarterly budget\n');
write('Clients/acme.md', 'plain note\n');
write('hostile.md', '# Hostile\n\n<img src=x onerror="window.__pwned=1">\n<script>window.__pwned=2</script>\n');
write('smoke-delete-me.md', 'delete me\n');

const failures = [];
function check(name, ok, detail = '') {
  if (!ok) failures.push(name);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], { cwd: repo, stdio: 'ignore' });
let app = null;
let originalVault = null;

async function waitFor(expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await app.evaluate(expression).catch(() => undefined);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return value;
}

async function waitForFile(rel, exists = true, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(vaultFile(rel)) === exists) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

const click = (selector) => app.evaluate(`document.querySelector(${js(selector)}).click()`);

async function answerAsk({ text, choice } = {}) {
  await waitFor("document.getElementById('askDialog').open");
  if (text !== undefined) await app.evaluate(`document.getElementById('askInput').value = ${js(text)}`);
  if (choice !== undefined) await app.evaluate(`document.getElementById('askSelect').value = ${js(choice)}`);
  await click('#askOkBtn');
}

async function menuAction(file, label) {
  await click(`[data-key=${js(`doc:${file}`)}] .row-menu`);
  await app.evaluate(
    `[...document.querySelectorAll('#rowMenu .menu-item')].find((b) => b.textContent === ${js(label)}).click()`,
  );
}

try {
  app = await connect(PORT);
  await waitFor("document.readyState === 'complete' && Boolean(window.api)");
  originalVault = await app.evaluate('window.api.getSettings().then((s) => s.vaultPath)');
  await app.evaluate(`window.api.saveSettings({ vaultPath: ${js(vault)} })`);

  const listed = await waitFor(`(${ROWS}).includes('doc:2026-09-01-0900-kickoff.md') && (${ROWS})`);
  check('library lists the vault', Boolean(listed) && listed.includes('folder:Clients') && !listed.includes('doc:Clients/acme.md'), listed);

  await click('[data-key="folder:Clients"]');
  check('folders expand', Boolean(await waitFor(`(${ROWS}).includes('doc:Clients/acme.md')`)));

  await app.evaluate("(() => { const s = document.getElementById('librarySearch'); s.value = 'budget'; s.dispatchEvent(new Event('input')); })()");
  const hit = await waitFor("document.querySelector('#libraryBody .row.hit')?.textContent");
  check('full-text search finds a line', Boolean(hit) && hit.includes('The quarterly budget'), hit);
  await app.evaluate("(() => { const s = document.getElementById('librarySearch'); s.value = ''; s.dispatchEvent(new Event('input')); })()");

  await waitFor(`(${ROWS}).includes('doc:2026-09-01-0900-kickoff.md')`);
  await click('[data-key="doc:2026-09-01-0900-kickoff.md"]');
  const caption = await waitFor("document.getElementById('docTitle').textContent === 'Kickoff' && document.querySelector('#docBody .caption')?.textContent");
  check('a document opens with its blocks', Boolean(caption) && caption.startsWith('Block 1'), caption);

  fs.appendFileSync(vaultFile('2026-09-01-0900-kickoff.md'), '\nEdited outside\n');
  check('an outside edit re-renders the document', Boolean(await waitFor("document.getElementById('docBody').textContent.includes('Edited outside')")));

  await click('[data-key="doc:hostile.md"]');
  await waitFor("document.getElementById('docTitle').textContent === 'hostile'");
  const hostile = await app.evaluate(
    "({ pwned: window.__pwned ?? null, scripts: document.querySelectorAll('#docBody script').length, handlers: document.querySelectorAll('#docBody [onerror]').length })",
  );
  check('document HTML is sanitised', hostile.pwned === null && hostile.scripts === 0 && hostile.handlers === 0, js(hostile));

  await click('[data-key="folder:"]');
  await click('#newFolderBtn');
  await answerAsk({ text: 'Archive' });
  check('a folder can be created', (await waitForFile('Archive')) && Boolean(await waitFor(`(${ROWS}).includes('folder:Archive')`)));

  await menuAction('Clients/acme.md', 'Move to…');
  await answerAsk({ choice: 'Archive' });
  check('a document can be moved', (await waitForFile('Archive/acme.md')) && !fs.existsSync(vaultFile('Clients/acme.md')));

  await click('[data-key="doc:2026-09-01-0900-kickoff.md"]');
  await waitFor("document.getElementById('docTitle').textContent === 'Kickoff'");
  await click('#docRenameBtn');
  await answerAsk({ text: 'Team kickoff' });
  const renamed = (await waitForFile('2026-09-01-0900-team-kickoff.md')) && (await waitFor("document.getElementById('docTitle').textContent === 'Team kickoff'"));
  check('a document can be renamed and stays selected', Boolean(renamed));

  await menuAction('smoke-delete-me.md', 'Delete');
  await answerAsk();
  check('a document can be deleted', await waitForFile('smoke-delete-me.md', false));

  await click('[data-key="folder:Archive"]');
  await click('#sessionStartBtn');
  const status = await waitFor(
    "window.api.getSessionStatus().then((s) => (s.state === 'recording' || s.state === 'error') && s)",
    20000,
  );
  if (!status || status.state !== 'recording') {
    check('a session starts in the selected folder', false, status ? status.message ?? status.state : 'did not start');
  } else {
    check('a session starts in the selected folder', status.folder === 'Archive' && status.documentFile.startsWith('Archive/'), status.documentFile);
    const live = await waitFor(
      "document.getElementById('docTitle').textContent === 'untitled' && document.querySelectorAll('#libraryBody .rec-dot').length === 1 && document.querySelector('#docBody .caption')?.textContent",
    );
    check('the session document is shown live', Boolean(live) && live.includes('live'), live);
    const refused = await app.evaluate(
      `window.api.renameDocument(${js(status.documentFile)}, 'x').then(() => 'renamed', (e) => e.message)`,
    );
    check('the recording document cannot be renamed', refused.includes('being recorded'), refused);
    check('the session panel shows the blocks', Boolean(await waitFor("document.getElementById('panelBody').textContent.includes('Blocks')")));
    await click('#sessionStopBtn');
    const stopped = await waitFor("window.api.getSessionStatus().then((s) => s.state === 'stopped' && s.blocks[0]?.state)");
    check('the session stops', Boolean(stopped), stopped);
  }
} catch (error) {
  check('smoke run completed', false, error instanceof Error ? error.message : String(error));
} finally {
  if (app && originalVault !== null) {
    await app.evaluate(`window.api.saveSettings({ vaultPath: ${js(originalVault)} })`).catch(() => undefined);
  }
  app?.close();
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  else child.kill();
  fs.rmSync(vault, { recursive: true, force: true });
}

console.log(failures.length === 0 ? '\nAll workspace checks passed.' : `\n${failures.length} check(s) failed.`);
process.exit(failures.length === 0 ? 0 : 1);
```

In `package.json` scripts add:

```json
"smoke:workspace": "node scripts/workspace-smoke.mjs",
```

- [ ] **Step 2: Run the smoke test**

```bash
npm run build
npm run smoke:workspace
```

Expected: every line `PASS`, then `All workspace checks passed.` The session checks need the live model (`ggml-base.en.bin`) installed; if it is missing, the session check fails with `Live model … is not installed`. Install it from the Models dialog, then re-run. Afterwards, confirm no process from this repository is left running (Task 5 Step 7, second PowerShell command). If a check fails, fix the cause in the task that owns it and re-run; do not weaken the check.

- [ ] **Step 3: Update the documentation**

`README.md`:
- In **Features**, replace the `Live Sessions` bullet with:
  `- **Workspace** - A library of your vault (folders, search), a live view of the document being written, and a panel showing each block's refinement`
- Replace the first paragraph and steps of **Recording a Session** (everything before "The live text comes from…") with:

```markdown
### The Workspace

The window has three panes under a header:

- **Header** — the server status, **Dictate** (quick dictation, with the last result and a Copy button), **Start session** / **Pause** / **Stop**, and the Models (🧠) and Settings (⚙️) dialogs.
- **Library** (left) — every Markdown file in your vault, in its folders, newest first. Type to filter titles; press Enter (or pause) to search the text of every document; click a result to jump to the line. The ⋯ menu on a document renames, moves, opens it in your editor, shows it in Explorer or moves it to the Recycle Bin. **+ folder** creates a folder. Keyboard: ↑/↓, ←/→, Enter, F2 (rename), Delete, Ctrl+F (search).
- **Document** (centre) — the selected document, read-only. ✎ renames, ⧉ copies the text, ↗ opens it in your editor. Edits you make elsewhere (Obsidian, VS Code) appear within a second.
- **Session** (right, collapsible with ⟩) — state, microphone, models, target folder, every block's refinement state (click one to jump to it), and messages. With no session running it shows the selected document's details.

### Recording a Session

1. Select a folder in the library if the session belongs to a project (otherwise it goes to the vault root)
2. Click **Start session** and speak. The new document opens in the centre and follows your words; scroll up to read back, and **Jump to live** to return
3. Press the hotkey (or **Pause**) to pause, and again to resume. Muting your microphone pauses the session as well; unmuting resumes it
4. Click **Stop** when you are done. The document cannot be renamed, moved or deleted while it is recording
```

- In **Configuring Settings**, change the Vault bullet to `**Vault folder** - Where session documents are written; pick it with **Choose folder…** (default `Documents\Dark-Whisper`)`.
- In **Project Structure**, add under `src/`:

```
│   ├── shared/api.ts              # Types shared by main, preload and renderer
│   ├── renderer/                  # Window code (ES modules → public/js)
│   │   ├── app.ts, state.ts       # Entry point and app state
│   │   ├── header.ts, library.ts, document.ts, sessionPanel.ts, dialogs.ts
│   │   └── format.ts, libraryTree.ts, documentView.ts, sessionModel.ts   # DOM-free, tested
```

and under `services/` add `libraryService.ts   # Vault tree, search, moves, path guard`, `libraryWatch.ts     # Change batching, polling diff`, `libraryRuntime.ts   # Library IPC and vault watcher`. Replace `public/index.html # UI (status, settings, models)` with `public/index.html, app.css   # Workspace markup and dark theme`. Update the test count line to the number `npm test` prints.
- In **Available Commands**, add `npm run build:renderer` (Compile the window code and copy marked/DOMPurify) and `npm run smoke:workspace` (End-to-end check of the workspace in a throwaway vault).
- In **Security**, add: `- **Sanitised documents** - Markdown is rendered with marked and cleaned with DOMPurify; a Content-Security-Policy blocks scripts and remote images, and links open in your browser, never in the app window`.
- In the **Unreleased** changelog, add: `- Three-pane workspace: vault library with folders and search, live document view, session panel with per-block refinement state; quick dictation moves to the header`.
- In **Future Enhancements**, remove the "full session workspace" item.

`DEVELOPMENT.md`:
- Replace the **Renderer Process** section with:

```markdown
### Renderer (src/renderer → public/js)
- Vanilla TypeScript compiled by `tsconfig.renderer.json` to ES modules (`npm run build:renderer`); `public/index.html` is markup only and loads `js/renderer/app.js`
- `marked` and `DOMPurify` are copied to `public/vendor/` and loaded as classic scripts (globals declared in `src/renderer/globals.d.ts`)
- One state object (`state.ts`) with `update(patch)` / `subscribe(listener)`; each pane re-renders from it
- DOM-free, Jest-tested: `format.ts`, `libraryTree.ts`, `documentView.ts`, `sessionModel.ts`, `state.ts` (they must not touch `window`/`document` and may use only ES2020 library features, since the main tsconfig compiles them through the tests)
- DOM: `header.ts`, `library.ts`, `document.ts`, `sessionPanel.ts`, `dialogs.ts` (ask/confirm, Settings, Models), `toast.ts`, `dom.ts`
- Imports use `.js` extensions and `import type`; renderer code may import only `src/renderer` and `src/shared`
- The only `innerHTML` is in `document.ts`, fed by `DOMPurify.sanitize`; everything else uses `textContent`
- CSP `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'` — no inline scripts or `style` attributes in the markup
```

- In the Electron-free services table add `libraryService.ts` (vault tree, search, read, rename, move, folders; the path guard every renderer path goes through) and `libraryWatch.ts` (`ChangeBatcher` debounce and snapshot diffing). In the Electron-bound table add `libraryRuntime.ts` (library IPC, `fs.watch` with a 5 s polling fallback, Recycle Bin, open/reveal, vault picker).
- Add `libraryRuntime` to the list of modules tests must not import.
- In **IPC Surface** add rows: `library-tree`, `library-search`, `document-read`, `document-rename`, `document-move`, `document-delete`, `folder-create`, `document-open-external`, `document-reveal`, `choose-vault`, `copy-text` (invoke, library and clipboard); `library-changed` (main → renderer, `{ paths }`, debounced 300 ms); `session-block` (main → renderer, one block's state). Note that `session-start` now takes an optional folder and `session-status` carries `sessionId`, `documentFile`, `folder`, `microphone`, `liveModel`, `refineModel`, `messages` and `blocks`.
- In **Testing**, update the counts and add: `npm run smoke:workspace` drives a real app instance over the DevTools protocol against a throwaway vault; `node scripts/dev-cdp.mjs "<expression>"` evaluates one expression in an app started with `--remote-debugging-port=9333`.
- In **Manual Test Checklist** add: Obsidian open on the vault while recording and while browsing; a 500-document vault opens and searches in under a second; keyboard-only library navigation; a document with remote images and links (images blocked, links open in the browser); the window at 900×560 with the panel collapsed; a vault on a network drive (polling notice appears).

`QUICKSTART.md`:
- In **Common Commands** add `npm run build:renderer` and `npm run smoke:workspace`.
- Replace **Testing a session** steps 2–5 with: `2. Click **Start session**; the new document opens in the centre and fills in as you speak` / `3. Watch the Session panel on the right: blocks go live → waiting → refining → refined` / `4. Tip: set **Minutes per block** to 1 to see refinement sooner` / `5. Click **Stop**; the document stays selected in the library`.
- Add under **File Locations**: `- **Window code**: src/renderer/ (compiled to public/js/, generated)`.

`SETUP_SUMMARY.txt`: add `src/shared/api.ts`, the `src/renderer/` modules and the three library services to the structure; change the `public/index.html` line to `public/index.html, app.css - Workspace markup and theme`; add `npm run build:renderer` and `npm run smoke:workspace` to COMMANDS; update the test counts; replace feature 0 with `0. Workspace - vault library (folders, search), live document view, session panel with per-block refinement; sessions as in stage 1`.

`.claude`: add a `## Workspace (stage 2)` section summarising the renderer rules from the DEVELOPMENT section above, the library IPC and path guard, the watcher and polling fallback, and the recording-document lock; update the test counts and module lists.

Then check for stale statements:

```bash
grep -n -i "session strip\|temporary session\|123 tests\|245 tests" README.md QUICKSTART.md DEVELOPMENT.md SETUP_SUMMARY.txt .claude
```

Expected: no matches, apart from historical changelog entries.

- [ ] **Step 4: Final verification**

```bash
npm ci
ls node_modules/node-mic/sox-win32/sox.exe || (cd node_modules/node-mic && node ./scripts/postinstall.js)
npx install-electron
npm run build && npm test && npm run lint && npm audit
npm run whisper:fetch && npm run ensure-mac-perms && npx electron-builder --win --dir
ls release/win-unpacked/resources/app.asar
npx asar list release/win-unpacked/resources/app.asar | grep -E "public/(index.html|app.css|js/renderer/app.js|vendor/marked.umd.js|vendor/purify.min.js)$"
ELECTRON_ENABLE_LOGGING=1 timeout 25 "release/win-unpacked/Dark-Whisper.exe" > "$TEMP/packaged.log" 2>&1; echo "exit: $?"
grep -iE "Uncaught|ReferenceError|TypeError|Cannot find module|Content Security Policy|Failed to load" "$TEMP/packaged.log"
npm run smoke:workspace
```

Expected: clean build, all suites passing, 0 lint errors, 0 vulnerabilities; the five packaged files are listed; the packaged run exits 124 with no matching error lines; the smoke test passes. If `npx asar` is not available, use `npx @electron/asar list`. Afterwards confirm no process from this repository is left running.

- [ ] **Step 5: Commit**

```bash
git add scripts/workspace-smoke.mjs package.json README.md QUICKSTART.md DEVELOPMENT.md SETUP_SUMMARY.txt .claude
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Document the workspace and add an end-to-end smoke test" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Report**

Summarise against the spec's §11 manual checklist, marking each item as run or not run here. List what only the user can check: a real spoken session with refinement shown live, Obsidian editing the vault during a session, a 500-document vault, a network-drive vault, and the look of the window at its minimum size.
