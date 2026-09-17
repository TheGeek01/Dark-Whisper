import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface VadModelPin {
  file: string;
  url: string;
  size: number;
  sha256: string;
}

// Mirrors whisper-vad.json (read by scripts/fetch-whisper.js and CI); a test keeps them equal.
export const VAD_MODEL: VadModelPin = {
  file: 'ggml-silero-v6.2.0.bin',
  url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin',
  size: 885098,
  sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987',
};

// whisper-server loads the VAD model on every request, and a bad file fails every request, so
// only a file that matches the pin is ever passed to it (spec §4).
export function fileMatchesPin(file: string, pin: VadModelPin = VAD_MODEL): boolean {
  try {
    const data = fs.readFileSync(file);
    return data.length === pin.size && createHash('sha256').update(data).digest('hex') === pin.sha256;
  } catch {
    return false;
  }
}

// The server cannot open absolute paths under non-ASCII profiles, so the model is copied into the
// models folder, next to the speech models it is used with (spec §3).
export function installVadModel(
  bundledDir: string,
  modelsDir: string,
  pin: VadModelPin = VAD_MODEL,
): { path: string } | { path: null; reason: string } {
  const target = path.join(modelsDir, pin.file);
  if (fileMatchesPin(target, pin)) return { path: target };
  const source = path.join(bundledDir, pin.file);
  if (!fileMatchesPin(source, pin)) {
    return { path: null, reason: `the bundled VAD model is missing or damaged (${source})` };
  }
  try {
    fs.mkdirSync(modelsDir, { recursive: true });
    const part = `${target}.part`;
    fs.copyFileSync(source, part);
    fs.renameSync(part, target);
  } catch (error) {
    return { path: null, reason: `could not copy the VAD model: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { path: target };
}
