/**
 * Keyboard encoding: a `KeyboardEvent`-shaped description in, the bytes xterm
 * would send out.
 *
 * Pure and DOM-free (it takes a plain `KeyInput`, not an event), so the whole
 * matrix is unit-testable and can be diffed against `showkey -a` output.
 *
 * The legacy ("modifyOtherKeys") encoding is what every TUI understands, so it
 * stays the default: Ctrl+C is 0x03, arrows are CSI A…D, and only combinations
 * the legacy scheme genuinely cannot express fall back to the `CSI 27;mod;cp~`
 * form — and then only when the application asked for it with XTMODKEYS. The
 * kitty keyboard protocol is a deliberate post-v1 item.
 */

import { isAltGraphText } from '../core/altgr';

/** What the encoder needs from a key event. */
export interface KeyInput {
  /** `KeyboardEvent.key`. */
  key: string;
  /** `KeyboardEvent.code` — tells the numeric keypad and AltGr characters apart. */
  code?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
  /**
   * `KeyboardEvent.getModifierState('AltGraph')`. Windows reports AltGr as
   * Ctrl+Alt; this (with `code`) is how its characters are told apart from
   * real Ctrl+Alt chords — see `core/altgr.ts`.
   */
  altGraph?: boolean;
}

/** Terminal state the encoding depends on (all of it from `Terminal.modes()`). */
export interface KeyEncodeState {
  /** DECCKM — arrows and Home/End switch from CSI to SS3. */
  applicationCursorKeys?: boolean;
  /** DECKPAM — the keypad sends SS3 sequences instead of digits. */
  applicationKeypad?: boolean;
  /** XTMODKEYS level: 0 off, 1 excludes shift-only, 2 includes it. */
  modifyOtherKeys?: number;
  /** Alt prefixes ESC (the Linux/Windows norm). Off = Alt is a compose key. */
  altSendsEscape?: boolean;
  /** Backspace sends DEL like xterm; off sends BS. Ctrl+Backspace sends the other. */
  backspaceSendsDelete?: boolean;
}

const ESC = '\x1b';
const CSI = '\x1b[';
const SS3 = '\x1bO';

/** Keys that only change how the *next* key encodes, and send nothing alone. */
const MODIFIER_KEYS = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'AltGraph',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Fn',
  'FnLock',
  'Hyper',
  'Super',
  'Symbol',
  'SymbolLock',
  // Composition in flight: the commit string arrives via a composition event.
  'Dead',
  'Process',
  'Unidentified',
]);

/** Cursor-ish keys: `CSI <final>` normally, `SS3 <final>` in application mode. */
const CURSOR_KEYS: Record<string, string> = {
  ArrowUp: 'A',
  ArrowDown: 'B',
  ArrowRight: 'C',
  ArrowLeft: 'D',
  Home: 'H',
  End: 'F',
  Clear: 'E',
};

/** Keys encoded as `CSI <n> ~`. */
const TILDE_KEYS: Record<string, number> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24,
  F13: 25,
  F14: 26,
  F15: 28,
  F16: 29,
  F17: 31,
  F18: 32,
  F19: 33,
  F20: 34,
};

/** F1–F4 are the VT100 PF keys: SS3, not CSI. */
const PF_KEYS: Record<string, string> = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' };

/**
 * Application-keypad finals, by `KeyboardEvent.code`. With NumLock off the
 * browser reports arrows/Home/End instead and the cursor-key path applies.
 */
const KEYPAD_KEYS: Record<string, string> = {
  Numpad0: 'p',
  Numpad1: 'q',
  Numpad2: 'r',
  Numpad3: 's',
  Numpad4: 't',
  Numpad5: 'u',
  Numpad6: 'v',
  Numpad7: 'w',
  Numpad8: 'x',
  Numpad9: 'y',
  NumpadDecimal: 'n',
  NumpadComma: 'l',
  NumpadEnter: 'M',
  NumpadAdd: 'k',
  NumpadSubtract: 'm',
  NumpadMultiply: 'j',
  NumpadDivide: 'o',
  NumpadEqual: 'X',
};

