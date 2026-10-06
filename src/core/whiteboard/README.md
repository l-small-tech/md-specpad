# src/core/whiteboard/ — the `.svg` whiteboard format

Pure, DOM-free, Vitest-covered. The DOM half of the feature is
`src/editors/whiteboard.ts` (a lazy-loaded adapter); everything that decides
what a whiteboard *is* lives here.

| File | Role |
| --- | --- |
| `xml.ts` | a small XML reader with SOURCE SPANS (not DOMParser — see below) |
| `scene.ts` | `SceneDoc` / `Layer` / `SceneElement` — the immutable scene model |
| `parse.ts` | SVG source → `SceneDoc`, and (with spans) where each element was |
| `locate.ts` | `ElementRef` ⇄ source offsets — Split mode's raw ⇄ draw link |
| `serialize.ts` | `SceneDoc` → deterministic SVG source |
| `geometry.ts` | points, rects, path flattening — "what is under this point" |
| `smoothing.ts` | 1€ filter → RDP → Catmull-Rom Béziers; the pen pipeline |
| `tool-settings.ts` | tool ids, palette, nib sizes. **A dependency-free leaf** |
| `tools.ts` | gesture → `SceneElement` (the tools themselves) |
| `layers.ts` | pure `(doc, …) → doc` layer and element operations |
| `hit-test.ts` | the eraser's aim, and selection's base |
| `select.ts` | the selected set, resize handles, and BAKING a transform in |
| `style.ts` | restyling a selection, and reading back what it currently IS |
| `groups.ts` | flat groups by tag, and the selection EXPANSION that welds groups and labels together |
| `labels.ts` | text centred on a host element: layout, re-centring after every commit, attach |
| `arrange.ts` | z-order within a layer, align, distribute |
| `clipboard.ts` | copy/paste as a document fragment, with ids remapped on the way in |
| `grid.ts` | the per-document grid, as typed accessors over the `wb:doc` metadata |
| `snap.ts` | grid snapping, smart guides, ports, and which one wins |
| `connectors.ts` | live connectors: ends that land on a host's OUTLINE and follow it; ports, attach, detach |
| `input.ts` | pointer routing and palm rejection. **A dependency-free leaf** |
| `history.ts` | the snapshot undo stack |
| `bounds.ts` | the content-fitted viewBox for infinite boards |
| `theme-inject.ts` | bake resolved theme vars into a board's root tag (for `<img>` contexts) |
| `color-mode.ts` | read a saved board's `colorMode` off its root tag; flip it by re-serializing (the preview/Edit right-click toggle) |
| `scan/` | the photo→SVG pipeline (see below) |

`tool-settings.ts` is split out of `tools.ts` deliberately: the ribbon draws
the palette and lives in the eager entry bundle, so importing it from `tools.ts`
would pull smoothing, serialization and the XML reader into startup and quietly
undo invariant I8. Keep that module importing nothing but a type. `input.ts` is
under the same constraint for the same reason — the ribbon's finger toggle
needs `fingerDrawsEnabled` and nothing else.

## Selection bakes; it never transforms

`select.ts` rewrites the elements themselves: a moved stroke gets a new `d`, a
resized rect gets new `x`/`width`. There is no `transform` attribute anywhere in
the format and there is not going to be one — hit-testing, the "renders
identically in a browser" promise and the scan pipeline's coordinate mapping all
stay simple in exchange for one careful module.

Two consequences worth knowing before editing it:

- A single `stroke-width` (or `font-size`) cannot follow two different axis
  scales, so it takes the **geometric mean** √(sx·sy). A non-uniformly stretched
  selection therefore lands within a stroke width of its box, not exactly on it.
  The tests state that as the contract rather than pretending otherwise.
- A resize **clamps** at a minimum size instead of passing through zero. Letting
  a box flip inside-out means negative scales, mirrored text, and a drag the
  user cannot undo by dragging back.

An `ElementRef` (layer id + index) survives a move or a resize, because those
REPLACE elements in place — and does not survive an add, a delete, or an undo,
which is why the adapter drops the selection on all three.

## Fingers, pens and palms

`input.ts` is a pure classifier: a pen always draws (and its eraser end always
erases), a mouse draws with the primary button, and a finger draws only when the
user asked it to — with a second finger always converting the gesture into a
pan/pinch. While a pen is down, and for 300 ms after it lifts, every touch is a
palm and is dropped; oversized contacts are dropped always; and a stroke a
finger committed in the 150 ms before a pen landed is undone, because that is
what a palm touching down just ahead of the nib looks like.

It is pure because those combinations are exactly what testing by hand on one
device fails to cover.

One thing the adapter must keep doing, learned the hard way: **cancelling
`pointerdown` costs you focus**, because focus-on-click rides on the
compatibility `mousedown` that `preventDefault()` suppresses. The stage focuses
itself explicitly on every accepted press; without that, every keyboard path
(Delete, Ctrl+Z, nudge) dies silently after the first click.

## Shapes: one box, many outlines (diagram phase A)

The five diagram shapes — diamond, triangle, parallelogram, hexagon, cylinder —
all keep `x/y/width/height` geometry, the same keys `rect` uses. That is the
whole design: `transformElement`, `elementBounds` and the resize path each got
ONE new branch rather than five, and the sixth shape will cost a vertex list.
`shapeGeomRect` in `geometry.ts` is the single decoder of the geom-key
convention, so "what does it cover" and "what can I click" cannot drift apart.

