import { describe, expect, test } from 'vitest';
import { isAltGraphText, type AltGraphKeyInput } from '../altgr';

/** A Ctrl+Alt event, the way Windows reports both AltGr and a real chord. */
const ctrlAlt = (key: string, code?: string, extra: Partial<AltGraphKeyInput> = {}) => ({
  key,
  code,
  ctrl: true,
  alt: true,
  ...extra,
});

describe('isAltGraphText', () => {
  test('a character the US key would not type is AltGr text', () => {
    expect(isAltGraphText(ctrlAlt('@', 'KeyQ'))).toBe(true); // German
    expect(isAltGraphText(ctrlAlt('\\', 'Minus'))).toBe(true); // German
    expect(isAltGraphText(ctrlAlt('#', 'Digit3'))).toBe(true); // French, no Shift
    expect(isAltGraphText(ctrlAlt('ą', 'KeyA'))).toBe(true); // Polish
    expect(isAltGraphText(ctrlAlt('|', 'IntlBackslash'))).toBe(true);
  });

  test('the US character of the physical key is a chord, Shift state included', () => {
    expect(isAltGraphText(ctrlAlt('[', 'BracketLeft'))).toBe(false);
    expect(isAltGraphText(ctrlAlt('7', 'Digit7'))).toBe(false);
    expect(isAltGraphText(ctrlAlt('#', 'Digit3', { shift: true }))).toBe(false);
    expect(isAltGraphText(ctrlAlt('1', 'Numpad1'))).toBe(false);
  });

  test('ASCII letters and space are always chords', () => {
    expect(isAltGraphText(ctrlAlt('z', 'KeyY'))).toBe(false);
    expect(isAltGraphText(ctrlAlt('A', 'KeyA', { shift: true, altGraph: true }))).toBe(false);
    expect(isAltGraphText(ctrlAlt(' ', 'Space', { altGraph: true }))).toBe(false);
  });

  test('the AltGraph modifier state overrides the US-key fallback', () => {
    expect(isAltGraphText(ctrlAlt('[', 'BracketLeft', { altGraph: true }))).toBe(true);
  });

  test('without a code, only characters no US chord can report are AltGr text', () => {
    expect(isAltGraphText(ctrlAlt('€'))).toBe(true);
    expect(isAltGraphText(ctrlAlt('['))).toBe(false);
  });

  test('needs Ctrl and Alt without Meta, and a single printable character', () => {
    expect(isAltGraphText({ key: '@', code: 'KeyQ', alt: true, altGraph: true })).toBe(false);
    expect(isAltGraphText({ key: '@', code: 'KeyQ', ctrl: true })).toBe(false);
    expect(isAltGraphText(ctrlAlt('@', 'KeyQ', { meta: true }))).toBe(false);
    expect(isAltGraphText(ctrlAlt('Dead', 'BracketRight'))).toBe(false);
    expect(isAltGraphText(ctrlAlt('Enter', 'Enter'))).toBe(false);
    expect(isAltGraphText(ctrlAlt('\x1b', 'KeyQ'))).toBe(false);
  });
});
