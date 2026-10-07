/**
 * AltGr detection: is this key event a character typed with AltGr, or a real
 * Ctrl+Alt chord?
 *
 * Windows reports AltGr to the web view as Ctrl+Alt — `ctrlKey` and `altKey`
 * are both true — while `key` is the character the layout produced: German
 * AltGr+Q arrives as Ctrl+Alt+"@". Anything that treats that as a chord eats
 * `@ { } [ ] \ | ~ €` on German, French, Spanish, Nordic, Polish… layouts.
 * (On Linux AltGr arrives without Ctrl or Alt and on macOS Option is Alt
 * alone, so neither ever looks like this.)
 *
 * The rule, for a Ctrl+Alt event without Meta whose `key` is one printable
 * character:
 *   - an ASCII letter or a space is always a chord (no layout's AltGr types a
 *     bare a–z, and German Ctrl+Alt+Z sits on the US Y key);
 *   - otherwise, if the browser reports the AltGraph modifier state
 *     (`getModifierState('AltGraph')`, which Chromium sets for AltGr on
 *     Windows), it is AltGr text;
 *   - otherwise it is a chord only when `key` is what the same physical key
 *     types on a US layout (with the Shift state held) — what a browser
 *     reports for a Ctrl+Alt press the layout has no AltGr character for.
 *     Anything else is AltGr text.
 *
 * The last rule is a fallback: it misreads AltGr characters that sit on the
 * US key for the same character (Swiss/Spanish/Italian `[` `]` are on the US
 * bracket keys) when the AltGraph state is not reported.
 *
 * Pure and DOM-free: callers pass the event's fields, not the event.
 */

export interface AltGraphKeyInput {
  /** `KeyboardEvent.key`. */
  key: string;
  /** `KeyboardEvent.code` — the physical key. */
  code?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
  /** `KeyboardEvent.getModifierState('AltGraph')`. */
  altGraph?: boolean;
}

/** What each physical key types on a US layout: [unshifted, shifted]. */
const US_LAYOUT: Record<string, readonly [string, string]> = {
  Backquote: ['`', '~'],
  Digit1: ['1', '!'],
  Digit2: ['2', '@'],
  Digit3: ['3', '#'],
  Digit4: ['4', '$'],
  Digit5: ['5', '%'],
  Digit6: ['6', '^'],
  Digit7: ['7', '&'],
  Digit8: ['8', '*'],
  Digit9: ['9', '('],
  Digit0: ['0', ')'],
  Minus: ['-', '_'],
  Equal: ['=', '+'],
  BracketLeft: ['[', '{'],
  BracketRight: [']', '}'],
  Backslash: ['\\', '|'],
  Semicolon: [';', ':'],
  Quote: ["'", '"'],
  Comma: [',', '<'],
  Period: ['.', '>'],
  Slash: ['/', '?'],
};

/** Every character a US-layout Ctrl+Alt chord can report, for code-less input. */
const US_CHARS = new Set(Object.values(US_LAYOUT).flat());

function isPrintableChar(key: string): boolean {
  if ([...key].length !== 1) return false;
  const cp = key.codePointAt(0) ?? 0;
  return cp >= 0x20 && cp !== 0x7f && !(cp >= 0x80 && cp < 0xa0);
}

/** True when the event is a character typed with AltGr, to be sent as text. */
export function isAltGraphText(input: AltGraphKeyInput): boolean {
  if (!input.ctrl || !input.alt || input.meta) return false;
  const key = input.key;
  if (!isPrintableChar(key)) return false;
  if (key === ' ' || /^[a-z]$/i.test(key)) return false;
  if (input.altGraph) return true;

  const code = input.code;
  if (!code) return !US_CHARS.has(key);
  // The numeric keypad has no AltGr layer.
  if (code.startsWith('Numpad')) return false;
  const us = US_LAYOUT[code];
  return us === undefined || us[input.shift ? 1 : 0] !== key;
}
