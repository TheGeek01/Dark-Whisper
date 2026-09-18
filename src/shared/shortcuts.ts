// Global shortcuts: the four actions, their defaults, and the rules both the Settings dialog
// (capturing keys) and main (registering them with Electron) use. Shortcuts are Electron
// accelerators with modifiers in a fixed order, e.g. "Ctrl+Alt+R"; "" means none.

export type ShortcutAction = 'quickNote' | 'record' | 'pause' | 'stop';
export type ShortcutResult = 'ok' | 'none' | 'taken' | 'duplicate' | 'invalid';

export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = ['quickNote', 'record', 'pause', 'stop'];

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  quickNote: 'Ctrl+Q',
  record: 'Ctrl+Alt+R',
  pause: 'Ctrl+Alt+P',
  stop: 'Ctrl+Alt+S',
};

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  quickNote: 'Quick Notes',
  record: 'Record / New Session',
  pause: 'Pause / Resume',
  stop: 'Stop',
};

// The setting each shortcut is stored in ("shortcut" predates the others).
export const SHORTCUT_SETTINGS = {
  quickNote: 'shortcut',
  record: 'recordShortcut',
  pause: 'pauseShortcut',
  stop: 'stopShortcut',
} as const satisfies Record<ShortcutAction, string>;

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Super'];
const MODIFIERS: Record<string, string> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  cmdorctrl: 'Ctrl',
  commandorcontrol: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super',
  win: 'Super',
};
const NAMED_KEYS = ['Space', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Backspace'];

function normalizeKey(key: string): string | null {
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase();
  const fKey = /^f([1-9]|1\d|2[0-4])$/i.exec(key);
  if (fKey) return `F${fKey[1]}`;
  return NAMED_KEYS.find((name) => name.toLowerCase() === key.toLowerCase()) ?? null;
}

// "alt+ctrl+r" and "Ctrl+Alt+R" are the same shortcut. Null when the text is not one.
export function normalizeShortcut(text: string): string | null {
  const parts = text
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const modifiers = new Set<string>();
  let key: string | null = null;
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (modifier) {
      modifiers.add(modifier);
      continue;
    }
    if (key !== null) return null;
    key = normalizeKey(part);
    if (key === null) return null;
  }
  if (key === null) return null;
  return [...MODIFIER_ORDER.filter((m) => modifiers.has(m)), key].join('+');
}

// A global shortcut takes its keys away from every other app, so it must never be plain typing.
export function shortcutProblem(text: string): string | null {
  const shortcut = normalizeShortcut(text);
  if (shortcut === null) return 'Not a key combination';
  const parts = shortcut.split('+');
  const key = parts[parts.length - 1];
  if (/^F\d+$/.test(key)) return null;
  if (!parts.slice(0, -1).some((modifier) => modifier !== 'Shift')) return 'Add Ctrl, Alt or Win';
  return null;
}

export function displayShortcut(shortcut: string): string {
  return shortcut === '' ? 'None' : shortcut.replace(/\bSuper\b/g, 'Win');
}

export interface KeyPress {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export type CaptureResult =
  | { kind: 'set'; shortcut: string }
  | { kind: 'cancel' }
  | { kind: 'clear' }
  | { kind: 'wait' }
  | { kind: 'reject'; reason: string };

const CODE_KEYS: Record<string, string> = {
  Space: 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  Delete: 'Delete',
  Backspace: 'Backspace',
};
const MODIFIER_CODE = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;

// Letters and digits come from the character typed, so a shortcut follows the keyboard layout;
// when a modifier changes the character (Shift+1 types "!"), the key's position is used instead.
function keyName(press: KeyPress): string | null {
  if (/^[a-z0-9]$/i.test(press.key)) return press.key.toUpperCase();
  const position = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(press.code);
  if (position) return position[1] ?? position[2];
  if (/^F([1-9]|1\d|2[0-4])$/.test(press.code)) return press.code;
  return CODE_KEYS[press.code] ?? null;
}

// One keydown in a shortcut field of the Settings dialog.
export function captureShortcut(press: KeyPress): CaptureResult {
  const modified = press.ctrlKey || press.altKey || press.shiftKey || press.metaKey;
  if (!modified && press.key === 'Escape') return { kind: 'cancel' };
  if (!modified && (press.key === 'Backspace' || press.key === 'Delete')) return { kind: 'clear' };
  if (MODIFIER_CODE.test(press.code)) return { kind: 'wait' };
  const key = keyName(press);
  if (key === null) return { kind: 'reject', reason: 'That key cannot be used' };
  const shortcut = [
    ...(press.ctrlKey ? ['Ctrl'] : []),
    ...(press.altKey ? ['Alt'] : []),
    ...(press.shiftKey ? ['Shift'] : []),
    ...(press.metaKey ? ['Super'] : []),
    key,
  ].join('+');
  const problem = shortcutProblem(shortcut);
  return problem ? { kind: 'reject', reason: problem } : { kind: 'set', shortcut };
}
