import {
  blockRange,
  slicesForRange,
  wavHeader,
  formatTimestampHeading,
  BYTES_PER_SECOND,
  WAV_HEADER_BYTES,
} from '../services/blockMath';

describe('blockRange', () => {
  it('maps 1-based block indices onto the audio clock', () => {
    expect(blockRange(1, 2)).toEqual({ startSec: 0, endSec: 120 });
    expect(blockRange(3, 2)).toEqual({ startSec: 240, endSec: 360 });
    expect(blockRange(1, 5)).toEqual({ startSec: 0, endSec: 300 });
  });
});

describe('formatTimestampHeading', () => {
  it('formats hours, minutes and seconds', () => {
    expect(formatTimestampHeading(0)).toBe('## 00:00:00');
    expect(formatTimestampHeading(3725)).toBe('## 01:02:05');
  });
});

describe('slicesForRange', () => {
  const single = [{ file: 'a.wav', startSec: 0, durationSec: 600 }];

  it('slices inside one file, allowing for the WAV header', () => {
    expect(slicesForRange(single, 120, 240)).toEqual([
      { file: 'a.wav', startByte: WAV_HEADER_BYTES + 120 * BYTES_PER_SECOND, endByte: WAV_HEADER_BYTES + 240 * BYTES_PER_SECOND },
    ]);
  });

  it('clamps to the audio that exists', () => {
    expect(slicesForRange(single, 540, 720)).toEqual([
      { file: 'a.wav', startByte: WAV_HEADER_BYTES + 540 * BYTES_PER_SECOND, endByte: WAV_HEADER_BYTES + 600 * BYTES_PER_SECOND },
    ]);
  });

  it('spans a restart across two files', () => {
    const manifest = [
      { file: 'a.wav', startSec: 0, durationSec: 100 },
      { file: 'b.wav', startSec: 110, durationSec: 200 },
    ];
    expect(slicesForRange(manifest, 90, 130)).toEqual([
      { file: 'a.wav', startByte: WAV_HEADER_BYTES + 90 * BYTES_PER_SECOND, endByte: WAV_HEADER_BYTES + 100 * BYTES_PER_SECOND },
      { file: 'b.wav', startByte: WAV_HEADER_BYTES, endByte: WAV_HEADER_BYTES + 20 * BYTES_PER_SECOND },
    ]);
  });

  it('returns nothing for a range that falls in a gap', () => {
    const manifest = [
      { file: 'a.wav', startSec: 0, durationSec: 100 },
      { file: 'b.wav', startSec: 110, durationSec: 200 },
    ];
    expect(slicesForRange(manifest, 101, 109)).toEqual([]);
    expect(slicesForRange([], 0, 120)).toEqual([]);
  });

  it('keeps byte offsets on 16-bit sample boundaries', () => {
    const [slice] = slicesForRange(single, 0.5001, 1.0001);
    expect((slice.startByte - WAV_HEADER_BYTES) % 2).toBe(0);
    expect((slice.endByte - WAV_HEADER_BYTES) % 2).toBe(0);
  });
});

describe('wavHeader', () => {
  it('describes 16 kHz mono 16-bit PCM', () => {
    const header = wavHeader(32_000);
    expect(header).toHaveLength(WAV_HEADER_BYTES);
    expect(header.toString('ascii', 0, 4)).toBe('RIFF');
    expect(header.toString('ascii', 8, 12)).toBe('WAVE');
    expect(header.readUInt32LE(4)).toBe(36 + 32_000);
    expect(header.readUInt16LE(22)).toBe(1); // channels
    expect(header.readUInt32LE(24)).toBe(16_000); // sample rate
    expect(header.readUInt16LE(34)).toBe(16); // bits per sample
    expect(header.readUInt32LE(40)).toBe(32_000); // data size
  });
});
