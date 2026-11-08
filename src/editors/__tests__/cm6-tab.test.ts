// @vitest-environment jsdom
/**
 * Tab in the source editor: list lines re-indent (list-indent.ts); every
 * other line gets two spaces at the caret or an indent level across a
 * selection, and Shift+Tab removes one. Nothing lets the key fall through to
 * the browser's focus navigation.
 */
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, test } from 'vitest';
import { createDocModel } from '../../core/doc-model';
import { createCm6Adapter, type Cm6Adapter } from '../cm6';

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

function press(view: EditorView, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  view.contentDOM.dispatchEvent(event);
  return event;
}

describe('Tab in the source editor', () => {
  test('on a plain line Tab inserts two spaces and is consumed', () => {
    const { model, adapter, view } = mount('hello world\n');
    adapter.setSelection(5, 5);
    const event = press(view, 'Tab');
    expect(event.defaultPrevented).toBe(true);
    expect(model.getText()).toBe('hello   world\n');
  });

  test('with a selection spanning plain lines Tab indents them and Shift+Tab undoes it', () => {
    const { model, adapter, view } = mount('one\ntwo\n');
    adapter.setSelection(0, 7);
    press(view, 'Tab');
    expect(model.getText()).toBe('  one\n  two\n');
    press(view, 'Tab', { shiftKey: true });
    expect(model.getText()).toBe('one\ntwo\n');
  });

  test('a first-level list item that cannot move still indents instead of swallowing the key', () => {
    const { model, adapter, view } = mount('* a\n');
    adapter.setSelection(3, 3);
    const event = press(view, 'Tab');
    expect(event.defaultPrevented).toBe(true);
    expect(model.getText()).toBe('* a  \n');
  });

  test('a nested list line still re-indents through the list rules', () => {
    const { model, adapter, view } = mount('* a\n* b\n');
    adapter.setSelection(6, 6);
    press(view, 'Tab');
    expect(model.getText()).toBe('* a\n  - b\n');
  });

  test('code files get the same Tab', () => {
    const { model, adapter, view } = mount('x\n', { language: 'ts' });
    adapter.setSelection(0, 0);
    press(view, 'Tab');
    expect(model.getText()).toBe('  x\n');
  });
});
