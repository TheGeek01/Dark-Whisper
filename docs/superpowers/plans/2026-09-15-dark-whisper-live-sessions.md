# Dark-Whisper Live Sessions Implementation Plan (Stage 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Dark-Whisper into a dictation workspace: a live transcription engine writes a Markdown file as you speak, completed blocks are quietly re-transcribed at higher quality, and the app is rebranded — all behind a deliberately plain UI that stage 2 replaces.

**Architecture:** whisper.cpp's `whisper-stream.exe` runs as a third supervised child process (same injected-dependency pattern as the existing `whisperServer`), emitting finalized segments on stdout. A session service appends each segment to a `.md` file in a user-chosen vault, closes a block every 2 minutes, and enqueues that block for refinement: its audio is sliced out of the session WAV and POSTed to the already-running `whisper-server`. Mic mute and in-app pause are one concept kept in sync through a Windows Core Audio shim.

**Tech Stack:** Electron 44, TypeScript 6 (CommonJS, `module: node20`), Jest 30 + ts-jest, whisper.cpp `b5130` (`whisper-server.exe` + `whisper-stream.exe` + SDL2), axios, electron-store 11, PowerShell 7 for the mute shim.

**Spec:** `docs/superpowers/specs/2026-09-15-dark-whisper-live-sessions-design.md`

## Global Constraints

- **No git commits.** The user works without a git identity; every task ends with a checkpoint (`git status --short`) instead of a commit. Never run `git commit`/`add`/`stash`/`checkout`/`reset`/`push`.
- Windows x64 only for packaging; unit tests must also pass on `ubuntu-latest`, so no test may spawn a real process, touch a real microphone, or call Windows-only commands.
- Electron cannot load under Jest: files under `src/__tests__/` must never import `electron`, `electron-store`, `settingsService`, `whisperRuntime`, `streamRuntime`, `appIdentity`, or `main`.
- Product name is exactly **Dark-Whisper**; `appId` stays `com.whisperdesktop.app`; installer artifact stays `Dark-Whisper-Setup-${version}.${ext}`.
- Engine invocation is exactly: `whisper-stream.exe -m <liveModelPath> --step 0 --length 10000 -vth 0.6 -t <threads> -l <language> -c <captureId> -sa -f live.txt`, working directory `userData/sessions/<sessionId>/`, plus `-ng` when CPU is forced.
- Engine ready marker is the stdout line `[Start speaking]`; readiness timeout 60 000 ms; crash restart delays reuse `RESTART_DELAYS_MS` (1000, 5000, 15000) then `error`.
- Saved audio is `YYYYMMDDHHMMSS.wav`, 16 kHz, 16-bit, mono → 32 000 bytes/sec, 44-byte WAV header.
- Block length default 2 minutes (`blockMinutes`), measured on the audio clock. Block marker format: `<!-- dw:block <n> t=<startSec>-<endSec> -->`.
- Refinement replaces a block only when its on-disk text still matches the SHA256 recorded when we wrote it.
- Vault default `%USERPROFILE%\Documents\Dark-Whisper`; user data moves to `%APPDATA%\Dark-Whisper` with migration from `whisper-desktop` then `Whisper Desktop`.
- `refineDuringRecording` auto-defers when live + refine model **files** together exceed 2 GB (2 147 483 648 bytes). Refinement is off in external-API mode unless `refineWithExternalApi` is on.
- Verification after every task: `npm run build`, `npm test`, `npm run lint` (0 errors; pre-existing warnings allowed).

## File Map

| File | Status | Responsibility |
|---|---|---|
| `src/services/userDataMigration.ts` | Create | Pure: plan which legacy user-data entries to move |
| `src/appIdentity.ts` | Create | Sets app name and runs the user-data migration before anything reads paths |
| `src/services/streamOutput.ts` | Create | Pure: parse `whisper-stream.exe` stdout/stderr — segments, device list, ready, errors |
| `src/services/streamEngine.ts` | Create | Supervisor state machine for `whisper-stream.exe` (injected deps) |
| `src/services/streamRuntime.ts` | Create | Electron/Node wiring for the engine: spawn, session dirs, audio manifest |
| `src/services/documentStore.ts` | Create | Pure-ish: vault `.md` files — frontmatter, append, block replace, hash guard, search |
| `src/services/blockMath.ts` | Create | Pure: block time ranges → audio manifest files and byte offsets; WAV slice headers |
| `src/services/sessionService.ts` | Create | One session: segments → document, block boundaries, refinement queue |
| `src/services/blockRefiner.ts` | Create | Slice audio, POST to the server, return replacement text; queue + memory guard |
| `src/services/micMuteService.ts` | Create | Read/set Windows mic mute via a PowerShell Core Audio shim |
| `src/services/micMuteOutput.ts` | Create | Pure: parse the shim's output |
| `src/services/serverPaths.ts` | Modify | Resolve `whisper-stream.exe` as well as `whisper-server.exe` |
| `src/services/settingsService.ts` | Modify | New settings keys |
| `src/main.ts` | Modify | Identity import first, session IPC, hotkey mode rules, tray label |
| `src/preload.ts` | Modify | Session bridge methods and events |
| `public/index.html` | Modify | Temporary session strip; rebranded strings |
| `scripts/fetch-whisper.js` | Modify | Also copy `whisper-stream.exe` |
| `.github/workflows/publish.yml` | Modify | SDL2 dev fetch + `-DWHISPER_SDL2=ON`, copy `whisper-stream.exe` |
| `electron-builder.yml`, `package.json` | Modify | Product name, package name |
| `README.md`, `QUICKSTART.md`, `DEVELOPMENT.md`, `SETUP_SUMMARY.txt`, `.claude` | Modify | Rebrand + new behaviour |

**Order rationale:** rebrand first (it moves the user-data directory everything else writes into), then packaging (the engine binary must exist), then the pure parser, the supervisor, and a runnable engine milestone at Task 5 — after which documents, slicing, orchestration, refinement, mute and UI land on top.

---

### Task 1: Rebrand and user-data migration

**Files:**
- Create: `src/services/userDataMigration.ts`
- Create: `src/appIdentity.ts`
- Test: `src/__tests__/userDataMigration.test.ts`
- Modify: `src/main.ts` (first import; tray tooltip; notification titles), `package.json` (`name`), `electron-builder.yml` (`productName`), `public/index.html` (visible strings)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `const LEGACY_APP_DIRS: readonly string[]` — `['whisper-desktop', 'Whisper Desktop']`
  - `const MIGRATED_ENTRIES: readonly string[]` — `['config.json', 'models', 'logs', 'recordings']`
  - `interface LegacyDir { path: string; entries: string[] }`
  - `interface MigrationPlan { from: string; entries: string[] }`
  - `planUserDataMigration(input: { targetExists: boolean; legacyDirs: LegacyDir[] }): MigrationPlan | null`
  - `src/appIdentity.ts` has no exports; importing it sets the app name and performs the migration.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/userDataMigration.test.ts`:

```ts
import {
  planUserDataMigration,
  LEGACY_APP_DIRS,
  MIGRATED_ENTRIES,
} from '../services/userDataMigration';

describe('planUserDataMigration', () => {
  it('lists legacy directories oldest name first', () => {
    expect(LEGACY_APP_DIRS).toEqual(['whisper-desktop', 'Whisper Desktop']);
    expect(MIGRATED_ENTRIES).toEqual(['config.json', 'models', 'logs', 'recordings']);
  });

  it('does nothing when the new directory already exists', () => {
    expect(
      planUserDataMigration({
        targetExists: true,
        legacyDirs: [{ path: 'C:/AppData/whisper-desktop', entries: ['config.json'] }],
      }),
    ).toBeNull();
  });

  it('does nothing when there is no legacy directory', () => {
    expect(planUserDataMigration({ targetExists: false, legacyDirs: [] })).toBeNull();
  });

  it('moves only the entries we own, in a stable order', () => {
    expect(
      planUserDataMigration({
        targetExists: false,
        legacyDirs: [
          {
            path: 'C:/AppData/whisper-desktop',
            entries: ['recordings', 'config.json', 'Cache', 'models', 'whisper-server.pid'],
          },
        ],
      }),
    ).toEqual({ from: 'C:/AppData/whisper-desktop', entries: ['config.json', 'models', 'recordings'] });
  });

  it('prefers the first legacy directory that holds something of ours', () => {
    const plan = planUserDataMigration({
      targetExists: false,
      legacyDirs: [
        { path: 'C:/AppData/whisper-desktop', entries: ['Cache'] },
        { path: 'C:/AppData/Whisper Desktop', entries: ['config.json', 'logs'] },
      ],
    });
    expect(plan).toEqual({ from: 'C:/AppData/Whisper Desktop', entries: ['config.json', 'logs'] });
  });

  it('ignores legacy directories that hold none of our entries', () => {
    expect(
      planUserDataMigration({
        targetExists: false,
        legacyDirs: [{ path: 'C:/AppData/whisper-desktop', entries: ['Cache', 'GPUCache'] }],
      }),
    ).toBeNull();
  });
});
```

Note: `MIGRATED_ENTRIES` order is the contract — the plan's expectation lists `config.json, models, recordings` in that order regardless of how `readdirSync` returned them.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/userDataMigration.test.ts`
Expected: FAIL — `Cannot find module '../services/userDataMigration'`.

- [ ] **Step 3: Write the implementation**

Create `src/services/userDataMigration.ts`:

```ts
export const LEGACY_APP_DIRS: readonly string[] = ['whisper-desktop', 'Whisper Desktop'];

// Everything else in a legacy profile (Electron caches, GPU caches) is disposable.
export const MIGRATED_ENTRIES: readonly string[] = ['config.json', 'models', 'logs', 'recordings'];

export interface LegacyDir {
  path: string;
  entries: string[];
}

export interface MigrationPlan {
  from: string;
  entries: string[];
}

export function planUserDataMigration(input: { targetExists: boolean; legacyDirs: LegacyDir[] }): MigrationPlan | null {
  if (input.targetExists) return null;
  for (const dir of input.legacyDirs) {
    const entries = MIGRATED_ENTRIES.filter((name) => dir.entries.includes(name));
    if (entries.length > 0) {
      return { from: dir.path, entries };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/userDataMigration.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Create the identity module**

Create `src/appIdentity.ts`:

```ts
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { LEGACY_APP_DIRS, planUserDataMigration } from './services/userDataMigration';

// Must run before anything calls app.getPath('userData') — electron-store resolves its
// location at import time, so main.ts imports this module first.
app.setName('Dark-Whisper');

const appData = app.getPath('appData');
const target = path.join(appData, 'Dark-Whisper');

function listDir(dir: string): string[] | null {
  try {
    return fs.readdirSync(dir);
  } catch {
    return null;
  }
}

const legacyDirs = LEGACY_APP_DIRS.map((name) => path.join(appData, name))
  .map((dir) => ({ path: dir, entries: listDir(dir) }))
  .filter((d): d is { path: string; entries: string[] } => d.entries !== null);

const plan = planUserDataMigration({ targetExists: fs.existsSync(target), legacyDirs });