/**
 * Control codes for Ctrl+<char>, beyond the letters. The digit forms are
 * xterm's: Ctrl+2 is NUL, Ctrl+3…7 walk ESC…US, Ctrl+8 is DEL.
 */
const CONTROL_CHARS: Record<string, number> = {
  '@': 0x00,
  ' ': 0x00,
  '2': 0x00,
  '[': 0x1b,
  '3': 0x1b,
  '\\': 0x1c,
  '4': 0x1c,
  ']': 0x1d,
  '5': 0x1d,
  '^': 0x1e,
  '6': 0x1e,
  _: 0x1f,
  '7': 0x1f,
  '/': 0x1f,
  '8': 0x7f,
  '?': 0x7f,
};

/** The xterm modifier parameter: 1 + shift(1) + alt(2) + ctrl(4) + meta(8). */
export function modifierParam(input: KeyInput): number {
  return (
    1 + (input.shift ? 1 : 0) + (input.alt ? 2 : 0) + (input.ctrl ? 4 : 0) + (input.meta ? 8 : 0)
  );
}

function hasModifier(input: KeyInput): boolean {
  return Boolean(input.ctrl || input.alt || input.shift || input.meta);
}

/**
 * The `CSI 27 ; mod ; codepoint ~` form, for combinations the legacy encoding
 * cannot express — but only if the application enabled XTMODKEYS. Level 1
 * excludes shift-only modifications by definition; level 2 includes them.
 */
function otherKey(input: KeyInput, state: KeyEncodeState, codepoint: number): string | null {
  const level = state.modifyOtherKeys ?? 0;
  if (level === 0) return null;
  const shiftOnly = Boolean(input.shift) && !input.ctrl && !input.alt && !input.meta;
  if (shiftOnly && level < 2) return null;
  return `${CSI}27;${modifierParam(input)};${codepoint}~`;
}

/** Alt as an ESC prefix, the encoding TUIs read as Meta. */
function withAlt(input: KeyInput, state: KeyEncodeState, sequence: string): string {
  return input.alt && (state.altSendsEscape ?? true) ? ESC + sequence : sequence;
}

function encodeCursorKey(final: string, input: KeyInput, state: KeyEncodeState): string {
  const mod = modifierParam(input);
  // A modified cursor key is always CSI, even in application-cursor mode —
  // there is no SS3 form that carries a parameter.
  if (mod > 1) return `${CSI}1;${mod}${final}`;
  return state.applicationCursorKeys ? SS3 + final : CSI + final;
}

function encodeEnter(input: KeyInput, state: KeyEncodeState): string {
  if (state.applicationKeypad && input.code === 'NumpadEnter' && !hasModifier(input)) {
    return `${SS3}M`;
  }
  // Ctrl/Shift+Enter have no legacy encoding — apps that care ask for XTMODKEYS.
  if (input.ctrl || input.shift || input.meta) {
    const other = otherKey(input, state, 13);
    if (other) return other;
  }
  return withAlt(input, state, '\r');
}

function encodeTab(input: KeyInput, state: KeyEncodeState): string {
  if (input.shift && !input.ctrl && !input.alt && !input.meta) return `${CSI}Z`;
  if (input.ctrl || input.shift || input.meta) {
    const other = otherKey(input, state, 9);
    if (other) return other;
  }
  return withAlt(input, state, '\t');
}

function encodeBackspace(input: KeyInput, state: KeyEncodeState): string {
  const del = state.backspaceSendsDelete ?? true;
  // Ctrl+Backspace sends whichever of DEL/BS plain Backspace does not, the
  // convention that lets shells bind "delete word" to it.
  const base = input.ctrl ? (del ? '\x08' : '\x7f') : del ? '\x7f' : '\x08';
  return withAlt(input, state, base);
}

