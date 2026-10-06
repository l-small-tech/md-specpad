/**
 * The format contract: parse → serialize → parse.
 *
 * Two different promises are tested here and they must not be confused:
 *
 * - **Byte-identity on an untouched file** is NOT this file's job — it belongs
 *   to the adapter's write-back guard (serialize only after a real edit), the
 *   same contract Milkdown has. What IS tested here is that serializing our own
 *   output is a fixed point, and that nothing is ever dropped.
 * - **Nothing dropped**: foreign SVGs (Inkscape, hand-authored) keep every
 *   element, attribute and comment through a full round trip.
 */

import { describe, expect, it } from 'vitest';
import { parseWhiteboard, WhiteboardParseError } from '../parse';
import {
  BOX_SHAPES,
  createLayer,
  createScene,
  DEFAULT_BOARD_HEIGHT,
  DEFAULT_BOARD_WIDTH,
  elementCount,
  type SceneDoc,
  type SceneElement,
  type ShapeKind,
} from '../scene';
import { PALETTE, PAPER_FILL } from '../tool-settings';
import { ARROW_MARKER_ID, ARROW_START_MARKER_ID, num, serializeWhiteboard } from '../serialize';

/** parse → serialize → parse; the second serialization must equal the first. */
function stabilize(source: string): { first: string; second: string; doc: SceneDoc } {
  const doc = parseWhiteboard(source);
  const first = serializeWhiteboard(doc);
  const second = serializeWhiteboard(parseWhiteboard(first));
  return { first, second, doc };
}

