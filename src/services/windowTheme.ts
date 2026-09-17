import type { ThemeName } from '../shared/api';

// Must match --bg in public/app.css: the native caption buttons sit on the page's header.
export const TITLE_BAR_HEIGHT = 56;

const COLORS: Record<ThemeName, { background: string; symbol: string }> = {
  dark: { background: '#0f1020', symbol: '#c9cbe0' },
  light: { background: '#f6f7fb', symbol: '#3b3d52' },
};

export function windowBackground(theme: ThemeName): string {
  return COLORS[theme].background;
}

export function titleBarOverlay(theme: ThemeName): { color: string; symbolColor: string; height: number } {
  return { color: COLORS[theme].background, symbolColor: COLORS[theme].symbol, height: TITLE_BAR_HEIGHT };
}
