/**
 * The whiteboard scene model — the in-memory shape of a `.svg` whiteboard.
 *
 * The FILE is the source of truth (a single self-contained SVG that any browser
 * renders); `SceneDoc` is a lossless projection of it that the editor can reason
 * about. `parse.ts` builds one, `serialize.ts` writes one back, and the pair is
 * golden-tested — those tests define the format.
 *
 * Two properties everything else leans on:
 *
 * - **Immutable, structurally shared.** Every edit is a pure
 *   `(doc, …) → doc`, so undo is a snapshot stack (Phase 2) rather than an
 *   inverse-operation zoo.
 * - **Nothing is dropped.** Content we don't model survives as a
 *   {@link RawElement} (inside a layer) or in {@link SceneDoc.prelude}
 *   (top-level `<defs>`/`<style>`/comments), both re-emitted from the original
 *   source text.
 */

/** Namespace for every editor-only attribute. Foreign renderers ignore it. */
export const WB_NAMESPACE = 'urn:md-specpad:whiteboard';
export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
export const SCENE_SCHEMA = 1;

/**
 * The default board, in scene units. Deliberately modest: a board is fitted to
 * the pane on open, so the board's size in units IS the zoom — a bigger default
 * makes every unit smaller on screen, and 24-unit type reads as fine print.
 * These numbers are chosen so one scene unit is roughly one board pixel in a
 * typical window.
 */
export const DEFAULT_BOARD_WIDTH = 1200;
export const DEFAULT_BOARD_HEIGHT = 750;
export const DEFAULT_BACKGROUND = '#ffffff';

/** A `name="value"` pair we don't own, re-emitted after the ones we do. */
export interface SceneAttr {
  readonly name: string;
  readonly value: string;
}

/**
 * How a themable document RENDERS its dual colour representation:
 * `'themed'` (the default) puts the `wb-board` class on the root so the
 * palette `<style>` block's `var()` rules override each element's literal
 * colour; `'fixed'` adds `wb-fixed`, whose `:not(.wb-fixed)` guard turns
 * those rules off so the literal presentation attributes render everywhere.
 * Both representations stay in the file either way — flipping the mode is a
 * one-token change, never a recolour. Stored as `colorMode` in the `wb:doc`
 * metadata; only meaningful while `themed !== false`.
 */
export type BoardColorMode = 'themed' | 'fixed';

/* ------------------------------- elements -------------------------------- */

/**
 * Freehand ink. The pen tool and the scan tracer both emit exactly this.
 * `'scanfill'` is the tracer's fallback for genuinely blobby ink — a CLOSED
 * outline painted with `fill` (evenodd) rather than stroked; its colour still
 * lives in `stroke` (the element's colour identity), serialization translates.
 */
export interface StrokeElement {
  readonly kind: 'stroke';
  /**
   * `wb:id`. Present inside scan layers (OCR metadata points at ink by id),
   * and on any element something else refers to — a labelled shape, a shape a
   * connector is attached to. Drawn ink that nothing refers to stays id-free:
   * every byte counts in a dense file.
   */
  readonly id: string | null;
  /**
   * `wb:group` — a FLAT group tag (see `groups.ts`). Members of a group share
   * the tag and nothing else: no `<g>` wrapper, no nesting. Null (the normal
   * case) emits no attribute.
   */
  readonly group: string | null;
  readonly tool: 'pen' | 'highlighter' | 'scanfill';
  /** Path data, already in scene coordinates. */
  readonly d: string;
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly opacity: number | null;
  /**
   * `wb:widths` — per-vertex half-widths from a scan, kept for a future
   * variable-width brush. v1 renders constant width and never reads this.
   */
  readonly widths: string | null;
  /**
   * STORED palette slot (`class="wb-cN"` / `wb-fN` in the file), for elements
   * whose literal colour is NOT a palette hex — a true-colour scan stroke
   * carries its measured hex in `stroke` and its theme identity here, which is
   * what lets one file hold both representations. Absent (the normal case) the
   * slot is DERIVED from the colour at serialize time, exactly as before.
   */
  readonly slot?: number;
}

