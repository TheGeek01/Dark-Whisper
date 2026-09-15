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