const BOARD = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:wb="urn:md-specpad:whiteboard" viewBox="0 0 1600 1000" width="1600" height="1000">
  <metadata><wb:doc>{"schema":1,"background":"#ffffff","view":{"scale":1.5}}</wb:doc></metadata>
  <rect wb:role="background" x="0" y="0" width="1600" height="1000" fill="#ffffff"/>
  <g wb:layer="a1B2" wb:name="Layer 1">
    <path wb:tool="pen" d="M10,10 C20,20 30,30 40,40" fill="none" stroke="#1f6fd0" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="100" y="120" width="80" height="40" fill="none" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round"/>
    <ellipse cx="300" cy="200" rx="50" ry="25" fill="#eeeeee" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round"/>
    <line x1="0" y1="0" x2="10" y2="10" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round" marker-end="url(#wb-arrow)"/>
    <text x="40" y="400" font-size="24" fill="#1a1a1a"><tspan x="40" dy="0">hello</tspan><tspan x="40" dy="1.2em">world</tspan></text>
  </g>
  <g wb:layer="c3D4" wb:name="Photo" wb:locked="true" display="none">
    <image x="0" y="0" width="100" height="100" href="data:image/png;base64,AAAA"/>
  </g>
</svg>
`;

describe('a whiteboard we wrote', () => {
  it('is a fixed point of serialization', () => {
    const { first, second } = stabilize(BOARD);
    expect(second).toBe(first);
  });

  it('reads a board saved before the rename (md-notepad namespace) and rewrites the namespace', () => {
    const old = BOARD.replace('urn:md-specpad:whiteboard', 'urn:md-notepad:whiteboard');
    const { first, doc } = stabilize(old);
    expect(elementCount(doc)).toBe(6);
    expect(first).toBe(stabilize(BOARD).first);
  });

  it('reads back every element with its geometry and style', () => {
    const doc = parseWhiteboard(BOARD);
    expect(doc.width).toBe(1600);
    expect(doc.viewBox).toEqual([0, 0, 1600, 1000]);
    expect(doc.background).toBe('#ffffff');
    expect(doc.layers.map((l) => l.id)).toEqual(['a1B2', 'c3D4']);
    expect(elementCount(doc)).toBe(6);

    const [ink, photo] = doc.layers;
    expect(ink!.name).toBe('Layer 1');
    expect(ink!.visible).toBe(true);
    expect(ink!.locked).toBe(false);
    expect(photo!.visible).toBe(false);
    expect(photo!.locked).toBe(true);

    const stroke = ink!.elements[0]!;
    expect(stroke).toMatchObject({
      kind: 'stroke',
      tool: 'pen',
      stroke: '#1f6fd0',
      strokeWidth: 4.2,
      d: 'M10,10 C20,20 30,30 40,40',
    });
    expect(ink!.elements[1]).toMatchObject({
      kind: 'shape',
      shape: 'rect',
      geom: { x: 100, y: 120, width: 80, height: 40 },
    });
    expect(ink!.elements[2]).toMatchObject({ kind: 'shape', shape: 'ellipse', fill: '#eeeeee' });
    // marker-end is what distinguishes an arrow from a plain line.
    expect(ink!.elements[3]).toMatchObject({ kind: 'shape', shape: 'arrow' });
    expect(ink!.elements[4]).toMatchObject({ kind: 'text', lines: ['hello', 'world'] });
    expect(photo!.elements[0]).toMatchObject({
      kind: 'image',
      href: 'data:image/png;base64,AAAA',
    });
  });

  it('preserves unknown metadata keys but regenerates schema and background', () => {
    const { first, doc } = stabilize(BOARD);
    expect(doc.meta).toEqual({ view: { scale: 1.5 } });
    expect(first).toContain('{"schema":1,"background":"#ffffff","view":{"scale":1.5}}');
  });

  it('does not emit a second arrow marker when the file already carries one', () => {
    const withDefs = BOARD.replace(
      '<g wb:layer="a1B2"',
      `<defs><marker id="${ARROW_MARKER_ID}"/></defs>\n  <g wb:layer="a1B2"`,
    );
    const out = serializeWhiteboard(parseWhiteboard(withDefs));
    expect(out.match(new RegExp(`id="${ARROW_MARKER_ID}"`, 'g'))).toHaveLength(1);
  });

  it('emits the arrow marker when an arrow exists and the file has no defs', () => {
    const out = serializeWhiteboard(parseWhiteboard(BOARD));
    expect(out).toContain(`<marker id="${ARROW_MARKER_ID}"`);
  });
});

/**
 * The phase-A promise: a file written BEFORE shape styling existed comes back
 * out byte-for-byte. Every new field's default emits no attribute at all, so
 * the proof is a canonical pre-phase-A body asserted verbatim, line by line.
 */
describe('a board written before shape styling', () => {
  const LEGACY_ELEMENTS = [
    '<path wb:tool="pen" class="wb-c3" d="M10,10 C20,20 30,30 40,40" fill="none" stroke="#1f6fd0" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/>',
    '<rect class="wb-c0" x="100" y="120" width="80" height="40" fill="none" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round"/>',
    '<ellipse class="wb-c0" cx="300" cy="200" rx="50" ry="25" fill="#eeeeee" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round"/>',
    '<line class="wb-c0" x1="0" y1="0" x2="10" y2="10" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round" marker-end="url(#wb-arrow)"/>',
    '<text class="wb-c0" x="40" y="400" font-size="24" fill="#1a1a1a"><tspan x="40" dy="0">hello</tspan><tspan x="40" dy="1.2em">world</tspan></text>',
  ];

  const LEGACY = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:wb="urn:md-specpad:whiteboard" viewBox="0 0 1600 1000" width="1600" height="1000">
  <g wb:layer="a1B2" wb:name="Layer 1">
    ${LEGACY_ELEMENTS.join('\n    ')}
  </g>
</svg>
`;

  it('re-emits every element byte-for-byte', () => {
    const { first, second } = stabilize(LEGACY);
    for (const element of LEGACY_ELEMENTS) {
      expect(first).toContain(element);
    }
    expect(second).toBe(first);
  });

  it('emits none of the new attributes for elements that never asked for them', () => {
    const { first } = stabilize(LEGACY);
    expect(first).not.toContain('stroke-dasharray');
    expect(first).not.toContain('marker-start');
    expect(first).not.toContain('wb:shape');
    // Phase B: groups and labels are opt-in per element, too.
    expect(first).not.toContain('wb:group');
    expect(first).not.toContain('wb:label-of');
    expect(first).not.toContain('text-anchor');
    // (an ellipse's own `rx` is geometry; only a rect's is a corner radius)
    expect(first).not.toMatch(/<rect[^>]* rx=/);
    expect(first).not.toContain(ARROW_START_MARKER_ID);
    // Phase D: a line drawn free, straight, says nothing about connectors.
    expect(first).not.toContain('wb:from=');
    expect(first).not.toContain('wb:to=');
    expect(first).not.toContain('wb:route');
  });
});

