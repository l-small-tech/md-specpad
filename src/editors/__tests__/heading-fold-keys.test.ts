// @vitest-environment jsdom
/**
 * The fold-all chords (Ctrl+Alt+[ / ]) against AltGr: Windows reports AltGr
 * as Ctrl+Alt, so German AltGr+8 ("[") and AltGr+9 ("]") must type brackets
 * instead of folding every section.
 */
import { markdown } from '@codemirror/lang-markdown';
import { foldedRanges } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, test } from 'vitest';
import { headingFoldExtension, sectionFoldKeymap } from '../heading-fold-cm6';

const DOC = '# One\ntext\n\n# Two\nmore\n';

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = '';
});

function makeView(): EditorView {
  view = new EditorView({
    state: EditorState.create({ doc: DOC, extensions: [markdown(), headingFoldExtension] }),
    parent: document.body,
  });
  return view;
}

function press(target: EditorView, key: string, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.contentDOM.dispatchEvent(event);
  return event;
}

function foldCount(target: EditorView): number {
  return foldedRanges(target.state).size;
}

describe('fold-all chords and AltGr', () => {
  test('the keymap no longer carries the named Ctrl-Alt bindings', () => {
    const keys = sectionFoldKeymap.map((binding) => binding.key).filter(Boolean);
    expect(keys).not.toContain('Ctrl-Alt-[');
    expect(keys).not.toContain('Ctrl-Alt-]');
    expect(keys).toContain('Ctrl-Shift-[');
  });

  test('a real Ctrl+Alt+[ folds every section and Ctrl+Alt+] unfolds them', () => {
    const v = makeView();
    const fold = press(v, '[', { code: 'BracketLeft', ctrlKey: true, altKey: true });
    expect(fold.defaultPrevented).toBe(true);
    expect(foldCount(v)).toBe(2);
    press(v, ']', { code: 'BracketRight', ctrlKey: true, altKey: true });
    expect(foldCount(v)).toBe(0);
  });

  test('German AltGr+8 / AltGr+9 (Ctrl+Alt on Windows) leave the folds alone', () => {
    const v = makeView();
    const open = press(v, '[', { code: 'Digit8', ctrlKey: true, altKey: true });
    expect(open.defaultPrevented).toBe(false);
    expect(foldCount(v)).toBe(0);
    const close = press(v, ']', { code: 'Digit9', ctrlKey: true, altKey: true });
    expect(close.defaultPrevented).toBe(false);
  });

  test('the AltGraph modifier state wins on layouts with brackets on the US keys', () => {
    const v = makeView();
    const event = press(v, '[', {
      code: 'BracketLeft',
      ctrlKey: true,
      altKey: true,
      modifierAltGraph: true,
    } as KeyboardEventInit);
    expect(event.defaultPrevented).toBe(false);
    expect(foldCount(v)).toBe(0);
  });
});
