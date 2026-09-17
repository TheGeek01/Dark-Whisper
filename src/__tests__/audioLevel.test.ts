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

  it('knows whether anyone spoke in a stretch of audio', () => {
    const tracker = new SilenceTracker();
    expect(tracker.hasSpeech(0, 5)).toBeNull();
    feed(tracker, 0, 3, -20);
    feed(tracker, 3, 10, -45);
    expect(tracker.hasSpeech(0, 5)).toBe(true);
    expect(tracker.hasSpeech(4, 10)).toBe(false);
    expect(tracker.hasSpeech(2.9, 10)).toBe(true);
    expect(tracker.hasSpeech(20, 30)).toBeNull();
  });
});
