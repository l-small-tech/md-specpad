# Changelog

Every tagged release gets a short, high-level entry here: the handful of
improvements a user would want to know about, not an inventory of commits.
The release workflow copies the tagged version's section into the GitHub
release notes and refuses to build a tag that has none.

Keep an `## [Unreleased]` section at the top while working; rename it to
`## [X.Y.Z] — YYYY-MM-DD` when bumping the version.

## [Unreleased]

## [0.11.0] — 2026-10-07

- Git tab: **Start tracking with Git** turns a plain workspace folder into a
  repository from the tab itself, and a first commit on a fresh computer asks
  for your name and email in the commit box (saved to your global git config).
- Git tab: **connect to GitHub, Gitea or any host** — paste the repository's
  address (the page URL works too) and Publish uploads your branch; a server
  repository that already has a README is brought in first. The cloud button
  lists, edits and removes connections.
- Git tab: **Push shows a progress bar** with a plain-language step; **Show
  log** opens git's own output.
- Git tab: the inspector column follows the graph selection, and a dashed
  **ghost row** at the top of the history stands for your uncommitted changes.
- Git tab: an **Active worktrees only** filter hides clean worktrees from the
  strip, and a status-bar button shows or hides the workspace pane.
- Heading marks tint the whole section under the heading; picking the same mark
  again clears it.
- The app only ever *opens* a harness: the Themes menu's **Open harness here**
  and the Help menu's **Open harness in docs** start it in a folder with no
  prompt or flags. The old "AI theme" row is gone.
- **Fixed: Save As on a note could delete the file it had just saved.** Saving
  a note under its own name in the notes folder now keeps the file; no flush
  ever deletes a file that is open in a tab or being written.
- **Fixed: typing during a slow save could be lost.** A save now marks only the
  text it actually wrote as saved, so anything typed meanwhile stays unsaved
  and is written next.
- **Fixed: a note whose rename failed could be overwritten** by a new note
  given the same title.
- **Fixed: a save that keeps failing no longer locks up the app.** Tearing off
  or moving a tab, and restarting for an update, stop with a notice instead of
  retrying forever; nothing moves until the work is saved.
- **Fixed: Discard in the Git tab could delete a file.** Discarding the edits
  to a staged new or renamed file now keeps its staged version; only an
  untracked file is deleted, and the confirm says so.
- **Fixed: Remove worktree closed its terminals before git refused.** A
  worktree with uncommitted changes is now refused up front, before anything
  is closed.
- **Fixed: removing a synced (Android) workspace discarded unsaved edits**
  without asking; its tabs now close through the usual save prompt.
- **Fixed: CRLF files turned LF on the first edit in Raw mode**, and a saved
  caret could stop Raw mode opening at all.
- **Fixed: imported SVG drawings lost attributes on the second save.** The
  Imported layer is now kept exactly as written.
- **Fixed: PDF export failed on a table with a short row**; PDF and DOCX now
  pad short rows like the preview.
