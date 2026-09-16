// SoX records 16 kHz, 16-bit, mono PCM: 32 000 bytes per second.
export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SAMPLE = 2;
export const BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE;
export const WAV_HEADER_BYTES = 44;

export interface AudioEntry {
  file: string;
  startSec: number;
  durationSec: number;
}

export interface AudioSlice {
  file: string;
  startByte: number;
  endByte: number;
}

export function blockRange(index: number, blockMinutes: number): { startSec: number; endSec: number } {
  const length = blockMinutes * 60;
  return { startSec: (index - 1) * length, endSec: index * length };
}

export function formatTimestampHeading(startSec: number): string {
  const total = Math.floor(startSec);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `## ${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function alignToSample(bytes: number): number {
  return Math.floor(bytes / BYTES_PER_SAMPLE) * BYTES_PER_SAMPLE;
}

export function slicesForRange(manifest: AudioEntry[], startSec: number, endSec: number): AudioSlice[] {
  const slices: AudioSlice[] = [];
  for (const entry of manifest) {
    const entryEnd = entry.startSec + entry.durationSec;
    const from = Math.max(startSec, entry.startSec);
    const to = Math.min(endSec, entryEnd);
    if (to <= from) continue;
    slices.push({
      file: entry.file,
      startByte: WAV_HEADER_BYTES + alignToSample((from - entry.startSec) * BYTES_PER_SECOND),
      endByte: WAV_HEADER_BYTES + alignToSample((to - entry.startSec) * BYTES_PER_SECOND),
    });
  }
  return slices;
}

export function wavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28); // byte rate
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}
