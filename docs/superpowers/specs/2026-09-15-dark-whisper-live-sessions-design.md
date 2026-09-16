# Dark-Whisper: Live Sessions, Markdown Vault, and Rebrand — Design

**Date:** 2026-09-15
**Status:** Draft for review
**Stage:** 1 of 2. This spec covers the rebrand, the live transcription engine, and the Markdown document model. The three-pane workspace redesign is stage 2 and gets its own spec.

## 1. Goal

Today a recording is transcribed only after it ends, and the text is pasted into another application. This stage makes Dark-Whisper a dictation *workspace*: you start a session, watch the Markdown file being written as you speak, and the file is saved continuously in a vault folder you own. Quality improves during the session as completed blocks are quietly re-transcribed with a larger model.

**Success criteria**
- Start a session and see text appear within ~1-2 seconds of speaking.
- The `.md` file on disk is never more than one segment behind what you said.
- A 1-2 hour session stays responsive, with bounded memory and no long wait at the end.
- Muting the microphone (in the app or in Windows) pauses transcription, and unmuting resumes it.
- Quick dictation (hotkey → paste into the focused app) keeps working exactly as it does now.

**Non-goals (this stage)**
- The three-pane UI, the live document view, the library sidebar and the contextual panel (stage 2). Stage 1 adds a deliberately plain session strip to the existing window.
- Speaker detection. `whisper-stream.exe` supports `-tdrz` (tinydiarize) with a suitable model, which is the likely future path; nothing in this stage depends on it.
- macOS/Linux, cloud sync, transcription history search UI beyond plain text search.

## 2. Decisions

| Topic | Decision |
|---|---|
| Live engine | whisper.cpp `whisper-stream.exe` (SDL2 capture, VAD sliding window), supervised like `whisper-server` |
| Quality | Completed ~2-minute blocks re-transcribed by the existing supervised server and replaced in the file |
| Long sessions | Refinement happens *during* the session, block by block; nothing waits at the end |
| Files | A vault folder the user chooses; one `.md` per session; real subfolders as projects |
| Autosave | Append every finalized segment |
| Pause | In-app pause and Windows mic mute are one concept, kept in sync |
| Modes | Quick dictation (unchanged) and Session mode coexist; one engine owns the mic at a time |
| Name | **Dark-Whisper** in UI, tray, installer and shortcuts |
| App id | `com.whisperdesktop.app` retained, so the installer upgrades v1.1.2 in place |

## 3. Architecture

```
                    ┌──────────────── main process ────────────────┐
 whisper-stream.exe ◄──────►│ streamEngine ──► sessionService ──► documentStore ──► vault/*.md
 (SDL2 mic,         │      │               │    ▲                 │
  live model)       │ streamOutput         │    │ refined text    │
                    │  (pure parser)       ▼    │                 │
                    │                  blockRefiner ──► apiService ──► whisper-server
                    │                      (WAV slice)                  (refine model)
                    │ micMuteService ◄──► Windows Core Audio (poll 1s)  │
                    └───────────────────────────────────────────────────┘
                                   session audio: userData/sessions/<id>/*.wav
```

Electron-free and unit-tested: `streamOutput`, `documentStore`, `blockMath`, `sessionService`, `streamEngine`, `settingsMigration` additions.
Electron-bound: `streamRuntime` (spawn/paths/manifest IO), `micMuteService`, IPC in `main.ts`.

Reused unchanged: `whisperServer`/`whisperRuntime`, `apiService`, `settingsService`, `hotkeyService`, `recordingService`, `pasteService`, `audioControlService`.

## 4. Live engine (`streamEngine.ts` + `streamOutput.ts`)

### 4.1 Process invocation

```
whisper-stream.exe -m <liveModelPath> --step 0 --length 10000 -vth 0.6 -t <threads>
           -l <language> -c <captureId> -sa -f live.txt
```
- `--step 0` selects VAD sliding-window mode: a segment is emitted when speech is detected and the window closes, which is what makes text appear as you speak.
- `--length 10000` is the window whisper sees per segment. `-vth 0.6` is upstream's suggested VAD threshold; it is a constant in this stage, tuned during manual testing, not a user setting.
- Working directory is `userData/sessions/<sessionId>/`, so `--save-audio` writes `YYYYMMDDHHMMSS.wav` (16 kHz, 16-bit, mono) there, and `live.txt` is a crash sink.
- `-ng` is added when the live model should run on CPU (mirrors the existing Force CPU setting).