- **Fixed: AltGr characters in the terminal.** On German, French and other
  AltGr layouts, `@ { [ ] } \ | ~ €` reach the shell as text instead of escape
  codes. In the Raw / Split editor every AltGr character is typed —
  AltGr+ß no longer re-indents the line instead of typing `\`, and AltGr
  brackets no longer fold every section.
- **Fixed (macOS): Ctrl+Tab / Ctrl+Shift+Tab switch tabs**, and torn-off
  windows get the same title bar and resizable edges as the main window.
- **Fixed (Windows/Linux): the window edges resize again.**
- **Fixed: offline dictation in installed builds.** The audio capture module
  no longer loads from a source the app's security policy blocks.

## [0.10.6] — 2026-10-06

- **Collapsible headings** (Settings, off by default): Raw and Split modes get a fold gutter so any heading's section can be collapsed like a function in a code editor, and a heading marked running collapses by itself.
- Git tab: a ⤢ button at the right of the worktree cards goes distraction-free, as on a document. The status bar with the branch picker and Fetch / Pull / Push stays; Esc or the top-edge cluster brings the tab bar back.
- **Fixed: no spelling suggestions on headings (Windows).** Right-clicking a heading used to swap the usual menu for the Mark running / Mark complete one, which hid the spell checker's suggestions. The mark items now sit at the bottom of the usual menu, so you get both.

## [0.10.4] — 2026-10-05

- Git tab: the three Staged / Changes / Untracked lists are now one list of every file changed since the last commit, with a checkbox per row that shows and sets whether it is staged. The commit box sits above the list so it never gets pushed down.
- Git tab: the history graph keeps the checked-out branch and the base branch in the two leftmost lanes, so main no longer drifts to the far right behind feature lines.

## [0.10.3] — 2026-10-05

- **Fixed: Raw mode lost its margins, highlighting, scrolling and your
  colour theme in the installed 0.10.2.** The boot splash's inline styles
  made Tauri tighten the app's Content Security Policy, which then blocked
  every stylesheet the editor and theme plugins add at runtime (dev builds,
  with no CSP, never showed it). The splash styles now ship as a linked
  stylesheet, and a test keeps `index.html` free of inline styles.
- Status-bar mode buttons, the git tab's controls and the review-notes
  filter buttons are no longer selectable as text.

## [0.10.2] — 2026-10-05

- **MD Notepad is now MD Specpad.** New name, new home:
  [github.com/l-small-tech/md-specpad](https://github.com/l-small-tech/md-specpad)
  (old links redirect). On first launch on desktop, your notes, sessions,
  settings, themes and Whisper models move over from the MD Notepad folder
  automatically. The update installs as **MD Specpad** next to the old app,
  so uninstall MD Notepad afterwards. On Android, MD Specpad installs as a
  separate app: move any notes you want to keep, then uninstall MD Notepad.
- **Visual Git.** The Git tab is redrawn around a picture of the repository:
  a commit graph of every branch with coloured lanes and branch, remote, tag
  and worktree pills on the commits; worktree cards across the top (click
  one to show that checkout; each shows its branch, what is dirty, and how
  far it is ahead of or behind the base); and the branch picker with Fetch,
  Pull and Push in the status bar, where the mode buttons would otherwise
  sit. Click a branch pill for switch / merge / delete.
- **Show hidden files.** The eye button in the Workspaces header (or
  right-click a folder → *Hidden Files*) reveals hidden files and folders
  such as `.github` or `.obsidian`. It follows each platform's rules:
  dot-names everywhere, plus the hidden attribute on Windows and the hidden
  flag on macOS.
- **Faster, visible startup with slow drives.** Restored tabs now load in
  parallel, and when a tab's file is slow to reach (a cloud drive, or a WSL
  share while WSL starts up) the window shows a loading message naming the
  file it is waiting for, instead of a blank screen.

## [0.10.1] — 2026-10-01

- **Mark headings running or complete.** Right-click a heading in Raw,
  Split or Edit mode to mark it running (⏳, amber bar) or complete (✅,
  green bar). The mark is saved in the heading text, so it travels with the
  file.
- **Prompt status removed.** The *Prompt status* workspace directive, the
  strip above `*.prompts.md` notes and the Workspace status panel are gone.
  Re-running **Workspace directives…** on a workspace removes the old
  section from its `AGENTS.md`; `.notepad/status.py` and
  `prompts/STATUSES.md` are left for you to delete.
- **Audio player.** MP3, WAV, M4A, AAC, OGG, Opus and FLAC files show in the
  explorer and open in their own tab. The tab has a waveform you click or drag
  to seek, playback speed, looping, and the file's format, length, sample rate
  and loudness. **Transcribe to note** runs the recording through the offline
  Whisper model and opens the text as a new note.
- **TODO list directive.** Initialize workspace can now add a shared `TODO.md`
  checklist that agents read, tick off and add follow-ups to.
- **Git tab in folders git won't trust.** Opening Git on a repository owned
  by another account (an admin-created folder, an exFAT or network drive) no
  longer just fails with "dubious ownership" — it offers to trust the folder.
- **Cleaner slide shows.** Touching the screen during a full-screen Marp
  presentation no longer pops up the Workspaces button or pull tab.

## [0.10.0] — 2026-09-25

- **Prompt files.** The prompt status strip now appears only on notes named
  `*.prompts.md` (one file, one or more prompts), and `STATUSES.md` moves into
  the `prompts/` folder. Initialize workspace no longer ticks any directive by
  default.
- **Git tab.** Source control as an ordinary tab (right-click a workspace →
  **Git**, *Git: source control* in the palette, or Ctrl+Shift+G): status with
  stage / unstage / discard, commit and amend, branches, per-file diffs,
  history, fetch / pull / push, and a worktree dashboard — every checkout
  with its branch, dirty count and ahead/behind, **New worktree** in one
  click, and a guided **Finish** flow that merges, removes the worktree and
  deletes the branch. Merge conflicts are handed to your AI agent: **Copy
  conflict prompt** puts an agent-ready brief on the clipboard, the panel
  tracks the files as they come clean, and Continue / Abort finish the
  merge. The app never types into a terminal — "Terminal here" and "Harness
  here" only open one in the right folder. Desktop only.

## [0.9.2] — 2026-09-22

- **Marp presentations, from the start.** **New › Marp presentation** (a
  folder's right-click menu, the **+** picker, or the command palette) writes
  a short example deck whose slides explain the syntax and the app's Split,
  Edit, Present and presenter views. The Initialize workspace dialog gains a
  **Marp presentations** directive that tells agents how to write decks this
  app shows well, with that example deck as the reference.
- **Two ways to add a workspace.** The sidebar's **+** now asks: **Open
  existing folder…** adds a folder you already have, and **Create new
  workspace…** just asks for a name — the folder is made for you, beside
  your other workspaces (or wherever you choose) — and sets it up for AI
  agents in one go.
- **Full screen no longer glitches on Windows.** Maximizing or dragging the
  window while full screen (double-clicking the tab bar, the maximize
  button, Win+Up) used to leave a black strip where the taskbar was and a
  half-restored window on the way out; those actions are now inert or undone,
  and closing the app while full screen no longer saves the monitor size as
  the window's size for the next launch.

- **Edit mode for slide decks.** A Marp deck now has an **Edit** button
  (Ctrl+3): a filmstrip of the slides, the real rendered slide in the middle,
  and a properties panel. Drag slides to reorder them, add, duplicate or
  delete; click any heading, paragraph, list item or code block on the slide
  to change its text and watch it re-render as you type; set a slide's layout,
  colours, page number, header, footer and background image, or the whole
  deck's theme and size, from the panel; write speaker notes under the slide.
  Made for polishing a deck an AI wrote: every tweak changes only the lines
  it is about, so the rest of the file stays exactly as it was written.
- **Browse your workspace while distraction-free.** Going distraction-free
  still leaves only the document, but the Workspaces pane is now one gesture
  away: push the pointer against the left edge for a pull tab (or use the new
  folder button in the floating controls) to open it and switch files —
  handy for reading through a markdown knowledge base in Review mode. Esc
  puts the pane away before it leaves distraction-free.
- **Split mode for drawings.** A drawing tab now has a **Split** button
  (Ctrl+2) beside Raw and Draw: the `.svg` source on the left, the board on
  the right, both of them editable and each one following the other as you
  work. The two panes also point at the same thing — select a shape and its
  markup lights up in the source; put the caret on an element and that shape
  is selected on the board, ready for the ribbon's colour and style controls.
  Right-click a shape → **Reveal in source** to jump the caret there. While
  the source is mid-edit and not yet valid, the board holds the last picture
  it could read and says so, instead of blanking or overwriting your typing.
- **Initialize workspace — set a folder up for AI agents.** Command palette →
  **Initialize workspace…**: pick or create a folder, tick the directives you
  want (file manifest, changelog, lessons learned, git worktree workflow, plus
  any `.md` of your own), and the app writes an `AGENTS.md` — with `CLAUDE.md`
  and `GEMINI.md` pointing at it — that the agent in your own terminal reads.
  Right-click a workspace → **Workspace directives…** to add or remove
  directives later; your own text and filled-in files are never overwritten.
- **Notes as prompts, with live status.** In an initialized workspace a strip
  above each note offers **Copy as prompt** for the section you are in. Paste
  it into your agent; it reports back through `STATUSES.md`, and the note shows
  a chip — Queued, Running, Needs input, Done, Failed — with a one-line
  summary. **Workspace status** in the palette lists every prompt.
- **Two views of one file, in sync as you type.** Right-click a file's tab →
  **Duplicate tab** (or **Duplicate in new window**) for a second view of the
  same file: Markdown in one, Present, Review or Draw in the other. Edits show
  up in the other view as you type — no more pressing Reload — and saving
  either one saves both. The Reload banner is still there for changes made
  outside the app.
- **Presenter view for slide decks.** Right-click a deck's tab → **Presenter
  view** (or press **P** during the show): a second window with the current
  slide, the next slide, your speaker notes, a clock and a timer. Put it on
  your laptop screen and press F11 on the slides — both windows stay on the
  same slide, and the arrow keys work in either.
- **The file drawer is sorted by name.** Folders come first, then files, both
  A→Z regardless of capitalisation and with numbers read as numbers, so
  `note2.md` sits above `note10.md`. Files used to be listed newest-first,
  which moved rows around every time you saved.
- **Full screen and distraction-free are now two separate switches.** F11
  makes the window fill the screen and leaves the interface exactly as it is,
  like every other desktop app. The old "full window" view that hides the
  tabs, toolbar and status bar is now called **Distraction-free** (the ⤢
  button and the app menu) and works with or without full screen. Esc leaves
  distraction-free first, then full screen. On Windows 11, full screen no
  longer leaves a black strip where the taskbar was.
- **Quieter scrollbars.** Scrollbars are now a slim, translucent bar tinted to
  your theme that appears while you scroll and fades away when you stop, in
  the style of Windows Terminal. Hover it to grab it.
- **Slide decks stand out in the file tree.** A Marp presentation now shows a
  purple *marp* badge in the Workspaces pane instead of the ordinary *md* one.
- **Ctrl+N opens a new window.** A fresh window with one empty note, instead
  of another tab in the current one. The tab bar's "+" and the command
  palette's "New tab" still add a tab here; Ctrl+Shift+N still picks a type.
- **Empty notes explain themselves.** A brand-new note shows ghost text — how
  notes save, what Ctrl+S does, and a one-glance markdown cheat sheet — that
  disappears at the first keystroke.
- **Diagram editor.** Whiteboards are for drawing diagrams now, not just
  sketching on. Five new shapes — diamond, triangle, parallelogram, hexagon and
  cylinder — join rectangles, rounded rectangles, ellipses, lines and arrows in
  a shape menu that keeps the ribbon the same size and remembers the shape you
  last used. Shapes can be filled (including with the board's own colour, so a
  box hides what is behind it on a light or a dark board), dashed or dotted,
  and arrows can have a head at either end or both. Holding Shift while
  dragging keeps a shape square and a line at 45°. With something selected, the
  colour, width, fill, dash and arrow-head controls restyle it instead of only
  setting what comes next — and they show what the selection currently is.
  Diagrams can now be arranged, too: copy, cut, paste and duplicate (Ctrl+C /
  X / V / D — a copy pastes onto another board, or into other apps as SVG),
  bring forward and send back (Ctrl+] / [), align and distribute from the
  board's new right-click menu, and group things so they select and move
  together (Ctrl+G). Double-click a shape to give it a label that stays
  centred as the shape moves and resizes. There is a grid, too (G, or the ⊞
  button — each board remembers its own spacing and whether it snaps), and
  things line up with each other whether or not the grid is on: drag a box
  near another one's edge or centre and it lands on it, with a thin line
  showing what it lined up with. Hold Alt to ignore all of that for one drag;
  freehand ink never snaps. And lines and arrows are live connectors: start
  or end one on a shape and it sticks — to the middle of a side, or aimed at
  the centre — and follows the shape when it moves or resizes, landing on the
  drawn edge of an ellipse or a diamond rather than the box around it. Select
  an arrow to drag either end onto another shape (or off it); pick "Elbow" in
  the style menu or the right-click menu for right-angled routing. Deleting a
  shape leaves its arrows where they were. Single-letter hotkeys pick tools
  (V, P, H, E, T, R, O, L, A) — see `docs/keyboard-shortcuts.md` and the new
  `docs/diagrams.md`. Everything still saves as a plain `.svg` that renders
  the same anywhere.

- **Help… menu and Prompts.** The ⌄ menu beside the + button gains a Help…
  page: the user guide, the shortcuts page, and **Prompts** — ready-made
  briefs an AI agent can act on, copied to the clipboard with one click. The
  first prompt converts a Marp deck and its SVG diagrams to follow the app
  theme; decks now bake the theme into whiteboard-style SVGs the way the
  markdown preview does, and re-bake them when you switch themes.
- **Marp slide decks.** A markdown file with `marp: true` in its frontmatter
  is a slide deck: Split shows the slides beside the text (the one under your
  cursor highlighted), the Review mode becomes **Present** — a light table of
  slides with your speaker notes under each — and F11 twice runs the show:
  one slide on a dark screen, keyboard driven, Esc back to where you were.
  The status bar counts slides and estimates the talk length, and Export…
  writes a standalone HTML deck. Themes from the Marp built-ins or a CSS file
  kept next to the deck.

## [0.8.1] — 2026-09-15

- **Switching modes keeps your place in the file.** Flipping between Raw,
  Split, Review and Edit now lands you where you were reading instead of
  jumping back to the top — it carries the line at the top of the screen
  across. For a code file in Review it lands on the card for that line.

- **"Rich" mode is now called "Edit".** The word-processor view for markdown
  files keeps the same Ctrl+3 shortcut and behaviour — only the name in the
  status bar, the command palette and Settings changes.

- **Cut, copy and paste files and folders in the workspaces pane.** Right-click
  any row for Cut / Copy, then Paste into a folder or workspace header — or use
  Ctrl+X, Ctrl+C and Ctrl+V on the selected row, as in VS Code and File
  Explorer. A cut row dims until you paste it; a copy lands as "name copy" when
  something with that name is already there, and can be pasted into as many
  folders as you like. Whole folders come along with everything inside them.

- **Copy a folder's path.** "Copy path" is now on folder and workspace
  right-click menus too, not just files.

- **Right-click menus near the bottom of the workspace pane stay whole.** A
  menu that would run off the bottom of the window now opens upwards (and
  scrolls if it is taller than the window) instead of being cut off.

- **Review notes live in the document.** The Review-mode button is now
  "Review notes" (they are typed on desktop and spoken on the phone). Press
  and hold a line and the note box opens right under it, like a comment in
  a word processor — no side panel. Every paragraph or code card that
  already has a note shows a marker in the margin; tap it to read, edit or
  delete the notes right there, and a saved note opens where it landed.

- **See all review notes.** A new "All notes" button beside the toggle (and
  a palette command) opens an overview of every note across your
  workspaces — newest first or grouped by document, searchable, scoped to
  the current document if you like. Edit a note in place, delete it, or
  "Go to" it: the document opens in Review mode scrolled to the note.
  Works as a side panel on desktop and a full-screen sheet on a phone.

- **Review notes are typed on desktop.** The note box is a text field with
  a Save button; use Win+H (Windows) or the Dictation key (macOS) to talk
  into it, or tap the microphone to dictate offline with Whisper. If Whisper
  isn't installed yet, the microphone is an Install button that downloads
  the model right there. The phone keeps voice first, with a text field too.

- **Voice typing.** A microphone in the ribbon in Raw, Split and Rich modes
  types what you say at the cursor — Windows voice typing, offline Whisper,
  or the phone's recognizer, the same engines as Review's voice notes.

- **Read mode is now Review.** The fourth mode (Ctrl+4) is called Review for
  every file type, matching the code view.

- **Whisper everywhere, and faster.** Offline dictation now runs on the GPU
  (Vulkan on Windows and Linux, Metal on macOS — several times faster, with
  a switch in Settings to force the CPU), works on Android as an alternative
  to the device's recognizer, and offers to download its model on first
  launch so it is ready before the first voice note. The model list is four
  compact files (Tiny, Base, Small, Large v3 Turbo); an earlier version's
  full-precision downloads are migrated and can be removed from Settings.
- **Review mode for code files.** Open a `.ts`, `.tsx`, `.js` or `.rs` file
  and press Ctrl+4 to see it as plain-English cards instead of syntax: one
  card per declaration, forms for types, an x-ray-folded Code expander,
  Flow and Calls diagrams, and a *What changed* view against a git
  baseline.
- **Voice notes.** In Review mode (and on code Review cards) press and hold and
  dictate; the note lands in a `.comments.md` sidecar the document never
  sees, ready for an agent to act on. Windows voice typing on Windows,
  offline Whisper on macOS/Linux (downloadable models, no audio saved),
  native recognizer on Android. Spoken identifiers snap to real names.
- **Live edit.** Mark a shared folder and open files merge outside changes
  as they land; a lost collision flashes red and offers *Restore mine*.
- **Explorer:** show or hide unsupported files per workspace or folder.
- Windows 11: launching from an empty virtual desktop opens the window
  there.

## [0.7.3] — 2026-09-02

- **Terminal tabs follow the shell.** Shell integration reports `cd`, so a
  terminal tab takes its workspace's color, and right-click helpers
  (*Change directory…*, *List files*, *Open Claude*) type the real command
  for you.
- **Harness detection and install.** Settings shows which AI agents
  (Claude Code, Copilot, opencode) are installed and offers to install the
  missing ones; light themes made readable for agent TUIs.
- **Settings** reorganized into tabs, with *Update now* and a weekly
  automatic update check.
- Whiteboard fixes: overlay opacity, vanishing strokes, and boards that
  blend into the surface they sit on; right-click a board image to switch
  its theme.
- File explorer: cross-workspace moves and case-only renames on cloud
  volumes.

Earlier releases are described on the
[GitHub Releases](https://github.com/l-small-tech/md-specpad/releases) page.
