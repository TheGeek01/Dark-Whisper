import { audioFileName, newSessionId } from '../services/sessionPaths';

describe('sessionPaths', () => {
  it('builds a sortable session id from the clock', () => {
    expect(newSessionId(new Date('2026-09-15T14:32:04Z'))).toMatch(/^\d{8}-\d{6}$/);
    expect(newSessionId(new Date(2026, 8, 15, 14, 32, 4))).toBe('20260915-143204');
  });

  it('names the first session audio file', () => {
    expect(audioFileName(1)).toBe('session-1.wav');
  });

  it('names later session audio files by index', () => {
    expect(audioFileName(3)).toBe('session-3.wav');
  });
});
