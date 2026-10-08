// @vitest-environment jsdom
/**
 * AltGr text against the source editor's keymaps. Windows reports AltGr as
 * Ctrl+Alt, so German AltGr+ß arrives as Ctrl+Alt+"\" — which CM6's default
 * keymap binds to indentSelection — and AltGr+8 / 9 as Ctrl+Alt+"[" / "]",
 * the fold-all chords. The adapter's guard types those characters before any
 * keymap runs; real Ctrl+Alt chords still reach the keymaps.
 */
import { foldedRanges } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, test } from 'vitest';
import { createDocModel } from '../../core/doc-model';
import { createCm6Adapter, type Cm6Adapter } from '../cm6';

/** An over-indented statement: indentSelection pulls it back to two spaces. */
const TS = '{\n      x;\n}\n';
/** The caret at the start of `x;`. */
const CARET = TS.indexOf('x');

let adapter: Cm6Adapter | null = null;

afterEach(() => {
  adapter?.detach();
  adapter = null;
  document.body.innerHTML = '';
});

function mount(text: string, options: Parameters<typeof createCm6Adapter>[0] = {}) {
  const model = createDocModel(text);
  const host = document.createElement('div');
  document.body.append(host);
  adapter = createCm6Adapter(options);
  adapter.attach(host, model);
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement);
  if (!view) throw new Error('no editor view');
  return { model, adapter, view };
}

function press(view: EditorView, key: string, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  view.contentDOM.dispatchEvent(event);
  return event;
}

describe('AltGr text in the source editor', () => {
  test('German AltGr+ß types a backslash instead of re-indenting', () => {
    const { model, adapter, view } = mount(TS, { language: 'ts' });
    adapter.setSelection(CARET, CARET);
    press(view, '\\', { code: 'Minus', ctrlKey: true, altKey: true });
    expect(model.getText()).toBe('{\n      \\x;\n}\n');
  });

  test('a US Ctrl+Alt+\\ still re-indents the selection', () => {
    const { model, adapter, view } = mount(TS, { language: 'ts' });
    adapter.setSelection(CARET, CARET);
    const event = press(view, '\\', { code: 'Backslash', ctrlKey: true, altKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(model.getText()).toBe('{\n  x;\n}\n');
  });

  test('the AltGraph modifier state wins on layouts with "\\" on the US key', () => {
    const { model, adapter, view } = mount(TS, { language: 'ts' });
    adapter.setSelection(CARET, CARET);
    press(view, '\\', {
      code: 'Backslash',
      ctrlKey: true,
      altKey: true,
      modifierAltGraph: true,
    } as KeyboardEventInit);
    expect(model.getText()).toBe('{\n      \\x;\n}\n');
  });

  test.each([
    ['@', 'KeyQ'],
    ['{', 'Digit7'],
    ['[', 'Digit8'],
    [']', 'Digit9'],
    ['}', 'Digit0'],
    ['\\', 'Minus'],
    ['|', 'IntlBackslash'],
    ['~', 'BracketRight'],
    ['€', 'KeyE'],
  ])('German AltGr types %s (%s) in a markdown note', (key, code) => {
    const { model, adapter, view } = mount('# One\ntext\n\n# Two\nmore\n', {
      collapsibleHeadings: true,
    });
    adapter.setSelection(0, 0);
    press(view, key, { code, ctrlKey: true, altKey: true });
    expect(model.getText()).toBe(`${key}# One\ntext\n\n# Two\nmore\n`);
    expect(foldedRanges(view.state).size).toBe(0);
  });

  test('AltGr text replaces the selection and undoes as one step', () => {
    const { model, adapter, view } = mount('a b c\n');
    adapter.setSelection(2, 3);
    press(view, '@', { code: 'KeyQ', ctrlKey: true, altKey: true });
    expect(model.getText()).toBe('a @ c\n');
    press(view, 'z', { code: 'KeyZ', ctrlKey: true });
    expect(model.getText()).toBe('a b c\n');
  });

  test('a real Ctrl+Alt+[ still folds every section', () => {
    const { model, view } = mount('# One\ntext\n\n# Two\nmore\n', { collapsibleHeadings: true });
    press(view, '[', { code: 'BracketLeft', ctrlKey: true, altKey: true });
    expect(foldedRanges(view.state).size).toBe(2);
    expect(model.getText()).toBe('# One\ntext\n\n# Two\nmore\n');
  });

  test('a letter chord is never AltGr text', () => {
    const { model, view } = mount('line\n');
    press(view, 'a', { code: 'KeyA', ctrlKey: true, altKey: true });
    expect(model.getText()).toBe('line\n');
  });
});
