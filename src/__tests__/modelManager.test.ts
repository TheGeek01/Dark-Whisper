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

  it('does not list the VAD model as a speech model', async () => {
    const m = manager(fetcherFor(Buffer.alloc(0)));
    await m.init();
    fs.writeFileSync(path.join(dir, 'ggml-silero-v6.2.0.bin'), ggmlBytes(16));
    expect(m.listModels().some((e) => e.id.includes('silero'))).toBe(false);
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
