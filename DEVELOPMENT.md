# Development Guide

## Architecture

The code is split so that all decision logic lives in modules that never import Electron, and a single thin layer wires those modules to Electron and the OS. That split is what makes the logic unit-testable: Jest cannot load Electron, so tests under `src/__tests__/` must never import `electron`, `electron-store`, `settingsService`, `whisperRuntime`, `streamRuntime`, `sessionRuntime`, `libraryRuntime`, `appIdentity` or `main`.

### Main Process (main.ts)
- Imports `appIdentity` first: it sets the app name and moves legacy user data before anything resolves `userData`
- Handles Electron window lifecycle and the tray icon
- Registers the global Quick Note hotkey, and draws the window with its own title bar (`titleBarOverlay`, colours from `windowTheme.ts`)
- Owns all IPC handlers
- Starts the transcription server at launch and stops it on quit
- Routes the hotkey, the tray item and the header button to `toggleQuickNote`; a refusal (a session is recording) is shown in the window, or as a notification when it is hidden

### Renderer (src/renderer → public/js)
- Vanilla TypeScript compiled by `tsconfig.renderer.json` to ES modules (`npm run build:renderer`); `public/index.html` is markup only and loads `js/renderer/app.js`
- `marked` and `DOMPurify` are copied to `public/vendor/` and loaded as classic scripts (globals declared in `src/renderer/globals.d.ts`)
- One state object (`state.ts`) with `update(patch)` / `subscribe(listener)`; each pane re-renders from it
- DOM-free, Jest-tested: `format.ts`, `libraryTree.ts`, `documentView.ts`, `sessionModel.ts`, `headerModel.ts`, `state.ts` (they must not touch `window`/`document` and may use only ES2020 library features, since the main tsconfig compiles them through the tests)
- DOM: `header.ts`, `library.ts`, `document.ts`, `levelMeter.ts`, `sessionPanel.ts`, `theme.ts`, `dialogs.ts` (ask/confirm, Settings, Models), `toast.ts`, `dom.ts`
- Colours are CSS tokens on `:root`, with a `[data-theme='light']` set; icons are CSS masks with `data:` SVGs (`.i .i-<name>`)
- Imports use `.js` extensions and `import type`; renderer code may import only `src/renderer` and `src/shared`
- The only `innerHTML` is in `document.ts`, fed by `DOMPurify.sanitize`; everything else uses `textContent`
- CSP `default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; font-src 'none'; media-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'` — no inline scripts or `style` attributes in the markup; images (including note images) may only be `data:` URIs, so remote and UNC (`//host/share`) image references are blocked

### Services Layer

Electron-free (unit-tested):

| Module | Responsibility |
|--------|----------------|
| `modelCatalog.ts` | Curated model list with pinned SHA256 hashes; custom URL parsing; GGML header check |
| `modelManager.ts` | Download to `.part`, hash and format verification, cancel, list, delete, disk usage |
| `vadModel.ts` | Pinned Silero VAD model: hash check and install into the models folder |
| `whisperServer.ts` | Supervisor state machine: `no-model`, `starting`, `ready`, `error`, `stopped` |
| `serverOutput.ts` | Classifies server log lines; restart backoff; line ring buffer; tasklist parsing |
| `serverPaths.ts` | Resolves `whisper-server.exe` for a backend (env override, packaged, dev) |
| `serverGate.ts` | Whether recording may start, and the status line text |
| `settingsMigration.ts` | Server-mode default (existing installs stay external, fresh installs built-in); silence-gap and theme clamping |
| `userDataMigration.ts` | Which entries to move from `whisper-desktop` / `Whisper Desktop` into `Dark-Whisper` |
| `streamOutput.ts` | Parses whisper-stream stdout/stderr: segments, device list, ready marker, failures |
| `streamEngine.ts` | Live engine supervisor: `idle`, `starting`, `listening`, `paused`, `stopped`, `error` |
| `sessionPaths.ts` | Session ids and session audio file names |
| `documentStore.ts` | Vault Markdown: frontmatter, append, block replace with hash guard, list, search, rename |
| `blockMath.ts` | Audio manifest → byte ranges, WAV headers |
| `audioLevel.ts` | PCM level in dBFS, meter level, and `SilenceTracker` (where a paragraph ends) |
| `pcmFileSink.ts` | Writes SoX's raw PCM to a WAV, reporting each chunk; patches the header on close |
| `quickNotes.ts` | The daily quick-note file (`prepareQuickNote`), start refusals, start-request parsing |
| `guardRegistry.ts` | One `GuardedStore` per document, shared by every recording that writes to it |
| `windowTheme.ts` | Title bar overlay and background colours per theme |
| `sessionService.ts` | One recording: segments → paragraphs (blocks) with clock lines, refinement jobs |
| `guardedStore.ts` | Wraps `DocumentStore` for a session: before every read or write, detects outside edits and reports which blocks changed |
| `blockRefiner.ts` | Refinement queue (one at a time, one retry) and the 2 GB memory guard |
| `micMuteOutput.ts` | The inline PowerShell/C# Core Audio shim and its `muted:true|false` output |
| `micMuteService.ts` | Polls the mute state and reports changes |
| `libraryService.ts` | Vault tree, search, read, rename, move, folders; the path guard every renderer path goes through. Tree and search use async I/O, at most 16 files open at once, so a large or synced vault does not stall the main process |
| `libraryWatch.ts` | `ChangeBatcher` debounce and snapshot diffing |

