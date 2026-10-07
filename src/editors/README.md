# src/editors/ — Editor adapters

Both editors implement `EditorAdapter` (defined in `src/core/mode-sync.ts`,
re-exported from `./adapter.ts`). The contract and its tests are normative —
read `src/core/__tests__/mode-sync.test.ts` before writing either adapter.

Contract essentials:

- `attach(host, model)` renders `model.getText()` into `host`; may be async.
- `detach()` synchronously flushes any pending write-back, then tears down.
- Must survive `attach → detach → attach` (mode-sync re-attaches on failure).
- Echo suppression via reentrancy flag (pattern in `doc-model.ts` header).

---

## cm6.ts — CodeMirror 6 source editor (M1)

Used by both `raw` and `split` (split adds a second pane — the preview, or on
an `.svg` tab the whiteboard editor; the CM6 instance is identical and is NOT
re-created when toggling raw⇄split).

### Recipe

```ts
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { tags } from '@lezer/highlight';
```

- One `EditorView` per adapter instance, created in `attach`, destroyed
  (`view.destroy()`) in `detach`. Keep the adapter reusable: `attach` after
  `detach` creates a fresh view from the current model text.
- Extensions: `markdown({ base: markdownLanguage })` (GFM variant),
  `history()`, `search()`, `lineNumbers()` behind a **Compartment**, OFF by
  default (Notepad feel) — the "Line numbers" setting toggles it live via
  `setLineNumbers`, `EditorView.lineWrapping` behind a **Compartment** (M6
  toggles it), theme + font size each behind their own Compartment.
- Editor → model: `EditorView.updateListener.of((u) => { if (u.docChanged) pushSelf(u.state.doc.toString()) })`
  where `pushSelf` wraps `model.pushText(text, 'cm6')` in the reentrancy
  flag.
- Model → editor (external change: file reload, wysiwyg write-back, a Live
  Edit merge): subscribe in `attach`; unless suppressed by the flag, apply
  the change as ONE transaction of minimal line-level edits —
  `view.dispatch({ changes: diffToChanges(current, text) })` (core/diff.ts) —
  so the selection and scroll position map through instead of resetting. A
  whole-document replace would put the caret at 0 every time someone else's
  save merged in. Do NOT recreate the view for external changes either.
- `flashRanges(ranges)` (Live Edit): a `StateField` of `Decoration.line`
  marks (`.cm-live-merged`, CSS fade in app.css) on the lines covering the
  given ranges, mapped through later edits and cleared by a timer that
  `detach` cancels.
- Unsubscribe from the model in `detach` (keep the unsubscribe fn).
- Cursor persistence (M2): expose `getSelection()`/`setSelection(anchor,
  head)` on the adapter (clamp offsets to doc length — a restored cursor
  may exceed a shrunken doc).
- Voice typing: `insertText(text)` puts a dictated phrase at the caret
  (replacing any selection, spacing from `core/dictation-insert.ts`) and
  refocuses. The Milkdown adapter implements the same method.
- Split mode on a drawing adds three members, all driven by `ui/svg-split.ts`:
  `setLinkedRanges(ranges, reveal)` (a steady MARK decoration — two elements
  can share a line, so a line decoration would claim both — with no caret
  move and no focus change, because the other pane's selection must never
  interrupt typing here), `revealRange(from, to)` (the explicit jump: caret,
  centre, focus) and `subscribeSelection(fn)`, a second caret watcher beside
  the single `onSelection` option. **Nothing may dispatch into CM6 from
  inside its own update listener** — the link defers every write by a
  microtask for exactly that reason.

### List indentation (Tab / Shift+Tab)

`list-indent.ts` holds the whole rule set as a pure function —
`reindentLists(lines, startLine, endLine, delta)` takes and returns plain
string arrays, so it is Vitest-covered without importing CM6. `cm6.ts` only
splits the doc, calls it, and diffs the result into per-line changes.

Word-like semantics: bullet markers cycle with depth (`*` → `-` → `+`,
repeating), a moved item takes its descendants with it, ordered runs are
renumbered across the surrounding block, and an item that would skip a level
(the first at its depth) does not move. Returning `null` means "not a list
selection" — the keymap then reports not-handled so Tab falls through to focus
navigation. Ordered nesting stays numeric: CommonMark has no `a.`/`i.` lists.

### Syntax highlighting