describe('shape styling', () => {
  function withShapes(...elements: string[]): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:wb="urn:md-specpad:whiteboard" viewBox="0 0 400 300" width="400" height="300">
  <g wb:layer="a1B2" wb:name="L">
    ${elements.join('\n    ')}
  </g>
</svg>
`;
  }

  it('round-trips a dash, a corner radius and a reversed arrow head', () => {
    const source = withShapes(
      '<rect x="10" y="10" width="80" height="40" rx="12" fill="none" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round" stroke-dasharray="8 5"/>',
      '<line x1="0" y1="0" x2="50" y2="0" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round" marker-start="url(#wb-arrow-start)" marker-end="url(#wb-arrow)"/>',
    );
    const doc = parseWhiteboard(source);
    expect(doc.layers[0]!.elements[0]).toMatchObject({ shape: 'rect', rx: 12, dash: '8 5' });
    expect(doc.layers[0]!.elements[1]).toMatchObject({ shape: 'arrow', markerStart: true });
    const out = serializeWhiteboard(doc);
    expect(out).toContain('rx="12"');
    expect(out).toContain('stroke-dasharray="8 5"');
    expect(out).toContain(`marker-start="url(#${ARROW_START_MARKER_ID})"`);
    expect(serializeWhiteboard(parseWhiteboard(out))).toBe(out);
  });

  it('brings a reversed marker def with it, mirrored rather than auto-start-reverse', () => {
    const out = serializeWhiteboard(
      parseWhiteboard(
        withShapes(
          '<line x1="0" y1="0" x2="50" y2="0" stroke="#1a1a1a" stroke-width="2" marker-start="url(#wb-arrow-start)"/>',
        ),
      ),
    );
    // The mirror is the head; the attribute stays plain `auto`, which every
    // SVG 1.1 renderer understands (see ARROW_START_MARKER_ID).
    expect(out).toContain(`<marker id="${ARROW_START_MARKER_ID}"`);
    expect(out).toContain('<path d="M10,0 L0,5 L10,10 z"');
    expect(out).toMatch(/id="wb-arrow-start"[^>]*orient="auto">/);
    // A line with only a start head is still a `line`, so no end marker.
    expect(out).not.toContain(`marker-end`);
    expect(out).not.toContain(`id="${ARROW_MARKER_ID}"`);
  });

  it('themes a fill through its own class, alongside the stroke’s', () => {
    const out = serializeWhiteboard(
      parseWhiteboard(
        withShapes(
          `<rect x="0" y="0" width="10" height="10" fill="${PALETTE[3]}" stroke="${PALETTE[1]}" stroke-width="2"/>`,
        ),
      ),
    );
    expect(out).toContain('class="wb-c1 wb-f3"');
    expect(serializeWhiteboard(parseWhiteboard(out))).toBe(out);
  });

  it('gives a Paper-filled shape the same class the page rect themes through', () => {
    const out = serializeWhiteboard(
      parseWhiteboard(
        withShapes(
          `<rect x="0" y="0" width="10" height="10" fill="${PAPER_FILL}" stroke="${PALETTE[0]}" stroke-width="2"/>`,
        ),
      ),
    );
    expect(out).toContain('class="wb-c0 wb-bg"');
    // The literal stays white — a CSS-less renderer must still paint paper.
    expect(out).toContain(`fill="${PAPER_FILL}"`);
    expect(serializeWhiteboard(parseWhiteboard(out))).toBe(out);
  });
});

describe('groups and labels (phase B)', () => {
  const LABELLED_ELEMENTS = [
    '<rect wb:id="bx1" wb:group="g1" class="wb-c0" x="100" y="100" width="200" height="100" fill="none" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round"/>',
    '<text wb:group="g1" wb:label-of="bx1" class="wb-c0" x="200" y="157" font-size="20" text-anchor="middle" fill="#1a1a1a"><tspan x="200" dy="0">Service</tspan><tspan x="200" dy="1.2em">API</tspan></text>',
    '<path wb:group="g1" wb:tool="pen" class="wb-c0" d="M1,1 L2,2" fill="none" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    '<image wb:id="im1" wb:group="g2" x="0" y="0" width="10" height="10" href="data:image/png;base64,AAAA"/>',
  ];

  const LABELLED = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:wb="urn:md-specpad:whiteboard" viewBox="0 0 400 300" width="400" height="300">
  <g wb:layer="a1B2" wb:name="L">
    ${LABELLED_ELEMENTS.join('\n    ')}
  </g>
</svg>
`;

  it('reads the tags back and re-emits every element byte-for-byte, id then group first', () => {
    const { first, second, doc } = stabilize(LABELLED);
    expect(second).toBe(first);
    for (const element of LABELLED_ELEMENTS) {
      expect(first).toContain(element);
    }
    const [box, label, ink, picture] = doc.layers[0]!.elements;
    expect(box).toMatchObject({ kind: 'shape', id: 'bx1', group: 'g1' });
    expect(label).toMatchObject({
      kind: 'text',
      group: 'g1',
      labelOf: 'bx1',
      x: 200,
      lines: ['Service', 'API'],
    });
    expect(ink).toMatchObject({ kind: 'stroke', group: 'g1', id: null });
    expect(picture).toMatchObject({ kind: 'image', id: 'im1', group: 'g2' });
  });

  it('derives text-anchor from label-of rather than storing it', () => {
    const doc = parseWhiteboard(LABELLED);
    const label = doc.layers[0]!.elements[1]!;
    const freed = { ...label, labelOf: null } as SceneElement;
    const out = serializeWhiteboard({
      ...doc,
      layers: [{ ...doc.layers[0]!, elements: [freed] }],
    });
    expect(out).not.toContain('text-anchor');
    expect(out).not.toContain('wb:label-of');
    // And a label written without the anchor (a hand edit) gets it back.
    const bare = LABELLED.replace(' text-anchor="middle"', '');
    expect(serializeWhiteboard(parseWhiteboard(bare))).toContain(LABELLED_ELEMENTS[1]!);
  });
});

