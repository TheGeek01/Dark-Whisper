import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileMatchesPin, installVadModel, VAD_MODEL, VadModelPin } from '../services/vadModel';

const content = Buffer.from('pretend silero weights');
const pin: VadModelPin = {
  file: 'ggml-silero-test.bin',
  url: 'https://example.invalid/ggml-silero-test.bin',
  size: content.length,
  sha256: createHash('sha256').update(content).digest('hex'),
};

describe('vadModel', () => {
  let root: string;
  let bundled: string;
  let models: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-vad-'));
    bundled = path.join(root, 'resources', 'vad');
    models = path.join(root, 'models');
    fs.mkdirSync(bundled, { recursive: true });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('matches the pin in whisper-vad.json', () => {
    const json = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'whisper-vad.json'), 'utf8'));
    expect(json).toEqual(VAD_MODEL);
  });

  it('checks size and hash', () => {
    const file = path.join(bundled, pin.file);
    expect(fileMatchesPin(file, pin)).toBe(false);
    fs.writeFileSync(file, content);
    expect(fileMatchesPin(file, pin)).toBe(true);
    fs.writeFileSync(file, Buffer.from('pretend silero weightZ'));
    expect(fileMatchesPin(file, pin)).toBe(false);
  });

  it('copies the bundled model into the models folder', () => {
    fs.writeFileSync(path.join(bundled, pin.file), content);
    expect(installVadModel(bundled, models, pin)).toEqual({ path: path.join(models, pin.file) });
    expect(fs.readFileSync(path.join(models, pin.file))).toEqual(content);
    expect(fs.existsSync(path.join(models, `${pin.file}.part`))).toBe(false);
  });

  it('keeps a good copy, even without the bundled file', () => {
    fs.mkdirSync(models);
    fs.writeFileSync(path.join(models, pin.file), content);
    expect(installVadModel(bundled, models, pin)).toEqual({ path: path.join(models, pin.file) });
  });

  it('replaces a damaged copy', () => {
    fs.writeFileSync(path.join(bundled, pin.file), content);
    fs.mkdirSync(models);
    fs.writeFileSync(path.join(models, pin.file), 'damaged');
    expect(installVadModel(bundled, models, pin)).toEqual({ path: path.join(models, pin.file) });
    expect(fs.readFileSync(path.join(models, pin.file))).toEqual(content);
  });

  it('explains when there is nothing good to install', () => {
    const missing = installVadModel(bundled, models, pin);
    expect(missing.path).toBeNull();
    expect(missing).toMatchObject({ reason: expect.stringContaining('bundled VAD model is missing or damaged') });

    fs.writeFileSync(path.join(bundled, pin.file), 'wrong bytes');
    expect(installVadModel(bundled, models, pin).path).toBeNull();
  });
});