They serialize as `<polygon wb:shape="diamond" points="…">`, and the cylinder
as `<path wb:shape="cylinder" wb:box="x y w h" d="…">`. The asymmetry is
deliberate: a polygon's vertices touch the box's edges **by construction**, so
parse recovers the geometry as the bounding box of the points and no
editor-only attribute is needed — a polygon someone nudged in a text editor
still comes back with the box it now occupies. The cylinder's arcs bulge past
the numbers in its `d`, and recovering a box from two elliptical arcs means
trusting a template a hand edit may already have broken, so it says its box out
loud instead. A `<polygon>` with no `wb:shape` — or one naming a shape we don't
know — stays a `RawElement`, which is the same promise the format has always
made about content it did not write.

Hit-testing follows the OUTLINE (`boxShapeOutline`), not the box: the corners
of a diamond's box are empty space, and a click there should reach whatever is
drawn underneath.

**A rounded rectangle is a `rect` with an `rx`, not a shape kind.** The tool is
`'roundrect'` (a `ShapeTool`, which the FORMAT never sees); the element is a
rect. That keeps hit-testing, transforms and connectors shared between square
and rounded boxes. `rx` scales by the
geometric mean √(sx·sy) under a non-uniform resize, the same compromise
`stroke-width` makes and for the same reason: one number cannot follow two
axes.

### Dashes, heads and a themable fill

- `dash` is the `stroke-dasharray` string, verbatim, or null for solid — and
  **null emits no attribute**, which is what keeps every shape written before
  this round-tripping byte-for-byte. The presets in `tool-settings.ts` are
  computed against the stroke width at construction time: a fixed pattern would
  mean something different on every nib, and a 1-unit dash on an 8-unit nib is
  a solid line. A pattern we cannot name (`dashStyleOf` → null) is somebody
  else's and is never rewritten.
- The head at the END of a line is still the `arrow` KIND — that is where every
  board written before this keeps it, and changing that would have rewritten
  them all. `markerStart` is the new field, so the ribbon's none/end/both is
  `(line, false)` / `(arrow, false)` / `(arrow, true)`.
- The start head is a **second marker def with mirrored geometry and plain
  `orient="auto"`**, not `wb-arrow` under `orient="auto-start-reverse"`. The
  attribute is SVG 2: Chromium, Firefox and WebView2 honour it; librsvg, resvg,
  older Inkscape and several SVG→PDF converters degrade it to `auto` and draw
  the head pointing backwards into the line. The file rendering identically
  anywhere outranks the tidier def, and the duplicate costs eighty bytes once.
- A shape's fill themes through its own class: `wb-fN` **alongside** the
  stroke's `wb-cN` (`class="wb-c1 wb-f3"`). The `.wb-fN` rule already existed
  for scan blobs and needed no new scoping. A fill equal to the board's
  background gets `wb-bg` instead — the very rule the page rect themes through
  — which is what makes a **Paper**-filled box hide the lines behind it on a
  dark board as well as a light one, while the literal attribute stays white
  for a CSS-less renderer. `PAPER_FILL` is duplicated in `tool-settings.ts`
  rather than imported, because that module is a dependency-free leaf; a test
  pins the two equal.

### Restyling is a patch, applied per kind

`restyleElements(doc, refs, patch)` in `style.ts` is the whole styling model:
the ribbon IS the properties panel, so a swatch/nib/fill/dash/head click
restyles the selection and sets the tool default in one go, one undo step. The
patch is partial — an absent field is left alone — and every kind ignores what
it cannot express rather than growing a field it never renders: a stroke has no
fill, text maps the colour control onto its `fill`, an image has no style at
all. Two rules are less obvious and both are tested: recolouring **drops a
stored palette slot** (it was a scan's "this hex means that theme colour" note
and is now a lie), and a nib change **redraws the dash pattern**, which is
expressed against the width.

`selectionStyle(doc, refs)` is the inverse, and the reason the ribbon can show
what is selected: every field is the value the whole selection agrees on, or
null when it is mixed. Null lights nothing, which is the honest answer to "what
colour is this?" for two differently-coloured shapes.

## Layout ops, groups and labels (diagram phase B)

Everything in this round is a `(doc, refs, …) → doc` over the existing model
plus two nullable fields — `group` on every element kind (`wb:group`) and
`labelOf` on text (`wb:label-of`). Both emit nothing when null, which is the
same promise phase A made: a file written before them re-serializes
byte-for-byte. Attribute order on every element is now `wb:id`, `wb:group`,
then the kind's own attributes (`wb:label-of` follows `wb:group` on text).

### Groups are flat, by tag — and will stay that way

A group is a shared `wb:group="id"` on its members. No `<g>` wrapper, no
nesting. A nested model would ripple through everything that names an
element: an `ElementRef` is `layer + index`, hit-testing walks a flat list,
transforms bake into flat elements, the serializer writes one element per
line, the scan pipeline inserts flat strokes — all of it would grow a
path-through-groups notion for a feature diagrams rarely need beyond one
level, and one level is exactly what a tag gives. A tag also survives
everything a wrapper would break: z-order ops, layer moves, copy/paste and a
Raw-mode edit all leave members as ordinary elements, and a member deleted by
hand simply leaves the group. Grouping a selection that already holds a group
MERGES it (every member is re-tagged) — that is what "no nesting" means in
practice.

**Selection expansion is the one mechanism behind groups and labels.** Every
selection the user makes — click, shift-click, marquee, the context menu —
is closed over "same group" and "label ⇄ host" (`expandSelection`) before it
is used. Moving a shape moves its label because the label was selected too,
not because move knows about labels; `Delete` on a host takes its labels
because they were in the set (and `withLabels` says so explicitly for the
eraser, which never goes through a selection). Align and distribute act on
UNITS (`selectionUnits`, the connected components under the same links), so a
group lines up as one thing. Shift-click removes a whole unit, because
removing one member would only see the expansion put it straight back.

