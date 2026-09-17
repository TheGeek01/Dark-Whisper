import { clampSilenceGap, DEFAULT_SILENCE_GAP_SECONDS, initialServerMode, normalizeTheme } from '../services/settingsMigration';

describe('initialServerMode', () => {
  it('keeps existing installs on the external API', () => {
    expect(initialServerMode(true)).toBe('external');
  });

  it('defaults fresh installs to the built-in server', () => {
    expect(initialServerMode(false)).toBe('builtin');
  });
});

describe('clampSilenceGap', () => {
  it('keeps whole seconds between 1 and 60', () => {
    expect(DEFAULT_SILENCE_GAP_SECONDS).toBe(5);
    expect(clampSilenceGap(5)).toBe(5);
    expect(clampSilenceGap(0)).toBe(1);
    expect(clampSilenceGap(600)).toBe(60);
    expect(clampSilenceGap(2.6)).toBe(3);
    expect(clampSilenceGap('7')).toBe(7);
  });

  it('falls back to the default for nonsense', () => {
    expect(clampSilenceGap(undefined)).toBe(5);
    expect(clampSilenceGap('soon')).toBe(5);
    expect(clampSilenceGap(Number.NaN)).toBe(5);
  });
});

describe('normalizeTheme', () => {
  it('accepts light and defaults to dark', () => {
    expect(normalizeTheme('light')).toBe('light');
    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme('purple')).toBe('dark');
    expect(normalizeTheme(undefined)).toBe('dark');
  });
});