/**
 * The diagram shapes that are nothing but a BOX plus a recipe for the outline
 * inside it. They all share `x`/`y`/`width`/`height` geometry deliberately: one
 * branch in `transformElement`, one in `elementBounds` and one in the resize
 * path covers every one of them, and adding a seventh costs a vertex list. Four
 * of them serialize as `<polygon>`, the cylinder as a `<path>` (see
 * `serialize.ts` for why the cylinder additionally carries `wb:box`).
 */
export type BoxShapeKind = 'diamond' | 'triangle' | 'parallelogram' | 'hexagon' | 'cylinder';

export const BOX_SHAPES: readonly BoxShapeKind[] = [
  'diamond',
  'triangle',
  'parallelogram',
  'hexagon',
  'cylinder',
];

export function isBoxShape(shape: string): shape is BoxShapeKind {
  return (BOX_SHAPES as readonly string[]).includes(shape);
}

export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow' | BoxShapeKind;

/**
 * Where on a host a connector lands. `n`/`e`/`s`/`w` are the midpoints of the
 * host's outline on its four axes; `c` means "aim at the centre" — the end
 * slides around the outline to face wherever the other end is, which is what
 * a line between two boxes usually wants.
 */
export type ConnectorPort = 'n' | 'e' | 's' | 'w' | 'c';

export const CONNECTOR_PORTS: readonly ConnectorPort[] = ['n', 'e', 's', 'w', 'c'];

export function isConnectorPort(value: string): value is ConnectorPort {
  return (CONNECTOR_PORTS as readonly string[]).includes(value);
}

/** One attached end of a line/arrow: the host's `wb:id` and the port on it. */
export interface ConnectorEnd {
  readonly id: string;
  readonly port: ConnectorPort;
}

/**
 * How a line/arrow travels between its ends: one straight segment, or an
 * axis-aligned ELBOW routed at serialize time (`geometry.ts` → `routeElbow`).
 * Straight is the default and emits nothing.
 */
export type ConnectorRoute = 'straight' | 'elbow';

/**
 * A primitive shape. Geometry is BAKED into the element's own coordinates —
 * there are no stacked transforms anywhere in the format, which is what keeps
 * hit-testing, resizing and foreign-renderer fidelity all trivial.
 *
 * `geom` keys by shape: rect and every {@link BoxShapeKind} →
 * x/y/width/height, ellipse → cx/cy/rx/ry, line and arrow → x1/y1/x2/y2.
 */
export interface ShapeElement {
  readonly kind: 'shape';
  readonly id: string | null;
  /** `wb:group` — see {@link StrokeElement.group}. */
  readonly group: string | null;
  readonly shape: ShapeKind;
  readonly geom: Readonly<Record<string, number>>;
  readonly stroke: string;
  readonly strokeWidth: number;
  /** `'none'` or a color. */
  readonly fill: string;
  readonly opacity: number | null;
  /**
   * `stroke-dasharray`, or null for a solid outline — and null emits NO
   * attribute, which is what keeps every shape written before this field
   * round-tripping byte-for-byte. The string is stored verbatim (a
   * hand-authored pattern survives); `DASH_STYLES` in `tool-settings.ts` is
   * only what the ribbon offers, computed against the stroke width at the
   * moment the shape is made.
   */
  readonly dash: string | null;
  /**
   * Corner radius, `rect` only (the `rx` attribute). Null = square corners and
   * no attribute. The "Rounded rect" TOOL is a rect with a default `rx`, not a
   * shape kind of its own, so rounded and square boxes share every code path
   * that matters — hit-testing, bounds, resize, connectors later on.
   */
  readonly rx: number | null;
  /**
   * A head at the START of a `line`/`arrow` (`marker-start`). The head at the
   * END is the `arrow` KIND itself, which is how every board written before
   * this still reads correctly — so the ribbon's none/end/both is
   * (line, false) / (arrow, false) / (arrow, true).
   */
  readonly markerStart: boolean;
  /**
   * `wb:from="<id>:<port>"` / `wb:to` — a `line`/`arrow` end ATTACHED to the
   * element carrying that `wb:id`. Null (every other shape, and every line
   * drawn free) emits nothing. The coordinates in `geom` are still the truth
   * a renderer draws; `connectors.ts` recomputes them from the host's outline
   * after every commit, so the file always holds the picture as well as the
   * link. A host that no longer exists leaves the end where it was.
   */
  readonly from: ConnectorEnd | null;
  readonly to: ConnectorEnd | null;
  /** `wb:route` — see {@link ConnectorRoute}. Only meaningful on a line/arrow. */
  readonly route: ConnectorRoute;
  /** Stored palette slot — see {@link StrokeElement.slot}. */
  readonly slot?: number;
}

