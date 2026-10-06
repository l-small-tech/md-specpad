/**
 * The raw ⇄ draw exchange rate (Split mode on an `.svg` tab).
 *
 * Two properties carry the whole feature and are asserted directly:
 *
 * 1. **The spans agree with the scene.** `parseWhiteboardWithSpans` reports one
 *    span per element of every layer, in the same order the scene holds them —
 *    if that ever drifted, the link would point at the wrong shape, silently.
 * 2. **A span IS the element's markup.** Slicing the source at it gives back
 *    the source of that element, which is what makes the highlight honest.
 */

import { describe, expect, it } from 'vitest';
import {
  lineRangeAt,
  rangeForRef,
  rangesForRefs,
  refAtOffset,
  sameRanges,
  sourceSpans,
} from '../locate';
import { parseWhiteboardWithSpans } from '../parse';
import { serializeWhiteboard } from '../serialize';

const BOARD = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:wb="urn:md-specpad:whiteboard" viewBox="0 0 800 600" width="800" height="600">
  <metadata><wb:doc>{"schema":1,"background":"#ffffff"}</wb:doc></metadata>
  <rect wb:role="background" x="0" y="0" width="800" height="600" fill="#ffffff"/>
  <g wb:layer="a1B2" wb:name="Layer 1">
    <rect x="100" y="120" width="80" height="40" fill="none" stroke="#1a1a1a" stroke-width="2"/>
    <ellipse cx="300" cy="200" rx="50" ry="25" fill="none" stroke="#1a1a1a" stroke-width="2"/>
    <text x="40" y="400" font-size="24" fill="#1a1a1a">hello</text>
  </g>
  <g wb:layer="c3D4" wb:name="Photo">
    <image x="0" y="0" width="100" height="100" href="data:image/png;base64,AAAA"/>
  </g>
</svg>
`;

/** Every span, sliced back out of the source it was measured against. */
function slices(source: string): string[] {
  return (sourceSpans(source) ?? []).map((span) => source.slice(span.start, span.end));
}

describe('element spans', () => {
  it('reports one per element, in the layers own order', () => {
    const { doc, spans } = parseWhiteboardWithSpans(BOARD);
    expect(spans.map((s) => `${s.layerId}:${s.index}`)).toEqual([
      'a1B2:0',
      'a1B2:1',
      'a1B2:2',
      'c3D4:0',
    ]);
    // The pairing is the contract: span n addresses scene element n.
    for (const span of spans) {
      const layer = doc.layers.find((l) => l.id === span.layerId);
      expect(layer?.elements[span.index]).toBeDefined();
    }
    expect(spans.length).toBe(doc.layers.reduce((n, l) => n + l.elements.length, 0));
  });

  it('slices back to exactly that elements markup', () => {
    expect(slices(BOARD)).toEqual([
      '<rect x="100" y="120" width="80" height="40" fill="none" stroke="#1a1a1a" stroke-width="2"/>',
      '<ellipse cx="300" cy="200" rx="50" ry="25" fill="none" stroke="#1a1a1a" stroke-width="2"/>',
      '<text x="40" y="400" font-size="24" fill="#1a1a1a">hello</text>',
      '<image x="0" y="0" width="100" height="100" href="data:image/png;base64,AAAA"/>',
    ]);
  });

  it('covers a foreign SVGs Imported layer too', () => {
    const foreign = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
  <circle cx="5" cy="5" r="4"/>
  <path d="M0,0 L10,10"/>
</svg>
`;
    const { doc, spans } = parseWhiteboardWithSpans(foreign);
    expect(doc.layers.map((l) => l.id)).toEqual(['imported']);
    expect(spans.map((s) => s.layerId)).toEqual(['imported', 'imported']);
    expect(slices(foreign)).toEqual(['<circle cx="5" cy="5" r="4"/>', '<path d="M0,0 L10,10"/>']);
  });

  it('survives our own serializer, which is what Split mode actually reads', () => {
    const { doc } = parseWhiteboardWithSpans(BOARD);
    const written = serializeWhiteboard(doc);
    const spans = sourceSpans(written) ?? [];
    expect(spans.length).toBe(4);
    for (const span of spans) {
      expect(written.slice(span.start, span.end)).toMatch(/^<[a-z]/);
    }
  });

  it('is null, not an exception, for text that is not XML yet', () => {
    expect(sourceSpans('<svg><rect x="1"')).toBeNull();
    expect(sourceSpans('')).toBeNull();
  });
});

