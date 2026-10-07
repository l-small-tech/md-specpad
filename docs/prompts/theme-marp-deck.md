# Make a Marp deck and its SVG images follow the app theme

I present Marp slide decks inside **md-specpad**, a markdown notepad with
switchable colour themes (light and dark ones, each with its own brand
colours). I want a deck — the markdown file plus every local `.svg` image it
references — converted so that the slides and the diagrams pick up whichever
theme the app is showing, while still looking right anywhere else a Marp deck
or an SVG file is opened. Work on the files in place. Keep every word, every
shape and every size exactly as it is: only colours, and the CSS that carries
them, change.

The deck is: **[path to the .md file]**.

## How the app themes things (read this before touching anything)

- The app sets CSS custom properties on the page. Marp slides inherit them
  (each slide renders in a shadow root, and custom properties cross that
  boundary), so a slide stylesheet can reference them. The useful ones:
  - Interface palette: `--fg` (text), `--bg` (chrome background), `--editor-bg`
    (writing surface), `--bg-alt` (panels), `--fg-muted` (secondary text),
    `--accent` (links, headings), `--border`, `--danger`, `--selection`.
  - Brand trio: `--brand-primary`, `--brand-secondary`, `--brand-tertiary`.
  - Drawing palette, derived from the theme: `--wb-bg` (paper), `--wb-c0`
    (ink), `--wb-c1` (primary), `--wb-c2` (secondary), `--wb-c3` (tertiary),
    `--wb-c4` (pencil, muted), `--wb-c5` (deep primary), `--wb-c6`
    (primary–secondary blend), `--wb-c7` (secondary–tertiary blend).
- An SVG shown through `<img>` is a sealed document; page variables never
  reach it. The app therefore recognises a **themable board**: an SVG whose
  root element carries `class="wb-board"` and whose first child is a palette
  `<style>` block (given verbatim below). Right before displaying such a file
  the app writes the theme's resolved `--wb-*` values into the root as an
  inline `style`, so the palette block's `var()` references pick them up. An
  SVG without that contract shows its literal colours, always.
- Every element keeps its literal `fill` / `stroke` **presentation
  attributes** as the fallback. The palette block's class rules override them
  in any CSS-capable renderer; a renderer with no CSS shows the literal
  colours. That is by design — never delete the literal colours.
- When the app exports a document it has one more fallback of its own: pure
  black, white and greys are remapped onto the theme's ink and paper, and
  chromatic colours are left alone. You do not need to do anything for that.

## Part 1 — the deck's markdown

1. Leave the frontmatter (`marp: true`, `theme:`, `paginate:` …), the `---`
   slide separators, the directives in HTML comments, the speaker notes and
   all text untouched.
2. Add one `<style>` block right after the frontmatter (Marp appends it to the
   theme). In it, map the slide chrome onto the app variables **with a literal
   fallback in every `var()`**, the fallback being the colour the deck has
   today, so the deck looks unchanged in the app's standalone HTML export and
   in any other Marp renderer. Typical block for the built-in `default` theme:

   ```css
   section { background-color: var(--wb-bg, #ffffff); color: var(--wb-c0, #222222); }
   section h1, section h2, section h3 { color: var(--wb-c1, #222222); }
   section a { color: var(--accent, #0288d1); }
   section code, section pre { background-color: var(--bg-alt, #f0f0f0); color: var(--fg, #222222); }
   section blockquote { color: var(--fg-muted, #666666); border-left-color: var(--border, #cccccc); }
   section table th { background-color: var(--bg-alt, #f0f0f0); }
   section table td, section table th { border-color: var(--border, #cccccc); }
   section header, section footer, section::after { color: var(--fg-muted, #666666); }
   ```

   If the deck uses `gaia` or `uncommon`, set those themes' own variables
   instead of overriding selectors, for example
   `section { --color-background: var(--wb-bg, #fff); --color-foreground: var(--wb-c0, #222); --color-highlight: var(--accent, #0288d1); --color-dimmed: var(--fg-muted, #666); }`,
   and give `section.invert` the swapped pair so inverted slides still invert.
