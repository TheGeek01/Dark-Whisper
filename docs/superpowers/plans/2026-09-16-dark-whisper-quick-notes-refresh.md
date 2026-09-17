# Quick Notes and Interface Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace paste-anywhere dictation with a daily Quick Note mode, split every recording into timestamped paragraphs at pauses, restyle the window to the mockup, and make search hits jump to the matching line.

**Architecture:** SoX now streams raw PCM to the app, which writes the session WAV and measures a level per chunk; a `SilenceTracker` built from those levels tells `SessionService` where a paragraph (block) ends. Blocks become variable-length paragraphs, each opened with a visible `**HH:MM**` clock line that refinement keeps. Quick notes are ordinary sessions whose document is `<vault>/Quick Notes/YYYY-MM-DD.md`, numbered after the blocks already in it, sharing one outside-edit guard per file through a `GuardRegistry`. The renderer keeps its vanilla-TS module layout; the header, sidebar, document pane and panel are rebuilt against CSS colour tokens with a light theme.

**Tech Stack:** Electron 44, TypeScript 6 (main: CommonJS/node20; renderer: ES2022 modules → `public/js`), Jest 30 + ts-jest, marked 18 + DOMPurify 3.4 (UMD globals), whisper.cpp `whisper-stream`, SoX (from `node-mic`).

**Spec:** `docs/superpowers/specs/2026-09-16-dark-whisper-quick-notes-refresh-design.md`

## Global Constraints

- Work on branch `feat/quick-notes-refresh` in `C:\claudeProjects\whisper-desktop`. Commit with `git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit`, message ending with a blank line and `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- No new npm dependencies. No changes to `.github/workflows/publish.yml`.
- The CSP in `public/index.html` stays exactly: `default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; font-src 'none'; media-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`. No inline `<script>`/`<style>`/`style=""`. Setting `element.style.x` from TypeScript is allowed (CSSOM). Icons are CSS `mask` images using `data:` SVG URIs.
- Renderer modules import each other with a `.js` suffix (`import { x } from './y.js'`) and import shared types from `'../shared/api.js'`. `src/shared/api.ts` contains types only, no imports.
- The only `innerHTML` in the renderer stays `renderMarkdown` in `src/renderer/document.ts` (DOMPurify-sanitised).
- Clock lines: `**HH:MM**` (24-hour, local), and `**YYYY-MM-DD HH:MM**` for the first block of a run. Regex: `^\*\*(\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}\*\*$`.
- Quick note file: `<vault>/Quick Notes/YYYY-MM-DD.md` (local date at start). Folder name exactly `Quick Notes`.
- Silence gap setting `silenceGapSeconds`: default 5, clamped to 1–60. Theme setting `theme`: `'dark' | 'light'`, default `'dark'`.
- Speech rule: a level chunk is speech when `db >= -50` and `db >= min(p10 of last 30 s, -40) + 10`.
- Automated checks never use the real profile: live app runs use `--user-data-dir=<temp dir>`. Never call `pauseSession`/click Pause in automated checks (it mutes the real microphone).
- Verification commands: `npx jest <path>` for one suite, `npm test` for all, `npm run build` (main + renderer), `npm run lint` (0 errors; warnings allowed).
- User-facing copy: sentence case, no exclamation marks, short.
- npm 12 on this machine skips install scripts: if `node_modules/node-mic/sox-win32/sox.exe` or Electron is missing after an install, run `node ./scripts/postinstall.js` inside `node_modules/node-mic` and `npx install-electron`. Do not run `npm ci` unless something is missing.

---

### Task 1: PCM levels and the silence tracker

**Files:**
- Create: `src/services/audioLevel.ts`
- Test: `src/__tests__/audioLevel.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pcmLevelDb(chunk: Buffer): number` — RMS of 16-bit LE mono PCM in dBFS, floored at `LEVEL_FLOOR_DB` (−60).
  - `meterLevel(db: number): number` — maps −60…0 dBFS to 0…1.
  - `interface SplitFinder { splitPoint(afterSec: number, beforeSec: number, gapSec: number): number | null }`
  - `class SilenceTracker implements SplitFinder { add(startSec: number, durationSec: number, db: number): void; splitPoint(...) }`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/audioLevel.test.ts`:

```ts
import { LEVEL_FLOOR_DB, meterLevel, pcmLevelDb, SilenceTracker } from '../services/audioLevel';

function pcm(values: number[]): Buffer {
  const buffer = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => buffer.writeInt16LE(v, i * 2));
  return buffer;
}

// Feeds 0.25 s chunks of a constant level, as SoX delivers them.
function feed(tracker: SilenceTracker, fromSec: number, toSec: number, db: number): void {
  for (let t = fromSec; t < toSec - 1e-9; t += 0.25) tracker.add(t, 0.25, db);
}

describe('pcmLevelDb', () => {
  it('reports digital silence at the floor', () => {
    expect(pcmLevelDb(pcm([0, 0, 0, 0]))).toBe(LEVEL_FLOOR_DB);
    expect(pcmLevelDb(Buffer.alloc(0))).toBe(LEVEL_FLOOR_DB);
  });

  it('measures full-scale and half-scale signals', () => {
    expect(pcmLevelDb(pcm([32767, -32768, 32767, -32768]))).toBeCloseTo(0, 1);
    expect(pcmLevelDb(pcm([16384, -16384, 16384, -16384]))).toBeCloseTo(-6.02, 1);
  });

  it('ignores a trailing odd byte', () => {
    const odd = Buffer.concat([pcm([16384, -16384]), Buffer.from([7])]);
    expect(pcmLevelDb(odd)).toBeCloseTo(-6.02, 1);
  });
});

describe('meterLevel', () => {
  it('maps -60…0 dBFS onto 0…1 and clamps', () => {
    expect(meterLevel(-60)).toBe(0);
    expect(meterLevel(-30)).toBe(0.5);
    expect(meterLevel(0)).toBe(1);
    expect(meterLevel(-90)).toBe(0);
    expect(meterLevel(3)).toBe(1);
  });
});

describe('SilenceTracker', () => {
  it('splits in the middle of a long pause between two segments', () => {
    const tracker = new SilenceTracker();
    feed(tracker, 0, 3, -20);
    feed(tracker, 3, 10, -45);
    feed(tracker, 10, 12, -20);
    expect(tracker.splitPoint(4, 12.5, 5)).toBe(6.5);
  });

  it('does not split on a short pause', () => {
    const tracker = new SilenceTracker();
    feed(tracker, 0, 3, -20);
    feed(tracker, 3, 6, -45);
    feed(tracker, 6, 8, -20);
    expect(tracker.splitPoint(4, 8.5, 5)).toBeNull();
  });

  it('hears speech from the very first chunk', () => {
    const tracker = new SilenceTracker();
    feed(tracker, 0, 10, -20);
    expect(tracker.splitPoint(1, 10, 5)).toBeNull();
  });

  it('treats a muted microphone as silence', () => {
    const tracker = new SilenceTracker();
    feed(tracker, 0, 2, -20);
    feed(tracker, 2, 9, -60);
    feed(tracker, 9, 10, -20);
    expect(tracker.splitPoint(3, 10.2, 5)).toBe(5.5);
  });

  it('treats steady background noise as silence', () => {
    const tracker = new SilenceTracker();
    feed(tracker, 0, 30, -35);
    feed(tracker, 30, 32, -15);
    feed(tracker, 32, 40, -35);
    feed(tracker, 40, 41, -15);
    expect(tracker.splitPoint(33, 41.5, 5)).toBe(36);
  });

  it('hears quiet speech in a quiet room', () => {
    const tracker = new SilenceTracker();
    feed(tracker, 0, 10, -58);
    feed(tracker, 10, 12, -45);
    feed(tracker, 12, 20, -58);
    feed(tracker, 20, 21, -45);
    expect(tracker.splitPoint(13, 21.5, 5)).toBe(16);
  });

  it('keeps the split between the two segments', () => {
    const tracker = new SilenceTracker();
    feed(tracker, 0, 20, -45);
    expect(tracker.splitPoint(2, 8, 5)).toBe(8);
  });

  it('ignores a pause that ended before the previous segment', () => {
    const tracker = new SilenceTracker();
    feed(tracker, 0, 8, -45);
    feed(tracker, 8, 20, -20);
    expect(tracker.splitPoint(12, 20, 5)).toBeNull();
  });

  it('falls back to the time between segments when there is no audio', () => {
    const tracker = new SilenceTracker();
    expect(tracker.splitPoint(1, 7, 5)).toBe(1);
    expect(tracker.splitPoint(1, 4, 5)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/audioLevel.test.ts`
Expected: FAIL with "Cannot find module '../services/audioLevel'".

- [ ] **Step 3: Write the implementation**

Create `src/services/audioLevel.ts`:

```ts
// Levels of 16-bit little-endian mono PCM, and the silence rule that ends a block (spec §3.1).

export const LEVEL_FLOOR_DB = -60;
const SPEECH_MIN_DB = -50;
const SPEECH_ABOVE_FLOOR_DB = 10;
// A noise floor above this is treated as this, so speech from the first second still counts.
const FLOOR_CAP_DB = -40;
const FLOOR_WINDOW_SEC = 30;
const FLOOR_PERCENTILE = 0.1;
// Chunks further back than this can no longer matter: a block closes after at most blockMinutes.
const KEEP_SEC = 35 * 60;
// Consecutive chunks are exactly adjacent; a larger hole (SoX restarting) ends a run.
const RUN_JOIN_SEC = 0.05;

export function pcmLevelDb(chunk: Buffer): number {
  const samples = Math.floor(chunk.length / 2);
  if (samples === 0) return LEVEL_FLOOR_DB;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const value = chunk.readInt16LE(i * 2);
    sum += value * value;
  }
  const rms = Math.sqrt(sum / samples) / 32768;
  if (rms <= 0) return LEVEL_FLOOR_DB;
  return Math.max(LEVEL_FLOOR_DB, 20 * Math.log10(rms));
}

export function meterLevel(db: number): number {
  return Math.min(1, Math.max(0, (db - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB));
}

export interface SplitFinder {
  // Where the block holding the segment that arrived at afterSec should end, given that the next
  // segment arrived at beforeSec; null to keep both in one block.
  splitPoint(afterSec: number, beforeSec: number, gapSec: number): number | null;
}

interface LevelSample {
  startSec: number;
  endSec: number;
  speech: boolean;
  db: number;
}

export class SilenceTracker implements SplitFinder {
  private samples: LevelSample[] = [];

  add(startSec: number, durationSec: number, db: number): void {
    const threshold = Math.max(SPEECH_MIN_DB, this.noiseFloor(startSec, db) + SPEECH_ABOVE_FLOOR_DB);
    this.samples.push({ startSec, endSec: startSec + durationSec, db, speech: db >= threshold });
    const cutoff = startSec - KEEP_SEC;
    while (this.samples.length > 0 && this.samples[0].endSec < cutoff) this.samples.shift();
  }

  private noiseFloor(atSec: number, current: number): number {
    const recent = this.samples.filter((s) => s.startSec >= atSec - FLOOR_WINDOW_SEC).map((s) => s.db);
    recent.push(current);
    recent.sort((a, b) => a - b);
    return Math.min(recent[Math.floor((recent.length - 1) * FLOOR_PERCENTILE)], FLOOR_CAP_DB);
  }

  splitPoint(afterSec: number, beforeSec: number, gapSec: number): number | null {
    const covered = this.samples.some((s) => s.endSec > afterSec && s.startSec < beforeSec);
    if (!covered) return beforeSec - afterSec >= gapSec ? afterSec : null;

    let best: { start: number; end: number } | null = null;
    let run: { start: number; end: number } | null = null;
    const closeRun = () => {
      if (run && run.end > afterSec && run.start < beforeSec && (!best || run.end - run.start > best.end - best.start)) {
        best = run;
      }
      run = null;
    };
    for (const sample of this.samples) {
      if (sample.speech) {
        closeRun();
        continue;
      }
      if (run && sample.startSec <= run.end + RUN_JOIN_SEC) {
        run.end = sample.endSec;
      } else {
        closeRun();
        run = { start: sample.startSec, end: sample.endSec };
      }
    }
    closeRun();

    const longest = best as { start: number; end: number } | null;
    if (!longest || longest.end - longest.start < gapSec) return null;
    const middle = (longest.start + longest.end) / 2;
    return Math.min(beforeSec, Math.max(afterSec, middle));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/audioLevel.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/audioLevel.ts src/__tests__/audioLevel.test.ts
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Measure audio levels and find pauses between segments

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Record session audio through the app (raw PCM from SoX)

**Files:**
- Create: `src/services/pcmFileSink.ts`
- Create: `src/services/soxPath.ts`
- Modify: `src/services/streamRuntime.ts` (session audio section, `startLiveEngine`, imports)
- Modify: `src/services/streamEngine.ts` (public `elapsedMs()`)
- Modify: `src/services/sessionRuntime.ts` (`audio` field on the context, `sliceAudio`, `audioManifest`)
- Test: `src/__tests__/pcmFileSink.test.ts`, `src/__tests__/streamEngine.test.ts` (add one test)

**Interfaces:**
- Consumes: `pcmLevelDb`, `meterLevel`, `SilenceTracker` from Task 1; `wavHeader`, `WAV_HEADER_BYTES`, `BYTES_PER_SECOND` from `src/services/blockMath.ts`.
- Produces:
  - `class PcmFileSink { constructor(file: string, onChunk: (startSec: number, durationSec: number, chunk: Buffer) => void); write(chunk: Buffer): void; close(): void; readonly dataBytes: number }`
  - `getSoxPath(): string` in `src/services/soxPath.ts` (moved from `recordingService.ts`, which keeps re-exporting it until Task 7 deletes that file).
  - In `streamRuntime.ts`: `interface SessionAudio { entries: { file: string; startSec: number }[]; silence: SilenceTracker }`; `startLiveEngine(args): Promise<SessionAudio>`; `onAudioLevel(listener: (level: number) => void): () => void`. `sessionAudioManifest()` is removed.
  - `StreamEngine.elapsedMs(): number` — milliseconds since the last `start()`, on the same clock as segment `atMs`.

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/pcmFileSink.test.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BYTES_PER_SECOND, WAV_HEADER_BYTES } from '../services/blockMath';
import { PcmFileSink } from '../services/pcmFileSink';

describe('PcmFileSink', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-sink-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes PCM after a header and reports each chunk on the audio clock', () => {
    const file = path.join(dir, 'audio-001.wav');
    const chunks: [number, number, number][] = [];
    const sink = new PcmFileSink(file, (startSec, durationSec, chunk) => chunks.push([startSec, durationSec, chunk.length]));
    const quarter = BYTES_PER_SECOND / 4;
    sink.write(Buffer.alloc(quarter, 1));
    sink.write(Buffer.alloc(quarter, 2));

    expect(chunks).toEqual([
      [0, 0.25, quarter],
      [0.25, 0.25, quarter],
    ]);
    expect(sink.dataBytes).toBe(quarter * 2);
    // Readable while recording: the data sits after a 44-byte header.
    const whileRecording = fs.readFileSync(file);
    expect(whileRecording.length).toBe(WAV_HEADER_BYTES + quarter * 2);
    expect(whileRecording.toString('ascii', 0, 4)).toBe('RIFF');
    expect(whileRecording[WAV_HEADER_BYTES + quarter]).toBe(2);
    sink.close();
  });

  it('patches the header sizes on close, once', () => {
    const file = path.join(dir, 'audio-001.wav');
    const sink = new PcmFileSink(file, () => undefined);
    sink.write(Buffer.alloc(1000));
    sink.close();
    sink.close();
    sink.write(Buffer.alloc(500));

    const wav = fs.readFileSync(file);
    expect(wav.length).toBe(WAV_HEADER_BYTES + 1000);
    expect(wav.readUInt32LE(4)).toBe(36 + 1000);
    expect(wav.readUInt32LE(40)).toBe(1000);
  });

  it('ignores empty chunks', () => {
    const calls: number[] = [];
    const sink = new PcmFileSink(path.join(dir, 'a.wav'), (start) => calls.push(start));
    sink.write(Buffer.alloc(0));
    sink.close();
    expect(calls).toEqual([]);
  });
});
```

In `src/__tests__/streamEngine.test.ts`, find how the existing tests build an engine (a fake `now` is passed in `StreamEngineDeps`). Add this test inside the top-level `describe`, reusing the file's existing helper for building an engine with a controllable clock (read the top of the file first; if the helper is named differently, use it and keep the assertions):

```ts
  it('reports the time since start on the segment clock', async () => {
    let now = 1_000;
    const engine = new StreamEngine({
      resolveBinary: () => null,
      spawnStream: () => {
        throw new Error('not spawned');
      },
      writeLog: () => undefined,
      now: () => now,
    });
    await engine.start({ modelPath: 'm', language: 'en', captureId: null, forceCpu: false, cwd: '.', threads: 2 });
    now = 4_500;
    expect(engine.elapsedMs()).toBe(3_500);
  });
```

(`resolveBinary: () => null` makes `start()` fail fast with an error status and no process, which is fine for this test.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/__tests__/pcmFileSink.test.ts src/__tests__/streamEngine.test.ts`
Expected: FAIL — "Cannot find module '../services/pcmFileSink'" and "engine.elapsedMs is not a function".

- [ ] **Step 3: Implement the sink and the engine clock**

Create `src/services/pcmFileSink.ts`:

```ts
import * as fs from 'fs';
import { BYTES_PER_SECOND, WAV_HEADER_BYTES, wavHeader } from './blockMath';

// Writes SoX's raw PCM into a WAV file as it arrives. The header goes in first with a zero size
// and is patched on close; until then the data is still sliceable by byte offset (spec §4.5).
export class PcmFileSink {
  private readonly fd: number;
  private bytes = 0;
  private closed = false;

  constructor(
    readonly file: string,
    private readonly onChunk: (startSec: number, durationSec: number, chunk: Buffer) => void,
  ) {
    this.fd = fs.openSync(file, 'w');
    fs.writeSync(this.fd, wavHeader(0));
  }

  get dataBytes(): number {
    return this.bytes;
  }

  write(chunk: Buffer): void {
    if (this.closed || chunk.length === 0) return;
    fs.writeSync(this.fd, chunk);
    const startSec = this.bytes / BYTES_PER_SECOND;
    this.bytes += chunk.length;
    this.onChunk(startSec, chunk.length / BYTES_PER_SECOND, chunk);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      fs.writeSync(this.fd, wavHeader(this.bytes), 0, WAV_HEADER_BYTES, 0);
    } finally {
      fs.closeSync(this.fd);
    }
  }
}
```

In `src/services/streamEngine.ts`, rename the private method `elapsed()` to a public `elapsedMs()` and update its two callers (`handleLine`: `const atMs = this.elapsedMs();` and `const segment = { text: event.text, atMs: this.elapsedMs() };`):

```ts
  // Milliseconds since start(), on the clock segment and launch times use.
  elapsedMs(): number {
    return this.deps.now() - this.startedAt;
  }
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/__tests__/pcmFileSink.test.ts src/__tests__/streamEngine.test.ts`
Expected: PASS.

- [ ] **Step 5: Move `getSoxPath` into its own module**

Create `src/services/soxPath.ts` with the body of `getSoxPath` moved verbatim from `src/services/recordingService.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

// The SoX binary bundled with node-mic: unpacked next to app.asar when packaged, in
// node_modules in development, else whatever is on PATH.
export function getSoxPath(): string {
  const appPath = app.getAppPath();
  if (appPath.includes('.asar')) {
    const resourcesDir = path.dirname(appPath);
    const asarPath = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'node-mic', 'sox-win32', 'sox.exe');
    if (fs.existsSync(asarPath)) return asarPath;
  }
  const devPath = path.join(appPath, 'node_modules', 'node-mic', 'sox-win32', 'sox.exe');
  if (fs.existsSync(devPath)) return devPath;
  return 'sox';
}
```

In `src/services/recordingService.ts`, delete the `getSoxPath` function body and its doc comment, and add near the imports:

```ts
import { getSoxPath } from './soxPath';

export { getSoxPath };
```

(Its own calls to `getSoxPath()` keep working. Task 7 deletes this file.)

- [ ] **Step 6: Record session audio from SoX's stdout**

In `src/services/streamRuntime.ts`:

Replace the imports block's `import { getSoxPath } from './recordingService';` with:

```ts
import { meterLevel, pcmLevelDb, SilenceTracker } from './audioLevel';
import { PcmFileSink } from './pcmFileSink';
import { getSoxPath } from './soxPath';
```

Add below `const SOX_EXIT_WAIT_MS = 5000;`:

```ts
// The renderer's level meter needs no more than this.
const LEVEL_INTERVAL_MS = 100;
```

Replace everything from the comment `// --- Session audio recording (SoX) ---` down to the end of `stopSessionAudio()` with:

```ts
// --- Session audio recording (SoX) ---
//
// whisper-stream's own --save-audio is not real-time (in VAD mode it rewrites its 2-second
// buffer ~10x/second), so we record session audio ourselves with the bundled SoX, which can hold
// the microphone at the same time whisper-stream does. SoX sends raw 16 kHz mono PCM to stdout;
// we write the WAV and measure each chunk's level, which drives the level meter and the silence
// rule that ends a block (spec §3.1, §4.5). SoX's own -S level display is buffered until it exits
// when stderr is a pipe, so it cannot be used for this.
export interface SessionAudio {
  // One entry per SoX process; a crashed recorder is restarted into a new file.
  entries: { file: string; startSec: number }[];
  silence: SilenceTracker;
}

let soxChild: ReturnType<typeof spawn> | null = null;
let soxClosed: Promise<void> = Promise.resolve();
let sessionStartedAt = 0;
let soxGeneration = 0;
let soxRestartCount = 0;
let sessionAudioActive = false;
let currentAudioIndex = 0;
let currentSessionDir = '';
let currentDeviceName = '';
let lastLevelAt = 0;
const levelListeners = new Set<(level: number) => void>();

export function onAudioLevel(listener: (level: number) => void): () => void {
  levelListeners.add(listener);
  return () => levelListeners.delete(listener);
}

function emitLevel(db: number): void {
  const now = Date.now();
  if (now - lastLevelAt < LEVEL_INTERVAL_MS) return;
  lastLevelAt = now;
  const level = meterLevel(db);
  for (const listener of levelListeners) listener(level);
}

function spawnSoxSegment(session: SessionAudio): void {
  currentAudioIndex += 1;
  const generation = ++soxGeneration;
  const file = path.join(currentSessionDir, audioFileName(currentAudioIndex));
  const device = currentDeviceName || 'default';
  const offsetSec = (Date.now() - sessionStartedAt) / 1000;

  let sink: PcmFileSink;
  try {
    sink = new PcmFileSink(file, (startSec, durationSec, chunk) => {
      const db = pcmLevelDb(chunk);
      session.silence.add(offsetSec + startSec, durationSec, db);
      emitLevel(db);
    });
  } catch (error) {
    console.error('Could not create the session audio file:', error);
    return;
  }
  session.entries.push({ file, startSec: offsetSec });

  const child = spawn(
    getSoxPath(),
    ['-q', '-t', 'waveaudio', device, '-r', '16000', '-c', '1', '-b', '16', '-e', 'signed-integer', '-t', 'raw', '-'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  soxChild = child;
  child.stdout?.on('data', (chunk: Buffer) => sink.write(chunk));
  child.stderr?.on('data', (chunk) => {
    console.error('sox (session audio) stderr:', chunk.toString());
  });

  let handled = false;
  let resolveClosed: () => void = () => undefined;
  soxClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  // 'close' fires once the process has exited and stdout is drained, so the WAV is complete.
  const onEnded = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (handled) return;
    handled = true;
    try {
      sink.close();
    } catch (error) {
      console.error('Could not finish the session audio file:', error);
    }
    resolveClosed();
    if (generation !== soxGeneration) return;
    soxChild = null;
    if (!sessionAudioActive) return;
    if (soxRestartCount >= MAX_SOX_RESTARTS) {
      console.error(
        `Session audio recorder (SoX) stopped (code ${code}, signal ${signal}) and the retry budget (${MAX_SOX_RESTARTS}) is exhausted; session audio recording has stopped for the rest of this session.`
      );
      return;
    }
    soxRestartCount += 1;
    console.error(
      `Session audio recorder (SoX) stopped unexpectedly (code ${code}, signal ${signal}); restarting (attempt ${soxRestartCount}/${MAX_SOX_RESTARTS}).`
    );
    spawnSoxSegment(session);
  };
  child.on('close', (code, signal) => onEnded(code, signal));
  child.on('error', (error) => {
    console.error('Failed to start the session audio recorder (SoX):', error);
    onEnded(null, null);
  });
}

export function startSessionAudio(sessionDir: string, deviceName: string): SessionAudio {
  currentSessionDir = sessionDir;
  currentDeviceName = deviceName;
  currentAudioIndex = 0;
  soxRestartCount = 0;
  sessionAudioActive = true;
  const session: SessionAudio = { entries: [], silence: new SilenceTracker() };
  spawnSoxSegment(session);
  return session;
}

// Resolves once SoX has exited and its WAV is finished (or after SOX_EXIT_WAIT_MS): until then
// Windows will not let the session audio be deleted.
export function stopSessionAudio(): Promise<void> {
  sessionAudioActive = false;
  soxGeneration++;
  const child = soxChild;
  soxChild = null;
  const closed = soxClosed;
  if (!child) return closed;
  const waited = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, SOX_EXIT_WAIT_MS);
    void closed.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  try {
    child.stdin?.write('q');
  } catch {
    // sox may already be gone; nothing to do.
  }
  child.kill();
  return waited;
}
```

Replace `startLiveEngine` with:

```ts
export async function startLiveEngine(args: { sessionId: string; captureId: number | null; deviceName?: string }): Promise<SessionAudio> {
  const settings = getSettings();
  const modelPath = resolveLiveModelPath();
  if (!modelPath) {
    throw new Error(`Live model ${settings.liveModelId} is not installed`);
  }
  const cwd = createSessionDir(args.sessionId);
  sessionStartedAt = Date.now();
  // Start our own session-audio recorder before the engine, and never stop it on an
  // engine restart: SoX must keep running across whisper-stream crashes/restarts so the
  // audio timeline (and the manifest block-refinement will slice by) stays continuous.
  const session = startSessionAudio(cwd, args.deviceName ?? '');
  await streamEngine.start({
    modelPath,
    language: settings.language,
    captureId: args.captureId,
    forceCpu: settings.forceCpu,
    cwd,
    threads: Math.max(2, Math.min(8, os.cpus().length - 2)),
  });
  return session;
}
```

Delete the old `sessionAudioManifest()` export.

- [ ] **Step 7: Give each session its own audio in `sessionRuntime.ts`**

In `src/services/sessionRuntime.ts`:

