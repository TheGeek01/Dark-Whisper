import { byId, el } from './dom.js';
import { cleanIpcError } from './format.js';

export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const node = el('div', `toast ${kind}`);
  const close = el('button', 'icon', '✕');
  close.title = 'Dismiss';
  close.addEventListener('click', () => node.remove());
  node.append(el('span', '', message), close);
  byId('toasts').append(node);
  setTimeout(() => node.remove(), kind === 'error' ? 10_000 : 4_000);
}

export function reportError(error: unknown): void {
  console.error(error);
  toast(cleanIpcError(error), 'error');
}
