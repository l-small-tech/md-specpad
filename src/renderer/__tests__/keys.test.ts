import { describe, expect, it } from 'vitest';
import { encodeKey, keyStateFromModes, modifierParam, type KeyEncodeState } from '../keys';

/** Terse chord notation: `key(...)` mirrors what a browser reports. */
const key = (
  k: string,
  mods: Partial<Record<'ctrl' | 'alt' | 'shift' | 'meta', boolean>> = {},
) => ({
  key: k,
  ...mods,
});

const enc = (input: Parameters<typeof encodeKey>[0], state: KeyEncodeState = {}) =>
  encodeKey(input, state);

describe('printable keys', () => {
  it('sends the character as typed', () => {
    expect(enc(key('a'))).toBe('a');
    expect(enc(key('A', { shift: true }))).toBe('A');
    expect(enc(key('€'))).toBe('€');
    expect(enc(key('🙂'))).toBe('🙂');
  });

  it('sends nothing for bare modifiers and IME placeholders', () => {
    for (const name of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Process']) {
      expect(enc(key(name))).toBeNull();
    }
  });

  it('ignores unknown named keys rather than sending their name', () => {
    expect(enc(key('AudioVolumeUp'))).toBeNull();
    expect(enc(key('ContextMenu'))).toBeNull();
  });
});

describe('control combinations', () => {
  it('maps Ctrl+letter to its control code', () => {
    expect(enc(key('c', { ctrl: true }))).toBe('\x03');
    expect(enc(key('a', { ctrl: true }))).toBe('\x01');
    expect(enc(key('z', { ctrl: true }))).toBe('\x1a');
    // Shift does not change the control code (Ctrl+Shift+C is still ETX here;
    // the app keymap claims it before the encoder ever sees it).
    expect(enc(key('C', { ctrl: true, shift: true }))).toBe('\x03');
  });

  it('maps the punctuation and digit control codes xterm sends', () => {
    expect(enc(key(' ', { ctrl: true }))).toBe('\x00');
    expect(enc(key('@', { ctrl: true }))).toBe('\x00');
    expect(enc(key('[', { ctrl: true }))).toBe('\x1b');
    expect(enc(key('\\', { ctrl: true }))).toBe('\x1c');
    expect(enc(key(']', { ctrl: true }))).toBe('\x1d');
    expect(enc(key('_', { ctrl: true }))).toBe('\x1f');
    expect(enc(key('/', { ctrl: true }))).toBe('\x1f');
    expect(enc(key('?', { ctrl: true }))).toBe('\x7f');
    expect(enc(key('2', { ctrl: true }))).toBe('\x00');
    expect(enc(key('6', { ctrl: true }))).toBe('\x1e');
  });

  it('falls back to the plain key when a Ctrl pair has no control code', () => {
    expect(enc(key('1', { ctrl: true }))).toBe('1');
    expect(enc(key(';', { ctrl: true }))).toBe(';');
  });

  it('prefixes ESC for Alt, and for Ctrl+Alt', () => {
    expect(enc(key('a', { alt: true }))).toBe('\x1ba');
    expect(enc(key('c', { ctrl: true, alt: true }))).toBe('\x1b\x03');
  });

  it('leaves Alt alone when it is configured as a compose key', () => {
    expect(enc(key('a', { alt: true }), { altSendsEscape: false })).toBe('a');
  });

  it('drops unclaimed Cmd chords rather than sending the bare letter', () => {
    expect(enc(key('a', { meta: true }))).toBeNull();
  });
});