/** A line or an arrow — the two kinds that can be connectors. */
export type LineShapeElement = ShapeElement & { readonly shape: 'line' | 'arrow' };

export function isLineShape(element: SceneElement): element is LineShapeElement {
  return element.kind === 'shape' && (element.shape === 'line' || element.shape === 'arrow');
}

export interface TextElement {
  readonly kind: 'text';
  readonly id: string | null;
  /** `wb:group` — see {@link StrokeElement.group}. */
  readonly group: string | null;
  /**
   * `wb:label-of` — the `wb:id` of the element this text is the LABEL of, or
   * null for free-standing text. A label is centred on its host (`labels.ts`
   * lays it out from the host's geometry and re-centres it after every
   * commit), serialized with `text-anchor="middle"`, and welded to the host
   * for selection: moving, deleting or copying the host takes the label along.
   * A label whose host no longer exists is just text.
   */
  readonly labelOf: string | null;
  /** The anchor point: `<text x y>`. For a label, `x` is the host's centre. */
  readonly x: number;
  readonly y: number;
  readonly fontSize: number;
  /**
   * A CSS font stack, or null to inherit the renderer's default. A STACK
   * rather than a single face on purpose: the file has to render in a plain
   * browser on someone else's machine, where the exact font may not exist.
   */
  readonly fontFamily: string | null;
  readonly fill: string;
  /**
   * One entry per rendered line, serialized as `<tspan>`s. Lines come from the
   * newlines the user typed and from nothing else: SVG 1.1 `<text>` has no
   * wrapping, no box and no reflow, so a line is a decision made once, at
   * authoring time, and the file renders identically forever.
   */
  readonly lines: readonly string[];
  /** Stored palette slot — see {@link StrokeElement.slot}. */
  readonly slot?: number;
}

/** A raster image: a scan's "insert as photo" fallback, or a pasted picture. */
export interface ImageElement {
  readonly kind: 'image';
  readonly id: string | null;
  /** `wb:group` — see {@link StrokeElement.group}. */
  readonly group: string | null;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Always a `data:` URL — the file must stay self-contained. */
  readonly href: string;
  readonly opacity: number | null;
}

/**
 * Content we recognize but do not model: foreign SVG, a scan layer's hidden OCR
 * `<text>` group, an element from a future schema. Held as its original source
 * and re-emitted unchanged; invisible to every tool.
 */
export interface RawElement {
  readonly kind: 'raw';
  readonly xml: string;
}

export type SceneElement = StrokeElement | ShapeElement | TextElement | ImageElement | RawElement;

/* -------------------------------- layers --------------------------------- */

/**
 * 'draw'    — an ordinary layer the tools own.
 * 'scan'    — a photo→SVG import; ordinary editable strokes plus OCR metadata.
 * 'foreign' — content from a non-whiteboard SVG. Rendered live, listed as
 *             "Imported", locked, re-emitted byte-for-byte.
 */