describe('the box shapes', () => {
  function boardWith(element: SceneElement): SceneDoc {
    return createScene({ layers: [createLayer({ id: 'a1B2', elements: [element] })] });
  }

  const shape = (kind: ShapeKind): SceneElement => ({
    kind: 'shape',
    id: null,
    group: null,
    shape: kind,
    geom: { x: 10, y: 20, width: 100, height: 60 },
    stroke: '#1a1a1a',
    strokeWidth: 2,
    fill: 'none',
    opacity: null,
    dash: null,
    rx: null,
    markerStart: false,
    from: null,
    to: null,
    route: 'straight',
  });

  it('round-trips every one of them, box and all', () => {
    for (const kind of BOX_SHAPES) {
      const source = serializeWhiteboard(boardWith(shape(kind)));
      expect(source).toContain(`wb:shape="${kind}"`);
      const back = parseWhiteboard(source).layers[0]!.elements[0];
      expect(back).toMatchObject({
        kind: 'shape',
        shape: kind,
        geom: { x: 10, y: 20, width: 100, height: 60 },
      });
      // And the serializer is still a fixed point with them in the file.
      expect(serializeWhiteboard(parseWhiteboard(source))).toBe(source);
    }
  });

  it('recovers a polygon’s box from its own vertices — no extra attribute', () => {
    const source = serializeWhiteboard(boardWith(shape('diamond')));
    expect(source).toContain(
      '<polygon wb:shape="diamond" class="wb-c0" points="60,20 110,50 60,80 10,50"',
    );
    expect(source).not.toContain('wb:box');
  });

  it('gives the cylinder wb:box, because two arcs cannot name their own box', () => {
    const source = serializeWhiteboard(boardWith(shape('cylinder')));
    expect(source).toContain('<path wb:shape="cylinder" class="wb-c0" wb:box="10 20 100 60"');
    expect(source).toContain('d="M10,30A50,10 0 0 1 110,30');
  });

  it('leaves a polygon nobody claimed as untouched raw content', () => {
    const doc = parseWhiteboard(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g wb:layer="aaaa" wb:name="L"><polygon wb:shape="trapezoid" points="0,0 1,1 2,2"/></g></svg>`,
    );
    expect(doc.layers[0]!.elements[0]).toMatchObject({ kind: 'raw' });
  });

  it('refuses a cylinder whose box was lost rather than putting it at the origin', () => {
    const doc = parseWhiteboard(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g wb:layer="aaaa" wb:name="L"><path wb:shape="cylinder" d="M0,0"/></g></svg>`,
    );
    expect(doc.layers[0]!.elements[0]).toMatchObject({ kind: 'raw' });
  });
});

