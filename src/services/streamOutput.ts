export const READY_MARKER = '[Start speaking]';

export interface CaptureDevice {
  index: number;
  name: string;
}

export type StreamSource = 'stdout' | 'stderr';

export type StreamEvent =
  | { kind: 'ready' }
  | { kind: 'segment'; text: string }
  | { kind: 'device'; device: CaptureDevice }
  | { kind: 'capture-failed' }
  | { kind: 'model-load-failed' };

// stream.exe redraws its provisional line with CSI sequences.
// eslint-disable-next-line no-control-regex
const ANSI = new RegExp('\x1b\\[[0-9;]*[A-Za-z]', 'g');

export function stripAnsi(line: string): string {
  return line.replace(ANSI, '').replace(/\r/g, '');
}

const DEVICE = /- Capture device #(\d+): '(.*)'/;
const TIMESTAMPED = /^\[\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\]\s*(.*)$/;

export function parseStreamLine(raw: string, source: StreamSource): StreamEvent | null {
  const line = stripAnsi(raw).trim();
  if (line.length === 0) return null;

  if (source === 'stdout') {
    // stdout carries only [Start speaking], transcript timestamps, and speech text
    if (line === READY_MARKER) return { kind: 'ready' };

    // VAD mode prints segment markers like "### Transcription 7 END" - ignore these
    if (line.startsWith('### ')) return null;

    const timestamped = TIMESTAMPED.exec(line);
    if (timestamped) {
      const text = timestamped[1].trim();
      return text.length > 0 ? { kind: 'segment', text } : null;
    }

    // Any other non-empty line from stdout is verbatim speech
    return { kind: 'segment', text: line };
  }

  // source === 'stderr'
  // stderr carries diagnostics: device lists, capture failures, model failures
  if (line.includes("couldn't open an audio device for capture")) return { kind: 'capture-failed' };
  if (line.includes('failed to initialize whisper context')) return { kind: 'model-load-failed' };

  const device = DEVICE.exec(line);
  if (device) {
    return { kind: 'device', device: { index: Number(device[1]), name: device[2] } };
  }

  // stderr: any other line is diagnostic noise, not emitted
  return null;
}

// Whisper emits bracketed or parenthesised annotations for non-speech audio.
const NOISE_ONLY = /^[[(][^)\]]*[)\]]$/;

export function isNoiseSegment(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (NOISE_ONLY.test(trimmed)) return true;
  return /^[.…,!?-]+$/.test(trimmed);
}
