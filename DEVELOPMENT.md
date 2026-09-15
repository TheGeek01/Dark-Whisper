# Development Guide

## Architecture

The code is split so that all decision logic lives in modules that never import Electron, and a single thin layer wires those modules to Electron and the OS. That split is what makes the logic unit-testable: Jest cannot load Electron, so tests under `src/__tests__/` must never import `electron`, `electron-store`, `settingsService`, `whisperRuntime` or `main`.

### Main Process (main.ts)
- Handles Electron window lifecycle and the tray icon
- Registers the global hotkey
- Owns all IPC handlers
- Starts the transcription server at launch and stops it on quit
- Decides whether a recording may start (via `serverGate`)

### Renderer Process (public/index.html)
- Vanilla JS, no framework; context-isolated, talks only through `window.api`
- Shows recording status, the server status line, the setup banner
- Settings modal (server mode, Force CPU, hotkey, microphone, auto-mute, external API)
- Models modal (download, use, delete, custom URL, progress)
- All dynamic text is set with `textContent`, never `innerHTML`

### Services Layer

Electron-free (unit-tested):

| Module | Responsibility |
|--------|----------------|
| `modelCatalog.ts` | Curated model list with pinned SHA256 hashes; custom URL parsing; GGML header check |
| `modelManager.ts` | Download to `.part`, hash and format verification, cancel, list, delete, disk usage |
| `whisperServer.ts` | Supervisor state machine: `no-model`, `starting`, `ready`, `error`, `stopped` |
| `serverOutput.ts` | Classifies server log lines; restart backoff; line ring buffer; tasklist parsing |
| `serverPaths.ts` | Resolves `whisper-server.exe` for a backend (env override, packaged, dev) |
| `serverGate.ts` | Whether recording may start, and the status line text |
| `settingsMigration.ts` | Server-mode default: existing installs stay external, fresh installs built-in |

Electron-bound (verified by build, lint and running the app):

| Module | Responsibility |
|--------|----------------|
| `whisperRuntime.ts` | Real dependencies: spawn, free port, `/health` polling, PID file, log file, stale-process cleanup; owns the `whisperServer` and `modelManager` singletons |
| `settingsService.ts` | electron-store persistence |
| `apiService.ts` | Transcription HTTP client (timeout differs per mode) |
| `recordingService.ts` | SoX recording, device enumeration |
| `audioControlService.ts` | Mute and restore system audio |
| `pasteService.ts` | Clipboard write, verify, Ctrl+V via libnut, clipboard restore |
| `hotkeyService.ts` | `globalShortcut` registration |

### Security (preload.ts)
- Context isolation between main and renderer; no `nodeIntegration`
- Only whitelisted channels are exposed via `contextBridge`
- Type-only imports, so the sandboxed preload requires nothing but `electron`
  (verify with `grep -n "require(" dist/preload.js` — only `require("electron")` should appear)

## Recording Flow

```
Ctrl+Q pressed
    ↓
hotkeyService triggers callback
    ↓
main.ts: handleRecordingToggle() → canStartRecording()
    ├─ external mode → always allowed (health-checked separately)
    └─ built-in mode → serverGate.recordingGate(mode, status)
         ├─ no-model  → open Models, notify
         ├─ starting  → notify "Model is still loading"
         └─ ready     → proceed
    ↓
recordingService.recordAudio(device)
    ├─ spawns bundled sox.exe (16 kHz mono WAV)
    ├─ stops on the next hotkey press, or after 5 minutes
    └─ returns the audio file path
    ↓
apiService.transcribeAudio(audioPath)
    ├─ POST multipart to /v1/audio/transcriptions
    ├─ built-in: http://127.0.0.1:<port>, 5 minute timeout
    └─ external: configured URL, 30 second timeout
    ↓
pasteService.pasteTranscriptClipboard(text)
    ├─ writes clipboard (await — Electron 44 clipboard is async)
    ├─ libnut.keyTap('v', 'control')
    └─ restores the previous clipboard
    ↓
IPC: 'transcription-complete' → renderer updates the UI
```

## Server Supervision

`whisperServer.ts` receives every dependency by injection, which is how the tests drive it with a fake process and fake timers.

- **Start:** end a stale process from a previous crash → resolve the binary (Vulkan first unless Force CPU or a remembered fallback) → pick a free port → spawn with `-m <model file> --host 127.0.0.1 --port <port> --inference-path /v1/audio/transcriptions`, with `cwd` set to the model's directory.
- **Relative model path:** whisper-server reads argv in the ANSI code page but decodes the path as UTF-8, so an absolute path breaks on non-ASCII profiles (e.g. `C:\Users\José`). Passing only the file name and setting `cwd` avoids that entirely. Do not "simplify" this back to an absolute path.
- **Readiness:** poll `GET /health` every 500 ms, up to 120 s. The model loads before the port opens, so connection refused during loading is normal.
- **GPU label:** taken from the server's own log line (`whisper_backend_init_gpu: using … backend` vs `no GPU found`), not from which binary was launched — a Vulkan build on a machine with no Vulkan driver quietly runs on CPU.
- **Fallbacks:** a Vulkan process that exits before readiness (without a model-load error) is retried on CPU, and that fallback is remembered per whisper.cpp version. A model-load failure never falls back; it reports an error.
- **Crashes:** restart after 1 s, 5 s, 15 s; a fourth crash reports an error. The counter resets after 5 minutes of healthy running.
- **Generations:** every launch increments a counter, and stale callbacks are ignored. This is what keeps restart, model switch and quit from racing.
- **Orphans:** the server PID is written to `userData/whisper-server.pid`. At startup a leftover process is ended only if its image name is `whisper-server.exe`.