describe('foreign SVGs', () => {
  // Shaped after a real Inkscape save: xml declaration, comment, its own
  // namespaces on the root, a namedview element and a transformed group.
  const INKSCAPE = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape (http://www.inkscape.org/) -->
<svg xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:svg="http://www.w3.org/2000/svg" xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="210mm" height="297mm" viewBox="0 0 210 297" version="1.1" id="svg5" inkscape:version="1.1">
  <sodipodi:namedview id="namedview7" pagecolor="#ffffff" inkscape:zoom="0.7"/>
  <defs id="defs2"><linearGradient id="grad"><stop offset="0" stop-color="#f00"/></linearGradient></defs>
  <g inkscape:label="Layer 1" inkscape:groupmode="layer" id="layer1" transform="translate(3,4)">
    <path style="fill:#ff0000" d="M 10,10 20,20 Z" id="path846"/>
  </g>
</svg>
`;

  it('opens as one locked "Imported" layer instead of failing', () => {
    const doc = parseWhiteboard(INKSCAPE);
    expect(doc.layers).toHaveLength(1);
    const imported = doc.layers[0]!;
    expect(imported.kind).toBe('foreign');
    expect(imported.locked).toBe(true);
    expect(imported.name).toBe('Imported');
    // The namedview and the drawing group both landed there, in order.
    expect(imported.elements).toHaveLength(2);
  });

  it('keeps every foreign element, attribute and comment through a round trip', () => {
    const { first, second } = stabilize(INKSCAPE);
    expect(second).toBe(first);
    // Verbatim body, including the transform we deliberately never bake.
    expect(first).toContain('transform="translate(3,4)"');
    expect(first).toContain('<path style="fill:#ff0000" d="M 10,10 20,20 Z" id="path846"/>');
    expect(first).toContain('<sodipodi:namedview id="namedview7"');
    // Non-layer top-level content is prelude, not a layer.
    expect(first).toContain('<linearGradient id="grad">');
    // Foreign root attributes (namespaces, version, id) survive.
    expect(first).toContain('xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"');
    expect(first).toContain('id="svg5"');
    expect(first).toContain('version="1.1"');
  });

  it('takes the board size from the viewBox when width/height carry units', () => {
    const doc = parseWhiteboard(INKSCAPE);
    // '210mm' parses to 210, which matches the viewBox — the units are dropped
    // deliberately: scene coordinates are unitless user units.
    expect(doc.width).toBe(210);
    expect(doc.viewBox).toEqual([0, 0, 210, 297]);
  });

  it('keeps foreign content in z-order relative to our own layers', () => {
    const mixed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
  <g wb:layer="aaaa" wb:name="Under"/>
  <circle cx="1" cy="1" r="1"/>
  <g wb:layer="bbbb" wb:name="Over"/>
</svg>`;
    const doc = parseWhiteboard(mixed);
    expect(doc.layers.map((l) => l.id)).toEqual(['aaaa', 'imported', 'bbbb']);
  });

  it('normalizes a circle to an ellipse inside one of OUR layers', () => {
    const doc = parseWhiteboard(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g wb:layer="aaaa" wb:name="L"><circle cx="1" cy="2" r="3" stroke="#000"/></g></svg>`,
    );
    expect(doc.layers[0]!.elements[0]).toMatchObject({
      kind: 'shape',
      shape: 'ellipse',
      geom: { cx: 1, cy: 2, rx: 3, ry: 3 },
    });
  });

  it('preserves an unmodeled element inside our own layer verbatim', () => {
    const doc = parseWhiteboard(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g wb:layer="aaaa" wb:name="L"><polygon points="0,0 1,1"/></g></svg>`,
    );
    expect(doc.layers[0]!.elements[0]).toEqual({
      kind: 'raw',
      xml: '<polygon points="0,0 1,1"/>',
    });
    expect(serializeWhiteboard(doc)).toContain('<polygon points="0,0 1,1"/>');
  });

  it("preserves a scan layer's hidden OCR group and its wb:kind", () => {
    const scan = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
  <g wb:layer="e5F6" wb:name="Scan 1" wb:kind="scan"><desc>ARCHITECTURE</desc><g wb:ocr="text" opacity="0"><text x="1" y="2">ARCHITECTURE</text></g><path wb:id="s1" wb:tool="pen" d="M1 1" stroke="#1f6fd0" stroke-width="4"/></g>
</svg>`;
    const doc = parseWhiteboard(scan);
    const layer = doc.layers[0]!;
    expect(layer.kind).toBe('scan');
    expect(layer.elements[1]).toMatchObject({ kind: 'raw' });
    expect(layer.elements[2]).toMatchObject({ kind: 'stroke', id: 's1' });
    const out = serializeWhiteboard(doc);
    expect(out).toContain('wb:kind="scan"');
    expect(out).toContain('<g wb:ocr="text" opacity="0"><text x="1" y="2">ARCHITECTURE</text></g>');
    expect(serializeWhiteboard(parseWhiteboard(out))).toBe(out);
  });
});

describe('degenerate input', () => {
  it('throws WhiteboardParseError on malformed XML', () => {
    expect(() => parseWhiteboard('<svg><g></svg>')).toThrow(WhiteboardParseError);
    expect(() => parseWhiteboard('')).toThrow(WhiteboardParseError);
  });

  it('throws when the root is not <svg>', () => {
    expect(() => parseWhiteboard('<html/>')).toThrow(/expected <svg>/);
  });

  it('survives corrupt editor metadata — the strokes are in the SVG body', () => {
    const doc = parseWhiteboard(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><metadata><wb:doc>{not json</wb:doc></metadata><g wb:layer="aaaa" wb:name="L"><path wb:tool="pen" d="M1 1" stroke="#000" stroke-width="2"/></g></svg>`,
    );
    expect(doc.meta).toEqual({});
    expect(elementCount(doc)).toBe(1);
  });

  it('falls back to a default board when the viewBox is missing or degenerate', () => {
    const doc = parseWhiteboard('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(doc.viewBox).toEqual([0, 0, DEFAULT_BOARD_WIDTH, DEFAULT_BOARD_HEIGHT]);
    // No background rect and no metadata background = an infinite board.
    expect(doc.background).toBeNull();
  });

  it('escapes text and attribute content that would otherwise break the file', () => {
    const doc = createScene({
      layers: [
        createLayer({
          id: 'aaaa',
          name: 'a & b <c>',
          elements: [
            {
              kind: 'text',
              id: null,
              group: null,
              labelOf: null,
              fontFamily: null,
              x: 0,
              y: 0,
              fontSize: 12,
              fill: '#000',
              lines: ['x < y & z'],
            },
          ],
        }),
      ],
    });
    const out = serializeWhiteboard(doc);
    // '>' needs no escaping inside an attribute value; '&' and '<' do.
    expect(out).toContain('wb:name="a &amp; b &lt;c>"');
    expect(out).toContain('x &lt; y &amp; z');
    const back = parseWhiteboard(out);
    expect(back.layers[0]!.name).toBe('a & b <c>');
    expect(back.layers[0]!.elements[0]).toMatchObject({ lines: ['x < y & z'] });
  });
});