1. Change the streamRuntime import to:
```ts
import { SessionAudio, startLiveEngine, stopLiveEngine, streamEngine, sessionsRoot } from './streamRuntime';
```
2. Add to `interface SessionContext`, after `refineModel: string;`:
```ts
  // Set once the recorder starts; each run keeps its own, so an older run can still be refined.
  audio: SessionAudio | null;
```
3. Replace `audioManifest()` with:
```ts
// Durations are derived from the files' current size, because the newest file is still growing.
function audioManifest(ctx: SessionContext): AudioEntry[] {
  return (ctx.audio?.entries ?? []).map((entry) => {
    let size = 0;
    try {
      size = fs.statSync(entry.file).size;
    } catch {
      // Not written yet: treat as empty.
    }
    return {
      file: entry.file,
      startSec: entry.startSec,
      durationSec: Math.max(0, (size - WAV_HEADER_BYTES) / BYTES_PER_SECOND),
    };
  });
}
```
4. In `sliceAudio`, delete these three lines:
```ts
  // The recorder's manifest is replaced when the next session starts; an older session's audio
  // can no longer be located after that.
  if (current !== ctx) return null;
```
and change `slicesForRange(audioManifest(), job.startSec, job.endSec)` to `slicesForRange(audioManifest(ctx), job.startSec, job.endSec)`.
5. In the `ctx = { ... }` literal in `startSession`, add `audio: null,` after `refineModel: ...,`.
6. Replace
```ts
    await startLiveEngine({ sessionId: id, captureId: device?.index ?? null, deviceName: device?.name });
```
with
```ts
    ctx.audio = await startLiveEngine({ sessionId: id, captureId: device?.index ?? null, deviceName: device?.name });
```

- [ ] **Step 8: Build, test, lint**

Run: `npm run build && npm test && npm run lint`
Expected: build succeeds; all suites pass; lint 0 errors.

- [ ] **Step 9: Probe the recorder once (no speech needed)**

Run this from the repo root; it records 3 s of room sound into the scratch file, checks the WAV and deletes it:

```bash
node -e "
const {spawn}=require('child_process');const fs=require('fs');const os=require('os');const path=require('path');
const {PcmFileSink}=require('./dist/services/pcmFileSink');const {pcmLevelDb}=require('./dist/services/audioLevel');
const file=path.join(os.tmpdir(),'dw-sink-probe.wav');const levels=[];
const sink=new PcmFileSink(file,(s,d,c)=>levels.push(pcmLevelDb(c).toFixed(1)));
const c=spawn('node_modules/node-mic/sox-win32/sox.exe',['-q','-t','waveaudio','default','-r','16000','-c','1','-b','16','-e','signed-integer','-t','raw','-'],{stdio:['pipe','pipe','pipe']});
c.stdout.on('data',d=>sink.write(d));
setTimeout(()=>{c.stdin.write('q');c.kill();},3000);
c.on('close',()=>{sink.close();const w=fs.readFileSync(file);console.log('bytes',w.length,'dataSize',w.readUInt32LE(40),'levels',levels.join(' '));fs.rmSync(file);});
"
```

Expected: `dataSize` ≈ 90000 (±10000) and equal to `bytes − 44`; about 11 level values between −60 and 0.

- [ ] **Step 10: Commit**

```bash
git add src/services/pcmFileSink.ts src/services/soxPath.ts src/services/recordingService.ts src/services/streamRuntime.ts src/services/streamEngine.ts src/services/sessionRuntime.ts src/__tests__/pcmFileSink.test.ts src/__tests__/streamEngine.test.ts
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Record session audio through the app and measure its level

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Clock lines and the daily quick-note file

**Files:**
- Modify: `src/services/documentStore.ts`
- Create: `src/services/quickNotes.ts`
- Modify: `src/shared/api.ts` (add `SessionKind` and `SessionStartRequest` types)
- Test: `src/__tests__/documentStore.test.ts` (add tests), `src/__tests__/quickNotes.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (in `documentStore.ts`):
  - `CLOCK_LINE: RegExp`, `isClockLine(line: string): boolean`
  - `localDateStamp(date: Date): string` → `'2026-09-16'`
  - `formatClockLine(date: Date, withDate: boolean): string` → `'**14:32**'` / `'**2026-09-16 14:32**'`
  - `nextBlockIndex(content: string): number`
  - `DocumentStore.setBlockRange(file: string, block: BlockRef): void`
  - `DocumentStore.openOrCreate(file: string, fm: Frontmatter): string` (returns the file's content)
- Produces (in `quickNotes.ts`):
  - `QUICK_NOTES_FOLDER = 'Quick Notes'`
  - `quickNotePath(vaultPath: string, date: Date): string`
  - `interface QuickNoteTarget { documentPath: string; folder: string; firstBlockIndex: number; baseDurationSec: number }`
  - `prepareQuickNote(store: DocumentStore, vaultPath: string, date: Date, fm: Omit<Frontmatter, 'title'>): QuickNoteTarget`
  - `startRefusal(running: SessionKind | null, requested: SessionKind): string | null`
  - `parseStartRequest(value: unknown): SessionStartRequest`
- Produces (in `src/shared/api.ts`): `type SessionKind = 'session' | 'quick-note'`; `type SessionStartRequest = { kind: 'session'; folder: string } | { kind: 'quick-note' }`.

- [ ] **Step 1: Add the shared types**

In `src/shared/api.ts`, add after `export type BlockState = ...;`:

```ts
export type SessionKind = 'session' | 'quick-note';
export type SessionStartRequest = { kind: 'session'; folder: string } | { kind: 'quick-note' };
```

- [ ] **Step 2: Write the failing tests**

Append to `src/__tests__/documentStore.test.ts` (and add `formatClockLine, isClockLine, localDateStamp, nextBlockIndex` to its import from `'../services/documentStore'`):

```ts
describe('clock lines', () => {
  const at = new Date(2026, 8, 6, 9, 5);

  it('formats a local time, with the date for the first block of a run', () => {
    expect(formatClockLine(at, false)).toBe('**09:05**');
    expect(formatClockLine(at, true)).toBe('**2026-09-06 09:05**');
    expect(localDateStamp(at)).toBe('2026-09-06');
  });

  it('recognises only whole clock lines', () => {
    expect(isClockLine('**14:32**')).toBe(true);
    expect(isClockLine('  **2026-09-16 14:32**  ')).toBe(true);
    expect(isClockLine('**14:32** said hello')).toBe(false);
    expect(isClockLine('**bold**')).toBe(false);
  });

  it('numbers new blocks after the highest existing one', () => {
    expect(nextBlockIndex('no markers here')).toBe(1);
    expect(nextBlockIndex('<!-- dw:block 1 t=0-5 -->\nx\n<!-- dw:block 3 t=9-12 -->\ny\n<!-- dw:block 2 t=5-9 -->\n')).toBe(4);
    expect(nextBlockIndex('<!-- dw:block 7 t=0-5 -->\r\nx\r\n')).toBe(8);
  });

  it('leaves the clock line out of the text refinement sees', () => {
    const content = '<!-- dw:block 1 t=0-5 -->\n**14:32**\nhello there\n';
    expect(blockTextFrom(content, 1)).toBe('hello there');
  });
});

describe('DocumentStore with clock lines', () => {
  let vault: string;
  let store: DocumentStore;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-clock-'));
    store = new DocumentStore(vault);
  });

  afterEach(() => fs.rmSync(vault, { recursive: true, force: true }));

  it('starts the text on the line after the clock line', () => {
    const file = store.createDocument('s1', FM);
    store.openBlock(file, { index: 1, startSec: 0, endSec: 0 }, '**14:32**');
    store.appendSegment(file, 'hello');
    store.appendSegment(file, 'there');
    expect(fs.readFileSync(file, 'utf8')).toContain('<!-- dw:block 1 t=0-0 -->\n**14:32**\nhello there\n');
  });

  it('keeps the clock line when refinement replaces the block', () => {
    const file = store.createDocument('s1', FM);
    store.openBlock(file, { index: 1, startSec: 0, endSec: 0 }, '**2026-09-16 14:32**');
    store.appendSegment(file, 'rough words');
    expect(store.replaceBlock(file, 1, 'Rough words.', hashText('rough words'))).toBe('replaced');
    expect(fs.readFileSync(file, 'utf8')).toContain('<!-- dw:block 1 t=0-0 -->\n**2026-09-16 14:32**\nRough words.\n');
  });

  it('rewrites a block marker with its final range, keeping the line ending', () => {
    const file = store.createDocument('s1', FM);
    store.openBlock(file, { index: 1, startSec: 3, endSec: 3 }, '**14:32**');
    store.appendSegment(file, 'one');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
    store.setBlockRange(file, { index: 1, startSec: 3, endSec: 9 });
    store.setBlockRange(file, { index: 5, startSec: 0, endSec: 1 });
    expect(fs.readFileSync(file, 'utf8')).toContain('<!-- dw:block 1 t=3-9 -->\r\n**14:32**\r\none');
  });

  it('creates a missing daily file with its folder and leaves an existing one alone', () => {
    const file = path.join(vault, 'Quick Notes', '2026-09-16.md');
    const created = store.openOrCreate(file, { ...FM, title: '2026-09-16' });
    expect(created).toContain('title: 2026-09-16');
    fs.appendFileSync(file, 'kept\n');
    const again = store.openOrCreate(file, { ...FM, title: 'other' });
    expect(again).toContain('kept');
    expect(again).not.toContain('title: other');
  });

  it('refuses a folder that has the daily file name', () => {
    const file = path.join(vault, 'Quick Notes', '2026-09-16.md');
    fs.mkdirSync(file, { recursive: true });
    expect(() => store.openOrCreate(file, FM)).toThrow();
  });
});
```

Create `src/__tests__/quickNotes.test.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DocumentStore, Frontmatter } from '../services/documentStore';
import { parseStartRequest, prepareQuickNote, quickNotePath, startRefusal } from '../services/quickNotes';

const FM: Omit<Frontmatter, 'title'> = {
  created: '2026-09-16T12:00:00Z',
  updated: '2026-09-16T12:00:00Z',
  duration: 0,
  language: 'en',
  liveModel: 'ggml-base.en.bin',
  refineModel: 'ggml-large-v3-turbo-q5_0.bin',
  app: 'dark-whisper 1.3.0',
};

describe('quick notes', () => {
  let vault: string;
  let store: DocumentStore;
  const day = new Date(2026, 8, 16, 23, 59);

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-quick-'));
    store = new DocumentStore(vault);
  });

  afterEach(() => fs.rmSync(vault, { recursive: true, force: true }));

  it('names the file after the local date', () => {
    expect(quickNotePath(vault, day)).toBe(path.join(vault, 'Quick Notes', '2026-09-16.md'));
  });

  it('creates the folder and the day file, titled with the date', () => {
    const target = prepareQuickNote(store, vault, day, FM);
    expect(target).toEqual({
      documentPath: path.join(vault, 'Quick Notes', '2026-09-16.md'),
      folder: 'Quick Notes',
      firstBlockIndex: 1,
      baseDurationSec: 0,
    });
    const content = fs.readFileSync(target.documentPath, 'utf8');
    expect(content.startsWith('---\ntitle: 2026-09-16\n')).toBe(true);
  });

  it('continues numbering and duration from an existing day file', () => {
    const file = quickNotePath(vault, day);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      '---\r\ntitle: 2026-09-16\r\nduration: 125\r\n---\r\n\r\n<!-- dw:block 1 t=0-4 -->\r\n**2026-09-16 09:00**\r\nfirst\r\n\r\n<!-- dw:block 2 t=10-14 -->\r\n**09:01**\r\nsecond\r\n',
    );
    const target = prepareQuickNote(store, vault, day, FM);
    expect(target.firstBlockIndex).toBe(3);
    expect(target.baseDurationSec).toBe(125);
    expect(fs.readFileSync(file, 'utf8')).toContain('second');
  });

  it('accepts a day file written by hand', () => {
    const file = quickNotePath(vault, day);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# My notes\n\nremember milk\n');
    const target = prepareQuickNote(store, vault, day, FM);
    expect(target.firstBlockIndex).toBe(1);
    expect(target.baseDurationSec).toBe(0);
  });

  it('explains when the day file cannot be opened', () => {
    fs.mkdirSync(quickNotePath(vault, day), { recursive: true });
    expect(() => prepareQuickNote(store, vault, day, FM)).toThrow(/^Could not open today's quick note \(Quick Notes[\\/]2026-09-16\.md\): /);
  });

  it('refuses to start one mode while the other records', () => {
    expect(startRefusal(null, 'quick-note')).toBeNull();
    expect(startRefusal(null, 'session')).toBeNull();
    expect(startRefusal('session', 'quick-note')).toBe('Stop the session before starting a quick note.');
    expect(startRefusal('quick-note', 'session')).toBe('Stop the quick note before starting a session.');
    expect(startRefusal('session', 'session')).toBe('A session is already recording.');
    expect(startRefusal('quick-note', 'quick-note')).toBe('A quick note is already recording.');
  });

  it('reads a start request from the renderer defensively', () => {
    expect(parseStartRequest({ kind: 'quick-note' })).toEqual({ kind: 'quick-note' });
    expect(parseStartRequest({ kind: 'session', folder: 'Work' })).toEqual({ kind: 'session', folder: 'Work' });
    expect(parseStartRequest({ kind: 'session' })).toEqual({ kind: 'session', folder: '' });
    expect(parseStartRequest('Work')).toEqual({ kind: 'session', folder: 'Work' });
    expect(parseStartRequest(undefined)).toEqual({ kind: 'session', folder: '' });
    expect(parseStartRequest({ kind: 'other', folder: 3 })).toEqual({ kind: 'session', folder: '' });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest src/__tests__/documentStore.test.ts src/__tests__/quickNotes.test.ts`
Expected: FAIL — missing exports / missing module.

- [ ] **Step 4: Implement in `documentStore.ts`**

Add after `hashText`:

```ts
// A block's clock line (spec §3.2): **14:32**, or **2026-09-16 14:32** for the first block of a run.
export const CLOCK_LINE = /^\*\*(\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}\*\*$/;

export function isClockLine(line: string): boolean {
  return CLOCK_LINE.test(line.trim());
}

const pad2 = (value: number) => String(value).padStart(2, '0');

export function localDateStamp(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function formatClockLine(date: Date, withDate: boolean): string {
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return withDate ? `**${localDateStamp(date)} ${time}**` : `**${time}**`;
}
```

In `blockTextFrom`, change the filter to:

```ts
    .filter((line) => !line.trim().startsWith('#') && line.trim() !== '<!-- dw:gap -->' && !isClockLine(line))
```

and update its comment to `// The text of one block as refinement sees it: no marker, headings, clock line or gap markers.`

Add after `blockIndexes`:

```ts
// The index for the first block appended to an existing document.
export function nextBlockIndex(content: string): number {
  return Math.max(0, ...blockIndexes(content)) + 1;
}
```

In `appendSegment`, change the `continuing` line to:

```ts
    const continuing =
      lastLine.length > 0 && !lastLine.startsWith('<!--') && !lastLine.startsWith('#') && !isClockLine(lastLine);
```

In `replaceBlock`, change the `headings` filter to keep clock lines too:

```ts
    const headings = bounds.lines
      .slice(bounds.startLine + 1, bounds.endLine)
      .filter((line) => line.trim().startsWith('#') || isClockLine(line));
```

Add these methods to `DocumentStore`, after `openBlock`:

```ts
  // A block's end is only known when it closes; the marker is rewritten then.
  setBlockRange(file: string, block: BlockRef): void {
    const lines = this.read(file).split('\n');
    const range = blockLineRange(lines, block.index);
    if (!range) return;
    const ending = lines[range.start].endsWith('\r') ? '\r' : '';
    lines[range.start] = `${blockMarker(block)}${ending}`;
    this.write(file, lines.join('\n'));
  }

  // The daily quick note: created with its folder and frontmatter if missing, otherwise left as
  // it is. Returns the file's content.
  openOrCreate(file: string, fm: Frontmatter): string {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(file, `${formatFrontmatter(fm)}\n`, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return this.read(file);
  }
```

- [ ] **Step 5: Create `src/services/quickNotes.ts`**

```ts
import * as path from 'path';
import type { SessionKind, SessionStartRequest } from '../shared/api';
import { DocumentStore, Frontmatter, localDateStamp, nextBlockIndex, parseFrontmatter } from './documentStore';

export const QUICK_NOTES_FOLDER = 'Quick Notes';

export interface QuickNoteTarget {
  documentPath: string;
  folder: string;
  firstBlockIndex: number;
  baseDurationSec: number;
}

export function quickNotePath(vaultPath: string, date: Date): string {
  return path.join(vaultPath, QUICK_NOTES_FOLDER, `${localDateStamp(date)}.md`);
}

// Today's quick note (spec §3.4): created if missing, else appended to after its last block.
export function prepareQuickNote(
  store: DocumentStore,
  vaultPath: string,
  date: Date,
  fm: Omit<Frontmatter, 'title'>,
): QuickNoteTarget {
  const documentPath = quickNotePath(vaultPath, date);
  let content: string;
  try {
    content = store.openOrCreate(documentPath, { title: localDateStamp(date), ...fm });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const name = path.join(QUICK_NOTES_FOLDER, `${localDateStamp(date)}.md`);
    throw new Error(`Could not open today's quick note (${name}): ${reason}`);
  }
  const duration = Number(parseFrontmatter(content.replace(/\r\n/g, '\n')).frontmatter.duration);
  return {
    documentPath,
    folder: QUICK_NOTES_FOLDER,
    firstBlockIndex: nextBlockIndex(content),
    baseDurationSec: Number.isFinite(duration) && duration > 0 ? duration : 0,
  };
}

const KIND_NAMES: Record<SessionKind, string> = { session: 'session', 'quick-note': 'quick note' };

// Sessions and quick notes share one microphone and one live engine: only one records at a time.
export function startRefusal(running: SessionKind | null, requested: SessionKind): string | null {
  if (running === null) return null;
  if (running === requested) return `A ${KIND_NAMES[running]} is already recording.`;
  return `Stop the ${KIND_NAMES[running]} before starting a ${KIND_NAMES[requested]}.`;
}

export function parseStartRequest(value: unknown): SessionStartRequest {
  if (typeof value === 'string') return { kind: 'session', folder: value };
  if (value && typeof value === 'object') {
    const request = value as { kind?: unknown; folder?: unknown };
    if (request.kind === 'quick-note') return { kind: 'quick-note' };
    if (request.kind === 'session') {
      return { kind: 'session', folder: typeof request.folder === 'string' ? request.folder : '' };
    }
  }
  return { kind: 'session', folder: '' };
}
```

- [ ] **Step 6: Run tests**

Run: `npx jest src/__tests__/documentStore.test.ts src/__tests__/quickNotes.test.ts src/__tests__/guardedStore.test.ts src/__tests__/sessionOutsideEdit.test.ts`
Expected: PASS.

- [ ] **Step 7: Build and lint**

Run: `npm run build && npm run lint`
Expected: success, 0 errors.

- [ ] **Step 8: Commit**

```bash
git add src/services/documentStore.ts src/services/quickNotes.ts src/shared/api.ts src/__tests__/documentStore.test.ts src/__tests__/quickNotes.test.ts
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Add clock lines and the daily quick-note file

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---
### Task 4: Blocks are paragraphs

**Files:**
- Modify (rewrite): `src/services/sessionService.ts`
- Modify: `src/services/guardedStore.ts` (add `setBlockRange` pass-through)
- Modify: `src/services/blockMath.ts` (remove `blockRange` and `formatTimestampHeading`)
- Modify: `src/services/settingsMigration.ts`, `src/services/settingsService.ts`, `src/shared/api.ts` (`silenceGapSeconds`, `theme`; drop `timestampHeadings`)
- Modify: `src/services/sessionRuntime.ts` (new service deps; pause/stop times)
- Modify: `src/renderer/dialogs.ts`, `public/index.html` (silence-gap field replaces the timestamp-headings checkbox)
- Test (rewrite): `src/__tests__/sessionService.test.ts`
- Test: `src/__tests__/sessionOutsideEdit.test.ts`, `src/__tests__/blockMath.test.ts`, `src/__tests__/settingsMigration.test.ts`

