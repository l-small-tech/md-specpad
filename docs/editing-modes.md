# The viewing modes

Every markdown tab can be viewed four ways; code files get Raw and Review, a
Marp slide deck gets Raw, Split and Present, and a drawing gets Raw, Split and
Draw. Switch with the buttons at the bottom-left of the window, or with
**Ctrl+1** to **Ctrl+4** (Cmd on Mac). Each tab remembers its own mode.

## Raw (Ctrl+1)

Just your text, with the markdown symbols visible and gently colored. This
is the fastest, most precise mode — what you see is exactly what's in the
file. Press **Ctrl+F** here to search within the note.

## Split (Ctrl+2)

Raw text on the left, the finished result on the right, updating live as
you type. Great while you're learning markdown, or for documents with
tables and diagrams. Drag the divider between the panels to resize them.

On a **drawing tab** Split means the `.svg` source beside the board itself,
both of them editable and each pointing at whatever the other has selected —
see [Drawings and diagrams](diagrams.md).

## Edit (Ctrl+3)

A word-processor-style view: no markdown symbols, formatting appears as you
apply it, and a small toolbar pops up when you select text. Behind the
scenes it's still the same markdown file.

Two honest caveats about Edit mode:

- **Your first edit may tidy the markdown's spelling.** Markdown allows
  several ways to write the same thing (`*` or `-` for bullets, for
  example). Edit mode rewrites the text using its preferred style the first
  time you edit — the *content* never changes, only the symbols. The app
  shows a one-time reminder when this could happen. If the exact symbols
  matter to you, edit in Raw or Split mode.
- **Diagrams show as code.** Mermaid diagrams (see
  [Writing markdown](writing-markdown.md)) only render in Split and Review
  modes.
- **No YAML front matter.** A note that starts with a `---` block of
  `key: value` lines (the kind Obsidian and static-site tools add) is shown
  in Edit mode as a heading, and the first edit rewrites it. Edit such notes
  in Raw or Split mode. (Marp decks are the exception — their front matter is
  what makes them a deck.)

Also note: undo history doesn't carry across a switch between Edit and the
other modes.

## Marking headings (running, focus, backburner, complete)

In Raw, Split or Edit mode, right-click any heading (`#` through `######`)
and open **Mark heading**: **Running**, **Focus**, **Backburner**,
**Complete** or **Clear mark**. Handy for keeping track of which sections of
a plan or task list are under way, parked or done. On Windows the submenu sits
at the bottom of the usual right-click menu, so spelling suggestions for a
misspelled heading word still show. With text selected, right-clicking
anywhere in the selection marks the heading at its top, if it starts with one.

Each mark gets a bar down the left edge of the heading and everything under
it, sub-headings included, as one unbroken band: blue for running, purple for
focus, yellow for backburner, green for complete. Only one heading in a file
can be the focus — marking another one moves the focus there. The mark is
saved in the file itself, as a ⏳, 🎯, 💤 or ✅ at the end of the heading — so
it shows in the preview, survives switching modes, and anyone (or any AI
agent) reading the file sees it too. Deleting the emoji by hand clears the
mark just the same.

With **Collapsible headings** turned on in Settings, a heading collapses by
itself the moment it is marked running — in Raw and Split modes, which show a
fold gutter beside the text so any heading's section can be collapsed and
opened by hand too. See [Settings](settings.md).

## Review (Ctrl+4)

The polished result, full-width, with nothing editable — ideal for actually
*reading* a finished note. In Review mode the toolbar swaps to reading tools:

- **A− / A+** — text size (also Ctrl+`-` / Ctrl+`=` anywhere, Ctrl+0 to
  reset).
- **⤢ Distraction-free** — hides all the app chrome (tabs, toolbar, status
  bar) and shows only the document. The window itself stays where it is.
  **Esc** brings the chrome back.
- **Full screen** (**F11**; Ctrl+Cmd+F on Mac) — makes the window fill the
  whole screen and changes nothing else: the interface stays exactly as it
  was. Press **F11** or **Esc** to leave. It is also in the **⌄** app menu.

The two are independent — use either on its own, or both together for a
document and nothing else on a bare screen. Both work in every mode,
including drawings. Once the chrome is hidden, there are two ways back:

- **Mouse and keyboard** — move the pointer to the top of the window for the
  floating controls (full screen on/off and an exit), or press **Esc**.
- **Changing files without leaving** — reading a folder of notes means moving
  between them, so the **Workspaces** pane stays within reach: push the
  pointer against the **left edge** of the window and a small folder tab
  slides out — click it to pull the pane out (the floating controls have the
  same folder button). Pick a file and carry on; **Esc** puts the pane away
  first, and a second **Esc** leaves distraction-free.
- **Touch or pen** — press and hold anywhere for a moment. A small menu
  appears with **Exit distraction-free**, **Workspaces** and **Outline**. On
  a drawing, the hold that opens the menu doesn't leave a mark.

How wide the text column is in Review mode is up to you — see **Review mode
margins** in [Settings](settings.md).

## Present (Ctrl+4, slide decks)

A markdown file whose first lines are

```
---
marp: true
---
```

