/**
 * SVG source → {@link SceneDoc}. Pure; the inverse of `serialize.ts`.
 *
 * The contract this file owes the rest of the app:
 *
 * 1. **Never lose content.** Anything not modeled is preserved verbatim from
 *    the original source — top-level oddities in `prelude`, in-layer oddities
 *    as {@link RawElement}, unknown attributes in `extras`, unknown metadata
 *    keys in `meta`.
 * 2. **Never throw on valid XML.** A foreign SVG (Inkscape, Excalidraw export,
 *    hand-authored) parses fine: its renderable content becomes one locked
 *    "Imported" layer. Only malformed XML throws — {@link WhiteboardParseError},
 *    which the adapter surfaces as the "open as text" error card.
 *
 * {@link parseWhiteboardWithSpans} additionally reports WHERE each element came
 * from in the source text. It is the same walk — `parseWhiteboard` is a thin
 * wrapper over it — precisely so the two can never disagree about which node
 * became element `n` of layer `l`; Split mode's raw ⇄ draw linking
 * (`locate.ts`) is only correct while they agree.
 */

import {
  attr,
  childElements,
  isBlankText,
  localName,
  numAttr,
  parseXml,
  rawSource,
  textContent,
  XmlError,
  type XmlElement,
  type XmlNode,
} from './xml';
import { boundsOfPoints, flattenPathData, type Point } from './geometry';
import {
  DEFAULT_BOARD_HEIGHT,
  DEFAULT_BOARD_WIDTH,
  isBoxShape,
  isConnectorPort,
  SCENE_SCHEMA,
  type BoxShapeKind,
  type ConnectorEnd,
  type ImageElement,
  type Layer,
  type LayerKind,
  type SceneAttr,
  type SceneDoc,
  type SceneElement,
  type ShapeElement,
  type ShapeKind,
  type StrokeElement,
  type TextElement,
} from './scene';
import { paletteSlot } from './tool-settings';

export class WhiteboardParseError extends Error {
  constructor(
    message: string,
    /** Byte offset into the source, or null when not position-specific. */
    readonly offset: number | null = null,
  ) {
    super(message);
    this.name = 'WhiteboardParseError';
  }
}

/** Root attributes the serializer regenerates; everything else is preserved. */
const OWNED_ROOT_ATTRS = new Set(['xmlns', 'xmlns:wb', 'viewBox', 'width', 'height']);
/** Layer `<g>` attributes the serializer regenerates. */
const OWNED_LAYER_ATTRS = new Set(['wb:layer', 'wb:name', 'wb:kind', 'wb:locked', 'display']);
/** Top-level elements that carry no pixels of their own — kept as prelude. */
const PRELUDE_ELEMENTS = new Set(['defs', 'style', 'title', 'desc', 'metadata']);

/**
 * Where one element of one layer lives in the source text, `[start, end)` —
 * the same coordinates `xml.ts` hands out, so slicing the source at them gives
 * back exactly the markup that element was read from.
 *
 * `layerId` + `index` is an `ElementRef` (`layers.ts`): the pair addresses the
 * same element the scene does, which is what lets Split mode point at the
 * source of what is selected on the board and back again.
 */