export type LayerKind = 'draw' | 'scan' | 'foreign';

export interface Layer {
  /** Short opaque id; the `wb:layer` attribute and the panel's identity. */
  readonly id: string;
  readonly name: string;
  /** Serialized as `display="none"` — standard SVG, so foreign renderers obey. */
  readonly visible: boolean;
  readonly locked: boolean;
  readonly kind: LayerKind;
  readonly elements: readonly SceneElement[];
  /** Attributes on the `<g>` we don't own, preserved in source order. */
  readonly extras: readonly SceneAttr[];
}

/* --------------------------------- doc ----------------------------------- */

export interface SceneDoc {
  readonly schema: typeof SCENE_SCHEMA;
  readonly width: number;
  readonly height: number;
  /**
   * `[minX, minY, width, height]`. For an INFINITE board (`background: null`)
   * the serializer refits this to the content on every save; a page board
   * keeps it fixed (the page IS the board).
   */
  readonly viewBox: readonly [number, number, number, number];
  /** The page colour, or null for an infinite board with no page rect. */
  readonly background: string | null;
  /** Root `<svg>` attributes we don't own (xmlns:inkscape, class, …). */
  readonly rootExtras: readonly SceneAttr[];
  /** Verbatim top-level non-layer nodes (`<defs>`, `<style>`, comments). */
  readonly prelude: readonly string[];
  readonly layers: readonly Layer[];
  /**
   * Everything in the `wb:doc` metadata JSON that isn't a first-class field
   * above (`ocr`, `view`, future keys). Round-tripped untouched.
   */
  readonly meta: Readonly<Record<string, unknown>>;
}

/* ------------------------------- constructors ----------------------------- */

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * A short layer id. Pure by injection: callers pass the randomness so tests
 * (and the deterministic serializer goldens) stay reproducible.
 */
export function makeLayerId(random: () => number = Math.random): string {
  let out = '';
  for (let n = 0; n < 4; n++) {
    out += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)] ?? 'a';
  }
  return out;
}

/** A layer id not already used in `doc`. */
export function freshLayerId(doc: SceneDoc, random: () => number = Math.random): string {
  const used = new Set(doc.layers.map((l) => l.id));
  for (let attempt = 0; attempt < 64; attempt++) {
    const id = makeLayerId(random);
    if (!used.has(id)) {
      return id;
    }
  }
  // Astronomically unlikely; still never return a duplicate.
  return `l${used.size + 1}`;
}

/**
 * An element id (or group tag) used nowhere in `doc` — neither as a `wb:id`
 * nor as a `wb:group`. One pool for both on purpose: an id that is unique
 * across every reference the file can hold is one fewer thing a hand edit can
 * confuse. Same injectable randomness as {@link makeLayerId}, same reason.
 */
export function freshElementId(doc: SceneDoc, random: () => number = Math.random): string {
  return freshIdFrom(usedIds(doc), random);
}

/**
 * An id not in `used` — and ADDED to it, so a caller allocating several in a
 * row (the clipboard remapping a whole pasted set) cannot hand out the same
 * one twice.
 */
