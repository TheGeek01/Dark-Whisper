import type { ThemeName } from '../shared/api';

export type ServerMode = 'builtin' | 'external';

export function initialServerMode(configFileExisted: boolean): ServerMode {
  return configFileExisted ? 'external' : 'builtin';
}

export const DEFAULT_SILENCE_GAP_SECONDS = 5;

export function clampSilenceGap(value: unknown): number {
  const seconds = typeof value === 'number' ? value : Number(value);
  if (value === undefined || value === null || !Number.isFinite(seconds)) return DEFAULT_SILENCE_GAP_SECONDS;
  return Math.min(60, Math.max(1, Math.round(seconds)));
}

export function normalizeTheme(value: unknown): ThemeName {
  return value === 'light' ? 'light' : 'dark';
}