describe('ref ⇄ source', () => {
  const spans = sourceSpans(BOARD)!;

  it('finds the range of a ref, and nothing for one that is gone', () => {
    const range = rangeForRef(spans, { layerId: 'a1B2', index: 1 })!;
    expect(BOARD.slice(range.start, range.end)).toContain('<ellipse');
    expect(rangeForRef(spans, { layerId: 'a1B2', index: 9 })).toBeNull();
    expect(rangeForRef(spans, { layerId: 'nope', index: 0 })).toBeNull();
  });

  it('returns a selections ranges in SOURCE order', () => {
    const ranges = rangesForRefs(spans, [
      { layerId: 'c3D4', index: 0 },
      { layerId: 'a1B2', index: 0 },
    ]);
    expect(ranges.map((r) => BOARD.slice(r.start, r.start + 5))).toEqual(['<rect', '<imag']);
  });

  it('names the element the caret is inside', () => {
    const inside = BOARD.indexOf('cx="300"');
    expect(refAtOffset(BOARD, spans, inside)).toEqual({ layerId: 'a1B2', index: 1 });
  });

  it('names the element whose LINE the caret is on, indentation included', () => {
    const lineStart = BOARD.lastIndexOf('\n', BOARD.indexOf('<ellipse')) + 1;
    expect(refAtOffset(BOARD, spans, lineStart)).toEqual({ layerId: 'a1B2', index: 1 });
    // Just past the closing `>` is still that element's line.
    const lineEnd = BOARD.indexOf('\n', BOARD.indexOf('<ellipse'));
    expect(refAtOffset(BOARD, spans, lineEnd)).toEqual({ layerId: 'a1B2', index: 1 });
  });

  it('names nothing on a line that holds no element', () => {
    expect(refAtOffset(BOARD, spans, BOARD.indexOf('<metadata'))).toBeNull();
    expect(refAtOffset(BOARD, spans, 0)).toBeNull();
  });

  it('prefers containment when two elements share a line', () => {
    const packed =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:wb="urn:md-specpad:whiteboard" viewBox="0 0 10 10">' +
      '<g wb:layer="L1"><rect x="0" y="0" width="1" height="1"/><rect x="5" y="5" width="1" height="1"/></g>' +
      '</svg>';
    const packedSpans = sourceSpans(packed)!;
    expect(refAtOffset(packed, packedSpans, packed.indexOf('x="5"'))).toEqual({
      layerId: 'L1',
      index: 1,
    });
    expect(refAtOffset(packed, packedSpans, packed.indexOf('x="0"'))).toEqual({
      layerId: 'L1',
      index: 0,
    });
  });
});

describe('helpers', () => {
  it('bounds the line around an offset, excluding the break', () => {
    const text = 'one\ntwo\nthree';
    expect(lineRangeAt(text, 0)).toEqual({ start: 0, end: 3 });
    expect(lineRangeAt(text, 3)).toEqual({ start: 0, end: 3 });
    expect(lineRangeAt(text, 4)).toEqual({ start: 4, end: 7 });
    expect(lineRangeAt(text, 99)).toEqual({ start: 8, end: 13 });
  });

  it('compares range lists by value', () => {
    expect(sameRanges([{ start: 1, end: 2 }], [{ start: 1, end: 2 }])).toBe(true);
    expect(sameRanges([{ start: 1, end: 2 }], [{ start: 1, end: 3 }])).toBe(false);
    expect(sameRanges([], [])).toBe(true);
    expect(sameRanges([{ start: 1, end: 2 }], [])).toBe(false);
  });
});
