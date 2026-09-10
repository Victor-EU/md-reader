/**
 * Keyboard bindings for the command registry. A binding is written once,
 * platform independent: `Mod` is Cmd on macOS and Ctrl elsewhere, which is
 * how design 4.1 states every shortcut.
 */
export interface Binding {
  /** `KeyboardEvent.code` when the key has a stable physical name. */
  code: string | null;
  /** `KeyboardEvent.key` for named keys, or the literal character. */
  key: string;
  /** Cmd on macOS, Ctrl elsewhere. */
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** The literal Control key, which on macOS is not the modifier. */
  ctrl: boolean;
}

const punctuation: Record<string, string> = {
  '[': 'BracketLeft',
  ']': 'BracketRight',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  '`': 'Backquote',
  '-': 'Minus',
  '=': 'Equal',
};

/**
 * The physical key for a binding's key name. Letters, digits, and
 * punctuation are matched by `code` so that Cmd+Shift+[ still matches when
 * the shifted character is `{`, and so a non-US layout does not change what
 * the keymap means.
 */
function codeFor(key: string): string | null {
  if (/^[A-Za-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (key === 'Space') return 'Space';
  return punctuation[key] ?? null;
}

export function parseBinding(spec: string): Binding {
  const parts = spec.split('+');
  const key = parts.pop() ?? '';
  if (key === '') throw new Error(`binding has no key: ${spec}`);
  const binding: Binding = {
    code: codeFor(key),
    key,
    mod: false,
    shift: false,
    alt: false,
    ctrl: false,
  };
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case 'mod':
      case 'cmd':
      case 'meta':
        binding.mod = true;
        break;
      case 'ctrl':
      case 'control':
        binding.ctrl = true;
        break;
      case 'shift':
        binding.shift = true;
        break;
      case 'alt':
      case 'option':
        binding.alt = true;
        break;
      default:
        throw new Error(`unknown modifier ${part} in ${spec}`);
    }
  }
  return binding;
}

interface Modifiers {
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

/** What the event's modifier flags have to be for this binding, on this platform. */
function wanted(binding: Binding, mac: boolean): Modifiers {
  return {
    meta: mac ? binding.mod : false,
    ctrl: mac ? binding.ctrl : binding.mod || binding.ctrl,
    shift: binding.shift,
    alt: binding.alt,
  };
}

export function bindingMatches(binding: Binding, event: KeyboardEvent, mac: boolean): boolean {
  const want = wanted(binding, mac);
  if (
    want.meta !== event.metaKey ||
    want.ctrl !== event.ctrlKey ||
    want.shift !== event.shiftKey ||
    want.alt !== event.altKey
  ) {
    return false;
  }
  // `code` is empty for synthetic events and for IME composition; the key
  // name is the fallback, compared case-insensitively because Shift changes it.
  if (binding.code && event.code) return binding.code === event.code;
  return binding.key.toLowerCase() === event.key.toLowerCase();
}

const symbols: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Enter: '↵',
  Escape: 'Esc',
  Space: '␣',
};

/** The shortcut as the palette and the menus show it. */
export function formatBinding(binding: Binding, mac: boolean): string {
  const key = symbols[binding.key] ?? binding.key.toUpperCase();
  const want = wanted(binding, mac);
  if (mac) {
    return `${want.ctrl ? '⌃' : ''}${want.alt ? '⌥' : ''}${want.shift ? '⇧' : ''}${
      want.meta ? '⌘' : ''
    }${key}`;
  }
  const parts = [];
  if (want.ctrl) parts.push('Ctrl');
  if (want.alt) parts.push('Alt');
  if (want.shift) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/**
 * The shortcut as the menu bar wants it: Tauri's accelerator spelling,
 * whose key names are the `code` names a binding already carries, so
 * Cmd+Shift+[ is the same physical key in the menu as in the keymap.
 *
 * A binding with no code — a named key like Escape — gives its key name,
 * which is the same word in both vocabularies.
 */
export function acceleratorFor(binding: Binding, mac: boolean): string {
  const want = wanted(binding, mac);
  const parts: string[] = [];
  if (want.meta) parts.push('Command');
  if (want.ctrl) parts.push('Control');
  if (want.alt) parts.push('Alt');
  if (want.shift) parts.push('Shift');
  parts.push(binding.code ?? binding.key);
  return parts.join('+');
}