**Interfaces:**
- Consumes: `SplitFinder`, `SilenceTracker` (Task 1); `formatClockLine`, `DocumentStore.setBlockRange` (Task 3); `StreamEngine.elapsedMs()` and `SessionContext.audio` (Task 2).
- Produces:
  - `SessionStoreLike` = `{ openBlock(file, block, heading?); setBlockRange(file, block); appendSegment(file, text); readBlockText(file, index); replaceBlock(file, index, text, expectedHash); updateFrontmatter(file, { duration }) }` (no `appendLine`).
  - `SessionDeps` = `{ store; enqueueRefine(job); blockMinutes: number; silenceGapSec: number; silence: SplitFinder; now(): Date }`.
  - `SessionBlockEvent` gains `clock: string` (the block's clock line, e.g. `'**14:32**'`).
  - `SessionService.begin({ id, documentPath, firstBlockIndex?, baseDurationSec? })`, `setPaused(paused: boolean, atMs: number)`, `end(atMs?: number)`. `getInfo().blockIndex` is the open block's index, or 0 between blocks.
  - `settingsMigration.ts`: `DEFAULT_SILENCE_GAP_SECONDS = 5`, `clampSilenceGap(value: unknown): number`, `normalizeTheme(value: unknown): ThemeName`.
  - `src/shared/api.ts`: `type ThemeName = 'dark' | 'light'`; `SettingsView` gains `silenceGapSeconds: number; theme: ThemeName` and loses `timestampHeadings`.

- [ ] **Step 1: Write the failing tests**

Replace the whole of `src/__tests__/sessionService.test.ts` with:

```ts
import { BlockRef, hashText } from '../services/documentStore';
import { RefineJob, SessionBlockEvent, SessionService, SessionStoreLike } from '../services/sessionService';

type SplitFn = (afterSec: number, beforeSec: number, gapSec: number) => number | null;

const DATE_CLOCK = '**2026-09-16 14:32**';

function fakeStore() {
  const blocks = new Map<number, string>();
  const opened: { block: BlockRef; heading?: string }[] = [];
  const ranges: BlockRef[] = [];
  let duration = -1;
  let last = 0;
  const store: SessionStoreLike = {
    openBlock: (_file, block, heading) => {
      blocks.set(block.index, '');
      opened.push({ block, heading });
      last = block.index;
    },
    setBlockRange: (_file, block) => {
      ranges.push(block);
    },
    appendSegment: (_file, text) => {
      const current = blocks.get(last) ?? '';
      blocks.set(last, current ? `${current} ${text}` : text);
    },
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
  return { store, blocks, opened, ranges, getDuration: () => duration };
}

function setup(options: { blockMinutes?: number; split?: SplitFn; firstBlockIndex?: number; baseDurationSec?: number } = {}) {
  const fake = fakeStore();
  const jobs: RefineJob[] = [];
  const events: SessionBlockEvent[] = [];
  const calls: [number, number, number][] = [];
  const clock = { now: new Date(2026, 8, 16, 14, 32) };
  const split = options.split ?? (() => null);
  const service = new SessionService({
    store: fake.store,
    enqueueRefine: (job) => jobs.push(job),
    blockMinutes: options.blockMinutes ?? 2,
    silenceGapSec: 5,
    silence: {
      splitPoint: (afterSec, beforeSec, gapSec) => {
        calls.push([afterSec, beforeSec, gapSec]);
        return split(afterSec, beforeSec, gapSec);
      },
    },
    now: () => clock.now,
  });
  service.onBlock((event) => events.push(event));
  service.begin({
    id: 's1',
    documentPath: 'C:/vault/s1.md',
    firstBlockIndex: options.firstBlockIndex,
    baseDurationSec: options.baseDurationSec,
  });
  return { service, jobs, events, calls, clock, ...fake };
}

describe('SessionService', () => {
  it('starts recording without writing anything until words arrive', () => {
    const ctx = setup();
    expect(ctx.service.getInfo()).toEqual({
      id: 's1',
      documentPath: 'C:/vault/s1.md',
      state: 'recording',
      blockIndex: 0,
      durationSec: 0,
    });
    expect(ctx.opened).toEqual([]);
    expect(ctx.events).toEqual([]);
  });

  it('opens the first paragraph with the date and time when the first words arrive', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'hello', atMs: 1_000 });
    ctx.service.segment({ text: 'world', atMs: 4_500 });
    expect(ctx.opened).toEqual([{ block: { index: 1, startSec: 0, endSec: 0 }, heading: DATE_CLOCK }]);
    expect(ctx.blocks.get(1)).toBe('hello world');
    expect(ctx.service.getInfo()).toMatchObject({ blockIndex: 1, durationSec: 4.5 });
    expect(ctx.events).toEqual([{ blockIndex: 1, startSec: 0, endSec: 0, state: 'live', clock: DATE_CLOCK }]);
  });

  it('asks about the pause between the last two segments of the open paragraph', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'one', atMs: 4_000 });
    ctx.service.segment({ text: 'two', atMs: 6_000 });
    ctx.service.segment({ text: 'three', atMs: 9_000 });
    expect(ctx.calls).toEqual([
      [4, 6, 5],
      [6, 9, 5],
    ]);
    expect(ctx.blocks.get(1)).toBe('one two three');
    expect(ctx.jobs).toEqual([]);
  });

  it('ends a paragraph at a pause and starts the next with the time', () => {
    const ctx = setup({ split: (after, before) => (after === 4 && before === 12.5 ? 6.5 : null) });
    ctx.service.segment({ text: 'one', atMs: 4_000 });
    ctx.clock.now = new Date(2026, 8, 16, 14, 35);
    ctx.service.segment({ text: 'two', atMs: 12_500 });

    expect(ctx.ranges).toEqual([{ index: 1, startSec: 0, endSec: 7 }]);
    expect(ctx.jobs).toEqual([{ blockIndex: 1, startSec: 0, endSec: 6.5, hash: hashText('one') }]);
    expect(ctx.opened[1]).toEqual({ block: { index: 2, startSec: 6, endSec: 6 }, heading: '**14:35**' });
    expect(ctx.blocks.get(2)).toBe('two');
    expect(ctx.events.map((e) => `${e.state} ${e.blockIndex}`)).toEqual(['live 1', 'queued 1', 'live 2']);
    expect(ctx.events[1]).toEqual({ blockIndex: 1, startSec: 0, endSec: 6.5, state: 'queued', clock: DATE_CLOCK });
  });

  it('keeps a split between the two segments', () => {
    const late = setup({ split: () => 100 });
    late.service.segment({ text: 'a', atMs: 1_000 });
    late.service.segment({ text: 'b', atMs: 8_000 });
    expect(late.jobs[0].endSec).toBe(8);

    const early = setup({ split: () => 0 });
    early.service.segment({ text: 'a', atMs: 1_000 });
    early.service.segment({ text: 'b', atMs: 8_000 });
    expect(early.jobs[0].endSec).toBe(1);
  });

  it('ends a paragraph that reaches the length cap at its last segment', () => {
    const ctx = setup({ blockMinutes: 2 });
    ctx.service.segment({ text: 'first', atMs: 10_000 });
    ctx.service.segment({ text: 'second', atMs: 125_000 });
    expect(ctx.jobs).toEqual([{ blockIndex: 1, startSec: 0, endSec: 10, hash: hashText('first') }]);
    expect(ctx.opened[1].block).toEqual({ index: 2, startSec: 10, endSec: 10 });
    expect(ctx.calls).toEqual([]);
  });

  it('ends a paragraph on pause and starts the next one on resume', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'before', atMs: 2_000 });
    ctx.service.setPaused(true, 3_000);
    ctx.service.segment({ text: 'muted words', atMs: 5_000 });
    ctx.clock.now = new Date(2026, 8, 16, 14, 40);
    ctx.service.setPaused(false, 10_000);
    expect(ctx.opened).toHaveLength(1);
    ctx.service.segment({ text: 'after', atMs: 12_000 });

    expect(ctx.jobs).toEqual([{ blockIndex: 1, startSec: 0, endSec: 3, hash: hashText('before') }]);
    expect(ctx.opened[1]).toEqual({ block: { index: 2, startSec: 10, endSec: 10 }, heading: '**14:40**' });
    expect(ctx.blocks.get(2)).toBe('after');
    expect([...ctx.blocks.values()].join(' ')).not.toContain('muted');
  });

  it('writes no empty paragraph for a pause before any words', () => {
    const ctx = setup();
    ctx.service.setPaused(true, 1_000);
    ctx.service.setPaused(false, 4_000);
    ctx.service.segment({ text: 'first words', atMs: 6_000 });
    expect(ctx.opened).toEqual([{ block: { index: 1, startSec: 4, endSec: 4 }, heading: DATE_CLOCK }]);
    expect(ctx.events.map((e) => e.state)).toEqual(['live']);
  });

  it('reports a paragraph whose words were removed as empty', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'gone', atMs: 1_000 });
    ctx.blocks.set(1, '');
    ctx.service.end();
    expect(ctx.jobs).toEqual([]);
    expect(ctx.events[1]).toMatchObject({ blockIndex: 1, state: 'empty' });
  });

  it('ends the paragraph when the engine relaunches', () => {
    const ctx = setup();
    ctx.service.launch({ atMs: 0 });
    ctx.service.segment({ text: 'before the crash', atMs: 3_000 });
    ctx.service.launch({ atMs: 7_000 });
    ctx.service.segment({ text: 'after', atMs: 9_000 });
    expect(ctx.jobs).toEqual([{ blockIndex: 1, startSec: 0, endSec: 7, hash: hashText('before the crash') }]);
    expect(ctx.opened[1].block).toEqual({ index: 2, startSec: 7, endSec: 7 });
  });

  it('queues the last paragraph on end and adds the run to the recorded duration', () => {
    const ctx = setup({ baseDurationSec: 100 });
    ctx.service.segment({ text: 'a bit of speech', atMs: 30_000 });
    ctx.service.end(31_400);
    expect(ctx.jobs).toEqual([{ blockIndex: 1, startSec: 0, endSec: 31.4, hash: hashText('a bit of speech') }]);
    expect(ctx.ranges).toEqual([{ index: 1, startSec: 0, endSec: 32 }]);
    expect(ctx.getDuration()).toBe(131);
    expect(ctx.service.getInfo()).toMatchObject({ state: 'stopped', blockIndex: 0 });
  });

  it('ends at the last words when no stop time is given', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'x', atMs: 30_000 });
    ctx.service.end();
    expect(ctx.jobs[0].endSec).toBe(30);
    expect(ctx.getDuration()).toBe(30);
  });

  it('records the duration of a run without words, and end is idempotent', () => {
    const ctx = setup();
    ctx.service.end(12_000);
    ctx.service.end(20_000);
    expect(ctx.jobs).toEqual([]);
    expect(ctx.getDuration()).toBe(12);
  });

  it('numbers a run after the blocks already in the document', () => {
    const ctx = setup({ firstBlockIndex: 4 });
    ctx.service.segment({ text: 'a', atMs: 1_000 });
    ctx.service.setPaused(true, 2_000);
    ctx.service.setPaused(false, 3_000);
    ctx.service.segment({ text: 'b', atMs: 4_000 });
    expect(ctx.opened.map((o) => [o.block.index, o.heading])).toEqual([
      [4, DATE_CLOCK],
      [5, '**14:32**'],
    ]);
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
    ctx.service.setPaused(true, 0);
    ctx.service.setPaused(false, 0);
    ctx.service.end();
    expect(states).toEqual(['paused', 'recording', 'stopped']);
  });

  it('reports queued before the job is enqueued', () => {
    const fake = fakeStore();
    const order: string[] = [];
    const service = new SessionService({
      store: fake.store,
      enqueueRefine: (job) => order.push(`job ${job.blockIndex}`),
      blockMinutes: 2,
      silenceGapSec: 5,
      silence: { splitPoint: () => null },
      now: () => new Date(2026, 8, 16, 14, 32),
    });
    service.onBlock((event) => order.push(`${event.state} ${event.blockIndex}`));
    service.begin({ id: 's1', documentPath: 'C:/vault/s1.md' });
    service.segment({ text: 'hello', atMs: 1_000 });
    service.segment({ text: 'later', atMs: 250_000 });
    service.end();
    expect(order).toEqual(['live 1', 'queued 1', 'job 1', 'live 2', 'queued 2', 'job 2']);
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

  it('does not queue a paragraph edited outside the app, and says so', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'live words', atMs: 10_000 });
    ctx.service.markEdited(1);
    ctx.service.segment({ text: 'next block', atMs: 130_000 });

    expect(ctx.jobs).toEqual([]);
    expect(ctx.events).toContainEqual({ blockIndex: 1, startSec: 0, endSec: 10, state: 'edited', clock: DATE_CLOCK });
    expect(ctx.service.applyRefinement(1, 'Refined')).toBe('missing');
  });

  it('still queues the paragraphs that were not edited', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'one', atMs: 10_000 });
    ctx.service.markEdited(1);
    ctx.service.segment({ text: 'two', atMs: 130_000 });
    ctx.service.end();
    expect(ctx.jobs.map((job) => job.blockIndex)).toEqual([2]);
  });

  it('forgets edited blocks when a new run begins', () => {
    const ctx = setup();
    ctx.service.markEdited(1);
    ctx.service.begin({ id: 's2', documentPath: 'C:/vault/s2.md' });
    ctx.service.segment({ text: 'fresh', atMs: 10_000 });
    ctx.service.end();
    expect(ctx.jobs.map((job) => job.blockIndex)).toEqual([1]);
  });

  it('marks only the open paragraph as edited by another program', () => {
    const ctx = setup();
    ctx.service.noteOutsideEdit([1]);
    ctx.service.segment({ text: 'one', atMs: 1_000 });
    ctx.service.setPaused(true, 2_000);
    ctx.service.noteOutsideEdit([1]);
    ctx.service.setPaused(false, 3_000);
    ctx.service.segment({ text: 'two', atMs: 4_000 });
    ctx.service.noteOutsideEdit([1, 2]);
    ctx.service.end();
    expect(ctx.jobs.map((job) => job.blockIndex)).toEqual([1]);
    expect(ctx.events.filter((e) => e.state === 'edited').map((e) => e.blockIndex)).toEqual([2]);
  });
});
```

In `src/__tests__/sessionOutsideEdit.test.ts`:
1. Add `import { SilenceTracker } from '../services/audioLevel';`.
2. In `wire()`, replace the `SessionService` deps object with:
```ts
  const service = new SessionService({
    store,
    enqueueRefine: (job) => jobs.push(job),
    blockMinutes: 10,
    silenceGapSec: 5,
    // No audio: paragraphs split when segments arrive at least 5 s apart.
    silence: new SilenceTracker(),
    now: () => new Date(2026, 8, 16, 14, 32),
  });
```
3. Add `const CLOCK = '**2026-09-16 14:32**';` below the `FM` constant, and change the two `toContainEqual` expectations to:
```ts
    expect(w.events).toContainEqual({ blockIndex: 1, startSec: 0, endSec: 5, state: 'edited', clock: CLOCK });
```
(same line in both the first and the second test).
4. In `'still refines untouched blocks and skips a finished block edited later'`, change `w.service.segment({ text: 'four', atMs: 250_000 });` to `w.service.segment({ text: 'four', atMs: 247_000 });`.

In `src/__tests__/blockMath.test.ts`, remove `blockRange` and `formatTimestampHeading` from the import and delete the `describe('blockRange', …)` and `describe('formatTimestampHeading', …)` blocks.

Append to `src/__tests__/settingsMigration.test.ts` (and extend its import to `import { clampSilenceGap, DEFAULT_SILENCE_GAP_SECONDS, initialServerMode, normalizeTheme } from '../services/settingsMigration';`):

```ts
describe('clampSilenceGap', () => {
  it('keeps whole seconds between 1 and 60', () => {
    expect(DEFAULT_SILENCE_GAP_SECONDS).toBe(5);
    expect(clampSilenceGap(5)).toBe(5);
    expect(clampSilenceGap(0)).toBe(1);
    expect(clampSilenceGap(600)).toBe(60);
    expect(clampSilenceGap(2.6)).toBe(3);
    expect(clampSilenceGap('7')).toBe(7);
  });

  it('falls back to the default for nonsense', () => {
    expect(clampSilenceGap(undefined)).toBe(5);
    expect(clampSilenceGap('soon')).toBe(5);
    expect(clampSilenceGap(Number.NaN)).toBe(5);
  });
});

describe('normalizeTheme', () => {
  it('accepts light and defaults to dark', () => {
    expect(normalizeTheme('light')).toBe('light');
    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme('purple')).toBe('dark');
    expect(normalizeTheme(undefined)).toBe('dark');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/__tests__/sessionService.test.ts src/__tests__/sessionOutsideEdit.test.ts src/__tests__/settingsMigration.test.ts`
Expected: FAIL (type errors on the new deps / missing exports).

- [ ] **Step 3: Rewrite `src/services/sessionService.ts`**

```ts
import type { SplitFinder } from './audioLevel';
import { BlockRef, formatClockLine, hashText, ReplaceOutcome } from './documentStore';

export type SessionState = 'recording' | 'paused' | 'stopped';

export interface RefineJob {
  blockIndex: number;
  startSec: number;
  endSec: number;
  hash: string;
}

export type SessionBlockState = 'live' | 'empty' | 'queued' | 'edited';

export interface SessionBlockEvent {
  blockIndex: number;
  startSec: number;
  endSec: number;
  state: SessionBlockState;
  clock: string;
}

export interface SessionInfo {
  id: string;
  documentPath: string;
  state: SessionState;
  // The paragraph being written, or 0 between paragraphs.
  blockIndex: number;
  durationSec: number;
}

export interface SessionStoreLike {
  openBlock(file: string, block: BlockRef, heading?: string): void;
  setBlockRange(file: string, block: BlockRef): void;
  appendSegment(file: string, text: string): void;
  readBlockText(file: string, index: number): string | null;
  replaceBlock(file: string, index: number, text: string, expectedHash: string): ReplaceOutcome;
  updateFrontmatter(file: string, patch: { duration: number }): void;
}

export interface SessionDeps {
  store: SessionStoreLike;
  enqueueRefine(job: RefineJob): void;
  // A paragraph closes after this long even without a pause.
  blockMinutes: number;
  silenceGapSec: number;
  silence: SplitFinder;
  now(): Date;
}

interface OpenBlock {
  index: number;
  startSec: number;
  clock: string;
  lastSegmentSec: number;
}

// One recording run (a session, or one quick note) writing paragraphs into a document (spec §3.1).
// A paragraph is a block: it opens with a clock line when its first words arrive and closes at a
// pause in speech, on Pause, on an engine relaunch, at the length cap, or on Stop. Times are on
// the run's audio clock (seconds since the recorder started).
export class SessionService {
  private info: SessionInfo = { id: '', documentPath: '', state: 'stopped', blockIndex: 0, durationSec: 0 };
  private readonly listeners = new Set<(info: SessionInfo) => void>();
  private readonly blockListeners = new Set<(event: SessionBlockEvent) => void>();
  private readonly hashes = new Map<number, string>();
  // Blocks someone changed outside the app before they closed: their text is not ours to replace.
  private readonly editedBlocks = new Set<number>();
  private open: OpenBlock | null = null;
  // Where the next paragraph's audio begins.
  private nextStartSec = 0;
  private nextIndex = 1;
  private openedAny = false;
  private baseDurationSec = 0;
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

  private emit(): void {
    const snapshot = this.getInfo();
    for (const l of this.listeners) l(snapshot);
  }

  // A quick note appends to a document that already has blocks: numbering continues after them,
  // and the frontmatter duration adds this run to what was recorded before.
  begin(args: { id: string; documentPath: string; firstBlockIndex?: number; baseDurationSec?: number }): void {
    this.hashes.clear();
    this.editedBlocks.clear();
    this.open = null;
    this.nextStartSec = 0;
    this.nextIndex = args.firstBlockIndex ?? 1;
    this.openedAny = false;
    this.baseDurationSec = args.baseDurationSec ?? 0;
    this.launches = 0;
    this.info = { id: args.id, documentPath: args.documentPath, state: 'recording', blockIndex: 0, durationSec: 0 };
  }

  // The first paragraph of a run carries the date as well as the time (spec §3.2).
  private openBlock(atSec: number): OpenBlock {
    const startSec = Math.min(this.nextStartSec, atSec);
    const index = this.nextIndex++;
    const clock = formatClockLine(this.deps.now(), !this.openedAny);
    this.openedAny = true;
    const block: OpenBlock = { index, startSec, clock, lastSegmentSec: atSec };
    this.open = block;
    this.info = { ...this.info, blockIndex: index };
    const marker = Math.floor(startSec);
    this.deps.store.openBlock(this.info.documentPath, { index, startSec: marker, endSec: marker }, clock);
    this.emitBlock({ blockIndex: index, startSec, endSec: startSec, state: 'live', clock });
    return block;
  }

  markEdited(blockIndex: number): void {
    this.editedBlocks.add(blockIndex);
  }

  // Another program changed these blocks. The open paragraph has no hash yet, so it is marked;
  // closed paragraphs are protected by their hash when refined. While a paragraph closes, it is
  // still `open`, so an edit noticed by the closing reads is caught too.
  noteOutsideEdit(changed: readonly number[]): void {
    if (this.open && changed.includes(this.open.index)) {
      this.markEdited(this.open.index);
    }
  }

  // A paragraph with no words left has nothing to refine, and neither does one edited outside
  // the app. Reading the text may itself detect such an edit, so the edited check comes after.
  // 'queued' is reported before the job is enqueued: the queue may start it synchronously.
  private closeOpen(atSec: number): void {
    const block = this.open;
    if (!block) return;
    const endSec = Math.max(atSec, block.startSec);
    const file = this.info.documentPath;
    this.deps.store.setBlockRange(file, { index: block.index, startSec: Math.floor(block.startSec), endSec: Math.ceil(endSec) });
    const text = this.deps.store.readBlockText(file, block.index) ?? '';
    this.open = null;
    this.info = { ...this.info, blockIndex: 0 };
    this.nextStartSec = endSec;

    const event = { blockIndex: block.index, startSec: block.startSec, endSec, clock: block.clock };
    if (this.editedBlocks.has(block.index)) {
      this.emitBlock({ ...event, state: 'edited' });
      return;
    }
    if (text.trim().length === 0) {
      this.emitBlock({ ...event, state: 'empty' });
      return;
    }
    const hash = hashText(text);
    this.hashes.set(block.index, hash);
    this.emitBlock({ ...event, state: 'queued' });
    this.deps.enqueueRefine({ blockIndex: block.index, startSec: block.startSec, endSec, hash });
  }

  // Where the open paragraph should end before a segment that arrived at atSec, or null.
  private splitPoint(block: OpenBlock, atSec: number): number | null {
    if (atSec - block.startSec >= this.deps.blockMinutes * 60) return block.lastSegmentSec;
    const split = this.deps.silence.splitPoint(block.lastSegmentSec, atSec, this.deps.silenceGapSec);
    return split === null ? null : Math.min(atSec, Math.max(block.lastSegmentSec, split));
  }

  segment(s: { text: string; atMs: number }): void {
    if (this.info.state !== 'recording') return;
    const atSec = s.atMs / 1000;
    if (this.open) {
      const split = this.splitPoint(this.open, atSec);
      if (split !== null) this.closeOpen(split);
    }
    const block = this.open ?? this.openBlock(atSec);
    this.deps.store.appendSegment(this.info.documentPath, s.text);
    block.lastSegmentSec = atSec;
    this.info = { ...this.info, durationSec: Math.max(this.info.durationSec, atSec) };
    this.emit();
  }

  // whisper-stream crashed and came back: the paragraph ends where the engine stopped hearing.
  launch(l: { atMs: number }): void {
    this.launches++;
    if (this.launches <= 1) return;
    this.closeOpen(l.atMs / 1000);
  }

  setPaused(paused: boolean, atMs: number): void {
    if (this.info.state === 'stopped') return;
    const next: SessionState = paused ? 'paused' : 'recording';
    if (next === this.info.state) return;
    const atSec = atMs / 1000;
    if (paused) this.closeOpen(atSec);
    else this.nextStartSec = atSec;
    this.info = { ...this.info, state: next };
    this.emit();
  }

  end(atMs?: number): void {
    if (this.info.state === 'stopped') return;
    const endSec = Math.max(this.info.durationSec, (atMs ?? 0) / 1000);
    this.closeOpen(endSec);
    this.deps.store.updateFrontmatter(this.info.documentPath, {
      duration: Math.round(this.baseDurationSec + endSec),
    });
    this.info = { ...this.info, state: 'stopped', durationSec: endSec };
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

- [ ] **Step 4: Supporting changes**

`src/services/guardedStore.ts` — add after `openBlock`:

```ts
  setBlockRange(file: string, block: BlockRef): void {
    this.checkForOutsideEdit(file);
    this.store.setBlockRange(file, block);
    this.noteWrite(file);
  }
```

`src/services/blockMath.ts` — delete the `blockRange` and `formatTimestampHeading` functions.

`src/shared/api.ts` — add `export type ThemeName = 'dark' | 'light';` after `RefineMode`, and in `SettingsView` replace `timestampHeadings: boolean;` with:

```ts
  silenceGapSeconds: number;
  theme: ThemeName;
```

`src/services/settingsMigration.ts` — append:

```ts
import type { ThemeName } from '../shared/api';

export const DEFAULT_SILENCE_GAP_SECONDS = 5;

export function clampSilenceGap(value: unknown): number {
  const seconds = typeof value === 'number' ? value : Number(value);
  if (value === undefined || value === null || !Number.isFinite(seconds)) return DEFAULT_SILENCE_GAP_SECONDS;
  return Math.min(60, Math.max(1, Math.round(seconds)));
}

export function normalizeTheme(value: unknown): ThemeName {
  return value === 'light' ? 'light' : 'dark';
}
```

(Move the `import type` line to the top of the file.)

`src/services/settingsService.ts`:
- import: `import { clampSilenceGap, DEFAULT_SILENCE_GAP_SECONDS, initialServerMode, normalizeTheme, ServerMode } from './settingsMigration';` and `import type { ThemeName } from '../shared/api';`
- `Settings`: replace `timestampHeadings: boolean;` with `silenceGapSeconds: number;` and `theme: ThemeName;`
- store defaults: replace `timestampHeadings: false,` with `silenceGapSeconds: DEFAULT_SILENCE_GAP_SECONDS,` and `theme: 'dark',`
- `getSettings()`: replace the `timestampHeadings` line with
```ts
    silenceGapSeconds: clampSilenceGap(storeAny.get('silenceGapSeconds', DEFAULT_SILENCE_GAP_SECONDS)),
    theme: normalizeTheme(storeAny.get('theme', 'dark')),
```

`src/services/sessionRuntime.ts`:
- add `import { SilenceTracker } from './audioLevel';` and, below `const AUDIO_REMOVE_RETRY_MS = 1000;`:
```ts
// Used before the recorder has started: with no audio, paragraphs split on segment arrival gaps.
const NO_AUDIO = new SilenceTracker();
```
- replace the `new SessionService({...})` call with:
```ts
  const service = new SessionService({
    store,
    enqueueRefine: (job) => ctx?.queue.enqueue(job),
    blockMinutes: settings.blockMinutes,
    silenceGapSec: settings.silenceGapSeconds,
    silence: {
      splitPoint: (afterSec, beforeSec, gapSec) =>
        (ctx?.audio?.silence ?? NO_AUDIO).splitPoint(afterSec, beforeSec, gapSec),
    },
    now: () => new Date(),
  });
```
- in `applyPause`, change `ctx.service.setPaused(paused);` to `ctx.service.setPaused(paused, streamEngine.elapsedMs());`
- in `stopSession`, add `const atMs = streamEngine.elapsedMs();` as the first line after the `if (!ctx || ctx.stopped) return;` guard, and change `ctx.service.end();` to `ctx.service.end(atMs);`
- update the comment above `streamEngine.onLaunch` to: `// SoX keeps recording across engine relaunches, so the audio timeline stays continuous; the service ends the paragraph at the relaunch.`

`public/index.html` — in the settings dialog, replace
```html
      <label class="check"><input type="checkbox" id="timestampHeadingsInput"> Write timestamp headings in the document</label>
```
with
```html
      <label for="silenceGapInput">Start a new paragraph after this many seconds of silence</label>
      <input type="number" id="silenceGapInput" min="1" max="60" step="1">
```
and change the label `Minutes per block` to `Longest paragraph (minutes)`.

`src/renderer/dialogs.ts`:
- in `settingsFields()`, replace `timestampHeadings: byId<HTMLInputElement>('timestampHeadingsInput'),` with `silenceGap: byId<HTMLInputElement>('silenceGapInput'),`
- in `openSettings()`, replace `f.timestampHeadings.checked = settings.timestampHeadings;` with `f.silenceGap.value = String(settings.silenceGapSeconds);`
- in `saveSettingsFromDialog()`, replace `timestampHeadings: f.timestampHeadings.checked,` with `silenceGapSeconds: Math.max(1, Math.min(60, Math.round(Number(f.silenceGap.value) || 5))),`

- [ ] **Step 5: Run the tests, build and lint**

Run: `npm test && npm run build && npm run lint`
Expected: all suites pass; build succeeds; lint 0 errors. If `grep -rn "timestampHeadings\|formatTimestampHeading\|blockRange(" src` finds anything other than nothing, fix it.

- [ ] **Step 6: Commit**

```bash
git add -A src public/index.html
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Split recordings into timestamped paragraphs at pauses

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: One outside-edit guard per document

**Files:**
- Modify: `src/services/guardedStore.ts` (listeners instead of a constructor callback; drop `appendLine`)
- Create: `src/services/guardRegistry.ts`
- Modify: `src/services/sessionRuntime.ts` (acquire/release guards; `documentMoved`)
- Test: `src/__tests__/guardedStore.test.ts`, `src/__tests__/guardRegistry.test.ts`, `src/__tests__/sessionOutsideEdit.test.ts`

**Interfaces:**
- Consumes: `prepareQuickNote` (Task 3), `SessionService` (Task 4), `SilenceTracker` (Task 1).
- Produces:
  - `new GuardedStore(store: DocumentStore)`; `guard.onOutsideEdit(listener: (changed: number[]) => void): () => void`
  - `class GuardRegistry { acquire(file: string, documents: DocumentStore): GuardedStore; release(file: string): void; moved(from: string, to: string): void; size(): number }`
  - `SessionContext.releaseGuard(): void` in `sessionRuntime.ts` (idempotent).

- [ ] **Step 1: Write the failing tests**

In `src/__tests__/guardedStore.test.ts`:
1. In `setup()`, replace `const guard = new GuardedStore(documents, (changed) => reports.push(changed));` with
```ts
  const guard = new GuardedStore(documents);
  guard.onOutsideEdit((changed) => reports.push(changed));
```
2. In the first test, replace `ctx.guard.appendLine(ctx.file, '<!-- dw:gap -->');` with `ctx.guard.setBlockRange(ctx.file, block(1, 0));`.
3. Append this test inside the `describe`:
```ts
  it('tells every listener, and stops telling one that unsubscribed', () => {
    const ctx = setup();
    const other: number[][] = [];
    const stop = ctx.guard.onOutsideEdit((changed) => other.push(changed));
    ctx.guard.openBlock(ctx.file, block(1, 0));
    ctx.guard.appendSegment(ctx.file, 'words');
    fs.writeFileSync(ctx.file, fs.readFileSync(ctx.file, 'utf8').replace('words', 'wordz'));
    ctx.guard.appendSegment(ctx.file, 'more');
    stop();
    fs.writeFileSync(ctx.file, fs.readFileSync(ctx.file, 'utf8').replace('wordz', 'words'));
    ctx.guard.appendSegment(ctx.file, 'again');
    expect(ctx.reports).toEqual([[1], [1]]);
    expect(other).toEqual([[1]]);
  });
```

Create `src/__tests__/guardRegistry.test.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DocumentStore } from '../services/documentStore';
import { GuardRegistry } from '../services/guardRegistry';

describe('GuardRegistry', () => {
  let vault: string;
  let documents: DocumentStore;
  let registry: GuardRegistry;
  let file: string;
  let other: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-guards-'));
    documents = new DocumentStore(vault);
    registry = new GuardRegistry();
    file = path.join(vault, 'day.md');
    other = path.join(vault, 'other.md');
    fs.writeFileSync(file, '---\ntitle: day\n---\n\n');
    fs.writeFileSync(other, '---\ntitle: other\n---\n\n');
  });

  afterEach(() => fs.rmSync(vault, { recursive: true, force: true }));

  it('shares one guard per file, ignoring case', () => {
    const guard = registry.acquire(file, documents);
    expect(registry.acquire(file.toUpperCase(), documents)).toBe(guard);
    expect(registry.acquire(other, documents)).not.toBe(guard);
    expect(registry.size()).toBe(2);
  });

  it('starts a new guard from the file as it is, then reports outside edits', () => {
    fs.appendFileSync(file, '<!-- dw:block 1 t=0-0 -->\nbefore\n');
    const guard = registry.acquire(file, documents);
    const reports: number[][] = [];
    guard.onOutsideEdit((changed) => reports.push(changed));
    expect(guard.readBlockText(file, 1)).toBe('before');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('before', 'after'));
    expect(guard.readBlockText(file, 1)).toBe('after');
    expect(reports).toEqual([[1]]);
  });

  it('forgets a file once its last user releases it', () => {
    const guard = registry.acquire(file, documents);
    registry.acquire(file, documents);
    registry.release(file);
    expect(registry.acquire(file, documents)).toBe(guard);
    registry.release(file);
    registry.release(file);
    expect(registry.size()).toBe(0);
    registry.release(file);
    expect(registry.acquire(file, documents)).not.toBe(guard);
  });

  it('follows a moved file without reporting the move as an edit', () => {
    const guard = registry.acquire(file, documents);
    const reports: number[][] = [];
    guard.onOutsideEdit((changed) => reports.push(changed));
    const moved = path.join(vault, 'Work', 'day.md');
    fs.mkdirSync(path.dirname(moved));
    fs.renameSync(file, moved);
    fs.writeFileSync(moved, fs.readFileSync(moved, 'utf8').replace('title: day', 'title: renamed'));

    registry.moved(file, moved);

    expect(registry.acquire(moved, documents)).toBe(guard);
    guard.readBlockText(moved, 1);
    expect(reports).toEqual([]);
  });
});
```

In `src/__tests__/sessionOutsideEdit.test.ts`:
1. Extend the imports:
```ts
import { GuardRegistry } from '../services/guardRegistry';
import { prepareQuickNote } from '../services/quickNotes';
```
2. In `wire()`, replace the `GuardedStore` construction with:
```ts
  const store = new GuardedStore(documents);
  store.noteWrite(file);
  store.onOutsideEdit((changed) => {
    reports.push(changed);
    holder.service?.noteOutsideEdit(changed);
  });
