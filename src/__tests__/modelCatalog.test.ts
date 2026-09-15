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