describe('the named editing keys', () => {
  it('encodes Enter, Tab, Escape and Backspace', () => {
    expect(enc(key('Enter'))).toBe('\r');
    expect(enc(key('Tab'))).toBe('\t');
    expect(enc(key('Tab', { shift: true }))).toBe('\x1b[Z');
    expect(enc(key('Escape'))).toBe('\x1b');
    expect(enc(key('Backspace'))).toBe('\x7f');
  });

  it('sends BS for Ctrl+Backspace, and honors the DEL setting', () => {
    expect(enc(key('Backspace', { ctrl: true }))).toBe('\x08');
    expect(enc(key('Backspace'), { backspaceSendsDelete: false })).toBe('\x08');
    expect(enc(key('Backspace', { ctrl: true }), { backspaceSendsDelete: false })).toBe('\x7f');
  });

  it('prefixes ESC for Alt+Enter and Alt+Backspace', () => {
    expect(enc(key('Enter', { alt: true }))).toBe('\x1b\r');
    expect(enc(key('Backspace', { alt: true }))).toBe('\x1b\x7f');
  });

  it('encodes Delete and the paging keys as CSI ~ sequences', () => {
    expect(enc(key('Delete'))).toBe('\x1b[3~');
    expect(enc(key('Insert'))).toBe('\x1b[2~');
    expect(enc(key('PageUp'))).toBe('\x1b[5~');
    expect(enc(key('PageDown'))).toBe('\x1b[6~');
    expect(enc(key('Delete', { ctrl: true }))).toBe('\x1b[3;5~');
  });
});

describe('cursor keys', () => {
  it('uses CSI in normal mode and SS3 in application mode', () => {
    expect(enc(key('ArrowUp'))).toBe('\x1b[A');
    expect(enc(key('ArrowLeft'))).toBe('\x1b[D');
    expect(enc(key('Home'))).toBe('\x1b[H');
    expect(enc(key('End'))).toBe('\x1b[F');

    const app: KeyEncodeState = { applicationCursorKeys: true };
    expect(enc(key('ArrowUp'), app)).toBe('\x1bOA');
    expect(enc(key('End'), app)).toBe('\x1bOF');
  });

  it('falls back to the parameterized CSI form when modified', () => {
    expect(enc(key('ArrowUp', { shift: true }))).toBe('\x1b[1;2A');
    expect(enc(key('ArrowRight', { ctrl: true }))).toBe('\x1b[1;5C');
    expect(enc(key('ArrowLeft', { alt: true }))).toBe('\x1b[1;3D');
    // Application mode has no parameterized SS3 form, so CSI wins there too.
    expect(enc(key('ArrowUp', { ctrl: true }), { applicationCursorKeys: true })).toBe('\x1b[1;5A');
  });

  it('composes the modifier parameter the way xterm does', () => {
    expect(modifierParam(key('x'))).toBe(1);
    expect(modifierParam(key('x', { shift: true }))).toBe(2);
    expect(modifierParam(key('x', { alt: true }))).toBe(3);
    expect(modifierParam(key('x', { ctrl: true }))).toBe(5);
    expect(modifierParam(key('x', { ctrl: true, shift: true, alt: true, meta: true }))).toBe(16);
  });
});

describe('function keys', () => {
  it('sends F1–F4 as SS3 and F5 up as CSI ~', () => {
    expect(enc(key('F1'))).toBe('\x1bOP');
    expect(enc(key('F4'))).toBe('\x1bOS');
    expect(enc(key('F5'))).toBe('\x1b[15~');
    expect(enc(key('F12'))).toBe('\x1b[24~');
  });

  it('parameterizes modified function keys', () => {
    expect(enc(key('F1', { shift: true }))).toBe('\x1b[1;2P');
    expect(enc(key('F5', { ctrl: true }))).toBe('\x1b[15;5~');
  });
});

describe('the application keypad', () => {
  const app: KeyEncodeState = { applicationKeypad: true };

  it('sends SS3 finals for the keypad while DECKPAM is set', () => {
    expect(encodeKey({ key: '1', code: 'Numpad1' }, app)).toBe('\x1bOq');
    expect(encodeKey({ key: '+', code: 'NumpadAdd' }, app)).toBe('\x1bOk');
    expect(encodeKey({ key: '.', code: 'NumpadDecimal' }, app)).toBe('\x1bOn');
    expect(encodeKey({ key: 'Enter', code: 'NumpadEnter' }, app)).toBe('\x1bOM');
  });

  it('sends the plain characters in numeric mode', () => {
    expect(encodeKey({ key: '1', code: 'Numpad1' })).toBe('1');
    expect(encodeKey({ key: 'Enter', code: 'NumpadEnter' })).toBe('\r');
  });

  it('leaves the cursor keys to the cursor path when NumLock is off', () => {
    expect(encodeKey({ key: 'ArrowUp', code: 'Numpad8' }, app)).toBe('\x1b[A');
  });
});