function encodeEscape(input: KeyInput, state: KeyEncodeState): string {
  if (input.ctrl || input.shift || input.meta) {
    const other = otherKey(input, state, 27);
    if (other) return other;
  }
  return withAlt(input, state, ESC);
}

/** Ctrl+<printable>, or null when the pair has no control code. */
function controlCode(key: string): number | null {
  const lower = key.toLowerCase();
  if (lower.length === 1 && lower >= 'a' && lower <= 'z') return lower.charCodeAt(0) - 0x60;
  return CONTROL_CHARS[key] ?? null;
}

function encodePrintable(input: KeyInput, state: KeyEncodeState): string | null {
  const key = input.key;
  const codepoint = key.codePointAt(0) ?? 0;

  // AltGr arrives as Ctrl+Alt on Windows, but the key is the character the
  // layout typed (German AltGr+Q is "@"): text, not a Meta+Ctrl chord.
  if (isAltGraphText(input)) return key;

  // Cmd on macOS is the application's modifier, never the shell's; anything
  // the app keymap did not claim is dropped rather than mis-sent.
  if (input.meta && !input.ctrl) {
    return otherKey(input, state, codepoint);
  }

  if (input.ctrl) {
    const code = controlCode(key);
    if (code !== null) return withAlt(input, state, String.fromCharCode(code));
    // Ctrl+; and friends: only expressible with XTMODKEYS, else send the key
    // itself, which is what xterm does with modifyOtherKeys off.
    return otherKey(input, state, codepoint) ?? withAlt(input, state, key);
  }

  if (input.shift) {
    // `key` already carries the shifted character; only level 2 reports it.
    const other = otherKey(input, state, codepoint);
    if (other) return other;
  }

  return withAlt(input, state, key);
}

/**
 * The bytes (as a string; the caller UTF-8 encodes) for one key press, or null
 * when the key sends nothing — a bare modifier, an IME-owned key, or a
 * shortcut the terminal has no encoding for.
 */
export function encodeKey(input: KeyInput, state: KeyEncodeState = {}): string | null {
  const key = input.key;
  if (key === '' || MODIFIER_KEYS.has(key)) return null;

  if (key === 'Enter') return encodeEnter(input, state);
  if (key === 'Tab') return encodeTab(input, state);
  if (key === 'Backspace') return encodeBackspace(input, state);
  if (key === 'Escape') return encodeEscape(input, state);

  const cursor = CURSOR_KEYS[key];
  if (cursor !== undefined) return encodeCursorKey(cursor, input, state);

  const pf = PF_KEYS[key];
  if (pf !== undefined) {
    const mod = modifierParam(input);
    return mod > 1 ? `${CSI}1;${mod}${pf}` : SS3 + pf;
  }

  const tilde = TILDE_KEYS[key];
  if (tilde !== undefined) {
    const mod = modifierParam(input);
    return mod > 1 ? `${CSI}${tilde};${mod}~` : `${CSI}${tilde}~`;
  }

  // The keypad in application mode, when the browser reports its digits.
  if (state.applicationKeypad && input.code && !hasModifier(input)) {
    const keypad = KEYPAD_KEYS[input.code];
    if (keypad !== undefined && [...key].length === 1) return SS3 + keypad;
  }

  // A single character — a printable, or an astral one from an IME/emoji picker.
  if ([...key].length === 1) return encodePrintable(input, state);

  return null;
}

/** `Terminal.modes()` (plus settings) → the encoder's state. */
export function keyStateFromModes(
  modes: { applicationCursorKeys: boolean; applicationKeypad: boolean; modifyOtherKeys: number },
  options: Pick<KeyEncodeState, 'altSendsEscape' | 'backspaceSendsDelete'> = {},
): KeyEncodeState {
  return {
    applicationCursorKeys: modes.applicationCursorKeys,
    applicationKeypad: modes.applicationKeypad,
    modifyOtherKeys: modes.modifyOtherKeys,
    ...options,
  };
}
