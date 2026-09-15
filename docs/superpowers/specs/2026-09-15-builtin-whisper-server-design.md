# Built-in Whisper Server & Model Manager — Design

**Date:** 2026-09-15
**Status:** Draft for review

## 1. Goal

Whisper Desktop currently requires the user to run a separate Whisper-compatible HTTP API at `http://127.0.0.1:4444`. This design makes the app self-contained: it bundles and manages a local [whisper.cpp](https://github.com/ggml-org/whisper.cpp) server and adds a screen to download speech models from Hugging Face. Users with an existing external API keep working unchanged.

**Success criteria**
- Fresh install → pick a model → dictate with the hotkey, with no other software installed.
- GPU acceleration on NVIDIA, AMD, and Intel via Vulkan, with automatic CPU fallback.
- Existing v1.0.x users who rely on an external API see no change after upgrading.

**Non-goals (YAGNI)**
- Browsing/searching Hugging Face; resumable downloads; parallel downloads.
- Running the server when the app is closed; serving other applications.
- CUDA builds; macOS/Linux packaging (the app ships Windows x64 only today).
- Changing the recording pipeline (sox → 16 kHz mono WAV), which whisper.cpp already accepts natively.

## 2. Decisions

| Topic | Decision |
|---|---|
| Integration | Child process `whisper-server.exe` supervised by the main process (not an in-process addon, not a Windows service). |
| GPU | Vulkan build compiled in CI (no official prebuilt exists for Windows x64), plus a CPU build from the same source tag. |
| Models | Curated list pinned by SHA256 + custom Hugging Face `.bin` URL. |
| Server mode | Settings toggle: **Built-in** (default for fresh installs) or **External API** (today's behaviour). |
| Lifecycle | Server runs for the whole app session with the model loaded. |

## 3. Architecture

```
public/index.html ──contextBridge (preload.ts)──► main.ts
                                                   │
                     ┌─────────────────────────────┼──────────────────────────┐
                     ▼                             ▼                          ▼
          services/whisperServer.ts     services/modelManager.ts     services/apiService.ts
          spawn/supervise server        catalog, download, verify    POST /v1/audio/transcriptions
                     │                             │                          │
                     ▼                             ▼                          │
      resources/whisper/{vulkan,cpu}/     userData/models/*.bin               │
          whisper-server.exe  ◄───────────── model path ──────────────────────┘
          (127.0.0.1:<free port>)                              baseURL = server URL (built-in)
                                                                         or settings.apiUrl (external)
```

### 3.1 `src/services/whisperServer.ts` (new)

Owns the server process. Emits status changes; knows nothing about UI.

**State:** `no-model | starting | ready | error | stopped`, plus `{ modelId, backend: 'vulkan' | 'cpu', port, message? }`.

**Public interface (sketch)**
```ts
start(modelPath: string, opts: { forceCpu: boolean }): Promise<void>
stop(): Promise<void>
restart(): Promise<void>
getStatus(): ServerStatus
getBaseUrl(): string | null        // http://127.0.0.1:<port> when ready
onStatus(listener: (s: ServerStatus) => void): () => void
```

**Start sequence**
1. Kill a stale server from a previous crash (see §6.2).
2. Resolve binary: for the `vulkan` backend only, `WHISPER_SERVER_DIR` env var (dev) first; then `process.resourcesPath/whisper/<backend>/whisper-server.exe` (packaged) or `<repo>/resources/whisper/<backend>/` (dev). If the Vulkan binary is absent, use CPU. The bundled whisper.cpp version is read from `whisper/VERSION`, written by CI and `whisper:fetch`.
3. Backend: `cpu` if `forceCpu` or a cached fallback exists for the current whisper.cpp version; otherwise `vulkan`.
4. Obtain a free port by listening on port 0 on `127.0.0.1` and closing.
5. Spawn with `-m <modelPath> --host 127.0.0.1 --port <port> --inference-path /v1/audio/transcriptions`. Never pass `--convert`.
6. Write PID to `userData/whisper-server.pid`; pipe stdout/stderr to the log buffer.
7. Poll `GET http://127.0.0.1:<port>/health` every 500 ms until HTTP 200 → `ready`. Give up after 120 s → `error`. (whisper-server loads the model *before* binding the port, so connection refused during load is expected.)
8. GPU label: stderr line `whisper_backend_init_gpu: using <dev> backend` → GPU; `whisper_backend_init_gpu: no GPU found` → CPU. With `GGML_BACKEND_DL`, a Vulkan build on a machine without a Vulkan driver runs on CPU and logs "no GPU found" rather than exiting, so the status must come from this line, not from which binary was launched.

### 3.2 `src/services/modelManager.ts` (new)

Owns model files under `app.getPath('userData')/models/`.

**Public interface (sketch)**
```ts
listModels(): ModelEntry[]                 // catalog + installed custom models, with installed flag
getModelPath(id: string): string | null
download(id: string): void                 // curated
downloadCustom(url: string): void
cancelDownload(): void
deleteModel(id: string): Promise<void>
getDiskInfo(): Promise<{ usedBytes: number; freeBytes: number }>
onProgress(listener: (p: DownloadProgress) => void): () => void
```

**Curated catalog** (base URL `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/`)

| id / file | Bytes | SHA256 | Label |
|---|---|---|---|
| `ggml-large-v3-turbo-q5_0.bin` | 574041195 | `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2` | Recommended — best balance on GPU |
| `ggml-large-v3-turbo-q8_0.bin` | 874188075 | `317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1` | Slightly more accurate |
| `ggml-large-v3-turbo.bin` | 1624555275 | `1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69` | Full precision |
| `ggml-medium.en-q5_0.bin` | 539225533 | `76733e26ad8fe1c7a5bf7531a9d41917b2adc0f20f2e4f5531688a8c6cd88eb0` | English only |
| `ggml-small.en.bin` | 487614201 | `c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d` | English, good on CPU |
| `ggml-small.en-q5_1.bin` | 190098681 | `bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30` | English, fast on CPU |
| `ggml-base.en.bin` | 147964211 | `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002` | English, very fast |
| `ggml-tiny.en.bin` | 77704715 | `921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f` | Testing / low-end |

Values were taken from the Hugging Face tree API on 2026-09-15.

**Custom models**
- Accepted URL shape: `https://huggingface.co/<owner>/<repo>/resolve/<rev>/<path>.bin`. Validated before any request; redirects to HF's CDN are then followed.
- Expected SHA256 from the `X-Linked-Etag` response header. If the header is absent, the download is accepted on the GGML magic check alone.
- Stored as `userData/models/custom/<owner>__<repo>__<file>.bin`; id is that filename.

**Download algorithm**
1. Reject if a download is already running.
2. Check free space ≥ expected size + 100 MB (`fs.statfs`).
3. Stream via axios (`responseType: 'stream'`) to `<file>.part`, hashing incrementally with `crypto.createHash('sha256')`; emit progress (bytes, total, bytes/sec) at most every 250 ms.
4. On completion: verify SHA256 (when expected hash known) and GGML magic (first 4 bytes, little-endian `0x67676d6c`). On success rename `.part` → `.bin`; on failure delete `.part`.
5. Cancel aborts via `AbortController` and deletes `.part`.

### 3.3 Changes to existing files

| File | Change |
|---|---|
| `src/services/settingsService.ts` | Add `serverMode: 'builtin' \| 'external'`, `modelId: string \| null`, `forceCpu: boolean`, plus a migration (§6.5). |
| `src/services/apiService.ts` | `setConfig` accepts a timeout. Built-in: baseURL from `whisperServer.getBaseUrl()`, timeout 300 s, health = `getStatus().state === 'ready'`. External: unchanged (`/v1/health`, 30 s). |
| `src/main.ts` | On `ready`: run migration, start server in built-in mode if a model is selected, else set `no-model`. Hotkey/`start-recording` checks server state first (§4.4). `before-quit`: cancel download, stop server. Tray tooltip mirrors status; add "Models…" menu item. Register new IPC handlers. |
| `src/preload.ts` | Expose new invoke methods and `onServerStatus` / `onDownloadProgress` listeners. |
| `public/index.html` | Status line, no-model banner, settings mode toggle, Models modal (§5). |
| `electron-builder.yml` | Add `extraResources: [{ from: resources/whisper, to: whisper }]`. |
| `package.json` | Remove the duplicate `build` block (config lives only in `electron-builder.yml`); add `whisper:fetch` script. |
| `.github/workflows/publish.yml` | Add `build-whisper` job (§7.1). |
| `.gitignore` | Ignore `resources/whisper/`. |

New: `whisper.version` (contains the pinned whisper.cpp build tag, initially `b5130` — build tags are git tags that also carry official binaries, unlike `v1.9.x` release tags), `scripts/fetch-whisper.js`.

## 4. Data flow

### 4.1 App launch (built-in mode)
1. Settings loaded and migrated.
2. `modelId` set and file exists → `whisperServer.start()` → `starting` → `ready`.
3. `modelId` unset or file missing → state `no-model` → system notification "Choose a speech model to finish setup" (click opens Models modal).

### 4.2 First model download
User clicks Download → `download-model` IPC → progress events to renderer → on success, if `modelId` is unset, set it and start the server.

### 4.3 Dictation
Unchanged pipeline: hotkey → sox WAV → `transcribeAudio()` → paste. Only the base URL, timeout, and health check differ per mode.

### 4.4 Hotkey while not ready (built-in)
| State | Behaviour |
|---|---|
| `no-model` | Don't record; show window with Models modal open. |
| `starting` | Don't record; notification "Model is still loading". |
| `error` | Don't record; notification with the error; window shows Restart. |

### 4.5 Switching model
`select-model` → save `modelId` → `whisperServer.restart()` → `starting` → `ready`.

### 4.6 Deleting a model
If it is the active model: stop server, delete file, set `modelId = null`, state `no-model`. Otherwise just delete.

## 5. UI

Single `public/index.html`, vanilla JS, existing modal styles.

**Main window status line** under the title, with a 🧠 Models button beside ⚙️:
- `● No model installed` (grey) + banner with **Download recommended model**
- `● Loading model…` (amber)
- `● Ready — <model> (GPU|CPU)` (green)
- `● Server error: <message>` (red) + **Restart** and **Open log**
- `● External API — <url>` (external mode)

**Settings modal:** "Transcription server" radio (Built-in / External API) at the top. Built-in shows a "Force CPU" checkbox; External shows the existing API URL and token fields. Saving a change to mode or Force CPU starts, stops, or restarts the server.

**Models modal:** header with disk used/free; one row per catalog entry and installed custom model showing name, size, label, and action — `Active`, `Use` + `Delete`, `Download`, or an in-progress bar with %, speed, and `Cancel`. Other Download buttons are disabled during a download. Below the list: custom URL input + Download. Errors show inline on the affected row with Retry.

**Tray:** tooltip `Whisper Desktop — <status>`; new "Models…" item.

**IPC**

| Channel | Direction | Payload |
|---|---|---|
| `get-server-status` | invoke | → `ServerStatus` |
| `restart-server` | invoke | — |
| `open-server-log` | invoke | — |
| `list-models` | invoke | → `ModelEntry[]` + disk info |
| `download-model` | invoke | `id` |
| `download-custom-model` | invoke | `url` |
| `cancel-download` | invoke | — |
| `delete-model` | invoke | `id` |
| `select-model` | invoke | `id` |
| `server-status` | main → renderer | `ServerStatus` + `{ mode, text }` |
| `open-models` | main → renderer | — (tray "Models…", notification click, hotkey in `no-model`) |
| `download-progress` | main → renderer | `{ id, receivedBytes, totalBytes, bytesPerSec, state: 'downloading' \| 'verifying' \| 'done' \| 'error', error? }` |

## 6. Error handling

### 6.1 Server start and runtime
- **Vulkan unavailable:** Vulkan process exits before `ready` and stderr does not match a model-load failure → retry once with CPU; persist `gpuFallbackVersion = <whisper.version>` in settings. Cleared when the user unticks Force CPU or the bundled version changes.
- **Model load failure:** stderr matches whisper.cpp's model-load error → `error` "Model failed to load — try re-downloading it"; no CPU fallback.
- **Port bind failure:** retry once with a new free port.
- **Readiness timeout:** 120 s → `error`.
- **Crash while running:** restart after 1 s, 5 s, 15 s; a fourth crash → `error` (manual Restart). Counter resets after 5 min in `ready`.
- **Crash during transcription:** request fails with the existing error message; supervisor restarts in the background.

### 6.2 Orphaned process
On start, if `whisper-server.pid` exists and `tasklist /FI "PID eq <pid>" /FO CSV /NH` reports image `whisper-server.exe`, terminate it with `taskkill /PID <pid> /F`. Delete the PID file on clean stop.

### 6.3 Logging
Ring buffer of the last 500 stdout/stderr lines, flushed to `userData/logs/whisper-server.log` (overwritten per app launch) on every state change and on exit. "Open log" uses `shell.openPath`.

### 6.4 Downloads
Network error, disk error, or checksum/magic mismatch → delete `.part`, row shows the error + Retry. App quit cancels and deletes `.part`. On launch, delete stray `*.part` in the models directory.

### 6.5 Settings migration
If the store has no `serverMode` key:
- store file already existed (upgrade from v1.0.x) → `serverMode = 'external'`
- fresh install → `serverMode = 'builtin'`

Detection: check whether `config.json` exists in `userData` before `electron-store` initialises defaults.

### 6.6 Security
Server binds `127.0.0.1` only; no `--convert` (no ffmpeg on uploaded input); custom URLs restricted to `https://huggingface.co` before redirects; models verified by SHA256 where available and GGML magic always. The server is unauthenticated to other local processes — accepted for a single-user desktop app.

## 7. Build, packaging, and testing

### 7.1 CI: `build-whisper` job (`windows-latest`)
1. Read tag from `whisper.version`; cache key = tag + Vulkan SDK version.
2. On cache miss: checkout `ggml-org/whisper.cpp` at the tag; install pinned Vulkan SDK; build twice:
   - `cmake -B build-vulkan -DGGML_VULKAN=ON -DWHISPER_BUILD_EXAMPLES=ON -DCMAKE_BUILD_TYPE=Release` → `whisper-server.exe` + required DLLs
   - `cmake -B build-cpu -DWHISPER_BUILD_EXAMPLES=ON -DCMAKE_BUILD_TYPE=Release`
3. Smoke test: download `ggml-tiny.en.bin` (verify SHA256), start the CPU server, POST `samples/jfk.wav` to `/v1/audio/transcriptions`, assert the response text contains "ask not". For Vulkan, assert `whisper-server.exe --help` exits 0.
4. Upload `whisper/{cpu,vulkan}` as an artifact.

`build-and-release` gains `needs: [lint, test, build-whisper]`, downloads the artifact to `resources/whisper/`, then runs the existing packaging step.

### 7.2 Local development
- `npm run whisper:fetch` → `scripts/fetch-whisper.js` downloads the official `whisper-bin-x64.zip` from the whisper.cpp release whose tag equals `whisper.version`, verifies it against a SHA256 stored in the script, and extracts `whisper-server.exe` + DLLs into `resources/whisper/cpu/`.
- `WHISPER_SERVER_DIR` overrides the binary directory (e.g. a local Vulkan build).
- Without a Vulkan build, dev runs fall back to CPU via the normal fallback path.

### 7.3 Unit tests (Jest, mocked `child_process`, `axios`, `fs`)
- **modelManager:** catalog integrity (unique ids, 64-hex SHA256, URL shape); custom URL accept/reject table; GGML magic check; `.part` → `.bin` on hash match; delete on mismatch; delete on cancel; stray `.part` cleanup; insufficient-space rejection; one-download-at-a-time.
- **whisperServer:** `starting → ready`; no model → `no-model`; Vulkan early exit → CPU retry and fallback persisted; model-load stderr → `error` without fallback; crash backoff 1/5/15 s then `error` (fake timers); counter reset after 5 min; `stop()` kills the process and removes the PID file; stale PID killed only when the image name matches.
- **settingsService:** migration for existing vs fresh store.
- **apiService:** built-in mode uses server base URL + 300 s timeout; external unchanged.

### 7.4 Manual checklist (Windows)
1. Fresh install: no-model banner → download recommended → hotkey dictation, status shows GPU.
2. Force CPU on → still transcribes, status shows CPU.
3. Switch model; delete active model → `no-model`; cancel a download mid-way → no `.part` left.
4. Custom URL (e.g. a `distil-large-v3` GGML file) downloads and becomes selectable; a non-HF URL is rejected.
5. External mode against an existing API works as in v1.0.1.
6. Install over a v1.0.1 profile → mode is External.
7. Kill the app in Task Manager → relaunch → only one `whisper-server.exe` running.
8. Machine or VM without Vulkan → automatic CPU fallback.

## 8. Risks

- **Vulkan SDK install in CI** is the most fragile step; mitigated by caching the built binaries per version.
- **whisper.cpp stderr wording** for model-load failures may change between versions; the matcher lives in one function with a unit test and is re-checked when bumping `whisper.version`.
- **`X-Linked-ETag` is only on HF's 302 response** (the CDN's final `etag` is a Xet hash, not SHA256), so custom downloads read it with a HEAD request that does not follow redirects.
- **Hugging Face checksums** could change if files are re-uploaded; a mismatch fails safely and is fixed by updating the catalog.
- **Installer size** grows by roughly the two server builds (estimated 20–60 MB); models are never bundled.