### 4.2 Parsing (`streamOutput.ts`, pure)

| Input | Meaning |
|---|---|
| `[Start speaking]` on **stdout** | Engine ready → `listening` |
| `main: found N capture devices:` / `   - Capture device #N: 'name'` on stderr | Device list for the picker |
| `[00:00:01.000 --> 00:00:04.000]  text` on stdout | A finalized segment; timestamps are window-relative and discarded (the session clock is authoritative) |
| Bare text line on stdout | A finalized segment (no-timestamp path) |
| `couldn't open an audio device for capture` | Capture failure → `error` |
| `error: failed to initialize whisper context` | Model load failure → `error`, no retry |

The parser strips ANSI sequences (`\33[2K\r`), ignores blank lines, and reuses the existing `LineBuffer` for partial lines — one buffer per stream, since interleaving them would corrupt partial lines.

**Parsing is stream-aware.** `whisper-stream.exe` writes every diagnostic (`load_backend:`, `usage`, `init:`, the device list) to **stderr** and only `[Start speaking]` plus transcript text to **stdout** (verified against the b5130 binary). So stderr lines can only produce device/capture-failure/model-load-failure events, and stdout lines are the ready marker or speech. No prefix heuristic is used: an earlier attempt to recognise diagnostics by shape silently swallowed real dictation such as "12:30 is when we start".

### 4.3 States

`idle → preparing → starting → listening ⇄ paused → stopping → idle`, plus `error`.

- `starting` waits up to 60 s for `[Start speaking]` (model load), then `error`.
- Crash while `listening`: restart with 1 s / 5 s / 15 s backoff, a fourth crash → `error`. Each relaunch appends a new entry to the session's audio manifest and writes `<!-- dw:gap -->` plus an italic `*(recording interrupted and resumed)*` line into the document.
- `stop()` kills synchronously (same contract as `whisperServer`), so quit is safe.

### 4.4 Capture device

Devices are stored by **name** in settings. At session start the parsed device list resolves the name to an SDL index; if the name is gone, the session falls back to the default device and surfaces a warning. The last seen list is cached so the picker has something to show before the first session.

## 5. Document model (`documentStore.ts`)

### 5.1 Vault and naming

- `vaultPath` default `%USERPROFILE%\Documents\Dark-Whisper`, created on first use.
- A session creates `<vault>/<YYYY-MM-DD-HHmm>-untitled.md`. Renaming the title renames the file (slugified, collisions get `-2`).
- Subfolders are projects. The store lists, searches (plain substring over file contents, case-insensitive), renames and deletes; it never moves files on its own.

### 5.2 File shape

```markdown
---
title: untitled
created: 2026-09-15T14:32:04Z
updated: 2026-09-15T16:12:41Z
duration: 5797
language: en
liveModel: ggml-base.en.bin
refineModel: ggml-large-v3-turbo-q5_0.bin
app: dark-whisper 1.2.0
---

<!-- dw:block 1 t=0-120 -->
First block text, appended segment by segment as you speak.

<!-- dw:block 2 t=120-240 -->
Second block text.
```

- Block markers are HTML comments: invisible in rendered Markdown and in Obsidian, machine-readable, and no sidecar index to fall out of sync.
- `timestampHeadings` (default off) additionally writes `## 00:02:00` at each block start.
- `duration` is session seconds; `updated` is refreshed on each write.

### 5.3 Writing rules

- **Append:** each finalized segment is appended to the current block immediately (single writer: the main process).
- **Replace:** refinement rewrites exactly one block's body. When a block is written, its SHA256 is recorded in the session manifest. Refinement applies **only if** the block's current on-disk text still hashes to that value; otherwise the block is left alone and marked `edited` (your edits always win).
- **External change:** before each write the file's hash is compared with what we last wrote. On mismatch, refinement stops for the rest of the session, appending continues at the end of the file, and the UI shows "file edited outside the app — refinement paused".
- **Crash recovery:** `live.txt` plus the `.md` allow a session to be reconstructed; on startup a session directory with no matching document is reported once and left on disk.

### 5.4 Audio retention

Session WAVs live in `userData/sessions/<id>/`. They are deleted when every block of that session has been refined (or explicitly skipped), unless `keepSessionAudio` is on. Expect ~115 MB per hour while a session is in flight.

## 6. Session lifecycle (`sessionService.ts`)

