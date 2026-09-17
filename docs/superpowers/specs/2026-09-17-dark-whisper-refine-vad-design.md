# Dark-Whisper: Silero VAD for Refinement — Design

**Date:** 2026-09-17
**Status:** Draft for review
**Builds on:** `2026-09-16-dark-whisper-quick-notes-refresh-design.md` (paragraph blocks). Ships in 1.3.0, on branch `feat/quick-notes-refresh`.

## 1. Problem

Whisper models invent text on audio without speech ("Thank you.", "."). With recordings split into paragraphs at pauses, such text shows up as paragraphs of its own. Two sources:

- **Live text** (`whisper-stream`, fast model): already filtered by its words (`liveFilter.ts`: stock phrases, repeats).
- **Refinement** (`whisper-server`, main model): a paragraph whose audio is mostly silence comes back as "Thank you.".

A spike on 2026-09-17 against the bundled whisper.cpp **b5130** `whisper-server` (Vulkan) with `ggml-large-v3-turbo-q5_0.bin`, two runs per clip:

| Clip | No options | `--suppress-nst` | `--vad` + Silero v5.1.2 or v6.2.0 |
|---|---|---|---|
| 6 s digital silence | "Thank you." | "Thank you." | "" (≈18 ms) |
| 6 s noise at −40 dBFS | "." | "." | "" (≈17 ms) |
| 3 s noise + JFK sample + 4 s noise | correct | correct | correct |
| JFK sample | correct | correct | correct |

b5130's `whisper-server` already supports `--vad` / `-vm` (no whisper.cpp upgrade needed). `whisper-stream` has no Silero VAD in any version, so live text keeps the word filter.

**Success criteria**
- Refining a paragraph without speech never writes invented text; such a paragraph disappears from the document.
- Paragraphs with speech are refined as before.
- A fresh install gets this without any download or setting.

**Non-goals:** VAD for live text (would mean replacing `whisper-stream`); VAD in External API mode; a whisper.cpp upgrade.

## 2. Decisions

| Topic | Decision |
|---|---|
| Live text | Keep `whisper-stream` and the word filter |
| Refinement | `whisper-server` runs with Silero VAD |
| Empty refinement with VAD active | The paragraph is removed (unless edited since it closed) |
| Empty refinement without VAD | Live text kept (current behaviour) |
| VAD model | `ggml-silero-v6.2.0.bin`, 885 098 bytes, SHA256 `2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987`, from `https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin` |
| Delivery | Bundled in the installer (`resources/whisper/vad/`), copied into the models folder at start-up |
| Setting | `refineVad` (boolean, default `true`): "Skip silence when refining (VAD)", built-in server only; a change restarts the server |
| VAD options | whisper.cpp defaults (threshold 0.5, min speech 250 ms, min silence 100 ms, pad 30 ms) |

## 3. The VAD model

- `whisper-vad.json` in the repo root pins the model:
  ```json
  { "file": "ggml-silero-v6.2.0.bin", "url": "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin", "size": 885098, "sha256": "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987" }
  ```
