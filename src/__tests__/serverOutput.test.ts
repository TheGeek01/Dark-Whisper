import {
  classifyServerLine,
  restartDelay,
  RESTART_DELAYS_MS,
  LineBuffer,
  parseTasklistImage,
  isWhisperServerImage,
} from '../services/serverOutput';

describe('serverOutput', () => {
  describe('classifyServerLine', () => {
    it('recognises a VAD model the server could not load', () => {
      expect(classifyServerLine('whisper_vad: failed to initialize VAD context')).toBe('vad-failed');
      expect(classifyServerLine('whisper_vad: VAD is enabled, processing speech segments only')).toBeNull();
    });

    it.each([
      ['error: failed to initialize whisper context', 'model-load-failed'],
      ["couldn't bind to server socket: hostname=127.0.0.1 port=5000", 'bind-failed'],
      ['whisper_backend_init_gpu: using Vulkan0 backend', 'gpu-backend'],
      ['whisper_backend_init_gpu: no GPU found', 'no-gpu'],
      ['whisper_backend_init: using BLAS backend', null],
      ['whisper server listening at http://127.0.0.1:5000', null],
    ])('%s -> %s', (line, expected) => {
      expect(classifyServerLine(line)).toBe(expected);
    });
  });

  describe('restartDelay', () => {
    it('follows 1s, 5s, 15s then gives up', () => {
      expect(RESTART_DELAYS_MS).toEqual([1000, 5000, 15000]);
      expect([1, 2, 3, 4].map(restartDelay)).toEqual([1000, 5000, 15000, null]);
      expect(restartDelay(0)).toBeNull();
    });
  });

  describe('LineBuffer', () => {
    it('returns complete lines and keeps partial lines until finished', () => {
      const buf = new LineBuffer(10);
      expect(buf.push('first\r\nsec')).toEqual(['first']);
      expect(buf.push('ond\n\nthird')).toEqual(['second']);
      expect(buf.lines()).toEqual(['first', 'second', 'third']);
    });

    it('keeps only the most recent lines', () => {
      const buf = new LineBuffer(3);
      buf.push('1\n2\n3\n4\n5\n');
      expect(buf.lines()).toEqual(['3', '4', '5']);
    });
  });

  describe('tasklist parsing', () => {
    it('reads the image name from CSV output', () => {
      expect(parseTasklistImage('"whisper-server.exe","4242","Console","1","250,000 K"\r\n')).toBe('whisper-server.exe');
    });

    it('returns null when no process matches', () => {
      expect(parseTasklistImage('INFO: No tasks are running which match the specified criteria.\r\n')).toBeNull();
      expect(parseTasklistImage('')).toBeNull();
    });

    it('only accepts whisper-server.exe', () => {
      expect(isWhisperServerImage('WHISPER-SERVER.EXE')).toBe(true);
      expect(isWhisperServerImage('chrome.exe')).toBe(false);
      expect(isWhisperServerImage(null)).toBe(false);
    });
  });
});