1. **Start:** resolve live model, capture device and language; create the document and session directory; start `streamEngine`; state `preparing → starting → listening`.
2. **Segment received:** append to the document; extend the current block.
3. **Block boundary** (every `blockMinutes`, default 2, measured on the audio clock): close the block, record its hash, enqueue a refinement job, open the next block.
4. **Pause:** mute the mic device and set `paused`. The engine keeps capturing silence, so the audio clock continues and block arithmetic stays simple. Nothing is appended while paused.
5. **Resume:** unmute; back to `listening`.
6. **Stop:** stop the engine, close the final (partial) block, enqueue it, write `duration`, and let the refinement queue drain in the background.

**Mode rules.** During a session the global hotkey toggles pause/resume. Quick dictation is refused while a session is active, and starting a session is refused while a quick dictation is recording. The tray and the session strip both report the active mode.

## 7. Refinement (`blockRefiner.ts` + `blockMath.ts`)

- **Slicing:** a block's `[startSec, endSec)` is mapped onto the audio manifest (`{file, startSec}` entries, one per engine launch). For each overlapping file, bytes `44 + floor(offsetSec × 32000)` through `44 + ceil(endSec × 32000)` are copied into a temporary WAV with a fresh 44-byte header (16 kHz, 16-bit, mono). Ranges that fall in a gap between launches are skipped.
- **Transcription:** the temporary WAV is POSTed through `apiService` to the running server, which already holds the refine model (`modelId`). The result replaces the block subject to the hash guard in §5.3.
- **Queue:** one job at a time, oldest first, so refinement trails the session by at most a block or two on a GPU.
- **Memory guard (`refineDuringRecording`):** `auto` (default) defers all jobs until `stop` when the live and refine model **files** together exceed 2 GB; `always` refines during the session regardless; `after stop` always defers.
- **External API mode:** when `serverMode` is `external`, refinement is **off** by default — it would send session audio to a third party and may cost money. A setting (`refineWithExternalApi`, default off) enables it deliberately.
- **Failures:** a job that fails twice leaves the block as its live text, flagged `unrefined` in the manifest. Refinement failures never interrupt recording.

## 8. Mute and pause (`micMuteService.ts`)

- Reads and sets the default capture device's mute state through Windows Core Audio, invoked as a small inline C#/PowerShell shim (`IMMDeviceEnumerator` → `IAudioEndpointVolume::GetMute/SetMute`), spawned with `windowsHide`.
- Polls every 1 s while a session is active (not otherwise). The parse step — shim stdout (`muted:true|false`) → boolean — is pure and unit-tested; failures are logged once and treated as "unknown", which never forces a pause.
- App pause calls `SetMute(true)`; resume calls `SetMute(false)`. An OS-side change detected by the poll updates session state with the reason `mic muted`, so hardware keys, headset buttons and the app agree.

## 9. Settings and migration

New keys, alongside today's: `vaultPath`, `liveModelId` (default `ggml-base.en.bin`), `language` (default `en`), `refineDuringRecording` (`auto` | `always` | `afterStop`), `refineWithExternalApi` (default `false`), `blockMinutes` (default `2`), `keepSessionAudio` (default `false`), `timestampHeadings` (default `false`), `captureDeviceName` (default empty = system default).

**User-data migration.** `app.setName('Dark-Whisper')` moves `app.getPath('userData')` to `%APPDATA%\Dark-Whisper`. On first run, if that directory does not exist and a legacy one does (`whisper-desktop`, then `Whisper Desktop`), move `config.json`, `models/`, `logs/` and `recordings/` across with `fs.rename` (instant on the same volume; falls back to copy across volumes, reporting progress in the log). The migration is a pure planning function (given directory listings, produce the moves) plus a thin IO wrapper, so it is testable.

The live model is downloaded through the existing Models screen; `base.en` is already in the catalog. The Models screen gains a "use as live model" action in stage 2; in stage 1 `liveModelId` is set in Settings.

## 10. Rebrand

- `app.setName('Dark-Whisper')` early in `main.ts`, before any `getPath('userData')` call.
- `package.json` `name` → `dark-whisper`; `electron-builder.yml` `productName: Dark-Whisper`; `appId` unchanged (`com.whisperdesktop.app`) so the installer upgrades in place; NSIS shortcuts inherit the product name; installer artifact stays `Dark-Whisper-Setup-<version>.exe`.
- Window title, tray tooltip prefix, notification titles, and the "Whisper Desktop" strings in `public/index.html` become Dark-Whisper.
- README, QUICKSTART, DEVELOPMENT, SETUP_SUMMARY and `.claude` updated; `%APPDATA%\whisper-desktop` references become `%APPDATA%\Dark-Whisper` with a note about migration.

