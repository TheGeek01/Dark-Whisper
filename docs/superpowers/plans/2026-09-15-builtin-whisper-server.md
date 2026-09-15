# Built-in Whisper Server & Model Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bundle and supervise a local whisper.cpp server inside Whisper Desktop, with a Models screen that downloads verified GGML models from Hugging Face.

**Architecture:** Pure, Electron-free modules (catalog, output parsing, supervisor state machine, download manager, gating) carry all logic and are unit-tested with injected dependencies. A thin `whisperRuntime.ts` wires real Electron/Node dependencies, and `main.ts`/`preload.ts`/`index.html` expose it over IPC. The server binaries are built in CI (CPU + Vulkan) and shipped via electron-builder `extraResources`.

**Tech Stack:** Electron 44, TypeScript 6 (CommonJS output, `module: node20`), Jest 30 + ts-jest, axios, electron-store 11, whisper.cpp `b5130`, GitHub Actions (windows-latest, Vulkan SDK 1.4.357.0).

**Spec:** `docs/superpowers/specs/2026-09-15-builtin-whisper-server-design.md`

## Global Constraints

- **No git commits.** The user chose not to commit (no git identity on this machine). Each task ends with a checkpoint (`git status` review) instead of a commit.
- Windows x64 is the only packaged platform; unit tests must also pass on `ubuntu-latest` (CI lint/test jobs), so tests must not spawn real processes or use Windows-only commands.
- Electron cannot load under Jest: files under `src/__tests__` must never import `electron`, `electron-store`, `settingsService`, `whisperRuntime`, or `main`.
- whisper.cpp version tag: `b5130` (file `whisper.version`). Vulkan SDK: `1.4.357.0`.
- Server args: `-m <model> --host 127.0.0.1 --port <port> --inference-path /v1/audio/transcriptions`. Never `--convert`.
- Readiness: `GET /health` → 200, polled every 500 ms, timeout 120 000 ms.
- Crash restart delays: 1000, 5000, 15000 ms; 4th crash → `error`. Counter resets after 300 000 ms in `ready`.
- Transcription timeouts: built-in 300 000 ms; external 30 000 ms.
- Download free-space margin: 100 MB (104 857 600 bytes). Progress events at most every 250 ms.
- GGML magic: `buf.readUInt32LE(0) === 0x67676d6c`.
- Custom URL shape: `https://huggingface.co/<owner>/<repo>/resolve/<rev>/<path>.bin`; custom model id `custom/<owner>__<repo>__<file>`.
- Server log: last 500 lines → `userData/logs/whisper-server.log`. PID file: `userData/whisper-server.pid`.
- Settings migration: no `serverMode` key + `config.json` existed before store init → `external`; otherwise `builtin`.
- Verification commands after every task: `npm run build`, `npm test`, `npm run lint` (0 errors; pre-existing warnings allowed).

## File Map

| File | Status | Responsibility |
|---|---|---|
| `src/services/modelCatalog.ts` | Create | Curated model list, custom URL parsing, GGML header check, `X-Linked-ETag` parsing. Pure. |
| `src/services/modelManager.ts` | Create | `ModelManager` class: list/download/verify/cancel/delete models; default axios fetcher + statfs. No Electron. |
| `src/services/serverOutput.ts` | Create | Server log line classification, restart delays, line ring buffer, tasklist CSV parsing. Pure. |
| `src/services/whisperServer.ts` | Create | `WhisperServer` supervisor state machine with injected deps. No Electron. |
| `src/services/serverPaths.ts` | Create | Server binary path resolution. Pure. |
| `src/services/serverGate.ts` | Create | `recordingGate`, `toStatusView` (status text). Pure. |
| `src/services/settingsMigration.ts` | Create | `initialServerMode`. Pure. |
| `src/services/whisperRuntime.ts` | Create | Real deps wiring (spawn, ports, health, pid, logs), singletons, `startBuiltinServer`. Electron. |
| `src/services/settingsService.ts` | Modify | New settings fields + migration. |
| `src/services/apiService.ts` | Modify | Configurable timeout; exported timeout constants. |
| `src/main.ts` | Modify | Startup/quit lifecycle, gating, tray, IPC handlers. |
| `src/preload.ts` | Modify | New bridge methods/events. |
| `public/index.html` | Modify | Status line, setup banner, settings mode toggle, Models modal. |
| `whisper.version` | Create | `b5130` |
| `scripts/fetch-whisper.js` | Create | Dev: download official CPU build into `resources/whisper/cpu`. |
| `electron-builder.yml` | Modify | Single source of packaging config + `extraResources`. |
| `package.json` | Modify | Remove duplicate `build` block; add `whisper:fetch`. |
| `.gitignore` | Modify | Ignore `resources/whisper/`. |
| `.github/workflows/publish.yml` | Modify | `build-whisper` job; release downloads its artifact. |
| `src/__tests__/*.test.ts` | Create/Modify | Unit tests per module. |

---

### Task 1: Model catalog and validation helpers

**Files:**
- Create: `src/services/modelCatalog.ts`
- Test: `src/__tests__/modelCatalog.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface CatalogModel { id: string; file: string; url: string; sizeBytes: number; sha256: string; label: string; recommended: boolean }`
  - `const CATALOG: readonly CatalogModel[]`, `const RECOMMENDED_MODEL_ID = 'ggml-large-v3-turbo-q5_0.bin'`
  - `findCatalogModel(id: string): CatalogModel | undefined`
  - `interface CustomModelUrl { url: string; owner: string; repo: string; file: string; id: string }`
  - `parseCustomModelUrl(input: string): CustomModelUrl | null`
  - `const CUSTOM_ID_PATTERN: RegExp`
  - `isGgmlHeader(buf: Buffer): boolean`
  - `parseLinkedEtag(header: string | undefined | null): string | null`
  - `displayName(id: string): string`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/modelCatalog.test.ts`:

```ts
import {
  CATALOG,
  RECOMMENDED_MODEL_ID,
  findCatalogModel,
  parseCustomModelUrl,
  CUSTOM_ID_PATTERN,
  isGgmlHeader,
  parseLinkedEtag,
  displayName,
} from '../services/modelCatalog';