export function freshIdFrom(used: Set<string>, random: () => number = Math.random): string {
  for (let attempt = 0; attempt < 64; attempt++) {
    const id = makeLayerId(random);
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
  const fallback = `e${used.size + 1}`;
  used.add(fallback);
  return fallback;
}

/**
 * Every `wb:id` and `wb:group` value in the document — and every id a
 * connector end REFERS to, so a dangling `wb:from` (its host deleted in Raw
 * mode) can never be handed to a new element the connector would then leap
 * onto.
 */
export function usedIds(doc: SceneDoc): Set<string> {
  const used = new Set<string>();
  for (const layer of doc.layers) {
    for (const element of layer.elements) {
      if (element.kind === 'raw') {
        continue;
      }
      if (element.id !== null) {
        used.add(element.id);
      }
      if (element.group !== null) {
        used.add(element.group);
      }
      if (element.kind === 'shape') {
        if (element.from !== null) {
          used.add(element.from.id);
        }
        if (element.to !== null) {
          used.add(element.to.id);
        }
      }
    }
  }
  return used;
}

/**
 * Rewrite every id and every id REFERENCE in `elements` through `mapping`.
 *
 * An element's own `id` maps when the mapping names it and is otherwise kept.
 * A reference (`labelOf`, `group`, a connector's `from`/`to`) maps when the
 * mapping names its target and is otherwise DROPPED — a pasted label must not
 * keep pointing at the shape it was copied from, and a pasted connector must
 * not stay attached to a box it is no longer next to (it arrives DETACHED,
 * keeping its coordinates). The clipboard builds the mapping from every id and
 * tag in the fragment, so within a pasted set every link survives and every
 * link out of it is cut.
 */
export function remapIds(
  elements: readonly SceneElement[],
  mapping: ReadonlyMap<string, string>,
): SceneElement[] {
  const ref = (value: string | null): string | null =>
    value === null ? null : (mapping.get(value) ?? null);
  const end = (value: ConnectorEnd | null): ConnectorEnd | null => {
    const id = value === null ? null : ref(value.id);
    return id === null ? null : { id, port: value!.port };
  };
  return elements.map((element) => {
    if (element.kind === 'raw') {
      return element;
    }
    const id = element.id === null ? null : (mapping.get(element.id) ?? element.id);
    const group = ref(element.group);
    if (element.kind === 'text') {
      return { ...element, id, group, labelOf: ref(element.labelOf) };
    }
    if (element.kind === 'shape') {
      return { ...element, id, group, from: end(element.from), to: end(element.to) };
    }
    return { ...element, id, group };
  });
}

export function createLayer(init: Partial<Layer> & { id: string }): Layer {
  return {
    id: init.id,
    name: init.name ?? 'Layer 1',
    visible: init.visible ?? true,
    locked: init.locked ?? false,
    kind: init.kind ?? 'draw',
    elements: init.elements ?? [],
    extras: init.extras ?? [],
  };
}

/**
 * A blank board — the skeleton "New whiteboard" writes to disk. INFINITE by
 * default (`background: null`, no page rect): the serializer fits the viewBox
 * to the content on every save, and the surface colour comes from the palette
 * block's `svg.wb-board{background:…}` rule instead of a rect. Passing a
 * background colour creates a fixed page (`setBackground` toggles it later).
 */
export function createScene(init: Partial<SceneDoc> = {}): SceneDoc {
  const width = init.width ?? DEFAULT_BOARD_WIDTH;
  const height = init.height ?? DEFAULT_BOARD_HEIGHT;
  return {
    schema: SCENE_SCHEMA,
    width,
    height,
    viewBox: init.viewBox ?? [0, 0, width, height],
    background: init.background !== undefined ? init.background : null,
    rootExtras: init.rootExtras ?? [],
    prelude: init.prelude ?? [],
    layers: init.layers ?? [createLayer({ id: 'a1B2', name: 'Layer 1' })],
    meta: init.meta ?? {},
  };
}

/* --------------------------------- queries -------------------------------- */

/** Elements the tools may touch: modeled elements on unlocked, visible layers. */
export function editableLayers(doc: SceneDoc): Layer[] {
  return doc.layers.filter((l) => l.visible && !l.locked && l.kind !== 'foreign');
}

export function layerById(doc: SceneDoc, id: string): Layer | undefined {
  return doc.layers.find((l) => l.id === id);
}

/** Total modeled (non-raw) element count — the status readout and size guard. */
export function elementCount(doc: SceneDoc): number {
  let count = 0;
  for (const layer of doc.layers) {
    for (const element of layer.elements) {
      if (element.kind !== 'raw') {
        count++;
      }
    }
  }
  return count;
}