export interface ElementSpan {
  readonly layerId: string;
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

export interface ParsedWhiteboard {
  readonly doc: SceneDoc;
  /** One entry per element of every layer, in the layers' own order. */
  readonly spans: readonly ElementSpan[];
}

export function parseWhiteboard(source: string): SceneDoc {
  return parseWhiteboardWithSpans(source).doc;
}

export function parseWhiteboardWithSpans(source: string): ParsedWhiteboard {
  let doc;
  try {
    doc = parseXml(source);
  } catch (error) {
    if (error instanceof XmlError) {
      throw new WhiteboardParseError(error.message, error.offset);
    }
    throw error;
  }

  const root = doc.root;
  if (localName(root.name) !== 'svg') {
    throw new WhiteboardParseError(`root element is <${root.name}>, expected <svg>`, root.start);
  }

  const viewBox = readViewBox(root);
  const width = numAttr(root, 'width', viewBox[2]);
  const height = numAttr(root, 'height', viewBox[3]);

  const prelude: string[] = [];
  const layers: Layer[] = [];
  /** Parallel to `layers`, spliced with it — see the foreign layer below. */
  const spansByLayer: ElementSpan[][] = [];
  const foreign: string[] = [];
  const foreignSpans: { start: number; end: number }[] = [];
  let foreignIndex = -1;
  let meta: Record<string, unknown> = {};
  let background: string | null = null;
  let sawMeta = false;

  for (const node of root.children) {
    if (isBlankText(source, node)) {
      continue;
    }
    if (node.type !== 'element') {
      // Comments, PIs, CDATA and stray text ride along untouched.
      prelude.push(rawSource(source, node));
      continue;
    }
    const name = localName(node.name);

    if (name === 'metadata') {
      const wbDoc = childElements(node).find((c) => localName(c.name) === 'doc');
      if (wbDoc && !sawMeta) {
        // Ours: the whole <metadata> is regenerated on save.
        sawMeta = true;
        const parsed = readMeta(source, wbDoc);
        background = parsed.background;
        meta = parsed.rest;
        continue;
      }
      prelude.push(rawSource(source, node));
      continue;
    }

    if (name === 'style' && attr(node, 'wb:role') === 'palette') {
      // The serializer-owned palette block: tool-owned, regenerated wholesale
      // on save. Freezing it as prelude would pin a stale palette forever.
      continue;
    }

    if (name === 'rect' && attr(node, 'wb:role') === 'background') {
      // The rendered backdrop; regenerated from `background` on save.
      background = attr(node, 'fill') ?? background;
      continue;
    }

    if (name === 'g' && attr(node, 'wb:layer') !== null) {
      const read = readLayer(source, node);
      layers.push(read.layer);
      spansByLayer.push(read.spans);
      continue;
    }

    if (PRELUDE_ELEMENTS.has(name)) {
      prelude.push(rawSource(source, node));
      continue;
    }

    // Renderable content that isn't one of our layers: a foreign SVG's body.
    if (foreignIndex < 0) {
      foreignIndex = layers.length;
    }
    foreign.push(rawSource(source, node));
    foreignSpans.push({ start: node.start, end: node.end });
  }

  if (foreign.length > 0) {
    // One locked layer, placed where its first element appeared, so foreign
    // content keeps its z-order relative to any wb: layers around it.
    layers.splice(foreignIndex, 0, {
      id: 'imported',
      name: 'Imported',
      visible: true,
      locked: true,
      kind: 'foreign' satisfies LayerKind,
      elements: foreign.map((xml) => ({ kind: 'raw', xml }) satisfies SceneElement),
      extras: [],
    });
    spansByLayer.splice(
      foreignIndex,
      0,
      foreignSpans.map((span, index) => ({ layerId: 'imported', index, ...span })),
    );
  }

  return {
    doc: {
      schema: SCENE_SCHEMA,
      width: Number.isFinite(width) && width > 0 ? width : DEFAULT_BOARD_WIDTH,
      height: Number.isFinite(height) && height > 0 ? height : DEFAULT_BOARD_HEIGHT,
      viewBox,
      // No background rect and no metadata background = an INFINITE board (the
      // default since phase 2.5-followup); the palette block paints the surface.
      background,
      rootExtras: rootExtrasOf(root),
      prelude,
      layers,
      meta,
    },
    spans: spansByLayer.flat(),
  };
}

/* -------------------------------------------------------------------------- */

function readViewBox(root: XmlElement): [number, number, number, number] {
  const raw = attr(root, 'viewBox');
  const parts = raw
    ? raw
        .trim()
        .split(/[\s,]+/)
        .map((n) => Number.parseFloat(n))
    : [];
  if (
    parts.length === 4 &&
    parts.every((n) => Number.isFinite(n)) &&
    parts[2]! > 0 &&
    parts[3]! > 0
  ) {
    return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
  }
  const width = numAttr(root, 'width', DEFAULT_BOARD_WIDTH);
  const height = numAttr(root, 'height', DEFAULT_BOARD_HEIGHT);
  return [
    0,
    0,
    width > 0 ? width : DEFAULT_BOARD_WIDTH,
    height > 0 ? height : DEFAULT_BOARD_HEIGHT,
  ];
}

function readMeta(
  source: string,
  wbDoc: XmlElement,
): { background: string | null; rest: Record<string, unknown> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textContent(source, wbDoc).trim() || '{}');
  } catch {
    // Corrupt editor metadata is not corrupt DRAWING data — the strokes are in
    // the SVG body. Drop the metadata and carry on rather than failing the open.
    return { background: null, rest: {} };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { background: null, rest: {} };
  }
  const record = { ...(parsed as Record<string, unknown>) };
  const background = typeof record.background === 'string' ? record.background : null;
  delete record.background;
  delete record.schema; // regenerated
  return { background, rest: record };
}

