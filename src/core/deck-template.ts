/**
 * deck-template.ts — the example Marp presentation the app hands out.
 *
 * Two doors lead to the same text: the "New › Marp presentation" rows (the
 * explorer's directory menu, the new-tab picker, the command palette) write
 * it as a fresh file to be overwritten, and the `marp-decks` workspace module
 * seeds it as `decks/example-deck.md`, the reference the module's directive
 * points agents at. One text, so the conventions a person reads and the
 * conventions an agent copies cannot drift apart.
 *
 * The deck is its own instructions: every slide demonstrates the thing it
 * explains, and every claim in it is about THIS app's deck surfaces (Split,
 * Edit, Present, the presenter window, Export…) — keep it true when those
 * change. It must satisfy `isMarpDocument` (the frontmatter is the whole
 * detection) and render with Marp's built-in `default` theme, which is what
 * the tests pin.
 */

/** The file name a "New › Marp presentation" gets before its `uniquePathIn` suffix. */
export const DECK_TEMPLATE_BASENAME = 'presentation';

/** Where the `marp-decks` workspace module seeds the reference copy. */
export const EXAMPLE_DECK_PATH = 'decks/example-deck.md';

export const EXAMPLE_DECK = `---
marp: true
theme: default
paginate: true
---

<!-- _class: lead -->
<!-- _paginate: false -->

# Your presentation

A slide deck written in plain markdown

<!--
Speaker notes live in HTML comments like this one. They show under each
slide in Present mode and in the presenter window, never on the slide.
-->

---

## How this file works

- The \`marp: true\` line at the top turns this markdown file into a deck
- A line with only \`---\` starts a new slide
- Everything else is ordinary markdown: headings, lists, **bold**, \`code\`, tables, images
- Delete these slides when you are ready and write your own

---

## Viewing and presenting

- **Split** (Ctrl+2) — the text beside the slides, updating as you type
- **Edit** (Ctrl+3) — a filmstrip and the rendered slide: click any text and type, drag slides to reorder
- **Present** (Ctrl+4) — full-size slides with your notes; **F11** starts the show
- **Presenter view** (the button beside Present, at the bottom) — notes, the next slide and a timer

---

<!-- _class: invert -->

## Settings for one slide

A comment at the top of a slide changes only that slide:

- \`<!-- _class: invert -->\` — this slide (\`lead\` centres a title slide in the gaia theme)
- \`<!-- _backgroundColor: #123456 -->\` and \`<!-- _color: white -->\`
- \`<!-- _paginate: false -->\` hides the page number

Without the underscore (\`<!-- class: invert -->\`) the setting applies from that slide onwards.

---

## Images

- \`![](diagram.svg)\` — a picture in the slide; keep the file next to this one
- \`![bg](photo.jpg)\` — fills the background; \`![bg right:40%](photo.jpg)\` splits the slide
- \`![w:400](chart.png)\` — sets the width

A drawing made in this app (**New › Vector drawing**) works here too and follows the app's colour theme.

---

## Next steps

1. Change \`theme: default\` to \`gaia\` or \`uncommon\`, or to \`./brand.css\` for your own stylesheet next to this file
2. **Export…** writes a standalone HTML file that presents in any browser
3. Full syntax: https://marpit.marp.app/markdown
`;