- `npm run whisper:fetch` also downloads it into `resources/whisper/vad/<file>` and checks size and hash.
- CI (`build-whisper`) downloads and checks it into `whisper-dist/vad/`, so the uploaded artifact (and the installer, via the existing `extraResources` rule for `resources/whisper`) contains it.
- **Install into the models folder.** whisper-server decodes path arguments as UTF-8 but receives them in the ANSI code page, which breaks absolute paths under non-ASCII profiles (the reason models are passed by file name with `cwd` set). At start-up, before the server starts, the app copies the bundled file to `%APPDATA%\Dark-Whisper\models\<file>` when that copy is missing or its size differs, writing to `<file>.part` and renaming. The server receives the VAD model as a path relative to its `cwd` (the chosen model's directory), e.g. `ggml-silero-v6.2.0.bin` or `..\ggml-silero-v6.2.0.bin` for a custom model under `models\custom\`. Both stay inside the models tree, so they are ASCII.
- The VAD file is not a speech model: `modelManager` must not list it (its catalog is by id; the file name does not match a catalog entry, and custom models live under `custom\`, so no change is expected — the plan verifies it with a test).

## 4. Server start-up

- `whisperServer.start(modelId, modelPath, opts)` gains `opts.vadModelPath: string | null`. When set, the launch arguments add `--vad -vm <relative path>`.
- `whisperRuntime` passes the installed copy's path when `refineVad` is on, the server mode is built-in and the copy exists; otherwise `null`, with one log line saying why VAD is off.
- `classifyServerLine` learns `whisper_vad_init_from_file_with_params: loading VAD model` → event `vad-loaded`, and `failed to initialize VAD` / `failed to load VAD model` style lines → `vad-failed`. The plan confirms the exact failure strings against b5130 by starting the server with a corrupt VAD file.
- `ServerStatus` gains `vad: boolean`: true once ready if `vad-loaded` was seen. A VAD load failure is logged and the server is restarted once without VAD (like the GPU fallback), so a bad VAD file never blocks transcription.
- The status view text keeps its form; its tooltip (`ServerStatusView.text` is already the tooltip) appends `, VAD` when on: `Ready — large-v3-turbo-q5_0 (GPU, VAD)`.

## 5. Refinement results

- `DocumentStore.removeBlock(file, index, expectedHash): 'removed' | 'skipped-edited' | 'missing'` removes the marker line, the clock line, the text and the blank line after it, when the text still matches the hash. It goes through `GuardedStore` like every other write.
- `SessionService.applyRefinement(blockIndex, text, opts: { vad: boolean })`:
  - text with speech → replace (as now);
  - noise-only text and `opts.vad` → `removeBlock` → outcome `removed`;
  - noise-only text without VAD → `no-speech` (live text kept, as now).
- `RefineQueue.apply` passes through the new outcome; the event is `{ kind: 'removed', blockIndex }`, and the block state becomes `removed` (new `BlockState`, label "removed — no speech", ranked final like `refined`).
- `sessionRuntime` supplies `vad: settings.serverMode === 'builtin' && whisperServer.getStatus().vad` at the moment the result is applied.
- The renderer's Blocks list shows the state; the document no longer contains the paragraph, so the view simply re-renders without it.

## 6. Settings

- `Settings.refineVad: boolean` (default `true`), `SettingsView.refineVad`.
- Settings dialog, "Transcription server" group, built-in options: checkbox **Skip silence when refining (VAD)** with the hint "Removes paragraphs that contain no speech."
- `save-settings` restarts the built-in server when `refineVad` changes.

## 7. Error handling

| Case | Behaviour |
|---|---|
| Bundled VAD file missing (dev without `whisper:fetch`) | Server starts without VAD; log line |
| Copy into models folder fails | Server starts without VAD; log line |
| Server fails to load the VAD model | Restart once without VAD; log line; `vad: false` |
| External API mode | No VAD; empty results keep live text |
| Paragraph edited before its empty result arrives | Not removed (`skipped-edited`) |

## 8. Testing

Unit tests (written first):
- `whisperServer`: launch arguments with and without `vadModelPath` (relative to the model directory, including a model under `custom\`); `vad` status from the log; the VAD-failure fallback restarts without `--vad`.
- `serverOutput`: the VAD log lines.
- `serverGate`/status text: `, VAD` in the tooltip.
- `documentStore.removeBlock`: removes exactly one block (marker, clock line, text, trailing blank), refuses an edited block, reports a missing one, keeps CRLF files intact.
- `sessionService.applyRefinement` with and without VAD; `blockRefiner` reports `removed`.
- A pure `vadInstall` helper: needs-copy decision (missing / size differs / same) and the relative path.
- `sessionModel`: `removed` label and rank.
- Settings default.

CI: after the JFK check, the CPU smoke test restarts the server with `--vad -vm <vad file>`, sends 6 s of generated silence and expects empty text, then sends `jfk.wav` and expects "ask not".

Manual: quick notes with pauses — no "Thank you." paragraphs; the server tooltip shows `VAD`.

## 9. Documentation

README (features, settings, troubleshooting "Paragraphs disappear"), DEVELOPMENT (server args, VAD install, CI step), `.claude`, and the 1.3.0 changelog entry.