3. Replace every literal colour in the deck's own CSS and in inline `style="…"`
   attributes with the nearest variable plus that literal as the fallback.
   Pick by role: text → `--wb-c0`, paper → `--wb-bg`, the deck's main accent →
   `--wb-c1`, its second accent → `--wb-c2`, third → `--wb-c3`, greys and
   captions → `--wb-c4` or `--fg-muted`, links → `--accent`, warnings →
   `--danger`. The same original colour always maps to the same variable.
4. **Never define** `--wb-*`, `--fg`, `--bg`, `--accent` or any other app
   variable inside the deck — only reference them. A definition would
   override the theme.
5. Optionally, for readers who open the exported HTML with a dark OS, add a
   `@media (prefers-color-scheme: dark)` block that repeats the same rules
   with dark fallbacks (paper `#1e1e1e`, ink `#e6e6e6`).
6. If the frontmatter names a theme file (`theme: ./something.css`), apply
   steps 2–5 to that file too and keep its `/* @theme name */` header.

## Part 2 — every SVG the deck references

Find every local `.svg` the deck uses: `![](x.svg)`, `![bg](x.svg)`,
`<img src="x.svg">`, and `url(x.svg)` inside inline styles. For each file:

1. **Root.** Add `wb-board` to the root `<svg>` element's `class` (keep any
   existing classes, `xmlns`, `viewBox`, `width`, `height`). Do not add
   `wb-fixed`. Do not add `<metadata>`.
2. **Palette block.** Insert this as the first child of the root, verbatim.
   The hex values are the fallbacks a renderer with no theme sees, with a
   dark variant for a dark OS; the app replaces them live.

   ```xml
   <style>
     svg.wb-board{--wb-bg:#ffffff;--wb-c0:#1a1a1a;--wb-c1:#1f9d55;--wb-c2:#0f8f8f;--wb-c3:#1f6fd0;--wb-c4:#8a3fd1;--wb-c5:#d02f2f;--wb-c6:#e07b00;--wb-c7:#c9a400}
     @media (prefers-color-scheme: dark){svg.wb-board{--wb-bg:#1e1e1e;--wb-c0:#e6e6e6;--wb-c1:#43c17c;--wb-c2:#3ab5b5;--wb-c3:#62a0ef;--wb-c4:#b07ce8;--wb-c5:#ef6363;--wb-c6:#f09b3c;--wb-c7:#d9bc3f}}
     svg.wb-board:not(.wb-fixed){background:var(--wb-bg,#ffffff)}
     svg.wb-board.wb-fixed{background:#ffffff}
     svg.wb-board:not(.wb-fixed) .wb-bg{fill:var(--wb-bg,#ffffff)}
     svg.wb-board:not(.wb-fixed) .wb-c0:not(text){stroke:var(--wb-c0,#1a1a1a)}
     svg.wb-board:not(.wb-fixed) text.wb-c0{fill:var(--wb-c0,#1a1a1a)}
     svg.wb-board:not(.wb-fixed) .wb-f0{fill:var(--wb-c0,#1a1a1a)}
     svg.wb-board:not(.wb-fixed) .wb-c1:not(text){stroke:var(--wb-c1,#1f9d55)}
     svg.wb-board:not(.wb-fixed) text.wb-c1{fill:var(--wb-c1,#1f9d55)}
     svg.wb-board:not(.wb-fixed) .wb-f1{fill:var(--wb-c1,#1f9d55)}
     svg.wb-board:not(.wb-fixed) .wb-c2:not(text){stroke:var(--wb-c2,#0f8f8f)}
     svg.wb-board:not(.wb-fixed) text.wb-c2{fill:var(--wb-c2,#0f8f8f)}
     svg.wb-board:not(.wb-fixed) .wb-f2{fill:var(--wb-c2,#0f8f8f)}
     svg.wb-board:not(.wb-fixed) .wb-c3:not(text){stroke:var(--wb-c3,#1f6fd0)}
     svg.wb-board:not(.wb-fixed) text.wb-c3{fill:var(--wb-c3,#1f6fd0)}
     svg.wb-board:not(.wb-fixed) .wb-f3{fill:var(--wb-c3,#1f6fd0)}
     svg.wb-board:not(.wb-fixed) .wb-c4:not(text){stroke:var(--wb-c4,#8a3fd1)}
     svg.wb-board:not(.wb-fixed) text.wb-c4{fill:var(--wb-c4,#8a3fd1)}
     svg.wb-board:not(.wb-fixed) .wb-f4{fill:var(--wb-c4,#8a3fd1)}
     svg.wb-board:not(.wb-fixed) .wb-c5:not(text){stroke:var(--wb-c5,#d02f2f)}
     svg.wb-board:not(.wb-fixed) text.wb-c5{fill:var(--wb-c5,#d02f2f)}
     svg.wb-board:not(.wb-fixed) .wb-f5{fill:var(--wb-c5,#d02f2f)}
     svg.wb-board:not(.wb-fixed) .wb-c6:not(text){stroke:var(--wb-c6,#e07b00)}
     svg.wb-board:not(.wb-fixed) text.wb-c6{fill:var(--wb-c6,#e07b00)}
     svg.wb-board:not(.wb-fixed) .wb-f6{fill:var(--wb-c6,#e07b00)}
     svg.wb-board:not(.wb-fixed) .wb-c7:not(text){stroke:var(--wb-c7,#c9a400)}
     svg.wb-board:not(.wb-fixed) text.wb-c7{fill:var(--wb-c7,#c9a400)}
     svg.wb-board:not(.wb-fixed) .wb-f7{fill:var(--wb-c7,#c9a400)}
   </style>
   ```