Server binaries are resolved in this order (per backend): `WHISPER_SERVER_DIR` (Vulkan only, dev override) → `process.resourcesPath/whisper/<backend>/` when packaged → `<repo>/resources/whisper/<backend>/` in development. The bundled whisper.cpp version is read from `whisper/VERSION`.

## Model Downloads

- Curated entries in `modelCatalog.ts` are pinned to file size and SHA256 from the Hugging Face tree API.
- Custom links must be `https://huggingface.co/<owner>/<repo>/resolve/<rev>/<file>.bin`. Their SHA256 comes from the `X-Linked-ETag` header, which Hugging Face only returns on its 302 redirect — hence the no-redirect HEAD request before the download.
- Downloads stream to `<file>.part`, hashing as they go, and are renamed only after the hash and the GGML magic check pass. Failures and cancels delete the partial file; stray `.part` files are swept at startup.
- One download at a time; progress events are throttled to 250 ms.

## IPC Surface

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `get-status`, `start-recording`, `stop-recording`, `copy-to-clipboard`, `get-settings`, `save-settings`, `get-audio-devices` | invoke | Pre-existing app controls |
| `get-server-status` | invoke | Current status view (`state`, `mode`, `text`, …) |
| `restart-server` | invoke | Re-run the start sequence |
| `open-server-log` | invoke | Open `whisper-server.log` |
| `list-models` | invoke | Catalog + installed models, active id, disk usage |
| `download-model`, `download-custom-model`, `cancel-download`, `delete-model`, `select-model` | invoke | Model management |
| `server-status` | main → renderer | Status changed |
| `download-progress` | main → renderer | Bytes, speed, state, error |
| `open-models` | main → renderer | Open the Models modal (tray, notification, hotkey) |
| `transcription-complete`, `recording-started`, `recording-stopped`, `error` | main → renderer | Pre-existing events |

## Testing

```bash
npm test                      # all suites
npx jest src/__tests__/whisperServer.test.ts    # one suite
npm run test:coverage
```

123 tests across 11 suites. Conventions:

- Use real filesystem work in a temp directory (`fs.mkdtempSync(os.tmpdir())`) rather than mocking `fs`.
- Inject fakes for processes, HTTP and clocks; never spawn a real process or hit the network, so the suite also passes on the Ubuntu CI runners.
- Use `jest.useFakeTimers()` with `await jest.advanceTimersByTimeAsync(ms)` for the supervisor's timing behaviour.
- Use `path.join` in expectations so assertions hold on both Windows and Linux.

### Manual Test Checklist

Automated tests cannot click the tray or press hotkeys, so before a release:

- [ ] Fresh profile: setup banner → download recommended model → status `Ready` → dictate into another app
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

## Debugging

### Open DevTools
Press `Ctrl+Shift+I` in the app window, or add `mainWindow.webContents.openDevTools()` in `createWindow()`.

### Server Output
```powershell
type $env:APPDATA\whisper-desktop\logs\whisper-server.log
```

### Run the Server by Hand
```powershell
resources\whisper\cpu\whisper-server.exe -m $env:APPDATA\whisper-desktop\models\ggml-tiny.en.bin `
  --host 127.0.0.1 --port 18080 --inference-path /v1/audio/transcriptions
# then, in another shell:
curl http://127.0.0.1:18080/health
curl -X POST http://127.0.0.1:18080/v1/audio/transcriptions -F "file=@sample.wav" -F response_format=json
```

In Git Bash, prefix such commands with `MSYS_NO_PATHCONV=1`, or MSYS rewrites `/v1/...` into a Windows path and the request 404s.

### Recordings and Models
```powershell
explorer $env:APPDATA\whisper-desktop\recordings
explorer $env:APPDATA\whisper-desktop\models
```

## Known Limitations & Gotchas

### 1. Jest cannot load Electron
Put logic in an Electron-free module and inject its dependencies. If a test needs `electron`, the design is wrong, not the test.

### 2. whisper-server log strings are a contract
`classifyServerLine` matches the server's own messages to detect model-load failures, port-bind failures and the GPU backend. Re-check them when bumping `whisper.version`.

### 3. Electron 44 clipboard is asynchronous
`clipboard.readText()` / `writeText()` return promises. Forgetting to await makes paste silently fail.

### 4. Vulkan builds are made in CI only
No prebuilt Vulkan `whisper-server` is published upstream, so `.github/workflows/publish.yml` compiles it. Locally, `npm run whisper:fetch` gives you the CPU build; use `WHISPER_SERVER_DIR` for a GPU build.

### 5. The built-in server has no authentication
It binds `127.0.0.1` and is never started with `--convert`, but any local program can reach it while the app runs. Accepted for a single-user desktop app.

### 6. Microphone permissions
Windows may block capture: Settings → Privacy & Security → Microphone, and ensure the app (or `electron.exe` in development) is allowed.

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

1. **Language selection** - transcription language is currently fixed to English
2. **Voice activity detection** - auto-stop on silence instead of a second hotkey press
3. **Transcription history** - store and display past transcriptions
4. **Dark mode** - theme support
5. **Auto-update** - electron-updater integration
6. **macOS and Linux** - packaging and a non-Windows recording path
