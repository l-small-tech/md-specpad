# Keyboard shortcuts

On Mac, use **Cmd** wherever **Ctrl** is shown (except F2, F11, and Esc,
which are the same everywhere).

## Tabs

| Shortcut | What it does |
| --- | --- |
| Ctrl+N | New window, with one empty note in it (a new tab is the `+` button, or Ctrl+Shift+N to pick its type) |
| Ctrl+Shift+N | New tab menu — pick the type explicitly |
| Ctrl+W | Close the current tab |
| Ctrl+Tab | Next tab |
| Ctrl+Shift+Tab | Previous tab |
| F2 | Rename the current tab (and its file) |

## Files

| Shortcut | What it does |
| --- | --- |
| Ctrl+O | Open a file |
| Ctrl+S | Save (on a note tab: Save As) |
| Ctrl+Shift+S | Save As |

## Editing (Raw and Split modes)

| Shortcut | What it does |
| --- | --- |
| Enter (on a list line) | Continue the list with a new bullet/number |
| Tab (on a list line) | Indent one level, with any nested items below it |
| Shift+Tab (on a list line) | Un-indent one level, with any nested items below it |
| Ctrl+Shift+[ / Ctrl+Shift+] (Mac: Cmd+Alt+[ / ]) | Collapse / expand the section under the caret (with **Collapsible headings** on in Settings) |
| Ctrl+Alt+[ / Ctrl+Alt+] | Collapse / expand every section |

Indenting works like a word processor. Bullet markers change with depth — `*` at
the left margin, `-` one level in, `+` two levels in, then repeating — so
un-indenting a nested `- item` twice brings back `* item` at the margin. Ordered
lists are renumbered as you go: nesting an item restarts it at `1.` and closes
the gap it left behind. (Markdown has no letter numbering, so nested ordered
lists stay numeric.) The first item at any depth has nothing to nest under, so
Tab leaves it where it is.

## Viewing modes

| Shortcut | What it does |
| --- | --- |
| Ctrl+1 | Raw — plain markdown text |
| Ctrl+2 | Split — text and preview side by side |
| Ctrl+3 | Edit — word-processor style |
| Ctrl+4 | Review — read-only, full-width |

A tab only offers the modes its file type has, and a chord aimed at one it
lacks does nothing: a drawing has Raw, Split (the SVG source beside the board)
and Draw, a code file has Raw and Review, a slide deck has Raw, Split and
Present. Draw has no digit of its own — use the status bar, or *Mode: Draw*
in the command palette.

## Display

| Shortcut | What it does |
| --- | --- |
| Ctrl+= | Larger text |
| Ctrl+- | Smaller text |
| Ctrl+0 | Reset text size |
| F11 (Mac: Ctrl+Cmd+F) | Full screen — the window fills the screen, the interface stays as it is; F11 or Esc to leave |
| P (during a slide show) | Presenter view — notes, next slide and a timer in a second window |

## Terminal tabs (desktop only)

A focused terminal gives almost every key to the program running in it — so
Ctrl+S, Ctrl+O and Ctrl+1…4 go to the shell, not to the app. These are the
exceptions.

| Shortcut | What it does |
| --- | --- |
| Ctrl+Shift+C / Ctrl+Shift+V | Copy / paste |
| Ctrl+C | Copies **only when text is selected** — otherwise it interrupts, as usual |
| Ctrl+Shift+A | Select everything on screen |
| Ctrl+Shift+K | Clear the scrollback |
| Ctrl+Shift+D / Ctrl+Shift+E | Split the pane right / down |
| Ctrl+Shift+X | Close the pane (the last one closes the tab) |
| Ctrl+Shift+[ / Ctrl+Shift+] | Previous / next pane |
| Shift+PageUp / Shift+PageDown | Scroll back a page |
| Ctrl+Shift+↑ / ↓ | Scroll back a line |
| Ctrl+Shift+Home / End | Jump to the top / bottom of the scrollback |
| Ctrl+= / Ctrl+- / Ctrl+0 | Zoom this pane only |

Still available from a terminal: new window (Ctrl+N), the new-tab picker
(Ctrl+Shift+N), close tab, next/previous tab, rename tab, Settings, the
command palette, the Git tab (Ctrl+Shift+G), and full screen.

## Drawing tabs (whiteboards)

These work while the board has focus — click or tap it first. Single letters
switch tools; none of them fire while you are typing text on the board.

| Shortcut | What it does |
| --- | --- |
| V / P / H / E / T | Select / Pen / Highlighter / Eraser / Text |
| R / O / L / A | Rectangle / Ellipse / Line / Arrow |
| Ctrl+A | Select everything |
| Ctrl+C / Ctrl+X / Ctrl+V | Copy / cut / paste the selection — each repeated paste lands a little further along, and a copy can be pasted onto another board (or, as SVG, into other apps) |
| Ctrl+D | Duplicate the selection |
| Ctrl+G / Ctrl+Shift+G | Group / ungroup the selection (selecting any member selects the group) |
| Ctrl+] / Ctrl+[ | Bring forward / send backward |
| Ctrl+Shift+] / Ctrl+Shift+[ | Bring to front / send to back |
| Arrow keys | Nudge the selection one pixel (Shift: ten) |
| Delete / Backspace | Delete the selection |
| Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) | Undo / redo |
| Esc | Drop the selection, or cancel what you were typing |
| Space (held) | Pan with the mouse |
| G | Show or hide the grid (each board remembers its own) |
| Shift (while dragging a shape) | Keep it square / circular; a line snaps to 45° |
| Alt (while dragging) | Ignore snapping for that drag — the grid and the guides both |
| Enter / Ctrl+Enter (typing text) | New line / finish |

Right-click the board for the same commands as a menu, plus align and
distribute. Double-click a shape to label it — the words stay centred in it
when it moves or resizes.

With the grid on, shapes, moves, resizes and text land on it; whatever the
grid says, things also line up with other shapes' edges and centres, and a
thin line shows what they lined up with. Freehand ink never snaps. The grid's
spacing and its snap toggle are behind the ⌄ next to the grid button.

A line or arrow that starts or ends on a shape stays attached to it and
follows it around; select the arrow and drag either end to move it to another
shape or off into open space. Straight or elbow routing is in the shape-style
menu (◧) and the right-click menu. The whole drawing toolkit is described in
[Drawings and diagrams](diagrams.md).

## Everything else

| Shortcut | What it does |
| --- | --- |
| Ctrl+K | Command palette — type to search every command |
| Ctrl+Shift+O | Toggle the outline panel (jump between headings) |
| Ctrl+, | Open Settings |
| Ctrl+F | Find within the note (Raw and Split modes) |
| Ctrl+Shift+F | Search across all workspaces — click a result to jump to it |
| Ctrl+Shift+G | Git: source control — the git tab for the repository around the current tab (desktop only) |
| Esc | Close Settings / the command palette / put away a side pane opened while distraction-free, leave distraction-free, then full screen |

A few mouse tricks worth knowing: middle-click a tab to close it,
double-click a tab name to rename it, drag tabs to reorder them, and
right-click tabs, files, and workspace headings for their menus.