describe('modifyOtherKeys', () => {
  const level = (modifyOtherKeys: number): KeyEncodeState => ({ modifyOtherKeys });

  it('reports combinations the legacy encoding cannot express', () => {
    expect(enc(key('Enter', { ctrl: true }), level(1))).toBe('\x1b[27;5;13~');
    expect(enc(key(';', { ctrl: true }), level(1))).toBe('\x1b[27;5;59~');
    expect(enc(key('Escape', { ctrl: true }), level(1))).toBe('\x1b[27;5;27~');
  });

  it('needs level 2 for shift-only modifications', () => {
    expect(enc(key('Enter', { shift: true }), level(1))).toBe('\r');
    expect(enc(key('Enter', { shift: true }), level(2))).toBe('\x1b[27;2;13~');
    expect(enc(key('Tab', { shift: true }), level(2))).toBe('\x1b[Z');
  });

  it('never touches the well-known control codes', () => {
    // Ctrl+C staying 0x03 at every level is the whole reason this is opt-in:
    // an interrupt that arrived as a CSI sequence would not interrupt.
    for (const l of [0, 1, 2]) {
      expect(enc(key('c', { ctrl: true }), level(l))).toBe('\x03');
      expect(enc(key('ArrowUp'), level(l))).toBe('\x1b[A');
    }
  });

  it('is off unless the application asks', () => {
    expect(enc(key('Enter', { ctrl: true }))).toBe('\r');
    expect(enc(key(';', { ctrl: true }))).toBe(';');
  });
});

