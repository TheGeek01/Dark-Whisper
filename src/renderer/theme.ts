import type { ThemeName } from '../shared/api.js';
import { byId } from './dom.js';
import { reportError } from './toast.js';

let current: ThemeName = 'dark';

export function applyTheme(theme: ThemeName): void {
  current = theme;
  document.documentElement.dataset.theme = theme;
  byId('themeIcon').className = `i ${theme === 'dark' ? 'i-moon' : 'i-sun'}`;
  byId('themeBtn').title = theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme';
}

export function initTheme(): void {
  window.api.getSettings().then((settings) => applyTheme(settings.theme), reportError);
  byId('themeBtn').addEventListener('click', () => {
    const next: ThemeName = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    window.api.saveSettings({ theme: next }).catch(reportError);
  });
}
