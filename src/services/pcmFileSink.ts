import * as fs from 'fs';
import { BYTES_PER_SECOND, WAV_HEADER_BYTES, wavHeader } from './blockMath';

// Writes SoX's raw PCM into a WAV file as it arrives. The header goes in first with a zero size
// and is patched on close; until then the data is still sliceable by byte offset (spec §4.5).
export class PcmFileSink {
  private readonly fd: number;
  private bytes = 0;
  private closed = false;

  constructor(
    readonly file: string,
    private readonly onChunk: (startSec: number, durationSec: number, chunk: Buffer) => void,
  ) {
    this.fd = fs.openSync(file, 'w');
    fs.writeSync(this.fd, wavHeader(0));
  }

  get dataBytes(): number {
    return this.bytes;
  }

  write(chunk: Buffer): void {
    if (this.closed || chunk.length === 0) return;
    fs.writeSync(this.fd, chunk);
    const startSec = this.bytes / BYTES_PER_SECOND;
    this.bytes += chunk.length;
    this.onChunk(startSec, chunk.length / BYTES_PER_SECOND, chunk);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      fs.writeSync(this.fd, wavHeader(this.bytes), 0, WAV_HEADER_BYTES, 0);
    } finally {
      fs.closeSync(this.fd);
    }
  }
}
