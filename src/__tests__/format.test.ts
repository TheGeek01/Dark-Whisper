import { cleanIpcError, formatBytes, formatClock, formatDate } from '../renderer/format';

describe('formatClock', () => {
  it('formats minutes and seconds, adding hours only when needed', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(75)).toBe('01:15');
    expect(formatClock(59.9)).toBe('00:59');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(-5)).toBe('00:00');
  });
});

describe('formatBytes', () => {
  it('uses the largest sensible unit', () => {
    expect(formatBytes(null)).toBe('');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(574_041_195)).toBe('547 MB');
  });
});

describe('formatDate', () => {
  it('shows local date and time, falling back to the file time', () => {
    expect(formatDate(new Date(2026, 8, 16, 7, 6).toISOString(), 0)).toBe('2026-09-16 07:06');
    expect(formatDate('', new Date(2026, 0, 2, 3, 4).getTime())).toBe('2026-01-02 03:04');
    expect(formatDate('not a date', new Date(2026, 0, 2, 3, 4).getTime())).toBe('2026-01-02 03:04');
  });
});

describe('cleanIpcError', () => {
  it('strips the Electron IPC prefix', () => {
    const error = new Error("Error invoking remote method 'session-start': Error: A session is already recording");
    expect(cleanIpcError(error)).toBe('A session is already recording');
    expect(cleanIpcError('plain')).toBe('plain');
  });
});
