import { describe, expect, test } from 'vitest';
import { diffLanguageFor, mergeSpans, tokenizeLines, type TokenSpan } from '../diff-syntax';

/** The text of each class's spans on line `i`, as `cls:text`. */
function tokens(text: string, path: string, i: number): string[] {
  const lines = tokenizeLines(text, path);
  const line = text.split('\n')[i]!;
  return (lines?.[i] ?? []).map((t) => `${t.cls}:${line.slice(t.from, t.to)}`);
}

describe('diffLanguageFor', () => {
  test('picks a grammar from the extension', () => {
    expect(diffLanguageFor('src/a.ts')).toBe('ts');
    expect(diffLanguageFor('C:\\x\\App.TSX')).toBe('tsx');
    expect(diffLanguageFor('a.mjs')).toBe('js');
    expect(diffLanguageFor('a.jsx')).toBe('jsx');
    expect(diffLanguageFor('lib.rs')).toBe('rust');
    expect(diffLanguageFor('notes/Todo.md')).toBe('markdown');
  });

  test('null for anything it cannot colour', () => {
    expect(diffLanguageFor('a.json')).toBeNull();
    expect(diffLanguageFor('Makefile')).toBeNull();
    expect(diffLanguageFor('.gitignore')).toBeNull();
    expect(diffLanguageFor(null)).toBeNull();
    expect(diffLanguageFor('')).toBeNull();
  });
});

describe('tokenizeLines', () => {
  test('TypeScript keywords, strings and comments', () => {
    const text = 'const a = "x"; // hi';
    expect(tokens(text, 'a.ts', 0)).toEqual([
      'diff-tok-keyword:const',
      'diff-tok-def:a',
      'diff-tok-meta:=',
      'diff-tok-string:"x"',
      'diff-tok-comment:// hi',
    ]);
  });

  test('a block comment spanning lines colours every line it covers', () => {
    const text = 'let x = 1;\n/* one\ntwo */\nlet y;';
    expect(tokens(text, 'a.js', 1)).toEqual(['diff-tok-comment:/* one']);
    expect(tokens(text, 'a.js', 2)).toEqual(['diff-tok-comment:two */']);
    expect(tokens(text, 'a.js', 3)[0]).toBe('diff-tok-keyword:let');
  });

  test('Rust', () => {
    expect(tokens('fn main() {}', 'main.rs', 0).slice(0, 2)).toEqual([
      'diff-tok-keyword:fn',
      'diff-tok-def:main',
    ]);
  });

  test('Markdown headings, emphasis and code, plain paragraphs left alone', () => {
    const text = '# Title\n\nsome **bold** and `code`';
    // Nested tags compose: the `#` mark is inside the heading.
    expect(tokens(text, 'n.md', 0)).toEqual([
      'diff-tok-heading diff-tok-meta:#',
      'diff-tok-heading: Title',
    ]);
    const body = tokens(text, 'n.md', 2);
    expect(body).toContain('diff-tok-strong:bold');
    expect(body).toContain('diff-tok-string:code');
    expect(body.some((t) => t.endsWith(':some '))).toBe(false);
  });

  test('one entry per line, CRLF included', () => {
    const lines = tokenizeLines('let a;\r\nlet b;\r\n', 'a.ts');
    expect(lines).toHaveLength(3);
    expect(lines![1]![0]).toEqual({ from: 0, to: 3, cls: 'diff-tok-keyword' });
  });

  test('null without a grammar or past the size cap', () => {
    expect(tokenizeLines('x', 'a.txt')).toBeNull();
    expect(tokenizeLines('let a;', 'a.ts', 3)).toBeNull();
  });
});

describe('mergeSpans', () => {
  const toks: TokenSpan[] = [
    { from: 0, to: 5, cls: 'k' },
    { from: 8, to: 11, cls: 's' },
  ];

  test('plain text without tokens or range', () => {
    expect(mergeSpans('abc', null, null)).toEqual([{ text: 'abc', cls: null, hi: false }]);
    expect(mergeSpans('', null, null)).toEqual([]);
  });

  test('tokens fill gaps with plain text', () => {
    expect(mergeSpans('const x = "y";', toks, null)).toEqual([
      { text: 'const', cls: 'k', hi: false },
      { text: ' x ', cls: null, hi: false },
      { text: '= "', cls: 's', hi: false },
      { text: 'y";', cls: null, hi: false },
    ]);
  });

  test('the changed range cuts through tokens', () => {
    expect(mergeSpans('const x = "y";', toks, [3, 9])).toEqual([
      { text: 'con', cls: 'k', hi: false },
      { text: 'st', cls: 'k', hi: true },
      { text: ' x ', cls: null, hi: true },
      { text: '=', cls: 's', hi: true },
      { text: ' "', cls: 's', hi: false },
      { text: 'y";', cls: null, hi: false },
    ]);
  });

  test('segments always rebuild the line; spans past its end are clipped', () => {
    const text = 'let a;';
    const segs = mergeSpans(text, [{ from: 4, to: 9, cls: 'x' }], [5, 6]);
    expect(segs.map((s) => s.text).join('')).toBe(text);
    expect(segs).toEqual([
      { text: 'let ', cls: null, hi: false },
      { text: 'a', cls: 'x', hi: false },
      { text: ';', cls: 'x', hi: true },
    ]);
  });
});
