import { registerShortcuts, ShortcutDeps } from '../services/shortcutRegistry';
import {
  captureShortcut,
  DEFAULT_SHORTCUTS,
  displayShortcut,
  KeyPress,
  normalizeShortcut,
  shortcutProblem,
  ShortcutAction,
} from '../shared/shortcuts';

const press = (overrides: Partial<KeyPress>): KeyPress => ({
  key: '',
  code: '',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...overrides,
});

describe('normalizeShortcut', () => {
  it('orders modifiers and capitalises keys', () => {
    expect(normalizeShortcut('alt+ctrl+r')).toBe('Ctrl+Alt+R');
    expect(normalizeShortcut(' Ctrl + Shift + f9 ')).toBe('Ctrl+Shift+F9');
    expect(normalizeShortcut('Super+Space')).toBe('Super+Space');
    expect(normalizeShortcut('CommandOrControl+Q')).toBe('Ctrl+Q');
  });

  it('rejects what is not a key combination', () => {
    expect(normalizeShortcut('')).toBeNull();
    expect(normalizeShortcut('Ctrl+Alt')).toBeNull();
    expect(normalizeShortcut('Ctrl+R+T')).toBeNull();
    expect(normalizeShortcut('Ctrl+Banana')).toBeNull();
  });
});

describe('shortcutProblem', () => {
  it('keeps plain typing free: a key needs Ctrl, Alt or Win unless it is an F-key', () => {
    expect(shortcutProblem('Ctrl+Alt+R')).toBeNull();
    expect(shortcutProblem('Super+R')).toBeNull();
    expect(shortcutProblem('F9')).toBeNull();
    expect(shortcutProblem('Shift+F10')).toBeNull();
    expect(shortcutProblem('R')).toMatch(/Ctrl, Alt or Win/);
    expect(shortcutProblem('Shift+R')).toMatch(/Ctrl, Alt or Win/);
    expect(shortcutProblem('nonsense')).not.toBeNull();
  });

  it('accepts every default', () => {
    for (const value of Object.values(DEFAULT_SHORTCUTS)) expect(shortcutProblem(value)).toBeNull();
  });
});

describe('displayShortcut', () => {
  it('names the Windows key and an empty shortcut', () => {
    expect(displayShortcut('Super+Shift+D')).toBe('Win+Shift+D');
    expect(displayShortcut('')).toBe('None');
  });
});

describe('captureShortcut', () => {
  it('records a combination', () => {
    expect(captureShortcut(press({ key: 'r', code: 'KeyR', ctrlKey: true, altKey: true }))).toEqual({
      kind: 'set',
      shortcut: 'Ctrl+Alt+R',
    });
    expect(captureShortcut(press({ key: 'F9', code: 'F9' }))).toEqual({ kind: 'set', shortcut: 'F9' });
    expect(captureShortcut(press({ key: 'ArrowUp', code: 'ArrowUp', metaKey: true }))).toEqual({
      kind: 'set',
      shortcut: 'Super+Up',
    });
  });

  it('uses the key as typed, falling back to its position when a modifier changes the character', () => {
    // AZERTY: the key in the QWERTY "Q" position types "a".
    expect(captureShortcut(press({ key: 'a', code: 'KeyQ', ctrlKey: true, altKey: true }))).toEqual({
      kind: 'set',
      shortcut: 'Ctrl+Alt+A',
    });
    // Shift+1 types "!"; the shortcut is still Shift+1.
    expect(captureShortcut(press({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }))).toEqual({
      kind: 'set',
      shortcut: 'Ctrl+Shift+1',
    });
  });

  it('cancels on Esc, clears on Backspace or Delete, and waits while only modifiers are held', () => {
    expect(captureShortcut(press({ key: 'Escape', code: 'Escape' }))).toEqual({ kind: 'cancel' });
    expect(captureShortcut(press({ key: 'Backspace', code: 'Backspace' }))).toEqual({ kind: 'clear' });
    expect(captureShortcut(press({ key: 'Delete', code: 'Delete' }))).toEqual({ kind: 'clear' });
    expect(captureShortcut(press({ key: 'Control', code: 'ControlLeft', ctrlKey: true }))).toEqual({ kind: 'wait' });
    expect(captureShortcut(press({ key: 'Alt', code: 'AltLeft', ctrlKey: true, altKey: true }))).toEqual({ kind: 'wait' });
  });

  it('refuses plain typing and keys it cannot name', () => {
    expect(captureShortcut(press({ key: 'r', code: 'KeyR' }))).toMatchObject({ kind: 'reject' });
    expect(captureShortcut(press({ key: 'R', code: 'KeyR', shiftKey: true }))).toMatchObject({ kind: 'reject' });
    expect(captureShortcut(press({ key: '/', code: 'NumpadDivide', ctrlKey: true }))).toMatchObject({ kind: 'reject' });
  });
});

describe('registerShortcuts', () => {
  const bindings: Record<ShortcutAction, string> = {
    quickNote: 'Ctrl+Q',
    record: 'ctrl+alt+r',
    pause: 'Ctrl+Alt+P',
    stop: 'Ctrl+Alt+S',
  };
  const handlers = { quickNote: jest.fn(), record: jest.fn(), pause: jest.fn(), stop: jest.fn() };

  function deps(taken: string[] = []): ShortcutDeps & { registered: Map<string, () => void>; cleared: number } {
    const registered = new Map<string, () => void>();
    const d = {
      registered,
      cleared: 0,
      register: (accelerator: string, handler: () => void) => {
        if (taken.includes(accelerator)) return false;
        registered.set(accelerator, handler);
        return true;
      },
      unregisterAll: () => {
        registered.clear();
        d.cleared++;
      },
    };
    return d;
  }

  it('registers every shortcut, normalised, after clearing the old ones', () => {
    const d = deps();
    expect(registerShortcuts(d, bindings, handlers)).toEqual({ quickNote: 'ok', record: 'ok', pause: 'ok', stop: 'ok' });
    expect(d.cleared).toBe(1);
    expect([...d.registered.keys()]).toEqual(['Ctrl+Q', 'Ctrl+Alt+R', 'Ctrl+Alt+P', 'Ctrl+Alt+S']);
    d.registered.get('Ctrl+Alt+R')!();
    expect(handlers.record).toHaveBeenCalled();
  });

  it('reports shortcuts another app holds, duplicates, invalid ones and empty ones', () => {
    const d = deps(['Ctrl+Alt+P']);
    const result = registerShortcuts(d, { quickNote: '', record: 'Ctrl+Alt+R', pause: 'Ctrl+Alt+P', stop: 'Alt+Ctrl+R' }, handlers);
    expect(result).toEqual({ quickNote: 'none', record: 'ok', pause: 'taken', stop: 'duplicate' });
    expect(registerShortcuts(deps(), { ...bindings, record: 'R' }, handlers).record).toBe('invalid');
  });

  it('treats a shortcut Electron refuses to parse as invalid', () => {
    const d = deps();
    d.register = () => {
      throw new Error('conversion failure');
    };
    expect(registerShortcuts(d, bindings, handlers).quickNote).toBe('invalid');
  });
});
