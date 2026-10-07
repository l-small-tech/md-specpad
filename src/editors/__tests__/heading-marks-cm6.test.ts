import { describe, expect, test } from 'vitest';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { markedSectionLines } from '../heading-marks-cm6';

function sections(text: string) {
  const state = EditorState.create({
    doc: text,
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return markedSectionLines(state);
}

describe('markedSectionLines', () => {
  test('a marked heading tints its body and sub-headings, not the blank gap', () => {
    const doc = [
      '# Plan', // 1
      '## Build ⏳', // 2
      'text', // 3
      '### Parser', // 4
      'more', // 5
      '', // 6
      '## Test', // 7
      'after', // 8
    ].join('\n');
    expect(sections(doc)).toEqual([
      { first: 2, last: 3, mark: 'running' },
      { first: 4, last: 5, mark: 'running' },
    ]);
  });

  test('a sub-heading’s own mark takes over, then the parent resumes', () => {
    const doc = ['# A ✅', 'x', '## B ⏳', 'y', '# C', 'z'].join('\n');
    expect(sections(doc)).toEqual([
      { first: 1, last: 2, mark: 'complete' },
      { first: 3, last: 4, mark: 'running' },
    ]);
  });

  test('a `#` line in a code fence neither ends nor opens a section', () => {
    const doc = ['## Done ✅', '```', '# not a heading', '```', 'tail'].join('\n');
    expect(sections(doc)).toEqual([{ first: 1, last: 5, mark: 'complete' }]);
  });

  test('the last section runs to the end of the document', () => {
    expect(sections('intro\n## End ⏳\na\nb')).toEqual([{ first: 2, last: 4, mark: 'running' }]);
  });
});
