/**
 * @vitest-environment jsdom
 *
 * CodeMirror splits on `\r\n`, `\r` and `\n` alike and hands its text back
 * with `\n`, so a CRLF file used to save as an all-LF whole-file rewrite on
 * the first keystroke in Raw mode. The adapter now gives the text back in the
 * file's own line separator. Its offsets still count a line break as ONE
 * character, so a caret persisted against the longer CRLF text must be clamped
 * to the editor's document, not to the model text's length.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { createDocModel } from '../../core/doc-model';
import { createCm6Adapter, type Cm6Adapter } from '../cm6';

const CRLF = '# Title\r\n\r\nfirst line\r\nsecond line\r\n';

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
  return { model, adapter };
}

/** A line feed not preceded by a carriage return. */
const BARE_LF = /(?<!\r)\n/;

describe('cm6 adapter line endings', () => {
  test('an edit to a CRLF document keeps every line CRLF', () => {
    const { model, adapter } = mount(CRLF);
    adapter.setSelection(0, 0);
    adapter.insertLinkTo('x', 'y', false);
    expect(model.getText()).toBe(`[x](y)${CRLF}`);
    expect(model.getText()).not.toMatch(BARE_LF);
  });

  test('a new line typed into a CRLF document is CRLF too', () => {
    const { model, adapter } = mount(CRLF);
    adapter.setSelection(0, 0);
    adapter.format('quote');
    adapter.format('codeBlock');
    expect(model.getText()).not.toMatch(BARE_LF);
    expect(model.getText()).toContain('```\r\n');
  });

  test('an LF document stays LF', () => {
    const lf = CRLF.replace(/\r\n/g, '\n');
    const { model, adapter } = mount(lf);
    adapter.setSelection(0, 0);
    adapter.insertLinkTo('x', 'y', false);
    expect(model.getText()).toBe(`[x](y)${lf}`);
  });

  test('a CRLF text arriving from outside is followed, and edits after it stay CRLF', () => {
    const { model, adapter } = mount('a\nb\n');
    model.pushText('one\r\ntwo\r\n', 'file-load');
    adapter.setSelection(0, 0);
    adapter.insertLinkTo('x', 'y', false);
    expect(model.getText()).toBe('[x](y)one\r\ntwo\r\n');
  });

  test('a model change differing only in line endings does not echo back', () => {
    const { model } = mount(CRLF);
    const before = model.getVersion();
    model.pushText(CRLF.replace(/\r\n/g, '\n'), 'file-load');
    // The editor follows silently; it must not push the old CRLF text back.
    expect(model.getText()).toBe(CRLF.replace(/\r\n/g, '\n'));
    expect(model.getVersion()).toBe(before + 1);
  });

  test('a caret persisted against the CRLF length is clamped, not thrown', () => {
    const end = CRLF.length; // 4 longer than the editor's own document
    const { adapter } = mount(CRLF, { initialSelection: { anchor: end, head: end } });
    const docLength = CRLF.replace(/\r\n/g, '\n').length;
    expect(adapter.getSelection()).toEqual({ anchor: docLength, head: docLength });
  });
});