Electron-bound (verified by build, lint and running the app):

| Module | Responsibility |
|--------|----------------|
| `whisperRuntime.ts` | Real dependencies: spawn, free port, `/health` polling, PID file, log file, stale-process cleanup; owns the `whisperServer` and `modelManager` singletons |
| `streamRuntime.ts` | Spawns whisper-stream, session directories, the SoX recorder (raw PCM → `PcmFileSink`), per-recording audio and levels |
| `sessionRuntime.ts` | Wires engine, document, refinement queue and mic mute into sessions and quick notes; reacts to outside edits |
| `appIdentity.ts` | App name and the user-data migration, at import time |
| `settingsService.ts` | electron-store persistence |
| `apiService.ts` | Transcription HTTP client (timeout differs per mode) |
| `soxPath.ts` | Location of the bundled `sox.exe` |
| `hotkeyService.ts` | `globalShortcut` registration |
| `libraryRuntime.ts` | Library IPC, `fs.watch` with a 5 s polling fallback, Recycle Bin, open/reveal, vault picker |

At startup, `main.ts` creates the default vault (`Documents\Dark-Whisper`, `settingsService.DEFAULT_VAULT_PATH`) with `fs.mkdirSync(..., { recursive: true })` if it's missing, before calling `watchVault()` — a fresh install always has a vault to write to. A missing **custom** vault (one the user chose) is never auto-created; the library shows "Vault not found" with a Choose folder button instead.

### Security (preload.ts)
- Context isolation between main and renderer; no `nodeIntegration`
- Only whitelisted channels are exposed via `contextBridge`
- Type-only imports, so the sandboxed preload requires nothing but `electron`
  (verify with `grep -n "require(" dist/preload.js` — only `require("electron")` should appear)

## Quick Notes

```
Ctrl+Q / tray / Quick Notes button
    ↓
main.ts: handleQuickNoteToggle() → sessionRuntime.toggleQuickNote()
    ├─ a quick note is recording → stopSession()
    └─ otherwise → startSession({ kind: 'quick-note' })
         ├─ startRefusal: refused while a session records
         └─ prepareQuickNote → <vault>/Quick Notes/YYYY-MM-DD.md (created if missing),
              firstBlockIndex = highest dw:block + 1, baseDurationSec from frontmatter
    ↓
The rest is a normal recording (below). The date is fixed at start.
```

## Live Sessions

```
session-start (IPC)
    ↓
sessionRuntime.startSession()
    ├─ DocumentStore.createDocument → <vault>/YYYY-MM-DD-HHmm-untitled.md (-2, -3… on collision)
    ├─ GuardRegistry.acquire → the document's shared GuardedStore
    ├─ SessionService.begin → nothing is written until the first words
    └─ streamRuntime.startLiveEngine
         ├─ SoX streams raw PCM; PcmFileSink writes userData/sessions/<id>/audio-1.wav and
         │    every chunk's level feeds the recording's SilenceTracker and the level meter
         └─ streamEngine spawns whisper-stream.exe in that directory
    ↓
streamEngine 'segment' { text, atMs }
    ↓
SessionService.segment → if the open paragraph reached blockMinutes, or the audio between
  its last segment and this one holds silenceGapSeconds of non-speech, close it there;
  open a paragraph (marker + clock line) if none is open, append the text.
  A closed non-empty paragraph → RefineJob { index, range, hash }. Pause, an engine
  relaunch and Stop also close the open paragraph.
    ↓
RefineQueue → slice the block's bytes out of the WAV(s) → POST to whisper-server
  → SessionService.applyRefinement → DocumentStore.replaceBlock (hash guard)
    ↓
session-stop → engine and SoX stopped, final block queued, duration written;
  session audio removed once the queue is empty (unless keepSessionAudio)
```