function extrasOf(element: XmlElement, owned: ReadonlySet<string>): SceneAttr[] {
  return element.attrs
    .filter((a) => !owned.has(a.name))
    .map((a) => ({ name: a.name, value: a.value }));
}

/**
 * Root extras, with the serializer's own `wb-board` / `wb-fixed` tokens
 * removed from any `class` attribute — serialize re-derives both (wb-board
 * merged in front of a foreign class, wb-fixed from the metadata colorMode),
 * so leaving them here would emit the attribute twice and grow duplicate
 * tokens on every round trip.
 */
function rootExtrasOf(root: XmlElement): SceneAttr[] {
  return extrasOf(root, OWNED_ROOT_ATTRS).flatMap((a) => {
    if (a.name !== 'class') {
      return [a];
    }
    const rest = a.value
      .split(/\s+/)
      .filter((token) => token.length > 0 && token !== 'wb-board' && token !== 'wb-fixed')
      .join(' ');
    return rest.length > 0 ? [{ name: 'class', value: rest }] : [];
  });
}

function readLayer(source: string, group: XmlElement): { layer: Layer; spans: ElementSpan[] } {
  const kindAttr = attr(group, 'wb:kind');
  const kind: LayerKind =
    kindAttr === 'scan' ? 'scan' : kindAttr === 'foreign' ? 'foreign' : 'draw';
  const id = attr(group, 'wb:layer') ?? 'layer';
  const elements: SceneElement[] = [];
  const spans: ElementSpan[] = [];
  for (const node of group.children) {
    if (isBlankText(source, node)) {
      continue;
    }
    spans.push({ layerId: id, index: elements.length, start: node.start, end: node.end });
    // A foreign layer's body is somebody else's markup, read verbatim exactly
    // as it was on the first open. Modeling it here would hand it to the
    // element writers on the next save, which know only our own attributes and
    // would drop its transforms, styles and ids.
    elements.push(
      kind === 'foreign'
        ? { kind: 'raw', xml: rawSource(source, node) }
        : readElement(source, node),
    );
  }
  return {
    layer: {
      id,
      name: attr(group, 'wb:name') ?? 'Layer',
      visible: attr(group, 'display') !== 'none',
      locked: attr(group, 'wb:locked') === 'true',
      // 'foreign' matters on re-read: once we have wrapped an imported SVG's
      // body in an Imported layer, re-opening the saved file must recognize it
      // as still-foreign (locked, not tool-owned), not demote it to a draw layer.
      kind,
      elements,
      extras: extrasOf(group, OWNED_LAYER_ATTRS),
    },
    spans,
  };
}

/**
 * The palette slot named by an element's `class` (`wb-cN` for stroked ink and
 * text, `wb-fN` for fill-painted scan blobs), as `{ slot?: number }` ready to
 * spread into the element. Stored ONLY when it cannot be re-derived from the
 * colour — an element whose colour IS the slot's palette hex parses slot-free,
 * so pre-dual files and freshly drawn ink stay structurally identical.
 */
function storedSlot(
  element: XmlElement,
  color: string,
  pattern = /^wb-[cf]([0-7])$/,
): {
  slot?: number;
} {
  const classAttr = attr(element, 'class');
  if (classAttr === null) {
    return {};
  }
  for (const token of classAttr.split(/\s+/)) {
    const match = pattern.exec(token);
    if (match) {
      const slot = Number(match[1]);
      return slot === paletteSlot(color) ? {} : { slot };
    }
  }
  return {};
}

function readElement(source: string, node: XmlNode): SceneElement {
  if (node.type !== 'element') {
    return { kind: 'raw', xml: rawSource(source, node) };
  }
  const parsed = readModeled(source, node);
  return parsed ?? { kind: 'raw', xml: rawSource(source, node) };
}