describe('num', () => {
  it('rounds to two decimals and normalizes -0', () => {
    expect(num(1.23456)).toBe('1.23');
    expect(num(2)).toBe('2');
    expect(num(-0.001)).toBe('0');
    expect(num(Number.NaN)).toBe('0');
  });
});

describe('createScene', () => {
  it('produces a blank board that round-trips', () => {
    const source = serializeWhiteboard(createScene());
    expect(serializeWhiteboard(parseWhiteboard(source))).toBe(source);
    expect(parseWhiteboard(source).layers).toHaveLength(1);
  });
});

describe('connectors (phase D)', () => {
  const CONNECTED_ELEMENTS = [
    '<rect wb:id="a" class="wb-c0" x="0" y="0" width="100" height="60" fill="none" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round"/>',
    '<ellipse wb:id="b" class="wb-c0" cx="350" cy="130" rx="50" ry="30" fill="none" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round"/>',
    // A straight connector is still a <line>; the links ride in wb: attributes.
    '<line wb:from="a:e" wb:to="b:w" class="wb-c0" x1="100" y1="30" x2="300" y2="130" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round" marker-end="url(#wb-arrow)"/>',
    // An elbow is a <path> whose waypoints the router derived; it names itself
    // so parse can tell it from foreign geometry.
    '<path wb:from="a:s" wb:to="b:n" wb:route="elbow" wb:shape="elbow" class="wb-c0" d="M50,60 L50,80 L350,80 L350,100" fill="none" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#wb-arrow)"/>',
    // A free elbow line: no links, no marker, still routed.
    '<path wb:route="elbow" wb:shape="elbow" class="wb-c0" d="M0,200 L50,200 L50,260 L100,260" fill="none" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  ];

  const CONNECTED = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:wb="urn:md-specpad:whiteboard" viewBox="0 0 400 300" width="400" height="300">
  <g wb:layer="a1B2" wb:name="L">
    ${CONNECTED_ELEMENTS.join('\n    ')}
  </g>
</svg>
`;

  it('re-emits every element byte-for-byte and reads the links back', () => {
    const { first, second, doc } = stabilize(CONNECTED);
    expect(second).toBe(first);
    for (const element of CONNECTED_ELEMENTS) {
      expect(first).toContain(element);
    }
    const [, , straight, elbow, free] = doc.layers[0]!.elements;
    expect(straight).toMatchObject({
      shape: 'arrow',
      route: 'straight',
      from: { id: 'a', port: 'e' },
      to: { id: 'b', port: 'w' },
      geom: { x1: 100, y1: 30, x2: 300, y2: 130 },
    });
    // The elbow's geometry is its first and last point; the bends are derived.
    expect(elbow).toMatchObject({
      shape: 'arrow',
      route: 'elbow',
      from: { id: 'a', port: 's' },
      to: { id: 'b', port: 'n' },
      geom: { x1: 50, y1: 60, x2: 350, y2: 100 },
    });
    expect(free).toMatchObject({
      shape: 'line',
      route: 'elbow',
      from: null,
      to: null,
      geom: { x1: 0, y1: 200, x2: 100, y2: 260 },
    });
  });

  it('routes an elbow from its ports when it writes the path', () => {
    const doc = parseWhiteboard(CONNECTED);
    const elbow = doc.layers[0]!.elements[3]!;
    // Same ends, but leaving `a` sideways: one bend instead of two.
    const bent = { ...elbow, from: { id: 'a', port: 'e' } } as SceneElement;
    const out = serializeWhiteboard({ ...doc, layers: [{ ...doc.layers[0]!, elements: [bent] }] });
    expect(out).toContain('d="M50,60 L350,60 L350,100"');
  });

  it('drops a reference it cannot read rather than guessing a port', () => {
    const source = CONNECTED.replace('wb:from="a:e"', 'wb:from="a:x"').replace(
      'wb:to="b:w"',
      'wb:to="nocolon"',
    );
    const line = parseWhiteboard(source).layers[0]!.elements[2]!;
    expect(line).toMatchObject({ from: null, to: null });
    expect(serializeWhiteboard(parseWhiteboard(source))).not.toContain('wb:from="a:x"');
  });

  it('keeps an elbow path with no line in it as raw content', () => {
    const doc = parseWhiteboard(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g wb:layer="aaaa" wb:name="L"><path wb:shape="elbow" d="M1,1"/></g></svg>`,
    );
    expect(doc.layers[0]!.elements[0]).toMatchObject({ kind: 'raw' });
  });

  it('ignores connector attributes on a shape that is not a line', () => {
    const doc = parseWhiteboard(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g wb:layer="aaaa" wb:name="L"><rect wb:from="a:e" wb:route="elbow" x="0" y="0" width="5" height="5"/></g></svg>`,
    );
    expect(doc.layers[0]!.elements[0]).toMatchObject({ from: null, to: null, route: 'straight' });
  });
});
