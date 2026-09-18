// Levels of 16-bit little-endian mono PCM, and the silence rule that ends a block (spec §3.1).

export const LEVEL_FLOOR_DB = -60;
const SPEECH_MIN_DB = -50;
const SPEECH_ABOVE_FLOOR_DB = 10;
// A noise floor above this is treated as this, so speech from the first second still counts.
const FLOOR_CAP_DB = -40;
const FLOOR_WINDOW_SEC = 30;
const FLOOR_PERCENTILE = 0.1;
// Chunks further back than this can no longer matter: a block closes after at most blockMinutes.
const KEEP_SEC = 35 * 60;
// Consecutive chunks are exactly adjacent; a larger hole (SoX restarting) ends a run.
const RUN_JOIN_SEC = 0.05;

export function pcmLevelDb(chunk: Buffer): number {
  const samples = Math.floor(chunk.length / 2);
  if (samples === 0) return LEVEL_FLOOR_DB;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const value = chunk.readInt16LE(i * 2);
    sum += value * value;
  }
  const rms = Math.sqrt(sum / samples) / 32768;
  if (rms <= 0) return LEVEL_FLOOR_DB;
  return Math.max(LEVEL_FLOOR_DB, 20 * Math.log10(rms));
}

export function pcmPeak(chunk: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < chunk.length; i += 2) {
    peak = Math.max(peak, Math.abs(chunk.readInt16LE(i)));
  }
  return peak;
}

// A mic muted by its own button (the TONOR TM20's touch mute, for one) still looks unmuted to
// Windows and sends digital silence: every sample within one step of zero. A live mic in a room
// never does; a quiet room peaks in the hundreds.
const DEAD_PEAK = 4;
const DEAD_AFTER_SEC = 1.5;

export function isDeadPeak(peak: number): boolean {
  return peak <= DEAD_PEAK;
}

export class DeadMicDetector {
  private deadSec = 0;
  private dead = false;

  constructor(private readonly onChange: (dead: boolean) => void) {}

  add(durationSec: number, peak: number): void {
    if (!isDeadPeak(peak)) {
      this.deadSec = 0;
      this.set(false);
      return;
    }
    this.deadSec += durationSec;
    if (this.deadSec >= DEAD_AFTER_SEC - 1e-9) this.set(true);
  }

  reset(): void {
    this.deadSec = 0;
    this.dead = false;
  }

  private set(dead: boolean): void {
    if (this.dead === dead) return;
    this.dead = dead;
    this.onChange(dead);
  }
}

export function meterLevel(db: number): number {
  return Math.min(1, Math.max(0, (db - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB));
}

export interface SplitFinder {
  // Where the block holding the segment that arrived at afterSec should end, given that the next
  // segment arrived at beforeSec; null to keep both in one block.
  splitPoint(afterSec: number, beforeSec: number, gapSec: number): number | null;
}

interface LevelSample {
  startSec: number;
  endSec: number;
  speech: boolean;
  db: number;
  dead: boolean;
}

export class SilenceTracker implements SplitFinder {
  private samples: LevelSample[] = [];

  // A dead chunk (a muted mic sending digital silence) is silence, but says nothing about the
  // room: it is left out of the noise floor, which would otherwise sink to the level floor and
  // count room noise as speech for FLOOR_WINDOW_SEC after the mic comes back.
  add(startSec: number, durationSec: number, db: number, dead = false): void {
    const speech = !dead && db >= Math.max(SPEECH_MIN_DB, this.noiseFloor(startSec, db) + SPEECH_ABOVE_FLOOR_DB);
    this.samples.push({ startSec, endSec: startSec + durationSec, db, dead, speech });
    const cutoff = startSec - KEEP_SEC;
    while (this.samples.length > 0 && this.samples[0].endSec < cutoff) this.samples.shift();
  }

  private noiseFloor(atSec: number, current: number): number {
    const recent = this.samples.filter((s) => !s.dead && s.startSec >= atSec - FLOOR_WINDOW_SEC).map((s) => s.db);
    recent.push(current);
    recent.sort((a, b) => a - b);
    return Math.min(recent[Math.floor((recent.length - 1) * FLOOR_PERCENTILE)], FLOOR_CAP_DB);
  }

  splitPoint(afterSec: number, beforeSec: number, gapSec: number): number | null {
    const covered = this.samples.some((s) => s.endSec > afterSec && s.startSec < beforeSec);
    if (!covered) return beforeSec - afterSec >= gapSec ? afterSec : null;

    let best: { start: number; end: number } | null = null;
    let run: { start: number; end: number } | null = null;
    const closeRun = () => {
      if (run && run.end > afterSec && run.start < beforeSec && (!best || run.end - run.start > best.end - best.start)) {
        best = run;
      }
      run = null;
    };
    for (const sample of this.samples) {
      if (sample.speech) {
        closeRun();
        continue;
      }
      if (run && sample.startSec <= run.end + RUN_JOIN_SEC) {
        run.end = sample.endSec;
      } else {
        closeRun();
        run = { start: sample.startSec, end: sample.endSec };
      }
    }
    closeRun();

    const longest = best as { start: number; end: number } | null;
    if (!longest || longest.end - longest.start < gapSec) return null;
    const middle = (longest.start + longest.end) / 2;
    return Math.min(beforeSec, Math.max(afterSec, middle));
  }
}
