import { DeadMicDetector, LEVEL_FLOOR_DB, meterLevel, pcmLevelDb, pcmPeak, SilenceTracker } from '../services/audioLevel';

function pcm(values: number[]): Buffer {
  const buffer = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => buffer.writeInt16LE(v, i * 2));
  return buffer;
}

// Feeds 0.25 s chunks of a constant level, as SoX delivers them.
function feed(tracker: SilenceTracker, fromSec: number, toSec: number, db: number, dead = false): void {
  for (let t = fromSec; t < toSec - 1e-9; t += 0.25) tracker.add(t, 0.25, db, dead);
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

  it('judges the room by its own noise, not by a muted stretch before it', () => {
    const tracker = new SilenceTracker();
    feed(tracker, 0, 30, -38);
    feed(tracker, 30, 50, -60, true);
    feed(tracker, 50, 52, -38);
    feed(tracker, 52, 54, -20);
    feed(tracker, 54, 62, -38);
    feed(tracker, 62, 63, -20);
    expect(tracker.splitPoint(54.5, 63.5, 5)).toBe(58);
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

describe('pcmPeak', () => {
  it('is the largest sample magnitude', () => {
    expect(pcmPeak(pcm([0, 1, -1, 0]))).toBe(1);
    expect(pcmPeak(pcm([3, -1700, 200]))).toBe(1700);
    expect(pcmPeak(pcm([-32768]))).toBe(32768);
    expect(pcmPeak(Buffer.alloc(0))).toBe(0);
  });
});

describe('DeadMicDetector', () => {
  // A hardware-muted TONOR TM20 measured +/-1; a quiet room peaks in the hundreds or more.
  function setup() {
    const changes: boolean[] = [];
    const detector = new DeadMicDetector((dead) => changes.push(dead));
    const add = (seconds: number, peak: number) => {
      for (let t = 0; t < seconds - 1e-9; t += 0.25) detector.add(0.25, peak);
    };
    return { detector, changes, add };
  }

  it('reports a mic that has sent nothing but digital silence for 1.5 s', () => {
    const { changes, add } = setup();
    add(1.25, 1);
    expect(changes).toEqual([]);
    add(0.25, 1);
    expect(changes).toEqual([true]);
    add(5, 0);
    expect(changes).toEqual([true]);
  });

  it('reports the mic back on the first chunk with signal', () => {
    const { changes, add } = setup();
    add(2, 0);
    add(0.25, 40);
    expect(changes).toEqual([true, false]);
    add(1, 300);
    expect(changes).toEqual([true, false]);
  });

  it('never calls a quiet room dead', () => {
    const { changes, add } = setup();
    add(60, 12);
    expect(changes).toEqual([]);
  });

  it('starts the count again after any signal', () => {
    const { changes, add } = setup();
    add(1.25, 0);
    add(0.25, 50);
    add(1.25, 0);
    expect(changes).toEqual([]);
  });

  it('forgets its state on reset', () => {
    const { detector, changes, add } = setup();
    add(2, 0);
    detector.reset();
    add(0.25, 500);
    expect(changes).toEqual([true]);
    add(1.5, 0);
    expect(changes).toEqual([true, true]);
  });
});
