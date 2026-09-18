import { normalizeShortcut, SHORTCUT_ACTIONS, ShortcutAction, shortcutProblem, ShortcutResult } from '../shared/shortcuts';

// Electron's globalShortcut, injected so the rules can be tested without Electron.
export interface ShortcutDeps {
  register(accelerator: string, handler: () => void): boolean;
  unregisterAll(): void;
}

// Replaces every registered shortcut. The first action keeps a combination two actions share;
// register() returns false when another app already holds it.
export function registerShortcuts(
  deps: ShortcutDeps,
  bindings: Record<ShortcutAction, string>,
  handlers: Record<ShortcutAction, () => void>,
): Record<ShortcutAction, ShortcutResult> {
  deps.unregisterAll();
  const used = new Set<string>();
  const results = {} as Record<ShortcutAction, ShortcutResult>;
  for (const action of SHORTCUT_ACTIONS) {
    const text = bindings[action].trim();
    if (text === '') {
      results[action] = 'none';
      continue;
    }
    const shortcut = normalizeShortcut(text);
    if (shortcut === null || shortcutProblem(shortcut) !== null) {
      results[action] = 'invalid';
      continue;
    }
    if (used.has(shortcut)) {
      results[action] = 'duplicate';
      continue;
    }
    used.add(shortcut);
    try {
      results[action] = deps.register(shortcut, handlers[action]) ? 'ok' : 'taken';
    } catch (error) {
      console.error(`Could not register the shortcut ${shortcut}:`, error);
      results[action] = 'invalid';
    }
  }
  return results;
}