## 11. Packaging and CI

- `whisper-stream.exe` and `SDL2.dll` ship in `resources/whisper/<backend>/` alongside `whisper-server.exe`.
- The CI `build-whisper` job gains, before the cmake step: download `SDL2-devel-<ver>-VC.zip` from libsdl-org, extract, set `SDL2_DIR`, and add `-DWHISPER_SDL2=ON` to the common cmake args (mirroring whisper.cpp's own Windows release job). SDL2 version is pinned in the workflow. The copy step takes `whisper-server.exe`, `whisper-stream.exe` and `*.dll`.
- `scripts/fetch-whisper.js` copies `whisper-stream.exe` from the official zip in addition to `whisper-server.exe` (both are present in `whisper-bin-x64.zip`, as is `SDL2.dll`).
- Cache key gains the SDL2 version.

## 12. Stage-1 UI (temporary)

The existing window gets a session strip below the status line: **Start session / Pause / Stop**, the live text appended into a scrolling `<pre>`, the document path with a "reveal in Explorer" link, and a refinement indicator (`refining block 3…`). Settings gains fields for the new keys. This is scaffolding to exercise the engine; stage 2 replaces it wholesale, so it stays unstyled beyond the current CSS.

New IPC: `session-start`, `session-pause`, `session-resume`, `session-stop`, `session-status` (invoke); `session-segment`, `session-state`, `session-refined` (events); `list-capture-devices`, `open-vault`, `reveal-document` (invoke).

## 13. Testing

**Unit (Electron-free, temp dirs, injected fakes)**
- `streamOutput`: ready marker, device list, timestamped and bare segments, ANSI stripping, capture and model-load errors, partial lines.
- `documentStore`: frontmatter round-trip; append; block replace; hash guard refusing an edited block; external-change detection; rename with collision; search.
- `blockMath`: time → byte offsets; block spanning two audio files; block inside a gap; final partial block.
- `sessionService`: segment → append → block close → job enqueued → refined text applied; skip on hash mismatch; pause suppresses appends; gap marker on relaunch.
- `streamEngine`: fake process + fake timers — ready detection, pause/resume, crash backoff and manifest growth, 60 s readiness timeout, synchronous stop.
- `micMuteService` parsing; settings migration planning.

**CI:** `whisper-stream.exe --help` exits 0, and a short run under `SDL_AUDIODRIVER=dummy` reaches `[Start speaking]` and exits cleanly — proving the binary and `SDL2.dll` ship correctly.

**Manual (Windows, with a microphone)**
1. Start a session, speak; text appears within ~2 s and the `.md` grows on disk.
2. Let a block complete; its text visibly improves when refinement lands.
3. Mute with a hardware key → `Paused (mic muted)`; unmute → resumes.
4. Kill `whisper-stream.exe` mid-session → restart, gap marker, session continues.
5. Edit the file in Obsidian mid-session → refinement pauses with a notice, appends continue.
6. A long session (target 1-2 hours) stays responsive; memory flat; audio cleaned up after refinement.
7. Quick dictation still pastes into another app, and is refused during a session.
8. Vault on a second drive; migration of an existing `%APPDATA%\whisper-desktop` profile.

## 14. Risks

- **Silence hallucination.** VAD windows can emit phantom text; `-vth` may need tuning, and a post-filter for known artefacts ("(blank audio)", repeated single words) may be needed.
- **Two resident models.** The 2 GB heuristic is a guess at "comfortable"; it may need to consider actual free memory.
- **SDL device indices shift** as devices appear and disappear — mitigated by storing names, but a rename in Windows will still lose the binding.
- **Refinement churn.** Text changing under the reader is intended but unfamiliar; stage 2's UI should make it legible (e.g. a brief highlight).
- **Disk use** of ~115 MB per session hour until refinement completes.
- **`whisper-stream.exe` is an example program.** It is maintained upstream but not a stable API: its output format and flags can change between whisper.cpp versions, so `streamOutput` is the single place that knows them, and bumping `whisper.version` requires re-checking it (same rule as the server's log strings).