### whisper-stream contract

`streamOutput.ts` is the **only** place that knows the output format; re-check it when bumping `whisper.version`.

- Invocation: `whisper-stream.exe -m <live model> --step 0 --length 10000 -vth 0.6 -t <threads> -l <language> [-c <capture id>] [-ng] -f live.txt`, working directory `userData/sessions/<id>/`.
- Every diagnostic, including the device list (`   - Capture device #N: 'name'`), goes to **stderr**; only `[Start speaking]` and transcript text go to **stdout**. The parser is stream-aware and uses no "looks like a log line" heuristic, which once swallowed real speech.
- Ready marker: `[Start speaking]`, within 60 s. Crashes restart after 1 s, 5 s, 15 s, then `error`. Each relaunch ends the open paragraph.
- Segment timestamps are **not** used for timing: in VAD mode they are relative to a 10 s window and often span all of it. Silence comes from the audio level instead.
- `--save-audio` is **not** used: in VAD mode it rewrites its 2-second buffer ~10 times a second, so its WAV is not a real-time recording. SoX records instead (raw PCM to stdout, `-t raw -`; its own `-S` level display is buffered until exit when piped), and keeps running across engine restarts so the audio timeline stays continuous.

### Documents and refinement

- Paragraphs (blocks) are delimited by `<!-- dw:block <n> t=<startSec>-<endSec> -->` (written `t=start-start` when the paragraph opens, rewritten when it closes), followed by a clock line `**HH:MM**` (`**YYYY-MM-DD HH:MM**` for a recording's first paragraph). The clock line is not part of the text that is hashed or refined, and `replaceBlock` keeps it. A paragraph is replaced only when its text still hashes (SHA256 of the trimmed text) to what we recorded when it closed.
- Silence rule (`SilenceTracker`): a ~0.25 s chunk is speech when `db >= -50` and `db >= min(p10 of the last 30 s, -40) + 10`. The longest non-speech run overlapping the two segment arrival times must last `silenceGapSeconds`; the paragraph ends at `max(previous arrival, middle of the run)`. With no level data it falls back to the arrival gap. Dead chunks (a muted mic, every sample within ±4) are silence but are left out of the noise floor, so the floor stays at the room's level after a mute.
- `GuardedStore` compares the file with the exact text we last wrote before **every** read or write. A difference means another program edited the file: the outside text becomes the new baseline, and `changedBlocks` reports which blocks changed. Finished blocks are then protected by their own hash when refined (`skipped-edited`); the block still being recorded is marked through `SessionService.noteOutsideEdit` and is closed as `edited` (shown as skipped) instead of being queued. Every other block is still refined. A file that cannot be read at that moment (a sync client holding it) is not treated as an edit.
- Stopping a session waits for SoX to exit before deleting the session audio (Windows refuses to delete a file that is still open), and retries the delete a few times.
- Each recording owns its queue and its audio entries, so a stopped recording keeps refining after the next one starts. Recordings writing to the same document (two quick notes on one day) share its `GuardedStore` through `GuardRegistry`, so neither mistakes the other's writes for an outside edit; the second one numbers its paragraphs after the first's.
- Refinement runs only when allowed: built-in server `ready` (or external mode with `refineWithExternalApi`), and during recording only if `refineDuringRecording` permits (`auto` defers when the live and refine model files exceed 2 GB). Permission is re-checked whenever the server status changes.
- With VAD on, an empty refinement removes its paragraph (`removeBlock`, hash-guarded, state `removed`); without VAD the live text is kept.
- Refinement jobs slice `44 + floor(offset × 32000)` … bytes per overlapping WAV, skipping gaps; less than one second of audio is skipped.

### Microphone mute

Pause mutes the Windows default capture endpoint through an inline C# shim run by `powershell.exe` (`IMMDeviceEnumerator` → `IAudioEndpointVolume`). The COM declarations need `[ComImport]`, and `IAudioEndpointVolume` has **eleven** methods before `SetMute`; getting either wrong fails the cast or calls the wrong vtable slot. During a session the state is polled every second; a change from outside the app pauses or resumes. Each call starts PowerShell and compiles the shim (~0.8 s), so polling is limited to active sessions.

Many USB mics (e.g. the TONOR TM20's touch mute) mute inside the device: Windows still reports the endpoint as unmuted and the mic sends digital silence (every sample within ±1). `DeadMicDetector` (`audioLevel.ts`) watches the peak of the SoX audio: 1.5 s with no sample above ±4 pauses as a mic mute (shown as muted), and the first chunk with signal resumes. A quiet room peaks in the hundreds, so ordinary silence never triggers it. A Resume clicked while the mic is still dead holds until the mic comes back and goes dead again.

## Server Supervision

`whisperServer.ts` receives every dependency by injection, which is how the tests drive it with a fake process and fake timers.

- **Start:** end a stale process from a previous crash → resolve the binary (Vulkan first unless Force CPU or a remembered fallback) → pick a free port → spawn with `-m <model file> --host 127.0.0.1 --port <port> --inference-path /v1/audio/transcriptions`, with `cwd` set to the model's directory.
- **Relative model path:** whisper-server reads argv in the ANSI code page but decodes the path as UTF-8, so an absolute path breaks on non-ASCII profiles (e.g. `C:\Users\José`). Passing only the file name and setting `cwd` avoids that entirely. Do not "simplify" this back to an absolute path.
- **VAD:** with `refineVad` on, `whisperRuntime` verifies the bundled `resources/whisper/vad/ggml-silero-v6.2.0.bin` against `whisper-vad.json`, copies it into the models folder, and the server gets `--vad -vm <path relative to the model directory>`. b5130 loads the VAD model per request; a bad file makes every request fail with `whisper_vad: failed to initialize VAD context`, which relaunches the server without VAD. `ServerStatus.vad` says whether the running process uses it.
- **Readiness:** poll `GET /health` every 500 ms, up to 120 s. The model loads before the port opens, so connection refused during loading is normal.
- **GPU label:** taken from the server's own log line (`whisper_backend_init_gpu: using … backend` vs `no GPU found`), not from which binary was launched — a Vulkan build on a machine with no Vulkan driver quietly runs on CPU.
- **Fallbacks:** a Vulkan process that exits before readiness (without a model-load error) is retried on CPU, and that fallback is remembered per whisper.cpp version. A model-load failure never falls back; it reports an error.
- **Crashes:** restart after 1 s, 5 s, 15 s; a fourth crash reports an error. The counter resets after 5 minutes of healthy running.
- **Generations:** every launch increments a counter, and stale callbacks are ignored. This is what keeps restart, model switch and quit from racing.
- **Orphans:** the server PID is written to `userData/whisper-server.pid`. At startup a leftover process is ended only if its image name is `whisper-server.exe`.

Server binaries (and `whisper-stream.exe`, the same way) are resolved in this order (per backend): `WHISPER_SERVER_DIR` (Vulkan only, dev override) → `process.resourcesPath/whisper/<backend>/` when packaged → `<repo>/resources/whisper/<backend>/` in development. The bundled whisper.cpp version is read from `whisper/VERSION`.

## Model Downloads

- Curated entries in `modelCatalog.ts` are pinned to file size and SHA256 from the Hugging Face tree API.
- Custom links must be `https://huggingface.co/<owner>/<repo>/resolve/<rev>/<file>.bin`. Their SHA256 comes from the `X-Linked-ETag` header, which Hugging Face only returns on its 302 redirect — hence the no-redirect HEAD request before the download.
- Downloads stream to `<file>.part`, hashing as they go, and are renamed only after the hash and the GGML magic check pass. Failures and cancels delete the partial file; stray `.part` files are swept at startup.
- One download at a time; progress events are throttled to 250 ms.

## IPC Surface

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `get-settings`, `save-settings` | invoke | Settings (a theme change also recolours the title bar; a shortcut change re-registers it) |
| `get-server-status` | invoke | Current status view (`state`, `mode`, `text`, …) |
| `restart-server` | invoke | Re-run the start sequence |
| `open-server-log` | invoke | Open `whisper-server.log` |
| `list-models` | invoke | Catalog + installed models, active id, disk usage |
| `download-model`, `download-custom-model`, `cancel-download`, `delete-model`, `select-model` | invoke | Model management |
| `server-status` | main → renderer | Status changed |
| `download-progress` | main → renderer | Bytes, speed, state, error |
| `open-models` | main → renderer | Open the Models modal (tray, notification, hotkey) |
| `session-start`, `session-pause`, `session-resume`, `session-stop`, `session-status` | invoke | Recording control; `session-start` takes `{ kind: 'session', folder }` or `{ kind: 'quick-note' }` and returns the status view |
| `quick-note-toggle` | invoke | Start or stop a quick note |
| `list-capture-devices` | invoke | Last device list seen from whisper-stream |
| `open-vault`, `reveal-document` | invoke | Open the vault folder / show the current document |
| `session-status` | main → renderer | `{ state, documentPath, blockIndex, durationSec, refining, message, muted }` |
| `session-segment` | main → renderer | `{ text, blockIndex }` for each live segment |
| `error` | main → renderer | `{ message }` for failures outside a renderer call (the Quick Note shortcut) |
| `session-level` | main → renderer | Microphone level 0–1, at most every 100 ms |
| `library-tree`, `library-search`, `document-read`, `document-rename`, `document-move`, `document-delete`, `folder-create`, `document-open-external`, `document-reveal`, `choose-vault`, `copy-text` | invoke | Library and clipboard |
| `library-changed` | main → renderer | `{ paths }`, debounced 300 ms |
| `session-block` | main → renderer | One block's state |

`session-status` carries `sessionId`, `kind`, `documentFile`, `folder`, `microphone`, `liveModel`, `refineModel`, `messages` and `blocks`; each block event carries its `clock` line.

## Testing

```bash
npm test                      # all suites
npx jest src/__tests__/whisperServer.test.ts    # one suite
npm run test:coverage
```

Conventions:

- Use real filesystem work in a temp directory (`fs.mkdtempSync(os.tmpdir())`) rather than mocking `fs`.
- Inject fakes for processes, HTTP and clocks; never spawn a real process or hit the network, so the suite also passes on the Ubuntu CI runners.
- Use `jest.useFakeTimers()` with `await jest.advanceTimersByTimeAsync(ms)` for the supervisor's timing behaviour.
- Use `path.join` in expectations so assertions hold on both Windows and Linux.
- `npm run smoke:workspace` drives a real app instance over the DevTools protocol against a throwaway vault (and a throwaway `--user-data-dir` profile, so it never touches your settings). Chromium renders nothing in a hidden window with a title bar overlay (dialogs never report closing), so the script also starts the main process with `--inspect` and calls `showInactive()` on the window, parked with only a corner on screen.
- `node scripts/dev-cdp.mjs "<expression>"` evaluates one expression in an app started with `--remote-debugging-port=9333`.

### Manual Test Checklist

Automated tests cannot click the tray or press hotkeys, so before a release:

- [ ] Fresh profile: setup banner → download recommended model → status `Ready` → Ctrl+Q from another app writes a quick note
- [ ] Force CPU on → still transcribes, status shows `(CPU)`
- [ ] Switch models; delete the active model (status returns to `No model installed`)
- [ ] Cancel a download mid-way → no `.part` file left in the models directory
- [ ] Custom Hugging Face link downloads and becomes selectable; a non-Hugging-Face URL is rejected
- [ ] External API mode still works against an existing server
- [ ] Upgrade over an existing profile stays on External API
- [ ] Kill the app in Task Manager, relaunch → only one `whisper-server.exe` is running
- [ ] Launch a second instance while the first is ready → the first keeps working
- [ ] A Windows account whose profile path contains non-ASCII characters
- [ ] On a Vulkan-capable GPU, the status line shows `(GPU)`
- [ ] Upgrade from a `whisper-desktop` profile → settings and models appear under `%APPDATA%\Dark-Whisper`
- [ ] Session: text appears within ~2 s and the `.md` grows on disk
- [ ] A pause of 6 s starts a new paragraph with the time; Pause/Resume does too; the level meter moves while speaking
- [ ] Two quick notes in a row go into one day file, numbered on, and the first one's paragraphs still refine
- [ ] Quick note with long pauses: no "Thank you." paragraphs; the server tooltip shows VAD
- [ ] Session: a paragraph closes, "refining" appears, and its text is replaced in the file with its time line kept
- [ ] Edit a paragraph in another editor while recording → only that paragraph is skipped
- [ ] Session: mute the microphone (Windows, hardware key, or the mic's own mute button) → paused; unmute → recording
- [ ] A quick note is refused during a session and vice versa (the shortcut shows a notification when the window is hidden)
- [ ] Kill `whisper-stream.exe` → a new paragraph starts and recording continues
- [ ] Title bar: caption buttons follow the theme; Snap Layouts and double-click-to-maximize work
- [ ] Session: a session longer than 30 minutes; a vault on another drive or a synced folder
- [ ] Session: stop → session audio removed after refinement (kept with Keep session audio)
- [ ] Obsidian open on the vault while recording and while browsing
- [ ] A 500-document vault opens and searches in under a second
- [ ] Keyboard-only library navigation
- [ ] A document with remote images and links (images blocked, links open in the browser)
- [ ] The window at 900×560 with the panel collapsed
- [ ] A vault on a network drive (polling notice appears)

## Debugging

### Open DevTools
Press `Ctrl+Shift+I` in the app window, or add `mainWindow.webContents.openDevTools()` in `createWindow()`.

### Server Output
```powershell
type $env:APPDATA\Dark-Whisper\logs\whisper-server.log
```

### Run the Server by Hand
```powershell
resources\whisper\cpu\whisper-server.exe -m $env:APPDATA\Dark-Whisper\models\ggml-tiny.en.bin `
  --host 127.0.0.1 --port 18080 --inference-path /v1/audio/transcriptions
# then, in another shell:
curl http://127.0.0.1:18080/health
curl -X POST http://127.0.0.1:18080/v1/audio/transcriptions -F "file=@sample.wav" -F response_format=json
```

In Git Bash, prefix such commands with `MSYS_NO_PATHCONV=1`, or MSYS rewrites `/v1/...` into a Windows path and the request 404s.

### Live Engine Output
```powershell
type $env:APPDATA\Dark-Whisper\logs\stream.log
npm run stream:probe -- $env:APPDATA\Dark-Whisper\models\ggml-base.en.bin
```

### Recordings and Models
```powershell
explorer $env:APPDATA\Dark-Whisper\recordings
explorer $env:APPDATA\Dark-Whisper\models
explorer $env:APPDATA\Dark-Whisper\sessions
```

## Known Limitations & Gotchas

### 1. Jest cannot load Electron
Put logic in an Electron-free module and inject its dependencies. If a test needs `electron`, the design is wrong, not the test.

### 2. whisper-server log strings are a contract
`classifyServerLine` matches the server's own messages to detect model-load failures, port-bind failures and the GPU backend. Re-check them when bumping `whisper.version`.

### 3. Electron 44 clipboard is asynchronous
`clipboard.writeText()` returns a promise; await it (`copy-text`).

### 4. Vulkan builds are made in CI only
No prebuilt Vulkan `whisper-server` is published upstream, so `.github/workflows/publish.yml` compiles it. Locally, `npm run whisper:fetch` gives you the CPU build; use `WHISPER_SERVER_DIR` for a GPU build.

### 5. The built-in server has no authentication
It binds `127.0.0.1` and is never started with `--convert`, but any local program can reach it while the app runs. Accepted for a single-user desktop app.

### 6. Microphone permissions
Windows may block capture: Settings → Privacy & Security → Microphone, and ensure the app (or `electron.exe` in development) is allowed.

### 7. npm 12 skips install scripts
npm 12 does not run dependency install scripts unless they are approved. After `npm ci` there is no `node_modules/node-mic/sox-win32/sox.exe` (and no Electron binary until `install-electron` runs). Run `node scripts/postinstall.js` inside `node_modules/node-mic`, or approve the package with `npm install-scripts approve node-mic`. CI uses the npm bundled with Node 24, which still runs them.

### 8. Pausing mutes the default microphone
The mute shim acts on the Windows default capture endpoint, not on the session microphone chosen in Settings.

## Deployment

### Build the Installer Locally
```bash
npm run whisper:fetch      # CPU server into resources/whisper
npm run build:windows      # NSIS installer in release/
```
The local installer contains only the CPU server unless you supply a Vulkan build in `resources/whisper/vulkan/`.

### Release via CI
```bash
git tag v1.2.0
git push origin v1.2.0
```
`.github/workflows/publish.yml` lints, tests, builds the CPU and Vulkan servers (smoke-testing a real transcription), then packages and publishes a GitHub Release. Packaging config lives only in `electron-builder.yml`; `package.json` has no `build` block.

### Code Signing (Windows)
For production releases, sign the executable to avoid SmartScreen warnings.

## Future Enhancements

1. **Voice activity detection** - auto-stop on silence instead of a second hotkey press
2. **Transcription history** - store and display past transcriptions
3. **Auto-update** - electron-updater integration
4. **macOS and Linux** - packaging and a non-Windows recording path
