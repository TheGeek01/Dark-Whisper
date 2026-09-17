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

export function meterLevel(db: number): number {
  return Math.min(1, Math.max(0, (db - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB));
}

export interface SpeechAudio {
  // Where the block holding the segment that arrived at afterSec should end, given that the next
  // segment arrived at beforeSec; null to keep both in one block.
  splitPoint(afterSec: number, beforeSec: number, gapSec: number): number | null;
  // Whether any speech was heard in (fromSec, toSec]; null when no audio covers it.
  hasSpeech(fromSec: number, toSec: number): boolean | null;
}

interface LevelSample {
  startSec: number;
  endSec: number;
  speech: boolean;
  db: number;
}

export class SilenceTracker implements SpeechAudio {
  private samples: LevelSample[] = [];

  add(startSec: number, durationSec: number, db: number): void {
    const threshold = Math.max(SPEECH_MIN_DB, this.noiseFloor(startSec, db) + SPEECH_ABOVE_FLOOR_DB);
    this.samples.push({ startSec, endSec: startSec + durationSec, db, speech: db >= threshold });
    const cutoff = startSec - KEEP_SEC;
    while (this.samples.length > 0 && this.samples[0].endSec < cutoff) this.samples.shift();
  }

  private noiseFloor(atSec: number, current: number): number {
    const recent = this.samples.filter((s) => s.startSec >= atSec - FLOOR_WINDOW_SEC).map((s) => s.db);
    recent.push(current);
    recent.sort((a, b) => a - b);
    return Math.min(recent[Math.floor((recent.length - 1) * FLOOR_PERCENTILE)], FLOOR_CAP_DB);
  }

  hasSpeech(fromSec: number, toSec: number): boolean | null {
    const covering = this.samples.filter((s) => s.endSec > fromSec && s.startSec < toSec);
    return covering.length === 0 ? null : covering.some((s) => s.speech);
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
