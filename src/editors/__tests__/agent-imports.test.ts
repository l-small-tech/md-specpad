// @vitest-environment jsdom
/**
 * `@path` imports in an agent file get `.cm-agent-import` in the source
 * editor; the same text inside code does not, and a file that is not an
 * agent file gets nothing.
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
  const host = document.createElement('div');
  document.body.append(host);
  adapter = createCm6Adapter(options);
  adapter.attach(host, createDocModel(text));
  return host;
}

function marked(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('.cm-agent-import'), (el) => el.textContent ?? '');
}

describe('agent-file @imports', () => {
  test('imports in prose are marked; e-mail and code are not', () => {
    const host = mount(
      [
        '@AGENTS.md',
        'Read @docs/style.md, mail ann@example.com.',
        'Inline `@not/this.md` stays code.',
        '```',
        '@nor/this.md',
        '```',
        '',
      ].join('\n'),
      { agentFile: true },
    );
    expect(marked(host)).toEqual(['@AGENTS.md', '@docs/style.md']);
  });

  test('a plain markdown file gets no marks', () => {
    const host = mount('@AGENTS.md\n');
    expect(marked(host)).toEqual([]);
  });

  test('removing the fence above a token makes it an import again', () => {
    const host = mount('```\n@inside.md\n', { agentFile: true });
    expect(marked(host)).toEqual([]);
    const view = EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement);
    if (!view) throw new Error('no editor view');
    view.dispatch({ changes: { from: 0, to: 4, insert: '' } });
    expect(marked(host)).toEqual(['@inside.md']);
  });
});