3. **Map every colour to a slot.** List the distinct colours the file uses,
   then assign each a role, the same role for the same colour everywhere:
   - **Paper** — white and near-white backgrounds (a canvas rectangle, the
     inside of boxes that are meant to read as paper): class `wb-bg`. White
     text or white strokes drawn on a coloured shape are also `wb-bg`, which
     keeps them legible on the themed shape.
   - **Ink** — black, near-black and dark-grey lines and text: slot 0.
   - **The diagram's main colour** (the hue used most, or the brand colour):
     slot 1. Its second colour: slot 2. Its third: slot 3.
   - **Mid greys and muted labels**: slot 4.
   - **A darker shade of the main colour**: slot 5. Any further hues: 6 and 7.
   - **Colours that carry meaning** — a red error path, a green success
     branch, a traffic-light legend — get **no class at all** and keep their
     literal colour, so the meaning survives every theme. Say which ones you
     left alone and why.
4. **Apply the classes.** On each element: stroke-painted → `wb-cN`;
   fill-painted shape → `wb-fN`; `<text>` → `wb-cN` (text is painted by fill;
   the `text.wb-cN` rule handles it, and its `<tspan>`s inherit); a `<tspan>`
   with a colour of its own → `wb-fN`; an element with a fill in one slot and
   a stroke in another → both, e.g. `wb-f1 wb-c0`. Arrowheads
   and other `<marker>` contents take the class of the line they belong to.
   Keep the literal `fill="…"` / `stroke="…"` presentation attributes.
5. **Get colours out of the way of the classes.** The class rules only beat
   presentation attributes and plain class selectors, so:
   - move every colour out of inline `style="fill:…; stroke:…"` attributes
     into `fill="…"` / `stroke="…"` presentation attributes (inline styles
     would win over the palette rules and block theming);
   - remove colour declarations from the file's own `<style>` rules, or move
     them onto the elements as presentation attributes; never use
     `!important`;
   - leave `none`, `transparent`, `currentColor`, `url(#…)` paints, opacity
     values, gradients (`stop-color`) and filters exactly as they are.
6. Do not change `viewBox`, sizes, ids, text, paths, transforms or fonts. The
   file must stay well-formed XML.

## Part 3 — check and report

- Open each SVG in a browser: it should look like the original in light mode
  and switch to the dark fallback palette when the OS is dark.
- Open the deck in the app (Split or Present) and change the theme: slides
  and diagrams should recolour together, and the Marp theme's layout must be
  unchanged.
- Report per file: the colour → slot table, the colours left literal and why,
  and anything you could not map.
