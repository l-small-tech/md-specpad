import { describe, expect, test } from 'vitest';
import { ChangeSet, Text } from '@codemirror/state';
import { linesTurnedRunning } from '../heading-fold-cm6';

function change(before: string, edits: { from: number; to?: number; insert?: string }[]) {
  const doc = Text.of(before.split('\n'));
  const changes = ChangeSet.of(edits, doc.length);
  return { before: doc, after: changes.apply(doc), changes };
}

function replaceLine(before: string, lineNumber: number, text: string) {
  const doc = Text.of(before.split('\n'));
  const line = doc.line(lineNumber);
  return change(before, [{ from: line.from, to: line.to, insert: text }]);
}

describe('linesTurnedRunning', () => {
  const doc = '# Plan\n\n## Build ⏳\ntext\n\n## Test\nmore';

  test('a heading that just gained the running mark is reported', () => {
    const { before, after, changes } = replaceLine(doc, 6, '## Test ⏳');
    expect(linesTurnedRunning(before, after, changes)).toEqual([6]);
  });

  test('a heading that was already running is not reported again', () => {
    const { before, after, changes } = replaceLine(doc, 3, '## Build it ⏳');
    expect(linesTurnedRunning(before, after, changes)).toEqual([]);
  });

  test('marking complete or clearing the mark reports nothing', () => {
    const done = replaceLine(doc, 3, '## Build ✅');
    expect(linesTurnedRunning(done.before, done.after, done.changes)).toEqual([]);
    const cleared = replaceLine(doc, 3, '## Build');
    expect(linesTurnedRunning(cleared.before, cleared.after, cleared.changes)).toEqual([]);
  });

  test('edits elsewhere never report a running heading', () => {
    const { before, after, changes } = replaceLine(doc, 4, 'text changed');
    expect(linesTurnedRunning(before, after, changes)).toEqual([]);
  });

  test('a pasted block with new running headings reports each of them once', () => {
    const { before, after, changes } = change(doc, [
      { from: Text.of(doc.split('\n')).length, insert: '\n\n## A ⏳\nx\n## B ⏳\n' },
    ]);
    expect(linesTurnedRunning(before, after, changes)).toEqual([9, 11]);
  });

  test('typing the glyph onto a plain heading counts as setting it running', () => {
    const { before, after, changes } = change(doc, [{ from: '# Plan'.length, insert: ' ⏳' }]);
    expect(linesTurnedRunning(before, after, changes)).toEqual([1]);
  });
});