### Labels

A label is a `TextElement` whose `labelOf` names its host's `wb:id`; the
host gets an id the first time it is labelled (`freshElementId`, the same
injected randomness `makeLayerId` uses, from one pool shared with group tags).
It is serialized with `text-anchor="middle"` — plain SVG 1.1, derived from
`labelOf` rather than stored — and its `x` is the host's centre, so each line
centres itself in any renderer without the editor measuring glyphs it has no
metrics for. The block is stacked at 1.2 line height around the host's
centre (`labelBaseline`), shifted by a cap-centre constant so glyphs, not
line boxes, look centred; a line's centre is its midpoint because a line's
box is the box of its endpoints. Both `elementBounds` implementations know a
label straddles its `x`.

Two rules keep labels honest without a layout engine:

- **A label is welded to its host in both directions.** A label dragged on
  its own would be re-centred by the next commit, so it is never selectable
  on its own. The cost is that recolouring a host+label selection recolours
  both — for a diagram that is the usual intent.
- **A resize re-centres the label; it never scales it.** The adapter leaves
  labels out of the scale and runs `relayoutLabels` afterwards — the same
  pure pass every recorded commit runs (the adapter's `settle`), so
  whatever moved a host (align, nudge, a raw edit followed by any Draw-mode
  edit) leaves its labels centred. `relayoutLabels` is a fixed point on a
  document with nothing to do, so running it always costs nothing.

A label whose host is gone (deleted in Raw mode, a hand-authored file) is just
text with an anchor: every function treats a dangling `labelOf` as no host.

### Z-order, align, distribute

Z-order is the element order inside its layer and nothing else — layers are
the coarse stack, elements the fine one — so `reorderElements` works per
layer, never moves anything between layers, and returns the new refs. Forward
and backward step the selection one element past its nearest unselected
neighbour as a BLOCK, which is what makes repeated presses predictable. Align
and distribute are translations only; distribute equalises gaps and falls
back to even centres when the units overlap. All three live in the context
menu, not the ribbon — the strip has to fit a tablet and already does not have
a slot to spare.

### The clipboard is the file format

A copied selection serializes as a complete whiteboard `<svg>` holding one
layer, and a paste is anything `parseWhiteboard` can read modeled elements out
of. That means the fragment renders as a picture in any tool that accepts SVG
text, a whole board's source pasted onto another board lands as elements, and
there is no second grammar to keep in step with the serializer. The app keeps
the parsed elements in memory too (the UI store), so pasting works where the
web view cannot read the system clipboard back; each paste of the same
clipboard lands `PASTE_OFFSET` further along.

Ids are REMAPPED on paste (`remapIds`): every `wb:id` and `wb:group` in the
fragment gets a fresh value, so a label pasted with its host still labels the
copy, one pasted without it becomes plain text rather than a second label on
the original, and a group of one is dropped. A connector's `from`/`to` get the
same treatment through the same function — a reference the mapping does not
name is cut, never kept, so an arrow pasted without its box arrives detached
where it was rather than attached to the original.

## The grid, and snapping (diagram phase C)

### The grid is in the document and never in the picture

`grid` in the `wb:doc` metadata — `{ show, size, snap }`, default hidden / 20 /
snapping — because a grid is a property of the DIAGRAM, not of the app: a
flowchart drawn on 20-unit squares should come back on 20-unit squares next
week, on another machine, for whoever opens it. It is written the same way
every field added since phase A is: only what differs from the default, in a
fixed key order, so a default grid emits **no key at all** and a board written
before this round re-serializes byte-for-byte. A corrupt value degrades field
by field (`"grid": "on"` is simply not a grid), exactly like the rest of the
blob.

What is NOT in the file is the grid itself. The dots are chrome the adapter
injects into the adopted DOM after adoption; nothing here knows their
geometry and the serializer never sees them, so a board with the grid showing
saves identically to the same board with it hidden. Rendering a grid into the
file would trade the one big idea — a picture that renders identically
anywhere — for a convenience the editor can provide for free.

**Grid changes are not undo steps, and undo carries the current grid**
(`carryGrid`). The history stack is whole documents and the grid rides in the
document, so a plain undo would restore the grid the snapshot was taken with
— turning the dots back on as a side effect of undoing a stroke. Showing a
grid is a view decision, so every restore wears the live settings instead.
Nothing else in the metadata gets this treatment, because nothing else in it
is a view preference.

### Guides beat the grid, and one axis knows nothing about the other

`snap.ts` is per-axis and nothing else, which is why it is short: an x snap and
a y snap are decided independently, so a box can land on a neighbour's left
edge while its top stays exactly where the hand put it. Per axis the order is
**smart guide within the threshold → grid → nothing**. A guide wins because
aligning to a thing you can SEE beats aligning to an abstraction — that is the
whole reason editors that already have a grid grew guides.

The threshold arrives in scene units, converted by the adapter from
`SNAP_THRESHOLD` screen pixels, so the pull feels identical at 30% and at 400%
while the grid, which belongs to the drawing, scales with it. Candidates are
the left/centre/right and top/middle/bottom of every other element's bounds,
and a returned `GuideLine` carries the span of both the match and the
moving geometry, so the adapter can draw a line that reaches them both rather
than crossing the board.

Two exclusions are decisions rather than omissions. **Freehand ink is never a
guide**: a scribble's bounding box is not an alignment anyone meant, and
flattening every path on the board per gesture would cost more than the
feature is worth. **Locked, hidden and foreign layers are out** as well — you
cannot move that content, so offering to line up with it is a promise about
something the editor does not own. Ink does not snap either, for the same
reason it is not a guide: a pen stroke pulled onto a lattice is not the stroke
anyone drew.

## Live connectors (diagram phase D)

A connector is a `line`/`arrow` with two nullable fields, `from` and `to`,
each naming a host's `wb:id` and a port on it (`wb:from="bx1:e"`), plus a
`route` (`wb:route="elbow"`; straight emits nothing). Both default to
nothing, so — the same promise every phase has made — a line drawn before this
round re-serializes byte-for-byte, and a line drawn free today is
indistinguishable from one drawn last year.

### The coordinates stay in the file

An attached end still has real `x1/y1` numbers in it, and they are what every
renderer draws. The attachment is a `wb:` note saying where those numbers came
from; `reconnect` recomputes them from the host's current outline after every
commit (the adapter's `settle`, before `relayoutLabels`, because a connector's
label sits on its routed path). A host that no longer exists — deleted in Raw
mode, or a reference in a hand-authored file — simply leaves the end where
the file says it is, and its id stays reserved (`usedIds`) so a fresh element
can never inherit a stale arrow. Nothing here is a second rendering path: a
board with connectors is still a picture that renders identically anywhere.

### Following is NOT selection expansion

Groups and labels weld through `expandSelection`: selecting one selects the
others. Connectors deliberately do not. An arrow is not part of the box it
points at — selecting a box must not drag its arrows into the selection, and
deleting a box must not delete them. So moving a host moves only the arrow
ends that touch it, and deleting a host **detaches** its connectors
(`detachFrom`, run by `removeAndDetach` for Delete and the eraser): the lines
keep their last coordinates, because they were drawn on purpose too. The
clipboard follows from `remapIds`: a host and its arrow copied together stay
attached (fresh ids, same link); an arrow copied alone arrives detached.

### Ends land on the outline, never the box

`endpointOn(host, port, toward)` intersects a ray from the host's centre with
the phase-A outline (`shapeOutline`), so an arrow into an ellipse or a diamond
ends on the drawn edge, not on the corner of the rectangle around it (the
ellipse is solved exactly rather than sampled — its ports are the one case
where a chord's sag would show). Ports `n`/`e`/`s`/`w` are where the axes
cross that outline; `c` aims at the centre and slides around the outline to
face the other end — the other end's host centre when it has one, the free
endpoint otherwise. `nearestPort` turns a press into a port: within 30° of an
axis (measured on the box normalised to a square, so a wide box's `e` port is
not a sliver) it is that side, anywhere else it is `c`. `connectorTarget` is
the whole targeting rule in one place: a port within reach wins on whichever
host, otherwise the topmost body under the point — an UNFILLED box counts,
because the box is what the user sees.

### The elbow is routed, never stored

An elbow connector serializes as `<path wb:shape="elbow" d="M… L… L…">` —
a `<path>` because it is the only SVG 1.1 element that draws a polyline AND
takes markers at its ends — with `fill="none"` (a path fills black by default)
and the waypoints derived at serialize time by `routeElbow` in `geometry.ts`:
leave each end along its port's axis (a free end or a `c` port takes the
direction the other end mostly is), one bend when the two axes differ, two
bends turning at the midpoint when they agree, no bend when the ends are
already in line. Deterministic and geometry-only, so the same ends and ports
always draw the same path and nothing about the route is state a hand edit
could desynchronise. Parse recovers `x1/y1/x2/y2` from the path's first and
last point and the kind from `marker-end`. It names itself with `wb:shape`
exactly as the box polygons do, so a foreign `<path>` stays raw; `wb:route`
is emitted as well because the route is a field of the element, and a
hand-edited `<line wb:route="elbow">` is honoured. Hit-testing, bounds and the
label midpoint all follow the routed polyline (`connectorPoints`), which is
why the router lives below `hit-test.ts` in the import order rather than in
`connectors.ts` (which re-exports it).

The router does not add a stub when the target lies behind a port — an `e`
port aimed at something on the left runs back across its own host. That would
cost two more bends per end and a stub length nobody agrees on; the ports a
press picks face the pointer, so it takes deliberately choosing the wrong
side to reach it.

### Ports are strong guides

`snap.ts` gained `ports` beside `guides`: a point within the threshold of a
port lands exactly on it, both axes at once, and the edge guides do not get a
say — a port is a target you aim at, not a coincidence you accept. Connector
ends have a wider radius still (`PORT_SNAP_RADIUS`) and skip general snapping
altogether when a host is under the pointer, because you are pointing at the
box, not at a grid line.

## Text is a point and some lines — that is all `<text>` is

`TextElement.fontFamily` is a CSS stack or null (null = inherit, and null emits
no attribute at all, which is what keeps files written before it round-tripping
byte-for-byte). `FONT_FAMILIES` in `tool-settings.ts` only offers stacks that
end in a generic family: the premise of the whole feature is that the `.svg`
renders on someone else's machine, where the named face may not exist.

**There is no text box, and there will not be one.** SVG 1.1 `<text>` is an
anchor point plus `<tspan>`s; it has no width, no wrapping and no reflow (SVG 2
proposed one and no shipping renderer implements it). So `lines` comes from the
newlines the user typed and from nowhere else, and the editor's textarea grows
sideways rather than wrapping — what you see typed is the run of glyphs the file
will hold.

A drag-out wrapping box was built and reverted. It *can* be faked — measure the
glyphs, bake the breaks into `<tspan>`s at commit — but the result is an editor
promising a reflow the format cannot keep: the box's width becomes editor-only
state, the "wrapped" lines are frozen the moment anything about the font
resolves differently elsewhere, and resizing or restyling the text silently
invalidates breaks the user never chose. Going with the grain is cheaper and
more honest. If long text needs a column, the answer is to type the newlines,
not to teach the file a layout model it doesn't have.

Nib sizes and type sizes share a board, so they are chosen against each other:
`STROKE_WIDTHS` tops out well under `DEFAULT_FONT_SIZE`, and the default board
is small enough (in units) that a unit is roughly a screen pixel — a bigger
default board is a silent zoom-out that makes type read as fine print.

## The one big idea

**A single self-contained `.svg` file is the source of truth.** Not a project
format that exports SVG — the file the user edits is the file a browser
renders and the file `![](board.svg)` inlines in the markdown preview. That is
what makes whiteboards useful inside a notepad.

Consequences, all load-bearing:

- Anything a foreign renderer must honor is **standard SVG**: layer visibility
  is `display`, colors and widths are presentation attributes, layers are
  top-level `<g>`s. Editor-only state uses the `wb:` namespace
  (`urn:md-specpad:whiteboard`) and a `<metadata><wb:doc>` JSON blob, both of
  which every other renderer ignores.
- **No stacked transforms.** Select/move/resize bake coordinates into the
  element. Hit-testing, foreign-renderer fidelity and the scan pipeline's
  coordinate mapping all get simple in exchange.
- `SceneDoc` is **immutable with structural sharing**, so undo is a snapshot
  stack rather than an inverse-operation zoo.

## Pointing at the same element from both panes (Split mode)

Split on an `.svg` tab shows the source and the board at once, and each has
to be able to say "this one" to the other. The board speaks `ElementRef`s
(layer id + index); the source editor speaks character offsets.
`parseWhiteboardWithSpans` is the bridge: the SAME walk that builds the scene
also records each element's `[start, end)` in the source, so span *n* of layer
*l* and scene element *n* of layer *l* are the same node by construction.
`locate.ts` is the thin query layer over it (`rangeForRef`, `rangesForRefs`,
`refAtOffset`), and `parseWhiteboard` is now a one-line wrapper.

Two decisions worth keeping:

- **A second walk was rejected.** A standalone "find the elements" pass would
  be a second opinion about which node became element *n* — which layers
  count, which `<style>` is ours, where the Imported layer splices in — and
  the first time the two disagreed the link would quietly point at the wrong
  shape. One walk, one truth.
- **A caret anywhere on an element's LINE finds it** (`refAtOffset`), not
  just one inside its tag. The serializer writes one element per line, so
  that is what a person means; containment still wins where a hand-authored
  file puts two shapes on one line.

## Why not DOMParser

Two reasons. Core is DOM-free (I9), so the format's golden tests must run in
the node env with no shims. And the "nothing is ever dropped" guarantee needs
**source spans**: content we don't model is re-emitted by slicing the original
text, which `XMLSerializer` cannot do — it reformats.

## Why erasing deletes elements

Whole-element erase, never `<mask>`. Masking looks nicer for about a minute and
then bloats the file with an ever-growing mask path, breaks the "renders
identically in a browser" promise, and makes selection meaningless. Deleting
the element the user touched is the honest operation — and because scanned ink
will be made of the same `<path wb:tool="pen">` elements, it works there too.

`RawElement`s are invisible to every tool by design: unmodeled content belongs
to whoever authored it, and that is what makes carrying it safe.

## The two round-trip guarantees (don't conflate them)

1. **Mount → look → close is byte-identical.** This is NOT enforced here. It
   comes from the adapter's write-back guard, which serializes only after a
   genuine user edit — the same contract Milkdown has (I2). Opening a
   hand-authored or Inkscape SVG must never rewrite it.
2. **Nothing is dropped, ever.** Enforced here, and tested in
   `__tests__/roundtrip.test.ts`:
   - top-level `<defs>`/`<style>`/`<title>`/comments → `SceneDoc.prelude`,
     verbatim;
   - unmodeled elements inside one of our layers → `RawElement`, verbatim
     (this is also how a scan layer's hidden OCR group survives);
   - renderable top-level content that isn't one of our layers → one locked
     **foreign** layer named "Imported", verbatim, keeping its z-order;
   - unknown attributes → `extras`; unknown metadata keys → `meta`.

   Serializing our own output is a **fixed point** — that is the invariant the
   tests assert, and the thing to re-check after touching either file.

## Serializer determinism

Fixed attribute order, coordinates rounded to 2 decimals (`num`), 2-space
indent, `\n` endings, one trailing newline, metadata keys in a fixed order.
Determinism is what makes goldens possible and keeps a saved whiteboard's git
diff readable. Don't introduce output that depends on iteration order or
`Math.random` — `makeLayerId` takes its randomness by injection for exactly
this reason.

## Themable ink (phase 2.5)

A saved board follows the viewer's colour scheme without ever depending on it:

- Every element keeps its **concrete light-theme hex** in the presentation
  attribute (the truth for any CSS-less renderer). An element whose colour is
  one of the 8 `PALETTE` slots additionally gains `class="wb-cN"` (a
  fill-painted scanfill blob gains `wb-fN` — the stroke rule would outline
  it); the white background rect gains `wb-bg`. Classes are **derived from
  the colour at serialize time** — except for an element carrying a STORED
  `slot` (see the dual representation below), whose literal hex cannot name
  its theme slot.
- One serializer-owned `<style wb:role="palette">` block defines
  `--wb-bg`/`--wb-c0…c7` (light defaults + a `prefers-color-scheme: dark`
  override from `PALETTE_DARK`) and maps the classes to `var(--wb-cN, <hex>)`.
  Parse recognizes the `wb:role` and DROPS the block — it is regenerated on
  every save, so a stale palette can never freeze into the prelude.
- All rules scope to `svg.wb-board` (the serializer merges that class into the
  root, in front of any foreign class; parse strips the token back out).
  Never `:root` — the file gets inlined into HTML pages.
- A custom hex gets no class and stays literal in every scheme; a custom
  background likewise. `"themed": false` in the `wb:doc` metadata turns the
  whole mechanism off for a document.
- In the app, the adapter copies the resolved app-theme `--wb-*` values onto
  the board `<svg>` as inline style (inline beats the embedded block), so a
  forced app theme wins over the OS scheme while editing. base.css DERIVES
  those values from the theme's brand trio (`--wb-bg` is `--editor-bg`, the
  ink/pencil slots are `--fg`/`--fg-muted`, and the chromatic slots are
  `--brand-primary`/`--brand-secondary`/`--brand-tertiary` and blends of
  them), so every theme — built-in or user-authored — gets a matching board
  and ink palette automatically. The hexes in `tool-settings.ts`
  (`PALETTE`/`PALETTE_DARK`) are only what the saved file falls back to
  outside the app.
- The STATIC palette (`STATIC_PALETTE`, named SVG colours) is the opt-out made
  convenient: named colours never equal a `PALETTE` hex, so static strokes are
  literal by construction — no format machinery at all.

### The dual colour representation (`colorMode` + stored slots)

A scanned drawing holds BOTH colourings in one file, and a metadata switch
decides which one renders:

- A scan element carries its **measured (true) hex** in the presentation
  attribute and its **snapped palette slot** as `class="wb-cN"`/`wb-fN`. The
  slot is stored on the element (`SceneElement.slot`, parsed back from the
  class) exactly when the hex can't derive it; a derivable slot is never
  stored, so drawn ink and pre-dual files stay structurally identical.
- `colorMode` in the `wb:doc` metadata (`'themed'` default / `'fixed'`) is the
  switch. Fixed adds `wb-fixed` to the root class, and every palette rule that
  APPLIES colour is scoped `svg.wb-board:not(.wb-fixed)` — so fixed mode
  renders the literal attribute colours in the app, a browser and an export
  alike, while the map stays in the file. `svg.wb-board.wb-fixed` pins the
  surface white (measured colours were measured against white). Flipping the
  mode (`setColorMode`, the board's `◐` control, the scan review's colour
  select) is a one-token, undoable metadata edit that never recolours an
  element and never re-runs a trace.
- `theme-inject.ts` is the display half for `<img>` contexts: an SVG inside an
  `<img>` is sealed off from the page's `--wb-*` variables, so the preview
  pane and the Edit-mode editor bake the RESOLVED app-theme values into the root
  tag as an inline `style` when building the data URL (theme-fingerprinted
  cache keys). Fixed-mode and foreign SVGs pass through byte-identical.

## Infinite vs page boards

`background: null` (the default for new boards) means **infinite**: no page
rect; the palette block paints the surface via CSS `background` on the svg
viewport, and the serializer refits the root viewBox to the content
(`bounds.ts`: +48 margin, integer-rounded, idempotent, unioning the stored
viewBox when raw/foreign content is unmeasurable). A non-null background is a
**page**: the rect is emitted, the viewBox is the page and is never touched.
`setBackground` (layers.ts) flips between the two — adding a page pins the
current content-fitted viewBox.

## `scan/` — photograph a physical whiteboard

Phase 4 ships S0–S1: acquire and rectify. Phases 5–7 add the illumination,
ink-extraction, vectorizing and OCR stages beside these, in the same shape.

| File | Role |
| --- | --- |
| `types.ts` | `RgbaImage`, `Quad`, presets. **A dependency-free leaf** |
| `image-ops.ts` | downscale/resample, luminance, Otsu, connected components, bilinear sampling, `rotate90` |
| `quad.ts` | find the board: hull → decimate → maximum-area quadrilateral |
| `homography.ts` | DLT solve, Zhang & He aspect recovery, the banded inverse warp |
| `pipeline.ts` | output sizing (`planRectify`) and the resumable `createRectifier` |
| `illumination.ts` | S2: flat-field estimate (van Herk dilation) + division; glare detection |
| `distance.ts` | exact Euclidean distance transform (Felzenszwalb–Huttenlocher); stroke-width estimate |
| `binarize.ts` | S3a: Sauvola-modulated strong/weak luminance gates + free-standing chroma gates |
| `components.ts` | S3b: hysteresis, per-component stats and filters, the i-dot rule, the border split rescue |
| `separate.ts` | S4.5: split mixed-marker components (crossing strokes) along page-level colour clusters |
| `color.ts` | S4: core-pixel colour voting, page-level hue peaks, 2-D black test, snap to the drawing `PALETTE` |
| `clean.ts` | the resumable S2–S4.5 job (`createCleaner`), the mode-switchable `composeCleaned`, and `composeRemovedDebug` |
| `thin.ts` | S5: Zhang–Suen thinning, active-frontier queue (O(ink pixels)) |
| `skeleton.ts` | S5: skeleton → polylines (junction clustering, spur pruning, angle-paired continuation) |
| `contour.ts` | S5: marching-squares boundary loops — the blob fallback |
| `trace.ts` | the resumable S5 job (`createTracer`), stroke/blob classification, `buildScanElements` / `fitScanElements` + the size guard |
| `text-layout.ts` | S6 gate: group traced marks into text LINES (y-bands, x-gap splits, i-dot satellites); classify the rest diagram-ish so no engine is asked to read an arrow |
| `ocr.ts` | S6 port + representation: recognizer request/response shapes, `<desc>` + hidden `<text>` builders (one-line RawElements), the `ocr[layerId]` metadata entry, and `applyScanOcr` — the pure async-safe layer patch |

Phase 5's own decisions (beyond the table in the plan):

- **Ink is decided per component, never per pixel** — hysteresis (a weak blob
  must contain a strong pixel) plus stats filters in units of the measured
  stroke width `w`. No blanket morphology anywhere; every removal is
  surgical and explainable, and the eraser-ghost golden asserts ZERO
  surviving components.
- **Colour output defaults to `'themed'`** — each component snapped to its
  `SCAN_PALETTE` hex, which is BY CONSTRUCTION a member of the drawing
  `PALETTE` (a test pins this), so scanned ink matches drawn ink and will be
  themeable for free when phase 6 vectorizes it. `'true'` keeps the voted
  measured colour — still one colour per component; this is the colour
  VOTING output, not raw pixels. Switching modes is a cheap re-compose from
  the cached extraction, never a pipeline re-run.
- **The cleaned raster is flat colour on pure white and ships as PNG**
  (photo fallback stays JPEG): flat colour compresses far better as PNG and
  JPEG ringing would haunt phase 6's tracer.
- **The i-dot rule is GENEROUS on purpose, and despeckling is phase 6's job.**
  Proximity to kept ink is the whole test; a speckle-sized component within
  2·w of confidently-kept ink stays. Two UAT rounds tried to make it
  discriminate — first a shape gate (dab `dtMax ≥ 0.3·w` or fragment spanning
  ≥ `w`), then an exemption for rescued components — and both failed the same
  way. Every property that separates residue from faint ink at the RASTER
  level (size, elongation, darkness, core thickness) also separates a fading
  stroke from its own solid part, so each tightening punched holes in
  lightly-drawn circles and arrows. **Losing ink is the worse error**: a
  surviving speck is one eraser tap away, a stroke the pipeline never emitted
  is gone for good. After tracing, a speck is a path with no length and no
  continuation — a decidable question, and phase 6's to answer.
- **A component with no core INHERITS its colour.** Below `0.4·w` half-width
  every pixel is anti-aliased edge, which is desaturated by construction, so
  the vote returns black whatever the marker was — which is how a green board
  came back with black specks and a black-dashed arrow. Such a component takes
  the answer of the nearest cored component within `3·w`; with nothing in
  reach it keeps its own vote. Donors must be cored, so fragments never chain.

Post-phase-7 UAT revisions (a real wiring-board photo — the failures were
colour consistency and a vanished box):

- **Colour is PAGE-CONSISTENT, not just component-consistent.** Component
  votes snap to the page's marker-hue peaks (`estimateMarkerHues`: circular
  histogram, smoothed, peaks ≥30° apart) and the PEAK is binned — a teal pen
  whose strokes straddle the 165° bin edge no longer splits across two
  buckets. The black test is 2-D (`isBlackVote`): low chroma, OR moderate
  chroma while dark — warm lighting pushes black ink's chroma past the flat
  cutoff but cannot brighten it.