```
(and delete the old `store.noteWrite(file);` line that followed it).
3. Below the `CLOCK` constant add:
```ts
const DETAILS: Omit<Frontmatter, 'title'> = {
  created: FM.created,
  updated: FM.updated,
  duration: 0,
  language: FM.language,
  liveModel: FM.liveModel,
  refineModel: FM.refineModel,
  app: FM.app,
};
```
4. Append at the end of the file:
```ts
describe('two quick-note runs on one day file', () => {
  it('share the guard, so only a real outside edit is reported and only its paragraph is skipped', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-two-runs-'));
    const documents = new DocumentStore(vault);
    const registry = new GuardRegistry();
    const day = new Date(2026, 8, 16, 14, 32);

    function startRun(id: string) {
      const target = prepareQuickNote(documents, vault, day, DETAILS);
      const store = registry.acquire(target.documentPath, documents);
      const jobs: RefineJob[] = [];
      const reports: number[][] = [];
      const service = new SessionService({
        store,
        enqueueRefine: (job) => jobs.push(job),
        blockMinutes: 10,
        silenceGapSec: 5,
        silence: new SilenceTracker(),
        now: () => day,
      });
      store.onOutsideEdit((changed) => {
        reports.push(changed);
        service.noteOutsideEdit(changed);
      });
      service.begin({
        id,
        documentPath: target.documentPath,
        firstBlockIndex: target.firstBlockIndex,
        baseDurationSec: target.baseDurationSec,
      });
      return { service, jobs, reports, file: target.documentPath };
    }

    const first = startRun('a');
    first.service.segment({ text: 'alpha', atMs: 2_000 });
    first.service.end(3_000);
    expect(first.jobs.map((job) => job.blockIndex)).toEqual([1]);

    const second = startRun('b');
    second.service.segment({ text: 'bravo', atMs: 2_000 });
    expect(first.service.applyRefinement(1, 'Alpha.')).toBe('replaced');
    second.service.segment({ text: 'and more', atMs: 3_000 });
    expect(first.reports).toEqual([]);
    expect(second.reports).toEqual([]);

    fs.writeFileSync(second.file, fs.readFileSync(second.file, 'utf8').replace('bravo', 'bravo fixed'));
    second.service.segment({ text: 'charlie', atMs: 20_000 });
    second.service.end(21_000);

    expect(first.reports).toEqual([[2]]);
    expect(second.reports).toEqual([[2]]);
    expect(second.jobs.map((job) => job.blockIndex)).toEqual([3]);
    const content = fs.readFileSync(second.file, 'utf8');
    expect(content).toContain('Alpha.');
    expect(content).toContain('bravo fixed and more');
    expect(content.match(/\*\*2026-09-16 14:32\*\*/g)).toHaveLength(2);
    expect(content).toContain('<!-- dw:block 3 t=3-21 -->\n**14:32**\ncharlie');
    expect(content).toMatch(/duration: 24\n/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/__tests__/guardedStore.test.ts src/__tests__/guardRegistry.test.ts src/__tests__/sessionOutsideEdit.test.ts`
Expected: FAIL (constructor arity, missing module).

- [ ] **Step 3: Implement**

Replace `src/services/guardedStore.ts` with:

```ts
import { BlockRef, changedBlocks, DocumentStore, ReplaceOutcome } from './documentStore';
import type { SessionStoreLike } from './sessionService';

// Called with the indexes of the blocks whose text another program changed (possibly none,
// e.g. an edit to the frontmatter).
export type OutsideEditListener = (changedBlocks: number[]) => void;

// Wraps the document store for one document. Before every read or write it compares the file
// with what we last wrote (spec §5.3). An outside change becomes the new baseline, and every
// listener learns which blocks changed: closed blocks are protected by their own hash when
// refined, and each run marks the block it is still writing so it is never refined over the edit.
// Every run writing to the document shares this guard (spec §3.5, GuardRegistry).
// A file that cannot be read at the moment (a sync client holding it) is not an edit.
export class GuardedStore implements SessionStoreLike {
  private lastContent: string | null = null;
  private readonly listeners = new Set<OutsideEditListener>();

  constructor(private readonly store: DocumentStore) {}

  onOutsideEdit(listener: OutsideEditListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private checkForOutsideEdit(file: string): void {
    if (this.lastContent === null) return;
    const current = this.store.readContent(file);
    if (current === null || current === this.lastContent) return;
    const changed = changedBlocks(this.lastContent, current);
    this.lastContent = current;
    for (const listener of [...this.listeners]) listener(changed);
  }

  noteWrite(file: string): void {
    this.lastContent = this.store.readContent(file);
  }

  openBlock(file: string, block: BlockRef, heading?: string): void {
    this.checkForOutsideEdit(file);
    this.store.openBlock(file, block, heading);
    this.noteWrite(file);
  }

  setBlockRange(file: string, block: BlockRef): void {
    this.checkForOutsideEdit(file);
    this.store.setBlockRange(file, block);
    this.noteWrite(file);
  }

  appendSegment(file: string, text: string): void {
    this.checkForOutsideEdit(file);
    this.store.appendSegment(file, text);
    this.noteWrite(file);
  }

  readBlockText(file: string, index: number): string | null {
    this.checkForOutsideEdit(file);
    return this.store.readBlockText(file, index);
  }

  replaceBlock(file: string, index: number, text: string, expectedHash: string): ReplaceOutcome {
    this.checkForOutsideEdit(file);
    const outcome = this.store.replaceBlock(file, index, text, expectedHash);
    this.noteWrite(file);
    return outcome;
  }

  updateFrontmatter(file: string, patch: { duration: number }): void {
    this.checkForOutsideEdit(file);
    this.store.updateFrontmatter(file, patch);
    this.noteWrite(file);
  }
}
```

Create `src/services/guardRegistry.ts`:

```ts
import * as path from 'path';
import { DocumentStore } from './documentStore';
import { GuardedStore } from './guardedStore';

interface Entry {
  guard: GuardedStore;
  users: number;
}

// One guard per document, shared by every run that writes to it (spec §3.5): a quick note can
// start while an earlier run on the same day file is still refining, and neither may mistake the
// other's writes for an outside edit.
export class GuardRegistry {
  private readonly entries = new Map<string, Entry>();

  private static key(file: string): string {
    return path.resolve(file).toLowerCase();
  }

  // A new guard starts from the file as it is now.
  acquire(file: string, documents: DocumentStore): GuardedStore {
    const key = GuardRegistry.key(file);
    const existing = this.entries.get(key);
    if (existing) {
      existing.users++;
      return existing.guard;
    }
    const guard = new GuardedStore(documents);
    guard.noteWrite(file);
    this.entries.set(key, { guard, users: 1 });
    return guard;
  }

  release(file: string): void {
    const key = GuardRegistry.key(file);
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.users--;
    if (entry.users <= 0) this.entries.delete(key);
  }

  // The library renamed or moved a document. A rename rewrites the title in the frontmatter,
  // which is our own write, not an outside edit.
  moved(from: string, to: string): void {
    const fromKey = GuardRegistry.key(from);
    const entry = this.entries.get(fromKey);
    if (!entry) return;
    this.entries.delete(fromKey);
    this.entries.set(GuardRegistry.key(to), entry);
    entry.guard.noteWrite(to);
  }

  size(): number {
    return this.entries.size;
  }
}
```

In `src/services/sessionRuntime.ts`:
1. Change `import { GuardedStore } from './guardedStore';` to `import type { GuardedStore } from './guardedStore';` and add `import { GuardRegistry } from './guardRegistry';`.
2. Below `const finishing = new Set<SessionContext>();` add `const guards = new GuardRegistry();`.
3. Add to `interface SessionContext` after `store: GuardedStore;`:
```ts
  // Stops listening to the shared guard and releases it; safe to call more than once.
  releaseGuard(): void;
```
4. In `documentMoved`, delete these two lines:
```ts
    // A rename rewrites the title in the frontmatter; that is our own write, not an outside edit.
    ctx.store.noteWrite(to);
```
and add `guards.moved(from, to);` just before the final `emit();`.
5. In `settle`, after `finishing.delete(ctx);` add `ctx.releaseGuard();`.
6. In `startSession`, replace the whole `const store = new GuardedStore(documents, (changed) => { ... });` statement and the `store.noteWrite(documentPath);` line after it with:
```ts
  const store = guards.acquire(documentPath, documents);
  const stopListening = store.onOutsideEdit((changed) => {
    if (!ctx) return;
    ctx.service.noteOutsideEdit(changed);
    if (changed.length > 0 && !ctx.outsideEditNoticed) {
      ctx.outsideEditNoticed = true;
      addMessage(ctx, OUTSIDE_EDIT_MESSAGE);
      emit();
    }
  });
  let guardReleased = false;
```
(keep the comment about outside changes that touched no block above it), and add to the `ctx = { ... }` literal after `store,`:
```ts
    releaseGuard: () => {
      if (guardReleased) return;
      guardReleased = true;
      stopListening();
      guards.release(ctx?.documentPath ?? documentPath);
    },
```

- [ ] **Step 4: Run tests, build, lint**

Run: `npm test && npm run build && npm run lint`
Expected: all pass, 0 lint errors.

- [ ] **Step 5: Commit**

```bash
git add src/services/guardedStore.ts src/services/guardRegistry.ts src/services/sessionRuntime.ts src/__tests__/guardedStore.test.ts src/__tests__/guardRegistry.test.ts src/__tests__/sessionOutsideEdit.test.ts
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Share one outside-edit guard per document between runs

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Quick Note runs in the session runtime

**Files:**
- Modify: `src/services/sessionRuntime.ts`
- Modify: `src/shared/api.ts` (`BlockEvent.clock`, `SessionStatusView.kind`, `startSession(request)`, `toggleQuickNote()`)
- Modify: `src/preload.ts`, `src/main.ts` (`session-start` takes a request; `quick-note-toggle`)
- Modify: `src/renderer/header.ts` (start call)
- Test: `src/__tests__/sessionModel.test.ts`, `src/__tests__/documentView.test.ts` (fixtures only)

**Interfaces:**
- Consumes: `prepareQuickNote`, `startRefusal`, `parseStartRequest`, `QUICK_NOTES_FOLDER` (Task 3); `SessionKind`, `SessionStartRequest` (Task 3).
- Produces:
  - `startSession(request: SessionStartRequest): Promise<SessionStatusView>` and `toggleQuickNote(): Promise<void>` in `sessionRuntime.ts`.
  - `BlockEvent.clock: string` — the block's clock line (`'**14:32**'`), `''` when unknown.
  - `SessionStatusView.kind: SessionKind`.
  - IPC `session-start` (payload: `SessionStartRequest`), `quick-note-toggle` (no payload).
  - `window.api.startSession(request: SessionStartRequest)`, `window.api.toggleQuickNote(): Promise<void>`.

- [ ] **Step 1: Update the shared types and test fixtures**

In `src/shared/api.ts`:
- `BlockEvent`: add `clock: string; // the block's clock line, e.g. **14:32**; '' when unknown` after `endSec`.
- `SessionStatusView`: add `kind: SessionKind;` after `sessionId`.
- `DarkWhisperApi`: replace `startSession(folder?: string): Promise<SessionStatusView>;` with
```ts
  startSession(request: SessionStartRequest): Promise<SessionStatusView>;
  toggleQuickNote(): Promise<void>;
```

In `src/__tests__/sessionModel.test.ts`, add `kind: 'session',` after `sessionId: 's1',` in the `status()` fixture, and `clock: '',` after `endSec: blockIndex * 120,` in the `block()` fixture.

In `src/__tests__/documentView.test.ts`, change the `blocks` fixture in `describe('mergeLiveText')` to
```ts
  const blocks: BlockEvent[] = [{ sessionId: 's', blockIndex: 4, startSec: 360, endSec: 480, state: 'live', clock: '' }];
```

- [ ] **Step 2: Rework `startSession` in `src/services/sessionRuntime.ts`**

1. Imports: add
```ts
import { prepareQuickNote, startRefusal } from './quickNotes';
```
and change the shared-type import to
```ts
import type { BlockEvent, BlockState, SessionKind, SessionStartRequest, SessionStatusView } from '../shared/api';
```
2. `interface SessionContext`: add `kind: SessionKind;` after `id: string;`.
3. `recordBlock`: change the `range` parameter type to `range?: { startSec: number; endSec: number; clock?: string }` and add to the event literal, after `endSec`:
```ts
    clock: range?.clock ?? previous?.clock ?? '',
```
4. `sessionStatus()`: add `kind: ctx?.kind ?? 'session',` after `sessionId: ctx?.id ?? null,`.
5. Replace the beginning of `startSession` — from `export async function startSession(folder = ''): Promise<SessionStatusView> {` down to and including the line `const documentPath = documents.createDocument(uniqueDocumentId(targetDir, base), frontmatter, target.folder);` — with:

```ts
export async function startSession(request: SessionStartRequest): Promise<SessionStatusView> {
  const refusal = startRefusal(isSessionActive() && current ? current.kind : null, request.kind);
  if (refusal) throw new Error(refusal);

  const settings = getSettings();
  const documents = new DocumentStore(settings.vaultPath);
  const startedAt = new Date();
  const id = newSessionId(startedAt);
  const created = startedAt.toISOString();
  const details: Omit<Frontmatter, 'title'> = {
    created,
    updated: created,
    duration: 0,
    language: settings.language,
    liveModel: settings.liveModelId,
    refineModel: settings.modelId ?? 'none',
    app: `dark-whisper ${app.getVersion()}`,
  };

  // A quick note appends to today's file in Quick Notes (spec §3.4); a session gets a new
  // document in the selected folder.
  let documentPath: string;
  let folder: string;
  let firstBlockIndex = 1;
  let baseDurationSec = 0;
  let folderMessage: string | undefined;
  if (request.kind === 'quick-note') {
    const target = prepareQuickNote(documents, settings.vaultPath, startedAt, details);
    documentPath = target.documentPath;
    folder = target.folder;
    firstBlockIndex = target.firstBlockIndex;
    baseDurationSec = target.baseDurationSec;
  } else {
    const library = new LibraryService(settings.vaultPath);
    const target = resolveTargetFolder(library, request.folder);
    folder = target.folder;
    folderMessage = target.message;
    const base = id.replace(/^(\d{4})(\d{2})(\d{2})-(\d{4})\d{2}$/, '$1-$2-$3-$4');
    const targetDir = path.join(settings.vaultPath, folder);
    documentPath = documents.createDocument(uniqueDocumentId(targetDir, base), { title: 'untitled', ...details }, folder);
  }

  if (current && !current.audioRemoved) finishing.add(current);
  statusMessage = undefined;
```

6. In the rest of `startSession`:
- in the `ctx = { ... }` literal, add `kind: request.kind,` after `id,` and change `folder: target.folder,` to `folder,`;
- replace `if (target.message) addMessage(ctx, target.message);` with `if (folderMessage) addMessage(ctx, folderMessage);`;
- replace `service.begin({ id, documentPath });` with `service.begin({ id, documentPath, firstBlockIndex, baseDurationSec });`.

7. Add after `stopSession`:
```ts
// Ctrl+Q and the Quick Notes button: stop a running quick note, else start one. A running
// session is not touched; startSession refuses with a message instead.
export async function toggleQuickNote(): Promise<void> {
  if (isSessionActive() && current?.kind === 'quick-note') {
    await stopSession();
    return;
  }
  await startSession({ kind: 'quick-note' });
}
```

- [ ] **Step 3: Wire IPC, preload and the renderer call**

`src/preload.ts`: replace the `startSession` line with
```ts
  startSession: (request) => ipcRenderer.invoke('session-start', request),
  toggleQuickNote: () => ipcRenderer.invoke('quick-note-toggle'),
```

`src/main.ts`:
- add `toggleQuickNote,` to the `./services/sessionRuntime` import list, and `import { parseStartRequest } from './services/quickNotes';`
- replace the `session-start` handler with:
```ts
ipcMain.handle('session-start', async (_event, request?: unknown) => {
  if (isRecording) {
    throw new Error('Quick dictation is recording. Stop it before starting a session.');
  }
  return startSession(parseStartRequest(request));
});

ipcMain.handle('quick-note-toggle', () => toggleQuickNote());
```

`src/renderer/header.ts`: in the `sessionStartBtn` click handler, change `window.api.startSession(getState().selectedFolder)` to `window.api.startSession({ kind: 'session', folder: getState().selectedFolder })`.

- [ ] **Step 4: Run tests, build, lint**

Run: `npm test && npm run build && npm run lint`
Expected: all pass, 0 lint errors. `grep -rn "startSession(" src` shows no call passing a bare string.

- [ ] **Step 5: Quick-note smoke on a throwaway profile**

With the app built, run this script from the repo root. It starts a throwaway instance, starts and stops two quick notes through the API (no Pause), and checks the day file. Save it as `%TEMP%\dw-quicknote-check.mjs` (outside the repo) and run `node %TEMP%\dw-quicknote-check.mjs`:

```js
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
const repo = process.cwd();
const { connect } = await import(new URL(`file:///${repo.replace(/\\/g, '/')}/scripts/dev-cdp.mjs`));
const electronPath = createRequire(path.join(repo, 'package.json'))('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-qn-profile-'));
const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-qn-vault-'));
const model = path.join(process.env.APPDATA, 'Dark-Whisper', 'models', 'ggml-base.en.bin');
fs.mkdirSync(path.join(profile, 'models'));
fs.copyFileSync(model, path.join(profile, 'models', 'ggml-base.en.bin'));
const child = spawn(electronPath, ['.', '--remote-debugging-port=9335', `--user-data-dir=${profile}`], { cwd: repo, stdio: 'ignore' });
const app = await connect(9335);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await app.evaluate(`window.api.saveSettings({ vaultPath: ${JSON.stringify(vault)} })`);
  for (let run = 1; run <= 2; run++) {
    await app.evaluate('window.api.toggleQuickNote()');
    await wait(4000);
    const s = await app.evaluate('window.api.getSessionStatus()');
    console.log(run, s.kind, s.state, s.documentFile);
    const refused = await app.evaluate("window.api.startSession({ kind: 'session', folder: '' }).then(() => 'started', (e) => e.message)");
    console.log('session while quick note:', refused);
    await app.evaluate('window.api.toggleQuickNote()');
    await wait(1500);
  }
  const dir = path.join(vault, 'Quick Notes');
  console.log(fs.readdirSync(dir), fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'));
} finally {
  app.close();
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
}
```

Expected: both runs print `quick-note recording Quick Notes/<today>.md`; the refusal reads `Error…Stop the quick note before starting a session.`; the folder holds exactly one file whose frontmatter title is today's date. (No speech, so no blocks are written.) Delete the two temp folders afterwards.

- [ ] **Step 6: Commit**

```bash
git add src/services/sessionRuntime.ts src/shared/api.ts src/preload.ts src/main.ts src/renderer/header.ts src/__tests__/sessionModel.test.ts src/__tests__/documentView.test.ts
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Record quick notes into a daily file

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---
### Task 7: Colour tokens, light theme and the frameless window

This task writes the final stylesheet for the whole window. Tasks 8–11 then rebuild each pane's markup against these classes; until they land, parts of the old markup may look unstyled. That is expected.

**Files:**
- Create: `src/services/windowTheme.ts`, `src/renderer/theme.ts`
- Modify (rewrite): `public/app.css`
- Modify: `public/index.html` (`data-theme`, theme button, caption space)
- Modify: `src/main.ts` (window options; theme change in `save-settings`)
- Modify: `src/renderer/app.ts`
- Test: `src/__tests__/windowTheme.test.ts`

**Interfaces:**
- Consumes: `ThemeName`, `SettingsView.theme` (Task 4).
- Produces:
  - `titleBarOverlay(theme: ThemeName): { color: string; symbolColor: string; height: number }`, `windowBackground(theme: ThemeName): string`, `TITLE_BAR_HEIGHT = 56`.
  - `initTheme(): void` and `applyTheme(theme: ThemeName): void` in `src/renderer/theme.ts` (uses `#themeBtn` and `#themeIcon`).
  - CSS classes used by later tasks (all defined below): `.i` + `.i-<name>` icons (`logo note mic stop pause play moon sun gear chevron-down chevron-right search folder file clock plus more pencil external copy focus panel`), `.btn.primary|ghost|outline|quick|record|wide`, `.icon`, `.icon.text`, `.chip`, `.dot.ok|busy|rec|error|idle|external`, `.spacer`, `.caption-space`, `.run-controls`, `.status`, `.brand`, `.brand-name`, `.logo`; sidebar `.search`, `.section-title`, `.row.folder|doc|recent|hit|root`, `.twisty(.none)`, `.kind(.quick)`, `.count`, `.date`, `.rec-dot`, `.row-menu`, `.library-footer`, `.footer-line`; document `.doc-icon`, `.meter .bar`, `.live-badge`, `.doc-body.size-0|1|2`, `.para(.intro|.live)`, `.margin .time`, `.md`, `.gap`, `.cursor`, `.flash`, `.hit-line`, `.jump`, `.doc-toolbar`; panel `.panel-section(.open)`, `.section-head .chev .title .extra`, `.section-body`, `.details`, `.state-line`, `.pill`, `.blocks`, `.block-row .num .range .msg`, `.messages`; `.badge.<state>`; `.workspace.panel-collapsed|focus`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/windowTheme.test.ts`:

```ts
import { TITLE_BAR_HEIGHT, titleBarOverlay, windowBackground } from '../services/windowTheme';

describe('windowTheme', () => {
  it('matches the header colours of each theme', () => {
    expect(windowBackground('dark')).toBe('#0f1020');
    expect(windowBackground('light')).toBe('#f6f7fb');
    expect(titleBarOverlay('dark')).toEqual({ color: '#0f1020', symbolColor: '#c9cbe0', height: TITLE_BAR_HEIGHT });
    expect(titleBarOverlay('light')).toEqual({ color: '#f6f7fb', symbolColor: '#3b3d52', height: 56 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/__tests__/windowTheme.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/services/windowTheme.ts`**

```ts
import type { ThemeName } from '../shared/api';

// Must match --bg in public/app.css: the native caption buttons sit on the page's header.
export const TITLE_BAR_HEIGHT = 56;

const COLORS: Record<ThemeName, { background: string; symbol: string }> = {
  dark: { background: '#0f1020', symbol: '#c9cbe0' },
  light: { background: '#f6f7fb', symbol: '#3b3d52' },
};

export function windowBackground(theme: ThemeName): string {
  return COLORS[theme].background;
}

export function titleBarOverlay(theme: ThemeName): { color: string; symbolColor: string; height: number } {
  return { color: COLORS[theme].background, symbolColor: COLORS[theme].symbol, height: TITLE_BAR_HEIGHT };
}
```

Run: `npx jest src/__tests__/windowTheme.test.ts` → PASS.

- [ ] **Step 4: Window options in `src/main.ts`**

Add `import { titleBarOverlay, windowBackground } from './services/windowTheme';`. In `createWindow`, add `const theme = getSettings().theme;` as the first line and change the `BrowserWindow` options to:

```ts
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: windowBackground(theme),
    // The page draws its own header; Windows keeps drawing the caption buttons over it.
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(theme),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
```

In the `save-settings` handler, right after `const after = getSettings();`, add:

```ts
  if (before.theme !== after.theme && mainWindow) {
    mainWindow.setTitleBarOverlay(titleBarOverlay(after.theme));
    mainWindow.setBackgroundColor(windowBackground(after.theme));
  }
```

- [ ] **Step 5: Renderer theme switch**

Create `src/renderer/theme.ts`:

```ts
import type { ThemeName } from '../shared/api.js';
import { byId } from './dom.js';
import { reportError } from './toast.js';

let current: ThemeName = 'dark';

export function applyTheme(theme: ThemeName): void {
  current = theme;
  document.documentElement.dataset.theme = theme;
  byId('themeIcon').className = `i ${theme === 'dark' ? 'i-moon' : 'i-sun'}`;
  byId('themeBtn').title = theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme';
}

export function initTheme(): void {
  window.api.getSettings().then((settings) => applyTheme(settings.theme), reportError);
  byId('themeBtn').addEventListener('click', () => {
    const next: ThemeName = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    window.api.saveSettings({ theme: next }).catch(reportError);
  });
}
```

In `src/renderer/app.ts`, add `import { initTheme } from './theme.js';` and call `initTheme();` right after `initDialogs(...)`.

In `public/index.html`:
- change `<html lang="en">` to `<html lang="en" data-theme="dark">`;
- inside `<div class="tools">`, insert as its first child:
```html
      <button class="icon" id="themeBtn" title="Switch theme"><span class="i i-moon" id="themeIcon" aria-hidden="true"></span></button>
```
- insert `<div class="caption-space" aria-hidden="true"></div>` as the last child of `<header class="topbar">`.

- [ ] **Step 6: Replace `public/app.css`**

Replace the whole file with:

```css
/* == Tokens == */
:root {
  --bg: #0f1020;
  --bg-pane: #111227;
  --bg-raised: #181a33;
  --bg-input: #14152b;
  --bg-hover: #1e2042;
  --bg-selected: #252a5c;
  --border: #23264a;
  --text: #e6e7f2;
  --text-strong: #ffffff;
  --muted: #8d90b3;
  --accent: #6d5dfc;
  --accent-hover: #7d6fff;
  --accent-soft: rgba(109, 93, 252, 0.2);
  --accent-text: #b3a9ff;
  --quick: #f2c14e;
  --quick-soft: rgba(242, 193, 78, 0.14);
  --danger: #ff6b6b;
  --ok: #3ecf8e;
  --ok-soft: rgba(62, 207, 142, 0.14);
  --warn: #f5b942;
  --info: #7aa7ff;
  --info-soft: rgba(122, 167, 255, 0.14);
  --shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  --header-height: 56px;
  --caption-width: 140px;
  font-family: 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif;
  font-size: 14px;
  color-scheme: dark;
}

:root[data-theme='light'] {
  --bg: #f6f7fb;
  --bg-pane: #ffffff;
  --bg-raised: #eef0f7;
  --bg-input: #ffffff;
  --bg-hover: #e8eaf4;
  --bg-selected: #e2e0fd;
  --border: #dcdfeb;
  --text: #1c1d2e;
  --text-strong: #0b0c18;
  --muted: #62667f;
  --accent: #5b4cf0;
  --accent-hover: #4b3ce0;
  --accent-soft: rgba(91, 76, 240, 0.12);
  --accent-text: #4b3ce0;
  --quick: #a86b00;
  --quick-soft: rgba(214, 150, 20, 0.12);
  --danger: #d64545;
  --ok: #178a55;
  --ok-soft: rgba(23, 138, 85, 0.12);
  --warn: #a86b00;
  --info: #2b6fd6;
  --info-soft: rgba(43, 111, 214, 0.1);
  --shadow: 0 8px 24px rgba(20, 22, 50, 0.16);
  color-scheme: light;
}

/* == Base == */
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--text); display: flex; flex-direction: column; overflow: hidden; }
button { font: inherit; color: inherit; }
[hidden] { display: none !important; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.muted { color: var(--muted); }
.spacer { flex: 1; }
.pad { padding: 8px 12px; margin: 0; }
kbd { font: inherit; font-size: 11px; color: var(--muted); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; }

.btn { display: inline-flex; align-items: center; gap: 8px; background: var(--bg-raised); border: 1px solid var(--border); border-radius: 8px; padding: 6px 12px; cursor: pointer; white-space: nowrap; }
.btn:hover:not(:disabled) { background: var(--bg-hover); }
.btn:disabled { opacity: 0.45; cursor: default; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn.danger { border-color: var(--danger); color: var(--danger); }
.btn.primary.danger { background: var(--danger); color: #fff; }
.btn.ghost { background: none; border-color: transparent; color: var(--muted); }
.btn.ghost:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }
.btn.outline { background: none; border-color: var(--accent); color: var(--accent-text); }
.btn.outline:hover:not(:disabled) { background: var(--accent-soft); }
.btn.wide { width: 100%; justify-content: center; }
.icon { display: inline-flex; align-items: center; justify-content: center; background: none; border: none; border-radius: 6px; padding: 6px; cursor: pointer; color: var(--muted); }
.icon:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }
.icon:disabled { opacity: 0.4; cursor: default; }
.icon.text { font-weight: 600; min-width: 32px; }
.link { background: none; border: none; color: var(--accent-text); cursor: pointer; padding: 2px 4px; }
.dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--muted); flex: none; }
.dot.ok { background: var(--ok); }
.dot.busy { background: var(--warn); }
.dot.rec { background: var(--danger); animation: pulse 1.4s ease-in-out infinite; }
.dot.error { background: var(--danger); }
.dot.external { background: var(--info); }
@keyframes pulse { 50% { opacity: 0.35; } }

/* == Icons == */
.i { display: inline-block; width: 18px; height: 18px; flex: none; background: currentColor; -webkit-mask: var(--icon) center / contain no-repeat; mask: var(--icon) center / contain no-repeat; }
.i-logo { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='M2 10v4M6 7v10M10 3v18M14 7v10M18 5v14M22 10v4'/%3E%3C/svg%3E"); }
.i-note { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='5' y='3' width='14' height='18' rx='2'/%3E%3Cpath d='M9 8h6M9 12h6M9 16h4'/%3E%3C/svg%3E"); }
.i-mic { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='9' y='2' width='6' height='12' rx='3'/%3E%3Cpath d='M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8'/%3E%3C/svg%3E"); }
.i-stop { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23000'%3E%3Crect x='5' y='5' width='14' height='14' rx='2'/%3E%3C/svg%3E"); }
.i-pause { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23000'%3E%3Crect x='6' y='4' width='4' height='16' rx='1'/%3E%3Crect x='14' y='4' width='4' height='16' rx='1'/%3E%3C/svg%3E"); }
.i-play { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23000'%3E%3Cpath d='M7 4v16l13-8z'/%3E%3C/svg%3E"); }
.i-moon { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z'/%3E%3C/svg%3E"); }
.i-sun { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round'%3E%3Ccircle cx='12' cy='12' r='4'/%3E%3Cpath d='M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'/%3E%3C/svg%3E"); }
.i-gear { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round'%3E%3Ccircle cx='12' cy='12' r='3'/%3E%3Ccircle cx='12' cy='12' r='7'/%3E%3Cpath d='M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2'/%3E%3C/svg%3E"); }
.i-chevron-down { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E"); }
.i-chevron-right { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M9 6l6 6-6 6'/%3E%3C/svg%3E"); }
.i-search { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cpath d='M20 20l-4-4'/%3E%3C/svg%3E"); }
.i-folder { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linejoin='round'%3E%3Cpath d='M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'/%3E%3C/svg%3E"); }
.i-file { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z'/%3E%3Cpath d='M14 3v5h5M9 13h6M9 17h6'/%3E%3C/svg%3E"); }
.i-clock { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round'%3E%3Ccircle cx='12' cy='12' r='9'/%3E%3Cpath d='M12 7v5l3 2'/%3E%3C/svg%3E"); }
.i-plus { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='M12 5v14M5 12h14'/%3E%3C/svg%3E"); }
.i-more { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23000'%3E%3Ccircle cx='5' cy='12' r='2'/%3E%3Ccircle cx='12' cy='12' r='2'/%3E%3Ccircle cx='19' cy='12' r='2'/%3E%3C/svg%3E"); }
.i-pencil { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linejoin='round'%3E%3Cpath d='M4 20h4L19 9l-4-4L4 16z'/%3E%3C/svg%3E"); }
.i-external { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'/%3E%3C/svg%3E"); }
.i-copy { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linejoin='round'%3E%3Crect x='8' y='8' width='12' height='12' rx='2'/%3E%3Cpath d='M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3'/%3E%3C/svg%3E"); }
.i-focus { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5'/%3E%3C/svg%3E"); }
.i-panel { --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linejoin='round'%3E%3Crect x='3' y='4' width='18' height='16' rx='2'/%3E%3Cpath d='M15 4v16'/%3E%3C/svg%3E"); }

/* == Header == */
.topbar { height: var(--header-height); flex: none; display: flex; align-items: center; gap: 12px; padding-left: 18px; border-bottom: 1px solid var(--border); background: var(--bg); -webkit-app-region: drag; user-select: none; }
.topbar button, .topbar input, .topbar select { -webkit-app-region: no-drag; }
.caption-space { width: var(--caption-width); flex: none; align-self: stretch; }
.brand { display: flex; align-items: center; gap: 10px; font-size: 20px; font-weight: 600; color: var(--text-strong); margin-right: 6px; white-space: nowrap; }
.brand .logo { width: 26px; height: 26px; color: var(--accent); }
.status { display: flex; align-items: center; gap: 8px; color: var(--muted); min-width: 0; max-width: 240px; }
.status > span:not(.dot) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn.quick { background: none; border-color: var(--quick); color: var(--quick); }
.btn.quick:hover:not(:disabled) { background: var(--quick-soft); }
.btn.quick.active { background: var(--quick-soft); }
.btn.quick.active .i { animation: pulse 1.4s ease-in-out infinite; }
.chip { display: inline-flex; align-items: center; gap: 8px; min-width: 0; max-width: 260px; background: var(--bg-pane); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; cursor: pointer; }
.chip > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip:hover { background: var(--bg-hover); }
.btn.record { padding: 9px 26px; font-size: 15px; font-weight: 600; border-radius: 10px; }
.btn.record.recording, .btn.record.recording:disabled { background: var(--danger); border-color: var(--danger); opacity: 1; }
.run-controls { display: flex; align-items: center; gap: 4px; padding-left: 8px; border-left: 1px solid var(--border); }
.banner { flex: none; display: flex; align-items: center; gap: 12px; padding: 8px 18px; background: var(--accent-soft); border-bottom: 1px solid var(--border); }
@media (max-width: 1240px) {
  .brand-name { display: none; }
  .chip { max-width: 180px; }
}
@media (max-width: 1080px) {
  .run-controls .btn > span:not(.i) { display: none; }
  .status { max-width: 120px; }
}
/* Old header layout, removed by Task 8. */
.dictation, .session-controls, .tools, .server { display: flex; align-items: center; gap: 8px; min-width: 0; }
.last { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; max-width: 200px; }

/* == Workspace == */
.workspace { flex: 1; display: grid; grid-template-columns: 280px minmax(0, 1fr) 330px; min-height: 0; }
.workspace.panel-collapsed { grid-template-columns: 280px minmax(0, 1fr) 44px; }
.workspace.panel-collapsed .panel-body { display: none; }
.workspace.focus { grid-template-columns: minmax(0, 1fr); }
.workspace.focus .library, .workspace.focus .panel { display: none; }
@media (max-width: 1100px) {
  .workspace { grid-template-columns: 240px minmax(0, 1fr) 280px; }
  .workspace.panel-collapsed { grid-template-columns: 240px minmax(0, 1fr) 44px; }
}

/* == Library == */
.library { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: var(--bg); }
.search { display: flex; align-items: center; gap: 8px; margin: 14px 14px 6px; padding: 0 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-input); color: var(--muted); }
.search:focus-within { border-color: var(--accent); }
.search input { flex: 1; min-width: 0; border: none; outline: none; background: none; color: var(--text); padding: 9px 0; font: inherit; }
.library-body { flex: 1; overflow-y: auto; outline: none; padding: 4px 8px 12px; }
.section-title { display: flex; align-items: center; gap: 8px; padding: 16px 8px 6px; color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; }
.row { display: flex; align-items: center; gap: 10px; min-height: 36px; padding: 7px 10px; border-radius: 8px; cursor: pointer; color: var(--text); }
.row:hover { background: var(--bg-hover); }
.row.selected { background: var(--bg-selected); }
.row.target { background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent); }
.row.root { min-height: 0; padding: 14px 8px 6px; color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; }
.row.root:hover { background: none; color: var(--text); }
.row.root.target { background: none; box-shadow: none; color: var(--accent-text); }
.library-body:focus .row.focused { outline: 1px solid var(--accent); outline-offset: -1px; }
.row .twisty { width: 14px; height: 14px; color: var(--muted); }
.row .twisty.none { visibility: hidden; }
.row .kind { color: var(--muted); }
.row.folder .kind { color: var(--accent-text); }
.row .kind.quick { color: var(--quick); }
.row .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .count, .row .date { flex: none; color: var(--muted); font-size: 12px; }
.row .rec-dot, .row .warn { flex: none; }
.row .warn { color: var(--warn); }
.row .row-menu { visibility: hidden; padding: 2px; }
.row:hover .row-menu, .row.selected .row-menu { visibility: visible; }
.row.hit { flex-direction: column; align-items: stretch; gap: 2px; }
.row.hit .snippet { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.library-footer { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border-top: 1px solid var(--border); }
.footer-line { display: flex; align-items: center; gap: 8px; color: var(--muted); }

/* == Document == */
.document { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--bg-pane); }
.doc-bar { display: flex; align-items: center; gap: 10px; min-height: 60px; padding: 10px 22px; border-bottom: 1px solid var(--border); }
.doc-bar .doc-icon { width: 22px; height: 22px; color: var(--muted); }
.doc-bar h1 { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 20px; font-weight: 600; color: var(--text-strong); }
.meter { display: flex; align-items: center; gap: 2px; height: 28px; }
.meter .bar { width: 3px; height: 100%; border-radius: 2px; background: var(--accent); transform: scaleY(0.08); transition: transform 0.12s linear; }
.live-badge { display: inline-flex; align-items: center; gap: 8px; padding: 4px 12px; border: 1px solid var(--ok); border-radius: 8px; background: var(--ok-soft); color: var(--ok); font-weight: 600; }
.live-badge .dot { background: var(--ok); }
.doc-body { flex: 1; overflow-y: auto; padding: 18px 22px 48px 10px; line-height: 1.65; }
.doc-body.size-0 { font-size: 13px; }
.doc-body.size-1 { font-size: 15px; }
.doc-body.size-2 { font-size: 17px; }
.para { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 14px; margin-bottom: 10px; padding: 6px 8px; border-radius: 8px; }
.para .margin { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; padding-top: 2px; color: var(--accent-text); font-size: 0.87em; font-variant-numeric: tabular-nums; }
.para .md > :first-child { margin-top: 0; }
.para .md > :last-child { margin-bottom: 0; }
.para.live { box-shadow: inset 2px 0 0 var(--danger); }
.doc-body .md a { color: var(--accent-text); }
.doc-body .md pre, .doc-body .md code { background: var(--bg-raised); border-radius: 4px; }
.doc-body .md pre { padding: 8px 10px; overflow-x: auto; }
.doc-body .md blockquote { margin-left: 0; padding-left: 12px; border-left: 3px solid var(--border); color: var(--muted); }
.doc-body .md img { max-width: 100%; }
.doc-body .gap { margin: 12px 0 12px 86px; padding-top: 4px; border-top: 1px dashed var(--border); color: var(--muted); font-size: 12px; text-align: center; }
.doc-body .cursor { color: var(--accent); animation: blink 1s steps(1) infinite; }
.doc-body .flash { animation: flash 1.6s ease-out; }
.hit-line { border-radius: 4px; animation: hit 6s ease-out forwards; }
.doc-body .empty-state, .doc-body .error-state { margin-top: 40px; color: var(--muted); text-align: center; }
.doc-body .error-state { color: var(--danger); }
.jump { position: absolute; right: 26px; bottom: 70px; box-shadow: var(--shadow); }
.doc-toolbar { display: flex; align-items: center; gap: 6px; margin: 0 16px; padding: 8px 4px; border-top: 1px solid var(--border); }
@keyframes blink { 50% { opacity: 0; } }
@keyframes flash { from { background: var(--accent-soft); } to { background: transparent; } }
@keyframes hit { 0%, 70% { background: var(--accent-soft); box-shadow: 0 0 0 4px var(--accent-soft); } 100% { background: transparent; box-shadow: none; } }

.badge { display: inline-block; padding: 1px 9px; border-radius: 10px; background: var(--bg-raised); color: var(--muted); font-size: 11px; line-height: 1.5; white-space: nowrap; }
.badge.live { color: var(--danger); }
.badge.queued, .badge.refining { background: var(--info-soft); color: var(--info); }
.badge.refined { background: var(--ok-soft); color: var(--ok); }
.badge.failed, .badge.skipped { color: var(--danger); }

/* == Panel == */
.panel { position: relative; min-height: 0; overflow-y: auto; border-left: 1px solid var(--border); background: var(--bg); }
.panel .collapse { position: absolute; top: 12px; right: 10px; z-index: 1; }
.panel-body { padding: 6px 18px 24px; }
.panel-section { padding: 2px 0 12px; border-bottom: 1px solid var(--border); }
.section-head { display: flex; align-items: center; gap: 10px; width: 100%; padding: 12px 36px 10px 0; background: none; border: none; cursor: pointer; color: var(--text-strong); font-size: 16px; font-weight: 600; text-align: left; }
.section-head .chev { width: 16px; height: 16px; color: var(--muted); transform: rotate(-90deg); transition: transform 0.15s; }
.panel-section.open .section-head .chev { transform: none; }
.section-head .extra { margin-left: auto; color: var(--muted); font-size: 12px; font-weight: 400; }
.details { display: grid; grid-template-columns: minmax(96px, auto) 1fr; gap: 8px 14px; margin: 0; }
.details dt { color: var(--accent-text); }
.details dd { margin: 0; overflow-wrap: anywhere; }
.state-line { display: flex; align-items: center; gap: 8px; }
.pill { display: inline-flex; align-items: center; gap: 6px; padding: 1px 10px; border-radius: 8px; background: var(--accent-soft); color: var(--accent-text); font-size: 12px; }
.blocks { list-style: none; margin: 0; padding: 0; }
.block-row { display: grid; grid-template-columns: 28px 1fr auto; gap: 8px; align-items: center; padding: 6px 4px; border-radius: 6px; cursor: pointer; font-variant-numeric: tabular-nums; }
.block-row:hover { background: var(--bg-hover); }
.block-row .num { color: var(--muted); }
.block-row .msg { grid-column: 2 / 4; color: var(--muted); font-size: 12px; }
.messages { margin: 10px 0 0; padding-left: 16px; color: var(--muted); }

/* == Menus, toasts, dialogs == */
.menu { position: fixed; z-index: 20; min-width: 190px; padding: 4px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-pane); box-shadow: var(--shadow); }
.menu-item { display: block; width: 100%; padding: 7px 10px; border: none; border-radius: 6px; background: none; text-align: left; cursor: pointer; }
.menu-item:hover, .menu-item:focus { background: var(--bg-hover); outline: none; }
.menu-item.danger { color: var(--danger); }

.toasts { position: fixed; right: 16px; bottom: 16px; z-index: 30; display: flex; flex-direction: column; gap: 8px; max-width: 420px; }
.toast { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border: 1px solid var(--border); border-left: 4px solid var(--info); border-radius: 8px; background: var(--bg-pane); box-shadow: var(--shadow); }
.toast.error { border-left-color: var(--danger); }
.toast > span { flex: 1; }

dialog { width: 380px; max-height: 85vh; overflow-y: auto; padding: 18px 20px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-pane); color: var(--text); box-shadow: var(--shadow); }
dialog.wide { width: 560px; }
dialog::backdrop { background: rgba(0, 0, 0, 0.55); }
dialog h2 { margin: 0 0 12px; font-size: 17px; }
dialog h3 { margin: 18px 0 6px; color: var(--muted); font-size: 13px; letter-spacing: 0.05em; text-transform: uppercase; }
dialog label { display: block; margin: 8px 0 3px; }
dialog label.check { display: flex; align-items: center; gap: 8px; }
dialog input[type='text'], dialog input[type='password'], dialog input[type='number'], dialog select {
  width: 100%; padding: 6px 9px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-input); color: var(--text);
}
dialog .row-input { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
dialog .row-input input { flex: 1; }
dialog .hint { margin: 3px 0 0; color: var(--muted); font-size: 12px; }
dialog .actions { display: flex; flex-direction: row-reverse; gap: 8px; margin-top: 18px; }
.dialog-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.model-list { display: flex; flex-direction: column; gap: 6px; margin: 10px 0 14px; }
.model-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; }
.model-name { font-weight: 600; }
.model-meta { color: var(--muted); font-size: 12px; }
.model-error { color: var(--danger); font-size: 12px; }
.model-actions { display: flex; align-items: center; gap: 6px; flex: none; }
.badge-active { color: var(--ok); font-size: 12px; }
.progress { width: 90px; height: 6px; overflow: hidden; border-radius: 3px; background: var(--bg-raised); }
.progress-bar { width: 0; height: 100%; background: var(--accent); }
```

- [ ] **Step 7: Build, test, lint and look**

Run: `npm run build && npm test && npm run lint`
Expected: success.

Then launch a throwaway instance and check the frame and theme toggle (nothing is recorded):

```bash
node -e "const p=require('fs').mkdtempSync(require('path').join(require('os').tmpdir(),'dw-look-'));console.log(p)"
npx electron . --user-data-dir=<the printed folder>
```

Expected: no Windows title bar; the caption buttons sit on the dark header; the moon button switches to the light theme and the caption buttons follow; restarting that instance keeps the light theme. Close it and delete the folder.

- [ ] **Step 8: Commit**

```bash
git add public/app.css public/index.html src/main.ts src/renderer/app.ts src/renderer/theme.ts src/services/windowTheme.ts src/__tests__/windowTheme.test.ts
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Add colour tokens, a light theme and a frameless window

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: New header with Quick Notes; remove paste dictation

**Files:**
- Create: `src/renderer/headerModel.ts`
- Modify (rewrite): `src/renderer/header.ts`, `src/main.ts`, `src/preload.ts`
- Modify: `src/shared/api.ts`, `src/services/settingsService.ts`, `src/services/libraryRuntime.ts`, `src/renderer/dialogs.ts`, `src/renderer/app.ts`, `public/index.html`, `public/app.css`
- Delete: `src/services/pasteService.ts`, `src/services/audioControlService.ts`, `src/services/audioService.ts`, `src/services/micWrapper.ts`, `src/services/recordingService.ts`
- Test: `src/__tests__/headerModel.test.ts`

**Interfaces:**
- Consumes: `toggleQuickNote`, `startSession(request)` (Task 6); `onAudioLevel` (Task 2); `titleBarOverlay`, `windowBackground` (Task 7).
- Produces:
  - `shortModelName(id: string | null | undefined): string`, `modelChipText(settings: Pick<SettingsView, 'liveModelId' | 'modelId' | 'serverMode'>): string`, `headerStatus(server: ServerStatusView | null, session: SessionStatusView | null): { text: string; tone: 'ok' | 'busy' | 'rec' | 'error' | 'idle' | 'external' }` in `headerModel.ts`.
  - `setSettings(settings: SettingsView): void` exported from `header.ts` (replaces `setShortcut`).
  - `window.api.onSessionLevel(callback: (level: number) => void): void`; IPC event `session-level`.
  - `SettingsView`/`Settings` lose `autoMuteAudio` and `micDevice`. `DarkWhisperApi` loses `onTranscriptionComplete`, `onRecordingStarted`, `onRecordingStopped`, `getStatus`, `startRecording`, `stopRecording`, `copyToClipboard`, `getAudioDevices` (keeps `onError`, `copyText`).
  - Header element ids: `serverStatus`, `serverDot`, `serverText`, `serverRestartBtn`, `serverLogBtn`, `quickNoteBtn`, `quickNoteLabel`, `modelChip`, `modelChipText`, `recordBtn`, `recordLabel`, `stopBtn`, `pauseBtn`, `pauseIcon`, `pauseLabel`, `themeBtn`, `themeIcon`, `settingsBtn`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/headerModel.test.ts`:

```ts
import type { ServerStatusView, SessionStatusView } from '../shared/api';
import { headerStatus, modelChipText, shortModelName } from '../renderer/headerModel';

const server = (overrides: Partial<ServerStatusView> = {}): ServerStatusView => ({
  state: 'ready',
  mode: 'builtin',
  text: 'Ready — large-v3-turbo-q5_0 (GPU)',
  modelId: 'ggml-large-v3-turbo-q5_0.bin',
  gpu: true,
  ...overrides,
});

const session = (overrides: Partial<SessionStatusView> = {}): SessionStatusView => ({
  sessionId: 's1',
  kind: 'session',
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

describe('headerModel', () => {
  it('shortens model file names', () => {
    expect(shortModelName('ggml-large-v3-turbo-q5_0.bin')).toBe('large-v3-turbo');
    expect(shortModelName('ggml-base.en.bin')).toBe('base.en');
    expect(shortModelName('ggml-medium-q8_0.bin')).toBe('medium');
    expect(shortModelName(null)).toBe('none');
  });

  it('shows the live and refine models on the chip', () => {
    expect(modelChipText({ liveModelId: 'ggml-base.en.bin', modelId: 'ggml-large-v3-turbo-q5_0.bin', serverMode: 'builtin' })).toBe(
      'base.en → large-v3-turbo',
    );
    expect(modelChipText({ liveModelId: 'ggml-base.en.bin', modelId: null, serverMode: 'external' })).toBe('base.en → External API');
  });

  it('prefers what is recording over the server state', () => {
    expect(headerStatus(server(), session())).toEqual({ text: 'Recording', tone: 'rec' });
    expect(headerStatus(server(), session({ kind: 'quick-note' }))).toEqual({ text: 'Quick note', tone: 'rec' });
    expect(headerStatus(server(), session({ state: 'paused' }))).toEqual({ text: 'Paused', tone: 'busy' });
    expect(headerStatus(server(), session({ state: 'starting' }))).toEqual({ text: 'Starting…', tone: 'busy' });
    expect(headerStatus(server(), session({ state: 'error', message: 'Mic gone' }))).toEqual({ text: 'Mic gone', tone: 'error' });
    expect(headerStatus(server(), session({ state: 'stopped', refining: 2 }))).toEqual({ text: 'Refining 2', tone: 'busy' });
  });

  it('falls back to the server state', () => {
    expect(headerStatus(server(), session({ state: 'stopped' }))).toEqual({ text: 'Ready', tone: 'ok' });
    expect(headerStatus(server(), null)).toEqual({ text: 'Ready', tone: 'ok' });
    expect(headerStatus(null, null)).toEqual({ text: 'Checking…', tone: 'idle' });
    expect(headerStatus(server({ state: 'starting', text: 'Loading model…' }), null)).toEqual({ text: 'Loading model…', tone: 'busy' });
    expect(headerStatus(server({ state: 'error', text: 'Server crashed' }), null)).toEqual({ text: 'Server crashed', tone: 'error' });
    expect(headerStatus(server({ state: 'no-model', text: 'No model' }), null)).toEqual({ text: 'No model', tone: 'idle' });
    expect(headerStatus(server({ mode: 'external', text: 'External API' }), null)).toEqual({ text: 'External API', tone: 'external' });
  });
});
```

Run: `npx jest src/__tests__/headerModel.test.ts` → FAIL (module not found).

- [ ] **Step 2: Implement `src/renderer/headerModel.ts`**

```ts
import type { ServerStatusView, SessionStatusView, SettingsView } from '../shared/api.js';

export type HeaderTone = 'ok' | 'busy' | 'rec' | 'error' | 'idle' | 'external';

// 'ggml-large-v3-turbo-q5_0.bin' → 'large-v3-turbo'
export function shortModelName(id: string | null | undefined): string {
  if (!id) return 'none';
  return id
    .replace(/^ggml-/, '')
    .replace(/\.bin$/, '')
    .replace(/-q\d+(_\d+)?$/, '');
}

export function modelChipText(settings: Pick<SettingsView, 'liveModelId' | 'modelId' | 'serverMode'>): string {
  const refine = settings.serverMode === 'external' ? 'External API' : shortModelName(settings.modelId);
  return `${shortModelName(settings.liveModelId)} → ${refine}`;
}

// The header's one status line: what is recording wins over the server.
export function headerStatus(
  server: ServerStatusView | null,
  session: SessionStatusView | null,
): { text: string; tone: HeaderTone } {
  if (session) {
    if (session.state === 'error') return { text: session.message ?? 'Recording error', tone: 'error' };
    if (session.state === 'starting') return { text: 'Starting…', tone: 'busy' };
    if (session.state === 'recording') return { text: session.kind === 'quick-note' ? 'Quick note' : 'Recording', tone: 'rec' };
    if (session.state === 'paused') return { text: 'Paused', tone: 'busy' };
    if (session.refining > 0) return { text: `Refining ${session.refining}`, tone: 'busy' };
  }
  if (!server) return { text: 'Checking…', tone: 'idle' };
  if (server.mode === 'external') return { text: server.text, tone: 'external' };
  if (server.state === 'ready') return { text: 'Ready', tone: 'ok' };
  if (server.state === 'error') return { text: server.text, tone: 'error' };
  if (server.state === 'starting') return { text: server.text, tone: 'busy' };
  return { text: server.text, tone: 'idle' };
}
```

Run: `npx jest src/__tests__/headerModel.test.ts` → PASS.

- [ ] **Step 3: Header markup and settings dialog**

In `public/index.html`, replace the whole `<header class="topbar">…</header>` element with:

```html
  <header class="topbar">
    <div class="brand"><span class="i i-logo logo" aria-hidden="true"></span><span class="brand-name">Dark-Whisper</span></div>
    <div class="status" id="serverStatus">
      <span class="dot" id="serverDot"></span>
      <span id="serverText">Checking…</span>
      <button class="link" id="serverRestartBtn" hidden>Restart</button>
      <button class="link" id="serverLogBtn" hidden>Open log</button>
    </div>
    <button class="btn quick" id="quickNoteBtn"><span class="i i-note" aria-hidden="true"></span><span id="quickNoteLabel">Quick Notes</span></button>
    <button class="chip" id="modelChip" title="Speech models"><span id="modelChipText">…</span><span class="i i-chevron-down" aria-hidden="true"></span></button>
    <button class="btn primary record" id="recordBtn"><span class="i i-mic" aria-hidden="true"></span><span id="recordLabel">Record</span></button>
    <div class="run-controls">
      <button class="btn ghost" id="stopBtn" disabled><span class="i i-stop" aria-hidden="true"></span><span>Stop</span></button>
      <button class="btn ghost" id="pauseBtn" disabled><span class="i i-pause" id="pauseIcon" aria-hidden="true"></span><span id="pauseLabel">Pause</span></button>
    </div>
    <div class="spacer"></div>
    <button class="icon" id="themeBtn" title="Switch theme"><span class="i i-moon" id="themeIcon" aria-hidden="true"></span></button>
    <button class="icon" id="settingsBtn" title="Settings"><span class="i i-gear" aria-hidden="true"></span></button>
    <div class="caption-space" aria-hidden="true"></div>
  </header>
```

In the settings dialog, replace the whole "Quick dictation" group (the `<h3>Quick dictation</h3>` heading through the `autoMuteInput` checkbox label) with:

```html
      <h3>Quick notes</h3>
      <label for="shortcutInput">Quick note shortcut</label>
      <input type="text" id="shortcutInput" placeholder="e.g. Ctrl+Q, Alt+R">
      <p class="hint">Quick notes go to the Quick Notes folder, one file per day.</p>
```

In `public/app.css`, delete the two lines under `/* Old header layout, removed by Task 8. */` and that comment.

In `src/services/libraryRuntime.ts`, change the refusal `'This document is being recorded. Stop the session first.'` to `'This document is being recorded. Stop recording first.'` (quick notes record too).

In `src/renderer/dialogs.ts`:
- remove `micDevice` and `autoMute` from `settingsFields()`;
- delete `fillMicDevices`;
- in `openSettings()`, delete `f.autoMute.checked = …;` and change the `Promise.all([...])` to `await fillCaptureDevices(settings.captureDeviceName);`;
- in `saveSettingsFromDialog()`, delete the `micDevice` and `autoMuteAudio` lines, and change the toast to `toast('Settings saved.');`.

- [ ] **Step 4: Shared API and settings**

In `src/shared/api.ts`:
- `SettingsView`: delete `autoMuteAudio: boolean;` and `micDevice: string;`.
- `DarkWhisperApi`: replace the `// Quick dictation` group with
```ts
  // Errors raised outside a renderer call (e.g. the Quick Note shortcut)
  onError(callback: (data: { message: string }) => void): void;
  copyText(text: string): Promise<void>;
```
  delete `getAudioDevices(): …;`, and add after `onSessionBlock(…)`:
```ts
  onSessionLevel(callback: (level: number) => void): void;
```

In `src/services/settingsService.ts`: delete `autoMuteAudio` and `micDevice` from `Settings`, from the store defaults and from `getSettings()`.

Replace `src/preload.ts` with:

```ts
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
```

- [ ] **Step 5: Rewrite `src/main.ts`**

Replace the whole file with:

```ts
import './appIdentity';
import { app, BrowserWindow, clipboard, globalShortcut, Menu, Tray, ipcMain, Notification, shell } from 'electron';
import path from 'path';
import * as fs from 'fs';
import registerShortcuts from './services/hotkeyService';
import { setApiConfig, BUILTIN_TIMEOUT_MS, EXTERNAL_TIMEOUT_MS } from './services/apiService';
import { DEFAULT_VAULT_PATH, getSettings, saveSettings } from './services/settingsService';
import { cleanupStaleServer, modelManager, openServerLog, startBuiltinServer, whisperServer } from './services/whisperRuntime';
import { toStatusView } from './services/serverGate';
import type { DownloadProgress } from './services/modelManager';
import {
  captureDevices,
  isSessionActive,
  onSessionBlock,
  onSessionSegment,
  onSessionStatus,
  openVault,
  pauseSession,
  resumeSession,
  revealDocument,
  SessionStatusView,
  sessionStatus,
  startSession,
  stopSession,
  toggleQuickNote,
} from './services/sessionRuntime';
import { onAudioLevel } from './services/streamRuntime';
import { parseStartRequest } from './services/quickNotes';
import { titleBarOverlay, windowBackground } from './services/windowTheme';
import { onLibraryChanged, registerLibraryIpc, stopWatching, watchVault } from './services/libraryRuntime';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let currentShortcut = 'Ctrl+Q';

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to run a second instance, show the existing window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

const openExternalLink = (url: string) => {
  if (/^https?:\/\//i.test(url)) {
    void shell.openExternal(url);
  }
};

const createWindow = () => {
  const theme = getSettings().theme;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: windowBackground(theme),
    // The page draws its own header; Windows keeps drawing the caption buttons over it.
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(theme),
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
    event.preventDefault();
    openExternalLink(url);
  });

  // Hide instead of close on window close
  mainWindow.on('close', (event) => {
    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Always start in background (hidden in tray)
  // User can show window via tray menu "Show/Hide" option
};

const showSystemNotification = (title: string, body: string, autoCloseMs?: number) => {
  const notification = new Notification({
    title: title,
    body: body,
    timeoutType: 'never',
    silent: true,
  });
  notification.show();

  if (autoCloseMs !== undefined) {
    setTimeout(() => {
      notification.close();
    }, autoCloseMs);
  }

  return notification;
};

const showModelsWindow = () => {
  mainWindow?.show();
  mainWindow?.webContents.send('open-models');
};

const currentStatusView = () => {
  const settings = getSettings();
  return toStatusView(settings.serverMode, whisperServer.getStatus(), settings.apiUrl);
};

const applyApiConfig = () => {
  const settings = getSettings();
  if (settings.serverMode === 'builtin') {
    // Port 1 is never listening, so requests fail fast until the server reports ready.
    setApiConfig(whisperServer.getBaseUrl() ?? 'http://127.0.0.1:1', '', { timeoutMs: BUILTIN_TIMEOUT_MS });
  } else {
    setApiConfig(settings.apiUrl, settings.apiToken, { timeoutMs: EXTERNAL_TIMEOUT_MS });
  }
};

const RUN_TRAY_STATES: Partial<Record<SessionStatusView['state'], string>> = {
  starting: 'starting',
  recording: 'recording',
  paused: 'paused',
  error: 'error',
};

// The tray reports the active mode: a running session or quick note wins over the server status.
const updateTrayTooltip = () => {
  const status = isSessionActive() ? sessionStatus() : null;
  const state = status ? RUN_TRAY_STATES[status.state] : undefined;
  const label = status && state ? `${status.kind === 'quick-note' ? 'Quick note' : 'Session'} ${state}` : currentStatusView().text;
  tray?.setToolTip(`Dark-Whisper — ${label}`);
};

const handleServerStatus = () => {
  applyApiConfig();
  const view = currentStatusView();
  mainWindow?.webContents.send('server-status', view);
  updateTrayTooltip();
};

// The shortcut, the tray and the header button all toggle a quick note (spec §3.4). A refusal
// (a session is recording) is shown in the window, and as a notification when it is hidden.
const handleQuickNoteToggle = async () => {
  try {
    await toggleQuickNote();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    mainWindow?.webContents.send('error', { message });
    if (!mainWindow?.isVisible()) showSystemNotification('Dark-Whisper', message, 4000);
  }
};

const registerQuickNoteShortcut = (shortcut: string) => {
  globalShortcut.unregisterAll();
  registerShortcuts(() => void handleQuickNoteToggle(), shortcut);
};

const runDownload = (requestedId: string, start: () => Promise<DownloadProgress>) => {
  start()
    .then(async (result) => {
      if (result.state === 'done' && !getSettings().modelId) {
        saveSettings({ modelId: result.id });
        await startBuiltinServer();
      }
    })
    .catch((error: unknown) => {
      const progress: DownloadProgress = {
        id: requestedId,
        receivedBytes: 0,
        totalBytes: null,
        bytesPerSec: 0,
        state: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
      mainWindow?.webContents.send('download-progress', progress);
    });
};

const buildTrayMenu = () =>
  Menu.buildFromTemplate([
    {
      label: 'Show/Hide',
      click: () => {
        if (mainWindow?.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow?.show();
        }
      },
    },
    {
      label: `Quick note (${currentShortcut})`,
      click: () => void handleQuickNoteToggle(),
    },
    {
      label: 'Models…',
      click: showModelsWindow,
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => {
        app.quit();
      },
    },
  ]);

const createTray = () => {
  try {
    // Load custom icon - use app.getAppPath() for correct path in packaged app
    const iconPath = path.join(app.getAppPath(), 'assets/whisper.ico');
    if (!fs.existsSync(iconPath)) {
      throw new Error(`Icon file not found at ${iconPath}`);
    }
    tray = new Tray(iconPath);
  } catch (error) {
    console.error('Error creating tray:', error);
    // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
    const { nativeImage } = require('electron');
    const image = nativeImage.createEmpty();
    tray = new Tray(image);
  }

  tray.setContextMenu(buildTrayMenu());
  tray.setToolTip('Dark-Whisper');
};

app.on('ready', () => {
  if (!gotTheLock) return;
  const settings = getSettings();
  currentShortcut = settings.shortcut;

  // Enable auto-start on Windows startup (minimized to tray). Dev and smoke launches are never
  // packaged, so this never registers a login item outside a real install.
  if (process.platform === 'win32' && app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: app.getPath('exe'),
      args: ['--hidden'],
    });
  }

  createWindow();
  createTray();
  registerQuickNoteShortcut(settings.shortcut);

  whisperServer.onStatus(handleServerStatus);
  onSessionStatus((view) => {
    mainWindow?.webContents.send('session-status', view);
    updateTrayTooltip();
  });
  onSessionSegment((segment) => mainWindow?.webContents.send('session-segment', segment));
  onSessionBlock((event) => mainWindow?.webContents.send('session-block', event));
  onAudioLevel((level) => mainWindow?.webContents.send('session-level', level));
  // A fresh install has no vault yet; only ever auto-create the default one, never a custom
  // path the user chose (a missing custom vault keeps showing "Vault not found").
  if (settings.vaultPath === DEFAULT_VAULT_PATH) {
    fs.mkdirSync(DEFAULT_VAULT_PATH, { recursive: true });
  }
  watchVault();
  onLibraryChanged((change) => mainWindow?.webContents.send('library-changed', change));
  modelManager.onProgress((progress) => mainWindow?.webContents.send('download-progress', progress));
  handleServerStatus();

  (async () => {
    await cleanupStaleServer();
    await modelManager.init();
    await startBuiltinServer();
    if (getSettings().serverMode === 'builtin' && whisperServer.getStatus().state === 'no-model') {
      const notification = showSystemNotification('Dark-Whisper', 'Choose a speech model to finish setup', 8000);
      notification.on('click', showModelsWindow);
    }
  })().catch((error) => console.error('Failed to start transcription server:', error));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('before-quit', () => {
  if (mainWindow) {
    mainWindow.removeAllListeners('close');
  }
  if (isSessionActive()) {
    void stopSession();
  }
  globalShortcut.unregisterAll();
  modelManager.cancelDownload();
  whisperServer.stop();
  stopWatching();
});

ipcMain.handle('get-settings', () => {
  return getSettings();
});

ipcMain.handle('save-settings', async (_event, settings: any) => {
  const before = getSettings();
  if (typeof settings?.vaultPath === 'string' && settings.vaultPath !== before.vaultPath && isSessionActive()) {
    throw new Error('Stop recording before changing the vault.');
  }
  saveSettings(settings);
  const after = getSettings();

  if (before.theme !== after.theme && mainWindow) {
    mainWindow.setTitleBarOverlay(titleBarOverlay(after.theme));
    mainWindow.setBackgroundColor(windowBackground(after.theme));
  }

  if (before.vaultPath !== after.vaultPath) {
    watchVault();
    mainWindow?.webContents.send('library-changed', { paths: [] });
  }

  if (before.forceCpu && !after.forceCpu) {
    saveSettings({ gpuFallbackVersion: null });
  }
  if (before.serverMode !== after.serverMode || before.forceCpu !== after.forceCpu) {
    await startBuiltinServer();
  }
  handleServerStatus();

  if (after.shortcut !== before.shortcut) {
    currentShortcut = after.shortcut;
    registerQuickNoteShortcut(after.shortcut);
    tray?.setContextMenu(buildTrayMenu());
  }

  return { success: true };
});

ipcMain.handle('get-server-status', () => currentStatusView());

ipcMain.handle('restart-server', async () => {
  await startBuiltinServer();
});

ipcMain.handle('open-server-log', async () => {
  await openServerLog();
});

ipcMain.handle('list-models', async () => ({
  models: modelManager.listModels(),
  activeModelId: getSettings().modelId,
  downloading: modelManager.isDownloading(),
  disk: await modelManager.getDiskInfo(),
}));

ipcMain.handle('download-model', (_event, id: string) => {
  runDownload(id, () => modelManager.startDownload(id));
});

ipcMain.handle('download-custom-model', (_event, url: string) => {
  runDownload('custom', () => modelManager.startCustomDownload(url));
});

ipcMain.handle('cancel-download', () => {
  modelManager.cancelDownload();
});

ipcMain.handle('delete-model', async (_event, id: string) => {
  if (!modelManager.isValidId(id)) {
    throw new Error('Unknown model');
  }
  if (getSettings().modelId === id) {
    whisperServer.setNoModel();
    saveSettings({ modelId: null });
  }
  await modelManager.deleteModel(id);
});

ipcMain.handle('select-model', async (_event, id: string) => {
  if (!modelManager.getModelPath(id)) {
    throw new Error('Model is not installed');
  }
  saveSettings({ modelId: id });
  await startBuiltinServer();
});

ipcMain.handle('session-start', (_event, request?: unknown) => startSession(parseStartRequest(request)));
ipcMain.handle('quick-note-toggle', () => toggleQuickNote());
ipcMain.handle('session-pause', () => pauseSession());
ipcMain.handle('session-resume', () => resumeSession());
ipcMain.handle('session-stop', () => stopSession());
ipcMain.handle('session-status', () => sessionStatus());
ipcMain.handle('list-capture-devices', () => captureDevices());
ipcMain.handle('open-vault', () => openVault());
ipcMain.handle('reveal-document', () => revealDocument());

registerLibraryIpc(() => mainWindow);

ipcMain.handle('copy-text', async (_event, text: unknown) => {
  if (typeof text !== 'string') throw new Error('text must be text');
  await clipboard.writeText(text);
});
```

Then delete the dead dictation modules:

```bash
git rm src/services/pasteService.ts src/services/audioControlService.ts src/services/audioService.ts src/services/micWrapper.ts src/services/recordingService.ts
```

(`streamRuntime.ts` already imports `getSoxPath` from `./soxPath` since Task 2.) If `npm run build` reports another importer of a deleted module, point it at `./soxPath` or remove the dead code.

- [ ] **Step 6: Rewrite `src/renderer/header.ts`**

```ts
import type { ServerStatusView, SettingsView } from '../shared/api.js';
import { openModels, openSettings, startModelDownload } from './dialogs.js';
import { byId } from './dom.js';
import { headerStatus, modelChipText } from './headerModel.js';
import { isSessionRunning } from './sessionModel.js';
import { getState, subscribe } from './state.js';
import { reportError, toast } from './toast.js';

const RECOMMENDED_MODEL_ID = 'ggml-large-v3-turbo-q5_0.bin';

let server: ServerStatusView | null = null;
let settings: SettingsView | null = null;

function render(): void {
  const { session, tree } = getState();
  const status = session.status;
  const running = isSessionRunning(status);
  const quick = running && status?.kind === 'quick-note';
  const noVault = tree?.exists === false;

  const line = headerStatus(server, status);
  byId('serverText').textContent = line.text;
  byId('serverDot').className = `dot ${line.tone}`;
  byId('serverStatus').title = server?.text ?? '';
  const failed = server?.mode === 'builtin' && server.state === 'error';
  byId('serverRestartBtn').hidden = !failed;
  byId('serverLogBtn').hidden = !failed;
  byId('setupBanner').hidden = !(server?.mode === 'builtin' && server.state === 'no-model');

  const shortcut = settings?.shortcut ?? 'Ctrl+Q';
  const quickBtn = byId<HTMLButtonElement>('quickNoteBtn');
  quickBtn.classList.toggle('active', quick);
  quickBtn.disabled = (running && !quick) || noVault;
  quickBtn.title = quick ? `Stop the quick note (${shortcut})` : `Start a quick note in today's file (${shortcut})`;
  byId('quickNoteLabel').textContent = quick ? 'Stop quick note' : 'Quick Notes';

  const record = byId<HTMLButtonElement>('recordBtn');
  record.disabled = running || noVault;
  record.classList.toggle('recording', running && !quick);
  byId('recordLabel').textContent = running && !quick ? 'Recording' : 'Record';
  const folder = getState().selectedFolder;
  record.title = `Start a session in ${folder || 'the vault root'}`;

  const paused = status?.state === 'paused';
  const pause = byId<HTMLButtonElement>('pauseBtn');
  pause.disabled = !running || status?.state === 'error' || status?.state === 'starting';
  byId('pauseLabel').textContent = paused ? 'Resume' : 'Pause';
  byId('pauseIcon').className = `i ${paused ? 'i-play' : 'i-pause'}`;
  byId<HTMLButtonElement>('stopBtn').disabled = !running;

  byId('modelChipText').textContent = settings ? modelChipText(settings) : '…';
}

export function setSettings(value: SettingsView): void {
  settings = value;
  render();
}

function refreshSettings(): void {
  window.api.getSettings().then(setSettings, reportError);
}

export function initHeader(): void {
  window.api.onServerStatus((view) => {
    server = view;
    // A model change restarts the server: the chip follows.
    refreshSettings();
    render();
  });
  window.api.getServerStatus().then((view) => {
    server = view;
    render();
  }, reportError);
  window.api.onError(({ message }) => toast(message, 'error'));
  refreshSettings();

  byId('serverRestartBtn').addEventListener('click', () => window.api.restartServer().catch(reportError));
  byId('serverLogBtn').addEventListener('click', () => window.api.openServerLog().catch(reportError));
  byId('setupDownloadBtn').addEventListener('click', () => {
    openModels();
    startModelDownload(RECOMMENDED_MODEL_ID);
  });
  byId('quickNoteBtn').addEventListener('click', () => window.api.toggleQuickNote().catch(reportError));
  byId('recordBtn').addEventListener('click', () => {
    window.api.startSession({ kind: 'session', folder: getState().selectedFolder }).catch(reportError);
  });
  byId('pauseBtn').addEventListener('click', () => {
    const paused = getState().session.status?.state === 'paused';
    (paused ? window.api.resumeSession() : window.api.pauseSession()).catch(reportError);
  });
  byId('stopBtn').addEventListener('click', () => window.api.stopSession().catch(reportError));
  byId('modelChip').addEventListener('click', openModels);
  byId('settingsBtn').addEventListener('click', () => openSettings().catch(reportError));

  subscribe((_state, changed) => {
    if (changed.has('session') || changed.has('tree') || changed.has('selectedFolder')) render();
  });
  render();
}
```

In `src/renderer/app.ts`, change the header import to `import { initHeader, setSettings } from './header.js';` and the dialogs call to `initDialogs({ onSettingsSaved: setSettings });`.

- [ ] **Step 7: Build, test, lint, check for leftovers**

Run: `npm run build && npm test && npm run lint`
Expected: success. Then:

Run: `git grep -n -i "dictat\|pasteTranscript\|startRecording\|copyToClipboard\|autoMuteAudio\|micDevice\|getAudioDevices\|dictateBtn\|sessionStartBtn\|sessionStopBtn\|sessionPauseBtn\|modelsBtn" -- src public`
Expected: no output. (`README.md` and docs are updated in Task 12.)

Launch a throwaway instance (as in Task 7 Step 7) and check: the header matches the mockup's order; Quick Notes and Record are enabled; Stop and Pause are disabled; the model chip opens the models dialog.

- [ ] **Step 8: Commit**

```bash
git add -A src public
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Replace paste dictation with Quick Notes in a new header

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---
### Task 9: Sidebar — Vault, pinned Quick Notes, Recent, footer

**Files:**
- Modify: `src/renderer/libraryTree.ts`, `src/renderer/format.ts`, `src/renderer/dom.ts`
- Modify (rewrite): `src/renderer/library.ts`
- Modify: `public/index.html` (library `<aside>`)
- Test: `src/__tests__/libraryTree.test.ts`, `src/__tests__/format.test.ts`

**Interfaces:**
- Consumes: `startSession(request)` (Task 6); CSS classes from Task 7.
- Produces:
  - `libraryTree.ts`: `QUICK_NOTES_FOLDER`, `folderCounts(tree: LibraryTree): Map<string, number>`, `recentDocuments(tree: LibraryTree, limit?: number): LibraryDocument[]`, `pinQuickNotes(root: FolderView): FolderView`.
  - `format.ts`: `relativeTime(ms: number, nowMs: number): string`.
  - `dom.ts`: `icon(name: string, className?: string): HTMLSpanElement`.
  - `library.ts` keeps its exports: `recordingFile()`, `reloadTree()`, `openDocument(file, line?)`, `renameDocument(doc)`, `initLibrary()`.
  - Element ids: `librarySearch`, `libraryBody`, `newSessionBtn`, `docCount`, `vaultMenuBtn`. Tree rows keep `data-key` (`folder:<path>` / `doc:<file>`); recent rows use `data-recent="<file>"` and class `row recent`.

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/libraryTree.test.ts` (extend its import with `folderCounts, pinQuickNotes, QUICK_NOTES_FOLDER, recentDocuments`; the file already has helpers for building a `LibraryTree` — read its top first and reuse them if they fit; the tests below build their own):

```ts
describe('sidebar helpers', () => {
  const doc = (file: string, mtimeMs: number) => ({
    file,
    folder: file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '',
    title: file,
    created: '',
    mtimeMs,
    readable: true,
  });
  const tree = {
    root: 'C:\\Vault',
    exists: true,
    folders: [
      { path: 'Work', name: 'Work', children: [{ path: 'Work/Acme', name: 'Acme', children: [] }] },
      { path: 'Archive', name: 'Archive', children: [] },
    ],
    documents: [doc('a.md', 5), doc('Work/b.md', 50), doc('Work/Acme/c.md', 20), doc('Work/Acme/d.md', 40), doc('Archive/e.md', 10), doc('Archive/f.md', 30)],
  };

  it('counts documents per folder including subfolders', () => {
    const counts = folderCounts(tree);
    expect(counts.get('')).toBe(6);
    expect(counts.get('Work')).toBe(3);
    expect(counts.get('Work/Acme')).toBe(2);
    expect(counts.get('Archive')).toBe(2);
    expect(counts.get('Nope')).toBeUndefined();
  });

  it('lists the most recently changed documents first', () => {
    expect(recentDocuments(tree).map((d) => d.file)).toEqual(['Work/b.md', 'Work/Acme/d.md', 'Archive/f.md', 'Work/Acme/c.md', 'Archive/e.md']);
    expect(recentDocuments(tree, 2).map((d) => d.file)).toEqual(['Work/b.md', 'Work/Acme/d.md']);
  });

  it('pins Quick Notes first, adding it when the folder does not exist yet', () => {
    const pinned = pinQuickNotes(buildTree(tree, new Set()));
    expect(pinned.folders.map((f) => f.path)).toEqual([QUICK_NOTES_FOLDER, 'Work', 'Archive']);
    expect(pinned.folders[0]).toEqual({ path: 'Quick Notes', name: 'Quick Notes', depth: 1, expanded: false, folders: [], documents: [] });

    const withQuick = {
      ...tree,
      folders: [...tree.folders, { path: 'Quick Notes', name: 'Quick Notes', children: [] }],
      documents: [...tree.documents, doc('Quick Notes/2026-09-16.md', 60)],
    };
    const again = pinQuickNotes(buildTree(withQuick, new Set(['Quick Notes'])));
    expect(again.folders.map((f) => f.path)).toEqual(['Quick Notes', 'Work', 'Archive']);
    expect(again.folders[0].documents.map((d) => d.file)).toEqual(['Quick Notes/2026-09-16.md']);
    expect(again.folders[0].expanded).toBe(true);
  });
});
```

(If `buildTree` is not already imported in that file, add it.)

Append to `src/__tests__/format.test.ts` (extend its import with `relativeTime`):

```ts
describe('relativeTime', () => {
  const now = Date.UTC(2026, 8, 16, 12, 0, 0);
  it('rounds down to the largest whole unit', () => {
    expect(relativeTime(now - 20_000, now)).toBe('just now');
    expect(relativeTime(now + 5_000, now)).toBe('just now');
    expect(relativeTime(now - 2 * 60_000, now)).toBe('2m ago');
    expect(relativeTime(now - 59 * 60_000, now)).toBe('59m ago');
    expect(relativeTime(now - 60 * 60_000, now)).toBe('1h ago');
    expect(relativeTime(now - 23 * 3_600_000, now)).toBe('23h ago');
    expect(relativeTime(now - 49 * 3_600_000, now)).toBe('2d ago');
  });
});
```

Run: `npx jest src/__tests__/libraryTree.test.ts src/__tests__/format.test.ts` → FAIL (missing exports).

- [ ] **Step 2: Implement the helpers**

Append to `src/renderer/libraryTree.ts`:

```ts
export const QUICK_NOTES_FOLDER = 'Quick Notes';

// Documents per folder, counting subfolders; '' holds the whole vault.
export function folderCounts(tree: LibraryTree): Map<string, number> {
  const counts = new Map<string, number>();
  for (const doc of tree.documents) {
    const parts = doc.folder === '' ? [] : doc.folder.split('/');
    for (let i = 0; i <= parts.length; i++) {
      const key = parts.slice(0, i).join('/');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

export function recentDocuments(tree: LibraryTree, limit = 5): LibraryDocument[] {
  return [...tree.documents].sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file)).slice(0, limit);
}

// Quick Notes is always the first folder under the vault, even before it exists (spec §4.2).
export function pinQuickNotes(root: FolderView): FolderView {
  const existing = root.folders.find((folder) => folder.path === QUICK_NOTES_FOLDER);
  const quick: FolderView = existing ?? {
    path: QUICK_NOTES_FOLDER,
    name: QUICK_NOTES_FOLDER,
    depth: 1,
    expanded: false,
    folders: [],
    documents: [],
  };
  return { ...root, folders: [quick, ...root.folders.filter((folder) => folder !== existing)] };
}
```

Append to `src/renderer/format.ts`:

```ts
export function relativeTime(ms: number, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
```

Append to `src/renderer/dom.ts`:

```ts
// A CSS mask icon from public/app.css (.i-<name>).
export function icon(name: string, className = ''): HTMLSpanElement {
  const node = el('span', `i i-${name}${className ? ` ${className}` : ''}`);
  node.setAttribute('aria-hidden', 'true');
  return node;
}
```

Run: `npx jest src/__tests__/libraryTree.test.ts src/__tests__/format.test.ts` → PASS.

- [ ] **Step 3: Library markup**

In `public/index.html`, replace the whole `<aside class="library" …>…</aside>` with:

```html
    <aside class="library" aria-label="Library">
      <div class="search">
        <span class="i i-search" aria-hidden="true"></span>
        <input type="search" id="librarySearch" placeholder="Search vault…" aria-label="Search the vault">
        <kbd>Ctrl+K</kbd>
      </div>
      <div class="library-body" id="libraryBody" tabindex="0" role="tree"></div>
      <div class="library-footer">
        <button class="btn outline wide" id="newSessionBtn"><span class="i i-plus" aria-hidden="true"></span>New Session</button>
        <div class="footer-line">
          <span class="i i-folder" aria-hidden="true"></span>
          <span id="docCount"></span>
          <span class="spacer"></span>
          <button class="icon" id="vaultMenuBtn" title="Vault actions"><span class="i i-more" aria-hidden="true"></span></button>
        </div>
      </div>
    </aside>
```

- [ ] **Step 4: Rewrite `src/renderer/library.ts`**

```ts
import type { LibraryDocument, LibrarySearchHit } from '../shared/api.js';
import { ask, confirmAction } from './dialogs.js';
import { byId, el, icon } from './dom.js';
import { formatDate, relativeTime } from './format.js';
import {
  buildTree,
  expandTo,
  folderChoices,
  folderCounts,
  parentFolder,
  pinQuickNotes,
  QUICK_NOTES_FOLDER,
  recentDocuments,
  visibleRows,
  type FolderView,
  type VisibleRow,
} from './libraryTree.js';
import { isSessionRunning } from './sessionModel.js';
import { getState, subscribe, update, type AppState } from './state.js';
import { reportError, toast } from './toast.js';

const LIBRARY_KEYS = new Set<keyof AppState>(['tree', 'expanded', 'selectedFile', 'selectedFolder', 'search']);
const INDENT_PX = 16;
const RECENT_REFRESH_MS = 60_000;

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

// The document a session or quick note is writing right now.
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

// The tree as shown: Quick Notes is pinned unless a title filter is active.
function libraryRoot(): FolderView | null {
  const { tree, expanded, search } = getState();
  if (!tree) return null;
  const root = buildTree(tree, expanded, search);
  return search.trim() === '' ? pinQuickNotes(root) : root;
}

// ---- Document actions (also used by the document pane)

export async function renameDocument(doc: { file: string; title: string }): Promise<void> {
  const title = await ask({ title: 'Rename document', value: doc.title, confirmLabel: 'Rename' });
  if (title === null || title.trim() === '' || title.trim() === doc.title) return;
  try {
    const next = await window.api.renameDocument(doc.file, title.trim());
    if (getState().selectedFile === doc.file) update({ selectedFile: next });
  } finally {
    await reloadTree();
  }
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
  try {
    const next = await window.api.moveDocument(doc.file, folder);
    if (getState().selectedFile === doc.file) {
      update({ selectedFile: next, expanded: expandTo(getState().expanded, folder) });
    }
  } finally {
    await reloadTree();
  }
}

async function deleteDocument(doc: LibraryDocument): Promise<void> {
  if (!(await confirmAction('Delete document', `Move "${doc.title}" to the Recycle Bin?`, 'Delete'))) return;
  try {
    await window.api.deleteDocument(doc.file);
    if (getState().selectedFile === doc.file) update({ selectedFile: null, document: null });
  } finally {
    await reloadTree();
  }
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

// ---- Menus

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
  menu.style.top = `${Math.max(4, Math.min(rect.bottom + 2, window.innerHeight - menu.offsetHeight - 4))}px`;
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

function showVaultMenu(): void {
  showMenu(byId('vaultMenuBtn'), [
    { label: 'New folder…', run: () => newFolder() },
    { label: 'Change vault…', run: () => chooseVault() },
    { label: 'Show vault in Explorer', run: () => window.api.openVault() },
  ]);
}

// ---- Rendering

function folderRow(folder: FolderView, counts: ReadonlyMap<string, number>): HTMLElement {
  const { selectedFolder } = getState();
  const key = `folder:${folder.path}`;
  const root = folder.depth === 0;
  const row = el('div', root ? 'row folder root' : 'row folder');
  if (!root) row.style.paddingLeft = `${10 + (folder.depth - 1) * INDENT_PX}px`;
  row.dataset.key = key;
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-expanded', String(folder.expanded));
  row.classList.toggle('target', selectedFolder === folder.path);
  row.classList.toggle('focused', focusedRow === key);
  if (root) {
    row.title = 'New sessions go to the vault root';
    row.append(icon('chevron-down', 'twisty'), el('span', 'name', 'Vault'));
  } else {
    const hasChildren = folder.folders.length > 0 || folder.documents.length > 0;
    const quick = folder.path === QUICK_NOTES_FOLDER;
    row.append(
      icon(folder.expanded ? 'chevron-down' : 'chevron-right', hasChildren ? 'twisty' : 'twisty none'),
      quick ? icon('note', 'kind quick') : icon('folder', 'kind'),
      el('span', 'name', folder.name),
      el('span', 'count', String(counts.get(folder.path) ?? 0)),
    );
  }
  row.addEventListener('click', () => selectFolder(folder.path, root ? undefined : !folder.expanded));
  return row;
}

function documentRow(doc: LibraryDocument, depth: number): HTMLElement {
  const key = `doc:${doc.file}`;
  const row = el('div', 'row doc');
  row.style.paddingLeft = `${10 + Math.max(0, depth - 1) * INDENT_PX}px`;
  row.dataset.key = key;
  row.setAttribute('role', 'treeitem');
  row.classList.toggle('selected', getState().selectedFile === doc.file);
  row.classList.toggle('focused', focusedRow === key);
  row.append(icon('file', 'kind'));
  const name = el('span', 'name', doc.title);
  name.title = doc.file;
  row.append(name);
  if (doc.file === recordingFile()) {
    const dot = el('span', 'dot rec rec-dot');
    dot.title = 'Recording';
    row.append(dot);
  }
  if (!doc.readable) {
    const warn = el('span', 'warn', '⚠');
    warn.title = 'This file could not be read';
    row.append(warn);
  }
  const menu = el('button', 'icon row-menu');
  menu.title = 'Actions';
  menu.append(icon('more'));
  menu.addEventListener('click', (event) => {
    event.stopPropagation();
    showDocumentMenu(doc, menu);
  });
  row.append(el('span', 'date', formatDate(doc.created, doc.mtimeMs)), menu);
  row.addEventListener('click', () => openDocument(doc.file));
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    showDocumentMenu(doc, row);
  });
  return row;
}

function folderRows(folder: FolderView, counts: ReadonlyMap<string, number>): HTMLElement[] {
  const rows = [folderRow(folder, counts)];
  if (!folder.expanded) return rows;
  for (const child of folder.folders) rows.push(...folderRows(child, counts));
  for (const doc of folder.documents) rows.push(documentRow(doc, folder.depth + 1));
  return rows;
}

function recentRows(): HTMLElement[] {
  const { tree, selectedFile } = getState();
  if (!tree || tree.documents.length === 0) return [];
  const now = Date.now();
  const title = el('div', 'section-title');
  title.append(icon('clock'), el('span', '', 'Recent'));
  const rows = recentDocuments(tree).map((doc) => {
    const row = el('div', 'row recent');
    row.dataset.recent = doc.file;
    row.classList.toggle('selected', selectedFile === doc.file);
    const name = el('span', 'name', doc.title);
    name.title = doc.file;
    row.append(icon('file', 'kind'), name, el('span', 'date', relativeTime(doc.mtimeMs, now)));
    row.addEventListener('click', () => openDocument(doc.file));
    return row;
  });
  return [title, ...rows];
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

function renderFooter(): void {
  const { tree, selectedFolder } = getState();
  const count = tree?.documents.length ?? 0;
  byId('docCount').textContent = `${count} ${count === 1 ? 'document' : 'documents'}`;
  const button = byId<HTMLButtonElement>('newSessionBtn');
  button.title = `Start a session in ${selectedFolder || 'the vault root'}`;
  button.disabled = recordingFile() !== null || tree?.exists === false;
}

function renderLibrary(): void {
  const body = byId('libraryBody');
  const { tree, search } = getState();
  renderFooter();
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
  const root = libraryRoot() as FolderView;
  body.replaceChildren(...folderRows(root, folderCounts(tree)));
  const filtering = search.trim() !== '';
  if (tree.documents.length === 0) {
    body.append(el('p', 'muted pad', 'No documents yet. Start a session or a quick note to begin.'));
  } else if (filtering && root.folders.length === 0 && root.documents.length === 0) {
    body.append(el('p', 'muted pad', 'No matches'));
  }
  if (!filtering) body.append(...recentRows());
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
  const { tree } = getState();
  const root = libraryRoot();
  if (!tree || !root || searchHits) return;
  const rows = visibleRows(root);
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
    case 'ContextMenu':
    case 'F10': {
      if (event.key === 'F10' && !event.shiftKey) return;
      if (!doc) return;
      const anchor = byId('libraryBody').querySelector<HTMLElement>(`[data-key="doc:${doc.file}"]`);
      if (anchor) showDocumentMenu(doc, anchor);
      break;
    }
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
  byId('newSessionBtn').addEventListener('click', () => {
    window.api.startSession({ kind: 'session', folder: getState().selectedFolder }).catch(reportError);
  });
  byId('vaultMenuBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    showVaultMenu();
  });
  document.addEventListener('click', hideMenu);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideMenu();
    const key = event.key.toLowerCase();
    if (event.ctrlKey && (key === 'f' || key === 'k')) {
      event.preventDefault();
      search.focus();
      search.select();
    }
  });
  window.api.onLibraryChanged(({ paths }) => {
    // Main sends an empty paths list after the vault setting changes: the old tree's folders
    // no longer mean anything, so drop the selected folder and expansion state before reloading.
    if (paths.length === 0) update({ selectedFolder: '', expanded: new Set() });
    void reloadTree();
  });
  // "2m ago" goes stale.
  setInterval(() => {
    if (!searchHits && getState().search.trim() === '') renderLibrary();
  }, RECENT_REFRESH_MS);

  subscribe((_state, changed) => {
    const recording = recordingFile();
    const recordingChanged = recording !== lastRecording;
    lastRecording = recording;
    if (recordingChanged && recording) {
      // A new run's document: show it (the watcher may not have reported it yet).
      void reloadTree().then(() => openDocument(recording));
    }
    if (recordingChanged || [...changed].some((key) => LIBRARY_KEYS.has(key))) renderLibrary();
    else if (changed.has('session')) renderFooter();
  });

  renderLibrary();
  void reloadTree();
}
```

- [ ] **Step 5: Build, test, lint, look**

Run: `npm run build && npm test && npm run lint` → success.

Launch a throwaway instance (Task 7 Step 7), point it at a scratch vault via the ••• menu → Change vault… (or `window.api.saveSettings` from DevTools), and check: VAULT heading, Quick Notes first with the note icon, folder counts, the RECENT list with relative times, New Session and the footer count.

- [ ] **Step 6: Commit**

```bash
git add public/index.html src/renderer/library.ts src/renderer/libraryTree.ts src/renderer/format.ts src/renderer/dom.ts src/__tests__/libraryTree.test.ts src/__tests__/format.test.ts
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Rebuild the sidebar with Quick Notes, counts and recent documents

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Document pane — clock margin, line jump, toolbar, level meter

**Files:**
- Modify: `src/renderer/documentView.ts`
- Create: `src/renderer/levelMeter.ts`
- Modify (rewrite): `src/renderer/document.ts`
- Modify: `public/index.html` (document `<section>`)
- Test: `src/__tests__/documentView.test.ts`

**Interfaces:**
- Consumes: `window.api.onSessionLevel` (Task 8); `icon` (Task 9); `BlockEvent.clock` (Task 6).
- Produces (in `documentView.ts`):
  - `DocumentPart.clock: string` — the clock inside the block's clock line (`'14:32'` or `'2026-09-16 14:32'`), `''` if none.
  - `clockOf(line: string): string`, `clockParts(clock: string): { date: string; time: string }`
  - `hitNeedle(content: string, line: number): string`, `normalizeText(text: string): string`, `lineIndexContaining(texts: readonly string[], needle: string): number`
  - `absolutePath(root: string, file: string): string`
  - `documentDetailRows(frontmatter: Record<string, string>, file: string): { label: string; value: string }[]`
  - `frontmatterRows` now formats a parseable `created` value with `formatDate`.
  - `blockCaption` is removed.
- Element ids: `docTitle`, `docRenameBtn`, `levelMeter`, `liveBadge`, `docBody`, `jumpLiveBtn`, `docToolbar`, `docOpenBtn`, `docCopyPathBtn`, `docCopyBtn`, `fontSizeBtn`, `focusBtn`. Rendered paragraphs are `section.para` with `.margin` (`.time`, `.badge`) and `.md`; the matched line is wrapped in `span.hit-line`.

- [ ] **Step 1: Write the failing tests**

In `src/__tests__/documentView.test.ts`:
1. Change the import list to:
```ts
import {
  absolutePath,
  clockOf,
  clockParts,
  documentDetailRows,
  documentTitle,
  DocumentPart,
  frontmatterRows,
  hitNeedle,
  lineIndexContaining,
  mergeLiveText,
  normalizeText,
  parseDocument,
  partIndexForLine,
  plainText,
} from '../renderer/documentView';
import { formatDate } from '../renderer/format';
```
2. Add `clock: '',` to the `part()` fixture defaults (after `continued: false,`).
3. Delete the `it('captions a block with its time range', …)` test.
4. Replace the `it('lists the known frontmatter fields', …)` test with:
```ts
  it('lists the known frontmatter fields, showing a created time locally', () => {
    expect(frontmatterRows({ created: 'x', duration: '250', title: 't', other: 'y' })).toEqual([
      { label: 'Created', value: 'x' },
      { label: 'Duration', value: '04:10' },
    ]);
    expect(frontmatterRows({ created: '2026-09-16T17:52:00Z' })).toEqual([
      { label: 'Created', value: formatDate('2026-09-16T17:52:00Z', 0) },
    ]);
  });

  it('adds the path after the created time', () => {
    expect(documentDetailRows({ created: 'x', language: 'en' }, 'Testing/test doc.md')).toEqual([
      { label: 'Created', value: 'x' },
      { label: 'Path', value: 'Testing/test doc.md' },
      { label: 'Language', value: 'en' },
    ]);
    expect(documentDetailRows({}, 'a.md')).toEqual([{ label: 'Path', value: 'a.md' }]);
  });
```
5. Append:
```ts
describe('clock lines', () => {
  const content = [
    '---',
    'title: Day',
    '---',
    '',
    '<!-- dw:block 1 t=0-4 -->',
    '**2026-09-16 14:32**',
    'First note.',
    '',
    '<!-- dw:block 2 t=10-14 -->',
    '**14:35**',
    'Second note.',
    'Another line.',
    '',
  ].join('\n');

  it('moves each clock line out of the text into its paragraph', () => {
    const parts = parseDocument(content).parts;
    expect(parts.map((p) => [p.index, p.clock, p.markdown, p.line])).toEqual([
      [1, '2026-09-16 14:32', 'First note.', 5],
      [2, '14:35', 'Second note.\nAnother line.', 9],
    ]);
  });

  it('keeps bold text and late clock lines as text', () => {
    expect(parseDocument('<!-- dw:block 1 t=0-0 -->\n**Agenda**\nx').parts[0]).toMatchObject({ clock: '', markdown: '**Agenda**\nx' });
    expect(parseDocument('<!-- dw:block 1 t=0-0 -->\nhello\n**14:32**').parts[0]).toMatchObject({ clock: '', markdown: 'hello\n**14:32**' });
  });

  it('reads and splits clocks', () => {
    expect(clockOf('**14:32**')).toBe('14:32');
    expect(clockOf(' **2026-09-16 14:32** ')).toBe('2026-09-16 14:32');
    expect(clockOf('**later**')).toBe('');
    expect(clockParts('2026-09-16 14:32')).toEqual({ date: '2026-09-16', time: '14:32' });
    expect(clockParts('14:32')).toEqual({ date: '', time: '14:32' });
    expect(clockParts('')).toEqual({ date: '', time: '' });
  });

  it('gives a live paragraph the read has not seen yet the clock of its event', () => {
    const merged = mergeLiveText([], new Map([[3, 'hi']]), [
      { sessionId: 's', blockIndex: 3, startSec: 5, endSec: 5, state: 'live', clock: '**14:40**' },
    ]);
    expect(merged).toEqual([part({ index: 3, startSec: 5, endSec: 5, line: 0, clock: '14:40', markdown: 'hi' })]);
  });
});

describe('search hits', () => {
  it('reads the matched line without Markdown syntax', () => {
    const text = '# Title\n\n- **Budget** line two\n> quoted [link](http://x) here\n';
    expect(hitNeedle(text, 3)).toBe('budget line two');
    expect(hitNeedle(text, 4)).toBe('quoted link here');
    expect(hitNeedle(text, 1)).toBe('title');
    expect(hitNeedle(text, 99)).toBe('');
    expect(hitNeedle('a\r\nb  c\r\n', 2)).toBe('b c');
    expect(normalizeText('  The *Big*   `plan` ')).toBe('the big plan');
  });

  it('finds the rendered line that holds the match', () => {
    expect(lineIndexContaining(['Alpha line', 'The Budget line two', 'gamma'], 'budget line two')).toBe(1);
    expect(lineIndexContaining(['Alpha'], 'missing')).toBe(-1);
    expect(lineIndexContaining(['Alpha'], '')).toBe(-1);
  });

  it('builds the absolute path of a vault file', () => {
    expect(absolutePath('C:\\Vault\\', 'Work/a b.md')).toBe('C:\\Vault\\Work\\a b.md');
    expect(absolutePath('C:\\Vault', 'a.md')).toBe('C:\\Vault\\a.md');
  });
});
```

Run: `npx jest src/__tests__/documentView.test.ts` → FAIL (missing exports / `clock` property).

- [ ] **Step 2: Update `src/renderer/documentView.ts`**

1. Add `import { formatClock, formatDate } from './format.js';` (replacing the existing `formatClock` import).
2. Add `clock: string;` to `DocumentPart` after `continued: boolean;`, and `clock: ''` to every `DocumentPart` object literal in the file (the initial `current`, the block `current`, the gap part, the `mergeLiveText` new part — see below).
3. Below `const GAP_NOTE = …;` add:

```ts
// A block's clock line (written by sessionService, spec §3.2).
const CLOCK_LINE = /^\*\*((?:\d{4}-\d{2}-\d{2} )?\d{2}:\d{2})\*\*$/;

// The clock inside a clock line, or '' if the line is not one.
export function clockOf(line: string): string {
  return CLOCK_LINE.exec(line.trim())?.[1] ?? '';
}

export function clockParts(clock: string): { date: string; time: string } {
  const match = /^(?:(\d{4}-\d{2}-\d{2}) )?(\d{2}:\d{2})$/.exec(clock);
  return match ? { date: match[1] ?? '', time: match[2] } : { date: '', time: '' };
}
```

4. In `parseDocument`'s loop, after the `if (trimmed === GAP_LINE) { … }` block and before `buffer.push(lines[i]);`, add:

```ts
    // The first non-blank line of a block may be its clock line: it goes to the margin.
    if (current.kind === 'block' && current.clock === '' && buffer.every((line) => line.trim() === '')) {
      const clock = clockOf(trimmed);
      if (clock !== '') {
        current = { ...current, clock };
        continue;
      }
    }
```

   In the gap branch, keep the clock on the continued part but it is not shown (continued parts have no margin content). In the block branch, set `clock: ''` on the new `current`.

5. In `mergeLiveText`, the pushed part becomes:

```ts
    result.push({
      kind: 'block',
      index,
      startSec: event ? event.startSec : 0,
      endSec: event ? event.endSec : 0,
      continued: false,
      clock: event ? clockOf(event.clock) : '',
      line: 0,
      markdown: '',
    });
```

6. Delete `blockCaption`.

7. Replace `frontmatterRows` with:

```ts
export function frontmatterRows(frontmatter: Record<string, string>): { label: string; value: string }[] {
  return FRONTMATTER_FIELDS.filter(([key]) => frontmatter[key] !== undefined && frontmatter[key] !== '').map(
    ([key, label]) => {
      const raw = frontmatter[key];
      if (key === 'duration') return { label, value: formatClock(Number(raw) || 0) };
      if (key === 'created' && !Number.isNaN(Date.parse(raw))) return { label, value: formatDate(raw, 0) };
      return { label, value: raw };
    },
  );
}

// The panel's Document section: the frontmatter, with the vault path after the created time.
export function documentDetailRows(frontmatter: Record<string, string>, file: string): { label: string; value: string }[] {
  const rows = frontmatterRows(frontmatter);
  const created = rows.findIndex((row) => row.label === 'Created');
  rows.splice(created + 1, 0, { label: 'Path', value: file });
  return rows;
}
```

8. Append:

```ts
// Search hits carry a source line; the rendered text has no Markdown syntax, so both sides are
// compared without it, case-insensitively.
export function normalizeText(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function hitNeedle(content: string, line: number): string {
  const raw = content.replace(/\r\n/g, '\n').split('\n')[line - 1] ?? '';
  return normalizeText(raw.replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/, ''));
}

export function lineIndexContaining(texts: readonly string[], needle: string): number {
  if (needle === '') return -1;
  return texts.findIndex((text) => normalizeText(text).includes(needle));
}

export function absolutePath(root: string, file: string): string {
  return `${root.replace(/[\\/]+$/, '')}\\${file.replace(/\//g, '\\')}`;
}
```

Run: `npx jest src/__tests__/documentView.test.ts` → PASS.

- [ ] **Step 3: Document markup**

In `public/index.html`, replace the whole `<section class="document" …>…</section>` with:

```html
    <section class="document" aria-label="Document">
      <div class="doc-bar">
        <span class="i i-file doc-icon" aria-hidden="true"></span>
        <h1 id="docTitle">Select a document</h1>
        <button class="icon" id="docRenameBtn" title="Rename" hidden><span class="i i-pencil" aria-hidden="true"></span></button>
        <span class="spacer"></span>
        <div class="meter" id="levelMeter" aria-hidden="true" hidden></div>
        <span class="live-badge" id="liveBadge" hidden><span class="dot"></span>Live</span>
      </div>
      <div class="doc-body size-1" id="docBody"></div>
      <button class="btn jump" id="jumpLiveBtn" hidden>Jump to live ↓</button>
      <div class="doc-toolbar" id="docToolbar" hidden>
        <button class="icon" id="docOpenBtn" title="Open in editor"><span class="i i-external" aria-hidden="true"></span></button>
        <button class="icon" id="docCopyPathBtn" title="Copy the file path"><span class="i i-copy" aria-hidden="true"></span></button>
        <button class="icon" id="docCopyBtn" title="Copy the text"><span class="i i-file" aria-hidden="true"></span></button>
        <span class="spacer"></span>
        <button class="icon text" id="fontSizeBtn" title="Text size">Aa</button>
        <button class="icon" id="focusBtn" title="Focus mode"><span class="i i-focus" aria-hidden="true"></span></button>
      </div>
    </section>
```

- [ ] **Step 4: Create `src/renderer/levelMeter.ts`**

```ts
import { byId, el } from './dom.js';

const BARS = 40;
// Without level events (the recorder failed), text arriving still shows the meter is alive.
const LEVEL_TIMEOUT_MS = 2000;

const levels: number[] = new Array<number>(BARS).fill(0);
let lastLevelAt = 0;

function draw(): void {
  const bars = byId('levelMeter').children;
  levels.forEach((level, i) => {
    (bars[i] as HTMLElement).style.transform = `scaleY(${Math.max(0.08, level)})`;
  });
}

function push(level: number): void {
  levels.shift();
  levels.push(level);
  draw();
}

export function initLevelMeter(): void {
  byId('levelMeter').replaceChildren(...levels.map(() => el('span', 'bar')));
  window.api.onSessionLevel((level) => {
    lastLevelAt = Date.now();
    push(level);
  });
  window.api.onSessionSegment(() => {
    if (Date.now() - lastLevelAt < LEVEL_TIMEOUT_MS) return;
    push(0.7);
    setTimeout(() => push(0.25), 150);
  });
}
```

- [ ] **Step 5: Rewrite `src/renderer/document.ts`**

```ts
import type { BlockEvent } from '../shared/api.js';
import {
  absolutePath,
  clockParts,
  documentTitle,
  hitNeedle,
  lineIndexContaining,
  mergeLiveText,
  parseDocument,
  partIndexForLine,
  plainText,
  type DocumentPart,
} from './documentView.js';
import { byId, el } from './dom.js';
import { initLevelMeter } from './levelMeter.js';
import { recordingFile, renameDocument } from './library.js';
import { BLOCK_LABELS, clearPendingText, isSessionRunning } from './sessionModel.js';
import { getState, subscribe, update, type AppState } from './state.js';
import { reportError, toast } from './toast.js';

const FOLLOW_THRESHOLD_PX = 40;
const FONT_SIZE_KEY = 'dark-whisper.fontSize';
const FONT_SIZES = 3;
const DEFAULT_FONT_SIZE = 1;
const LINE_BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th';

let readSeq = 0;
let shownFile: string | null = null;
let follow = true;
let readError: string | null = null;
let refinedSignature = '';
let wasRunning = false;
let wasSessionDocument = false;
let fontSize = DEFAULT_FONT_SIZE;

function isLiveDocument(): boolean {
  const file = getState().selectedFile;
  return file !== null && file === recordingFile();
}

// The selected document belongs to the current run (recording, or stopped and still refining).
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
  const row = el('section', part.kind === 'block' ? 'para' : 'para intro');
  row.dataset.line = String(part.line);
  const margin = el('div', 'margin');
  if (part.kind === 'block') {
    row.dataset.block = String(part.index);
    row.classList.toggle('live', part.index === liveIndex);
    if (!part.continued) {
      const { date, time } = clockParts(part.clock);
      if (time) {
        const stamp = el('div', 'time', time);
        stamp.title = date ? `${date} ${time}` : time;
        margin.append(stamp);
      }
      // A refined paragraph is the normal end state: only other states are worth a badge.
      const event = blocks.find((b) => b.blockIndex === part.index);
      if (event && event.state !== 'refined') {
        const badge = el('span', `badge ${event.state}`, BLOCK_LABELS[event.state]);
        if (event.message) badge.title = event.message;
        margin.append(badge);
      }
    }
  }
  const content = el('div', 'md');
  renderMarkdown(content, part.markdown);
  if (part.kind === 'block' && part.index === liveIndex && isLastOfLive) content.append(el('span', 'cursor', '▌'));
  row.append(margin, content);
  return row;
}

function setBarVisible(visible: boolean): void {
  byId('docRenameBtn').hidden = !visible;
  byId('docToolbar').hidden = !visible;
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
  const live = selectedFile !== null && isLiveDocument();
  byId('liveBadge').hidden = !live;
  byId('levelMeter').hidden = !live;

  if (!selectedFile) {
    title.textContent = 'Select a document';
    setBarVisible(false);
    jump.hidden = true;
    const hint = tree && tree.exists && tree.documents.length === 0 ? 'Start a session or a quick note to begin.' : '';
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
      body.replaceChildren();
    }
    return;
  }

  const parsed = parseDocument(document.content);
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

// With breaks: true, one paragraph holds several source lines separated by <br>.
function lineGroups(block: Element): Node[][] {
  const groups: Node[][] = [[]];
  for (const node of [...block.childNodes]) {
    if (node.nodeName === 'BR') groups.push([]);
    else groups[groups.length - 1].push(node);
  }
  return groups.filter((group) => group.length > 0);
}

// Wraps the rendered line that holds the search match, or returns null.
function highlightLine(section: Element, needle: string): HTMLElement | null {
  const content = section.querySelector('.md');
  if (!content) return null;
  for (const block of content.querySelectorAll(LINE_BLOCKS)) {
    const groups = lineGroups(block);
    const index = lineIndexContaining(
      groups.map((group) => group.map((node) => node.textContent ?? '').join('')),
      needle,
    );
    if (index === -1) continue;
    const nodes = groups[index];
    const span = el('span', 'hit-line');
    nodes[0].parentNode?.insertBefore(span, nodes[0]);
    span.append(...nodes);
    return span;
  }
  return null;
}

function applyPendingScroll(parts: DocumentPart[]): void {
  const { scrollToLine, scrollToBlock, document } = getState();
  if (scrollToLine === null && scrollToBlock === null) return;
  const body = byId('docBody');
  follow = false;
  if (scrollToLine !== null) {
    const index = partIndexForLine(parts, scrollToLine);
    const section = index === -1 ? null : body.children[index];
    const needle = document ? hitNeedle(document.content, scrollToLine) : '';
    const line = section ? highlightLine(section, needle) : null;
    if (line) line.scrollIntoView({ block: 'center' });
    else flash(section ?? body.firstElementChild);
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
    wasSessionDocument = isSessionDocument();
    void loadDocument();
  }
  let sessionRelevant = false;
  if (changed.has('session')) {
    const running = isSessionRunning(state.session.status);
    const signature = state.session.blocks
      .filter((b) => b.state === 'refined')
      .map((b) => b.blockIndex)
      .join(',');
    const stoppedNow = wasRunning && !running;
    const isDoc = isSessionDocument();
    // Render on a session change only when the open document is, or just was, the session
    // document: unrelated notes must not lose the reader's text selection.
    sessionRelevant = isDoc || wasSessionDocument;
    if (isDoc && (signature !== refinedSignature || stoppedNow)) void loadDocument();
    refinedSignature = signature;
    wasRunning = running;
    wasSessionDocument = isDoc;
  }
  if (
    changed.has('document') ||
    changed.has('selectedFile') ||
    (changed.has('session') && sessionRelevant) ||
    // The tree only affects the empty-state hint text, which only shows with nothing selected.
    (changed.has('tree') && state.selectedFile === null) ||
    (changed.has('scrollToLine') && state.scrollToLine !== null) ||
    (changed.has('scrollToBlock') && state.scrollToBlock !== null)
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

function readFontSize(): number {
  try {
    const raw = window.localStorage.getItem(FONT_SIZE_KEY);
    const size = raw === null ? DEFAULT_FONT_SIZE : Number(raw);
    return Number.isInteger(size) && size >= 0 && size < FONT_SIZES ? size : DEFAULT_FONT_SIZE;
  } catch {
    return DEFAULT_FONT_SIZE;
  }
}

function applyFontSize(size: number): void {
  fontSize = size;
  const body = byId('docBody');
  for (let i = 0; i < FONT_SIZES; i++) body.classList.toggle(`size-${i}`, i === size);
  try {
    window.localStorage.setItem(FONT_SIZE_KEY, String(size));
  } catch {
    // Storage unavailable: the size lasts for this window only.
  }
}

function setFocusMode(on: boolean): void {
  byId('workspace').classList.toggle('focus', on);
  byId('focusBtn').title = on ? 'Leave focus mode (Esc)' : 'Focus mode';
}

export function initDocument(): void {
  applyFontSize(readFontSize());
  initLevelMeter();
  byId('docRenameBtn').addEventListener('click', () => {
    const { selectedFile, tree } = getState();
    const doc = tree?.documents.find((d) => d.file === selectedFile);
    if (!doc) return;
    if (doc.file === recordingFile()) {
      toast('Stop recording before renaming this document.');
      return;
    }
    renameDocument(doc).catch(reportError);
  });
  byId('docCopyBtn').addEventListener('click', () => {
    window.api.copyText(plainText(currentParts())).then(() => toast('Text copied'), reportError);
  });
  byId('docCopyPathBtn').addEventListener('click', () => {
    const { selectedFile, tree } = getState();
    if (!selectedFile || !tree) return;
    window.api.copyText(absolutePath(tree.root, selectedFile)).then(() => toast('Path copied'), reportError);
  });
  byId('docOpenBtn').addEventListener('click', () => {
    const file = getState().selectedFile;
    if (file) window.api.openDocumentExternally(file).catch(reportError);
  });
  byId('fontSizeBtn').addEventListener('click', () => applyFontSize((fontSize + 1) % FONT_SIZES));
  byId('focusBtn').addEventListener('click', () => setFocusMode(!byId('workspace').classList.contains('focus')));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !document.querySelector('dialog[open]')) setFocusMode(false);
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

- [ ] **Step 6: Build, test, lint**

Run: `npm run build && npm test && npm run lint` → success. `git grep -n "blockCaption\|docCopyBtn.*Copy all" -- src public` → no output.

- [ ] **Step 7: Commit**

```bash
git add public/index.html src/renderer/document.ts src/renderer/documentView.ts src/renderer/levelMeter.ts src/__tests__/documentView.test.ts
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Show paragraph times in the margin and jump to the matching line

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Right panel — collapsible Session, Blocks and Document sections

**Files:**
- Modify: `src/renderer/sessionModel.ts`
- Modify (rewrite): `src/renderer/sessionPanel.ts`
- Modify: `public/index.html` (panel `<aside>`)
- Test: `src/__tests__/sessionModel.test.ts`

**Interfaces:**
- Consumes: `clockOf`, `clockParts`, `documentDetailRows`, `parseDocument` (Task 10); `icon` (Task 9); `BlockEvent.clock`, `SessionStatusView.kind` (Task 6).
- Produces (in `sessionModel.ts`): `BLOCK_LABELS.queued === 'pending'`; `sessionTitle(status): string`; `stateLabel(status): string`; `sessionDetailRows(status): [string, string][]`; `blockTime(block: BlockEvent): string`. `sessionSummary` stays.
- Element ids: `sessionPanel`, `panelToggleBtn`, `panelBody`. Sections: `section.panel-section[data-section="session"|"blocks"|"document"]`.

- [ ] **Step 1: Write the failing tests**

In `src/__tests__/sessionModel.test.ts`, extend the import from `'../renderer/sessionModel'` with `BLOCK_LABELS, blockTime, sessionDetailRows, sessionTitle, stateLabel`, and append inside the `describe`:

```ts
  it('names the run and its state', () => {
    expect(sessionTitle(status())).toBe('Session');
    expect(sessionTitle(status({ kind: 'quick-note' }))).toBe('Quick Note');
    expect(stateLabel(status())).toBe('Recording');
    expect(stateLabel(status({ state: 'paused', muted: true }))).toBe('Paused (mic muted)');
    expect(stateLabel(status({ state: 'stopped' }))).toBe('Stopped');
    expect(BLOCK_LABELS.queued).toBe('pending');
  });

  it('lists the run details', () => {
    expect(sessionDetailRows(status({ durationSec: 161, refining: 2, muted: true, folder: 'Work' }))).toEqual([
      ['Microphone', 'Mic (muted)'],
      ['Live model', 'base'],
      ['Refine model', 'turbo'],
      ['Elapsed time', '02:41'],
      ['Waiting to refine', '2'],
      ['Folder', 'Work'],
    ]);
    expect(sessionDetailRows(status({ microphone: '' }))[0]).toEqual(['Microphone', 'System default']);
    expect(sessionDetailRows(status())[5]).toEqual(['Folder', 'Vault root']);
  });

  it('shows a paragraph by its clock time, else its start', () => {
    expect(blockTime({ ...block(1, 'refined'), clock: '**2026-09-16 14:32**' })).toBe('14:32');
    expect(blockTime({ ...block(2, 'refined'), clock: '' })).toBe('02:00');
  });
```

Run: `npx jest src/__tests__/sessionModel.test.ts` → FAIL.

- [ ] **Step 2: Update `src/renderer/sessionModel.ts`**

- Add `import { clockOf, clockParts } from './documentView.js';`.
- Change `queued: 'waiting',` to `queued: 'pending',` in `BLOCK_LABELS`.
- Replace `sessionSummary` with:

```ts
export function stateLabel(status: SessionStatusView): string {
  if (status.state === 'idle') return 'No session';
  if (status.state === 'paused' && status.muted) return 'Paused (mic muted)';
  return status.state.charAt(0).toUpperCase() + status.state.slice(1);
}

export function sessionSummary(status: SessionStatusView): string {
  if (status.state === 'idle') return 'No session';
  return `${stateLabel(status)} · ${formatClock(status.durationSec)}`;
}

export function sessionTitle(status: SessionStatusView): string {
  return status.kind === 'quick-note' ? 'Quick Note' : 'Session';
}

export function sessionDetailRows(status: SessionStatusView): [string, string][] {
  const microphone = status.microphone || 'System default';
  return [
    ['Microphone', status.muted === true ? `${microphone} (muted)` : microphone],
    ['Live model', status.liveModel],
    ['Refine model', status.refineModel],
    ['Elapsed time', formatClock(status.durationSec)],
    ['Waiting to refine', String(status.refining)],
    ['Folder', status.folder || 'Vault root'],
  ];
}

export function blockTime(block: BlockEvent): string {
  return clockParts(clockOf(block.clock)).time || formatClock(block.startSec);
}
```

Run: `npx jest src/__tests__/sessionModel.test.ts` → PASS (the existing `sessionSummary` tests still pass).

- [ ] **Step 3: Panel markup**

In `public/index.html`, replace the `<aside class="panel" …>…</aside>` with:

```html
    <aside class="panel" id="sessionPanel" aria-label="Details">
      <button class="icon collapse" id="panelToggleBtn" title="Hide the panel"><span class="i i-panel" aria-hidden="true"></span></button>
      <div class="panel-body" id="panelBody"></div>
    </aside>
```

- [ ] **Step 4: Rewrite `src/renderer/sessionPanel.ts`**

```ts
import type { BlockEvent, SessionStatusView } from '../shared/api.js';
import { documentDetailRows, parseDocument } from './documentView.js';
import { byId, el, icon } from './dom.js';
import { openDocument } from './library.js';
import { BLOCK_LABELS, blockTime, sessionDetailRows, sessionTitle, stateLabel } from './sessionModel.js';
import { getState, subscribe, update } from './state.js';

const COLLAPSED_KEY = 'dark-whisper.panelCollapsed';
const SECTIONS_KEY = 'dark-whisper.panelClosedSections';
const SECTION_IDS = ['session', 'blocks', 'document'] as const;
type SectionId = (typeof SECTION_IDS)[number];

let closedSections = readClosedSections();

function readClosedSections(): Set<SectionId> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SECTIONS_KEY) ?? '[]');
    const list = Array.isArray(parsed) ? parsed : [];
    return new Set(SECTION_IDS.filter((id) => list.includes(id)));
  } catch {
    return new Set();
  }
}

function toggleSection(id: SectionId): void {
  if (closedSections.has(id)) closedSections.delete(id);
  else closedSections.add(id);
  try {
    window.localStorage.setItem(SECTIONS_KEY, JSON.stringify([...closedSections]));
  } catch {
    // Storage unavailable: the choice lasts for this window only.
  }
  renderPanel();
}

function section(id: SectionId, title: string, body: HTMLElement[]): HTMLElement {
  const open = !closedSections.has(id);
  const wrap = el('section', open ? 'panel-section open' : 'panel-section');
  wrap.dataset.section = id;
  const head = el('button', 'section-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', String(open));
  head.append(icon('chevron-down', 'chev'), el('span', 'title', title));
  head.addEventListener('click', () => toggleSection(id));
  wrap.append(head);
  if (open) {
    const content = el('div', 'section-body');
    content.append(...body);
    wrap.append(content);
  }
  return wrap;
}

function details(rows: [string, string | HTMLElement][]): HTMLElement {
  const list = el('dl', 'details');
  for (const [label, value] of rows) {
    const dd = el('dd');
    if (typeof value === 'string') dd.textContent = value;
    else dd.append(value);
    list.append(el('dt', '', label), dd);
  }
  return list;
}

function stateLine(status: SessionStatusView): HTMLElement {
  const line = el('div', 'state-line');
  const tone =
    status.state === 'recording' ? 'rec' : status.state === 'error' ? 'error' : status.state === 'stopped' ? 'idle' : 'busy';
  line.append(el('span', `dot ${tone}`), el('span', '', stateLabel(status)));
  if (status.state === 'recording') {
    const pill = el('span', 'pill');
    pill.append(el('span', 'dot rec'), el('span', '', 'Live'));
    line.append(pill);
  }
  return line;
}

function messageList(messages: readonly string[]): HTMLElement {
  const list = el('ul', 'messages');
  for (const message of messages) list.append(el('li', '', message));
  return list;
}

function jumpToBlock(index: number): void {
  const file = getState().session.status?.documentFile;
  if (!file) return;
  if (getState().selectedFile !== file) openDocument(file);
  update({ scrollToBlock: index });
}

function blockList(blocks: readonly BlockEvent[]): HTMLElement {
  if (blocks.length === 0) return el('p', 'muted', 'No paragraphs yet');
  const list = el('ol', 'blocks');
  for (const block of blocks) {
    const item = el('li', `block-row ${block.state}`);
    item.append(
      el('span', 'num', String(block.blockIndex)),
      el('span', 'range', blockTime(block)),
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
    const body: HTMLElement[] = [details([['State', stateLine(status)], ...sessionDetailRows(status)])];
    if (status.messages.length > 0) body.push(messageList(status.messages));
    nodes.push(section('session', sessionTitle(status), body));
    nodes.push(section('blocks', `Blocks (${session.blocks.length})`, [blockList(session.blocks)]));
  } else if (status && status.messages.length > 0) {
    nodes.push(section('session', 'Messages', [messageList(status.messages)]));
  }

  if (document && document.file === selectedFile) {
    const rows = documentDetailRows(parseDocument(document.content).frontmatter, document.file);
    nodes.push(section('document', 'Document', [details(rows.map((row) => [row.label, row.value]))]));
  }

  if (nodes.length === 0) nodes.push(el('p', 'muted', 'Nothing recorded yet.'));
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
  byId('panelToggleBtn').title = collapsed ? 'Show the panel' : 'Hide the panel';
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

- [ ] **Step 5: Build, test, lint**

Run: `npm run build && npm test && npm run lint` → success.

- [ ] **Step 6: Commit**

```bash
git add public/index.html src/renderer/sessionModel.ts src/renderer/sessionPanel.ts src/__tests__/sessionModel.test.ts
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Split the panel into collapsible Session, Blocks and Document sections

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Workspace smoke checks and documentation

**Files:**
- Modify (rewrite): `scripts/workspace-smoke.mjs`
- Modify: `README.md`, `QUICKSTART.md`, `DEVELOPMENT.md`, `SETUP_SUMMARY.md` (whichever mention dictation), `docs/superpowers/specs/2026-09-15-dark-whisper-live-sessions-design.md` (one note)

**Interfaces:**
- Consumes: every element id listed in Tasks 8–11.
- Produces: `npm run smoke:workspace` covering the new UI; docs for 1.3.0.

- [ ] **Step 1: Rewrite `scripts/workspace-smoke.mjs`**

Keep the file's header comment, imports, profile/model setup, `write`, `check`, `waitFor`, `waitForFile`, `click`, `rmDir`, `answerAsk`, `menuAction` and the `finally`/exit code exactly as they are, with these changes:

1. `const ROWS = "[...document.querySelectorAll('#libraryBody .row[data-key]')].map((r) => r.dataset.key).join('|')";`
2. Replace the fixture writes with:
```js
write('2026-09-01-0900-kickoff.md', '---\ntitle: Kickoff\ncreated: 2026-09-01T09:00:00Z\n---\n\n<!-- dw:block 1 t=0-120 -->\n**2026-09-01 09:00**\nThe quarterly budget\n');
write('Clients/acme.md', 'plain note\n');
write('Notes/multi.md', '---\ntitle: Multi\n---\n\n<!-- dw:block 1 t=0-9 -->\n**10:15**\nalpha first line\nbudget line two\ngamma third line\n');
write('hostile.md', '# Hostile\n\n<img src=x onerror="window.__pwned=1">\n<script>window.__pwned=2</script>\n');
write('remote-image.md', '# Remote\n\n<img src="//127.0.0.1/share/x.png">\n\n![r](//127.0.0.1/share/y.png)\n');
write('smoke-delete-me.md', 'delete me\n');
const today = (() => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();
```
3. Replace the body of the `try { … }` block with:

```js
  app = await connect(PORT);
  await waitFor("document.readyState === 'complete' && Boolean(window.api)");
  await app.evaluate(`window.api.saveSettings({ vaultPath: ${js(vault)} })`);

  const listed = await waitFor(`(${ROWS}).includes('doc:2026-09-01-0900-kickoff.md') && (${ROWS})`);
  check(
    'the sidebar lists the vault with Quick Notes pinned first',
    Boolean(listed) && listed.startsWith('folder:|folder:Quick Notes|') && listed.includes('folder:Clients') && !listed.includes('doc:Clients/acme.md'),
    listed,
  );
  const counts = await app.evaluate("document.querySelector('[data-key=\"folder:Clients\"] .count')?.textContent");
  check('folders show document counts', counts === '1', counts);
  const recent = await app.evaluate("document.querySelectorAll('#libraryBody .row.recent').length");
  check('recent documents are listed', recent === 5, String(recent));
  const footer = await app.evaluate("document.getElementById('docCount').textContent");
  check('the footer counts documents', footer === '6 documents', footer);

  await click('[data-key="folder:Clients"]');
  check('folders expand', Boolean(await waitFor(`(${ROWS}).includes('doc:Clients/acme.md')`)));

  await app.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))");
  check('Ctrl+K focuses search', await app.evaluate("document.activeElement?.id === 'librarySearch'"));

  await app.evaluate("(() => { const s = document.getElementById('librarySearch'); s.value = 'line two'; s.dispatchEvent(new Event('input')); })()");
  const hit = await waitFor("document.querySelector('#libraryBody .row.hit')?.textContent");
  check('full-text search finds a line', Boolean(hit) && hit.includes('budget line two'), hit);
  await click('#libraryBody .row.hit');
  const marked = await waitFor("document.getElementById('docTitle').textContent === 'Multi' && document.querySelector('#docBody .hit-line')?.textContent.trim()");
  check('a search hit highlights its line only', marked === 'budget line two', marked);
  await app.evaluate("(() => { const s = document.getElementById('librarySearch'); s.value = ''; s.dispatchEvent(new Event('input')); })()");

  await waitFor(`(${ROWS}).includes('doc:2026-09-01-0900-kickoff.md')`);
  await click('[data-key="doc:2026-09-01-0900-kickoff.md"]');
  const margin = await waitFor("document.getElementById('docTitle').textContent === 'Kickoff' && document.querySelector('#docBody .para .time')?.textContent");
  const body = await app.evaluate("document.querySelector('#docBody .para .md').textContent");
  check('clock lines move into the margin', margin === '09:00' && !body.includes('**') && body.includes('quarterly budget'), `${margin} / ${body}`);

  fs.appendFileSync(vaultFile('2026-09-01-0900-kickoff.md'), '\nEdited outside\n');
  check('an outside edit re-renders the document', Boolean(await waitFor("document.getElementById('docBody').textContent.includes('Edited outside')")));

  await click('#fontSizeBtn');
  check('the text size changes', await app.evaluate("document.getElementById('docBody').classList.contains('size-2')"));
  await click('#focusBtn');
  const focused = await app.evaluate("document.getElementById('workspace').classList.contains('focus') && getComputedStyle(document.querySelector('.library')).display === 'none'");
  await app.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
  const unfocused = await app.evaluate("!document.getElementById('workspace').classList.contains('focus')");
  check('focus mode hides the side panes and Esc leaves it', focused && unfocused);

  const panel = await app.evaluate("[...document.querySelectorAll('#panelBody .panel-section')].map((s) => s.dataset.section).join(',')");
  check('the panel shows the document section', panel.split(',').includes('document'), panel);
  await click('[data-section="document"] .section-head');
  const collapsed = await app.evaluate("!document.querySelector('[data-section=\"document\"]').classList.contains('open') && !document.querySelector('[data-section=\"document\"] .section-body')");
  await click('[data-section="document"] .section-head');
  check('panel sections collapse and open', collapsed);

  await click('#themeBtn');
  const light = await waitFor("document.documentElement.dataset.theme === 'light' && window.api.getSettings().then((s) => s.theme === 'light')");
  await click('#themeBtn');
  check('the theme switches and is saved', light === true, String(light));

  await click('[data-key="doc:hostile.md"]');
  await waitFor("document.getElementById('docTitle').textContent === 'hostile'");
  const hostile = await app.evaluate(
    "({ pwned: window.__pwned ?? null, scripts: document.querySelectorAll('#docBody script').length, handlers: document.querySelectorAll('#docBody [onerror]').length })",
  );
  check('document HTML is sanitised', hostile.pwned === null && hostile.scripts === 0 && hostile.handlers === 0, js(hostile));

  await app.evaluate(
    "document.addEventListener('securitypolicyviolation', (e) => (window.__cspBlocked ??= []).push(e.blockedURI))",
  );
  await click('[data-key="doc:remote-image.md"]');
  await waitFor("document.getElementById('docTitle').textContent === 'remote-image'");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const remote = await app.evaluate(
    "({ blocked: window.__cspBlocked ?? [], zeroWidth: [...document.querySelectorAll('#docBody img')].every((img) => img.naturalWidth === 0) })",
  );
  check('remote and UNC images are blocked', remote.blocked.length > 0 && remote.zeroWidth, js(remote));

  await click('[data-key="folder:"]');
  await click('#vaultMenuBtn');
  await app.evaluate("[...document.querySelectorAll('#rowMenu .menu-item')].find((b) => b.textContent === 'New folder…').click()");
  await answerAsk({ text: 'Archive' });
  check('a folder can be created from the vault menu', (await waitForFile('Archive')) && Boolean(await waitFor(`(${ROWS}).includes('folder:Archive')`)));

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

  // Recording checks. Never Pause: it mutes the real microphone.
  await click('#quickNoteBtn');
  const quick = await waitFor(
    "window.api.getSessionStatus().then((s) => (s.state === 'recording' || s.state === 'error') && s)",
    20000,
  );
  if (!quick || quick.state !== 'recording') {
    check('a quick note starts', false, quick ? quick.message ?? quick.state : 'did not start');
  } else {
    check('a quick note records into today\'s file', quick.kind === 'quick-note' && quick.documentFile === `Quick Notes/${today}.md`, quick.documentFile);
    const shown = await waitFor(
      `document.getElementById('docTitle').textContent === ${js(today)} && !document.getElementById('liveBadge').hidden && document.getElementById('quickNoteBtn').classList.contains('active') && document.getElementById('recordBtn').disabled`,
    );
    check('the quick note is shown live and Record is disabled', Boolean(shown));
    const refused = await app.evaluate("window.api.startSession({ kind: 'session', folder: '' }).then(() => 'started', (e) => e.message)");
    check('a session cannot start during a quick note', refused.includes('Stop the quick note'), refused);
    await click('#quickNoteBtn');
    const stopped = await waitFor("window.api.getSessionStatus().then((s) => s.state === 'stopped')");
    check('the quick note stops', Boolean(stopped));
    const dayFile = fs.readFileSync(vaultFile(`Quick Notes/${today}.md`), 'utf8');
    check('the day file has its date as title', dayFile.startsWith(`---\ntitle: ${today}\n`), dayFile.slice(0, 40));
  }

  await click('[data-key="folder:Archive"]');
  await click('#recordBtn');
  const status = await waitFor(
    "window.api.getSessionStatus().then((s) => s.kind === 'session' && (s.state === 'recording' || s.state === 'error') && s)",
    20000,
  );
  if (!status || status.state !== 'recording') {
    check('a session starts in the selected folder', false, status ? status.message ?? status.state : 'did not start');
  } else {
    check('a session starts in the selected folder', status.folder === 'Archive' && status.documentFile.startsWith('Archive/'), status.documentFile);
    const live = await waitFor(
      "document.getElementById('docTitle').textContent === 'untitled' && document.querySelectorAll('#libraryBody .rec-dot').length === 1 && !document.getElementById('liveBadge').hidden",
    );
    check('the session document is shown live', Boolean(live));
    const refused = await app.evaluate(
      `window.api.renameDocument(${js(status.documentFile)}, 'x').then(() => 'renamed', (e) => e.message)`,
    );
    check('the recording document cannot be renamed', refused.includes('being recorded'), refused);
    check('the panel shows the session and its paragraphs', Boolean(await waitFor("document.getElementById('panelBody').textContent.includes('Blocks (0)')")));
    await click('#stopBtn');
    const stopped = await waitFor("window.api.getSessionStatus().then((s) => s.state === 'stopped')");
    check('the session stops', Boolean(stopped));
  }
```

- [ ] **Step 2: Run the smoke checks**

Run: `npm run build && npm run smoke:workspace`
Expected: every line `PASS`, then `All workspace checks passed.` If the live model is not installed for the real app, the two recording groups report `did not start`; install `ggml-base.en.bin` through the app first.

- [ ] **Step 3: Update the documentation**

Run `git grep -n -i "dictat\|paste\|Ctrl+Q\|timestamp heading\|minutes per block\|Start session" -- README.md QUICKSTART.md DEVELOPMENT.md SETUP_SUMMARY.md .claude` and update every hit so the docs describe the new behaviour:

- **Ctrl+Q** starts or stops a **quick note**: text goes to `Quick Notes/YYYY-MM-DD.md` in the vault, one file per day, each note starting with `**YYYY-MM-DD HH:MM**`. Pause ends the paragraph; Resume starts a new one with `**HH:MM**`. It cannot run while a session records, and a session cannot start while it runs.
- **Paragraphs:** in sessions and quick notes, 5 seconds of silence (Settings → "Start a new paragraph after this many seconds of silence", 1–60) starts a new paragraph with the time. Each paragraph is refined on its own; editing one in another editor skips only that paragraph. "Longest paragraph (minutes)" replaces "Minutes per block".
- **Removed:** paste-into-any-app dictation (its shortcut, header button, "last dictation" copy button, the "Text Not Pasting" troubleshooting section, the dictation microphone and mute settings).
- **Window:** header (status, Quick Notes, model chip, Record, Stop, Pause, theme, settings), sidebar (search Ctrl+K/Ctrl+F, VAULT with Quick Notes pinned and counts, RECENT, New Session, ••• menu with New folder / Change vault / Show vault in Explorer), document pane (times in the margin, search hits highlight their line, toolbar: open in editor, copy path, copy text, text size, focus mode), right panel (Session / Blocks / Document, collapsible), dark and light themes.
- **Tray:** Show/Hide, Quick note (shortcut), Models…, Exit.
- **Project structure** (README/DEVELOPMENT): add `audioLevel.ts`, `pcmFileSink.ts`, `soxPath.ts`, `quickNotes.ts`, `guardRegistry.ts`, `windowTheme.ts`, `renderer/headerModel.ts`, `renderer/levelMeter.ts`, `renderer/theme.ts`; remove `pasteService.ts`, `audioControlService.ts`, `audioService.ts`, `micWrapper.ts`, `recordingService.ts`.

Add this entry at the top of the README changelog (match the existing entries' heading style):

```markdown
### 1.3.0

- Quick notes: Ctrl+Q (or Quick Notes in the header) records into one file per day in the Quick Notes folder, with a date and time at the start of each note.
- Recordings are split into paragraphs after 5 seconds of silence (adjustable), each with its time in the margin. Each paragraph is refined on its own.
- New look: a header with Record, Stop and Pause, a sidebar with pinned Quick Notes, folder counts and recent documents, a collapsible details panel, and a light theme.
- Search results now jump to the matching line.
- Font size and focus mode for reading.
- An earlier recording keeps refining after a new one starts.
- Removed: paste-into-any-app dictation.
```

In `docs/superpowers/specs/2026-09-15-dark-whisper-live-sessions-design.md`, add below the title block:

```markdown
> **Update (stage 3, 2026-09-16):** blocks are now variable-length paragraphs that close at pauses in speech, each with a clock line; see `2026-09-16-dark-whisper-quick-notes-refresh-design.md` §3.
```

- [ ] **Step 4: Final verification**

Run: `npm run build && npm test && npm run lint && npm run smoke:workspace`
Expected: all green; lint 0 errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/workspace-smoke.mjs README.md QUICKSTART.md DEVELOPMENT.md SETUP_SUMMARY.md .claude docs/superpowers/specs/2026-09-15-dark-whisper-live-sessions-design.md
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Cover the refreshed workspace in the smoke checks and docs

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

(Only add the files that exist and changed; `git status` first.)

---

## After the tasks (controller, with the user)

These steps need the user and are not dispatched to subagents:

1. **Live check with a real microphone** on a throwaway profile (`--user-data-dir`, model copied in):
   - speak, pause 6 s and speak again: a new paragraph with a new time;
   - Pause and Resume: the paragraph ends and a new one starts with the time;
   - two quick notes in a row: one day file, numbering continues, and the first run's paragraphs still refine;
   - edit a paragraph in Notepad++ during a quick note: only that paragraph is skipped;
   - the level meter moves while speaking;
   - light theme, focus mode, search jump.
2. Build the GPU installer for the user to test (`npm run build:windows` with the local whisper binaries, as for 1.2.x).
3. On the user's go-ahead: merge `feat/quick-notes-refresh` into `main`, push `main` to the `dark-whisper` remote, tag `v1.3.0` (parse the pwsh blocks in `.github/workflows/publish.yml` with the PowerShell parser first), watch CI, and verify the release asset URL.