describe('modelCatalog', () => {
  describe('CATALOG', () => {
    it('has 8 entries with unique ids', () => {
      expect(CATALOG).toHaveLength(8);
      expect(new Set(CATALOG.map((m) => m.id)).size).toBe(8);
    });

    it.each(CATALOG.map((m) => [m.id, m]))('%s is well formed', (_id, m) => {
      expect(m.id).toBe(m.file);
      expect(m.file).toMatch(/^ggml-[a-z0-9._-]+\.bin$/);
      expect(m.url).toBe(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${m.file}`);
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.sizeBytes).toBeGreaterThan(10_000_000);
      expect(m.label.length).toBeGreaterThan(0);
    });

    it('marks exactly the recommended model', () => {
      expect(CATALOG.filter((m) => m.recommended).map((m) => m.id)).toEqual([RECOMMENDED_MODEL_ID]);
      expect(findCatalogModel(RECOMMENDED_MODEL_ID)?.sizeBytes).toBe(574041195);
    });

    it('returns undefined for unknown ids', () => {
      expect(findCatalogModel('nope.bin')).toBeUndefined();
    });
  });

  describe('parseCustomModelUrl', () => {
    it('accepts a Hugging Face resolve URL', () => {
      expect(
        parseCustomModelUrl('https://huggingface.co/distil-whisper/distil-large-v3-ggml/resolve/main/ggml-distil-large-v3.bin'),
      ).toEqual({
        url: 'https://huggingface.co/distil-whisper/distil-large-v3-ggml/resolve/main/ggml-distil-large-v3.bin',
        owner: 'distil-whisper',
        repo: 'distil-large-v3-ggml',
        file: 'ggml-distil-large-v3.bin',
        id: 'custom/distil-whisper__distil-large-v3-ggml__ggml-distil-large-v3.bin',
      });
    });

    it('accepts nested paths, revisions, and query strings', () => {
      const parsed = parseCustomModelUrl('https://huggingface.co/a/b/resolve/abc123/sub/dir/model.bin?download=true');
      expect(parsed?.file).toBe('model.bin');
      expect(parsed?.id).toBe('custom/a__b__model.bin');
    });

    it.each([
      ['http scheme', 'http://huggingface.co/a/b/resolve/main/m.bin'],
      ['other host', 'https://example.com/a/b/resolve/main/m.bin'],
      ['lookalike host', 'https://huggingface.co.evil.com/a/b/resolve/main/m.bin'],
      ['explicit port', 'https://huggingface.co:8443/a/b/resolve/main/m.bin'],
      ['blob instead of resolve', 'https://huggingface.co/a/b/blob/main/m.bin'],
      ['not a .bin', 'https://huggingface.co/a/b/resolve/main/m.gguf'],
      ['missing file', 'https://huggingface.co/a/b/resolve/main'],
      ['traversal segment', 'https://huggingface.co/a/b/resolve/main/..%2Fx.bin'],
      ['garbage', 'not a url'],
    ])('rejects %s', (_name, url) => {
      expect(parseCustomModelUrl(url)).toBeNull();
    });
  });

  describe('CUSTOM_ID_PATTERN', () => {
    it('matches generated custom ids only', () => {
      expect(CUSTOM_ID_PATTERN.test('custom/a__b__model.bin')).toBe(true);
      expect(CUSTOM_ID_PATTERN.test('custom/../x.bin')).toBe(false);
      expect(CUSTOM_ID_PATTERN.test('ggml-tiny.en.bin')).toBe(false);
    });
  });

  describe('isGgmlHeader', () => {
    it('accepts the GGML magic', () => {
      const buf = Buffer.alloc(8);
      buf.writeUInt32LE(0x67676d6c, 0);
      expect(isGgmlHeader(buf)).toBe(true);
    });

    it('rejects HTML and short buffers', () => {
      expect(isGgmlHeader(Buffer.from('<!doctype html>'))).toBe(false);
      expect(isGgmlHeader(Buffer.from([0x6c, 0x6d]))).toBe(false);
    });
  });

  describe('parseLinkedEtag', () => {
    const sha = '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f';
    it('strips quotes and weak prefix', () => {
      expect(parseLinkedEtag(`"${sha}"`)).toBe(sha);
      expect(parseLinkedEtag(`W/"${sha.toUpperCase()}"`)).toBe(sha);
    });
    it('rejects non-sha values', () => {
      expect(parseLinkedEtag('"abc"')).toBeNull();
      expect(parseLinkedEtag(undefined)).toBeNull();
    });
  });

  describe('displayName', () => {
    it('shortens catalog and custom ids', () => {
      expect(displayName('ggml-large-v3-turbo-q5_0.bin')).toBe('large-v3-turbo-q5_0');
      expect(displayName('custom/distil-whisper__distil-large-v3-ggml__ggml-distil-large-v3.bin')).toBe(
        'distil-whisper/distil-large-v3-ggml: ggml-distil-large-v3.bin',
      );
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/modelCatalog.test.ts`
Expected: FAIL — `Cannot find module '../services/modelCatalog'`.

- [ ] **Step 3: Write the implementation**

Create `src/services/modelCatalog.ts`:

```ts
export interface CatalogModel {
  id: string;
  file: string;
  url: string;
  sizeBytes: number;
  sha256: string;
  label: string;
  recommended: boolean;
}

export interface CustomModelUrl {
  url: string;
  owner: string;
  repo: string;
  file: string;
  id: string;
}

const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

function entry(file: string, sizeBytes: number, sha256: string, label: string, recommended = false): CatalogModel {
  return { id: file, file, url: HF_BASE + file, sizeBytes, sha256, label, recommended };
}

export const RECOMMENDED_MODEL_ID = 'ggml-large-v3-turbo-q5_0.bin';

// Sizes and SHA256 from the Hugging Face tree API (2026-09-15).
export const CATALOG: readonly CatalogModel[] = [
  entry('ggml-large-v3-turbo-q5_0.bin', 574041195, '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2', 'Recommended — best balance on GPU', true),
  entry('ggml-large-v3-turbo-q8_0.bin', 874188075, '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1', 'Slightly more accurate'),
  entry('ggml-large-v3-turbo.bin', 1624555275, '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69', 'Full precision'),
  entry('ggml-medium.en-q5_0.bin', 539225533, '76733e26ad8fe1c7a5bf7531a9d41917b2adc0f20f2e4f5531688a8c6cd88eb0', 'English only'),
  entry('ggml-small.en.bin', 487614201, 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d', 'English, good on CPU'),
  entry('ggml-small.en-q5_1.bin', 190098681, 'bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30', 'English, fast on CPU'),
  entry('ggml-base.en.bin', 147964211, 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002', 'English, very fast'),
  entry('ggml-tiny.en.bin', 77704715, '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f', 'Testing / low-end'),
];

export function findCatalogModel(id: string): CatalogModel | undefined {
  return CATALOG.find((m) => m.id === id);
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

export const CUSTOM_ID_PATTERN = /^custom\/[A-Za-z0-9._-]+__[A-Za-z0-9._-]+__[A-Za-z0-9._-]+\.bin$/;

export function parseCustomModelUrl(input: string): CustomModelUrl | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'huggingface.co' || url.port !== '') {
    return null;
  }
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  if (segments.length < 5 || segments[2] !== 'resolve') {
    return null;
  }
  const [owner, repo] = segments;
  const file = segments[segments.length - 1];
  const valid = [owner, repo, file].every((s) => SAFE_SEGMENT.test(s) && s !== '.' && s !== '..');
  if (!valid || !file.endsWith('.bin')) {
    return null;
  }
  return { url: url.toString(), owner, repo, file, id: `custom/${owner}__${repo}__${file}` };
}

export const GGML_MAGIC = 0x67676d6c;

export function isGgmlHeader(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === GGML_MAGIC;
}

export function parseLinkedEtag(header: string | undefined | null): string | null {
  if (!header) return null;
  const value = header.replace(/^W\//, '').replace(/"/g, '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

export function displayName(id: string): string {
  if (id.startsWith('custom/')) {
    const [owner, repo, ...rest] = id.slice('custom/'.length).split('__');
    return `${owner}/${repo}: ${rest.join('__')}`;
  }
  return id.replace(/^ggml-/, '').replace(/\.bin$/, '');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/modelCatalog.test.ts`
Expected: PASS. Then `npm run lint` → 0 errors.

- [ ] **Step 5: Checkpoint (no commit)**

Run: `git status --short` — expect the two new files only.

---

### Task 2: Model download manager

**Files:**
- Create: `src/services/modelManager.ts`
- Test: `src/__tests__/modelManager.test.ts`

**Interfaces:**
- Consumes (Task 1): `CATALOG`, `findCatalogModel`, `parseCustomModelUrl`, `CUSTOM_ID_PATTERN`, `isGgmlHeader`, `parseLinkedEtag`, `displayName`.
- Produces:
  - `interface FetchResult { stream: NodeJS.ReadableStream; totalBytes: number | null; linkedSha256: string | null }`
  - `type ModelFetcher = (url: string, signal: AbortSignal) => Promise<FetchResult>`
  - `type FreeSpaceFn = (dir: string) => Promise<number>`
  - `interface ModelEntry { id: string; name: string; label: string; sizeBytes: number | null; installed: boolean; custom: boolean; recommended: boolean }`
  - `type DownloadState = 'downloading' | 'verifying' | 'done' | 'error' | 'cancelled'`
  - `interface DownloadProgress { id: string; receivedBytes: number; totalBytes: number | null; bytesPerSec: number; state: DownloadState; error?: string }`
  - `class ModelManager` with `constructor(opts: { modelsDir: string; fetcher: ModelFetcher; freeSpace: FreeSpaceFn; now?: () => number })`, `init(): Promise<void>`, `isValidId(id: string): boolean`, `listModels(): ModelEntry[]`, `getModelPath(id: string): string | null`, `startDownload(id: string): Promise<DownloadProgress>`, `startCustomDownload(url: string): Promise<DownloadProgress>`, `cancelDownload(): void`, `isDownloading(): boolean`, `deleteModel(id: string): Promise<void>`, `getDiskInfo(): Promise<{ usedBytes: number; freeBytes: number }>`, `onProgress(listener: (p: DownloadProgress) => void): () => void`
  - `const axiosFetcher: ModelFetcher`, `const statfsFreeSpace: FreeSpaceFn`
  - Pre-flight failures (download in progress, unknown id, invalid URL, not enough space) **reject**; download failures **resolve** with `state: 'error' | 'cancelled'` after emitting that progress event.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/modelManager.test.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { PassThrough, Readable } from 'stream';
import { ModelManager, ModelFetcher, DownloadProgress } from '../services/modelManager';
import { CATALOG } from '../services/modelCatalog';

function ggmlBytes(size = 64): Buffer {
  const buf = Buffer.alloc(size, 7);
  buf.writeUInt32LE(0x67676d6c, 0);
  return buf;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('ModelManager', () => {
  let dir: string;
  const tiny = CATALOG.find((m) => m.id === 'ggml-tiny.en.bin')!;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function manager(fetcher: ModelFetcher, freeBytes = 10 * 1024 ** 3) {
    return new ModelManager({ modelsDir: dir, fetcher, freeSpace: async () => freeBytes });
  }

  function fetcherFor(body: Buffer, linkedSha256: string | null = null): ModelFetcher {
    return async () => ({ stream: Readable.from([body]), totalBytes: body.length, linkedSha256 });
  }

  it('init creates directories and removes stray .part files', async () => {
    fs.mkdirSync(path.join(dir, 'custom'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'x.bin.part'), 'junk');
    fs.writeFileSync(path.join(dir, 'custom', 'y.bin.part'), 'junk');
    fs.writeFileSync(path.join(dir, 'keep.bin'), 'keep');
    await manager(fetcherFor(Buffer.alloc(0))).init();
    expect(fs.existsSync(path.join(dir, 'x.bin.part'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'custom', 'y.bin.part'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'keep.bin'))).toBe(true);
  });

  it('validates ids', () => {
    const m = manager(fetcherFor(Buffer.alloc(0)));
    expect(m.isValidId('ggml-tiny.en.bin')).toBe(true);
    expect(m.isValidId('custom/a__b__c.bin')).toBe(true);
    expect(m.isValidId('../evil.bin')).toBe(false);
    expect(m.getModelPath('../evil.bin')).toBeNull();
  });

  it('lists catalog models with installed flags and custom models', async () => {
    const m = manager(fetcherFor(Buffer.alloc(0)));
    await m.init();
    fs.writeFileSync(path.join(dir, 'ggml-tiny.en.bin'), ggmlBytes());
    fs.writeFileSync(path.join(dir, 'custom', 'a__b__model.bin'), ggmlBytes(100));
    const list = m.listModels();
    expect(list).toHaveLength(CATALOG.length + 1);
    expect(list.find((e) => e.id === 'ggml-tiny.en.bin')).toMatchObject({ installed: true, custom: false, name: 'tiny.en' });
    expect(list.find((e) => e.id === 'ggml-base.en.bin')?.installed).toBe(false);
    expect(list.find((e) => e.id === 'custom/a__b__model.bin')).toMatchObject({
      installed: true,
      custom: true,
      sizeBytes: 100,
      name: 'a/b: model.bin',
      label: 'Custom model',
    });
    expect(m.getModelPath('ggml-tiny.en.bin')).toBe(path.join(dir, 'ggml-tiny.en.bin'));
    expect(m.getModelPath('ggml-base.en.bin')).toBeNull();
  });

  it('downloads a custom model, verifies linked sha256, and renames .part', async () => {
    const body = ggmlBytes(1024);
    const m = manager(fetcherFor(body, sha(body)));
    await m.init();
    const events: DownloadProgress[] = [];
    m.onProgress((p) => events.push(p));
    const result = await m.startCustomDownload('https://huggingface.co/a/b/resolve/main/model.bin');
    expect(result).toMatchObject({ id: 'custom/a__b__model.bin', state: 'done', receivedBytes: 1024 });
    expect(fs.readFileSync(path.join(dir, 'custom', 'a__b__model.bin'))).toEqual(body);
    expect(fs.existsSync(path.join(dir, 'custom', 'a__b__model.bin.part'))).toBe(false);
    expect(events.map((e) => e.state)).toEqual(expect.arrayContaining(['verifying', 'done']));
    expect(m.isDownloading()).toBe(false);
  });

  it('fails a catalog download on checksum mismatch and deletes .part', async () => {
    const m = manager(fetcherFor(ggmlBytes(2048)));
    await m.init();
    const result = await m.startDownload(tiny.id);
    expect(result.state).toBe('error');
    expect(result.error).toMatch(/checksum/i);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('ggml-tiny'))).toEqual([]);
  });

  it('rejects files that are not GGML', async () => {
    const m = manager(fetcherFor(Buffer.from('<!doctype html><html></html>')));
    await m.init();
    const result = await m.startCustomDownload('https://huggingface.co/a/b/resolve/main/model.bin');
    expect(result.state).toBe('error');
    expect(result.error).toMatch(/not a Whisper GGML model/);
  });

  it('accepts a custom download without linked sha when the header is valid', async () => {
    const m = manager(fetcherFor(ggmlBytes(256), null));
    await m.init();
    expect((await m.startCustomDownload('https://huggingface.co/a/b/resolve/main/m.bin')).state).toBe('done');
  });

  it('cancels a running download and deletes .part', async () => {
    const stream = new PassThrough();
    const fetcher: ModelFetcher = async () => ({ stream, totalBytes: 10_000, linkedSha256: null });
    const m = manager(fetcher);
    await m.init();
    const pending = m.startCustomDownload('https://huggingface.co/a/b/resolve/main/m.bin');
    stream.write(ggmlBytes(100));
    await new Promise((r) => setTimeout(r, 20));
    expect(m.isDownloading()).toBe(true);
    m.cancelDownload();
    const result = await pending;
    expect(result.state).toBe('cancelled');
    expect(fs.existsSync(path.join(dir, 'custom', 'a__b__m.bin.part'))).toBe(false);
    expect(m.isDownloading()).toBe(false);
  });

  it('rejects a second concurrent download', async () => {
    const stream = new PassThrough();
    const m = manager(async () => ({ stream, totalBytes: null, linkedSha256: null }));
    await m.init();
    const first = m.startCustomDownload('https://huggingface.co/a/b/resolve/main/m.bin');
    await new Promise((r) => setTimeout(r, 10));
    await expect(m.startDownload(tiny.id)).rejects.toThrow(/already in progress/);
    m.cancelDownload();
    await first;
  });

  it('rejects unknown ids, invalid URLs, and insufficient space before downloading', async () => {
    const fetcher = jest.fn(fetcherFor(ggmlBytes()));
    const m = manager(fetcher, tiny.sizeBytes);
    await m.init();
    await expect(m.startDownload('nope.bin')).rejects.toThrow(/Unknown model/);
    await expect(m.startCustomDownload('https://example.com/x.bin')).rejects.toThrow(/Hugging Face/);
    await expect(m.startDownload(tiny.id)).rejects.toThrow(/Not enough disk space/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('deletes installed models and reports disk usage', async () => {
    const m = manager(fetcherFor(Buffer.alloc(0)), 5000);
    await m.init();
    fs.writeFileSync(path.join(dir, 'ggml-tiny.en.bin'), ggmlBytes(300));
    fs.writeFileSync(path.join(dir, 'custom', 'a__b__c.bin'), ggmlBytes(200));
    expect(await m.getDiskInfo()).toEqual({ usedBytes: 500, freeBytes: 5000 });
    await m.deleteModel('ggml-tiny.en.bin');
    expect(m.getModelPath('ggml-tiny.en.bin')).toBeNull();
    await expect(m.deleteModel('../x.bin')).rejects.toThrow(/Unknown model/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/modelManager.test.ts`
Expected: FAIL — `Cannot find module '../services/modelManager'`.

- [ ] **Step 3: Write the implementation**

Create `src/services/modelManager.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import axios from 'axios';
import {
  CATALOG,
  CUSTOM_ID_PATTERN,
  displayName,
  findCatalogModel,
  isGgmlHeader,
  parseCustomModelUrl,
  parseLinkedEtag,
} from './modelCatalog';

export interface FetchResult {
  stream: NodeJS.ReadableStream;
  totalBytes: number | null;
  linkedSha256: string | null;
}

export type ModelFetcher = (url: string, signal: AbortSignal) => Promise<FetchResult>;
export type FreeSpaceFn = (dir: string) => Promise<number>;

export interface ModelEntry {
  id: string;
  name: string;
  label: string;
  sizeBytes: number | null;
  installed: boolean;
  custom: boolean;
  recommended: boolean;
}

export type DownloadState = 'downloading' | 'verifying' | 'done' | 'error' | 'cancelled';

export interface DownloadProgress {
  id: string;
  receivedBytes: number;
  totalBytes: number | null;
  bytesPerSec: number;
  state: DownloadState;
  error?: string;
}

export interface ModelManagerOptions {
  modelsDir: string;
  fetcher: ModelFetcher;
  freeSpace: FreeSpaceFn;
  now?: () => number;
}

const SPACE_MARGIN_BYTES = 100 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 250;

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export class ModelManager {
  private readonly modelsDir: string;
  private readonly fetcher: ModelFetcher;
  private readonly freeSpace: FreeSpaceFn;
  private readonly now: () => number;
  private readonly listeners = new Set<(p: DownloadProgress) => void>();
  private active: AbortController | null = null;

  constructor(opts: ModelManagerOptions) {
    this.modelsDir = opts.modelsDir;
    this.fetcher = opts.fetcher;
    this.freeSpace = opts.freeSpace;
    this.now = opts.now ?? Date.now;
  }

  async init(): Promise<void> {
    const customDir = path.join(this.modelsDir, 'custom');
    await fs.promises.mkdir(customDir, { recursive: true });
    for (const d of [this.modelsDir, customDir]) {
      for (const f of await fs.promises.readdir(d)) {
        if (f.endsWith('.part')) {
          await fs.promises.rm(path.join(d, f), { force: true });
        }
      }
    }
  }

  isValidId(id: string): boolean {
    return findCatalogModel(id) !== undefined || CUSTOM_ID_PATTERN.test(id);
  }

  getModelPath(id: string): string | null {
    if (!this.isValidId(id)) return null;
    const p = path.join(this.modelsDir, id);
    return fs.existsSync(p) ? p : null;
  }

  listModels(): ModelEntry[] {
    const entries: ModelEntry[] = CATALOG.map((m) => ({
      id: m.id,
      name: displayName(m.id),
      label: m.label,
      sizeBytes: m.sizeBytes,
      installed: fs.existsSync(path.join(this.modelsDir, m.id)),
      custom: false,
      recommended: m.recommended,
    }));
    const customDir = path.join(this.modelsDir, 'custom');
    const customFiles = fs.existsSync(customDir) ? fs.readdirSync(customDir) : [];
    for (const f of customFiles) {
      const id = `custom/${f}`;
      if (!CUSTOM_ID_PATTERN.test(id)) continue;
      entries.push({
        id,
        name: displayName(id),
        label: 'Custom model',
        sizeBytes: fs.statSync(path.join(customDir, f)).size,
        installed: true,
        custom: true,
        recommended: false,
      });
    }
    return entries;
  }

  isDownloading(): boolean {
    return this.active !== null;
  }

  onProgress(listener: (p: DownloadProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async startDownload(id: string): Promise<DownloadProgress> {
    const model = findCatalogModel(id);
    if (!model) throw new Error(`Unknown model: ${id}`);
    return this.run(model.id, model.url, model.sha256, model.sizeBytes);
  }

  async startCustomDownload(url: string): Promise<DownloadProgress> {
    const parsed = parseCustomModelUrl(url);
    if (!parsed) {
      throw new Error('Only https://huggingface.co/<owner>/<repo>/resolve/<revision>/<file>.bin links are supported (Hugging Face)');
    }
    return this.run(parsed.id, parsed.url, null, null);
  }

  cancelDownload(): void {
    this.active?.abort();
  }

  async deleteModel(id: string): Promise<void> {
    if (!this.isValidId(id)) throw new Error(`Unknown model: ${id}`);
    await fs.promises.rm(path.join(this.modelsDir, id), { force: true, maxRetries: 5, retryDelay: 200 });
  }

  async getDiskInfo(): Promise<{ usedBytes: number; freeBytes: number }> {
    const usedBytes = this.listModels()
      .filter((m) => m.installed)
      .reduce((sum, m) => sum + fs.statSync(path.join(this.modelsDir, m.id)).size, 0);
    return { usedBytes, freeBytes: await this.freeSpace(this.modelsDir) };
  }

  private emit(p: DownloadProgress): DownloadProgress {
    for (const l of this.listeners) l(p);
    return p;
  }

  private async assertSpace(needed: number): Promise<void> {
    const free = await this.freeSpace(this.modelsDir);
    if (free < needed + SPACE_MARGIN_BYTES) {
      throw new Error(`Not enough disk space: ${formatGb(needed + SPACE_MARGIN_BYTES)} needed, ${formatGb(free)} free`);
    }
  }

  private async run(id: string, url: string, expectedSha: string | null, expectedSize: number | null): Promise<DownloadProgress> {
    if (this.active) throw new Error('A download is already in progress');
    if (expectedSize !== null) await this.assertSpace(expectedSize);
    if (this.active) throw new Error('A download is already in progress');

    const controller = new AbortController();
    this.active = controller;
    const dest = path.join(this.modelsDir, id);
    const part = `${dest}.part`;
    const started = this.now();
    let received = 0;
    let total: number | null = expectedSize;
    let lastEmit = 0;
    const progress = (state: DownloadState, error?: string): DownloadProgress => {
      const elapsed = (this.now() - started) / 1000;
      return { id, receivedBytes: received, totalBytes: total, bytesPerSec: elapsed > 0 ? Math.round(received / elapsed) : 0, state, error };
    };

    try {
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      this.emit(progress('downloading'));
      const res = await this.fetcher(url, controller.signal);
      total = total ?? res.totalBytes;
      if (expectedSize === null && res.totalBytes !== null) await this.assertSpace(res.totalBytes);
      const expected = expectedSha ?? res.linkedSha256;

      const hash = createHash('sha256');
      let header = Buffer.alloc(0);
      const meter = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          hash.update(chunk);
          received += chunk.length;
          if (header.length < 4) header = Buffer.concat([header, chunk]).subarray(0, 4);
          if (this.now() - lastEmit >= PROGRESS_INTERVAL_MS) {
            lastEmit = this.now();
            this.emit(progress('downloading'));
          }
          cb(null, chunk);
        },
      });
      await pipeline(res.stream, meter, fs.createWriteStream(part), { signal: controller.signal });

      this.emit(progress('verifying'));
      if (!isGgmlHeader(header)) throw new Error('Downloaded file is not a Whisper GGML model');
      if (expected && hash.digest('hex') !== expected) {
        throw new Error('Download was corrupted (checksum mismatch). Please retry.');
      }
      await fs.promises.rename(part, dest);
      return this.emit(progress('done'));
    } catch (err) {
      await fs.promises.rm(part, { force: true, maxRetries: 5, retryDelay: 100 });
      if (controller.signal.aborted) return this.emit(progress('cancelled'));
      return this.emit(progress('error', err instanceof Error ? err.message : String(err)));
    } finally {
      this.active = null;
    }
  }
}

// X-Linked-ETag (the SHA256) is only present on Hugging Face's 302 response, so read it without following redirects.
export const axiosFetcher: ModelFetcher = async (url, signal) => {
  const headers = { 'User-Agent': 'whisper-desktop' };
  const head = await axios.head(url, {
    maxRedirects: 0,
    validateStatus: (s) => s >= 200 && s < 400,
    signal,
    headers,
    timeout: 30000,
  });
  const res = await axios.get(url, { responseType: 'stream', signal, headers, timeout: 60000 });
  const length = Number(res.headers['content-length']);
  return {
    stream: res.data,
    totalBytes: Number.isFinite(length) && length > 0 ? length : null,
    linkedSha256: parseLinkedEtag(String(head.headers['x-linked-etag'] ?? '')),
  };
};

export const statfsFreeSpace: FreeSpaceFn = async (dir) => {
  const stats = await fs.promises.statfs(dir);
  return stats.bavail * stats.bsize;
};
```

Note: the pre-flight rejections happen before `this.active` is set, so `startDownload` for an unknown id / low space never leaves the manager locked.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/modelManager.test.ts`
Expected: PASS (11 tests). Then `npm run build` and `npm run lint` → 0 errors.

- [ ] **Step 5: Checkpoint (no commit)**

Run: `git status --short` — expect `src/services/modelManager.ts` and its test added.

---

### Task 3: Server output parsing and binary path resolution

**Files:**
- Create: `src/services/serverOutput.ts`
- Create: `src/services/serverPaths.ts`
- Test: `src/__tests__/serverOutput.test.ts`
- Test: `src/__tests__/serverPaths.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (`serverOutput.ts`):
  - `type ServerLineEvent = 'model-load-failed' | 'bind-failed' | 'gpu-backend' | 'no-gpu'`
  - `classifyServerLine(line: string): ServerLineEvent | null`
  - `const RESTART_DELAYS_MS: readonly number[]` (`[1000, 5000, 15000]`), `restartDelay(crashCount: number): number | null`
  - `class LineBuffer { constructor(max?: number); push(chunk: string): string[]; lines(): string[] }`
  - `parseTasklistImage(output: string): string | null`, `isWhisperServerImage(name: string | null): boolean`
- Produces (`serverPaths.ts`):
  - `type Backend = 'vulkan' | 'cpu'`, `const SERVER_EXE = 'whisper-server.exe'`
  - `interface BinaryLocations { envDir?: string; resourcesPath: string; appPath: string; isPackaged: boolean }`
  - `whisperResourceDir(loc: BinaryLocations): string`
  - `candidateServerPaths(backend: Backend, loc: BinaryLocations): string[]`
  - `resolveServerBinary(backend: Backend, loc: BinaryLocations, exists: (p: string) => boolean): string | null`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/serverOutput.test.ts`:

```ts
import {
  classifyServerLine,
  restartDelay,
  RESTART_DELAYS_MS,
  LineBuffer,
  parseTasklistImage,
  isWhisperServerImage,
} from '../services/serverOutput';

describe('serverOutput', () => {
  describe('classifyServerLine', () => {
    it.each([
      ['error: failed to initialize whisper context', 'model-load-failed'],
      ["couldn't bind to server socket: hostname=127.0.0.1 port=5000", 'bind-failed'],
      ['whisper_backend_init_gpu: using Vulkan0 backend', 'gpu-backend'],
      ['whisper_backend_init_gpu: no GPU found', 'no-gpu'],
      ['whisper_backend_init: using BLAS backend', null],
      ['whisper server listening at http://127.0.0.1:5000', null],
    ])('%s -> %s', (line, expected) => {
      expect(classifyServerLine(line)).toBe(expected);
    });
  });

  describe('restartDelay', () => {
    it('follows 1s, 5s, 15s then gives up', () => {
      expect(RESTART_DELAYS_MS).toEqual([1000, 5000, 15000]);
      expect([1, 2, 3, 4].map(restartDelay)).toEqual([1000, 5000, 15000, null]);
      expect(restartDelay(0)).toBeNull();
    });
  });

  describe('LineBuffer', () => {
    it('returns complete lines and keeps partial lines until finished', () => {
      const buf = new LineBuffer(10);
      expect(buf.push('first\r\nsec')).toEqual(['first']);
      expect(buf.push('ond\n\nthird')).toEqual(['second']);
      expect(buf.lines()).toEqual(['first', 'second', 'third']);
    });

    it('keeps only the most recent lines', () => {
      const buf = new LineBuffer(3);
      buf.push('1\n2\n3\n4\n5\n');
      expect(buf.lines()).toEqual(['3', '4', '5']);
    });
  });

  describe('tasklist parsing', () => {
    it('reads the image name from CSV output', () => {
      expect(parseTasklistImage('"whisper-server.exe","4242","Console","1","250,000 K"\r\n')).toBe('whisper-server.exe');
    });

    it('returns null when no process matches', () => {
      expect(parseTasklistImage('INFO: No tasks are running which match the specified criteria.\r\n')).toBeNull();
      expect(parseTasklistImage('')).toBeNull();
    });

    it('only accepts whisper-server.exe', () => {
      expect(isWhisperServerImage('WHISPER-SERVER.EXE')).toBe(true);
      expect(isWhisperServerImage('chrome.exe')).toBe(false);
      expect(isWhisperServerImage(null)).toBe(false);
    });
  });
});
```

Create `src/__tests__/serverPaths.test.ts`:

```ts
import * as path from 'path';
import { candidateServerPaths, resolveServerBinary, whisperResourceDir } from '../services/serverPaths';

describe('serverPaths', () => {
  const dev = { resourcesPath: '/electron/resources', appPath: '/repo', isPackaged: false };
  const packaged = { resourcesPath: '/app/resources', appPath: '/app/resources/app.asar', isPackaged: true };

  it('uses the repo resources folder in development and resourcesPath when packaged', () => {
    expect(whisperResourceDir(dev)).toBe(path.join('/repo', 'resources', 'whisper'));
    expect(whisperResourceDir(packaged)).toBe(path.join('/app/resources', 'whisper'));
  });

  it('checks WHISPER_SERVER_DIR first for the vulkan backend only', () => {
    const loc = { ...dev, envDir: '/local/vulkan-build' };
    expect(candidateServerPaths('vulkan', loc)).toEqual([
      path.join('/local/vulkan-build', 'whisper-server.exe'),
      path.join('/repo', 'resources', 'whisper', 'vulkan', 'whisper-server.exe'),
    ]);
    expect(candidateServerPaths('cpu', loc)).toEqual([path.join('/repo', 'resources', 'whisper', 'cpu', 'whisper-server.exe')]);
  });

  it('returns the first existing candidate or null', () => {
    const cpu = path.join('/app/resources', 'whisper', 'cpu', 'whisper-server.exe');
    expect(resolveServerBinary('cpu', packaged, (p) => p === cpu)).toBe(cpu);
    expect(resolveServerBinary('vulkan', packaged, () => false)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/__tests__/serverOutput.test.ts src/__tests__/serverPaths.test.ts`
Expected: FAIL — cannot find modules.

- [ ] **Step 3: Write the implementations**

Create `src/services/serverOutput.ts`:

```ts
export type ServerLineEvent = 'model-load-failed' | 'bind-failed' | 'gpu-backend' | 'no-gpu';

// Strings from whisper.cpp b5130 (examples/server/server.cpp, src/whisper.cpp). Re-check when bumping whisper.version.
export function classifyServerLine(line: string): ServerLineEvent | null {
  if (line.includes('failed to initialize whisper context')) return 'model-load-failed';
  if (line.includes("couldn't bind to server socket")) return 'bind-failed';
  if (line.includes('whisper_backend_init_gpu: no GPU found')) return 'no-gpu';
  if (/whisper_backend_init_gpu: using \S+ backend/.test(line)) return 'gpu-backend';
  return null;
}

export const RESTART_DELAYS_MS: readonly number[] = [1000, 5000, 15000];

export function restartDelay(crashCount: number): number | null {
  return crashCount >= 1 && crashCount <= RESTART_DELAYS_MS.length ? RESTART_DELAYS_MS[crashCount - 1] : null;
}

export class LineBuffer {
  private partial = '';
  private readonly buffer: string[] = [];

  constructor(private readonly max = 500) {}

  push(chunk: string): string[] {
    const parts = (this.partial + chunk).split(/\r?\n/);
    this.partial = parts.pop() ?? '';
    const complete = parts.filter((l) => l.length > 0);
    for (const line of complete) {
      this.buffer.push(line);
      if (this.buffer.length > this.max) this.buffer.shift();
    }
    return complete;
  }

  lines(): string[] {
    const all = this.partial ? [...this.buffer, this.partial] : [...this.buffer];
    return all.slice(-this.max);
  }
}

export function parseTasklistImage(output: string): string | null {
  const line = output.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  const match = line ? /^"([^"]+)"/.exec(line) : null;
  return match ? match[1] : null;
}

export function isWhisperServerImage(name: string | null): boolean {
  return name?.toLowerCase() === 'whisper-server.exe';
}
```

Create `src/services/serverPaths.ts`:

```ts
import * as path from 'path';

export type Backend = 'vulkan' | 'cpu';

export const SERVER_EXE = 'whisper-server.exe';

export interface BinaryLocations {
  envDir?: string;
  resourcesPath: string;
  appPath: string;
  isPackaged: boolean;
}

export function whisperResourceDir(loc: BinaryLocations): string {
  return loc.isPackaged ? path.join(loc.resourcesPath, 'whisper') : path.join(loc.appPath, 'resources', 'whisper');
}

export function candidateServerPaths(backend: Backend, loc: BinaryLocations): string[] {
  const candidates: string[] = [];
  if (backend === 'vulkan' && loc.envDir) {
    candidates.push(path.join(loc.envDir, SERVER_EXE));
  }
  candidates.push(path.join(whisperResourceDir(loc), backend, SERVER_EXE));
  return candidates;
}

export function resolveServerBinary(backend: Backend, loc: BinaryLocations, exists: (p: string) => boolean): string | null {
  return candidateServerPaths(backend, loc).find(exists) ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/__tests__/serverOutput.test.ts src/__tests__/serverPaths.test.ts`
Expected: PASS. Then `npm run lint` → 0 errors.

- [ ] **Step 5: Checkpoint (no commit)**

Run: `git status --short` — expect four new files.

---

### Task 4: WhisperServer supervisor

**Files:**
- Create: `src/services/whisperServer.ts`
- Test: `src/__tests__/whisperServer.test.ts`

**Interfaces:**
- Consumes (Task 3): `classifyServerLine`, `LineBuffer`, `restartDelay`, `ServerLineEvent`, `Backend`.
- Produces:
  - `type ServerState = 'no-model' | 'starting' | 'ready' | 'error' | 'stopped'`
  - `interface ServerStatus { state: ServerState; modelId: string | null; backend: Backend | null; gpu: boolean; port: number | null; message?: string }`
  - `interface ServerProcess { pid: number | undefined; stdout: DataSource; stderr: DataSource; onExit(listener: (code: number | null) => void): void; kill(): void }` where `DataSource = { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown }`
  - `interface WhisperServerDeps { resolveBinary(backend: Backend): string | null; spawnServer(binary: string, args: string[]): ServerProcess; findFreePort(): Promise<number>; checkHealth(port: number): Promise<boolean>; killStaleProcess(): Promise<void>; writePid(pid: number): void; clearPid(): void; writeLog(lines: string[]): void; getGpuFallback(): boolean; setGpuFallback(value: boolean): void; now(): number }`
  - `const READY_TIMEOUT_MS = 120_000`, `HEALTH_POLL_MS = 500`, `STABLE_RESET_MS = 300_000`, `INFERENCE_PATH = '/v1/audio/transcriptions'`
  - `class WhisperServer { constructor(deps: WhisperServerDeps); getStatus(): ServerStatus; getBaseUrl(): string | null; onStatus(listener: (s: ServerStatus) => void): () => void; start(modelId: string, modelPath: string, opts: { forceCpu: boolean }): Promise<void>; restart(): Promise<void>; stop(): void; setNoModel(): void }`
  - `stop()` and `setNoModel()` kill synchronously (safe to call from `before-quit`).

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/whisperServer.test.ts`:

```ts
import { EventEmitter } from 'events';
import { WhisperServer, ServerProcess } from '../services/whisperServer';
import type { Backend } from '../services/serverPaths';

class FakeProcess implements ServerProcess {
  pid = 4242;
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

  log(line: string): void {
    this.stderr.emit('data', Buffer.from(`${line}\n`));
  }

  exit(code: number | null): void {
    this.exitListener?.(code);
  }
}

function setup() {
  const procs: FakeProcess[] = [];
  let fallback = false;
  const deps = {
    resolveBinary: jest.fn((b: Backend): string | null => `/bin/${b}/whisper-server.exe`),
    spawnServer: jest.fn((_binary: string, _args: string[]) => {
      const p = new FakeProcess();
      procs.push(p);
      return p;
    }),
    findFreePort: jest.fn(async () => 5000 + procs.length),
    checkHealth: jest.fn(async (_port: number) => false),
    killStaleProcess: jest.fn(async () => undefined),
    writePid: jest.fn(),
    clearPid: jest.fn(),
    writeLog: jest.fn(),
    getGpuFallback: jest.fn(() => fallback),
    setGpuFallback: jest.fn((v: boolean) => {
      fallback = v;
    }),
    now: () => Date.now(),
  };
  const server = new WhisperServer(deps);
  return { server, deps, procs };
}

const MODEL = ['ggml-tiny.en.bin', '/models/ggml-tiny.en.bin'] as const;
const flush = () => jest.advanceTimersByTimeAsync(0);

describe('WhisperServer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function startReady(ctx: ReturnType<typeof setup>) {
    await ctx.server.start(...MODEL, { forceCpu: false });
    ctx.deps.checkHealth.mockResolvedValue(true);
    await jest.advanceTimersByTimeAsync(500);
  }

  it('starts with no-model state', () => {
    expect(setup().server.getStatus()).toEqual({ state: 'no-model', modelId: null, backend: null, gpu: false, port: null });
  });

  it('spawns the vulkan build and becomes ready with a base url', async () => {
    const { server, deps, procs } = setup();
    const seen: string[] = [];
    server.onStatus((s) => seen.push(s.state));
    await server.start(...MODEL, { forceCpu: false });

    expect(deps.killStaleProcess).toHaveBeenCalledTimes(1);
    expect(deps.spawnServer).toHaveBeenCalledWith('/bin/vulkan/whisper-server.exe', [
      '-m', '/models/ggml-tiny.en.bin', '--host', '127.0.0.1', '--port', '5000', '--inference-path', '/v1/audio/transcriptions',
    ]);
    expect(deps.writePid).toHaveBeenCalledWith(4242);
    expect(server.getStatus()).toMatchObject({ state: 'starting', backend: 'vulkan', port: 5000, modelId: 'ggml-tiny.en.bin' });
    expect(server.getBaseUrl()).toBeNull();

    procs[0].log('whisper_backend_init_gpu: using Vulkan0 backend');
    deps.checkHealth.mockResolvedValue(true);
    await jest.advanceTimersByTimeAsync(500);

    expect(deps.checkHealth).toHaveBeenCalledWith(5000);
    expect(server.getStatus()).toMatchObject({ state: 'ready', gpu: true });
    expect(server.getBaseUrl()).toBe('http://127.0.0.1:5000');
    expect(seen).toEqual(['starting', 'ready']);
    expect(deps.writeLog).toHaveBeenCalled();
  });

  it('reports CPU when the vulkan build finds no GPU', async () => {
    const ctx = setup();
    await ctx.server.start(...MODEL, { forceCpu: false });
    ctx.procs[0].log('whisper_backend_init_gpu: no GPU found');
    ctx.deps.checkHealth.mockResolvedValue(true);
    await jest.advanceTimersByTimeAsync(500);
    expect(ctx.server.getStatus()).toMatchObject({ state: 'ready', backend: 'vulkan', gpu: false });
  });

  it('uses the CPU build when forced or after a remembered fallback', async () => {
    const forced = setup();
    await forced.server.start(...MODEL, { forceCpu: true });
    expect(forced.deps.spawnServer.mock.calls[0][0]).toBe('/bin/cpu/whisper-server.exe');

    const remembered = setup();
    remembered.deps.getGpuFallback.mockReturnValue(true);
    await remembered.server.start(...MODEL, { forceCpu: false });
    expect(remembered.deps.spawnServer.mock.calls[0][0]).toBe('/bin/cpu/whisper-server.exe');
  });

  it('uses CPU when the vulkan binary is missing and errors when no binary exists', async () => {
    const noVulkan = setup();
    noVulkan.deps.resolveBinary.mockImplementation((b: Backend) => (b === 'cpu' ? '/bin/cpu/whisper-server.exe' : null));
    await noVulkan.server.start(...MODEL, { forceCpu: false });
    expect(noVulkan.deps.spawnServer.mock.calls[0][0]).toBe('/bin/cpu/whisper-server.exe');

    const none = setup();
    none.deps.resolveBinary.mockReturnValue(null);
    await none.server.start(...MODEL, { forceCpu: false });
    expect(none.deps.spawnServer).not.toHaveBeenCalled();
    expect(none.server.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(/missing/) });
  });

  it('falls back to CPU and remembers it when vulkan exits during startup', async () => {
    const { server, deps, procs } = setup();
    await server.start(...MODEL, { forceCpu: false });
    procs[0].exit(3221225781);
    await flush();
    expect(deps.setGpuFallback).toHaveBeenCalledWith(true);
    expect(deps.clearPid).toHaveBeenCalled();
    expect(deps.spawnServer).toHaveBeenCalledTimes(2);
    expect(deps.spawnServer.mock.calls[1][0]).toBe('/bin/cpu/whisper-server.exe');
    expect(server.getStatus()).toMatchObject({ state: 'starting', backend: 'cpu' });
  });

  it('does not fall back when the model fails to load', async () => {
    const { server, deps, procs } = setup();
    await server.start(...MODEL, { forceCpu: false });
    procs[0].log('error: failed to initialize whisper context');
    procs[0].exit(3);
    await flush();
    expect(deps.spawnServer).toHaveBeenCalledTimes(1);
    expect(deps.setGpuFallback).not.toHaveBeenCalled();
    expect(server.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(/Model failed to load/) });
  });

  it('retries once on a port bind failure, then errors', async () => {
    const { server, deps, procs } = setup();
    await server.start(...MODEL, { forceCpu: false });
    procs[0].log("couldn't bind to server socket: hostname=127.0.0.1 port=5000");
    procs[0].exit(1);
    await flush();
    expect(deps.spawnServer).toHaveBeenCalledTimes(2);
    expect(deps.spawnServer.mock.calls[1][0]).toBe('/bin/vulkan/whisper-server.exe');
    expect(deps.spawnServer.mock.calls[1][1]).toContain('5001');

    procs[1].log("couldn't bind to server socket: hostname=127.0.0.1 port=5001");
    procs[1].exit(1);
    await flush();
    expect(deps.spawnServer).toHaveBeenCalledTimes(2);
    expect(server.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(/bind/) });
  });

  it('restarts after crashes with 1s, 5s, 15s backoff, then errors', async () => {
    const ctx = setup();
    await startReady(ctx);

    for (const delay of [1000, 5000, 15000]) {
      const count = ctx.procs.length;
      ctx.procs[count - 1].exit(1);
      await flush();
      expect(ctx.server.getStatus().state).toBe('starting');
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(ctx.procs).toHaveLength(count);
      await jest.advanceTimersByTimeAsync(1);
      expect(ctx.procs).toHaveLength(count + 1);
      await jest.advanceTimersByTimeAsync(500);
      expect(ctx.server.getStatus().state).toBe('ready');
    }

    ctx.procs[ctx.procs.length - 1].exit(1);
    await flush();
    expect(ctx.server.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(/crashed repeatedly/) });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(ctx.procs).toHaveLength(4);
  });

  it('resets the crash counter after 5 minutes of stable running', async () => {
    const ctx = setup();
    await startReady(ctx);
    ctx.procs[0].exit(1);
    await flush();
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(500);
    expect(ctx.server.getStatus().state).toBe('ready');

    await jest.advanceTimersByTimeAsync(300_000);
    ctx.procs[1].exit(1);
    await flush();
    await jest.advanceTimersByTimeAsync(999);
    expect(ctx.procs).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(ctx.procs).toHaveLength(3);
  });

  it('errors and kills the process when not ready within 120 seconds', async () => {
    const { server, procs } = setup();
    await server.start(...MODEL, { forceCpu: false });
    await jest.advanceTimersByTimeAsync(120_000);
    expect(server.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(/120 seconds/) });
    expect(procs[0].killed).toBe(true);
  });

  it('stop kills the process, clears the pid, and ignores the late exit', async () => {
    const ctx = setup();
    await startReady(ctx);
    ctx.server.stop();
    expect(ctx.procs[0].killed).toBe(true);
    expect(ctx.deps.clearPid).toHaveBeenCalled();
    expect(ctx.server.getStatus().state).toBe('stopped');
    expect(ctx.server.getBaseUrl()).toBeNull();

    ctx.procs[0].exit(0);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(ctx.deps.spawnServer).toHaveBeenCalledTimes(1);
    expect(ctx.server.getStatus().state).toBe('stopped');
  });

  it('setNoModel kills the process and reports no-model', async () => {
    const ctx = setup();
    await startReady(ctx);
    ctx.server.setNoModel();
    expect(ctx.procs[0].killed).toBe(true);
    expect(ctx.server.getStatus()).toEqual({ state: 'no-model', modelId: null, backend: null, gpu: false, port: null });
  });

  it('restart relaunches the same model', async () => {
    const ctx = setup();
    await startReady(ctx);
    await ctx.server.restart();
    expect(ctx.procs[0].killed).toBe(true);
    expect(ctx.deps.spawnServer).toHaveBeenCalledTimes(2);
    expect(ctx.deps.spawnServer.mock.calls[1][1]).toContain('/models/ggml-tiny.en.bin');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/whisperServer.test.ts`
Expected: FAIL — `Cannot find module '../services/whisperServer'`.

- [ ] **Step 3: Write the implementation**

Create `src/services/whisperServer.ts`:

```ts
import { classifyServerLine, LineBuffer, restartDelay, ServerLineEvent } from './serverOutput';
import type { Backend } from './serverPaths';

export type ServerState = 'no-model' | 'starting' | 'ready' | 'error' | 'stopped';

export interface ServerStatus {
  state: ServerState;
  modelId: string | null;
  backend: Backend | null;
  gpu: boolean;
  port: number | null;
  message?: string;
}

interface DataSource {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

export interface ServerProcess {
  pid: number | undefined;
  stdout: DataSource;
  stderr: DataSource;
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
}

export interface WhisperServerDeps {
  resolveBinary(backend: Backend): string | null;
  spawnServer(binary: string, args: string[]): ServerProcess;
  findFreePort(): Promise<number>;
  checkHealth(port: number): Promise<boolean>;
  killStaleProcess(): Promise<void>;
  writePid(pid: number): void;
  clearPid(): void;
  writeLog(lines: string[]): void;
  getGpuFallback(): boolean;
  setGpuFallback(value: boolean): void;
  now(): number;
}

export const READY_TIMEOUT_MS = 120_000;
export const HEALTH_POLL_MS = 500;
export const STABLE_RESET_MS = 300_000;
export const INFERENCE_PATH = '/v1/audio/transcriptions';

export class WhisperServer {
  private status: ServerStatus = { state: 'no-model', modelId: null, backend: null, gpu: false, port: null };
  private readonly listeners = new Set<(s: ServerStatus) => void>();
  private readonly log = new LineBuffer(500);
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private proc: ServerProcess | null = null;
  // Incremented whenever a process is launched or abandoned; callbacks from older generations are ignored.
  private generation = 0;
  private events = new Set<ServerLineEvent>();
  private crashCount = 0;
  private modelId: string | null = null;
  private modelPath: string | null = null;
  private forceCpu = false;

  constructor(private readonly deps: WhisperServerDeps) {}

  getStatus(): ServerStatus {
    return { ...this.status };
  }

  getBaseUrl(): string | null {
    return this.status.state === 'ready' && this.status.port !== null ? `http://127.0.0.1:${this.status.port}` : null;
  }

  onStatus(listener: (s: ServerStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(modelId: string, modelPath: string, opts: { forceCpu: boolean }): Promise<void> {
    this.halt();
    this.modelId = modelId;
    this.modelPath = modelPath;
    this.forceCpu = opts.forceCpu;
    this.crashCount = 0;
    const generation = this.generation;
    await this.deps.killStaleProcess();
    if (generation !== this.generation) return;
    const backend: Backend = opts.forceCpu || this.deps.getGpuFallback() ? 'cpu' : 'vulkan';
    await this.launch(backend, false);
  }

  async restart(): Promise<void> {
    if (this.modelId && this.modelPath) {
      await this.start(this.modelId, this.modelPath, { forceCpu: this.forceCpu });
    }
  }

  stop(): void {
    this.halt();
    this.setStatus({ state: 'stopped', modelId: this.modelId, backend: null, gpu: false, port: null });
  }

  setNoModel(): void {
    this.halt();
    this.modelId = null;
    this.modelPath = null;
    this.setStatus({ state: 'no-model', modelId: null, backend: null, gpu: false, port: null });
  }

  private halt(): void {
    this.generation++;
    this.clearTimers();
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
      this.deps.clearPid();
    }
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private schedule(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private setStatus(next: ServerStatus): void {
    this.status = next;
    this.deps.writeLog(this.log.lines());
    const snapshot = this.getStatus();
    for (const l of this.listeners) l(snapshot);
  }

  private fail(message: string): void {
    this.setStatus({ ...this.status, state: 'error', port: null, gpu: false, message });
  }

  private async launch(backend: Backend, portRetried: boolean): Promise<void> {
    const generation = ++this.generation;
    const modelPath = this.modelPath;
    if (modelPath === null) return;
    const binary = this.deps.resolveBinary(backend);
    if (!binary) {
      if (backend === 'vulkan') return this.launch('cpu', portRetried);
      this.fail('Transcription server is not installed (whisper-server.exe is missing)');
      return;
    }
    const port = await this.deps.findFreePort();
    if (generation !== this.generation) return;

    this.events = new Set();
    this.setStatus({ state: 'starting', modelId: this.modelId, backend, gpu: false, port });
    const proc = this.deps.spawnServer(binary, [
      '-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '--inference-path', INFERENCE_PATH,
    ]);
    this.proc = proc;
    if (proc.pid !== undefined) this.deps.writePid(proc.pid);

    const onData = (chunk: Buffer | string) => {
      for (const line of this.log.push(String(chunk))) {
        const event = classifyServerLine(line);
        if (event && generation === this.generation) this.events.add(event);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.onExit((code) => this.handleExit(generation, backend, portRetried, code));
    this.pollHealth(generation, this.deps.now() + READY_TIMEOUT_MS);
  }

  private pollHealth(generation: number, deadline: number): void {
    this.schedule(() => {
      void this.checkHealthOnce(generation, deadline);
    }, HEALTH_POLL_MS);
  }

  private async checkHealthOnce(generation: number, deadline: number): Promise<void> {
    const port = this.status.port;
    if (generation !== this.generation || port === null) return;
    let healthy = false;
    try {
      healthy = await this.deps.checkHealth(port);
    } catch {
      healthy = false;
    }
    if (generation !== this.generation) return;

    if (healthy) {
      const gpu = this.status.backend === 'vulkan' && this.events.has('gpu-backend');
      this.setStatus({ ...this.status, state: 'ready', gpu, message: undefined });
      this.schedule(() => {
        if (generation === this.generation) this.crashCount = 0;
      }, STABLE_RESET_MS);
      return;
    }
    if (this.deps.now() >= deadline) {
      this.halt();
      this.fail('Transcription server did not become ready within 120 seconds');
      return;
    }
    this.pollHealth(generation, deadline);
  }

  private handleExit(generation: number, backend: Backend, portRetried: boolean, code: number | null): void {
    if (generation !== this.generation) return;
    this.proc = null;
    this.deps.clearPid();
    this.clearTimers();

    if (this.status.state !== 'ready') {
      if (this.events.has('model-load-failed')) {
        this.fail('Model failed to load — try re-downloading it');
      } else if (this.events.has('bind-failed')) {
        if (portRetried) this.fail('Transcription server could not bind to a local port');
        else void this.launch(backend, true);
      } else if (backend === 'vulkan') {
        this.deps.setGpuFallback(true);
        void this.launch('cpu', portRetried);
      } else {
        this.fail(`Transcription server exited during startup (exit code ${code})`);
      }
      return;
    }

    this.crashCount++;
    const delay = restartDelay(this.crashCount);
    if (delay === null) {
      this.fail(`Transcription server crashed repeatedly (exit code ${code})`);
      return;
    }
    this.setStatus({ ...this.status, state: 'starting', port: null, gpu: false, message: `Server crashed, restarting in ${delay / 1000}s` });
    this.schedule(() => {
      if (generation === this.generation) void this.launch(backend, false);
    }, delay);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/whisperServer.test.ts`
Expected: PASS (13 tests). If a fake-timer test is flaky because a promise hasn't settled, add one more `await flush()` after the triggering call rather than changing the implementation. Then `npm run build` and `npm run lint` → 0 errors.

- [ ] **Step 5: Checkpoint (no commit)**

Run: `git status --short`.

---

### Task 5: Settings fields, migration, recording gate, and API timeouts

**Files:**
- Create: `src/services/settingsMigration.ts`
- Create: `src/services/serverGate.ts`
- Modify: `src/services/settingsService.ts` (whole file)
- Modify: `src/services/apiService.ts:5-33` and `:150-155`
- Test: `src/__tests__/settingsMigration.test.ts`, `src/__tests__/serverGate.test.ts`, `src/__tests__/apiServiceConfig.test.ts`

**Interfaces:**
- Consumes: `ServerStatus`, `ServerState` (Task 4); `displayName` (Task 1).
- Produces:
  - `settingsMigration.ts`: `type ServerMode = 'builtin' | 'external'`; `initialServerMode(configFileExisted: boolean): ServerMode`
  - `settingsService.ts`: `interface Settings { shortcut: string; apiUrl: string; apiToken: string; autoMuteAudio: boolean; micDevice: string; serverMode: ServerMode; modelId: string | null; forceCpu: boolean; gpuFallbackVersion: string | null }`; `getSettings(): Settings`; `saveSettings(settings: Partial<Settings>): void` (existing names kept)
  - `serverGate.ts`: `type GateResult = { allow: true } | { allow: false; action: 'open-models' | 'notify'; message: string }`; `recordingGate(mode: ServerMode, status: ServerStatus): GateResult`; `interface ServerStatusView extends ServerStatus { mode: ServerMode; text: string }`; `toStatusView(mode: ServerMode, status: ServerStatus, apiUrl: string): ServerStatusView`
  - `apiService.ts`: `EXTERNAL_TIMEOUT_MS = 30_000`, `BUILTIN_TIMEOUT_MS = 300_000`; `setApiConfig(apiUrl: string, apiToken: string, options?: { language?: string; timeoutMs?: number }): void`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/settingsMigration.test.ts`:

```ts
import { initialServerMode } from '../services/settingsMigration';

describe('initialServerMode', () => {
  it('keeps existing installs on the external API', () => {
    expect(initialServerMode(true)).toBe('external');
  });

  it('defaults fresh installs to the built-in server', () => {
    expect(initialServerMode(false)).toBe('builtin');
  });
});
```

Create `src/__tests__/serverGate.test.ts`:

```ts
import { recordingGate, toStatusView } from '../services/serverGate';
import type { ServerStatus } from '../services/whisperServer';

const base: ServerStatus = { state: 'ready', modelId: 'ggml-large-v3-turbo-q5_0.bin', backend: 'vulkan', gpu: true, port: 5000 };

describe('recordingGate', () => {
  it('always allows external mode', () => {
    expect(recordingGate('external', { ...base, state: 'no-model' })).toEqual({ allow: true });
  });

  it.each([
    ['ready', undefined, { allow: true }],
    ['no-model', undefined, { allow: false, action: 'open-models', message: 'Choose a speech model to finish setup' }],
    ['starting', undefined, { allow: false, action: 'notify', message: 'Model is still loading' }],
    ['error', 'Model failed to load — try re-downloading it', { allow: false, action: 'notify', message: 'Model failed to load — try re-downloading it' }],
    ['stopped', undefined, { allow: false, action: 'notify', message: 'Transcription server is not running' }],
  ] as const)('built-in %s', (state, message, expected) => {
    expect(recordingGate('builtin', { ...base, state, message })).toEqual(expected);
  });
});

describe('toStatusView', () => {
  it.each([
    ['external', base, 'External API — http://127.0.0.1:4444'],
    ['builtin', { ...base, state: 'no-model' }, 'No model installed'],
    ['builtin', { ...base, state: 'starting' }, 'Loading model…'],
    ['builtin', { ...base, state: 'starting', message: 'Server crashed, restarting in 5s' }, 'Server crashed, restarting in 5s'],
    ['builtin', base, 'Ready — large-v3-turbo-q5_0 (GPU)'],
    ['builtin', { ...base, gpu: false }, 'Ready — large-v3-turbo-q5_0 (CPU)'],
    ['builtin', { ...base, state: 'error', message: 'boom' }, 'Server error: boom'],
    ['builtin', { ...base, state: 'stopped' }, 'Server stopped'],
  ] as const)('%s %o', (mode, status, text) => {
    expect(toStatusView(mode, status as ServerStatus, 'http://127.0.0.1:4444')).toEqual({ ...status, mode, text });
  });
});
```

Create `src/__tests__/apiServiceConfig.test.ts`:

```ts
jest.mock('axios', () => {
  const create = jest.fn(() => ({ get: jest.fn(), post: jest.fn() }));
  return { __esModule: true, default: { create }, create };
});

import axios from 'axios';
import { setApiConfig, BUILTIN_TIMEOUT_MS, EXTERNAL_TIMEOUT_MS } from '../services/apiService';

const create = axios.create as unknown as jest.Mock;
const lastConfig = () => create.mock.calls[create.mock.calls.length - 1][0];

describe('apiService configuration', () => {
  it('uses the external defaults on load', () => {
    expect(create).toHaveBeenCalledTimes(1);
    expect(lastConfig()).toMatchObject({ baseURL: 'http://127.0.0.1:4444', timeout: EXTERNAL_TIMEOUT_MS });
  });

  it('applies the built-in server url and 5 minute timeout without auth', () => {
    setApiConfig('http://127.0.0.1:5000', '', { timeoutMs: BUILTIN_TIMEOUT_MS });
    expect(BUILTIN_TIMEOUT_MS).toBe(300_000);
    expect(lastConfig()).toMatchObject({ baseURL: 'http://127.0.0.1:5000', timeout: 300_000 });
    expect(lastConfig().headers.Authorization).toBeUndefined();
  });

  it('keeps bearer auth and the 30 second timeout for external APIs', () => {
    setApiConfig('https://api.example.com', 'sk-test');
    expect(lastConfig()).toMatchObject({ baseURL: 'https://api.example.com', timeout: 30_000, headers: { Authorization: 'Bearer sk-test' } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/__tests__/settingsMigration.test.ts src/__tests__/serverGate.test.ts src/__tests__/apiServiceConfig.test.ts`
Expected: FAIL — missing modules, and `BUILTIN_TIMEOUT_MS` undefined.

- [ ] **Step 3: Implement `settingsMigration.ts` and `serverGate.ts`**

Create `src/services/settingsMigration.ts`:

```ts
export type ServerMode = 'builtin' | 'external';

export function initialServerMode(configFileExisted: boolean): ServerMode {
  return configFileExisted ? 'external' : 'builtin';
}
```

Create `src/services/serverGate.ts`:

```ts
import { displayName } from './modelCatalog';
import type { ServerMode } from './settingsMigration';
import type { ServerStatus } from './whisperServer';

export type GateResult = { allow: true } | { allow: false; action: 'open-models' | 'notify'; message: string };

export interface ServerStatusView extends ServerStatus {
  mode: ServerMode;
  text: string;
}

export function recordingGate(mode: ServerMode, status: ServerStatus): GateResult {
  if (mode === 'external') return { allow: true };
  switch (status.state) {
    case 'ready':
      return { allow: true };
    case 'no-model':
      return { allow: false, action: 'open-models', message: 'Choose a speech model to finish setup' };
    case 'starting':
      return { allow: false, action: 'notify', message: 'Model is still loading' };
    case 'error':
      return { allow: false, action: 'notify', message: status.message ?? 'Transcription server error' };
    case 'stopped':
      return { allow: false, action: 'notify', message: 'Transcription server is not running' };
  }
}

function statusText(mode: ServerMode, status: ServerStatus, apiUrl: string): string {
  if (mode === 'external') return `External API — ${apiUrl}`;
  switch (status.state) {
    case 'no-model':
      return 'No model installed';
    case 'starting':
      return status.message ?? 'Loading model…';
    case 'ready':
      return `Ready — ${status.modelId ? displayName(status.modelId) : 'unknown model'} (${status.gpu ? 'GPU' : 'CPU'})`;
    case 'error':
      return `Server error: ${status.message ?? 'unknown error'}`;
    case 'stopped':
      return 'Server stopped';
  }
}

export function toStatusView(mode: ServerMode, status: ServerStatus, apiUrl: string): ServerStatusView {
  return { ...status, mode, text: statusText(mode, status, apiUrl) };
}
```

- [ ] **Step 4: Update `apiService.ts`**

In `src/services/apiService.ts`, replace lines 5–33 (class fields through `setConfig`) with:

```ts
export const EXTERNAL_TIMEOUT_MS = 30_000;
export const BUILTIN_TIMEOUT_MS = 300_000;

class WhisperAPI {
  private client!: AxiosInstance;
  private apiUrl: string = 'http://127.0.0.1:4444';
  private apiToken: string = '';
  private language: string = 'en';
  private timeoutMs: number = EXTERNAL_TIMEOUT_MS;

  constructor() {
    this.updateClient();
  }

  private updateClient() {
    const headers: any = { 'User-Agent': 'whisper-desktop' };
    if (this.apiToken) {
      headers['Authorization'] = `Bearer ${this.apiToken}`;
    }

    this.client = axios.create({
      baseURL: this.apiUrl,
      timeout: this.timeoutMs,
      headers,
    });
  }

  setConfig(apiUrl: string, apiToken: string, language: string = 'en', timeoutMs: number = EXTERNAL_TIMEOUT_MS) {
    this.apiUrl = apiUrl;
    this.apiToken = apiToken;
    this.language = language;
    this.timeoutMs = timeoutMs;
    this.updateClient();
  }
```

The `client` field no longer calls `axios.create()` in its initializer, so `updateClient()` is the only call on load (the test expects exactly one).

Replace the exported `setApiConfig` at the bottom with:

```ts
/**
 * Configure API endpoint, token, language, and request timeout
 */
export function setApiConfig(apiUrl: string, apiToken: string, options: { language?: string; timeoutMs?: number } = {}): void {
  whisperAPI.setConfig(apiUrl, apiToken, options.language ?? 'en', options.timeoutMs ?? EXTERNAL_TIMEOUT_MS);
}
```

- [ ] **Step 5: Replace `settingsService.ts`**

Replace the entire contents of `src/services/settingsService.ts` with:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import Store from 'electron-store';
import { initialServerMode, ServerMode } from './settingsMigration';

export interface Settings {
  shortcut: string;
  apiUrl: string;
  apiToken: string;
  autoMuteAudio: boolean;
  micDevice: string;
  serverMode: ServerMode;
  modelId: string | null;
  forceCpu: boolean;
  gpuFallbackVersion: string | null;
}

// Must be checked before the store is created, because creating it writes the defaults to disk.
const configFileExisted = fs.existsSync(path.join(app.getPath('userData'), 'config.json'));

const store = new Store({
  name: 'config',
  defaults: {
    shortcut: 'Ctrl+Q',
    apiUrl: 'http://127.0.0.1:4444',
    apiToken: '',
    autoMuteAudio: true,
    micDevice: 'default',
    modelId: null,
    forceCpu: false,
    gpuFallbackVersion: null,
  },
}) as unknown as Store<Settings>;

const storeAny = store as any;

if (!storeAny.has('serverMode')) {
  storeAny.set('serverMode', initialServerMode(configFileExisted));
}

export function getSettings(): Settings {
  return {
    shortcut: storeAny.get('shortcut', 'Ctrl+Q'),
    apiUrl: storeAny.get('apiUrl', 'http://127.0.0.1:4444'),
    apiToken: storeAny.get('apiToken', ''),
    autoMuteAudio: storeAny.get('autoMuteAudio', true),
    micDevice: storeAny.get('micDevice', 'default'),
    serverMode: storeAny.get('serverMode', 'builtin'),
    modelId: storeAny.get('modelId', null),
    forceCpu: storeAny.get('forceCpu', false),
    gpuFallbackVersion: storeAny.get('gpuFallbackVersion', null),
  };
}

export function saveSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  storeAny.set(key, value);
}

export function saveSettings(settings: Partial<Settings>): void {
  Object.entries(settings).forEach(([key, value]) => {
    if (value !== undefined) {
      storeAny.set(key, value);
    }
  });
}
```

`serverMode` is deliberately **not** in `defaults`: defaults are written on store creation, which would make `has('serverMode')` always true and defeat the migration.

- [ ] **Step 6: Run tests and build**

Run: `npx jest src/__tests__/settingsMigration.test.ts src/__tests__/serverGate.test.ts src/__tests__/apiServiceConfig.test.ts`
Expected: PASS.
Run: `npm run build && npm test && npm run lint`
Expected: build succeeds (`main.ts` still calls `setApiConfig(a, b)`, which remains valid), all tests pass, 0 lint errors.

- [ ] **Step 7: Checkpoint (no commit)**

Run: `git status --short`.

---

### Task 6: Packaging config and dev fetch script

**Files:**
- Create: `whisper.version`
- Create: `scripts/fetch-whisper.js`
- Modify: `electron-builder.yml` (whole file)
- Modify: `package.json` (remove `"build"` block, add script)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `resources/whisper/cpu/whisper-server.exe` (+ DLLs) and `resources/whisper/VERSION` locally; packaged app contains `resources/whisper/{cpu,vulkan}/` and `resources/whisper/VERSION` (read by Task 7's `bundledWhisperVersion()`).

This task has no unit tests; it is verified by running the real server and a packaging dry run.

- [ ] **Step 1: Pin the whisper.cpp version**

Create `whisper.version` containing exactly (no trailing newline required):

```
b5130
```

- [ ] **Step 2: Write the fetch script**

Create `scripts/fetch-whisper.js`:

```js
// Downloads the official whisper.cpp CPU build for local development into resources/whisper/cpu.
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ZIP_SHA256 = {
  b5130: 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c',
};

const root = path.join(__dirname, '..');
const tag = fs.readFileSync(path.join(root, 'whisper.version'), 'utf8').trim();
const whisperDir = path.join(root, 'resources', 'whisper');
const outDir = path.join(whisperDir, 'cpu');
const url = `https://github.com/ggml-org/whisper.cpp/releases/download/${tag}/whisper-bin-x64.zip`;

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('whisper:fetch downloads Windows binaries and must run on Windows');
  }
  const expected = ZIP_SHA256[tag];
  if (!expected) {
    throw new Error(`No SHA256 recorded for whisper.cpp ${tag}; add it to ZIP_SHA256 in scripts/fetch-whisper.js`);
  }

  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  const zip = Buffer.from(await res.arrayBuffer());
  const actual = crypto.createHash('sha256').update(zip).digest('hex');
  if (actual !== expected) throw new Error(`Checksum mismatch for ${url}: expected ${expected}, got ${actual}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-fetch-'));
  try {
    const zipPath = path.join(tmp, 'whisper-bin-x64.zip');
    fs.writeFileSync(zipPath, zip);
    // Windows' bundled bsdtar extracts zip files; Git Bash's GNU tar does not.
    const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tarExe, ['-xf', zipPath, '-C', tmp]);

    const releaseDir = path.join(tmp, 'Release');
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    for (const file of fs.readdirSync(releaseDir)) {
      if (file === 'whisper-server.exe' || file.toLowerCase().endsWith('.dll')) {
        fs.copyFileSync(path.join(releaseDir, file), path.join(outDir, file));
      }
    }
    fs.writeFileSync(path.join(whisperDir, 'VERSION'), tag);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`Installed whisper.cpp ${tag} CPU server to ${path.relative(root, outDir)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
```

- [ ] **Step 3: Make `electron-builder.yml` the single packaging config**

`package.json` currently duplicates the packaging config in `"build"`, with different `files` exclusions and `publish` fields than the YAML. Merge both into the YAML. Replace the whole of `electron-builder.yml` with:

```yaml
appId: com.whisperdesktop.app
productName: Whisper Desktop

directories:
  buildResources: assets
  output: release

files:
  - dist/**/*
  - "!dist/__tests__"
  - "!dist/**/*.test.*"
  - "!dist/**/*.map"
  - assets/**/*
  - public/**/*
  - package.json

extraResources:
  - from: resources/whisper
    to: whisper
    filter:
      - "**/*"

asar: true

asarUnpack:
  - node_modules/node-mic/**/*

win:
  target:
    - target: nsis
      arch:
        - x64

nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
  installerIcon: assets/whisper.ico
  uninstallerIcon: assets/whisper.ico
  installerHeaderIcon: assets/whisper.ico
  runAfterFinish: true
  artifactName: ${productName}.${ext}

extraMetadata:
  main: dist/main.js

publish:
  provider: github
  owner: dniasoff
  repo: whisper-desktop
  releaseType: release
```

- [ ] **Step 4: Update `package.json` and `.gitignore`**

In `package.json`:
- Delete the entire `"build": { ... }` object (it starts at `"build": {` after `"homepage"` and ends just before `"devDependencies"`), including its trailing comma.
- In `"scripts"`, add after `"test:coverage"`:

```json
    "whisper:fetch": "node scripts/fetch-whisper.js",
```

Append to `.gitignore`:

```
resources/whisper/
```

Validate the JSON: `node -e "require('./package.json')"` → no output.

- [ ] **Step 5: Fetch and smoke-test the real server**

Run (Git Bash, Windows):

```bash
npm run whisper:fetch
ls resources/whisper/cpu | head -20 && cat resources/whisper/VERSION
curl -sL -o "$TEMP/ggml-tiny.en.bin" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin
curl -sL -o "$TEMP/jfk.wav" https://raw.githubusercontent.com/ggml-org/whisper.cpp/b5130/samples/jfk.wav
(resources/whisper/cpu/whisper-server.exe -m "$TEMP/ggml-tiny.en.bin" --host 127.0.0.1 --port 18080 --inference-path /v1/audio/transcriptions > "$TEMP/ws.log" 2>&1 &)
for i in $(seq 1 60); do curl -sf http://127.0.0.1:18080/health && break; sleep 1; done
curl -s -F file=@"$TEMP/jfk.wav" -F response_format=json http://127.0.0.1:18080/v1/audio/transcriptions
grep -E "whisper_backend_init_gpu|listening" "$TEMP/ws.log"
taskkill //IM whisper-server.exe //F
```

Expected:
- `resources/whisper/cpu` lists `whisper-server.exe`, `whisper.dll`, `ggml.dll`, `ggml-base.dll`, `ggml-cpu-*.dll`; `VERSION` prints `b5130`.
- Health prints `{"status":"ok"}`; transcription JSON contains `ask not what your country can do for you`.
- The log contains `whisper_backend_init_gpu: no GPU found` (confirms the Task 3 classifier strings against the real binary). If the wording differs, update `classifyServerLine` and its test to match before continuing.

- [ ] **Step 6: Packaging dry run**

Run:

```bash
npm run ensure-mac-perms && npm run build && npx electron-builder --win --dir
ls "release/win-unpacked/resources/whisper/cpu/whisper-server.exe" && cat "release/win-unpacked/resources/whisper/VERSION"
ls release/win-unpacked/resources/app.asar
```

Expected: all three paths exist; `VERSION` prints `b5130`; electron-builder prints no warning about conflicting `package.json` and `electron-builder.yml` config.

- [ ] **Step 7: Checkpoint (no commit)**

Run: `git status --short` — expect `whisper.version`, `scripts/fetch-whisper.js`, `electron-builder.yml`, `package.json`, `.gitignore`; `resources/` and `release/` must **not** appear.

---

### Task 7: Runtime wiring, main process lifecycle, and IPC

**Files:**
- Create: `src/services/whisperRuntime.ts`
- Modify: `src/main.ts` (imports; helpers after `showSystemNotification`; tray menu; `ready`; `before-quit`; `startRecordingSession` health check; `handleRecordingToggle`; `start-recording`; `save-settings`; new handlers at end)
- Modify: `src/preload.ts`

**Interfaces:**
- Consumes: `ModelManager`, `axiosFetcher`, `statfsFreeSpace`, `DownloadProgress` (Task 2); `parseTasklistImage`, `isWhisperServerImage`, `resolveServerBinary`, `whisperResourceDir`, `BinaryLocations` (Task 3); `WhisperServer`, `ServerProcess` (Task 4); `getSettings`, `saveSettings`, `recordingGate`, `toStatusView`, `ServerStatusView`, `setApiConfig`, `BUILTIN_TIMEOUT_MS`, `EXTERNAL_TIMEOUT_MS` (Task 5); `resources/whisper/VERSION` (Task 6).
- Produces (`whisperRuntime.ts`): `whisperServer: WhisperServer`, `modelManager: ModelManager`, `startBuiltinServer(): Promise<void>`, `openServerLog(): Promise<string>`, `bundledWhisperVersion(): string`.
- Produces (IPC, used by Task 8): invoke channels `get-server-status` → `ServerStatusView`; `restart-server`; `open-server-log`; `list-models` → `{ models: ModelEntry[]; activeModelId: string | null; downloading: boolean; disk: { usedBytes: number; freeBytes: number } }`; `download-model(id)`; `download-custom-model(url)`; `cancel-download`; `delete-model(id)`; `select-model(id)`. Events: `server-status` (`ServerStatusView`), `download-progress` (`DownloadProgress`; pre-flight failures arrive as `state: 'error'` with `id` = requested id, or `'custom'` for custom URLs), `open-models`.
- Preload bridge (on `window.api`): `getServerStatus(): Promise<ServerStatusView>`, `restartServer(): Promise<void>`, `openServerLog(): Promise<void>`, `listModels(): Promise<ModelList>`, `downloadModel(id: string): Promise<void>`, `downloadCustomModel(url: string): Promise<void>`, `cancelDownload(): Promise<void>`, `deleteModel(id: string): Promise<void>`, `selectModel(id: string): Promise<void>`, `onServerStatus(cb)`, `onDownloadProgress(cb)`, `onOpenModels(cb)`.

This wiring is Electron-bound and not unit-testable under Jest (see Global Constraints); all decision logic it calls is already tested. It is verified by build, lint, the existing suite, and a real app launch.

- [ ] **Step 1: Create `whisperRuntime.ts`**

Create `src/services/whisperRuntime.ts`:

```ts
import { app, shell } from 'electron';
import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { promisify } from 'util';
import { ModelManager, axiosFetcher, statfsFreeSpace } from './modelManager';
import { isWhisperServerImage, parseTasklistImage } from './serverOutput';
import { BinaryLocations, resolveServerBinary, whisperResourceDir } from './serverPaths';
import { getSettings, saveSettings } from './settingsService';
import { ServerProcess, WhisperServer } from './whisperServer';

const execFileAsync = promisify(execFile);
const userData = app.getPath('userData');
const pidFile = path.join(userData, 'whisper-server.pid');
const logFile = path.join(userData, 'logs', 'whisper-server.log');

function locations(): BinaryLocations {
  return {
    envDir: process.env.WHISPER_SERVER_DIR,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
  };
}

export function bundledWhisperVersion(): string {
  try {
    return fs.readFileSync(path.join(whisperResourceDir(locations()), 'VERSION'), 'utf8').trim();
  } catch {
    return 'unknown';
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function checkHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

function spawnServer(binary: string, args: string[]): ServerProcess {
  const child = spawn(binary, args, { cwd: path.dirname(binary), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
      // A spawn failure (e.g. missing DLL/binary) may emit 'error' without 'exit'.
      child.on('error', (error) => {
        console.error('whisper-server process error:', error);
        report(null);
      });
    },
    kill: () => {
      child.kill();
    },
  };
}

async function killStaleProcess(): Promise<void> {
  let pid: number;
  try {
    pid = Number.parseInt(await fs.promises.readFile(pidFile, 'utf8'), 10);
  } catch {
    return;
  }
  try {
    if (process.platform === 'win32' && Number.isInteger(pid) && pid > 0) {
      const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true });
      if (isWhisperServerImage(parseTasklistImage(stdout))) {
        await execFileAsync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
      }
    }
  } catch (error) {
    console.error('Failed to clean up a stale whisper-server process:', error);
  } finally {
    await fs.promises.rm(pidFile, { force: true });
  }
}

export const whisperServer = new WhisperServer({
  resolveBinary: (backend) => resolveServerBinary(backend, locations(), fs.existsSync),
  spawnServer,
  findFreePort,
  checkHealth,
  killStaleProcess,
  writePid: (pid) => fs.writeFileSync(pidFile, String(pid)),
  clearPid: () => fs.rmSync(pidFile, { force: true }),
  writeLog: (lines) => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, `${lines.join('\n')}\n`);
  },
  getGpuFallback: () => getSettings().gpuFallbackVersion === bundledWhisperVersion(),
  setGpuFallback: (value) => saveSettings({ gpuFallbackVersion: value ? bundledWhisperVersion() : null }),
  now: Date.now,
});

export const modelManager = new ModelManager({
  modelsDir: path.join(userData, 'models'),
  fetcher: axiosFetcher,
  freeSpace: statfsFreeSpace,
});

export async function startBuiltinServer(): Promise<void> {
  const settings = getSettings();
  if (settings.serverMode !== 'builtin') {
    whisperServer.stop();
    return;
  }
  const modelPath = settings.modelId ? modelManager.getModelPath(settings.modelId) : null;
  if (!settings.modelId || !modelPath) {
    whisperServer.setNoModel();
    return;
  }
  await whisperServer.start(settings.modelId, modelPath, { forceCpu: settings.forceCpu });
}

export function openServerLog(): Promise<string> {
  return shell.openPath(logFile);
}
```

- [ ] **Step 2: Update imports in `src/main.ts`**

Replace the import lines 5–9:

```ts
import { recordAudio, stopRecording, cleanupOldRecordings, getAudioDevices } from './services/recordingService';
import { transcribeAudio, checkAPIHealth, setApiConfig } from './services/apiService';
import { getSettings, saveSettings } from './services/settingsService';
import { pasteTranscriptClipboard, copyToClipboard } from './services/pasteService';
import { saveAndMuteAudio, restoreAudio } from './services/audioControlService';
```

with:

```ts
import { recordAudio, stopRecording, cleanupOldRecordings, getAudioDevices } from './services/recordingService';
import { transcribeAudio, checkAPIHealth, setApiConfig, BUILTIN_TIMEOUT_MS, EXTERNAL_TIMEOUT_MS } from './services/apiService';
import { getSettings, saveSettings } from './services/settingsService';
import { pasteTranscriptClipboard, copyToClipboard } from './services/pasteService';
import { saveAndMuteAudio, restoreAudio } from './services/audioControlService';
import { modelManager, openServerLog, startBuiltinServer, whisperServer } from './services/whisperRuntime';
import { recordingGate, toStatusView } from './services/serverGate';
import type { DownloadProgress } from './services/modelManager';
```

- [ ] **Step 3: Add helpers after `showSystemNotification` in `src/main.ts`**

Insert immediately after the closing `};` of `showSystemNotification` (before `const createTray`):

```ts
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

const handleServerStatus = () => {
  applyApiConfig();
  const view = currentStatusView();
  mainWindow?.webContents.send('server-status', view);
  tray?.setToolTip(`Whisper Desktop — ${view.text}`);
};

const canStartRecording = (): boolean => {
  const gate = recordingGate(getSettings().serverMode, whisperServer.getStatus());
  if (gate.allow) return true;
  if (gate.action === 'open-models') showModelsWindow();
  showSystemNotification('Whisper Desktop', gate.message, 4000);
  return false;
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
```

- [ ] **Step 4: Tray menu, startup, and quit in `src/main.ts`**

In `createTray`, insert after the `Show/Hide` menu item object (after its closing `},`):

```ts
    {
      label: 'Models…',
      click: showModelsWindow,
    },
```

In the `app.on('ready', ...)` handler, delete the line `setApiConfig(settings.apiUrl, settings.apiToken);` and add after `registerShortcuts(handleRecordingToggle, settings.shortcut);`:

```ts
  whisperServer.onStatus(handleServerStatus);
  modelManager.onProgress((progress) => mainWindow?.webContents.send('download-progress', progress));
  handleServerStatus();

  (async () => {
    await modelManager.init();
    await startBuiltinServer();
    if (getSettings().serverMode === 'builtin' && whisperServer.getStatus().state === 'no-model') {
      const notification = showSystemNotification('Whisper Desktop', 'Choose a speech model to finish setup', 8000);
      notification.on('click', showModelsWindow);
    }
  })().catch((error) => console.error('Failed to start transcription server:', error));
```

Replace the `before-quit` handler with:

```ts
app.on('before-quit', () => {
  if (mainWindow) {
    mainWindow.removeAllListeners('close');
  }
  modelManager.cancelDownload();
  whisperServer.stop();
});
```

(The original block only contained the `removeAllListeners('close')` call, which is kept.)

- [ ] **Step 5: Gate recording in `src/main.ts`**

In `startRecordingSession`, replace:

```ts
    const isAPIHealthy = await checkAPIHealth();
    if (!isAPIHealthy) {
      const errorMsg = 'Whisper API is not running at http://127.0.0.1:4444. Please start the API before recording.';
      mainWindow?.webContents.send('error', { message: errorMsg });
      isRecording = false;
      return;
    }
```

with:

```ts
    if (settings.serverMode === 'external') {
      const isAPIHealthy = await checkAPIHealth();
      if (!isAPIHealthy) {
        const errorMsg = `Whisper API is not running at ${settings.apiUrl}. Please start the API before recording.`;
        mainWindow?.webContents.send('error', { message: errorMsg });
        isRecording = false;
        return;
      }
    }
```

Replace `handleRecordingToggle` with:

```ts
const handleRecordingToggle = async () => {
  if (isRecording) {
    await stopRecording();
  } else if (canStartRecording()) {
    isRecording = true;
    void startRecordingSession();
  }
};
```

In the `start-recording` handler, insert after the `if (isRecording) { ... return; }` block:

```ts
  if (!canStartRecording()) {
    return;
  }
```

- [ ] **Step 6: Settings save and new IPC handlers in `src/main.ts`**

Replace the `save-settings` handler with:

```ts
ipcMain.handle('save-settings', async (_event, settings: any) => {
  const before = getSettings();
  saveSettings(settings);
  const after = getSettings();

  if (before.forceCpu && !after.forceCpu) {
    saveSettings({ gpuFallbackVersion: null });
  }
  if (before.serverMode !== after.serverMode || before.forceCpu !== after.forceCpu) {
    await startBuiltinServer();
  }
  handleServerStatus();

  if (settings.shortcut) {
    currentShortcut = settings.shortcut;
    // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
    const { globalShortcut } = require('electron');
    globalShortcut.unregisterAll();
    registerShortcuts(handleRecordingToggle, settings.shortcut);
  }

  return { success: true };
});
```

Append at the end of `src/main.ts`:

```ts
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
```

- [ ] **Step 7: Extend `src/preload.ts`**

Add at the top, after the `electron` import (type-only imports are erased, so the sandboxed preload still only requires `electron`):

```ts
import type { DownloadProgress, ModelEntry } from './services/modelManager';
import type { ServerStatusView } from './services/serverGate';

interface ModelList {
  models: ModelEntry[];
  activeModelId: string | null;
  downloading: boolean;
  disk: { usedBytes: number; freeBytes: number };
}
```

Inside the object passed to `contextBridge.exposeInMainWorld('api', { ... })`, add after `getAudioDevices`:

```ts
  getServerStatus: (): Promise<ServerStatusView> => ipcRenderer.invoke('get-server-status'),
  restartServer: (): Promise<void> => ipcRenderer.invoke('restart-server'),
  openServerLog: (): Promise<void> => ipcRenderer.invoke('open-server-log'),
  listModels: (): Promise<ModelList> => ipcRenderer.invoke('list-models'),
  downloadModel: (id: string): Promise<void> => ipcRenderer.invoke('download-model', id),
  downloadCustomModel: (url: string): Promise<void> => ipcRenderer.invoke('download-custom-model', url),
  cancelDownload: (): Promise<void> => ipcRenderer.invoke('cancel-download'),
  deleteModel: (id: string): Promise<void> => ipcRenderer.invoke('delete-model', id),
  selectModel: (id: string): Promise<void> => ipcRenderer.invoke('select-model', id),
  onServerStatus: (callback: (status: ServerStatusView) => void) => {
    ipcRenderer.on('server-status', (_event, status: ServerStatusView) => callback(status));
  },
  onDownloadProgress: (callback: (progress: DownloadProgress) => void) => {
    ipcRenderer.on('download-progress', (_event, progress: DownloadProgress) => callback(progress));
  },
  onOpenModels: (callback: () => void) => {
    ipcRenderer.on('open-models', () => callback());
  },
```

Inside `declare global { interface Window { api: { ... } } }`, add after `getAudioDevices`:

```ts
      getServerStatus: () => Promise<ServerStatusView>;
      restartServer: () => Promise<void>;
      openServerLog: () => Promise<void>;
      listModels: () => Promise<ModelList>;
      downloadModel: (id: string) => Promise<void>;
      downloadCustomModel: (url: string) => Promise<void>;
      cancelDownload: () => Promise<void>;
      deleteModel: (id: string) => Promise<void>;
      selectModel: (id: string) => Promise<void>;
      onServerStatus: (callback: (status: ServerStatusView) => void) => void;
      onDownloadProgress: (callback: (progress: DownloadProgress) => void) => void;
      onOpenModels: (callback: () => void) => void;
```

- [ ] **Step 8: Build, test, lint, and confirm preload stays dependency-free**

Run: `npm run build && npm test && npm run lint`
Expected: success; 0 lint errors.

Run: `grep -n "require(" dist/preload.js`
Expected: only `require("electron")`. If any `./services/...` require appears, a type import was written without `import type`; fix it.

- [ ] **Step 9: Launch the app**

Run (Git Bash):

```bash
ELECTRON_ENABLE_LOGGING=1 timeout 25 node_modules/electron/dist/electron.exe . > "$TEMP/app-run.log" 2>&1; echo "exit: $?"
grep -iE "error|exception" "$TEMP/app-run.log" | grep -viE "gpu|dxgi|angle|Security Warning|Network service crashed|Renderer process crashed" 
grep -o '"serverMode":"[a-z]*"' "$APPDATA/whisper-desktop/config.json"
ls "$APPDATA/whisper-desktop/models"
```

Expected:
- `exit: 124` (killed by timeout; renderer/GPU "crash" lines at the timeout moment are the kill, not a bug).
- No main-process errors (in particular no `electron-store` or `whisperRuntime` load errors).
- `serverMode` is `external` on a machine with an existing v1.0.x `config.json`, or `builtin` on a fresh profile.
- `models` directory exists (contains `custom/`).
- Run `tasklist | grep -i whisper-server` → nothing left running.

- [ ] **Step 10: Checkpoint (no commit)**

Run: `git status --short`.

---

### Task 8: Renderer UI — status line, settings toggle, Models modal

**Files:**
- Modify: `public/index.html` (CSS before `</style>`; header buttons at line 337; status block after line 338; settings API fields at lines 371–379; Models modal after line 403; script additions and edits)

**Interfaces:**
- Consumes (Task 7 preload): `window.api.getServerStatus`, `restartServer`, `openServerLog`, `listModels`, `downloadModel`, `downloadCustomModel`, `cancelDownload`, `deleteModel`, `selectModel`, `onServerStatus`, `onDownloadProgress`, `onOpenModels`; existing `getSettings`/`saveSettings` now carry `serverMode` and `forceCpu`.
- Produces: user-facing UI only.

All dynamic text (model names from custom URLs, error messages) must be set with `textContent`, never `innerHTML`.

- [ ] **Step 1: Add CSS**

Insert immediately before `</style>`:

```css
    [hidden] {
      display: none !important;
    }

    .server-status {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: #555;
      margin-bottom: 10px;
      flex-wrap: wrap;
    }

    .server-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #9e9e9e;
      flex-shrink: 0;
    }

    .server-dot.starting { background: #ffb300; }
    .server-dot.ready { background: #4caf50; }
    .server-dot.error { background: #f44336; }
    .server-dot.external { background: #2196f3; }

    .link-btn {
      background: none;
      border: none;
      color: #667eea;
      padding: 0;
      min-width: auto;
      font-size: 13px;
      font-weight: 600;
      text-decoration: underline;
    }

    .setup-banner {
      background: #fff8e1;
      border: 1px solid #ffe082;
      border-radius: 8px;
      padding: 12px;
      font-size: 13px;
      margin-bottom: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: center;
    }

    .models-content {
      max-width: 580px;
    }

    .model-list {
      max-height: 320px;
      overflow-y: auto;
      border: 1px solid #eee;
      border-radius: 8px;
      margin: 12px 0;
      text-align: left;
    }

    .model-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-bottom: 1px solid #f0f0f0;
      font-size: 13px;
    }

    .model-row:last-child { border-bottom: none; }
    .model-info { flex: 1; min-width: 0; }
    .model-name { font-weight: 600; color: #333; overflow-wrap: anywhere; }
    .model-meta { color: #777; font-size: 12px; }
    .model-error { color: #b71c1c; font-size: 12px; }
    .model-actions { display: flex; gap: 6px; align-items: center; }
    .model-actions button, .inline-btn { min-width: auto; padding: 6px 10px; font-size: 12px; }
    .badge-active { color: #2e7d32; font-weight: 600; font-size: 12px; }
    .progress { width: 90px; height: 6px; background: #eee; border-radius: 3px; overflow: hidden; }
    .progress-bar { height: 100%; background: #667eea; width: 0; }

    .radio-label {
      display: inline-flex !important;
      align-items: center;
      gap: 6px;
      margin-right: 16px;
      font-weight: normal !important;
      cursor: pointer;
    }
```

- [ ] **Step 2: Header buttons and status block**

Replace line 337:

```html
      <button id="settingsBtn" style="padding: 8px 16px; border: none; border-radius: 6px; background: #f0f0f0; cursor: pointer; font-size: 18px;">⚙️</button>
```

with:

```html
      <div style="display: flex; gap: 8px;">
        <button id="modelsBtn" title="Speech models" style="padding: 8px 16px; min-width: auto; border: none; border-radius: 6px; background: #f0f0f0; cursor: pointer; font-size: 18px;">🧠</button>
        <button id="settingsBtn" title="Settings" style="padding: 8px 16px; min-width: auto; border: none; border-radius: 6px; background: #f0f0f0; cursor: pointer; font-size: 18px;">⚙️</button>
      </div>
```

Insert directly after the header's closing `</div>` (currently line 338), before `<div class="status">`:

```html
    <div class="server-status">
      <span class="server-dot" id="serverDot"></span>
      <span id="serverStatusText">Checking transcription server…</span>
      <button class="link-btn" id="serverRestartBtn" hidden>Restart</button>
      <button class="link-btn" id="serverLogBtn" hidden>Open log</button>
    </div>

    <div class="setup-banner" id="setupBanner" hidden>
      <span>No speech model installed yet.</span>
      <button class="modal-btn modal-btn-save" id="setupDownloadBtn">Download recommended model (547 MB)</button>
    </div>
```

- [ ] **Step 3: Settings modal server mode**

Replace lines 371–379 (the "API Endpoint" and "API Token" `form-group` divs) with:

```html
      <div class="form-group">
        <label>Transcription server</label>
        <label class="radio-label"><input type="radio" name="serverMode" id="serverModeBuiltin" value="builtin" style="width: auto;"> Built-in</label>
        <label class="radio-label"><input type="radio" name="serverMode" id="serverModeExternal" value="external" style="width: auto;"> External API</label>
      </div>

      <div class="form-group" id="builtinOptions">
        <label style="display: flex; align-items: center; cursor: pointer; user-select: none; font-weight: normal;">
          <input type="checkbox" id="forceCpuInput" style="width: auto; margin-right: 10px; cursor: pointer;">
          <span>Force CPU (use if GPU transcription fails)</span>
        </label>
      </div>

      <div id="externalOptions">
        <div class="form-group">
          <label for="apiUrlInput">API Endpoint</label>
          <input type="text" id="apiUrlInput" placeholder="http://127.0.0.1:4444">
        </div>

        <div class="form-group">
          <label for="apiTokenInput">API Token (optional)</label>
          <input type="password" id="apiTokenInput" placeholder="Leave empty for local API">
        </div>
      </div>
```

- [ ] **Step 4: Models modal markup**

Insert after the settings modal's closing `</div>` (the one closing `<div id="settingsModal" class="modal">`) and before `<script>`:

```html
  <div id="modelsModal" class="modal">
    <div class="modal-content models-content">
      <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 10px;">
        <h2 style="margin: 0;">Speech models</h2>
        <span id="diskInfo" class="model-meta"></span>
      </div>

      <div class="model-list" id="modelList"></div>

      <div class="form-group" style="text-align: left; margin-bottom: 0;">
        <label for="customModelUrl">Custom model (Hugging Face .bin URL)</label>
        <div style="display: flex; gap: 8px;">
          <input type="text" id="customModelUrl" placeholder="https://huggingface.co/owner/repo/resolve/main/model.bin">
          <button class="modal-btn modal-btn-save inline-btn" id="customModelBtn">Download</button>
        </div>
        <div style="display: flex; gap: 8px; align-items: center; margin-top: 6px;">
          <span class="model-meta" id="customModelStatus"></span>
          <button class="link-btn" id="customCancelBtn" hidden>Cancel</button>
        </div>
      </div>

      <div class="modal-buttons">
        <button class="modal-btn modal-btn-cancel" id="modelsCloseBtn">Close</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 5: Settings modal script changes**

After the line `const micDeviceInput = document.getElementById('micDeviceInput');` add:

```js
    const serverModeBuiltin = document.getElementById('serverModeBuiltin');
    const serverModeExternal = document.getElementById('serverModeExternal');
    const forceCpuInput = document.getElementById('forceCpuInput');
    const builtinOptions = document.getElementById('builtinOptions');
    const externalOptions = document.getElementById('externalOptions');

    function syncServerModeUi() {
      const external = serverModeExternal.checked;
      externalOptions.hidden = !external;
      builtinOptions.hidden = external;
    }

    serverModeBuiltin.addEventListener('change', syncServerModeUi);
    serverModeExternal.addEventListener('change', syncServerModeUi);
```

In the `settingsBtn` click handler, after `autoMuteInput.checked = settings.autoMuteAudio !== false; // Default to true` add:

```js
      serverModeBuiltin.checked = settings.serverMode !== 'external';
      serverModeExternal.checked = settings.serverMode === 'external';
      forceCpuInput.checked = settings.forceCpu === true;
      syncServerModeUi();
```

In the `settingsSaveBtn` handler's `saveSettings({ ... })` object, add after `micDevice: micDeviceInput.value || 'default',`:

```js
          serverMode: serverModeExternal.checked ? 'external' : 'builtin',
          forceCpu: forceCpuInput.checked,
```

- [ ] **Step 6: Server status and Models script**

Insert immediately before `</script>`:

```js
    // Transcription server status
    const RECOMMENDED_MODEL_ID = 'ggml-large-v3-turbo-q5_0.bin';
    const serverDot = document.getElementById('serverDot');
    const serverStatusText = document.getElementById('serverStatusText');
    const serverRestartBtn = document.getElementById('serverRestartBtn');
    const serverLogBtn = document.getElementById('serverLogBtn');
    const setupBanner = document.getElementById('setupBanner');
    const setupDownloadBtn = document.getElementById('setupDownloadBtn');

    function renderServerStatus(view) {
      serverStatusText.textContent = view.text;
      serverDot.className = 'server-dot ' + (view.mode === 'external' ? 'external' : view.state);
      const isError = view.mode === 'builtin' && view.state === 'error';
      serverRestartBtn.hidden = !isError;
      serverLogBtn.hidden = !isError;
      setupBanner.hidden = !(view.mode === 'builtin' && view.state === 'no-model');
    }

    function cleanIpcError(error) {
      const message = error && error.message ? error.message : String(error);
      return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }

    window.api.onServerStatus(renderServerStatus);
    window.api.getServerStatus().then(renderServerStatus);
    serverRestartBtn.addEventListener('click', () => {
      window.api.restartServer().catch((error) => showError(cleanIpcError(error)));
    });
    serverLogBtn.addEventListener('click', () => window.api.openServerLog());
    setupDownloadBtn.addEventListener('click', () => {
      openModels();
      startModelDownload(RECOMMENDED_MODEL_ID);
    });

    // Models modal
    const modelsModal = document.getElementById('modelsModal');
    const modelsBtn = document.getElementById('modelsBtn');
    const modelsCloseBtn = document.getElementById('modelsCloseBtn');
    const modelList = document.getElementById('modelList');
    const diskInfo = document.getElementById('diskInfo');
    const customModelUrl = document.getElementById('customModelUrl');
    const customModelBtn = document.getElementById('customModelBtn');
    const customModelStatus = document.getElementById('customModelStatus');
    const customCancelBtn = document.getElementById('customCancelBtn');

    let modelsState = { models: [], activeModelId: null, downloading: false, disk: null };
    const progressById = new Map();
    const errorById = new Map();

    function formatBytes(bytes) {
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

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function actionButton(text, className, onClick, disabled) {
      const button = el('button', 'modal-btn ' + className, text);
      button.disabled = Boolean(disabled);
      button.addEventListener('click', onClick);
      return button;
    }

    function progressText(progress) {
      if (progress.state === 'verifying') return 'Verifying…';
      if (!progress.totalBytes) return formatBytes(progress.receivedBytes);
      const percent = Math.floor((progress.receivedBytes / progress.totalBytes) * 100);
      return `${percent}% · ${formatBytes(progress.bytesPerSec)}/s`;
    }

    function renderModelRow(model) {
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
        actions.append(bar, el('span', 'model-meta', progressText(progress)), actionButton('Cancel', 'modal-btn-cancel', () => window.api.cancelDownload()));
      } else if (model.installed) {
        if (model.id === modelsState.activeModelId) {
          actions.append(el('span', 'badge-active', 'Active'));
        } else {
          actions.append(actionButton('Use', 'modal-btn-save', () => selectModel(model.id)));
        }
        actions.append(actionButton('Delete', 'modal-btn-cancel', () => deleteModel(model)));
      } else {
        actions.append(actionButton(error ? 'Retry' : 'Download', 'modal-btn-save', () => startModelDownload(model.id), modelsState.downloading));
      }
      row.append(info, actions);
      return row;
    }

    function renderModels() {
      const disk = modelsState.disk;
      diskInfo.textContent = disk ? `Disk: ${formatBytes(disk.usedBytes)} used · ${formatBytes(disk.freeBytes)} free` : '';
      modelList.replaceChildren(...modelsState.models.map(renderModelRow));
      customModelBtn.disabled = modelsState.downloading;
    }

    async function refreshModels() {
      try {
        modelsState = await window.api.listModels();
        renderModels();
      } catch (error) {
        showError(cleanIpcError(error));
      }
    }

    function openModels() {
      modelsModal.classList.add('show');
      refreshModels();
    }

    function startModelDownload(id) {
      errorById.delete(id);
      progressById.set(id, { id, receivedBytes: 0, totalBytes: null, bytesPerSec: 0, state: 'downloading' });
      modelsState.downloading = true;
      renderModels();
      window.api.downloadModel(id);
    }

    async function selectModel(id) {
      try {
        await window.api.selectModel(id);
      } catch (error) {
        showError(cleanIpcError(error));
      }
      refreshModels();
    }

    async function deleteModel(model) {
      if (!confirm(`Delete ${model.name}?`)) return;
      try {
        await window.api.deleteModel(model.id);
      } catch (error) {
        showError(cleanIpcError(error));
      }
      refreshModels();
    }

    window.api.onDownloadProgress((progress) => {
      const active = progress.state === 'downloading' || progress.state === 'verifying';
      if (progress.id.startsWith('custom')) {
        customCancelBtn.hidden = !active;
        customModelStatus.className = progress.state === 'error' ? 'model-error' : 'model-meta';
        const labels = { done: 'Downloaded', cancelled: 'Cancelled', error: progress.error };
        customModelStatus.textContent = active ? progressText(progress) : labels[progress.state];
      } else if (active) {
        progressById.set(progress.id, progress);
      } else {
        progressById.delete(progress.id);
        if (progress.state === 'error') errorById.set(progress.id, progress.error);
      }
      modelsState.downloading = active;
      if (active) {
        renderModels();
      } else {
        refreshModels();
      }
    });

    customModelBtn.addEventListener('click', () => {
      const url = customModelUrl.value.trim();
      if (!url) return;
      customModelStatus.className = 'model-meta';
      customModelStatus.textContent = 'Starting…';
      modelsState.downloading = true;
      renderModels();
      window.api.downloadCustomModel(url);
    });

    customCancelBtn.addEventListener('click', () => window.api.cancelDownload());
    modelsBtn.addEventListener('click', openModels);
    modelsCloseBtn.addEventListener('click', () => modelsModal.classList.remove('show'));
    modelsModal.addEventListener('click', (event) => {
      if (event.target === modelsModal) modelsModal.classList.remove('show');
    });
    window.api.onOpenModels(openModels);
```

- [ ] **Step 7: Build and static checks**

Run: `npm run build && npm test && npm run lint`
Expected: success.
Run: `grep -n "innerHTML" public/index.html`
Expected: only the two pre-existing mic-device lines (`micDeviceInput.innerHTML = ''` and the fallback option), none in the new code.

- [ ] **Step 8: Manual golden path on a fresh profile**

Move the dev profile aside so the app behaves like a fresh install (restored in Step 10):

```bash
mv "$APPDATA/whisper-desktop" "$APPDATA/whisper-desktop.backup"
npm start
```

Open the window from the tray ("Show/Hide") and verify, in order:
1. A "Choose a speech model to finish setup" notification appeared; status line reads grey `No model installed`; setup banner visible.
2. Tray tooltip reads `Whisper Desktop — No model installed`; tray menu has `Models…`, which opens the Models modal.
3. Press the hotkey (Ctrl+Q): no recording starts; Models modal opens.
4. In Models, click Download on `tiny.en` (74 MB): progress bar, percent, and speed update; other Download buttons disabled. When done: row shows `Active`; status goes amber `Loading model…` then green `Ready — tiny.en (CPU)` (CPU because only the fetched CPU build exists locally).
5. Record with Ctrl+Q into Notepad: transcript pastes.
6. Start downloading `base.en`, click Cancel: row returns to `Download`; `ls "$APPDATA/whisper-desktop/models"` shows no `.part`.
7. Custom URL `https://example.com/x.bin` → red error mentioning Hugging Face. Custom URL `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en-q5_1.bin` → downloads and appears as `ggerganov/whisper.cpp: ggml-tiny.en-q5_1.bin` with `Use`/`Delete`.
8. `Use` the custom model → status Loading → Ready with the custom name.
9. Delete the active model (confirm) → status `No model installed`; `tasklist | grep -i whisper-server` shows nothing.
10. Settings → External API: URL/token fields appear, Force CPU hides; Save → status blue `External API — http://127.0.0.1:4444`; no whisper-server process running. Switch back to Built-in and select `tiny.en` again → Ready.
11. Rename `resources/whisper/cpu/whisper-server.exe` to `.bak`, click Restart path by selecting the model again → red `Server error: Transcription server is not installed…` with Restart/Open log. Open log opens `whisper-server.log`. Rename the file back, click Restart → Ready.

- [ ] **Step 9: Orphan cleanup check**

With the app in `Ready`, kill Electron from Task Manager (or `taskkill //IM electron.exe //F`). Confirm `tasklist | grep -i whisper-server` still shows the orphan, then `npm start` again and confirm only one `whisper-server.exe` is running once Ready.

- [ ] **Step 10: Restore the dev profile and check the upgrade path**

Quit the app from the tray, then:

```bash
rm -rf "$APPDATA/whisper-desktop"
mv "$APPDATA/whisper-desktop.backup" "$APPDATA/whisper-desktop"
npm start
```

Expected: with the original v1.0.x `config.json`, the status line reads `External API — <your URL>` and no model notification appears.

- [ ] **Step 11: Checkpoint (no commit)**

Run: `git status --short`.

---

### Task 9: CI job that builds the CPU and Vulkan servers

**Files:**
- Modify: `.github/workflows/publish.yml`

**Interfaces:**
- Consumes: `whisper.version` (Task 6); packaging expects `resources/whisper/{cpu,vulkan}/` and `resources/whisper/VERSION` (Tasks 6–7).
- Produces: artifact `whisper-server` containing `cpu/`, `vulkan/`, `VERSION`; `build-and-release` packages it.

CI cannot run locally; this task is verified by YAML validation, a dependency-graph check, and running the smoke-test script body locally against the Task 6 CPU build.

- [ ] **Step 1: Add the `build-whisper` job**

In `.github/workflows/publish.yml`, insert this job between the `test` job and the `build-and-release` job (same indentation as the other jobs):

```yaml
  build-whisper:
    name: Build whisper.cpp server
    runs-on: windows-latest
    env:
      VULKAN_VERSION: 1.4.357.0
    steps:
      - uses: actions/checkout@v7

      - name: Read whisper.cpp version
        id: version
        shell: pwsh
        run: |
          $tag = (Get-Content whisper.version -Raw).Trim()
          "tag=$tag" >> $env:GITHUB_OUTPUT

      - name: Restore cached build
        id: cache
        uses: actions/cache@v6
        with:
          path: whisper-dist
          key: whisper-${{ steps.version.outputs.tag }}-vulkan-${{ env.VULKAN_VERSION }}-v1

      - name: Checkout whisper.cpp
        if: steps.cache.outputs.cache-hit != 'true'
        uses: actions/checkout@v7
        with:
          repository: ggml-org/whisper.cpp
          ref: ${{ steps.version.outputs.tag }}
          path: whisper.cpp

      - name: Install Vulkan SDK
        if: steps.cache.outputs.cache-hit != 'true'
        shell: pwsh
        run: |
          curl.exe -o $env:RUNNER_TEMP/VulkanSDK-Installer.exe -L "https://sdk.lunarg.com/sdk/download/${env:VULKAN_VERSION}/windows/vulkansdk-windows-X64-${env:VULKAN_VERSION}.exe"
          & "$env:RUNNER_TEMP\VulkanSDK-Installer.exe" --accept-licenses --default-answer --confirm-command install
          Add-Content $env:GITHUB_ENV "VULKAN_SDK=C:\VulkanSDK\${env:VULKAN_VERSION}"
          Add-Content $env:GITHUB_PATH "C:\VulkanSDK\${env:VULKAN_VERSION}\bin"

      - name: Build CPU and Vulkan servers
        if: steps.cache.outputs.cache-hit != 'true'
        shell: pwsh
        working-directory: whisper.cpp
        run: |
          $common = @(
            '-DCMAKE_BUILD_TYPE=Release',
            '-DBUILD_SHARED_LIBS=ON',
            '-DWHISPER_BUILD_TESTS=OFF',
            '-DWHISPER_BUILD_EXAMPLES=ON',
            '-DWHISPER_BUILD_SERVER=ON',
            '-DGGML_NATIVE=OFF',
            '-DGGML_BACKEND_DL=ON',
            '-DGGML_CPU_ALL_VARIANTS=ON'
          )
          cmake -B build-cpu @common
          if ($LASTEXITCODE -ne 0) { throw 'cmake configure (cpu) failed' }
          cmake --build build-cpu --config Release -j 4
          if ($LASTEXITCODE -ne 0) { throw 'cmake build (cpu) failed' }
          cmake -B build-vulkan @common -DGGML_VULKAN=ON
          if ($LASTEXITCODE -ne 0) { throw 'cmake configure (vulkan) failed' }
          cmake --build build-vulkan --config Release -j 4
          if ($LASTEXITCODE -ne 0) { throw 'cmake build (vulkan) failed' }

          foreach ($backend in 'cpu', 'vulkan') {
            $out = "../whisper-dist/$backend"
            New-Item -ItemType Directory -Force $out | Out-Null
            Copy-Item "build-$backend/bin/Release/whisper-server.exe" $out
            Copy-Item "build-$backend/bin/Release/*.dll" $out
          }
          Set-Content -Path ../whisper-dist/VERSION -Value '${{ steps.version.outputs.tag }}' -NoNewline

      - name: Smoke test CPU server
        shell: pwsh
        run: |
          curl.exe -sL -o "$env:RUNNER_TEMP/ggml-tiny.en.bin" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin
          $hash = (Get-FileHash "$env:RUNNER_TEMP/ggml-tiny.en.bin" -Algorithm SHA256).Hash.ToLower()
          if ($hash -ne '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f') { throw "tiny.en checksum mismatch: $hash" }
          curl.exe -sL -o "$env:RUNNER_TEMP/jfk.wav" "https://raw.githubusercontent.com/ggml-org/whisper.cpp/${{ steps.version.outputs.tag }}/samples/jfk.wav"

          $server = Start-Process -FilePath whisper-dist/cpu/whisper-server.exe -PassThru -NoNewWindow -ArgumentList @(
            '-m', "$env:RUNNER_TEMP/ggml-tiny.en.bin", '--host', '127.0.0.1', '--port', '18080',
            '--inference-path', '/v1/audio/transcriptions')
          try {
            $ready = $false
            for ($i = 0; $i -lt 60; $i++) {
              try {
                if ((Invoke-WebRequest -UseBasicParsing http://127.0.0.1:18080/health).StatusCode -eq 200) { $ready = $true; break }
              } catch {}
              Start-Sleep -Seconds 1
            }
            if (-not $ready) { throw 'whisper-server did not become ready' }
            $text = curl.exe -s -F "file=@$env:RUNNER_TEMP/jfk.wav" -F response_format=json http://127.0.0.1:18080/v1/audio/transcriptions
            Write-Output $text
            if ($text -notmatch 'ask not') { throw 'Unexpected transcription output' }
          } finally {
            Stop-Process -Id $server.Id -Force
          }

      - name: Check Vulkan server launches
        shell: pwsh
        run: |
          & whisper-dist/vulkan/whisper-server.exe --help *> $null
          if ($LASTEXITCODE -ne 0) { throw "vulkan whisper-server --help exited with $LASTEXITCODE" }

      - uses: actions/upload-artifact@v7
        with:
          name: whisper-server
          path: whisper-dist
          if-no-files-found: error
```

- [ ] **Step 2: Wire it into `build-and-release`**

In the `build-and-release` job, change:

```yaml
    needs: [lint, test]
```

to:

```yaml
    needs: [lint, test, build-whisper]
```

and insert as the first step after `- uses: actions/checkout@v7`:

```yaml
      - name: Download whisper.cpp server
        uses: actions/download-artifact@v8
        with:
          name: whisper-server
          path: resources/whisper
```

- [ ] **Step 3: Validate the workflow**

Run:

```bash
node -e "
const y = require('js-yaml').load(require('fs').readFileSync('.github/workflows/publish.yml', 'utf8'));
const j = y.jobs;
console.log(Object.keys(j).join(' '));
console.log('needs:', j['build-and-release'].needs.join(','));
console.log('download step:', j['build-and-release'].steps.some(s => (s.uses || '').startsWith('actions/download-artifact')));
console.log('upload step:', j['build-whisper'].steps.some(s => (s.uses || '').startsWith('actions/upload-artifact')));
"
```

Expected:
```
lint test build-whisper build-and-release
needs: lint,test,build-whisper
download step: true
upload step: true
```

- [ ] **Step 4: Run the smoke test body locally**

Using the Task 6 CPU build as a stand-in for `whisper-dist`, run in PowerShell from the repo root:

```powershell
New-Item -ItemType Directory -Force whisper-dist | Out-Null
Copy-Item -Recurse -Force resources/whisper/cpu whisper-dist/cpu
$env:RUNNER_TEMP = $env:TEMP
```

Then paste the body of the "Smoke test CPU server" step's `run:` block, replacing `${{ steps.version.outputs.tag }}` with `b5130`.
Expected: prints JSON containing `ask not`, no exception. Then clean up: `Remove-Item -Recurse -Force whisper-dist`.

- [ ] **Step 5: Checkpoint (no commit)**

Run: `git status --short` — expect `.github/workflows/publish.yml` modified and no `whisper-dist/` left behind.

---

### Task 10: Final verification

- [ ] **Step 1: Full suite**

Run: `npm ci && npm run build && npm test && npm run lint && npm audit`
Expected: build OK; all suites pass (existing 33 tests plus the new suites); 0 lint errors; 0 vulnerabilities.

- [ ] **Step 2: Packaged app smoke test**

Run: `npm run whisper:fetch && npm run ensure-mac-perms && npm run build && npx electron-builder --win`
Install `release/Whisper Desktop.exe` on this machine, then repeat Task 8 Step 8 items 1, 4, and 5 from the installed app (confirms `extraResources` paths resolve under `process.resourcesPath`).

- [ ] **Step 3: Vulkan build check (needs a CI run or a local Vulkan SDK)**

After the first CI run of `build-whisper`, download the `whisper-server` artifact, point `WHISPER_SERVER_DIR` at its `vulkan` folder, run `npm start`, select a model, and confirm the status line shows `(GPU)` on a machine with a Vulkan-capable GPU, and `(CPU)` in a VM without one (spec §7.4 item 8).

- [ ] **Step 4: Report**

Summarise results against spec §7.4's manual checklist, listing any item that could not be run here (e.g. Vulkan GPU, fresh-VM install) so the user can run it.