- **Crossing strokes are SEPARATED before voting** (`separate.ts`, stage
  S4.5). Wires cross on real boards, and one 8-connected component holding
  two markers votes as one — the black wire came back red. Ridge pixels
  (distance-transform maxima) are classified into page colour clusters; a
  component whose ridge holds ≥2 real clusters is split by multi-source BFS
  from those ridge seeds into per-cluster components. Single-marker
  components pass through untouched, object-identical.
- **A border removal SPLITS instead of swallowing** (`rescueBorderInk`). A
  diffuse glare streak can run from real ink to the frame edge and weld them
  into one oversized border-touching component. Strong DARK pixels (bright
  chromatic pixels are reflections, not ink — `BORDER_GLARE_LUM`) that do not
  themselves touch the border come back as new components with a `2·w` weak
  halo; the streak and the frame stay removed.
- **Every removal is attributed.** `InkExtraction.removedComponents` records
  each removed component with its reason; `composeRemovedDebug` paints them
  tinted by reason (the scan panel's Debug insert writes it as
  `3b-removed.png`). "My box vanished" is now a one-file diagnosis.

Four things here are decisions, not implementation details:

- **Detection is a heuristic and says so.** `detectBoardQuad` returns
  `source: 'frame'` when nothing board-shaped stood out, and the crop screen
  always shows draggable corners regardless. The Drive scanner's trick is not
  perfect detection — it is that fixing a bad guess costs one drag.
