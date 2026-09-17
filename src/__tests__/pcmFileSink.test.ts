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
