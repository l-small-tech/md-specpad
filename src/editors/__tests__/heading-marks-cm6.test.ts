import { describe, expect, test } from 'vitest';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { headingMarkChanges, markedSectionLines } from '../heading-marks-cm6';

function stateOf(text: string) {
  const state = EditorState.create({
    doc: text,
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

function sections(text: string) {
  return markedSectionLines(stateOf(text));
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

describe('markedSectionLines — one continuous band', () => {
  test('blank lines before a sub-heading inside the band stay tinted', () => {
    const doc = [
      '## Build ⏳', // 1
      'text', // 2
      '', // 3
      '### Parser', // 4
      'more', // 5
      '', // 6
      '### Lexer', // 7
      'lex', // 8
      '', // 9
      '## Next', // 10
    ].join('\n');
    expect(sections(doc)).toEqual([
      { first: 1, last: 3, mark: 'running' },
      { first: 4, last: 6, mark: 'running' },
      { first: 7, last: 8, mark: 'running' },
    ]);
  });

  test('the gap before a differently marked sub-heading is not', () => {
    const doc = ['## A ✅', 'x', '', '### B 💤', 'y'].join('\n');
    expect(sections(doc)).toEqual([
      { first: 1, last: 2, mark: 'complete' },
      { first: 4, last: 5, mark: 'backburner' },
    ]);
  });
});

describe('headingMarkChanges', () => {
  function apply(text: string, line: number, mark: Parameters<typeof headingMarkChanges>[2]) {
    const state = stateOf(text);
    const changes = headingMarkChanges(state, state.doc.line(line).from, mark);
    return state.update({ changes }).state.doc.toString();
  }

  test('focus moves: the previous focus heading is cleared', () => {
    const doc = ['# A 🎯', 'x', '## B', '```', '# code 🎯', '```'].join('\n');
    expect(apply(doc, 3, 'focus')).toBe(
      ['# A', 'x', '## B 🎯', '```', '# code 🎯', '```'].join('\n'),
    );
  });

  test('other marks leave the rest of the document alone', () => {
    const doc = ['# A 🎯', '## B ⏳'].join('\n');
    expect(apply(doc, 2, 'backburner')).toBe(['# A 🎯', '## B 💤'].join('\n'));
  });
});
