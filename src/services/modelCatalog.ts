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