- **The aspect ratio is RECOVERED, not measured.** A board shot at an angle
  projects to a quad whose side lengths lie about its shape;
  `quadAspectRatio` inverts the projection (Zhang & He, MSR-TR-2003-39). It
  returns null on a near-fronto-parallel shot — where there is no perspective
  to invert — and `sideLengthAspect` is exactly right in that case. A test
  projects known rectangles through a synthetic camera and asks for their
  ratios back within 3%.
- **The warp is destination→source and BANDED.** Inverse mapping because
  forward mapping leaves holes; banded because 3.2 M bilinear samples in one
  loop is a frozen tab. A test asserts a banded run is byte-identical to a
  one-shot one — banding must be invisible.
- **The output long edge is clamped to what the source resolves.** Upsampling
  a 900 px quad to 1800 px invents no detail and makes every later stage
  slower for nothing.

Phase 6's own decisions (beyond the plan's spec — full rationale in
`whiteboard-plan.md`):

- **Traced strokes ARE pen strokes** — same element, same smoothing, so the
  eraser/select/theming all work on scanned ink with zero new machinery.
- **`wb:tool="scanfill"`** is the blob fallback: a first-class stroke painted
  with `fill` (evenodd), colour still in the model's `stroke` field, no
  palette-slot class (the block's stroke rule would outline it).
- **Sauvola has an absolute-darkness floor** (`L < 0.35`): its low-variance
  veto otherwise hollows any filled region larger than its window into a ring.
  Sauvola may veto contrast decisions, never darkness.
- **A nib-sized dab is a DOT.**
- **The despeckle is WIDTH-relative, and only ever a conjunction** (revised
  after desktop UAT on a real board): ink whose measured width is under
  `0.5·w` AND whose length is under `3·w` is residue and is dropped — the one
  discriminator the raster never had, because a marker cannot leave a mark
  much thinner than its own nib unless it is fading, and fading ink is LONG.
  Same rule at the skeleton-graph level for dangling wisp edges (they fake the
  junctions that fragment the stroke they hang off; solid edges also pair
  before residue edges in junction continuation). Thin-but-long ink — a
  hairline stroke, a fading tail — always survives.
- **Every emitted stroke carries its own PATH median width**, never a
  component-wide one: a single component can hold a marker-fat line and its
  fading hairline continuation, and one shared width lies about both.
- **The width FLOOR is the despeckle's complement**: surviving thin-but-long
  ink renders at no less than `0.5·w` — the sub-nib measurement is
  binarization catching only a faint stroke's core, and drawing it verbatim
  makes it near-invisible. Below the floor and short → dropped; below the
  floor and long → drawn at exactly the floor.
- **Pixel-scale NICKS are bridged after tracing** (`bridgeNicks`): endpoint
  pairs within `2·w` (the nick itself is under half a nib; thinning retreats
  each endpoint another half-nib) merge into one stroke, but only ACROSS
  components (a nick by definition split the ink — same-component ends are
  the junctions continuation deliberately refused), and only when both end
  tangents continue across the gap within 50° (letters at that distance are
  never collinear). A circle drawn in one movement with one nick closes back
  into a ring.
- **Covered residue is suppressed** (`suppressCoveredResidue`): a thin path
  (≤ `0.75·w`) whose sampled vertices sit ≥80% inside the painted band of a
  strictly wider stroke is a parallel edge-doubling track — the wider stroke
  already paints every pixel it would, so dropping it removes an element,
  not ink. Thin ink in open space is covered by nothing and always survives;
  nib-width retraces are never suppressed (real double-drawn marks stay).
- **The size guard** (`fitScanElements`) raises ε geometrically until the
  serialized elements fit 1.5 MB; it never drops strokes.

Phase 7's own decisions (S6 — OCR):

- **Recognition is a PORT.** Core fixes the request/response shapes and the
  SVG representation; the engines live behind platform bridges selected in
  `src/ui/scan-ocr.ts` (Android: ML Kit Digital Ink → Text Recognition
  fallback; Windows: `Windows.Media.Ocr`; macOS/Linux: none — the metadata
  records `"status": "unavailable"` honestly).
- **The output rides existing machinery.** The `<desc>` and the hidden
  `<g wb:ocr="text" opacity="0">` group are ONE-LINE RawElements — verbatim
  re-emission gives byte-stable round trips for free, and `applyScanOcr`
  regenerates the pair wholesale on a re-run. Structured detail (engine,
  timestamp, per-line confidence, boxes, `wb:id`s) goes in the `wb:doc`
  metadata under `ocr[layerId]` with deterministic key order.
- **OCR never blocks the scan.** Strokes insert first; the outcome promise
  rides the insert payload and the adapter patches the layer when it settles —
  `history.replace`, not `push`, so the annotation never costs an undo step,
  and a layer deleted meanwhile drops the result (`applyScanOcr` → null).
- **Confidence is nullable, never invented.** ML Kit ink candidates and
  Windows OCR report none; the schema records `null` there and the real number
  where the raster engine has one.
- **OCR accuracy expectations** (recorded after "48v" read as "49v"): none of
  the engines expose a character allowlist or a correction hook, digits in
  handwriting are genuinely unreliable (Windows's printed-text engine
  especially), and no post-processing is applied — a heuristic that "fixes"
  digits corrupts text that was right. The strokes themselves are always
  preserved verbatim; OCR text only reaches the `<desc>`, the hidden text
  group and "Copy text", so a misread digit costs search/copy fidelity, never
  ink. Android sends the UI language with the ink payload so the model choice
  is explicit.

Fixtures are GENERATED in-test, never committed as bytes: a JPEG decoder
differs across platforms and pixel-exact goldens on photos are a maintenance
trap. Real-photo fixtures arrive in phase 5, asserted as summary statistics in
ranges.

## Error policy

Malformed XML throws `WhiteboardParseError`, which the adapter turns into the
error card with an "Open as text" button (`setMode('raw')`). Everything else
degrades instead of throwing: a corrupt `wb:doc` JSON blob is dropped (the
strokes live in the SVG body, not the metadata), a missing viewBox falls back
to a default board, a foreign root opens as an Imported layer.