/** Recognized element, or null → the caller preserves it verbatim. */
function readModeled(source: string, element: XmlElement): SceneElement | null {
  const name = localName(element.name);
  const id = attr(element, 'wb:id');
  const group = attr(element, 'wb:group');
  const opacity = optionalNum(element, 'opacity');

  if (name === 'polygon' || name === 'path') {
    // A box shape NAMES itself: an anonymous `<polygon>` belongs to whoever
    // wrote it and stays a RawElement, which is the promise the format has
    // always made about unmodeled content.
    const declared = attr(element, 'wb:shape');
    if (declared !== null && isBoxShape(declared)) {
      const box = boxGeometry(element, declared);
      return box === null ? null : shape(element, declared, box);
    }
    if (name === 'path' && declared === 'elbow') {
      // An elbow connector: the waypoints are derived, so only the first and
      // last point of the path are geometry. Fewer than two and there is no
      // line to recover — it stays raw rather than collapsing to a point.
      const points = flattenPathData(attr(element, 'd') ?? '').flat();
      const first = points[0];
      const last = points[points.length - 1];
      if (first === undefined || last === undefined || points.length < 2) {
        return null;
      }
      const kind: ShapeKind = attr(element, 'marker-end') ? 'arrow' : 'line';
      return shape(element, kind, { x1: first.x, y1: first.y, x2: last.x, y2: last.y }, 'elbow');
    }
  }

  if (name === 'path') {
    const tool = attr(element, 'wb:tool');
    if (tool === 'scanfill') {
      // A traced blob: colour rides in `fill`; `stroke` is literally "none".
      const fill = attr(element, 'fill') ?? '#000000';
      return {
        kind: 'stroke',
        id,
        group,
        tool,
        d: attr(element, 'd') ?? '',
        stroke: fill,
        strokeWidth: 0,
        opacity,
        widths: null,
        ...storedSlot(element, fill),
      } satisfies StrokeElement;
    }
    if (tool !== 'pen' && tool !== 'highlighter') {
      return null; // foreign geometry — keep as-is
    }
    const stroke = attr(element, 'stroke') ?? '#000000';
    return {
      kind: 'stroke',
      id,
      group,
      tool,
      d: attr(element, 'd') ?? '',
      stroke,
      strokeWidth: numAttr(element, 'stroke-width', 1),
      opacity,
      widths: attr(element, 'wb:widths'),
      ...storedSlot(element, stroke),
    } satisfies StrokeElement;
  }

  if (name === 'rect') {
    return shape(element, 'rect', {
      x: numAttr(element, 'x', 0),
      y: numAttr(element, 'y', 0),
      width: numAttr(element, 'width', 0),
      height: numAttr(element, 'height', 0),
    });
  }

  if (name === 'ellipse') {
    return shape(element, 'ellipse', {
      cx: numAttr(element, 'cx', 0),
      cy: numAttr(element, 'cy', 0),
      rx: numAttr(element, 'rx', 0),
      ry: numAttr(element, 'ry', 0),
    });
  }

  if (name === 'circle') {
    // Normalized to an ellipse — the editor has one radial shape, and the
    // rewrite only reaches the file after a genuine edit (write-back guard).
    const r = numAttr(element, 'r', 0);
    return shape(element, 'ellipse', {
      cx: numAttr(element, 'cx', 0),
      cy: numAttr(element, 'cy', 0),
      rx: r,
      ry: r,
    });
  }

  if (name === 'line') {
    const kind: ShapeKind = attr(element, 'marker-end') ? 'arrow' : 'line';
    return shape(element, kind, {
      x1: numAttr(element, 'x1', 0),
      y1: numAttr(element, 'y1', 0),
      x2: numAttr(element, 'x2', 0),
      y2: numAttr(element, 'y2', 0),
    });
  }

  if (name === 'text') {
    const tspans = childElements(element).filter((c) => localName(c.name) === 'tspan');
    const lines =
      tspans.length > 0
        ? tspans.map((t) => textContent(source, t))
        : [textContent(source, element)];
    const fill = attr(element, 'fill') ?? '#000000';
    return {
      kind: 'text',
      id,
      group,
      labelOf: attr(element, 'wb:label-of'),
      x: numAttr(element, 'x', 0),
      y: numAttr(element, 'y', 0),
      fontSize: numAttr(element, 'font-size', 16),
      fontFamily: attr(element, 'font-family') ?? null,
      fill,
      lines,
      ...storedSlot(element, fill),
    } satisfies TextElement;
  }

  if (name === 'image') {
    const href = attr(element, 'href') ?? attr(element, 'xlink:href');
    if (href === null) {
      return null;
    }
    return {
      kind: 'image',
      id,
      group,
      x: numAttr(element, 'x', 0),
      y: numAttr(element, 'y', 0),
      width: numAttr(element, 'width', 0),
      height: numAttr(element, 'height', 0),
      href,
      opacity,
    } satisfies ImageElement;
  }

  return null;
}