Define one `HighlightStyle` using CSS variables (not hex values) so themes
switch without touching CM6: headings bold + `var(--accent)`, emphasis
italic, code `var(--fg-muted)` on subtle bg, links underlined. Register via
`syntaxHighlighting(style)` inside the theme compartment so a theme flip
reconfigures it atomically.

### Code files (`language: 'ts' | 'rust'`)

`code-highlight.ts` wraps the Lezer grammars the code Review model already
parses with (`@lezer/javascript` in its TypeScript+JSX dialect, `@lezer/rust`)
in `LRLanguage.define`, so a `.ts`/`.js`/`.rs` tab's Raw mode gets real syntax
colouring for free — no second tokenizer, and the same tree the model reads.
`EditorHost` picks the value with `codeLanguageFor(path)` from
`core/code/parse.ts` and falls back to `'plain'` for any other code-family
file. The style follows the `--md-*` variable vocabulary of the markdown and
XML styles (keywords → accent, definitions → heading, types → link, strings →
code, comments → quote), so themes need nothing new. Like `'xml'` and
`'plain'`, these languages drop the markdown-only editing behaviours.

### Pitfalls

- Fira Code ligatures: the editor content element must inherit
  `font-variant-ligatures: contextual` — set `.cm-content { font-family:
  var(--font-mono); }` in the theme and DON'T set `font-feature-settings`
  to anything that disables `calt`.
- CM6 packages must not be version-mismatched (all `@codemirror/*` move
  together); they are pinned by the lockfile — don't bump one alone.
- `EditorView.updateListener` fires for selection-only updates too — gate
  on `u.docChanged` before pushing.
- `searchKeymap` is registered MINUS its `Mod-g` entry (find next / previous,
  which CM6 binds with `preventDefault`): the app's global `mod+Shift+G`
  opens the git tab (`ui/keymap.ts`) and has to reach the window listener
  from a focused editor. F3 / Shift+F3 and the search panel's Enter still
  step through matches. Don't add `Mod-g` back without moving the chord.

---

## Heading marks (both text editors)

Right-click an ATX heading → Mark running / Mark complete / Clear mark
(picking the ticked mark again clears it, `markAfterPick`). The
mark is a trailing glyph in the heading text (`core/heading-mark.ts`), so the
editors only (a) decide a line IS a heading, (b) rewrite its tail, and (c)
tint it with `.heading-mark .heading-mark-<mark>` (app.css). The rest of the
section — body and unmarked sub-headings, up to the next heading of the same
or a higher level — gets `.heading-mark-section .heading-mark-section-<mark>`;
`sectionMarks` (core) decides which mark each section shows (its own, else
the innermost marked ancestor's). Sections are built from TOP-LEVEL headings
only (a heading inside a list or quote still gets its own tint but does not
open a section). In Edit mode the band is per block, so block margins leave
small gaps in the bar; in CM6 lines are contiguous.

- `heading-marks-cm6.ts` (markdown language only): a `ViewPlugin` of line
  decorations over the visible ranges, and a `contextmenu` handler that
  checks the syntax tree (`ATXHeading*`, so fenced `#` lines never qualify)
  and replaces just that line as a `input.heading-mark` user edit.
- `heading-marks-milkdown.ts` (lazy chunk only — imported by `milkdown.ts`
  through `crepe.editor.use`): a ProseMirror plugin with node decorations
  and the same menu; it replaces only the glyph tail with an unmarked text
  node and is NOT tagged programmatic, so the guard writes it back.
- `heading-mark-menu.ts` is the shared menu. On Windows it does NOT cancel
  the native menu (that would hide the spell checker's suggestions, which no
  web API exposes): it stashes the items on `window.__mdSpecpadNativeMenu`
  and `src-tauri/src/native_menu.rs` appends them to WebView2's menu under a
  deferral, calling `select(id)` on a pick. A capture-phase `contextmenu`
  listener clears the stash on every right-click. Other platforms cancel the
  native menu and open `whiteboard-menu.ts`'s `openContextMenu` instead. Only
  heading right-clicks are touched; everywhere else the native menu stays.
- `heading-fold-cm6.ts` (markdown only, behind the `collapsibleHeadings`
  setting via a Compartment in `cm6.ts`): CM6's `codeFolding` + `foldGutter`
  + `foldKeymap` — the markdown grammar's own fold service already folds a
  heading's section, and `cm6.ts` switches the grammar's paragraph folds
  off so arrows sit on headings, lists and code blocks only — plus an update
  listener that folds a heading the moment a change turns it into a running
  one (`linesTurnedRunning`, pure and tested). It keys off the document
  change, not the menu, so Edit mode's write-back and an agent saving the
  file collapse the section too; the fold is dispatched from a microtask
  because CM6 forbids dispatching inside an update. Turning the setting off
  reconfigures the compartment to `[]`, which drops the fold state (unfolds
  everything) with it.

---

## milkdown.ts — Crepe/Milkdown WYSIWYG (M5)

Loaded ONLY via dynamic import from the wysiwyg `AdapterFactory` (I8):

```ts
// in the tab wiring (ui), not here:
const wysiwygFactory: AdapterFactory = async () => {
  const { createMilkdownAdapter } = await import('../editors/milkdown');
  return createMilkdownAdapter();
};
```

### Recipe (Crepe first — fall back to @milkdown/kit only if theming fails)

- Instantiate `Crepe` with `defaultValue: model.getText()`, features
  trimmed to the minimal set (disable anything that fights the aesthetic:
  image upload UI etc. — evaluate at M5 against Crepe's current feature
  flags).
- Theme via Crepe's CSS variables mapped onto ours (`--bg`, `--fg`,
  `--accent`, `--font-mono`). Content font stays monospace — that's the
  product's look, even in Edit mode.