describe('AltGr on non-US layouts', () => {
  // Windows reports AltGr as Ctrl+Alt (ctrlKey && altKey) while `key` is the
  // character the layout produced. Those are typed text, not Meta+Ctrl chords.
  const altGr = (k: string, code: string, extra: { shift?: boolean; altGraph?: boolean } = {}) => ({
    key: k,
    code,
    ctrl: true,
    alt: true,
    ...extra,
  });

  it('sends German AltGr characters as typed (Windows: Ctrl+Alt, no AltGraph flag)', () => {
    expect(enc(altGr('@', 'KeyQ'))).toBe('@');
    expect(enc(altGr('{', 'Digit7'))).toBe('{');
    expect(enc(altGr('[', 'Digit8'))).toBe('[');
    expect(enc(altGr(']', 'Digit9'))).toBe(']');
    expect(enc(altGr('}', 'Digit0'))).toBe('}');
    expect(enc(altGr('\\', 'Minus'))).toBe('\\');
    expect(enc(altGr('~', 'BracketRight'))).toBe('~');
    expect(enc(altGr('|', 'IntlBackslash'))).toBe('|');
    expect(enc(altGr('€', 'KeyE'))).toBe('€');
  });

  it('sends French AZERTY AltGr characters as typed', () => {
    expect(enc(altGr('~', 'Digit2'))).toBe('~');
    // US Shift+3 is '#', but Shift is not held, so this is AltGr+3, not a chord.
    expect(enc(altGr('#', 'Digit3'))).toBe('#');
    expect(enc(altGr('{', 'Digit4'))).toBe('{');
    expect(enc(altGr('[', 'Digit5'))).toBe('[');
    expect(enc(altGr('|', 'Digit6'))).toBe('|');
    expect(enc(altGr('\\', 'Digit8'))).toBe('\\');
    expect(enc(altGr('@', 'Digit0'))).toBe('@');
    expect(enc(altGr(']', 'Minus'))).toBe(']');
    expect(enc(altGr('}', 'Equal'))).toBe('}');
  });

  it('trusts the AltGraph modifier state for keys a US chord could also produce', () => {
    // Swiss German AltGr+ü / AltGr+¨ sit on the US [ and ] keys.
    expect(enc(altGr('[', 'BracketLeft', { altGraph: true }))).toBe('[');
    expect(enc(altGr(']', 'BracketRight', { altGraph: true }))).toBe(']');
  });

  it('ignores every other modifier setting for AltGr text', () => {
    expect(enc(altGr('@', 'KeyQ'), { altSendsEscape: false })).toBe('@');
    expect(enc(altGr('@', 'KeyQ'), { modifyOtherKeys: 2 })).toBe('@');
    expect(enc(altGr('{', 'Digit7', { shift: true }), { modifyOtherKeys: 2 })).toBe('{');
  });

  it('keeps real Ctrl+Alt chords on a US layout exactly as before', () => {
    expect(enc(altGr('a', 'KeyA'))).toBe('\x1b\x01');
    expect(enc(altGr('c', 'KeyC'))).toBe('\x1b\x03');
    expect(enc(altGr('[', 'BracketLeft'))).toBe('\x1b\x1b');
    expect(enc(altGr(']', 'BracketRight'))).toBe('\x1b\x1d');
    expect(enc(altGr('\\', 'Backslash'))).toBe('\x1b\x1c');
    expect(enc(altGr('/', 'Slash'))).toBe('\x1b\x1f');
    expect(enc(altGr('2', 'Digit2'))).toBe('\x1b\x00');
    expect(enc(altGr(' ', 'Space'))).toBe('\x1b\x00');
    expect(enc(altGr('-', 'Minus'))).toBe('\x1b-');
    // Shifted: Ctrl+Alt+Shift+2 reports '@', which US Shift+2 produces.
    expect(enc(altGr('@', 'Digit2', { shift: true }))).toBe('\x1b\x00');
    expect(enc(altGr('_', 'Minus', { shift: true }))).toBe('\x1b\x1f');
    expect(enc(altGr('Backspace', 'Backspace'))).toBe('\x1b\x08');
    expect(enc(altGr('ArrowUp', 'ArrowUp'))).toBe('\x1b[1;7A');
  });

  it('keeps Ctrl+Alt+letter a chord on any layout, AltGraph flag or not', () => {
    // German Ctrl+Alt+Z sits on the US Y key; French Ctrl+Alt+A on the US Q key.
    expect(enc(altGr('z', 'KeyY'))).toBe('\x1b\x1a');
    expect(enc(altGr('a', 'KeyQ'))).toBe('\x1b\x01');
    expect(enc(altGr('a', 'KeyA', { altGraph: true }))).toBe('\x1b\x01');
  });

  it('falls back to the chord when a key event carries no code', () => {
    expect(enc(key('[', { ctrl: true, alt: true }))).toBe('\x1b\x1b');
    expect(enc(key('@', { ctrl: true, alt: true }))).toBe('\x1b\x00');
    expect(enc(key('€', { ctrl: true, alt: true }))).toBe('€');
  });

  it('leaves Cmd chords, dead keys and Alt-only keys alone', () => {
    // Cmd/Win held as well: not AltGr, so the chord encodes as it always did.
    expect(enc({ ...altGr('@', 'KeyQ'), meta: true })).toBe('\x1b\x00');
    expect(enc(altGr('Dead', 'BracketRight'))).toBeNull();
    // Alt without Ctrl is Meta (or macOS Option-as-Meta), never AltGr.
    expect(enc({ key: '@', code: 'KeyQ', alt: true })).toBe('\x1b@');
    expect(enc({ key: '@', code: 'KeyQ', alt: true, altGraph: true })).toBe('\x1b@');
  });
});

describe('keyStateFromModes', () => {
  it('carries the engine modes and the settings through', () => {
    const state = keyStateFromModes(
      { applicationCursorKeys: true, applicationKeypad: false, modifyOtherKeys: 2 },
      { altSendsEscape: false },
    );
    expect(state).toEqual({
      applicationCursorKeys: true,
      applicationKeypad: false,
      modifyOtherKeys: 2,
      altSendsEscape: false,
    });
  });
});
