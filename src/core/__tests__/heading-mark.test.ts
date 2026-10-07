import { describe, expect, test } from 'vitest';
import {
  markOfText,
  parseHeadingLine,
  setHeadingLineMark,
  stripMark,
  withMarkText,
} from '../heading-mark';

describe('parseHeadingLine', () => {
  test('any ATX level, with or without a mark', () => {
    expect(parseHeadingLine('# Title')).toEqual({ level: 1, mark: null });
    expect(parseHeadingLine('###### Deep ⏳')).toEqual({ level: 6, mark: 'running' });
    expect(parseHeadingLine('   ## Indented ✅')).toEqual({ level: 2, mark: 'complete' });
    expect(parseHeadingLine('## Closed ✅ ##')).toEqual({ level: 2, mark: 'complete' });
    expect(parseHeadingLine('## Done ✅\r')).toEqual({ level: 2, mark: 'complete' });
    expect(parseHeadingLine('##')).toEqual({ level: 2, mark: null });
  });

  test('not headings', () => {
    expect(parseHeadingLine('#hashtag')).toBeNull();
    expect(parseHeadingLine('####### seven')).toBeNull();
    expect(parseHeadingLine('    # code-indented')).toBeNull();
    expect(parseHeadingLine('plain ✅')).toBeNull();
  });

  test('a glyph in the middle of the text is not a mark', () => {
    expect(parseHeadingLine('## ✅ checklist')).toEqual({ level: 2, mark: null });
    expect(parseHeadingLine('## done✅')).toEqual({ level: 2, mark: null });
  });
});

describe('setHeadingLineMark', () => {
  test('adds, swaps and clears', () => {
    const running = setHeadingLineMark('## Build it', 'running');
    expect(running).toBe('## Build it ⏳');
    const complete = setHeadingLineMark(running!, 'complete');
    expect(complete).toBe('## Build it ✅');
    expect(setHeadingLineMark(complete!, null)).toBe('## Build it');
  });

  test('setting the same mark twice does not stack glyphs', () => {
    expect(setHeadingLineMark('# A ✅', 'complete')).toBe('# A ✅');
  });

  test('keeps indent, a closing run and CRLF', () => {
    expect(setHeadingLineMark('  ### Title ##', 'running')).toBe('  ### Title ⏳ ##');
    expect(setHeadingLineMark('# Title ✅\r', null)).toBe('# Title\r');
    expect(setHeadingLineMark('## Title  ', 'complete')).toBe('## Title ✅  ');
  });

  test('an empty heading gets just the glyph; clearing leaves it empty', () => {
    expect(setHeadingLineMark('##', 'running')).toBe('## ⏳');
    expect(setHeadingLineMark('## ⏳', null)).toBe('## ');
  });

  test('reads the emoji-presentation form', () => {
    expect(setHeadingLineMark('# A ✅️', null)).toBe('# A');
  });

  test('null for a line that is not a heading', () => {
    expect(setHeadingLineMark('text', 'running')).toBeNull();
  });
});

describe('heading text helpers (Edit mode works on node text)', () => {
  test('markOfText / stripMark / withMarkText', () => {
    expect(markOfText('Plan ⏳')).toBe('running');
    expect(markOfText('Plan')).toBeNull();
    expect(stripMark('Plan ✅ ')).toBe('Plan');
    expect(withMarkText('Plan ⏳', 'complete')).toBe('Plan ✅');
    expect(withMarkText('', 'running')).toBe('⏳');
  });
});