is a [Marp](https://marp.app) slide deck, and the app treats it as one
without any extra step. The quickest start is **New › Marp presentation**
(right-click a folder in the sidebar, the **+** button's picker, or the
command palette): it writes a short example deck whose slides explain the
syntax, ready to be overwritten. Slides are separated by `---` lines; a Marp
theme (`theme: gaia` in that same header, or `theme: ./brand.css` for a
stylesheet kept next to the file) decides how they look. A deck offers these
modes:

- **Raw** — the text, as for any markdown file.
- **Split** — the text on the left and the slides on the right. The slide
  under your cursor gets a coloured border and stays in view as you type.
- **Present** — replaces Review: a light table of full-size slides, numbered,
  with your speaker notes (HTML comments in the slide, `<!-- like this -->`)
  shown quietly under each one. Review notes work here too — press and hold a
  slide. Press **F11** (full screen) and the show starts on the slide at
  the top of the light table: one slide on a dark
  screen, **arrow keys / Space / PgUp / PgDn / Home / End** to move, a number
  then **Enter** to jump, and a thin progress line along the bottom. **Esc**
  brings you back to the light table on the slide you were showing.
- **Presenter view** — right-click the deck's tab → **Presenter view** (or
  press **P** during the show, or find it in the command palette). A second
  window opens with the current slide, the next slide, your speaker notes, a
  clock and a timer (click it to pause; **Reset** zeroes it). Drag it to your
  own screen, then press **F11** in the main window for the show on the
  projector. The two stay on the same slide, and the arrow keys work in
  whichever window has focus. **A−** / **A+** resize the notes.

- **Edit** — not the word-processor view (it would rewrite the comments and
  image syntax Marp relies on) but a filmstrip beside the rendered slide:
  click a block to edit its text, drag slides to reorder, and set a slide's
  class, background and notes in the inspector. Each change touches only its
  own lines.

The status bar shows `Slide 4 / 12`
and a rough talk length instead of the line and word counts, and **Export…**
writes the deck as a standalone HTML file you can open and present in any
browser.

## Review (Ctrl+4, code files)

A code file — TypeScript/JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`,
`.cts`, `.mjs`, `.cjs`) or Rust (`.rs`) — offers two modes: **Raw**, the
plain source with syntax colouring, and **Review**, which here shows structure
instead of rendered text.
Review is read-only. It shows the file's *structure* for someone who knows
what code is but not the syntax, so you can read what an agent did and tell
it what to change next, by voice.

Every piece of the file becomes a card, in source order:

- **A plain-English sentence** for each function — "Takes a folder path, a
  list of folders, and an optional list of folders, and gives back *show*
  (yes or no) and *explicit* (yes or no)." The real signature sits under it
  in code font, and the author's doc comment under that. The sentence is a
  reading aid built from simple rules, not a specification; when it looks
  off, trust the signature.
- **Forms** for structs, interfaces, enums and classes: a table of fields,
  each with its plain-English type and its comment.
- **An imports card** at the top: what this file uses from the app and
  which packages.
- **Facts** on each card: what it calls and what calls it, its size (the
  dots), and whether it is exported.
- **Code** opens the body folded to its bones — the declarations and the
  `if` / `for` / `match` / `return` lines — with `⋯ 9 lines` markers you tap
  to open one level at a time. Short functions open in full.
- **Flow** draws one function's branches and loops as a flowchart.

Above the deck, **Cards / Calls / Changes** switch views. *Calls* draws which
functions in this file use which; tap a node to jump to its card. Chips
under the header filter the deck (All · Exported · Changed · Functions ·
Types). Any diagram opens full screen with pinch-zoom when tapped.

**Changes** needs git on the machine. The header offers a baseline — *this
branch* (against the branch it was made from), *uncommitted*, or *last
commit* — and cards carry **added**, **changed** and **removed** badges;
a changed signature says what changed ("now also takes hiddenDirs"). When
the same file is also changed on another worktree's branch, the card says
so. Without git, the header just says so and every other view works. The
branch to compare against is auto-detected (`development`, `main`, or
`master`) and can be set under **Review baseline branch** in
[Settings](settings.md).

**Voice notes work on cards.** Turn on the toolbar's voice-notes button,
press and hold a card, and dictate. The note lands in
`<file>.<ext>.comments.md` beside the file, quoting the card's signature and
naming the declaration, with the branch and baseline recorded at the top.
Spoken names snap to the real identifiers ("shows all files" becomes
`showsAllFiles`); each snap can be undone before you move on. On the
desktop, the offline Whisper engine is primed with the file's own names, so
they transcribe correctly far more often.

## Choosing a default

New tabs open in Raw mode out of the box. Pick a different default —
including Review, handy if you mostly open notes to look things up — under
**Default mode** in [Settings](settings.md).

## Two views of the same file

Right-click a file's tab → **Duplicate tab** opens a second tab on the same
file, and **Duplicate in new window** opens it in another window. Put one in
Markdown and the other in Present, Review or Draw: whatever you type in one
appears in the other straight away, and saving either saves both. (Notes that
have not been saved as a file cannot be duplicated — use **Save as…** first.)