if (plan) {
  console.warn(`Migrating user data from ${plan.from} to ${target}: ${plan.entries.join(', ')}`);
  fs.mkdirSync(target, { recursive: true });
  for (const entry of plan.entries) {
    const from = path.join(plan.from, entry);
    const to = path.join(target, entry);
    try {
      fs.renameSync(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EXDEV') {
        // Different volume: copy then remove.
        fs.cpSync(from, to, { recursive: true });
        fs.rmSync(from, { recursive: true, force: true });
      } else {
        console.error(`Failed to migrate ${entry}:`, error);
      }
    }
  }
}
```

- [ ] **Step 6: Wire it up and rebrand the strings**

In `src/main.ts`, make this the **first** import line, above the `electron` import:

```ts
import './appIdentity';
```

In the same file, change the tray tooltip and notification titles from `Whisper Desktop` to `Dark-Whisper`:
- `tray.setToolTip('Whisper Desktop')` → `tray.setToolTip('Dark-Whisper')`
- `tray?.setToolTip(\`Whisper Desktop — ${view.text}\`)` → `` tray?.setToolTip(`Dark-Whisper — ${view.text}`) ``
- every `showSystemNotification('Whisper Desktop', …)` → `showSystemNotification('Dark-Whisper', …)`

In `package.json`: `"name": "dark-whisper"`.
In `electron-builder.yml`: `productName: Dark-Whisper` (leave `appId` and `artifactName` alone).
In `public/index.html`: `<title>Dark-Whisper</title>`, the `<h1>` text `🎤 Dark-Whisper`, and the settings-saved message if it names the app.

Confirm nothing user-visible was missed: `grep -rn "Whisper Desktop" src public package.json electron-builder.yml` should return only the `clean-build` script's stale `dist/Whisper Desktop.exe` paths (pre-existing dead code — leave them).

- [ ] **Step 7: Verify**

Run: `npm run build && npm test && npm run lint`
Expected: build clean, all suites pass, 0 lint errors.

Run the app and confirm the migration and identity:

```bash
ELECTRON_ENABLE_LOGGING=1 timeout 25 node_modules/electron/dist/electron.exe . > "$TEMP/rebrand-run.log" 2>&1; echo "exit: $?"
grep -iE "Migrating user data|Uncaught|ReferenceError|Cannot find module" "$TEMP/rebrand-run.log"
ls "$APPDATA/Dark-Whisper" && ls "$APPDATA/whisper-desktop" 2>&1 | tail -1
```

Expected: exit 124; a `Migrating user data` line on the first run; `%APPDATA%\Dark-Whisper` now contains `config.json` and `models`; the old directory either gone or holding only caches. Kill any process you started.

- [ ] **Step 8: Checkpoint (no commit)**

Run: `git status --short`.

---

### Task 2: Ship `whisper-stream.exe` and SDL2

**Files:**
- Modify: `src/services/serverPaths.ts`
- Test: `src/__tests__/serverPaths.test.ts` (extend)
- Modify: `scripts/fetch-whisper.js`
- Modify: `.github/workflows/publish.yml` (the `build-whisper` job)

**Interfaces:**
- Consumes: `Backend`, `BinaryLocations`, `whisperResourceDir` (existing in `serverPaths.ts`).
- Produces:
  - `const STREAM_EXE = 'whisper-stream.exe'`
  - `candidateStreamPaths(backend: Backend, loc: BinaryLocations): string[]`
  - `resolveStreamBinary(backend: Backend, loc: BinaryLocations, exists: (p: string) => boolean): string | null`

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/serverPaths.test.ts` (inside the existing `describe('serverPaths', …)`):

```ts
  it('resolves whisper-stream.exe next to the server binary', () => {
    const packagedStream = path.join('/app/resources', 'whisper', 'cpu', 'whisper-stream.exe');
    expect(candidateStreamPaths('cpu', packaged)).toEqual([packagedStream]);
    expect(resolveStreamBinary('cpu', packaged, (p) => p === packagedStream)).toBe(packagedStream);
    expect(resolveStreamBinary('cpu', packaged, () => false)).toBeNull();
  });

  it('honours WHISPER_SERVER_DIR for the vulkan stream binary only', () => {
    const loc = { ...dev, envDir: '/local/vulkan-build' };
    expect(candidateStreamPaths('vulkan', loc)).toEqual([
      path.join('/local/vulkan-build', 'whisper-stream.exe'),
      path.join('/repo', 'resources', 'whisper', 'vulkan', 'whisper-stream.exe'),
    ]);
    expect(candidateStreamPaths('cpu', loc)).toEqual([path.join('/repo', 'resources', 'whisper', 'cpu', 'whisper-stream.exe')]);
  });
```

Add `candidateStreamPaths, resolveStreamBinary` to the file's import from `../services/serverPaths`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/serverPaths.test.ts`
Expected: FAIL — `candidateStreamPaths is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/services/serverPaths.ts`, add the export and generalise the existing candidate builder. Replace the body of `candidateServerPaths` and add the stream variants:

```ts
export const STREAM_EXE = 'whisper-stream.exe';

function candidatePaths(backend: Backend, loc: BinaryLocations, exe: string): string[] {
  const candidates: string[] = [];
  if (backend === 'vulkan' && loc.envDir) {
    candidates.push(path.join(loc.envDir, exe));
  }
  candidates.push(path.join(whisperResourceDir(loc), backend, exe));
  return candidates;
}

export function candidateServerPaths(backend: Backend, loc: BinaryLocations): string[] {
  return candidatePaths(backend, loc, SERVER_EXE);
}

export function candidateStreamPaths(backend: Backend, loc: BinaryLocations): string[] {
  return candidatePaths(backend, loc, STREAM_EXE);
}

export function resolveStreamBinary(backend: Backend, loc: BinaryLocations, exists: (p: string) => boolean): string | null {
  return candidateStreamPaths(backend, loc).find(exists) ?? null;
}
```

Leave `resolveServerBinary` as it is — it already calls `candidateServerPaths`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/serverPaths.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Copy `whisper-stream.exe` in the dev fetch script**

In `scripts/fetch-whisper.js`, change the copy filter:

```js
    for (const file of fs.readdirSync(releaseDir)) {
      const keep = file === 'whisper-server.exe' || file === 'whisper-stream.exe' || file.toLowerCase().endsWith('.dll');
      if (keep) {
        fs.copyFileSync(path.join(releaseDir, file), path.join(outDir, file));
      }
    }
```

- [ ] **Step 6: Build `whisper-stream.exe` in CI**

In `.github/workflows/publish.yml`, in the `build-whisper` job:

Add to the job's `env:` block (next to `VULKAN_VERSION`):

```yaml
      SDL2_VERSION: 2.30.9
```

Add `-${{ env.SDL2_VERSION }}` to the cache key so a new SDL2 rebuilds:

```yaml
          key: whisper-${{ steps.version.outputs.tag }}-vulkan-${{ env.VULKAN_VERSION }}-sdl2-${{ env.SDL2_VERSION }}-v1
```

Insert this step immediately **before** "Build CPU and Vulkan servers" (same `if:` guard):

```yaml
      - name: Fetch SDL2
        if: steps.cache.outputs.cache-hit != 'true'
        shell: pwsh
        run: |
          $url = "https://github.com/libsdl-org/SDL/releases/download/release-${env:SDL2_VERSION}/SDL2-devel-${env:SDL2_VERSION}-VC.zip"
          curl.exe -sL -o "$env:RUNNER_TEMP/sdl2.zip" $url
          if ($LASTEXITCODE -ne 0) { throw "SDL2 download failed: $url" }
          7z x "$env:RUNNER_TEMP/sdl2.zip" -o"$env:RUNNER_TEMP" | Out-Null
          $sdlRoot = "$env:RUNNER_TEMP/SDL2-${env:SDL2_VERSION}"
          if (-not (Test-Path "$sdlRoot/cmake")) { throw "SDL2 layout unexpected under $sdlRoot" }
          Add-Content $env:GITHUB_ENV "SDL2_DIR=$sdlRoot/cmake"
          Add-Content $env:GITHUB_ENV "SDL2_LIB_DIR=$sdlRoot/lib/x64"
```

In the "Build CPU and Vulkan servers" step, add SDL2 to the shared cmake args and copy the new files. The `$common` array gains one entry:

```powershell
            '-DWHISPER_SDL2=ON',
```

and the copy loop becomes:

```powershell
          foreach ($backend in 'cpu', 'vulkan') {
            $out = "../whisper-dist/$backend"
            New-Item -ItemType Directory -Force $out | Out-Null
            Copy-Item "build-$backend/bin/Release/whisper-server.exe" $out
            Copy-Item "build-$backend/bin/Release/whisper-stream.exe" $out
            Copy-Item "build-$backend/bin/Release/*.dll" $out
            Copy-Item "$env:SDL2_LIB_DIR/SDL2.dll" $out
          }
```

Add a check after the existing "Check Vulkan server launches" step:

```yaml
      - name: Check stream binaries launch
        shell: pwsh
        run: |
          foreach ($backend in 'cpu', 'vulkan') {
            $out = & "whisper-dist/$backend/whisper-stream.exe" --help 2>&1 | Out-String
            if ($out -notmatch 'capture device') { throw "$backend whisper-stream.exe --help did not print usage" }
          }
```

(`whisper-stream.exe` prints its usage to stderr and exits 0, and the usage text contains `capture device`.)

**Divergence from spec §13, deliberate:** the spec also suggested starting `whisper-stream.exe` under `SDL_AUDIODRIVER=dummy` in CI. The dummy driver exposes no *capture* device, so such a run fails at `SDL_OpenAudioDevice` and can never reach `[Start speaking]` — it would test nothing and fail confusingly. The `--help` check proves what CI can prove: that the binary and `SDL2.dll` were built and shipped. Real microphone behaviour is covered by the Task 5 probe and the manual checklist.

- [ ] **Step 7: Verify locally**

```bash
npm run whisper:fetch
ls resources/whisper/cpu | grep -iE "whisper-stream.exe|SDL2.dll"
resources/whisper/cpu/whisper-stream.exe --help 2>&1 | grep -c "capture device"
node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/publish.yml','utf8'));console.log('workflow yaml ok')"
npm run build && npm test && npm run lint
```

Expected: `whisper-stream.exe` and `SDL2.dll` both present; the usage grep prints `1`; workflow parses; build/tests/lint clean.

If `whisper-stream.exe` is missing from the fetched zip, stop and report — the plan assumes `whisper-bin-x64.zip` for tag `b5130` contains it (verified: it does).

- [ ] **Step 8: Checkpoint (no commit)**

Run: `git status --short` — `resources/` must not appear (gitignored).

---

### Task 3: Parse `whisper-stream.exe` output

**Files:**
- Create: `src/services/streamOutput.ts`
- Test: `src/__tests__/streamOutput.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces:
  - `const READY_MARKER = '[Start speaking]'`
  - `interface CaptureDevice { index: number; name: string }`
  - `type StreamEvent = { kind: 'ready' } | { kind: 'segment'; text: string } | { kind: 'device'; device: CaptureDevice } | { kind: 'capture-failed' } | { kind: 'model-load-failed' }`
  - `stripAnsi(line: string): string`
  - `type StreamSource = 'stdout' | 'stderr'`
  - `parseStreamLine(line: string, source: StreamSource): StreamEvent | null` — stderr yields only device/capture-failed/model-load-failed; stdout yields ready or segments, with no prefix guessing
  - `isNoiseSegment(text: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/streamOutput.test.ts`:

```ts
import { parseStreamLine, stripAnsi, isNoiseSegment, READY_MARKER } from '../services/streamOutput';

describe('streamOutput', () => {
  describe('stripAnsi', () => {
    it('removes the redraw sequences whisper-stream.exe emits', () => {
      expect(stripAnsi('\u001b[2K\rhello')).toBe('hello');
      expect(stripAnsi('plain')).toBe('plain');
    });
  });

  describe('parseStreamLine', () => {
    it('recognises the ready marker', () => {
      expect(READY_MARKER).toBe('[Start speaking]');
      expect(parseStreamLine('[Start speaking]')).toEqual({ kind: 'ready' });
    });

    it('reads a timestamped segment and drops the timestamps', () => {
      expect(parseStreamLine('[00:00:01.000 --> 00:00:04.000]   And so my fellow Americans')).toEqual({
        kind: 'segment',
        text: 'And so my fellow Americans',
      });
    });

    it('reads a bare segment line', () => {
      expect(parseStreamLine('ask not what your country can do for you')).toEqual({
        kind: 'segment',
        text: 'ask not what your country can do for you',
      });
    });

    it('reads capture devices', () => {
      expect(parseStreamLine("init:    - Capture device #0: 'Microphone (Realtek Audio)'")).toEqual({
        kind: 'device',
        device: { index: 0, name: 'Microphone (Realtek Audio)' },
      });
      expect(parseStreamLine("init:    - Capture device #2: 'Headset (Jabra)'")).toEqual({
        kind: 'device',
        device: { index: 2, name: 'Headset (Jabra)' },
      });
    });

    it('recognises failures', () => {
      expect(parseStreamLine("init: couldn't open an audio device for capture: No such device!")).toEqual({
        kind: 'capture-failed',
      });
      expect(parseStreamLine('error: failed to initialize whisper context')).toEqual({ kind: 'model-load-failed' });
    });

    it.each([
      'main: found 3 capture devices:',
      'init: attempt to open capture device 0 : \'Microphone\' ...',
      'init:     - sample rate:       16000',
      'whisper_init_from_file_with_params_no_state: loading model from ggml-base.en.bin',
      'whisper_backend_init_gpu: no GPU found',
      'system_info: n_threads = 4',
      '',
      '   ',
    ])('ignores noise line %p', (line) => {
      expect(parseStreamLine(line)).toBeNull();
    });

    it('strips ANSI before deciding', () => {
      expect(parseStreamLine('\u001b[2K\r[Start speaking]')).toEqual({ kind: 'ready' });
    });
  });

  describe('isNoiseSegment', () => {
    it.each(['[BLANK_AUDIO]', '(blank audio)', '[ Silence ]', '(buzzing)', '...', '', '  '])(
      'treats %p as noise',
      (text) => {
        expect(isNoiseSegment(text)).toBe(true);
      },
    );

    it('keeps real speech', () => {
      expect(isNoiseSegment('Hello there.')).toBe(false);
      expect(isNoiseSegment('(pause) but then we continued')).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/streamOutput.test.ts`
Expected: FAIL — `Cannot find module '../services/streamOutput'`.

- [ ] **Step 3: Write the implementation**

Create `src/services/streamOutput.ts`:

```ts
export const READY_MARKER = '[Start speaking]';

export interface CaptureDevice {
  index: number;
  name: string;
}

export type StreamEvent =
  | { kind: 'ready' }
  | { kind: 'segment'; text: string }
  | { kind: 'device'; device: CaptureDevice }
  | { kind: 'capture-failed' }
  | { kind: 'model-load-failed' };

// whisper-stream.exe redraws its provisional line with CSI sequences.
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(line: string): string {
  return line.replace(ANSI, '').replace(/\r/g, '');
}

const DEVICE = /- Capture device #(\d+): '(.*)'/;
const TIMESTAMPED = /^\[\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\]\s*(.*)$/;
// Diagnostics all carry a "prefix:" from whisper.cpp/SDL; speech never does.
const DIAGNOSTIC = /^(main|init|system_info|whisper_\w+|ggml_\w+|error|usage|sdl)\b.*:/;

export function parseStreamLine(raw: string): StreamEvent | null {
  const line = stripAnsi(raw).trim();
  if (line.length === 0) return null;

  if (line === READY_MARKER) return { kind: 'ready' };
  if (line.includes("couldn't open an audio device for capture")) return { kind: 'capture-failed' };
  if (line.includes('failed to initialize whisper context')) return { kind: 'model-load-failed' };

  const device = DEVICE.exec(line);
  if (device) {
    return { kind: 'device', device: { index: Number(device[1]), name: device[2] } };
  }

  const timestamped = TIMESTAMPED.exec(line);
  if (timestamped) {
    const text = timestamped[1].trim();
    return text.length > 0 ? { kind: 'segment', text } : null;
  }

  if (DIAGNOSTIC.test(line)) return null;

  return { kind: 'segment', text: line };
}

// Whisper emits bracketed or parenthesised annotations for non-speech audio.
const NOISE_ONLY = /^[[(][^)\]]*[)\]]$/;

export function isNoiseSegment(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (NOISE_ONLY.test(trimmed)) return true;
  return /^[.…,!?-]+$/.test(trimmed);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/streamOutput.test.ts`
Expected: PASS. Then `npm run build && npm run lint`.

- [ ] **Step 5: Checkpoint (no commit)**

Run: `git status --short`.

---

### Task 4: `whisper-stream.exe` supervisor

**Files:**
- Create: `src/services/streamEngine.ts`
- Test: `src/__tests__/streamEngine.test.ts`

**Interfaces:**
- Consumes (Task 3): `parseStreamLine`, `isNoiseSegment`, `READY_MARKER`, `CaptureDevice`. Also existing `LineBuffer` and `restartDelay` from `./serverOutput`.
- Produces:
  - `type StreamState = 'idle' | 'starting' | 'listening' | 'paused' | 'stopped' | 'error'`
  - `interface StreamStatus { state: StreamState; devices: CaptureDevice[]; captureId: number | null; message?: string }`
  - `interface StreamProcess { pid: number | undefined; stdout: DataSource; stderr: DataSource; onExit(l: (code: number | null) => void): void; kill(): void }` (same `DataSource` shape as `whisperServer.ts`)
  - `interface StreamLaunchOptions { modelPath: string; language: string; captureId: number | null; forceCpu: boolean; cwd: string; threads: number }`
  - `interface StreamEngineDeps { resolveBinary(): string | null; spawnStream(binary: string, args: string[], cwd: string): StreamProcess; writeLog(lines: string[]): void; now(): number }`
  - `const STREAM_READY_TIMEOUT_MS = 60_000`
  - `class StreamEngine` with `start(opts)`, `setPaused(paused: boolean)`, `stop()`, `getStatus()`, `onStatus(l)`, `onSegment(l: (s: { text: string; atMs: number }) => void)`, `onLaunch(l: (info: { atMs: number }) => void)`
  - `buildStreamArgs(opts: StreamLaunchOptions): string[]` (exported for testing)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/streamEngine.test.ts`:

```ts
import { EventEmitter } from 'events';
import { StreamEngine, StreamProcess, buildStreamArgs } from '../services/streamEngine';

class FakeProcess implements StreamProcess {
  pid = 909;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  private exitListener: ((code: number | null) => void) | null = null;

  onExit(listener: (code: number | null) => void): void {
    this.exitListener = listener;
  }
  kill(): void {
    this.killed = true;
  }
  out(line: string): void {
    this.stdout.emit('data', Buffer.from(`${line}\n`));
  }
  err(line: string): void {
    this.stderr.emit('data', Buffer.from(`${line}\n`));
  }
  exit(code: number | null): void {
    this.exitListener?.(code);
  }
}

const OPTS = {
  modelPath: 'C:/models/ggml-base.en.bin',
  language: 'en',
  captureId: 1,
  forceCpu: false,
  cwd: 'C:/sessions/s1',
  threads: 4,
};

function setup() {
  const procs: FakeProcess[] = [];
  const deps = {
    resolveBinary: jest.fn((): string | null => 'C:/whisper/cpu/whisper-stream.exe'),
    spawnStream: jest.fn((_binary: string, _args: string[], _cwd: string) => {
      const p = new FakeProcess();
      procs.push(p);
      return p;
    }),
    writeLog: jest.fn(),
    now: () => Date.now(),
  };
  const engine = new StreamEngine(deps);
  const segments: { text: string; atMs: number }[] = [];
  const launches: { atMs: number }[] = [];
  engine.onSegment((s) => segments.push(s));
  engine.onLaunch((l) => launches.push(l));
  return { engine, deps, procs, segments, launches };
}

describe('buildStreamArgs', () => {
  it('uses VAD mode, the model, language, device and audio saving', () => {
    expect(buildStreamArgs(OPTS)).toEqual([
      '-m', 'C:/models/ggml-base.en.bin',
      '--step', '0',
      '--length', '10000',
      '-vth', '0.6',
      '-t', '4',
      '-l', 'en',
      '-c', '1',
      '-sa',
      '-f', 'live.txt',
    ]);
  });

  it('omits the device flag for the default device and adds -ng when CPU is forced', () => {
    const args = buildStreamArgs({ ...OPTS, captureId: null, forceCpu: true });
    expect(args).not.toContain('-c');
    expect(args).toContain('-ng');
  });
});

describe('StreamEngine', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('starts idle', () => {
    expect(setup().engine.getStatus()).toEqual({ state: 'idle', devices: [], captureId: null });
  });

  it('spawns and reaches listening on the ready marker', async () => {
    const { engine, deps, procs } = setup();
    await engine.start(OPTS);
    expect(deps.spawnStream).toHaveBeenCalledWith('C:/whisper/cpu/whisper-stream.exe', buildStreamArgs(OPTS), 'C:/sessions/s1');
    expect(engine.getStatus().state).toBe('starting');

    procs[0].out('[Start speaking]');
    expect(engine.getStatus()).toMatchObject({ state: 'listening', captureId: 1 });
  });

  it('reports the launch so the caller can track audio files', async () => {
    const ctx = setup();
    await ctx.engine.start(OPTS);
    ctx.procs[0].out('[Start speaking]');
    expect(ctx.launches).toEqual([{ atMs: 0 }]);
  });

  it('emits segments once listening, dropping noise annotations', async () => {
    const ctx = setup();
    await ctx.engine.start(OPTS);
    ctx.procs[0].out('[Start speaking]');
    await jest.advanceTimersByTimeAsync(1500);
    ctx.procs[0].out('[00:00:00.000 --> 00:00:02.000]  hello world');
    ctx.procs[0].out('[BLANK_AUDIO]');
    ctx.procs[0].out('second line');
    expect(ctx.segments).toEqual([
      { text: 'hello world', atMs: 1500 },
      { text: 'second line', atMs: 1500 },
    ]);
  });

  it('ignores segments that arrive before ready and while paused', async () => {
    const ctx = setup();
    await ctx.engine.start(OPTS);
    ctx.procs[0].out('too early');
    ctx.procs[0].out('[Start speaking]');
    ctx.engine.setPaused(true);
    expect(ctx.engine.getStatus().state).toBe('paused');
    ctx.procs[0].out('while paused');
    ctx.engine.setPaused(false);
    expect(ctx.engine.getStatus().state).toBe('listening');
    ctx.procs[0].out('after resume');
    expect(ctx.segments.map((s) => s.text)).toEqual(['after resume']);
  });

  it('collects the capture device list from stderr', async () => {
    const ctx = setup();
    await ctx.engine.start(OPTS);
    ctx.procs[0].err("init:    - Capture device #0: 'Microphone (Realtek Audio)'");
    ctx.procs[0].err("init:    - Capture device #1: 'Headset (Jabra)'");
    expect(ctx.engine.getStatus().devices).toEqual([
      { index: 0, name: 'Microphone (Realtek Audio)' },
      { index: 1, name: 'Headset (Jabra)' },
    ]);
  });

  it('errors without retry when the model fails to load', async () => {
    const ctx = setup();
    await ctx.engine.start(OPTS);
    ctx.procs[0].err('error: failed to initialize whisper context');
    ctx.procs[0].exit(3);
    await jest.advanceTimersByTimeAsync(0);
    expect(ctx.deps.spawnStream).toHaveBeenCalledTimes(1);
    expect(ctx.engine.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(/Live model failed to load/) });
  });

  it('errors without retry when the microphone cannot be opened', async () => {
    const ctx = setup();
    await ctx.engine.start(OPTS);
    ctx.procs[0].err("init: couldn't open an audio device for capture: No such device!");
    ctx.procs[0].exit(1);
    await jest.advanceTimersByTimeAsync(0);
    expect(ctx.deps.spawnStream).toHaveBeenCalledTimes(1);
    expect(ctx.engine.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(/microphone/i) });
  });

  it('errors when the engine never becomes ready', async () => {
    const ctx = setup();
    await ctx.engine.start(OPTS);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(ctx.engine.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(/60 seconds/) });
    expect(ctx.procs[0].killed).toBe(true);
  });

  it('restarts a crash with 1s/5s/15s backoff and reports each relaunch', async () => {
    const ctx = setup();
    await ctx.engine.start(OPTS);
    ctx.procs[0].out('[Start speaking]');

    for (const delay of [1000, 5000, 15000]) {
      const count = ctx.procs.length;
      ctx.procs[count - 1].exit(1);
      await jest.advanceTimersByTimeAsync(0);
      expect(ctx.engine.getStatus().state).toBe('starting');
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(ctx.procs).toHaveLength(count);
      await jest.advanceTimersByTimeAsync(1);
      expect(ctx.procs).toHaveLength(count + 1);
      ctx.procs[count].out('[Start speaking]');
      expect(ctx.engine.getStatus().state).toBe('listening');
    }

    ctx.procs[ctx.procs.length - 1].exit(1);
    await jest.advanceTimersByTimeAsync(0);
    expect(ctx.engine.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(/repeatedly/) });
    expect(ctx.launches).toHaveLength(4);
    expect(ctx.launches[1].atMs).toBeGreaterThan(0);
  });

  it('stop kills the process, reports stopped, and ignores the late exit', async () => {
    const ctx = setup();
    await ctx.engine.start(OPTS);
    ctx.procs[0].out('[Start speaking]');
    ctx.engine.stop();
    expect(ctx.procs[0].killed).toBe(true);
    expect(ctx.engine.getStatus().state).toBe('stopped');
    ctx.procs[0].exit(0);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(ctx.deps.spawnStream).toHaveBeenCalledTimes(1);
  });

  it('errors when the binary is missing', async () => {
    const ctx = setup();
    ctx.deps.resolveBinary.mockReturnValue(null);
    await ctx.engine.start(OPTS);
    expect(ctx.deps.spawnStream).not.toHaveBeenCalled();
    expect(ctx.engine.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(/stream\.exe/) });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/streamEngine.test.ts`
Expected: FAIL — `Cannot find module '../services/streamEngine'`.

- [ ] **Step 3: Write the implementation**

Create `src/services/streamEngine.ts`:

```ts
import { LineBuffer, restartDelay } from './serverOutput';
import { CaptureDevice, isNoiseSegment, parseStreamLine, StreamSource } from './streamOutput';

export type StreamState = 'idle' | 'starting' | 'listening' | 'paused' | 'stopped' | 'error';

export interface StreamStatus {
  state: StreamState;
  devices: CaptureDevice[];
  captureId: number | null;
  message?: string;
}

interface DataSource {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

export interface StreamProcess {
  pid: number | undefined;
  stdout: DataSource;
  stderr: DataSource;
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
}

export interface StreamLaunchOptions {
  modelPath: string;
  language: string;
  captureId: number | null;
  forceCpu: boolean;
  cwd: string;
  threads: number;
}

export interface StreamEngineDeps {
  resolveBinary(): string | null;
  spawnStream(binary: string, args: string[], cwd: string): StreamProcess;
  writeLog(lines: string[]): void;
  now(): number;
}

export const STREAM_READY_TIMEOUT_MS = 60_000;
export const STREAM_WINDOW_MS = 10_000;
export const STREAM_VAD_THRESHOLD = '0.6';
export const LIVE_TEXT_SINK = 'live.txt';

export function buildStreamArgs(opts: StreamLaunchOptions): string[] {
  const args = [
    '-m', opts.modelPath,
    '--step', '0',
    '--length', String(STREAM_WINDOW_MS),
    '-vth', STREAM_VAD_THRESHOLD,
    '-t', String(opts.threads),
    '-l', opts.language,
  ];
  if (opts.captureId !== null) {
    args.push('-c', String(opts.captureId));
  }
  if (opts.forceCpu) {
    args.push('-ng');
  }
  args.push('-sa', '-f', LIVE_TEXT_SINK);
  return args;
}

export class StreamEngine {
  private status: StreamStatus = { state: 'idle', devices: [], captureId: null };
  private readonly statusListeners = new Set<(s: StreamStatus) => void>();
  private readonly segmentListeners = new Set<(s: { text: string; atMs: number }) => void>();
  private readonly launchListeners = new Set<(l: { atMs: number }) => void>();
  private readonly stdoutLines = new LineBuffer(500);
  private readonly stderrLines = new LineBuffer(500);
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private proc: StreamProcess | null = null;
  private generation = 0;
  private crashCount = 0;
  private opts: StreamLaunchOptions | null = null;
  private startedAt = 0;
  private paused = false;
  private fatal: string | null = null;

  constructor(private readonly deps: StreamEngineDeps) {}

  getStatus(): StreamStatus {
    return { ...this.status, devices: [...this.status.devices] };
  }

  onStatus(listener: (s: StreamStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  onSegment(listener: (s: { text: string; atMs: number }) => void): () => void {
    this.segmentListeners.add(listener);
    return () => {
      this.segmentListeners.delete(listener);
    };
  }

  onLaunch(listener: (l: { atMs: number }) => void): () => void {
    this.launchListeners.add(listener);
    return () => {
      this.launchListeners.delete(listener);
    };
  }

  async start(opts: StreamLaunchOptions): Promise<void> {
    this.halt();
    this.opts = opts;
    this.crashCount = 0;
    this.paused = false;
    this.fatal = null;
    this.startedAt = this.deps.now();
    this.setStatus({ state: 'starting', devices: [], captureId: opts.captureId });
    await this.launch();
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (this.status.state === 'listening' || this.status.state === 'paused') {
      this.setStatus({ ...this.status, state: paused ? 'paused' : 'listening' });
    }
  }

  stop(): void {
    this.halt();
    this.setStatus({ ...this.status, state: 'stopped', message: undefined });
  }

  private halt(): void {
    this.generation++;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  private schedule(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private setStatus(next: StreamStatus): void {
    this.status = next;
    this.deps.writeLog([...this.stderrLines.lines(), ...this.stdoutLines.lines()]);
    const snapshot = this.getStatus();
    for (const l of this.statusListeners) l(snapshot);
  }

  private fail(message: string): void {
    this.setStatus({ ...this.status, state: 'error', message });
  }

  private elapsed(): number {
    return this.deps.now() - this.startedAt;
  }

  private async launch(): Promise<void> {
    const opts = this.opts;
    if (!opts) return;
    const generation = ++this.generation;
    const binary = this.deps.resolveBinary();
    if (!binary) {
      this.fail('Live transcription is not installed (whisper-stream.exe is missing)');
      return;
    }

    const proc = this.deps.spawnStream(binary, buildStreamArgs(opts), opts.cwd);
    this.proc = proc;

    // Each stream gets its own buffer: whisper-stream writes transcript text to stdout and
    // every diagnostic to stderr, and interleaving them would corrupt partial lines.
    const handle = (source: StreamSource, buffer: LineBuffer) => (chunk: Buffer | string) => {
      for (const line of buffer.push(String(chunk))) {
        if (generation !== this.generation) return;
        this.handleLine(line, source);
      }
    };
    proc.stdout.on('data', handle('stdout', this.stdoutLines));
    proc.stderr.on('data', handle('stderr', this.stderrLines));
    proc.onExit((code) => this.handleExit(generation, code));

    const deadline = this.deps.now() + STREAM_READY_TIMEOUT_MS;
    this.pollReady(generation, deadline);
  }

  private pollReady(generation: number, deadline: number): void {
    this.schedule(() => {
      if (generation !== this.generation || this.status.state !== 'starting') return;
      if (this.deps.now() >= deadline) {
        this.halt();
        this.fail('Live transcription did not start within 60 seconds');
        return;
      }
      this.pollReady(generation, deadline);
    }, 500);
  }

  private handleLine(line: string, source: StreamSource): void {
    const event = parseStreamLine(line, source);
    if (!event) return;

    switch (event.kind) {
      case 'ready':
        if (this.status.state === 'starting') {
          this.setStatus({ ...this.status, state: this.paused ? 'paused' : 'listening', message: undefined });
          const atMs = this.elapsed();
          for (const l of this.launchListeners) l({ atMs });
        }
        return;
      case 'device': {
        const devices = this.status.devices.filter((d) => d.index !== event.device.index).concat(event.device);
        devices.sort((a, b) => a.index - b.index);
        this.setStatus({ ...this.status, devices });
        return;
      }
      case 'capture-failed':
        this.fatal = 'Could not open the microphone for live transcription';
        return;
      case 'model-load-failed':
        this.fatal = 'Live model failed to load — try re-downloading it';
        return;
      case 'segment': {
        if (this.status.state !== 'listening' || isNoiseSegment(event.text)) return;
        const segment = { text: event.text, atMs: this.elapsed() };
        for (const l of this.segmentListeners) l(segment);
        return;
      }
    }
  }

  private handleExit(generation: number, code: number | null): void {
    if (generation !== this.generation) return;
    this.proc = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();

    if (this.fatal) {
      this.fail(this.fatal);
      return;
    }

    this.crashCount++;
    const delay = restartDelay(this.crashCount);
    if (delay === null) {
      this.fail(`Live transcription crashed repeatedly (exit code ${code})`);
      return;
    }
    this.setStatus({ ...this.status, state: 'starting', message: `Live transcription restarting in ${delay / 1000}s` });
    this.schedule(() => {
      if (generation === this.generation) void this.launch();
    }, delay);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/streamEngine.test.ts`
Expected: PASS (13 tests). If a fake-timer assertion needs an extra promise turn, add `await jest.advanceTimersByTimeAsync(0)` after the triggering call — do not weaken assertions.

Then `npm run build && npm test && npm run lint`.

- [ ] **Step 5: Checkpoint (no commit)**

Run: `git status --short`.

---

### Task 5: Engine runtime wiring and a dev probe

**Files:**
- Create: `src/services/streamRuntime.ts`
- Create: `src/services/sessionPaths.ts`
- Create: `scripts/stream-probe.js`
- Test: `src/__tests__/sessionPaths.test.ts`
- Modify: `package.json` (add `stream:probe` script)

**Interfaces:**
- Consumes: `StreamEngine`, `StreamEngineDeps`, `StreamLaunchOptions` (Task 4); `resolveStreamBinary` (Task 2); `whisperResourceDir`, `BinaryLocations` (existing); `getSettings` (existing).
- Produces:
  - `sessionPaths.ts` (pure): `newSessionId(now: Date): string` (`YYYYMMDD-HHmmss`), `sessionDirName(id: string): string`, `pickNewAudioFile(before: string[], after: string[]): string | null`
  - `streamRuntime.ts`: `const streamEngine: StreamEngine`, `createSessionDir(sessionId: string): string`, `sessionsRoot(): string`, `resolveLiveModelPath(): string | null`, `startLiveEngine(args: { sessionId: string; captureId: number | null }): Promise<void>`, `stopLiveEngine(): void`, `currentAudioFiles(sessionId: string): string[]`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/sessionPaths.test.ts`:

```ts
import { newSessionId, pickNewAudioFile } from '../services/sessionPaths';

describe('sessionPaths', () => {
  it('builds a sortable session id from the clock', () => {
    expect(newSessionId(new Date('2026-09-15T14:32:04Z'))).toMatch(/^\d{8}-\d{6}$/);
    expect(newSessionId(new Date(2026, 8, 15, 14, 32, 4))).toBe('20260915-143204');
  });

  it('spots the audio file whisper-stream.exe just created', () => {
    expect(pickNewAudioFile(['live.txt'], ['live.txt', '20260915143204.wav'])).toBe('20260915143204.wav');
  });

  it('returns the newest name when several appeared', () => {
    expect(pickNewAudioFile([], ['20260915143204.wav', '20260915150000.wav'])).toBe('20260915150000.wav');
  });

  it('returns null when nothing new appeared', () => {
    expect(pickNewAudioFile(['20260915143204.wav'], ['20260915143204.wav'])).toBeNull();
    expect(pickNewAudioFile([], ['live.txt'])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/sessionPaths.test.ts`
Expected: FAIL — `Cannot find module '../services/sessionPaths'`.

- [ ] **Step 3: Write `sessionPaths.ts`**

Create `src/services/sessionPaths.ts`:

```ts
function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

export function newSessionId(now: Date): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}`;
  const time = `${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}`;
  return `${date}-${time}`;
}

export function sessionDirName(id: string): string {
  return id;
}

// whisper-stream.exe names its WAV after the local clock, so the new name is whatever appeared.
export function pickNewAudioFile(before: string[], after: string[]): string | null {
  const previous = new Set(before);
  const added = after.filter((name) => !previous.has(name) && name.toLowerCase().endsWith('.wav'));
  if (added.length === 0) return null;
  return added.sort()[added.length - 1];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/sessionPaths.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write `streamRuntime.ts`**

Create `src/services/streamRuntime.ts`:

```ts
import { app } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BinaryLocations, resolveStreamBinary } from './serverPaths';
import { getSettings } from './settingsService';
import { StreamEngine, StreamProcess } from './streamEngine';

const userData = app.getPath('userData');
const logFile = path.join(userData, 'logs', 'stream.log');

function locations(): BinaryLocations {
  return {
    envDir: process.env.WHISPER_SERVER_DIR,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
  };
}

export function sessionsRoot(): string {
  return path.join(userData, 'sessions');
}

export function createSessionDir(sessionId: string): string {
  const dir = path.join(sessionsRoot(), sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function currentAudioFiles(sessionId: string): string[] {
  try {
    return fs.readdirSync(path.join(sessionsRoot(), sessionId));
  } catch {
    return [];
  }
}

export function resolveLiveModelPath(): string | null {
  // Imported lazily to avoid a cycle: whisperRuntime owns the model manager.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
  const { modelManager } = require('./whisperRuntime') as typeof import('./whisperRuntime');
  return modelManager.getModelPath(getSettings().liveModelId);
}

function spawnStream(binary: string, args: string[], cwd: string): StreamProcess {
  const child = spawn(binary, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    pid: child.pid,
    stdout: child.stdout!,
    stderr: child.stderr!,
    onExit: (listener) => {
      let reported = false;
      const report = (code: number | null) => {
        if (!reported) {
          reported = true;
          listener(code);
        }
      };
      child.on('exit', (code) => report(code));
      child.on('error', (error) => {
        console.error('whisper-stream.exe process error:', error);
        report(null);
      });
    },
    kill: () => {
      child.kill();
    },
  };
}

export const streamEngine = new StreamEngine({
  resolveBinary: () => {
    const settings = getSettings();
    const backend = settings.forceCpu ? 'cpu' : 'vulkan';
    return resolveStreamBinary(backend, locations(), fs.existsSync) ?? resolveStreamBinary('cpu', locations(), fs.existsSync);
  },
  spawnStream,
  writeLog: (lines) => {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, `${lines.join('\n')}\n`);
    } catch (error) {
      console.error('Failed to write the live transcription log:', error);
    }
  },
  now: Date.now,
});

export async function startLiveEngine(args: { sessionId: string; captureId: number | null }): Promise<void> {
  const settings = getSettings();
  const modelPath = resolveLiveModelPath();
  if (!modelPath) {
    throw new Error(`Live model ${settings.liveModelId} is not installed`);
  }
  const cwd = createSessionDir(args.sessionId);
  await streamEngine.start({
    modelPath,
    language: settings.language,
    captureId: args.captureId,
    forceCpu: settings.forceCpu,
    cwd,
    threads: Math.max(2, Math.min(8, os.cpus().length - 2)),
  });
}

export function stopLiveEngine(): void {
  streamEngine.stop();
}
```

Note: `getSettings().liveModelId` and `.language` are added in Task 11. Until then, add them to `Settings` and the `getSettings()` return in `settingsService.ts` now (defaults `'ggml-base.en.bin'` and `'en'`) so this compiles; Task 11 adds the rest of the keys and the UI.

- [ ] **Step 6: Write the dev probe**

Create `scripts/stream-probe.js` — a harness that exercises the engine outside Electron, so live transcription can be proven before any UI exists:

```js
// Usage: npm run stream:probe -- <model path> [capture id]
// Speaks segments to stdout as you talk. Ctrl+C to stop.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StreamEngine } = require('../dist/services/streamEngine');
const { resolveStreamBinary } = require('../dist/services/serverPaths');

const modelPath = process.argv[2];
const captureId = process.argv[3] === undefined ? null : Number(process.argv[3]);
if (!modelPath || !fs.existsSync(modelPath)) {
  console.error('usage: npm run stream:probe -- <path to ggml model> [capture id]');
  process.exit(2);
}

const repo = path.join(__dirname, '..');
const locations = { resourcesPath: repo, appPath: repo, isPackaged: false };
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-probe-'));

const engine = new StreamEngine({
  resolveBinary: () => resolveStreamBinary('cpu', locations, fs.existsSync),
  spawnStream: (binary, args, dir) => {
    const child = spawn(binary, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    return {
      pid: child.pid,
      stdout: child.stdout,
      stderr: child.stderr,
      onExit: (l) => child.on('exit', l),
      kill: () => child.kill(),
    };
  },
  writeLog: () => {},
  now: Date.now,
});

engine.onStatus((s) => console.error(`[state] ${s.state}${s.message ? ': ' + s.message : ''}`));
engine.onSegment((s) => console.log(`${(s.atMs / 1000).toFixed(1)}s  ${s.text}`));

engine
  .start({ modelPath, language: 'en', captureId, forceCpu: true, cwd, threads: 4 })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

process.on('SIGINT', () => {
  engine.stop();
  console.error(`\nsession audio left in ${cwd}`);
  process.exit(0);
});
```

Add to `package.json` scripts, after `whisper:fetch`:

```json
    "stream:probe": "node scripts/stream-probe.js",
```

- [ ] **Step 7: Verify — the first real milestone**

```bash
npm run build && npm test && npm run lint
ls "$APPDATA/Dark-Whisper/models" | head
npm run stream:probe -- "$APPDATA/Dark-Whisper/models/ggml-base.en.bin"
```

Expected: `[state] starting` then `[state] listening`, and **speaking into the microphone prints timestamped lines of text**. Press Ctrl+C; the printed session directory contains a `.wav` and `live.txt`.

If `base.en` is not installed, download it first in the app's Models screen (or transcribe with `tiny.en` for the probe). If no text appears while `listening`, try `npm run stream:probe -- <model> 0` (and other indices) — the device list is printed as `[state]` lines on stderr.

Report the probe's output in the task report: it is the evidence that the live engine works.

- [ ] **Step 8: Checkpoint (no commit)**

Run: `git status --short`.

---

### Task 6: The vault document store

**Files:**
- Create: `src/services/documentStore.ts`
- Test: `src/__tests__/documentStore.test.ts`

**Interfaces:**
- Consumes: nothing (Node `fs`/`crypto` only; no Electron).
- Produces:
  - `interface Frontmatter { title: string; created: string; updated: string; duration: number; language: string; liveModel: string; refineModel: string; app: string }`
  - `interface BlockRef { index: number; startSec: number; endSec: number }`
  - `interface DocumentSummary { file: string; title: string; created: string }`
  - `interface SearchHit { file: string; line: number; text: string }`
  - `type ReplaceOutcome = 'replaced' | 'skipped-edited' | 'missing'`
  - `blockMarker(block: BlockRef): string`, `formatFrontmatter(fm: Frontmatter): string`, `parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string }`, `hashText(text: string): string`, `slugify(title: string): string`
  - `class DocumentStore` with `constructor(vaultPath: string)`, `createDocument(id: string, fm: Frontmatter): string`, `appendSegment(file: string, text: string): void`, `appendLine(file: string, line: string): void`, `openBlock(file: string, block: BlockRef, heading?: string): void`, `readBlockText(file: string, index: number): string | null`, `replaceBlock(file: string, index: number, text: string, expectedHash: string): ReplaceOutcome`, `updateFrontmatter(file: string, patch: Partial<Frontmatter>): void`, `listDocuments(): DocumentSummary[]`, `search(query: string): SearchHit[]`, `renameDocument(file: string, title: string): string`, `deleteDocument(file: string): void`, `fileHash(file: string): string`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/documentStore.test.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DocumentStore, Frontmatter, blockMarker, hashText, parseFrontmatter, slugify } from '../services/documentStore';

const FM: Frontmatter = {
  title: 'untitled',
  created: '2026-09-15T14:32:04Z',
  updated: '2026-09-15T14:32:04Z',
  duration: 0,
  language: 'en',
  liveModel: 'ggml-base.en.bin',
  refineModel: 'ggml-large-v3-turbo-q5_0.bin',
  app: 'dark-whisper 1.2.0',
};

describe('documentStore helpers', () => {
  it('formats block markers exactly as the spec requires', () => {
    expect(blockMarker({ index: 3, startSec: 240, endSec: 360 })).toBe('<!-- dw:block 3 t=240-360 -->');
  });

  it('round-trips frontmatter', () => {
    const parsed = parseFrontmatter('---\ntitle: hello\nduration: 12\n---\n\nbody text\n');
    expect(parsed.frontmatter).toEqual({ title: 'hello', duration: '12' });
    expect(parsed.body.trim()).toBe('body text');
  });

  it('treats a file without frontmatter as all body', () => {
    expect(parseFrontmatter('just text').frontmatter).toEqual({});
    expect(parseFrontmatter('just text').body).toBe('just text');
  });

  it('slugifies titles for filenames', () => {
    expect(slugify('Board meeting: Q3 results!')).toBe('board-meeting-q3-results');
    expect(slugify('   ')).toBe('untitled');
  });
});

describe('DocumentStore', () => {
  let vault: string;
  let store: DocumentStore;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-vault-'));
    store = new DocumentStore(vault);
  });

  afterEach(() => fs.rmSync(vault, { recursive: true, force: true }));

  it('creates a document with frontmatter', () => {
    const file = store.createDocument('2026-09-15-1432', FM);
    expect(file).toBe(path.join(vault, '2026-09-15-1432-untitled.md'));
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('title: untitled');
    expect(content).toContain('liveModel: ggml-base.en.bin');
  });

  it('appends segments and blocks in order', () => {
    const file = store.createDocument('s1', FM);
    store.openBlock(file, { index: 1, startSec: 0, endSec: 120 });
    store.appendSegment(file, 'hello world');
    store.appendSegment(file, 'second segment');
    store.openBlock(file, { index: 2, startSec: 120, endSec: 240 });
    store.appendSegment(file, 'third segment');

    expect(store.readBlockText(file, 1)).toBe('hello world second segment');
    expect(store.readBlockText(file, 2)).toBe('third segment');
    expect(store.readBlockText(file, 3)).toBeNull();
  });

  it('writes an optional timestamp heading', () => {
    const file = store.createDocument('s1', FM);
    store.openBlock(file, { index: 2, startSec: 120, endSec: 240 }, '## 00:02:00');
    expect(fs.readFileSync(file, 'utf8')).toContain('## 00:02:00');
  });

  it('replaces a block when the text is untouched', () => {
    const file = store.createDocument('s1', FM);
    store.openBlock(file, { index: 1, startSec: 0, endSec: 120 });
    store.appendSegment(file, 'rough live text');
    const hash = hashText(store.readBlockText(file, 1)!);

    expect(store.replaceBlock(file, 1, 'Polished refined text.', hash)).toBe('replaced');
    expect(store.readBlockText(file, 1)).toBe('Polished refined text.');
  });

  it('refuses to replace a block the user edited', () => {
    const file = store.createDocument('s1', FM);
    store.openBlock(file, { index: 1, startSec: 0, endSec: 120 });
    store.appendSegment(file, 'rough live text');
    const staleHash = hashText('something else entirely');

    expect(store.replaceBlock(file, 1, 'Polished.', staleHash)).toBe('skipped-edited');
    expect(store.readBlockText(file, 1)).toBe('rough live text');
  });

  it('reports a missing block', () => {
    const file = store.createDocument('s1', FM);
    expect(store.replaceBlock(file, 7, 'x', hashText(''))).toBe('missing');
  });

  it('keeps later blocks intact when replacing an earlier one', () => {
    const file = store.createDocument('s1', FM);
    store.openBlock(file, { index: 1, startSec: 0, endSec: 120 });
    store.appendSegment(file, 'block one');
    store.openBlock(file, { index: 2, startSec: 120, endSec: 240 });
    store.appendSegment(file, 'block two');

    store.replaceBlock(file, 1, 'BLOCK ONE REFINED', hashText('block one'));
    expect(store.readBlockText(file, 1)).toBe('BLOCK ONE REFINED');
    expect(store.readBlockText(file, 2)).toBe('block two');
  });

  it('updates frontmatter without touching the body', () => {
    const file = store.createDocument('s1', FM);
    store.openBlock(file, { index: 1, startSec: 0, endSec: 120 });
    store.appendSegment(file, 'body stays');
    store.updateFrontmatter(file, { duration: 97, title: 'Board meeting' });

    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('duration: 97');
    expect(content).toContain('title: Board meeting');
    expect(store.readBlockText(file, 1)).toBe('body stays');
  });

  it('lists documents including subfolders', () => {
    fs.mkdirSync(path.join(vault, 'projects'));
    const a = store.createDocument('s1', FM);
    fs.writeFileSync(path.join(vault, 'projects', 'nested.md'), '---\ntitle: nested\ncreated: 2026-01-01T00:00:00Z\n---\n\ntext\n');

    const titles = store.listDocuments().map((d) => d.title).sort();
    expect(titles).toEqual(['nested', 'untitled']);
    expect(store.listDocuments().some((d) => d.file === a)).toBe(true);
  });

  it('searches document contents case-insensitively', () => {
    const file = store.createDocument('s1', FM);
    store.openBlock(file, { index: 1, startSec: 0, endSec: 120 });
    store.appendSegment(file, 'The Quarterly Review went well');

    const hits = store.search('quarterly');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file, text: expect.stringContaining('Quarterly Review') });
    expect(store.search('nothing here')).toEqual([]);
  });

  it('renames a document and its file', () => {
    const file = store.createDocument('2026-09-15-1432', FM);
    const renamed = store.renameDocument(file, 'Board meeting');
    expect(path.basename(renamed)).toBe('2026-09-15-1432-board-meeting.md');
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(renamed, 'utf8')).toContain('title: Board meeting');
  });

  it('avoids clobbering an existing filename on rename', () => {
    const first = store.createDocument('2026-09-15-1432', FM);
    fs.writeFileSync(path.join(vault, '2026-09-15-1432-notes.md'), 'x');
    expect(path.basename(store.renameDocument(first, 'notes'))).toBe('2026-09-15-1432-notes-2.md');
  });

  it('deletes a document', () => {
    const file = store.createDocument('s1', FM);
    store.deleteDocument(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('hashes the whole file so outside edits can be detected', () => {
    const file = store.createDocument('s1', FM);
    const before = store.fileHash(file);
    expect(store.fileHash(file)).toBe(before);

    store.appendSegment(file, 'our own write');
    const afterOurs = store.fileHash(file);
    expect(afterOurs).not.toBe(before);

    fs.appendFileSync(file, 'someone edited this in Obsidian\n');
    expect(store.fileHash(file)).not.toBe(afterOurs);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/documentStore.test.ts`
Expected: FAIL — `Cannot find module '../services/documentStore'`.

- [ ] **Step 3: Write the implementation**

Create `src/services/documentStore.ts`:

```ts
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface Frontmatter {
  title: string;
  created: string;
  updated: string;
  duration: number;
  language: string;
  liveModel: string;
  refineModel: string;
  app: string;
}

export interface BlockRef {
  index: number;
  startSec: number;
  endSec: number;
}

export interface DocumentSummary {
  file: string;
  title: string;
  created: string;
}

export interface SearchHit {
  file: string;
  line: number;
  text: string;
}

export type ReplaceOutcome = 'replaced' | 'skipped-edited' | 'missing';

export function blockMarker(block: BlockRef): string {
  return `<!-- dw:block ${block.index} t=${block.startSec}-${block.endSec} -->`;
}

export function formatFrontmatter(fm: Frontmatter): string {
  const lines = Object.entries(fm).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

export function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  if (!content.startsWith('---\n')) {
    return { frontmatter: {}, body: content };
  }
  const end = content.indexOf('\n---', 4);
  if (end === -1) {
    return { frontmatter: {}, body: content };
  }
  const frontmatter: Record<string, string> = {};
  for (const line of content.slice(4, end).split('\n')) {
    const separator = line.indexOf(':');
    if (separator > 0) {
      frontmatter[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }
  return { frontmatter, body: content.slice(end + 4).replace(/^\n+/, '') };
}

export function hashText(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex');
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'untitled';
}

const BLOCK_LINE = /^<!-- dw:block (\d+) t=(\d+)-(\d+) -->$/;

export class DocumentStore {
  constructor(private readonly vaultPath: string) {}

  private read(file: string): string {
    return fs.readFileSync(file, 'utf8');
  }

  private write(file: string, content: string): void {
    fs.writeFileSync(file, content);
  }

  createDocument(id: string, fm: Frontmatter): string {
    fs.mkdirSync(this.vaultPath, { recursive: true });
    const file = path.join(this.vaultPath, `${id}-${slugify(fm.title)}.md`);
    this.write(file, `${formatFrontmatter(fm)}\n`);
    return file;
  }

  appendLine(file: string, line: string): void {
    const content = this.read(file);
    const separator = content.endsWith('\n') ? '' : '\n';
    this.write(file, `${content}${separator}${line}\n`);
  }

  openBlock(file: string, block: BlockRef, heading?: string): void {
    this.appendLine(file, `\n${blockMarker(block)}`);
    if (heading) {
      this.appendLine(file, heading);
    }
  }

  // Segments join with a space so a block reads as prose, not one line per utterance.
  appendSegment(file: string, text: string): void {
    const content = this.read(file);
    const trimmed = content.replace(/\s+$/, '');
    const lastLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1);
    const continuing = lastLine.length > 0 && !lastLine.startsWith('<!--') && !lastLine.startsWith('#');
    this.write(file, `${trimmed}${continuing ? ' ' : '\n'}${text.trim()}\n`);
  }

  private blockBounds(file: string, index: number): { startLine: number; endLine: number; lines: string[] } | null {
    const lines = this.read(file).split('\n');
    const startLine = lines.findIndex((line) => {
      const match = BLOCK_LINE.exec(line.trim());
      return match !== null && Number(match[1]) === index;
    });
    if (startLine === -1) return null;
    let endLine = lines.length;
    for (let i = startLine + 1; i < lines.length; i++) {
      if (BLOCK_LINE.test(lines[i].trim())) {
        endLine = i;
        break;
      }
    }
    return { startLine, endLine, lines };
  }

  readBlockText(file: string, index: number): string | null {
    const bounds = this.blockBounds(file, index);
    if (!bounds) return null;
    return bounds.lines
      .slice(bounds.startLine + 1, bounds.endLine)
      .filter((line) => !line.trim().startsWith('#') && line.trim() !== '<!-- dw:gap -->')
      .join('\n')
      .trim();
  }

  replaceBlock(file: string, index: number, text: string, expectedHash: string): ReplaceOutcome {
    const bounds = this.blockBounds(file, index);
    if (!bounds) return 'missing';
    const current = this.readBlockText(file, index) ?? '';
    if (hashText(current) !== expectedHash) return 'skipped-edited';

    const headings = bounds.lines
      .slice(bounds.startLine + 1, bounds.endLine)
      .filter((line) => line.trim().startsWith('#'));
    const replacement = [...headings, text.trim(), ''];
    const next = [...bounds.lines.slice(0, bounds.startLine + 1), ...replacement, ...bounds.lines.slice(bounds.endLine)];
    this.write(file, next.join('\n'));
    return 'replaced';
  }

  updateFrontmatter(file: string, patch: Partial<Frontmatter>): void {
    const { frontmatter, body } = parseFrontmatter(this.read(file));
    for (const [key, value] of Object.entries(patch)) {
      frontmatter[key] = String(value);
    }
    const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`);
    this.write(file, `---\n${lines.join('\n')}\n---\n\n${body}`);
  }

  private markdownFiles(dir = this.vaultPath): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...this.markdownFiles(full));
      else if (entry.name.toLowerCase().endsWith('.md')) files.push(full);
    }
    return files;
  }

  listDocuments(): DocumentSummary[] {
    return this.markdownFiles().map((file) => {
      const { frontmatter } = parseFrontmatter(this.read(file));
      return {
        file,
        title: frontmatter.title ?? path.basename(file, '.md'),
        created: frontmatter.created ?? '',
      };
    });
  }

  search(query: string): SearchHit[] {
    const needle = query.toLowerCase();
    if (needle.length === 0) return [];
    const hits: SearchHit[] = [];
    for (const file of this.markdownFiles()) {
      this.read(file)
        .split('\n')
        .forEach((text, i) => {
          if (text.toLowerCase().includes(needle)) {
            hits.push({ file, line: i + 1, text: text.trim() });
          }
        });
    }
    return hits;
  }

  renameDocument(file: string, title: string): string {
    const dir = path.dirname(file);
    const prefix = path.basename(file, '.md').split('-').slice(0, 4).join('-');
    let target = path.join(dir, `${prefix}-${slugify(title)}.md`);
    let attempt = 2;
    while (fs.existsSync(target) && target !== file) {
      target = path.join(dir, `${prefix}-${slugify(title)}-${attempt}.md`);
      attempt++;
    }
    if (target !== file) fs.renameSync(file, target);
    this.updateFrontmatter(target, { title });
    return target;
  }

  deleteDocument(file: string): void {
    fs.rmSync(file, { force: true });
  }

  // Lets callers notice an edit made outside the app between two of our own writes.
  fileHash(file: string): string {
    try {
      return hashText(this.read(file));
    } catch {
      return '';
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/documentStore.test.ts`
Expected: PASS (18 tests). Then `npm run build && npm run lint`.

- [ ] **Step 5: Checkpoint (no commit)**

Run: `git status --short`.

---

### Task 7: Block audio maths

**Files:**
- Create: `src/services/blockMath.ts`
- Test: `src/__tests__/blockMath.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `const BYTES_PER_SECOND = 32_000`, `const WAV_HEADER_BYTES = 44`
  - `interface AudioEntry { file: string; startSec: number; durationSec: number }`
  - `interface AudioSlice { file: string; startByte: number; endByte: number }`
  - `blockRange(index: number, blockMinutes: number): { startSec: number; endSec: number }`
  - `slicesForRange(manifest: AudioEntry[], startSec: number, endSec: number): AudioSlice[]`
  - `wavHeader(dataBytes: number): Buffer`
  - `formatTimestampHeading(startSec: number): string`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/blockMath.test.ts`:

```ts
import {
  blockRange,
  slicesForRange,
  wavHeader,
  formatTimestampHeading,
  BYTES_PER_SECOND,
  WAV_HEADER_BYTES,
} from '../services/blockMath';

describe('blockRange', () => {
  it('maps 1-based block indices onto the audio clock', () => {
    expect(blockRange(1, 2)).toEqual({ startSec: 0, endSec: 120 });
    expect(blockRange(3, 2)).toEqual({ startSec: 240, endSec: 360 });
    expect(blockRange(1, 5)).toEqual({ startSec: 0, endSec: 300 });
  });
});

describe('formatTimestampHeading', () => {
  it('formats hours, minutes and seconds', () => {
    expect(formatTimestampHeading(0)).toBe('## 00:00:00');
    expect(formatTimestampHeading(3725)).toBe('## 01:02:05');
  });
});

describe('slicesForRange', () => {
  const single = [{ file: 'a.wav', startSec: 0, durationSec: 600 }];

  it('slices inside one file, allowing for the WAV header', () => {
    expect(slicesForRange(single, 120, 240)).toEqual([
      { file: 'a.wav', startByte: WAV_HEADER_BYTES + 120 * BYTES_PER_SECOND, endByte: WAV_HEADER_BYTES + 240 * BYTES_PER_SECOND },
    ]);
  });

  it('clamps to the audio that exists', () => {
    expect(slicesForRange(single, 540, 720)).toEqual([
      { file: 'a.wav', startByte: WAV_HEADER_BYTES + 540 * BYTES_PER_SECOND, endByte: WAV_HEADER_BYTES + 600 * BYTES_PER_SECOND },
    ]);
  });

  it('spans a restart across two files', () => {
    const manifest = [
      { file: 'a.wav', startSec: 0, durationSec: 100 },
      { file: 'b.wav', startSec: 110, durationSec: 200 },
    ];
    expect(slicesForRange(manifest, 90, 130)).toEqual([
      { file: 'a.wav', startByte: WAV_HEADER_BYTES + 90 * BYTES_PER_SECOND, endByte: WAV_HEADER_BYTES + 100 * BYTES_PER_SECOND },
      { file: 'b.wav', startByte: WAV_HEADER_BYTES, endByte: WAV_HEADER_BYTES + 20 * BYTES_PER_SECOND },
    ]);
  });

  it('returns nothing for a range that falls in a gap', () => {
    const manifest = [
      { file: 'a.wav', startSec: 0, durationSec: 100 },
      { file: 'b.wav', startSec: 110, durationSec: 200 },
    ];
    expect(slicesForRange(manifest, 101, 109)).toEqual([]);
    expect(slicesForRange([], 0, 120)).toEqual([]);
  });

  it('keeps byte offsets on 16-bit sample boundaries', () => {
    const [slice] = slicesForRange(single, 0.5001, 1.0001);
    expect((slice.startByte - WAV_HEADER_BYTES) % 2).toBe(0);
    expect((slice.endByte - WAV_HEADER_BYTES) % 2).toBe(0);
  });
});

describe('wavHeader', () => {
  it('describes 16 kHz mono 16-bit PCM', () => {
    const header = wavHeader(32_000);
    expect(header).toHaveLength(WAV_HEADER_BYTES);
    expect(header.toString('ascii', 0, 4)).toBe('RIFF');
    expect(header.toString('ascii', 8, 12)).toBe('WAVE');
    expect(header.readUInt32LE(4)).toBe(36 + 32_000);
    expect(header.readUInt16LE(22)).toBe(1); // channels
    expect(header.readUInt32LE(24)).toBe(16_000); // sample rate
    expect(header.readUInt16LE(34)).toBe(16); // bits per sample
    expect(header.readUInt32LE(40)).toBe(32_000); // data size
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/blockMath.test.ts`
Expected: FAIL — `Cannot find module '../services/blockMath'`.

- [ ] **Step 3: Write the implementation**

Create `src/services/blockMath.ts`:

```ts
// whisper-stream.exe --save-audio writes 16 kHz, 16-bit, mono PCM: 32 000 bytes per second.
export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SAMPLE = 2;
export const BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE;
export const WAV_HEADER_BYTES = 44;

export interface AudioEntry {
  file: string;
  startSec: number;
  durationSec: number;
}

export interface AudioSlice {
  file: string;
  startByte: number;
  endByte: number;
}

export function blockRange(index: number, blockMinutes: number): { startSec: number; endSec: number } {
  const length = blockMinutes * 60;
  return { startSec: (index - 1) * length, endSec: index * length };
}

export function formatTimestampHeading(startSec: number): string {
  const total = Math.floor(startSec);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `## ${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function alignToSample(bytes: number): number {
  return Math.floor(bytes / BYTES_PER_SAMPLE) * BYTES_PER_SAMPLE;
}

export function slicesForRange(manifest: AudioEntry[], startSec: number, endSec: number): AudioSlice[] {
  const slices: AudioSlice[] = [];
  for (const entry of manifest) {
    const entryEnd = entry.startSec + entry.durationSec;
    const from = Math.max(startSec, entry.startSec);
    const to = Math.min(endSec, entryEnd);
    if (to <= from) continue;
    slices.push({
      file: entry.file,
      startByte: WAV_HEADER_BYTES + alignToSample((from - entry.startSec) * BYTES_PER_SECOND),
      endByte: WAV_HEADER_BYTES + alignToSample((to - entry.startSec) * BYTES_PER_SECOND),
    });
  }
  return slices;
}

export function wavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28); // byte rate
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/blockMath.test.ts`
Expected: PASS (9 tests). Then `npm run build && npm run lint`.

- [ ] **Step 5: Checkpoint (no commit)**

Run: `git status --short`.

---

### Task 8: Session orchestration

**Files:**
- Create: `src/services/sessionService.ts`
- Test: `src/__tests__/sessionService.test.ts`

**Interfaces:**
- Consumes (Tasks 6-7): `ReplaceOutcome`, `BlockRef`, `hashText`; `blockRange`, `formatTimestampHeading`.
- Produces:
  - `type SessionState = 'recording' | 'paused' | 'stopped'`
  - `interface RefineJob { blockIndex: number; startSec: number; endSec: number; hash: string }`
  - `interface SessionInfo { id: string; documentPath: string; state: SessionState; blockIndex: number; durationSec: number }`
  - `interface SessionStoreLike { openBlock(file: string, block: BlockRef, heading?: string): void; appendSegment(file: string, text: string): void; appendLine(file: string, line: string): void; readBlockText(file: string, index: number): string | null; replaceBlock(file: string, index: number, text: string, expectedHash: string): ReplaceOutcome; updateFrontmatter(file: string, patch: { duration: number }): void }`
  - `interface SessionDeps { store: SessionStoreLike; enqueueRefine(job: RefineJob): void; blockMinutes: number; timestampHeadings: boolean }`
  - `class SessionService` with `begin(args: { id: string; documentPath: string }): void`, `segment(s: { text: string; atMs: number }): void`, `launch(l: { atMs: number }): void`, `setPaused(paused: boolean): void`, `end(): void`, `applyRefinement(blockIndex: number, text: string): ReplaceOutcome`, `getInfo(): SessionInfo`, `onInfo(listener: (info: SessionInfo) => void): () => void`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/sessionService.test.ts`:

```ts
import { SessionService, SessionStoreLike, RefineJob } from '../services/sessionService';
import { hashText } from '../services/documentStore';

function fakeStore() {
  const blocks = new Map<number, string>();
  const lines: string[] = [];
  const headings: (string | undefined)[] = [];
  let duration = 0;
  const store: SessionStoreLike = {
    openBlock: (_file, block, heading) => {
      blocks.set(block.index, '');
      headings.push(heading);
    },
    appendSegment: (_file, text) => {
      const current = [...blocks.keys()].pop() ?? 1;
      blocks.set(current, `${blocks.get(current) ?? ''}${blocks.get(current) ? ' ' : ''}${text}`);
    },
    appendLine: (_file, line) => lines.push(line),
    readBlockText: (_file, index) => blocks.get(index) ?? null,
    replaceBlock: (_file, index, text, expectedHash) => {
      const current = blocks.get(index);
      if (current === undefined) return 'missing';
      if (hashText(current) !== expectedHash) return 'skipped-edited';
      blocks.set(index, text);
      return 'replaced';
    },
    updateFrontmatter: (_file, patch) => {
      duration = patch.duration;
    },
  };
  return { store, blocks, lines, headings, getDuration: () => duration };
}

function setup(overrides: { blockMinutes?: number; timestampHeadings?: boolean } = {}) {
  const fake = fakeStore();
  const jobs: RefineJob[] = [];
  const service = new SessionService({
    store: fake.store,
    enqueueRefine: (job) => jobs.push(job),
    blockMinutes: overrides.blockMinutes ?? 2,
    timestampHeadings: overrides.timestampHeadings ?? false,
  });
  service.begin({ id: 's1', documentPath: 'C:/vault/s1.md' });
  return { service, jobs, ...fake };
}

describe('SessionService', () => {
  it('opens the first block and reports recording', () => {
    const ctx = setup();
    expect(ctx.service.getInfo()).toEqual({
      id: 's1',
      documentPath: 'C:/vault/s1.md',
      state: 'recording',
      blockIndex: 1,
      durationSec: 0,
    });
    expect(ctx.blocks.has(1)).toBe(true);
  });

  it('appends segments and tracks duration', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'hello', atMs: 1_000 });
    ctx.service.segment({ text: 'world', atMs: 4_500 });
    expect(ctx.blocks.get(1)).toBe('hello world');
    expect(ctx.service.getInfo().durationSec).toBe(4.5);
  });

  it('closes a block at the boundary and queues it for refinement', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'first block', atMs: 10_000 });
    ctx.service.segment({ text: 'second block', atMs: 121_000 });

    expect(ctx.jobs).toEqual([
      { blockIndex: 1, startSec: 0, endSec: 120, hash: hashText('first block') },
    ]);
    expect(ctx.blocks.get(1)).toBe('first block');
    expect(ctx.blocks.get(2)).toBe('second block');
    expect(ctx.service.getInfo().blockIndex).toBe(2);
  });

  it('skips empty blocks when someone is silent for minutes', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'talking again', atMs: 400_000 });
    expect(ctx.jobs).toEqual([]);
    expect(ctx.service.getInfo().blockIndex).toBe(4);
    expect(ctx.blocks.get(4)).toBe('talking again');
  });

  it('writes timestamp headings when enabled', () => {
    const ctx = setup({ timestampHeadings: true });
    ctx.service.segment({ text: 'x', atMs: 121_000 });
    expect(ctx.headings).toEqual(['## 00:00:00', '## 00:02:00']);
  });

  it('marks an interruption when the engine relaunches', () => {
    const ctx = setup();
    ctx.service.launch({ atMs: 0 });
    ctx.service.launch({ atMs: 65_000 });
    expect(ctx.lines).toEqual(['<!-- dw:gap -->', '*(recording interrupted and resumed)*']);
  });

  it('ignores segments while paused', () => {
    const ctx = setup();
    ctx.service.setPaused(true);
    expect(ctx.service.getInfo().state).toBe('paused');
    ctx.service.segment({ text: 'muted words', atMs: 5_000 });
    ctx.service.setPaused(false);
    ctx.service.segment({ text: 'heard this', atMs: 6_000 });
    expect(ctx.blocks.get(1)).toBe('heard this');
  });

  it('queues the final partial block and records duration on end', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'a bit of speech', atMs: 30_000 });
    ctx.service.end();

    expect(ctx.jobs).toEqual([{ blockIndex: 1, startSec: 0, endSec: 30, hash: hashText('a bit of speech') }]);
    expect(ctx.getDuration()).toBe(30);
    expect(ctx.service.getInfo().state).toBe('stopped');
  });

  it('does not queue an empty final block, and end is idempotent', () => {
    const ctx = setup();
    ctx.service.end();
    ctx.service.end();
    expect(ctx.jobs).toEqual([]);
  });

  it('applies refinement through the recorded hash', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'rough text', atMs: 10_000 });
    ctx.service.end();

    expect(ctx.service.applyRefinement(1, 'Polished text.')).toBe('replaced');
    expect(ctx.blocks.get(1)).toBe('Polished text.');
  });

  it('reports a skipped refinement when the block was edited', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'rough text', atMs: 10_000 });
    ctx.service.end();
    ctx.blocks.set(1, 'the user rewrote this');

    expect(ctx.service.applyRefinement(1, 'Polished text.')).toBe('skipped-edited');
    expect(ctx.blocks.get(1)).toBe('the user rewrote this');
  });

  it('notifies listeners on every state change', () => {
    const ctx = setup();
    const states: string[] = [];
    ctx.service.onInfo((info) => states.push(info.state));
    ctx.service.setPaused(true);
    ctx.service.setPaused(false);
    ctx.service.end();
    expect(states).toEqual(['paused', 'recording', 'stopped']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/sessionService.test.ts`
Expected: FAIL — `Cannot find module '../services/sessionService'`.

- [ ] **Step 3: Write the implementation**

Create `src/services/sessionService.ts`:

```ts
import { blockRange, formatTimestampHeading } from './blockMath';
import { BlockRef, hashText, ReplaceOutcome } from './documentStore';

export type SessionState = 'recording' | 'paused' | 'stopped';

export interface RefineJob {
  blockIndex: number;
  startSec: number;
  endSec: number;
  hash: string;
}

export interface SessionInfo {
  id: string;
  documentPath: string;
  state: SessionState;
  blockIndex: number;
  durationSec: number;
}

export interface SessionStoreLike {
  openBlock(file: string, block: BlockRef, heading?: string): void;
  appendSegment(file: string, text: string): void;
  appendLine(file: string, line: string): void;
  readBlockText(file: string, index: number): string | null;
  replaceBlock(file: string, index: number, text: string, expectedHash: string): ReplaceOutcome;
  updateFrontmatter(file: string, patch: { duration: number }): void;
}

export interface SessionDeps {
  store: SessionStoreLike;
  enqueueRefine(job: RefineJob): void;
  blockMinutes: number;
  timestampHeadings: boolean;
}

export class SessionService {
  private info: SessionInfo = { id: '', documentPath: '', state: 'stopped', blockIndex: 0, durationSec: 0 };
  private readonly listeners = new Set<(info: SessionInfo) => void>();
  private readonly hashes = new Map<number, string>();
  private launches = 0;

  constructor(private readonly deps: SessionDeps) {}

  getInfo(): SessionInfo {
    return { ...this.info };
  }

  onInfo(listener: (info: SessionInfo) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snapshot = this.getInfo();
    for (const l of this.listeners) l(snapshot);
  }

  begin(args: { id: string; documentPath: string }): void {
    this.hashes.clear();
    this.launches = 0;
    this.info = { id: args.id, documentPath: args.documentPath, state: 'recording', blockIndex: 1, durationSec: 0 };
    this.openBlock(1);
  }

  private openBlock(index: number): void {
    const range = blockRange(index, this.deps.blockMinutes);
    const block: BlockRef = { index, startSec: range.startSec, endSec: range.endSec };
    const heading = this.deps.timestampHeadings ? formatTimestampHeading(range.startSec) : undefined;
    this.deps.store.openBlock(this.info.documentPath, block, heading);
  }

  // A block with no speech in it has nothing to refine, so it is closed without a job.
  private closeBlock(index: number, endSec: number): void {
    const text = this.deps.store.readBlockText(this.info.documentPath, index) ?? '';
    if (text.trim().length === 0) return;
    const hash = hashText(text);
    this.hashes.set(index, hash);
    const range = blockRange(index, this.deps.blockMinutes);
    this.deps.enqueueRefine({ blockIndex: index, startSec: range.startSec, endSec, hash });
  }

  segment(s: { text: string; atMs: number }): void {
    if (this.info.state !== 'recording') return;
    const atSec = s.atMs / 1000;

    while (atSec >= blockRange(this.info.blockIndex, this.deps.blockMinutes).endSec) {
      const closing = this.info.blockIndex;
      this.closeBlock(closing, blockRange(closing, this.deps.blockMinutes).endSec);
      this.info = { ...this.info, blockIndex: closing + 1 };
      this.openBlock(this.info.blockIndex);
    }

    this.deps.store.appendSegment(this.info.documentPath, s.text);
    this.info = { ...this.info, durationSec: Math.max(this.info.durationSec, atSec) };
    this.emit();
  }

  launch(l: { atMs: number }): void {
    this.launches++;
    if (this.launches <= 1) return;
    this.deps.store.appendLine(this.info.documentPath, '<!-- dw:gap -->');
    this.deps.store.appendLine(this.info.documentPath, '*(recording interrupted and resumed)*');
  }

  setPaused(paused: boolean): void {
    if (this.info.state === 'stopped') return;
    const next: SessionState = paused ? 'paused' : 'recording';
    if (next === this.info.state) return;
    this.info = { ...this.info, state: next };
    this.emit();
  }

  end(): void {
    if (this.info.state === 'stopped') return;
    const duration = Math.round(this.info.durationSec);
    this.closeBlock(this.info.blockIndex, duration);
    this.deps.store.updateFrontmatter(this.info.documentPath, { duration });
    this.info = { ...this.info, state: 'stopped' };
    this.emit();
  }

  applyRefinement(blockIndex: number, text: string): ReplaceOutcome {
    const hash = this.hashes.get(blockIndex);
    if (hash === undefined) return 'missing';
    const outcome = this.deps.store.replaceBlock(this.info.documentPath, blockIndex, text, hash);
    if (outcome === 'replaced') {
      this.hashes.set(blockIndex, hashText(text));
    }
    return outcome;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/sessionService.test.ts`
Expected: PASS (12 tests). Then `npm run build && npm run lint`.

- [ ] **Step 5: Checkpoint (no commit)**

Run: `git status --short`.

---

### Task 9: Refinement queue

**Files:**
- Create: `src/services/blockRefiner.ts`
- Test: `src/__tests__/blockRefiner.test.ts`

**Interfaces:**
- Consumes (Task 8): `RefineJob`.
- Produces:
  - `const CONCURRENT_MODEL_BUDGET_BYTES = 2_147_483_648`
  - `type RefineMode = 'auto' | 'always' | 'afterStop'`
  - `shouldRefineDuringRecording(mode: RefineMode, liveModelBytes: number, refineModelBytes: number): boolean`
  - `type RefineEvent = { kind: 'started' | 'replaced' | 'skipped' | 'failed'; blockIndex: number; message?: string }`
  - `interface RefineDeps { sliceAudio(job: RefineJob): Promise<string | null>; transcribe(wavPath: string): Promise<string>; cleanup(wavPath: string): void; apply(blockIndex: number, text: string): 'replaced' | 'skipped-edited' | 'missing'; report(event: RefineEvent): void }`
  - `class RefineQueue` with `enqueue(job: RefineJob): void`, `setAllowed(allowed: boolean): void`, `pending(): number`, `isRunning(): boolean`, `drain(): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/blockRefiner.test.ts`:

```ts
import {
  RefineQueue,
  RefineDeps,
  RefineEvent,
  shouldRefineDuringRecording,
  CONCURRENT_MODEL_BUDGET_BYTES,
} from '../services/blockRefiner';
import { RefineJob } from '../services/sessionService';

const JOB: RefineJob = { blockIndex: 1, startSec: 0, endSec: 120, hash: 'abc' };

function setup(overrides: Partial<RefineDeps> = {}) {
  const events: RefineEvent[] = [];
  const cleaned: string[] = [];
  const deps: RefineDeps = {
    sliceAudio: jest.fn(async () => 'C:/tmp/block-1.wav'),
    transcribe: jest.fn(async () => 'refined text'),
    cleanup: (wav) => cleaned.push(wav),
    apply: jest.fn(() => 'replaced' as const),
    report: (event) => events.push(event),
    ...overrides,
  };
  return { queue: new RefineQueue(deps), deps, events, cleaned };
}

describe('shouldRefineDuringRecording', () => {
  it('always refines in always mode and never in afterStop mode', () => {
    expect(shouldRefineDuringRecording('always', 3e9, 3e9)).toBe(true);
    expect(shouldRefineDuringRecording('afterStop', 1, 1)).toBe(false);
  });

  it('auto refines only when both models fit the budget', () => {
    expect(CONCURRENT_MODEL_BUDGET_BYTES).toBe(2_147_483_648);
    expect(shouldRefineDuringRecording('auto', 150_000_000, 574_041_195)).toBe(true);
    expect(shouldRefineDuringRecording('auto', 150_000_000, 2_100_000_000)).toBe(false);
  });
});

describe('RefineQueue', () => {
  it('runs a job and applies the text', async () => {
    const ctx = setup();
    ctx.queue.enqueue(JOB);
    await ctx.queue.drain();

    expect(ctx.deps.sliceAudio).toHaveBeenCalledWith(JOB);
    expect(ctx.deps.transcribe).toHaveBeenCalledWith('C:/tmp/block-1.wav');
    expect(ctx.deps.apply).toHaveBeenCalledWith(1, 'refined text');
    expect(ctx.events).toEqual([
      { kind: 'started', blockIndex: 1 },
      { kind: 'replaced', blockIndex: 1 },
    ]);
    expect(ctx.cleaned).toEqual(['C:/tmp/block-1.wav']);
  });

  it('holds jobs while refinement is not allowed, then runs them in order', async () => {
    const ctx = setup();
    ctx.queue.setAllowed(false);
    ctx.queue.enqueue({ ...JOB, blockIndex: 1 });
    ctx.queue.enqueue({ ...JOB, blockIndex: 2 });
    expect(ctx.queue.pending()).toBe(2);
    expect(ctx.deps.sliceAudio).not.toHaveBeenCalled();

    ctx.queue.setAllowed(true);
    await ctx.queue.drain();
    expect(ctx.events.filter((e) => e.kind === 'replaced').map((e) => e.blockIndex)).toEqual([1, 2]);
  });

  it('skips a block whose audio is gone', async () => {
    const ctx = setup({ sliceAudio: jest.fn(async () => null) });
    ctx.queue.enqueue(JOB);
    await ctx.queue.drain();

    expect(ctx.deps.transcribe).not.toHaveBeenCalled();
    expect(ctx.events).toContainEqual({ kind: 'skipped', blockIndex: 1, message: 'no audio for this block' });
  });

  it('reports a skipped apply when the user edited the block', async () => {
    const ctx = setup({ apply: jest.fn(() => 'skipped-edited' as const) });
    ctx.queue.enqueue(JOB);
    await ctx.queue.drain();
    expect(ctx.events).toContainEqual({ kind: 'skipped', blockIndex: 1, message: 'block edited since transcription' });
  });

  it('retries once, then fails without stopping the queue', async () => {
    const transcribe = jest
      .fn<Promise<string>, [string]>()
      .mockRejectedValueOnce(new Error('server busy'))
      .mockResolvedValueOnce('second attempt worked');
    const ctx = setup({ transcribe });
    ctx.queue.enqueue(JOB);
    await ctx.queue.drain();
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(ctx.events).toContainEqual({ kind: 'replaced', blockIndex: 1 });

    const always = setup({ transcribe: jest.fn(async () => { throw new Error('still broken'); }) });
    always.queue.enqueue({ ...JOB, blockIndex: 4 });
    always.queue.enqueue({ ...JOB, blockIndex: 5 });
    await always.queue.drain();
    expect(always.events).toContainEqual({ kind: 'failed', blockIndex: 4, message: 'still broken' });
    expect(always.events.filter((e) => e.blockIndex === 5)).not.toHaveLength(0);
  });

  it('always cleans up the temporary slice, even on failure', async () => {
    const ctx = setup({ transcribe: jest.fn(async () => { throw new Error('boom'); }) });
    ctx.queue.enqueue(JOB);
    await ctx.queue.drain();
    expect(ctx.cleaned).toEqual(['C:/tmp/block-1.wav', 'C:/tmp/block-1.wav']);
  });

  it('reports pending and running state', async () => {
    const ctx = setup();
    expect(ctx.queue.isRunning()).toBe(false);
    ctx.queue.enqueue(JOB);
    expect(ctx.queue.isRunning()).toBe(true);
    await ctx.queue.drain();
    expect(ctx.queue.pending()).toBe(0);
    expect(ctx.queue.isRunning()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/blockRefiner.test.ts`
Expected: FAIL — `Cannot find module '../services/blockRefiner'`.

- [ ] **Step 3: Write the implementation**

Create `src/services/blockRefiner.ts`:

```ts
import { RefineJob } from './sessionService';

// A live model plus a refine model resident at once; above this, refinement waits for the session to end.
export const CONCURRENT_MODEL_BUDGET_BYTES = 2_147_483_648;

export type RefineMode = 'auto' | 'always' | 'afterStop';

export function shouldRefineDuringRecording(mode: RefineMode, liveModelBytes: number, refineModelBytes: number): boolean {
  if (mode === 'always') return true;
  if (mode === 'afterStop') return false;
  return liveModelBytes + refineModelBytes <= CONCURRENT_MODEL_BUDGET_BYTES;
}

export type RefineEvent = {
  kind: 'started' | 'replaced' | 'skipped' | 'failed';
  blockIndex: number;
  message?: string;
};

export interface RefineDeps {
  sliceAudio(job: RefineJob): Promise<string | null>;
  transcribe(wavPath: string): Promise<string>;
  cleanup(wavPath: string): void;
  apply(blockIndex: number, text: string): 'replaced' | 'skipped-edited' | 'missing';
  report(event: RefineEvent): void;
}

const MAX_ATTEMPTS = 2;

export class RefineQueue {
  private readonly jobs: RefineJob[] = [];
  private allowed = true;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: RefineDeps) {}

  enqueue(job: RefineJob): void {
    this.jobs.push(job);
    this.kick();
  }

  setAllowed(allowed: boolean): void {
    this.allowed = allowed;
    this.kick();
  }

  pending(): number {
    return this.jobs.length;
  }

  isRunning(): boolean {
    return this.running !== null || this.jobs.length > 0;
  }

  async drain(): Promise<void> {
    while (this.running) {
      await this.running;
    }
  }

  private kick(): void {
    if (!this.allowed || this.running || this.jobs.length === 0) return;
    this.running = this.run().finally(() => {
      this.running = null;
      // A job may have been queued while this one ran.
      this.kick();
    });
  }

  private async run(): Promise<void> {
    while (this.allowed && this.jobs.length > 0) {
      const job = this.jobs.shift()!;
      this.deps.report({ kind: 'started', blockIndex: job.blockIndex });
      await this.runJob(job);
    }
  }

  private async runJob(job: RefineJob): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let wavPath: string | null = null;
      try {
        wavPath = await this.deps.sliceAudio(job);
        if (wavPath === null) {
          this.deps.report({ kind: 'skipped', blockIndex: job.blockIndex, message: 'no audio for this block' });
          return;
        }
        const text = await this.deps.transcribe(wavPath);
        const outcome = this.deps.apply(job.blockIndex, text);
        if (outcome === 'replaced') {
          this.deps.report({ kind: 'replaced', blockIndex: job.blockIndex });
        } else if (outcome === 'skipped-edited') {
          this.deps.report({ kind: 'skipped', blockIndex: job.blockIndex, message: 'block edited since transcription' });
        } else {
          this.deps.report({ kind: 'skipped', blockIndex: job.blockIndex, message: 'block no longer in the document' });
        }
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === MAX_ATTEMPTS) {
          this.deps.report({ kind: 'failed', blockIndex: job.blockIndex, message });
        }
      } finally {
        if (wavPath !== null) this.deps.cleanup(wavPath);
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/blockRefiner.test.ts`
Expected: PASS (9 tests). Then `npm run build && npm run lint`.

- [ ] **Step 5: Checkpoint (no commit)**

Run: `git status --short`.

---

### Task 10: Microphone mute as pause

**Files:**
- Create: `src/services/micMuteOutput.ts`
- Create: `src/services/micMuteService.ts`
- Test: `src/__tests__/micMute.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `micMuteOutput.ts`: `parseMuteOutput(stdout: string): boolean | null`, `const MUTE_SHIM_SCRIPT: string`, `buildShimArgs(action: 'get' | 'mute' | 'unmute'): string[]`
  - `micMuteService.ts`: `interface MicMuteDeps { readMute(): Promise<boolean | null>; writeMute(muted: boolean): Promise<void>; pollMs: number }`, `class MicMuteService` with `start(): void`, `stop(): void`, `setMuted(muted: boolean): Promise<void>`, `isMuted(): boolean | null`, `onChange(listener: (muted: boolean) => void): () => void`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/micMute.test.ts`:

```ts
import { parseMuteOutput, buildShimArgs, MUTE_SHIM_SCRIPT } from '../services/micMuteOutput';
import { MicMuteService } from '../services/micMuteService';

describe('parseMuteOutput', () => {
  it('reads the shim contract', () => {
    expect(parseMuteOutput('muted:true\n')).toBe(true);
    expect(parseMuteOutput('muted:false')).toBe(false);
    expect(parseMuteOutput('  muted:TRUE  ')).toBe(true);
  });

  it('returns null for anything unexpected', () => {
    expect(parseMuteOutput('')).toBeNull();
    expect(parseMuteOutput('Exception calling GetMute')).toBeNull();
    expect(parseMuteOutput('muted:maybe')).toBeNull();
  });
});

describe('buildShimArgs', () => {
  it('passes the action to the inline PowerShell script', () => {
    const args = buildShimArgs('get');
    expect(args[0]).toBe('-NoProfile');
    expect(args).toContain('-Command');
    expect(args[args.length - 1]).toContain('get');
    expect(MUTE_SHIM_SCRIPT).toContain('IAudioEndpointVolume');
  });
});

describe('MicMuteService', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function setup(initial: boolean | null = false) {
    let current = initial;
    const deps = {
      readMute: jest.fn(async () => current),
      writeMute: jest.fn(async (muted: boolean) => {
        current = muted;
      }),
      pollMs: 1000,
    };
    const service = new MicMuteService(deps);
    const changes: boolean[] = [];
    service.onChange((muted) => changes.push(muted));
    return { service, deps, changes, set: (v: boolean | null) => (current = v) };
  }

  it('polls and reports the first reading', async () => {
    const ctx = setup(false);
    ctx.service.start();
    await jest.advanceTimersByTimeAsync(1000);
    expect(ctx.service.isMuted()).toBe(false);
    expect(ctx.changes).toEqual([false]);
  });

  it('reports only changes, not every poll', async () => {
    const ctx = setup(false);
    ctx.service.start();
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);
    ctx.set(true);
    await jest.advanceTimersByTimeAsync(1000);
    expect(ctx.changes).toEqual([false, true]);
  });

  it('setMuted writes through and reports immediately', async () => {
    const ctx = setup(false);
    await ctx.service.setMuted(true);
    expect(ctx.deps.writeMute).toHaveBeenCalledWith(true);
    expect(ctx.service.isMuted()).toBe(true);
    expect(ctx.changes).toEqual([true]);
  });

  it('treats an unreadable state as unknown and never reports it', async () => {
    const ctx = setup(null);
    ctx.service.start();
    await jest.advanceTimersByTimeAsync(3000);
    expect(ctx.service.isMuted()).toBeNull();
    expect(ctx.changes).toEqual([]);
  });

  it('stops polling on stop', async () => {
    const ctx = setup(false);
    ctx.service.start();
    await jest.advanceTimersByTimeAsync(1000);
    ctx.service.stop();
    ctx.set(true);
    await jest.advanceTimersByTimeAsync(5000);
    expect(ctx.changes).toEqual([false]);
    expect(ctx.deps.readMute).toHaveBeenCalledTimes(1);
  });

  it('survives a rejecting shim', async () => {
    const ctx = setup(false);
    ctx.deps.readMute.mockRejectedValueOnce(new Error('powershell missing'));
    ctx.service.start();
    await jest.advanceTimersByTimeAsync(2000);
    expect(ctx.changes).toEqual([false]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/micMute.test.ts`
Expected: FAIL — `Cannot find module '../services/micMuteOutput'`.

- [ ] **Step 3: Write `micMuteOutput.ts`**

```ts
// Reads or sets the mute flag on the default capture endpoint through Core Audio.
// Printed contract: exactly "muted:true" or "muted:false" on stdout.
export const MUTE_SHIM_SCRIPT = `
$ErrorActionPreference = 'Stop'
$action = $args[0]
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int NotImpl1();
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int NotImpl1(); int NotImpl2(); int NotImpl3(); int NotImpl4();
  int NotImpl5(); int NotImpl6(); int NotImpl7(); int NotImpl8();
  int NotImpl9(); int NotImpl10(); int NotImpl11(); int NotImpl12();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid eventContext);
  int GetMute(out bool mute);
}
public static class MicMute {
  public static bool Get() { return Volume().Item1; }
  public static void Set(bool mute) { var v = Volume(); v.Item2.SetMute(mute, Guid.Empty); }
  static Tuple<bool, IAudioEndpointVolume> Volume() {
    IMMDevice device;
    var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator() as object);
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(1, 1, out device));
    object o;
    var iid = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out o));
    var volume = (IAudioEndpointVolume)o;
    bool muted;
    Marshal.ThrowExceptionForHR(volume.GetMute(out muted));
    return Tuple.Create(muted, volume);
  }
}
'@
if ($action -eq 'get') { }
elseif ($action -eq 'mute') { [MicMute]::Set($true) }
elseif ($action -eq 'unmute') { [MicMute]::Set($false) }
Write-Output ("muted:" + [MicMute]::Get().ToString().ToLower())
`;

export function buildShimArgs(action: 'get' | 'mute' | 'unmute'): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', `& {${MUTE_SHIM_SCRIPT}} ${action}`];
}

export function parseMuteOutput(stdout: string): boolean | null {
  const match = /muted:(true|false)/i.exec(stdout.trim());
  if (!match) return null;
  return match[1].toLowerCase() === 'true';
}
```

- [ ] **Step 4: Write `micMuteService.ts`**

```ts
import { parseMuteOutput, buildShimArgs } from './micMuteOutput';

export interface MicMuteDeps {
  readMute(): Promise<boolean | null>;
  writeMute(muted: boolean): Promise<void>;
  pollMs: number;
}

export class MicMuteService {
  private muted: boolean | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(muted: boolean) => void>();

  constructor(private readonly deps: MicMuteDeps) {}

  isMuted(): boolean | null {
    return this.muted;
  }

  onChange(listener: (muted: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (this.timer) return;
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async setMuted(muted: boolean): Promise<void> {
    await this.deps.writeMute(muted);
    this.update(muted);
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      void this.poll();
    }, this.deps.pollMs);
  }

  private async poll(): Promise<void> {
    try {
      const value = await this.deps.readMute();
      if (value !== null) this.update(value);
    } catch (error) {
      console.error('Could not read the microphone mute state:', error);
    }
    if (this.timer) this.schedule();
  }

  private update(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    for (const l of this.listeners) l(muted);
  }
}

// Real dependencies live in the runtime layer; exported here so the wiring is obvious.
export { buildShimArgs, parseMuteOutput };
```

Note: `stop()` clears the timer, and `poll()` only reschedules while `this.timer` is set, so a poll already in flight cannot resurrect the loop.

- [ ] **Step 5: Run tests**

Run: `npx jest src/__tests__/micMute.test.ts`
Expected: PASS (9 tests). Then `npm run build && npm run lint`.

- [ ] **Step 6: Verify the shim against real Windows audio**

Run (PowerShell, not Git Bash):

```powershell
node -e "const {buildShimArgs}=require('./dist/services/micMuteOutput');console.log(JSON.stringify(buildShimArgs('get')))" > $env:TEMP\args.json
node -e "const {spawnSync}=require('child_process');const {buildShimArgs,parseMuteOutput}=require('./dist/services/micMuteOutput');const r=spawnSync('powershell',buildShimArgs('get'),{encoding:'utf8'});console.log('raw:',JSON.stringify(r.stdout),'err:',r.stderr.slice(0,400));console.log('parsed:',parseMuteOutput(r.stdout));"
```

Expected: `parsed: false` (or `true` if your mic is muted). Mute your microphone in Windows, run it again, and confirm the value flips. If the shim throws, report the exact PowerShell error — the C# interface layout is the likely culprit and the controller will decide.

- [ ] **Step 7: Checkpoint (no commit)**

Run: `git status --short`.

---

### Task 11: Settings, session runtime, and IPC

**Files:**
- Modify: `src/services/settingsService.ts`
- Create: `src/services/sessionRuntime.ts`
- Modify: `src/main.ts`
- Modify: `src/preload.ts`

**Interfaces:**
- Consumes: everything from Tasks 4-10, plus existing `whisperServer`, `modelManager`, `transcribeAudio`, `getSettings`, `saveSettings`.
- Produces:
  - `Settings` gains: `vaultPath: string`, `liveModelId: string`, `language: string`, `refineDuringRecording: RefineMode`, `refineWithExternalApi: boolean`, `blockMinutes: number`, `keepSessionAudio: boolean`, `timestampHeadings: boolean`, `captureDeviceName: string`
  - `sessionRuntime.ts`: `startSession(): Promise<SessionInfo>`, `pauseSession(): Promise<void>`, `resumeSession(): Promise<void>`, `stopSession(): Promise<void>`, `sessionStatus(): SessionStatusView`, `onSessionStatus(l: (v: SessionStatusView) => void): () => void`, `onSessionSegment(l: (s: { text: string; blockIndex: number }) => void): () => void`, `captureDevices(): CaptureDevice[]`, `isSessionActive(): boolean`, `revealDocument(): Promise<void>`, `openVault(): Promise<void>`
  - `interface SessionStatusView { state: 'idle' | 'starting' | 'recording' | 'paused' | 'stopped' | 'error'; documentPath: string | null; blockIndex: number; durationSec: number; refining: number; message?: string; muted: boolean | null }`
- IPC: `session-start`, `session-pause`, `session-resume`, `session-stop`, `session-status`, `list-capture-devices`, `open-vault`, `reveal-document` (invoke); `session-status` and `session-segment` (events).

- [ ] **Step 1: Extend settings**

In `src/services/settingsService.ts`, add to `Settings` and to the `getSettings()` return (defaults in brackets): `vaultPath` [`path.join(app.getPath('documents'), 'Dark-Whisper')`], `liveModelId` [`'ggml-base.en.bin'`], `language` [`'en'`], `refineDuringRecording` [`'auto'`], `refineWithExternalApi` [`false`], `blockMinutes` [`2`], `keepSessionAudio` [`false`], `timestampHeadings` [`false`], `captureDeviceName` [`''`]. Add the same defaults to the `new Store({ defaults: … })` block **except** nothing that the migration depends on (`serverMode` stays excluded as before). Import `RefineMode` as a type from `./blockRefiner`.

- [ ] **Step 2: Write the session runtime**

Create `src/services/sessionRuntime.ts`. It wires the pure pieces to real IO:

```ts
import { app, shell } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AudioEntry, BYTES_PER_SECOND, WAV_HEADER_BYTES, slicesForRange, wavHeader } from './blockMath';
import { RefineMode, RefineQueue, shouldRefineDuringRecording } from './blockRefiner';
import { DocumentStore, Frontmatter } from './documentStore';
import { MicMuteService } from './micMuteService';
import { buildShimArgs, parseMuteOutput } from './micMuteOutput';
import { RefineJob, SessionService } from './sessionService';
import { newSessionId } from './sessionPaths';
import { CaptureDevice } from './streamOutput';
import { getSettings } from './settingsService';
import { startLiveEngine, stopLiveEngine, streamEngine, sessionsRoot, currentAudioFiles } from './streamRuntime';
import { transcribeAudio } from './apiService';
import { modelManager, whisperServer } from './whisperRuntime';

export interface SessionStatusView {
  state: 'idle' | 'starting' | 'recording' | 'paused' | 'stopped' | 'error';
  documentPath: string | null;
  blockIndex: number;
  durationSec: number;
  refining: number;
  message?: string;
  muted: boolean | null;
}

const listeners = new Set<(v: SessionStatusView) => void>();
const segmentListeners = new Set<(s: { text: string; blockIndex: number }) => void>();

let session: SessionService | null = null;
let queue: RefineQueue | null = null;
let manifest: { file: string; startSec: number }[] = [];
let sessionId: string | null = null;
let documentPath: string | null = null;
let statusMessage: string | undefined;

const micMute = new MicMuteService({
  readMute: () =>
    new Promise((resolve) => {
      const child = spawn('powershell', buildShimArgs('get'), { windowsHide: true });
      let out = '';
      child.stdout.on('data', (c) => (out += String(c)));
      child.on('error', () => resolve(null));
      child.on('close', () => resolve(parseMuteOutput(out)));
    }),
  writeMute: (muted) =>
    new Promise((resolve) => {
      const child = spawn('powershell', buildShimArgs(muted ? 'mute' : 'unmute'), { windowsHide: true });
      child.on('error', () => resolve());
      child.on('close', () => resolve());
    }),
  pollMs: 1000,
});

function emit(): void {
  const view = sessionStatus();
  for (const l of listeners) l(view);
}

export function onSessionStatus(listener: (v: SessionStatusView) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function onSessionSegment(listener: (s: { text: string; blockIndex: number }) => void): () => void {
  segmentListeners.add(listener);
  return () => segmentListeners.delete(listener);
}

export function captureDevices(): CaptureDevice[] {
  return streamEngine.getStatus().devices;
}

export function isSessionActive(): boolean {
  const info = session?.getInfo();
  return info !== undefined && info.state !== 'stopped';
}

export function sessionStatus(): SessionStatusView {
  const engine = streamEngine.getStatus();
  const info = session?.getInfo();
  let state: SessionStatusView['state'] = 'idle';
  if (engine.state === 'error') state = 'error';
  else if (engine.state === 'starting') state = 'starting';
  else if (info) state = info.state;

  return {
    state,
    documentPath,
    blockIndex: info?.blockIndex ?? 0,
    durationSec: info?.durationSec ?? 0,
    refining: queue?.pending() ?? 0,
    message: engine.message ?? statusMessage,
    muted: micMute.isMuted(),
  };
}

function audioManifest(): AudioEntry[] {
  return manifest.map((entry) => {
    const full = path.join(sessionsRoot(), sessionId!, entry.file);
    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch {
      size = 0;
    }
    return {
      file: full,
      startSec: entry.startSec,
      durationSec: Math.max(0, (size - WAV_HEADER_BYTES) / BYTES_PER_SECOND),
    };
  });
}

async function sliceAudio(job: RefineJob): Promise<string | null> {
  const slices = slicesForRange(audioManifest(), job.startSec, job.endSec);
  if (slices.length === 0) return null;
  const chunks: Buffer[] = [];
  for (const slice of slices) {
    const handle = await fs.promises.open(slice.file, 'r');
    try {
      const length = slice.endByte - slice.startByte;
      if (length <= 0) continue;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, slice.startByte);
      if (bytesRead > 0) chunks.push(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }
  const data = Buffer.concat(chunks);
  if (data.length < BYTES_PER_SECOND) return null; // less than a second of audio is not worth a pass
  const out = path.join(os.tmpdir(), `dw-block-${job.blockIndex}-${Date.now()}.wav`);
  await fs.promises.writeFile(out, Buffer.concat([wavHeader(data.length), data]));
  return out;
}

function refinementAllowedNow(): boolean {
  const settings = getSettings();
  if (settings.serverMode === 'external' && !settings.refineWithExternalApi) return false;
  if (settings.serverMode === 'builtin' && whisperServer.getStatus().state !== 'ready') return false;
  const liveBytes = modelSize(settings.liveModelId);
  const refineBytes = settings.modelId ? modelSize(settings.modelId) : 0;
  return shouldRefineDuringRecording(settings.refineDuringRecording as RefineMode, liveBytes, refineBytes);
}

function modelSize(id: string): number {
  const file = modelManager.getModelPath(id);
  if (!file) return 0;
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export async function startSession(): Promise<SessionStatusView> {
  if (isSessionActive()) throw new Error('A session is already recording');
  const settings = getSettings();
  const store = new DocumentStore(settings.vaultPath);
  sessionId = newSessionId(new Date());
  manifest = [];
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
  documentPath = store.createDocument(sessionId.replace(/(\d{4})(\d{2})(\d{2})-(\d{4})\d{2}/, '$1-$2-$3-$4'), frontmatter);

  session = new SessionService({
    store,
    enqueueRefine: (job) => queue?.enqueue(job),
    blockMinutes: settings.blockMinutes,
    timestampHeadings: settings.timestampHeadings,
  });

  queue = new RefineQueue({
    sliceAudio,
    transcribe: (wav) => transcribeAudio(wav),
    cleanup: (wav) => fs.rmSync(wav, { force: true }),
    apply: (blockIndex, text) => session!.applyRefinement(blockIndex, text),
    report: (event) => {
      statusMessage = event.kind === 'failed' ? `Refinement failed for block ${event.blockIndex}` : undefined;
      emit();
    },
  });
  queue.setAllowed(refinementAllowedNow());

  session.begin({ id: sessionId, documentPath });
  session.onInfo(() => emit());

  const device = captureDevices().find((d) => d.name === settings.captureDeviceName);
  if (settings.captureDeviceName && !device) {
    statusMessage = `Microphone "${settings.captureDeviceName}" not found — using the default device`;
  }

  micMute.start();
  await startLiveEngine({ sessionId, captureId: device?.index ?? null });
  emit();
  return sessionStatus();
}

export async function pauseSession(): Promise<void> {
  if (!isSessionActive()) return;
  await micMute.setMuted(true);
  streamEngine.setPaused(true);
  session?.setPaused(true);
  emit();
}

export async function resumeSession(): Promise<void> {
  if (!isSessionActive()) return;
  await micMute.setMuted(false);
  streamEngine.setPaused(false);
  session?.setPaused(false);
  emit();
}

export async function stopSession(): Promise<void> {
  if (!session) return;
  stopLiveEngine();
  micMute.stop();
  session.end();
  queue?.setAllowed(true); // deferred jobs run now
  emit();

  const settings = getSettings();
  const id = sessionId;
  void queue?.drain().then(() => {
    if (!settings.keepSessionAudio && id) {
      fs.rmSync(path.join(sessionsRoot(), id), { recursive: true, force: true });
    }
    emit();
  });
}

export async function revealDocument(): Promise<void> {
  if (documentPath) shell.showItemInFolder(documentPath);
}

export async function openVault(): Promise<void> {
  const vault = getSettings().vaultPath;
  fs.mkdirSync(vault, { recursive: true });
  await shell.openPath(vault);
}

// Engine → session plumbing, registered once.
streamEngine.onSegment((segment) => {
  session?.segment(segment);
  const blockIndex = session?.getInfo().blockIndex ?? 0;
  for (const l of segmentListeners) l({ text: segment.text, blockIndex });
});
streamEngine.onLaunch((launch) => {
  if (!sessionId) return;
  const before = manifest.map((m) => m.file);
  // whisper-stream.exe creates its WAV as it starts; give it a moment, then record the new name.
  setTimeout(() => {
    const after = currentAudioFiles(sessionId!);
    const added = after.filter((f) => f.toLowerCase().endsWith('.wav') && !before.includes(f)).sort();
    const file = added[added.length - 1];
    if (file) manifest.push({ file, startSec: launch.atMs / 1000 });
  }, 500);
});
streamEngine.onStatus(() => emit());
micMute.onChange((muted) => {
  if (!isSessionActive()) return;
  if (muted) void pauseSession();
  else void resumeSession();
});
```

**External-edit guard (spec §5.3).** Add a module-level `let lastFileHash = ''` and a helper, then call it from the places that write:

```ts
function noteOurWrite(store: DocumentStore): void {
  if (documentPath) lastFileHash = store.fileHash(documentPath);
}

function externallyEdited(store: DocumentStore): boolean {
  if (!documentPath || lastFileHash === '') return false;
  return store.fileHash(documentPath) !== lastFileHash;
}
```

Wrap the segment handler so an outside edit stops refinement but never stops recording:

```ts
streamEngine.onSegment((segment) => {
  const store = activeStore;
  if (store && externallyEdited(store)) {
    queue?.setAllowed(false);
    statusMessage = 'File edited outside the app — refinement paused for this session';
  }
  session?.segment(segment);
  if (store) noteOurWrite(store);
  const blockIndex = session?.getInfo().blockIndex ?? 0;
  for (const l of segmentListeners) l({ text: segment.text, blockIndex });
});
```

Keep the store reachable: add `let activeStore: DocumentStore | null = null`, set it in `startSession` (`activeStore = store`), call `noteOurWrite(store)` right after `session.begin(...)`, and after every `applyRefinement` inside the queue's `apply` callback. Because the guard only trips when *someone else* changed the file between two of our writes, normal appends and refinements do not trigger it.

**Orphan session report (spec §5.3).** At the end of the module, log once at startup so stale audio is never silent:

```ts
try {
  for (const dir of fs.readdirSync(sessionsRoot())) {
    console.warn(`Leftover session audio from a previous run: ${path.join(sessionsRoot(), dir)}`);
  }
} catch {
  // No sessions directory yet — nothing to report.
}
```

- [ ] **Step 3: Wire IPC and the hotkey rules in `main.ts`**

Add the import:

```ts
import {
  captureDevices,
  isSessionActive,
  onSessionSegment,
  onSessionStatus,
  openVault,
  pauseSession,
  resumeSession,
  revealDocument,
  sessionStatus,
  startSession,
  stopSession,
} from './services/sessionRuntime';
```

In the `ready` handler, after the existing status wiring:

```ts
  onSessionStatus((view) => mainWindow?.webContents.send('session-status', view));
  onSessionSegment((segment) => mainWindow?.webContents.send('session-segment', segment));
```

Replace `handleRecordingToggle` so the hotkey serves the active mode:

```ts
const handleRecordingToggle = async () => {
  if (isSessionActive()) {
    const paused = sessionStatus().state === 'paused';
    await (paused ? resumeSession() : pauseSession());
    return;
  }
  if (isRecording) {
    await stopRecording();
  } else if (canStartRecording()) {
    isRecording = true;
    void startRecordingSession();
  }
};
```

In the `start-recording` handler, refuse during a session — insert before the existing guards:

```ts
  if (isSessionActive()) {
    mainWindow?.webContents.send('error', { message: 'A recording session is in progress. Stop it before using quick dictation.' });
    return;
  }
```

Append the new handlers at the end of the file:

```ts
ipcMain.handle('session-start', async () => {
  if (isRecording) {
    throw new Error('Quick dictation is recording. Stop it before starting a session.');
  }
  return startSession();
});

ipcMain.handle('session-pause', () => pauseSession());
ipcMain.handle('session-resume', () => resumeSession());
ipcMain.handle('session-stop', () => stopSession());
ipcMain.handle('session-status', () => sessionStatus());
ipcMain.handle('list-capture-devices', () => captureDevices());
ipcMain.handle('open-vault', () => openVault());
ipcMain.handle('reveal-document', () => revealDocument());
```

In `before-quit`, stop a running session first:

```ts
  if (isSessionActive()) {
    void stopSession();
  }
```

- [ ] **Step 4: Extend the preload bridge**

In `src/preload.ts`, add type-only imports and bridge methods:

```ts
import type { SessionStatusView } from './services/sessionRuntime';
import type { CaptureDevice } from './services/streamOutput';
```

```ts
  startSession: (): Promise<SessionStatusView> => ipcRenderer.invoke('session-start'),
  pauseSession: (): Promise<void> => ipcRenderer.invoke('session-pause'),
  resumeSession: (): Promise<void> => ipcRenderer.invoke('session-resume'),
  stopSession: (): Promise<void> => ipcRenderer.invoke('session-stop'),
  getSessionStatus: (): Promise<SessionStatusView> => ipcRenderer.invoke('session-status'),
  listCaptureDevices: (): Promise<CaptureDevice[]> => ipcRenderer.invoke('list-capture-devices'),
  openVault: (): Promise<void> => ipcRenderer.invoke('open-vault'),
  revealDocument: (): Promise<void> => ipcRenderer.invoke('reveal-document'),
  onSessionStatus: (callback: (view: SessionStatusView) => void) => {
    ipcRenderer.on('session-status', (_event, view: SessionStatusView) => callback(view));
  },
  onSessionSegment: (callback: (segment: { text: string; blockIndex: number }) => void) => {
    ipcRenderer.on('session-segment', (_event, segment: { text: string; blockIndex: number }) => callback(segment));
  },
```

Mirror all ten entries in the `declare global` block.

- [ ] **Step 5: Verify**

```bash
npm run build && npm test && npm run lint
grep -n "require(" dist/preload.js
```
Expected: build and tests clean, 0 lint errors, and only `require("electron")` in the preload bundle.

- [ ] **Step 6: Checkpoint (no commit)**

Run: `git status --short`.

---

### Task 12: Temporary session strip in the UI

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes (Task 11): `window.api.startSession/pauseSession/resumeSession/stopSession/getSessionStatus/listCaptureDevices/openVault/revealDocument/onSessionStatus/onSessionSegment`, and the new settings keys via the existing `getSettings`/`saveSettings`.
- Produces: no new interfaces. This UI is scaffolding; stage 2 replaces it.

- [ ] **Step 1: Add the markup**

Insert after the existing `.button-group` div:

```html
    <div class="session-strip">
      <div class="session-row">
        <button class="record-btn" id="sessionStartBtn">Start session</button>
        <button class="modal-btn modal-btn-cancel inline-btn" id="sessionPauseBtn" hidden>Pause</button>
        <button class="modal-btn modal-btn-cancel inline-btn" id="sessionStopBtn" hidden>Stop</button>
        <span class="model-meta" id="sessionState">No session</span>
      </div>
      <pre class="session-text" id="sessionText"></pre>
      <div class="session-row">
        <button class="link-btn" id="revealDocBtn" hidden>Reveal document</button>
        <button class="link-btn" id="openVaultBtn">Open vault</button>
        <span class="model-meta" id="sessionRefining"></span>
      </div>
    </div>
```

Add the CSS before `</style>`:

```css
    .session-strip { border-top: 1px solid #eee; margin-top: 16px; padding-top: 12px; text-align: left; }
    .session-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 6px 0; }
    .session-text {
      background: #1e1e24; color: #e8e8ef; border-radius: 8px; padding: 12px;
      min-height: 80px; max-height: 220px; overflow-y: auto; white-space: pre-wrap;
      font-family: 'Courier New', monospace; font-size: 13px; margin: 0;
    }
```

- [ ] **Step 2: Add the script**

Insert before `</script>`:

```js
    // Temporary session controls — replaced by the three-pane workspace in stage 2.
    const sessionStartBtn = document.getElementById('sessionStartBtn');
    const sessionPauseBtn = document.getElementById('sessionPauseBtn');
    const sessionStopBtn = document.getElementById('sessionStopBtn');
    const sessionState = document.getElementById('sessionState');
    const sessionText = document.getElementById('sessionText');
    const sessionRefining = document.getElementById('sessionRefining');
    const revealDocBtn = document.getElementById('revealDocBtn');
    const openVaultBtn = document.getElementById('openVaultBtn');

    function renderSession(view) {
      const active = view.state === 'recording' || view.state === 'paused' || view.state === 'starting';
      sessionStartBtn.hidden = active;
      sessionPauseBtn.hidden = !active;
      sessionStopBtn.hidden = !active;
      sessionPauseBtn.textContent = view.state === 'paused' ? 'Resume' : 'Pause';
      revealDocBtn.hidden = !view.documentPath;

      const parts = [];
      if (view.state === 'idle') parts.push('No session');
      else parts.push(view.state === 'paused' && view.muted ? 'paused (mic muted)' : view.state);
      if (view.durationSec) parts.push(`${Math.round(view.durationSec)}s`);
      if (view.blockIndex) parts.push(`block ${view.blockIndex}`);
      if (view.message) parts.push(view.message);
      sessionState.textContent = parts.join(' · ');
      sessionRefining.textContent = view.refining > 0 ? `refining ${view.refining} block(s)…` : '';
    }

    window.api.onSessionStatus(renderSession);
    window.api.getSessionStatus().then(renderSession);

    window.api.onSessionSegment(({ text }) => {
      sessionText.textContent = `${sessionText.textContent}${sessionText.textContent ? ' ' : ''}${text}`;
      sessionText.scrollTop = sessionText.scrollHeight;
    });

    sessionStartBtn.addEventListener('click', async () => {
      sessionText.textContent = '';
      try {
        renderSession(await window.api.startSession());
      } catch (error) {
        showError(cleanIpcError(error));
      }
    });

    sessionPauseBtn.addEventListener('click', async () => {
      const view = await window.api.getSessionStatus();
      await (view.state === 'paused' ? window.api.resumeSession() : window.api.pauseSession());
    });

    sessionStopBtn.addEventListener('click', () => window.api.stopSession().catch((e) => showError(cleanIpcError(e))));
    revealDocBtn.addEventListener('click', () => window.api.revealDocument());
    openVaultBtn.addEventListener('click', () => window.api.openVault());
```

- [ ] **Step 3: Add the new settings fields**

In the settings modal, after the microphone `form-group`, add:

```html
      <div class="form-group">
        <label for="vaultPathInput">Vault folder</label>
        <input type="text" id="vaultPathInput" placeholder="C:\Users\you\Documents\Dark-Whisper">
      </div>

      <div class="form-group">
        <label for="liveModelInput">Live model (fast)</label>
        <input type="text" id="liveModelInput" placeholder="ggml-base.en.bin">
      </div>

      <div class="form-group">
        <label for="languageInput">Language</label>
        <input type="text" id="languageInput" placeholder="en">
      </div>

      <div class="form-group">
        <label for="blockMinutesInput">Minutes per block</label>
        <input type="number" id="blockMinutesInput" min="1" max="30">
      </div>

      <div class="form-group">
        <label for="refineModeInput">Refine during recording</label>
        <select id="refineModeInput" style="width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; font-family: inherit; cursor: pointer;">
          <option value="auto">Auto (skip when models are large)</option>
          <option value="always">Always</option>
          <option value="afterStop">After stopping</option>
        </select>
      </div>

      <div class="form-group">
        <label style="display: flex; align-items: center; cursor: pointer; user-select: none; font-weight: normal;">
          <input type="checkbox" id="timestampHeadingsInput" style="width: auto; margin-right: 10px; cursor: pointer;">
          <span>Write timestamp headings in the document</span>
        </label>
        <label style="display: flex; align-items: center; cursor: pointer; user-select: none; font-weight: normal; margin-top: 8px;">
          <input type="checkbox" id="keepAudioInput" style="width: auto; margin-right: 10px; cursor: pointer;">
          <span>Keep session audio after refinement</span>
        </label>
      </div>
```

Declare the references next to the existing settings element lookups:

```js
    const vaultPathInput = document.getElementById('vaultPathInput');
    const liveModelInput = document.getElementById('liveModelInput');
    const languageInput = document.getElementById('languageInput');
    const blockMinutesInput = document.getElementById('blockMinutesInput');
    const refineModeInput = document.getElementById('refineModeInput');
    const timestampHeadingsInput = document.getElementById('timestampHeadingsInput');
    const keepAudioInput = document.getElementById('keepAudioInput');
```

In the `settingsBtn` click handler, after the existing field population:

```js
      vaultPathInput.value = settings.vaultPath || '';
      liveModelInput.value = settings.liveModelId || 'ggml-base.en.bin';
      languageInput.value = settings.language || 'en';
      blockMinutesInput.value = settings.blockMinutes || 2;
      refineModeInput.value = settings.refineDuringRecording || 'auto';
      timestampHeadingsInput.checked = settings.timestampHeadings === true;
      keepAudioInput.checked = settings.keepSessionAudio === true;
```

In the `saveSettings({ … })` object, add these named fields (never a spread):

```js
          vaultPath: vaultPathInput.value.trim(),
          liveModelId: liveModelInput.value.trim() || 'ggml-base.en.bin',
          language: languageInput.value.trim() || 'en',
          blockMinutes: Math.max(1, Math.min(30, Number(blockMinutesInput.value) || 2)),
          refineDuringRecording: refineModeInput.value,
          timestampHeadings: timestampHeadingsInput.checked,
          keepSessionAudio: keepAudioInput.checked,
```

- [ ] **Step 4: Verify**

```bash
npm run build && npm test && npm run lint
grep -c innerHTML public/index.html
node -e "const h=require('fs').readFileSync('public/index.html','utf8');const ids=[...h.matchAll(/getElementById\('([^']+)'\)/g)].map(m=>m[1]);const missing=ids.filter(id=>!h.includes('id=\"'+id+'\"'));console.log(missing.length?'MISSING ids: '+missing.join(', '):'all ids present')"
```
Expected: build/tests/lint clean; `innerHTML` count unchanged at 2 (pre-existing); all ids present.

- [ ] **Step 5: The real milestone — record a session**

```bash
npm start
```
Then: open the window from the tray, click **Start session**, speak. Confirm text appears in the dark strip within ~2 s, the state line shows `recording · Ns · block 1`, and the `.md` file in `Documents/Dark-Whisper` grows (open it in another editor). Mute your microphone with a hardware key → the state shows `paused (mic muted)`; unmute → `recording`. Let a block boundary pass (2 minutes, or set `blockMinutes` to 1 for testing) and confirm `refining 1 block(s)…` appears and the block's text is rewritten in the file. Click **Stop**, then confirm the session audio folder under `%APPDATA%/Dark-Whisper/sessions` is cleaned up once refinement finishes.

Report exactly what happened, including the resulting `.md` content.

- [ ] **Step 6: Checkpoint (no commit)**

Run: `git status --short`.

---

### Task 13: Final verification and documentation

**Files:**
- Modify: `README.md`, `QUICKSTART.md`, `DEVELOPMENT.md`, `SETUP_SUMMARY.txt`, `.claude`

- [ ] **Step 1: Full suite**

```bash
npm ci && npm run build && npm test && npm run lint && npm audit
```
Expected: build clean, all suites pass, 0 lint errors, 0 vulnerabilities.

- [ ] **Step 2: Packaged build**

```bash
npm run whisper:fetch && npm run ensure-mac-perms && npm run build && npx electron-builder --win --dir
ls "release/win-unpacked/resources/whisper/cpu/whisper-stream.exe" "release/win-unpacked/resources/whisper/cpu/SDL2.dll"
ELECTRON_ENABLE_LOGGING=1 timeout 25 "release/win-unpacked/Dark-Whisper.exe" > "$TEMP/packaged.log" 2>&1; echo "exit: $?"
grep -iE "Uncaught|ReferenceError|TypeError|Cannot find module" "$TEMP/packaged.log"
```
Expected: both binaries present; exit 124; no script errors. (The executable name follows `productName`, so it is `Dark-Whisper.exe`.)

- [ ] **Step 3: Update the documentation**

Fold stage 1 into the docs: sessions and the vault in README (new "Recording a session" section, the new settings, `%APPDATA%\Dark-Whisper` paths and the migration note), the session flow and `whisper-stream.exe` contract in DEVELOPMENT (including that `streamOutput.ts` is the only place that knows the output format), `npm run stream:probe` in QUICKSTART, and refreshed module lists in SETUP_SUMMARY and `.claude`. Rename "Whisper Desktop" to "Dark-Whisper" throughout.

- [ ] **Step 4: Report**

Summarise against the spec's §13 manual checklist, marking each item run or not run here, and list anything the user must verify themselves (long session, Obsidian edit conflict, vault on another drive, GPU behaviour).