function shape(
  element: XmlElement,
  kind: ShapeKind,
  geom: Record<string, number>,
  declaredRoute: 'straight' | 'elbow' = 'straight',
): ShapeElement {
  const stroke = attr(element, 'stroke') ?? '#000000';
  const line = kind === 'line' || kind === 'arrow';
  return {
    kind: 'shape',
    id: attr(element, 'wb:id'),
    group: attr(element, 'wb:group'),
    shape: kind,
    geom,
    stroke,
    strokeWidth: numAttr(element, 'stroke-width', 1),
    // An elbow path says `fill="none"` for the renderer's sake; a line's fill
    // is always none, so neither is read back.
    fill: line ? 'none' : (attr(element, 'fill') ?? 'none'),
    opacity: optionalNum(element, 'opacity'),
    // Verbatim: a hand-authored pattern we cannot name is still a pattern, and
    // dropping it would rewrite somebody's file on the next save.
    dash: attr(element, 'stroke-dasharray'),
    // `rx` is a rect's corner radius; on an ellipse it is geometry and has
    // already been read as such.
    rx: kind === 'rect' ? optionalNum(element, 'rx') : null,
    markerStart: attr(element, 'marker-start') !== null,
    // Connector ends and the route belong to the line family only; a `wb:from`
    // on a box means nothing and is not carried.
    from: line ? connectorEnd(attr(element, 'wb:from')) : null,
    to: line ? connectorEnd(attr(element, 'wb:to')) : null,
    route:
      line && (declaredRoute === 'elbow' || attr(element, 'wb:route') === 'elbow')
        ? 'elbow'
        : 'straight',
    // The stroke slot only — a `wb-fN` token beside it names the FILL's slot,
    // which is always derivable from the literal fill and never stored.
    ...storedSlot(element, stroke, /^wb-c([0-7])$/),
  };
}

/**
 * `"<id>:<port>"` → a connector end, or null for anything else. Split at the
 * LAST colon (ids are alphanumeric, but a hand-typed one need not be); an
 * unknown port makes the whole reference invalid rather than guessing one.
 */
function connectorEnd(raw: string | null): ConnectorEnd | null {
  if (raw === null) {
    return null;
  }
  const at = raw.lastIndexOf(':');
  if (at <= 0) {
    return null;
  }
  const id = raw.slice(0, at);
  const port = raw.slice(at + 1);
  return isConnectorPort(port) ? { id, port } : null;
}

/**
 * A box shape's `x/y/width/height`, read back out of the element itself.
 *
 * A polygon's vertices touch its box's edges by construction, so the box IS
 * their bounding rect — no editor-only attribute needed, and a polygon someone
 * nudged in a text editor still comes back with the box it now occupies. The
 * cylinder's arcs bulge past its numbers, so it carries `wb:box` instead.
 * Either way, geometry that cannot be recovered returns null and the element
 * stays a RawElement rather than becoming a shape at the origin.
 */
function boxGeometry(element: XmlElement, kind: BoxShapeKind): Record<string, number> | null {
  if (kind === 'cylinder') {
    const parts = (attr(element, 'wb:box') ?? '')
      .trim()
      .split(/[\s,]+/)
      .map((n) => Number.parseFloat(n));
    if (parts.length !== 4 || !parts.every((n) => Number.isFinite(n))) {
      return null;
    }
    return { x: parts[0]!, y: parts[1]!, width: parts[2]!, height: parts[3]! };
  }
  const numbers = (attr(element, 'points') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map((n) => Number.parseFloat(n))
    .filter((n) => Number.isFinite(n));
  if (numbers.length < 6) {
    return null; // fewer than three vertices is not a polygon
  }
  const points: Point[] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    points.push({ x: numbers[i]!, y: numbers[i + 1]! });
  }
  const box = boundsOfPoints(points);
  return box === null ? null : { x: box.x, y: box.y, width: box.width, height: box.height };
}

function optionalNum(element: XmlElement, name: string): number | null {
  const raw = attr(element, name);
  if (raw === null) {
    return null;
  }
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}