- **Write-back guard is mandatory** (I2): create
  `createWritebackGuard({ serialize, push, debounceMs: 150 })` in `attach`,
  where `serialize` reads the current editor markdown and `push` wraps
  `model.pushText(text, 'milkdown')` in the reentrancy flag.

### The transaction-tagging pattern (the #1 pitfall)

Do NOT use Milkdown's high-level `markdownUpdated` listener naively — it
fires for programmatic content-setting too, which would defeat the guard
and normalize documents the user only LOOKED at. Instead:

1. Get the ProseMirror `EditorView` from milkdown's ctx (`editorViewCtx`).
2. Wrap `dispatchTransaction`（or use a ProseMirror plugin) so EVERY
   transaction reports
   `guard.noteTransaction({ docChanged: tr.docChanged, programmatic: !!tr.getMeta('md-specpad-programmatic') })`.
3. Any content you set yourself (initial load, external model change) must
   carry that meta flag: `tr.setMeta('md-specpad-programmatic', true)`.
4. `detach()` calls `guard.flushSync()` FIRST, then destroys the editor.

Model → editor: on external model changes (reentrancy-flag filtered),
re-parse the document into the editor with the programmatic meta set.

### Normalization hint (M5)

On attach, compute `serialize(parse(text)) !== text` (both available from
milkdown's ctx once loaded — cheap for note-sized docs). If true and the
tab hasn't shown it before, ask the UI (callback option on the adapter) to
show the one-time status-bar hint.

### Local images and board colour mode

`createImageNodeView` owns the `image` node's DOM: local refs are read off
disk and inlined as data URLs (adapter-lifetime cache keyed by path, plus
the theme fingerprint for a whiteboard `.svg`, which gets the app palette
baked in — `core/whiteboard/theme-inject.ts`). A board is tagged
(`data-wb-path` / `data-wb-mode`, `core/whiteboard/color-mode.ts`) and its
right-click reports `onBoardContextMenu({ path, mode, x, y })` instead of the
native menu; other images keep the webview menu (they sit in contenteditable).
The host's menu rewrites the file's `colorMode`, then calls the adapter's
`refreshImages(paths)` (a `MilkdownAdapter` extra beyond the mode-sync
contract) which drops those cache entries and re-applies every live node.

### Known limitations to verify at M5 (QA has a section)

GFM round-trip: tables, task lists, strikethrough, autolinks survive; check
footnotes and HTML blocks — if Crepe drops them, the no-edit guarantee (I2)
still protects untouched docs; document "editing in Edit mode may drop X"
in the root README known-limitations list.

---

## whiteboard.ts — the Draw-mode whiteboard editor

Loaded ONLY via dynamic import from the `draw` `AdapterFactory` (I8), same as
Milkdown. `EditorHost` supplies that factory only when
`docFamilyFor(path) === 'svg'`; a markdown tab has no draw adapter at all, and
`createModeSync`'s `adapters` map is `Partial` precisely so a tab can offer just
the adapters its document family uses.

An `.svg` tab's **Split** mounts a SECOND instance of this adapter in the pane
beside the source editor (`EditorHost`'s `createBoardAdapter`, the same options
both times). The two are never attached at once — mode-sync's lives in Draw,
Split's lives in Split — and they share the tab's entry in
`stores/whiteboard`, so the ribbon drives whichever is on screen and the
viewport carries across the switch. `ui/svg-split.ts` links what each pane is
pointing at, through `onSelectionChange` / `getSelection` / `selectRefs` and
the menu's `onRevealInSource` (omitted in Draw, where the item is not offered).

An `.svg` tab is an ordinary `kind:'file'` tab whose DocModel text IS the SVG
source. That is what buys dirty tracking, session buffering, Ctrl+S/liveSave,
mtime conflict detection and tear-off for free — and it makes Raw mode a free
SVG source editor. Nothing about `TabKind` or the session manifest changed:
`parseManifest` hard-validates `kind` but never validates `mode`, so a
`mode:'draw'` file tab degrades harmlessly to the source editor in an older
build instead of self-healing the session away.

- All logic lives in `src/core/whiteboard/` (read its README first). This file
  and `whiteboard-layers.ts` are the only places in the whiteboard stack that
  touch the DOM.
- Rendering hands **SVG source** to DOMParser and adopts the resulting `<svg>`,
  so the pane shows exactly what the file says — the same pixels a browser or
  the markdown preview would show. Before the first edit that source is the
  file's own bytes; after it, `serializeWhiteboard(scene)`. There is
  deliberately no second rendering path that could drift from the format.
- **A parse failure lands one of two ways.** With nothing ever drawn there is
  no picture to stand on, so it raises the error card, whose "Open as text"
  button calls `setMode('raw')`. Once a version of the document HAS rendered,
  a later failure instead goes **stale** (`staleMessage`): the last good
  picture stays, dimmed, under a strip saying why it stopped following, and
  every edit is refused — `commit` returns early and `onPointerDown` routes
  like a scene-less board, so pan and zoom still work. That is the state
  Split mode lives in half the time (a source editor holds invalid XML every
  other keystroke), and both halves of it matter: replacing the drawing with
  an error card would make the other pane useless, and committing from the
  stale scene would silently throw away what is being typed.
- The in-progress stroke/shape is drawn on a transparent `<svg>` overlay via
  `serializeElement` — the same function that will write the committed element,
  so the drag preview cannot disagree with the result. The board itself is not
  touched until the pointer lifts.
- Pan/zoom reuses `core/diagram-zoom.ts` unchanged. The stage sets
  `touch-action: none` and does its own pointer routing. Phase 2 is **mouse and
  pen only** for tools: a finger pans (one pointer) or pinch-zooms (two), and a
  held space bar or non-primary button pans without leaving the tool. A pen's
  eraser end (`button === 5`) overrides the selected tool while it is down.
  Full touch routing, palm rejection and the finger-draw toggle are phase 3.
- **Write-back is guarded** (I2): nothing is pushed into the DocModel until a
  genuine edit, so mount → look → close is byte-identical and opening a
  hand-authored or Inkscape SVG never normalizes it. Pushes are debounced
  150 ms and flushed synchronously in `detach()`, which is what makes a fast
  Draw→Raw toggle lossless.
- **Echo suppression is a reentrancy flag**, not a version check: our own
  `pushText` re-enters the model subscription synchronously (see
  `doc-model.ts`). Without the flag every stroke would re-parse the board from
  its own output and reset the undo history.
- Undo is a snapshot stack (`core/whiteboard/history.ts`), **per adapter
  instance** — it is lost on a Draw⇄Raw switch, matching the documented
  raw⇄wysiwyg limitation. An external change (raw edit, file reload, conflict
  resolution) resets the timeline to the incoming text.
- The **ribbon is the draw toolbar**: tool, colour and nib live in
  `ui/stores/whiteboard.ts` (global, not per-tab — the marker you picked stays
  picked on the next board) and the adapter reads them at each gesture start.
  Undo depth flows the other way through `onStateChange`. The layers panel and
  zoom cluster stay in the adapter, so neither side subscribes to the other.
  Note `core/whiteboard/tool-settings.ts` is a dependency-free leaf **on
  purpose**: the ribbon is in the eager entry bundle, and importing the palette
  from `tools.ts` would drag smoothing, serialization and the XML reader into
  startup, quietly undoing I8.
- **Selection, text and touch (phase 3)** keep the same shape: `select.ts` and
  `input.ts` decide, this file wires. Three things about the wiring are load-
  bearing:
  - A select drag paints straight onto the board and commits ONCE on release
    (the eraser-drag pattern), re-deriving from the drag's own starting
    document every frame so transforms never accumulate.
  - The text editor is a `<textarea>` parented to the **transformed**
    `.wb-canvas`, so the browser pans and zooms it with the board and the
    on-screen type size is the size that gets committed. It grows sideways and
    never wraps, because `<text>` never wraps — see the format README; a
    drag-out wrapping box was built and reverted.
  - The viewport is reported UP for per-tab session persistence and is never
    written to the file — panning must not dirty a document. A `view` in the
    file's metadata is honoured read-only as the opening view.
- `refreshTool()` exists because tool settings are PULLED per gesture: the
  cursor and the selection handles are what the ribbon has to announce.
- **Styling lives in the ribbon (diagram phase A).** There is no floating
  toolbar and no properties panel: a swatch, nib, fill, dash or arrow-head
  click calls `restyleSelection(patch)` AND sets the tool default, so one click
  changes what is selected and what the next shape will look like. The decision
  is `core/whiteboard/style.ts`; this file only commits it, and the refs
  survive because a restyle replaces elements in place.
  - The traffic back up is `WhiteboardUiState.selectionStyle` — the style the
    whole selection AGREES on, each field null when mixed. The ribbon shows the
    selection when there is one and the tool's own settings otherwise, and
    highlights nothing for null. It also carries `hasText`/`hasInk`/`hasLine`,
    which is how the ribbon decides whether to show the type row, the nib row
    or both; before this it swapped the nib row out for ANY selection, so
    selecting a shape hid the control its outline needed.
  - Ten shapes and three style controls would have pushed the strip past the
    width it has to fit on a tablet, so they live behind two popovers (the
    shape picker, whose button is the last shape you used, and the shape-style
    menu). Both use the same dismiss contract as the other ribbon menus.
  - Shift constrains a shape drag (square/circle, 45° line). It is read LIVE
    on every move rather than latched at the press, because people reach for it
    once they can see the shape is not square yet; the maths is
    `constrainShapeDrag` in `tools.ts`.
  - The drag-preview overlay carries its own copy of BOTH arrow markers — the
    board's `<defs>` only exists once the file HAS an arrow, so without them
    the first one would drag around headless.
- **Layout ops, groups and labels (diagram phase B)** add no state model to
  this file; they add three seams worth knowing:
  - `expanded(refs)` / `setSelection` — every selection the user makes is
    closed over groups and label ⇄ host links (`groups.ts`) before it is used.
    That is the hook: a group moves as one and a label follows its host
    because they were selected, not because move knows about them. Connectors
    do NOT expand (an arrow is not part of the box it points at) — they follow
    through `settle`.
  - `settle(doc)` — the pure passes every RECORDED commit runs before the
    document becomes the next snapshot: `reconnect`, then `relayoutLabels`
    (a connector's label sits on its routed path, so the path settles first).
    Undo/redo skip it (a snapshot was settled when it was recorded). A resize
    drag runs the same `settle` per frame after scaling the selection MINUS
    its labels (`nonLabelRefs`), and a move drag runs `reconnect` per frame,
    so arrows and labels follow live rather than jumping on release.
  - `contextMenuItems()` — the right-click menu (`whiteboard-menu.ts`, plain
    DOM styled as a `.tab-menu`) is built from a list of items enabled by the
    pure predicates in `arrange.ts` / `groups.ts`. Later phases append to the
    list. The stage's `contextmenu` handler calls `preventDefault`, which is
    what tells `ui/context-menu-guard.ts` this surface owns the right-click.
  - The clipboard is reached through `options.clipboard` (the UI store holds
    it, globally, so a copy on one board pastes on another) and the system
    clipboard through the `ipc/clipboard` seam. Ctrl+V is deliberately NOT a
    keydown chord: the `paste` event carries the system clipboard's text,
    which a keydown cannot read, so `onPaste` owns it — images still go to
    the scan screen first, a whiteboard fragment lands as elements, and only
    an EMPTY system clipboard falls back to the board clipboard (prose copied
    since the last board copy means the user moved on).
  - The text editor gains an anchor: a label is typed CENTRED on its host
    (`.wb-centred`: `left` is the centre, `translateX(-50%)`, and the box's
    top follows `labelBaseline` for the lines typed so far), so the caret sits
    where the committed `text-anchor="middle"` glyphs will land. Editing
    existing text now keeps its id, group and `labelOf`.
  - Bare-letter tool hotkeys (`TOOL_HOTKEYS`) are looked up on the stage's
    keydown and reported UP through `onToolHotkey` — the ribbon's store owns
    the tool, the adapter only asks. `G` is its own branch, not a tool hotkey:
    it changes the document, so the adapter handles it directly.
- **The grid and snapping (diagram phase C)** add one piece of DOM the file
  does not have, and one rule to every gesture:
  - `renderGrid()` injects a `<pattern>`-based dot grid INTO the adopted board
    `<svg>`, after adoption — the one place the on-screen board deliberately
    differs from the file. It is safe by construction: `renderedText` comes
    from `serializeWhiteboard(scene)`, never from this DOM, so the injected
    nodes cannot reach the file. It goes inside the board rather than on the
    overlay because the dots have to sit UNDER the ink and over the page rect
    (the insertion point is "before the first `wb:layer` group"), and a grid
    painted over a drawing is one you have to turn off to read it. The dot
    radius is a constant number of SCREEN pixels, like the selection handles,
    and an infinite board's grid rectangle is the visible pane — so both are
    redone on every `setView`. Pattern ids carry a per-adapter suffix: every
    tab's editor is mounted at once (I7), and `url(#…)` resolves document-wide.
  - `beginSnap` / `snapContext` / `showGuides` / `clearGuides` are the seam.
    Candidates are computed ONCE per gesture (they come from the drag's base
    document, which does not change) and the selection is excluded EXPANDED,
    so a group being dragged never offers its own members to line up with.
    Snapping is applied in `elementFor` (a shape's end — snap first, then
    `constrainShapeDrag`, because a Shift-square that is not square would be
    the worse lie), at the press for a shape's start and for text placement,
    in `moveDelta` (the selection's BOUNDS snap, not the pointer — what the
    user is aligning is the box they can see) and in `resizeTarget` (the
    dragged handle, on the axes that handle actually moves). `beginSnap` also
    collects every host's ports (`guidePorts`) into the context; `snapPoint`
    lands on one within the threshold, both axes at once.
  - `snapOff` is Alt, read LIVE on every pointer event for the same reason
    `constrained` reads Shift live: people reach for it once they can see the
    snap pulling something where they did not mean it to go.
  - The ribbon's grid button goes through `WhiteboardUiState.grid` and
    `adapter.setGrid(patch)` — per TAB, unlike the tool, because the grid is
    stored in the document. That commit passes `record: false` and
    `history.replace`, so the grid never costs an undo step, and `restored()`
    carries the live grid over anything undo or redo brings back.
- **Live connectors (diagram phase D)** add no rendering of their own — an
  attached arrow is still a `<line>` (or an elbow `<path>`) the board draws
  from the file — only gestures, all deciding through `core/whiteboard/
  connectors.ts`:
  - Drawing a line/arrow: the press asks `connectorTarget` whether it landed
    on a host (a port within `PORT_SNAP_RADIUS` wins, else the body under the
    pointer with `nearestPort`); if so the gesture carries a `fromTarget` and
    starts ON the outline. `connectorFor` (the line branch of `elementFor`)
    asks the same question about the pointer every frame for `toTarget`, and
    aims a `c` port exactly the way `reconnect` will — at the other host's
    centre — so the preview IS the result. A host under the pointer beats
    grid and guide snapping: you are pointing at the box. On release
    `attachConnector` gives hosts their ids and re-aims the ends inside the
    same undo step. The preview element carries placeholder ids (`'?'`) so
    an elbow routes by its ports before anything has an id; they never reach
    the file.
  - A single selected line/arrow shows two round ENDPOINT handles instead of
    the resize box (`singleConnector` in `renderChrome`, filled when that end
    is attached), and `beginSelectDrag` checks them before anything else:
    dragging one is the `'endpoint'` select-drag, whose frame is
    `endpointFrame` → `setConnectorEnd` (attach to the host under the pointer,
    or detach to a snapped point). Committed once on release like every other
    select drag.
  - `hoverTarget` / `matchedPort` ride along with `matchedGuides` through
    `showGuides` and are cleared by `clearGuides`: the candidate host's four
    ports are drawn with the chosen one lit (a ring at the landing point for a
    `c` port), and a single selected host shows its ports faintly as an
    invitation. All chrome, none of it in the file.
  - Delete and the eraser go through `removeAndDetach`, so an arrow into a
    deleted box stays behind, detached. The context menu gains the route
    (Straight / Elbow, ticked via the new `checked` item flag) and Detach; the
    ribbon's shape-style popover gains a Route row that, like every control
    there, restyles the selection AND sets the tool default (`route` in the
    store and `ToolSettings`).

## deck-editor.ts + edit-switch.ts — Edit mode on a Marp deck

Edit (`wysiwyg`) on a deck is NOT Milkdown: a WYSIWYG round trip would
mangle directive comments (`<!-- _class: lead -->`) and `![bg]` alt syntax.
The intended workflow is "an agent writes the deck, a person tweaks it", so
the file must stay the agent's markdown.

- **`edit-switch.ts`** is the one adapter mode-sync holds for the `wysiwyg`
  kind on a markdown tab. It chooses Milkdown or the deck editor from the
  CONTENT (`core/deck isMarpDocument`) at attach time — mode-sync caches one
  adapter per kind, so the choice cannot live in its factory — and swaps them
  in place (detach flushes, then attach) when `marp: true` arrives or leaves
  while Edit is showing. Both inner factories stay lazy (I8). Swaps are
  serialized on a promise chain; a `detach()` mid-swap leaves nothing
  attached (`__tests__/edit-switch.test.ts`).
- **`deck-editor.ts`** is filmstrip + stage + inspector + notes, plain DOM
  under the `.deck-edit` host class (`styles/deck-edit.css`). It holds NO
  document of its own: every gesture is one of the pure, line-precise edits
  in `core/deck-edit.ts` (move/duplicate/delete/insert slide, spot directive,
  `![bg]` line, notes comment, frontmatter key, replace a block's lines),
  pushed at once with source `'deck-edit'` inside the reentrancy flag. With
  nothing to serialise there is nothing to normalise, so "mount → look →
  leave is byte-identical" holds by construction and no write-back guard is
  needed; `detach()` still flushes the debounced field writers and the open
  block popover synchronously, per the contract.
- **Click-to-edit** rides on `renderDeck(…, { stampLines: true })`
  (`preview/marp.ts`): every rendered block carries `data-line` /
  `data-line-end`. The innermost stamped element under the pointer is the
  block; `core/deck-edit blockRange` trims the trailing blank line
  markdown-it's `map` swallows; a popover textarea edits exactly those lines
  and pushes as you type (one undo entry per popover). Esc restores the
  document as it was when the block was opened. Filmstrip thumbnails mount the
  same render with the stamps STRIPPED, so a line added above a slide does
  not remount its thumbnail.
- **The engine is injected** (`DeckEngine`): Marp lives in `preview/`, which
  editors never import (I9). `ui/components/EditorHost.tsx` hands over
  `renderDeck` / `mountSlide` / `inlineDeckImages` / …, plus the image picker
  and "Source" (Split at this slide) — the same shape as the whiteboard's
  injected camera.
- **Undo** is the adapter's own snapshot stack (the CM6 history is not
  attached in this mode): one entry per gesture, typing coalesced per field
  visit; an external change to the model clears it. Inside a text field the
  browser's native undo applies instead.
- The inspector writes SPOT directives only (`_class`, `_backgroundColor`…):
  what it shows and clears is this slide's own value, never one inherited
  from an earlier slide or the frontmatter. Deck-wide settings are frontmatter
  keys.

## Testing expectations

Adapters are thin DOM glue by design — logic that can be tested (guard
wiring decisions, selection clamping, hint predicate) must live in pure
functions beside them and get Vitest coverage. The adapters themselves are
exercised by the QA checklists (M1/M5). One exception is pinned in
`__tests__/whiteboard-overlay.test.ts`: the draw overlay's `background: none
!important` — a cascade contract against the FILE's adopted palette stylesheet
that has regressed twice ("stroke draws, then vanishes on release").
