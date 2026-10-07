# src/ui/ — React chrome

React renders the frame around the editors — never the editors themselves.
Keep this directory small; anything smart belongs in a store or in core.

## Component inventory

| Component | Milestone | Notes |
| --- | --- | --- |
| `App` | M1 | layout shell: TabBar / EditorHost / StatusBar stack |
| `TabBar` | M1 | tabs + new-tab button; middle-click close; F2/double-click inline rename; dirty dot for file tabs (M3); drag-out tear-off + "Move to new window" (M8); workspace color cues (a tab wears its workspace's accent; `groupTabsByWorkspace` optionally keeps each workspace's tabs contiguous — rules in core/tab-workspaces.ts, resolution in ui/workspace-cues.ts); phone widths (≤640px) show only the active tab full-width + a count-pill switcher |
| `EditorHost` | M1 | THE critical component — see below |
| `StatusBar` | M1 | mode segment control, cursor pos, word count; notice area (hints, flush errors); the **Live** chip (`LiveChip`) while the active tab is in Live Edit mode — its dot pulses once per merge (keyed on `liveEditStore`'s per-tab merge count) and the tooltip carries the last merge time. Deliberately not a button: the toggle is in the Save menu |
| `ConflictBanner` | M3 | per-tab "File changed on disk — View diff / Reload / Keep mine". Never shown for a Live Edit tab: `session/conflict-probe.ts` merges instead (see "Live Edit" below) |
| `LiveEditBanner` | reference | per-tab "Another editor replaced N lines you wrote — Restore mine / Dismiss" after a Live Edit merge where disk won a collision (`liveEditStore.lost`); same shape as ConflictBanner, mounted beside it in EditorHost |
| `DiffView` | reference | read-only side-by-side diff of two texts (core/diff.ts does the comparing); shown inline in EditorHost while a conflict's "View diff" is open, reusable for the future git integration |
| `ExternalLinkPrompt` | reference | the confirm bar for a clicked `http(s)` link (non-modal, bottom centre) — see "Link policy" below |
| `SettingsDialog` | M6 | plain form over the settings store; its Voice notes tab projects `stores/whisper-models.ts` (model list, download progress) — see "Voice notes" below |
| `ExternalLinkPrompt` | reference | the "open this in your browser?" bar for a clicked external link — non-modal, self-dismissing |
| `UpdateChip` | M7 | unobtrusive "Update available → restart" affordance |
| `TerminalTab` | M9 | one terminal tab page: hosts its split tree — see I10 below |
| `TerminalPane` | M9 | one pty + engine + canvas + input; the only place src/term and src/renderer meet the app |
| `PaneTree` | M9 | places a tab's panes as keyed, absolutely-positioned SIBLINGS (nesting them would remount — and kill — a pty on every split) |
| `git/GitTab` | git | the source-control panel behind a `kind: 'git'` tab: the worktree strip on top, then the side column (conflicts, changes + commit) and the main column (the commit graph; under it, while something is selected, the detail; the output drawer at the foot), hidden with `display: none` when inactive (I7) — see "Git tab (tool tab)" below |
| `git/WorktreeStrip` | git | the header: one card per checkout (main first, then `worktrees/<slug>`) — the card IS the checkout picker; each shows branch, a stacked dirty bar (staged · changed · untracked · conflicted), ahead/behind meters against the base, terminal dot, state / missing / locked chips, and the row actions (open as workspace, terminal / harness here, diff vs base, merge either way, Finish…, Remove); the dashed card is **New worktree** |
| `git/GraphPane` | git | the whole repository's history as a lane graph (`core/git/graph.ts` lays out, this paints one SVG per row): ref pills from `%D` decorations (`core/git/decorations.ts`) — local / current / remote / tag — plus a folder pill per worktree standing on the commit, the subject, an author mark, the age, the sha; a row click shows the commit, a branch pill opens `BranchMenu`, a worktree pill selects that checkout; Load more |
| `git/BranchPicker` | git | `BranchMenu` — one branch's actions (Switch / check out as tracking local, Merge into current, Delete; "in `<worktree>`" disables what git would refuse) from a graph pill; `BranchPicker` — the status bar's popover: fuzzy filter, locals then remotes with the same actions on hover, inline New branch |
| `git/GitStatusBar` | git | what `StatusBar` renders on a git tab instead of the mode segments: the branch button (upstream, state chip) opening `BranchPicker` upward, Fetch / Pull / Push ("Publish" with no upstream; ahead / behind count badges), Refresh, the last error |
| `git/GitMenu` | git | the anchored popover primitive (`fixed`, kept on screen, backdrop click / Esc closes) + `MenuItem`; `anchorFor(el, dir, align)` |
| `git/GitStates` | git | whole-panel states: git missing, no longer a repository (+ Close tab), first-load skeleton |
| `git/ConflictsSection` | git | unmerged files, the live tracker line, **Copy conflict prompt** / Terminal here / Harness here / Abort / Continue (gated), per-file Mark resolved; `ConflictActions` is shared with the finish flow |
| `git/ChangesSection` | git | Staged / Changes / Untracked groups (from `repo.groups`) with hover actions and Stage all / Unstage all; the commit box (mod+Enter on the textarea commits, Amend) |
| `git/GitDetail` | git | the lower half of the main column while something is selected: a thin bar naming it (+ close), then `DiffView` over `repo.diff` (+ EOL / binary hint bar), a commit with its files, a worktree's files vs base, or `FinishFlow` |
| `git/OutputDrawer` | git | streamed fetch / pull / push output at the foot of the main column; the failure hint is text in a `<code>`, never a button; Cancel / Dismiss. A push is a progress bar plus one plain sentence (`core/git/push-progress.ts`), git's lines behind Show log |
| `git/FinishFlow` | git | the finish-worktree stepper: verify pause (terminal here + Continue / Skip), conflicts pause (the agent-first actions + tracker), failed (Retry / Skip / Abort), cleanup confirm text |
| `git/NewWorktreeDialog` | git | `.settings-dialog` chrome: slug, prefix, base branch, "then open" none / shell / harness, a live preview line, Create |
| `git/RemotesDialog` | git | `.settings-dialog` chrome over the store's `remotesDialog` views: connect (paste an address — the line under the field says what was understood — and "Upload my work now"), checking, bring-in (the server already has files), failed (Change address / Try again), the list (change an address, disconnect) and edit. Opened by the status bar's cloud button, and by Publish when there is no remote |

## EditorHost — the never-remount rule (I7)

One `EditorHost` per OPEN tab, all mounted simultaneously; the inactive
ones are hidden with `display: none` — **not** unmounted. Switching tabs
must not re-create editors (state, undo history, scroll all live in the
editor instances).

```tsx
function EditorHost({ tab }: { tab: TabState }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // runs ONCE per tab lifetime — createModeSync attaches the initial editor
    const sync = createModeSync({
      model: tab.model, host: hostRef.current!, initialMode: tab.mode,
      adapters: { source: cm6Factory, wysiwyg: wysiwygFactory },
      onError: reportEditorError,
    });
    tabsStore.getState().registerModeSync(tab.id, sync);
    return () => { void sync.dispose(); };
  }, [tab.id]); // tab.id only — NEVER add deps that change during the tab's life
  return <div ref={hostRef} className="editor-host" />;
}
```

Rules:

- The effect dependency list is `[tab.id]` and stays that way. Mode changes
  go through `modeSync.setMode(...)` via a store action, not through props
  that would re-run the effect.
- `React.memo` the component; the parent renders `<EditorHost key={tab.id}>`
  so reconciliation is keyed by tab identity.
- No `<StrictMode>` in main.tsx (decision log): its dev double-effect would
  attach/dispose/attach every editor. If StrictMode is ever reintroduced,
  EditorHost must first become idempotent under double-mount — do not flip
  one without the other.
- Split mode: EditorHost renders the editor div plus (when
  `tab.mode === 'split'`) a divider and the preview pane div side by side.
  The editor div itself is the SAME node in raw and split — toggling only
  shows/hides the preview column (I7 corollary: mode-sync reuses the
  attached editor). The preview pane is NOT an editor — it's a second effect
  (keyed `[tabId, mode]`, separate from the `[tabId]`-only editor effect)
  that calls `attachPreviewPane` (src/preview/README.md) on entering split
  and disposes it on the way out; I7 governs the source editor only.
- Split divider: a ~15-line pointer-drag handler in EditorHost (no
  dependency) sets the editor pane's `flex-basis` directly via
  `style.flex`, bypassing React state so dragging never re-renders. The
  ratio lives in a module-level variable shared by every tab, so it survives
  tab switches for the session (not persisted to the manifest).

### Split on a drawing (`.svg`)

The same second pane, holding the whiteboard EDITOR instead of a preview —
both halves live over the one DocModel, which is all the syncing there is to
do (I1: an edit on either side is a `pushText`, and the other side is a
subscriber). `SVG_MODES` is `['raw', 'split', 'draw']`; Draw stays the family
default.

- **The source editor keeps the editor pane**, so mode-sync's `kindFor` is
  unchanged and raw ⇄ split leaves CM6 alone (I7) — the caret and the undo
  history survive the toggle you make most. The board is built and torn down
  with the mode by the `[tabId, mode]` effect, costing it only its undo
  timeline, which every whiteboard mode switch already costs.
- **`createBoardAdapter(tabId, extra)`** (module scope in EditorHost) builds
  it, and is the same function mode-sync's `draw` factory calls — one options
  object, two call sites, so Draw and Split cannot drift. They share the tab's
  `stores/whiteboard` entry: the Split column registers itself on attach and
  hands the registry back to `drawAdapterRef` on the way out (or
  `clearWhiteboardAdapter`, which keeps `viewByTab` — the viewport is session
  state that should survive the round trip).
- **`ui/svg-split.ts` links the panes** — board selection → highlighted markup
  (no caret move), caret → selected element (revealed if off screen), and the
  board menu's "Reveal in source". The mapping is
  `core/whiteboard/locate.ts`; the module's own header owns the two rules that
  are easy to get wrong (microtask deferral, and forgetting the caret's last
  target on every document change).
- The ribbon's draw cluster and the hidden outline toggle are keyed on the
  FAMILY now, not on `mode === 'draw'`: a drawing has a board on screen in
  Split too, and has no headings in any mode.

### Keeping your place across a mode switch

Every mode shows the same document, but each surface scrolls in its own
coordinate space, so a switch used to drop the reader at the top of the
incoming one. `ui/mode-scroll.ts` (the per-tab port registry) and
`core/mode-scroll.ts` (the pure mapping) carry ONE coordinate across:
the 1-based source line at the top of the outgoing surface.

- `tabsStore.setMode` calls `captureScrollAnchor(id, tab.mode)` **before**
  the store update — the old surface is still on screen, which is the only
  moment it can be measured.
- Each live surface registers a `{ getTopLine, scrollToLine }` port under
  its `ScrollSurface`: `source` (the CM6 adapter's own two methods),
  `rendered` (either preview pane's), `edit` (the Milkdown adapter's
  `getTopHeadingIndex` / `revealHeading`, translated through the document's
  outline — ProseMirror nodes have no line numbers, so headings are the
  finest landmark both sides share).
- `scrollSurfaceFor(mode)` says who owns the anchor. Split maps to `source`:
  both panes are up, but the editor is what the reader drives, so the
  preview column only *peeks* at the anchor and rides along.
- Applying it is split in two, because the surfaces become ready at
  different times: the preview effect takes the anchor as it attaches the
  pane (which parks the line until it has rendered blocks to measure),
  while a separate `[tabId, mode]` effect waits on `modeSync.whenIdle()` and
  one animation frame — the editor pane was `display: none` until this
  render committed — before scrolling the source or Edit editor.

### Review mode for code files

A code-family tab's `read` mode (labelled *Review* by `core/doc-family
modeLabel`; `CODE_MODES = ['raw', 'read']`, so mod+4, the status bar segments
and session manifests need nothing new) mounts `preview/code-review.ts` in
the same preview host instead of the markdown pane. `EditorHost` wires:
`stores/code-review.ts` (one `ReviewState` per tab — `dispatch(tabId,
action)` from the pane's `onAction`, `pane.setState(reviewStateFor(tabId))`
on every store tick), dark mode, `onOpenDiagram` → `stores/diagram-viewer`,
and `onHoldUnit` → `voice-comments.openNoteAtLine(tabId, signatureLine,
{ unit, quote, hint, identifiers })` armed from the voice store like the
markdown pane's line hold, plus the note markers (`setNotes` from
`marks[tabId]`, `onOpenUnitNotes` → `openAllComments(tabId, { unit })`). The Ribbon's `ReaderControls` (text zoom) apply
unchanged. `stores/code-review` is transient and never persisted; EditorHost
clears the tab's entry on unmount.

**What changed** (`code-review-git.ts`, review_plan.md §6) is the git side
of that wiring, one `createReviewGit({ path, … })` per mounted pane. On
attach — and whenever the tab becomes active, the window regains focus, or
the `reviewBaseBranch` setting changes — it calls `ipc.gitRepoInfo`
(throttled to once per 5 s, `refresh(true)` skips the throttle). The pure
rules are exported and tested: `defaultBaseline(info)` is *branch* when a
merge base exists and HEAD is not the base branch (every worktree), else
*uncommitted*; `baselineRev` maps branch → `info.baseRef`, uncommitted →
`HEAD`, last-commit → `HEAD~1`; `radarBranches` is every other worktree's
branch. `modelChanged(model, text)` (from the pane's `onModelChange`) and
`baselineChanged()` (the store's baseline moved) recompute
`changeMap(parseCode(baseText), model, diffLines(baseText, text))`, with the
baseline text and the radar (`ipc.gitFileChanges`, filtered to `differs`)
cached per revision and dropped when HEAD or the merge base moves. Results
go to `pane.setChanges` — badges first, the radar when it lands — and repo
facts to `pane.setGitInfo`; `isGitUnavailable` (or any other git failure)
becomes `{ available: false, hint }` and clears the badges. Stale answers
are dropped by sequence number, and nothing ever waits on git before the
cards render. `context()` is the `ReviewContext` (`core/comments.ts`) the
hold gesture passes to `openNoteAtLine`, so the sidecar's preamble records
the branch, the worktree root and the baseline.

## Tab strip: shrink, then scroll (M9)

Every tab renders at `--tab-width` (its ideal size, not its title's — a
widened window would otherwise leave the new room empty) and shrinks like a
browser's down to `--tab-min-width`, then the strip scrolls; the `›N` button
appears only while something is actually clipped and lists exactly the clipped
tabs (with a per-row close, since a clipped tab has no × on screen).
Activating a tab scrolls it into view — from the keyboard or from that menu,
landing on a tab you cannot see is useless.

Whole tabs only, justified: when the strip overflows, the fitted whole tabs
stretch to share the sub-tab remainder (`wholeTabsFit` in the same module
gives the count; `--tab-justify-width` overrides the tab min/max), so the
right edge never slices a tab AND the strip ends flush against the ›N / "+ ⌄"
group instead of leaving a gap before the window controls.
`scroll-snap-align` keeps the left edge on a tab start once it scrolls. The
fit comes from tab widths rather than live positions, so it does not move as
the strip scrolls.

What is clipped is **measured**, not computed from a width budget: the tabs
are elastic, so the answer has to survive a resize, a renamed title, a
collapsed group and a scroll alike. The rule itself is pure and tested
(`clippedTabIds` in `src/ui/tab-overflow.ts`); the component keeps only the
`ResizeObserver` wiring. Two consequences worth knowing:

- The phone layout is now plain CSS (`.tab:not(.tab-active) { display: none }`
  below 640px). Hidden tabs measure as zero-width, which the rule already
  counts as clipped — so the count pill lists exactly them with no phone
  branch in the measurement.
- A clipped group CHIP takes its whole run into the overflow list: a run you
  can only see the tail of is not a group you can read.

Right-clicking the strip's FREE space opens nothing (the default webview menu
is suppressed) — the app menu lives solely in the "+ ⌄" picker
(`components/AppMenu.tsx`). "Close all tabs" remains reachable from a tab's
context menu and the command palette.

Right-clicking a TAB opens that tab's own menu (`TabContextMenu`) — what acts
on this document: **Export…** and **Copy all raw text** (only for a tab holding
markdown — not a terminal, image, import card or `.svg` drawing), **Copy path**
(any tab backed by a file — the absolute path) and **Save** (file tabs — notes
persist themselves), then Keep open / Rename / **Move ›** / Close / Close all.
Move is a drill-in page (same pattern as the explorer menu's Import — no hover
flyouts) holding "Move to new window" plus "Move to window …" (one row per
OTHER open window, most recently focused first — the explicit route into an
existing window, and the only one on Wayland). The document rows name the
right-clicked tab's id explicitly, because right-clicking a tab deliberately
does not activate it (`ui/tab-actions.ts`, `saveTab(id)`, and
`openExportPreview(tabId?)`). The split is the rule: app commands in the
picker, per-document ones on the tab.

The free space after the last tab keeps `data-tauri-drag-region` but no
reserved floor — a full row of tabs runs right up to the window controls. The
drag drop-indicator is scroller-relative and must add `scroller.scrollLeft`.

### The "+ ⌄" button pair

The two live in one floating pill after the last tab (Windows Terminal
style). A plain click on + makes **another one of whatever is in front** —
`defaultNewTabChoice` in `core/new-tab.ts` (pure, tested): terminal → terminal,
`.svg` → drawing, a `marp: true` markdown tab → deck (the example
presentation, `core/deck-template.ts`), everything else → note. The ⌄ button — or alt-click,
right-click, long-press or mod+Shift+N — opens the type picker instead, which
lists every type explicitly — note, one row per terminal profile (shell icon,
no heading of its own: a shell is one more thing "+" makes), then the drawing —
so the inference is never the only route. mod+N follows the
same rule — the binding has always been labelled "New tab", not "New note".

Under the tab kinds the picker carries the app rows — **Themes** (drilling
into the same `ThemesMenuPage`), **Settings**, and the two full-screen stages
— and both they and the kind rows come from `components/AppMenu.tsx`
(`AppActionRows`, `NewTabRows`), which is also what the bar menu renders, so
the two cannot drift. The pill is the one menu affordance that stays visible
however full the strip gets, which is why the chrome actions live there and
not only behind the bar's right-click.

Every tab leads with a kind icon (terminal / markdown / drawing / image /
import — `tabIconKind` in TabBar) so the strip reads apart at a glance; a
terminal's agent-status badge sits after the icon, not instead of it.

### Where a new terminal starts

`terminal-open.ts` gives every new terminal tab the **selected workspace's
directory** as its cwd: `uiStore.selectedExplorerDir` (the last folder row
clicked, a workspace explicitly set active via the header's right-click "Set
active", or a freshly added workspace — adding one makes it active; the active
workspace wears a check on its header). "Set active" mirrors the theme
picker's split: clicking it applies to every window (broadcast over
`active-workspace-changed`, `ui/active-workspace.ts`), right-clicking it keeps
the change to this window; implicit selections (folder clicks, adding a
workspace, `?ws=`) always stay window-local. It falls back to the default notes-dir
workspace, and to the app's own cwd for a synced (`saf://`) selection. A
torn-off window inherits the source window's active workspace (`?ws=` URL
param, first spawn only). It does
not inherit from the tab in front. A profile's own `cwd` still wins
(`TerminalPane`), and splitting a pane still inherits that pane's cwd.

Callers that know better pass an explicit cwd, which beats all of the above:
the explorer context menu's "New" page offers a terminal and a harness session
started in the right-clicked directory (NOT the active workspace), and the
Themes menu's AI-theme row starts the agent in the themes folder.

### Which shell a terminal runs, and in which typeface

One global choice each, both in the Settings dialog's Terminal tab — the
app stays a notepad with a terminal in it, not a terminal emulator with
per-profile launch configs.

- **Shell** (`settings.terminalShell`) — a program name resolved against
  `PATH`, an absolute path, or empty for the platform default that
  `src-tauri/src/shell.rs` picks (PowerShell 7 / zsh / bash). The picker lists
  the usual shells for `desktopOs()` plus "Custom…"; `core/terminal-shells.ts`
  owns those lists. `core/settings.ts`'s `terminalProgram` folds the setting
  into a profile at spawn time, so a profile that names its OWN `program`
  still wins. It applies to shells started from
  now on — a running pty is never restarted by a settings change.
- **Font** (`settings.terminalFont`) — defaults to Fira Code rather than
  following the editor font, because box-drawing and column alignment are not
  what a prose typeface is chosen for; `'match'` opts back in. Only the
  FAMILY is separate: the size still follows `--editor-font-size`, so mod+=/-/0
  keeps driving terminal cells. A profile may still shift that size:
  `fontSize` (absolute) or `fontSizeDelta` (relative to the editor) —
  `core/settings.ts`'s `profileFontSize` resolves them; the virtual harness /
  AI theme profiles carry `fontSizeDelta: 2` so an agent's output reads a
  touch larger than the note beside it.

### Which harnesses are installed, and installing one

A **harness** is a terminal coding agent — Claude, ChatGPT (`codex`), Gemini,
Grok, Copilot, opencode, or a custom command line. The Settings dialog's
Harness picker is a radio list (`HarnessRows`) fed by
`stores/harness-availability.ts`: one `ipc.findPrograms` scan answers for every
harness's command, the custom command's program and the install tools
(`core/harness-install.ts`'s `INSTALL_TOOLS`). `refresh()` runs fire-and-forget
after React mounts (main.tsx), when the picker mounts, on **Re-check**, every
`INSTALL_POLL_MS` while an install tab is open, and when that tab closes; the
newest scan wins over a late answer; Android is a no-op. The row model
(`harnessRowModel`) is pure: unknown → nothing, installed → ✓ + path, missing →
dimmed name + **Install** if `installCommandFor` has a route, and a harness in
the store's `installing` list → a spinner + "Installing…" in place of the
button (found-on-PATH wins over that, so a finished install shows ✓ even while
its tab is still open).

`settings.harness` starts at `'auto'`: a fresh install has chosen nothing, so
the first scan that finds a harness writes it in (`adoptDefaultHarness` →
`core/settings.ts`'s `pickDefaultHarness`), preferring Claude, then ChatGPT,
then the rest of `HARNESS_IDS`. The pick is persisted rather than re-derived,
so the new-tab row's name never changes under the user; with nothing installed
the setting stays `'auto'` and `harnessInstalled` is false, which is what makes
the new-tab menu's Harness row open Settings → Harness (`openSettings('harness')`)
instead of spawning a command that is not there.

**Install** (`ui/harness-install.ts`) opens an ordinary shell tab in the default
workspace and hands the command to it as `initialInput`: a transient field on
`TerminalPaneState` / `openTerminalTab` that `TerminalPane` writes to the pty
ONCE — after the shell's first output and a short quiet period (`\r`
appended), or 4s after spawn if the shell stays silent — then clears via
`clearInitialInput`. Splits do not inherit it and `snapshot()` never records
it, so a restored terminal never re-runs an install. The dialect (POSIX /
pwsh / Windows PowerShell / cmd) follows the shell that profile will spawn:
its own program, else `settings.terminalShell`, else `ipc.defaultShell()`.
`watchInstall` then marks the harness installing and polls PATH until it
is found or the tab closes — whichever first — so the user never has to
read the installer's output to know whether it worked.

### The Settings dialog's tabs

`SettingsDialog` is one dialog with a tab strip (`settingsTabs`): Appearance
(theme, fonts, margins, ligatures), Editor (default mode, cursor, wrap, line
numbers, scrolling, tab behaviour), Files (live save, moves, images, notes
folder), Terminal, Harness, and Updates. Terminal and Harness exist only where
`terminalsAvailable()` — never on Android. The last tab shown is remembered
for the session so reopening the dialog lands where the user left it, unless
the caller named one (`uiStore.openSettings(tab)`, cleared on close).

### Where a terminal IS, and the color it wears

`TerminalPaneState.cwd` follows the shell through OSC 7. No stock shell emits
it, so a PLAIN SHELL profile (one naming no `program` — the Shell setting or
the platform default, resolved through `stores/default-shell` when it is
Automatic) is spawned with shell integration: `core/shell-integration.ts`
decides the extra args/env per `shellKind`, `ui/shell-integration.ts` writes
the bash/zsh scripts under `<appDataDir>/shell-integration` once per process,
and `TerminalPane` folds them in (`withShellIntegration`) — profile args first,
profile env on top. A profile with its own program (the harness, ssh) is spawned
exactly as written; that is also the opt-out.

The tab strip colors a terminal by its FOCUSED pane's cwd. The terminals store
stays separate from the tabs store on purpose (title churn), so `tabs.ts`
subscribes to it and mirrors ONLY the focused pane's cwd onto
`TabEntry.terminalCwd` (seeded from the spawn/restored cwd; `setTerminalCwd`
re-runs the workspace arrangement when grouping is on). `workspaceCueFor`
places a terminal by that field, so the strip, the run bands, the overflow
switcher and `groupTabsByWorkspace` all agree; a shell outside every open
workspace has no cue.

### Shell helpers (the pane's right-click menu)

On a plain shell that is NOT on the alternate screen (`Terminal.altScreen` —
an agent TUI or vim owns the pane then), `PaneMenu` adds **Change directory…**
(OS folder picker via `ipc/dialog.ts`, then `cdTarget` + `cdCommand`), **List
files** and **Open <agent>** (`quoteCommand` of the harness profile). Each
types a command plus `\r` through the pane's action runner
(`PaneAction` `terminal-send` — raw keystrokes, not a paste, so bracketed
paste cannot swallow the Enter) and carries a `title` tooltip naming the exact
command: the helpers exist to teach the shell, not to hide it.

## TerminalTab — the keep-your-box rule (I10)

The opposite of I7's `display: none`, for the opposite reason. A terminal
page is hidden with `visibility: hidden` (plus `pointer-events: none`) and
is **never** unmounted while its tab exists.

`display: none` would measure the pane at 0×0; its `ResizeObserver` would
resize the pty to 1×1; and every TUI running in it would redraw into a
corner — which the user sees the instant they switch back. A hidden CM6
must not lay out, a hidden terminal must. Both call sites carry a comment
pointing at the other; keep them that way.

The chrome is HIDDEN on a terminal tab: `Ribbon`, `FileExplorer`,
`OutlinePanel` and `StatusBar` are not rendered at all (they read editor
state a terminal has none of), while the `TabBar` stays — it is the window
titlebar. The explorer/outline open-closed flags in `uiStore` are left
untouched, so switching back to a document restores exactly what was there.

## Git tab (tool tab)

`kind: 'git'` is the second document-less tab kind after the terminal, and the
first TOOL tab (`DocFamily 'tool'`, the single mode `'tool'`). One per
repository per window, keyed by the repository's MAIN root
(`TabEntry.gitRoot`, deduped by `pathKey` in `tabsStore.openGitTab`), whichever
worktree or file it was opened from; `gitCheckout` is the checkout the panel
shows and rides the manifest with the root (`PersistedTab.git`). Restore
re-asks `gitRepoInfo(root)` and drops the tab — with the "missing" notice —
when the root is no longer a repository; Android drops it outright.

- **I7 holds the same way as for images**: every `GitTab` stays mounted and
  the inactive ones are `display: none`. There is no editor behind it, but the
  panel's scroll positions, collapsed sections and the divider ratio (module
  scope, like EditorHost's Split) are worth keeping.
- **Chrome policy**: a tool tab keeps the `TabBar`, the `FileExplorer` and the
  `StatusBar` (its notice area is where "Conflict prompt copied" lands) and
  drops the `Ribbon` and the `OutlinePanel`. The status bar hides its mode
  segments and word counts for any family with exactly one mode
  (`allowedModesFor(family).length === 1`), which is what tells it apart from
  a terminal (where the whole bar is gone).
- **Everything shown is `useGitStore` state, every click a store action.**
  Components read narrow slices through `useRepoSlice(root, pick)` (pick must
  return something the store already holds — never a fresh object) and call
  `gitStore.getState().<action>(root, …)`. There is no component logic
  beyond that, and no component tests (policy); the store and `core/git` own
  the decisions and the suites. The store's real dependencies are wired once
  at bootstrap by `ui/git-deps.ts` (`installAppGitDeps`), since
  `stores/git.ts` cannot import the session facade or the tabs store itself.
- **Finish-flow and network-op state is per window and never persisted.**
  Closing the tab, or tearing it off, while an op streams or a finish flow is
  mid-step asks first (`closeTabInteractive`); a torn-off git tab arrives in
  its new window as a fresh repository read.
- **The app never types into a terminal.** The feature's only terminal call
  is `ui/git-open.ts`'s `openTerminalAt(cwd, harness)` →
  `openTerminal(harness ? HARNESS_PROFILE_ID : undefined, cwd)`, two
  arguments, no `initialInput`; `__tests__/git-open.test.ts` pins that and
  scans the module sources for the token. "Terminal here" / "Harness here"
  only start a shell or the harness IN a checkout. A failed fetch / pull /
  push shows git's stderr and a one-line reading of it as TEXT in the output
  drawer — there is no "run in terminal" button anywhere.
- **Conflicts are the agent's job.** The Conflicts section's primary action
  is **Copy conflict prompt** (`copyConflictPrompt`, the `copyPrompt` voice:
  "Conflict prompt copied — paste it into your AI agent"), beside Terminal /
  Harness here, **Abort merge** and **Continue merge** — disabled with its
  reason until the store's tracker says no unmerged entries remain and every
  tracked file is marker-free. Clicking a conflicted file opens it as plain
  text; **Mark resolved** saves it if open and stages it. No CodeMirror
  conflict widgets.
- **Watcher additions** (`ui/watch-dirs.ts`, extracted from main.tsx):
  `refreshWatchedDirs()` re-arms the OS watcher from workspace roots + Live
  Edit folders + the checkouts of open repositories that no root covers, and
  is what the store awaits before `git worktree remove` (Windows refuses to
  delete a watched directory). main.tsx listens to the watcher's `git-changed`
  (roots under whose `.git` something moved; 500 ms trailing debounce) and
  also passes `fs-changed` roots to `gitStore.onRepoChanged`; window focus
  calls `gitStore.onFocus()` beside `checkAllFileConflicts`.
- **Entry points**: the explorer's workspace-root menu row **Git** (same gate
  as "Workspace directives…": desktop, local folder), the palette's *Git:
  source control* / *Git: new worktree…*, and `mod+Shift+G`
  (`ShortcutAction 'open-git'`, also in `TERMINAL_PASSTHROUGH`). The chord
  reaches the window listener from a focused editor because `editors/cm6.ts`
  drops `Mod-g` from CM6's `searchKeymap` (F3 / Shift+F3 keep find next /
  previous).

## Multi-window (M8 tab tear-off)

On Windows/macOS (`globalCoordsTrusted()` — the platforms with real global
coordinates), tab tear-off follows Chrome's model (M8.6, "live tear-off"):
pulling a tab VERTICALLY out of the strip (`TEAR_OFF_PX` past the bar;
side-to-side stays a reorder) tears it off immediately, mid-drag, into a
real window — spawned unfocused under the cursor, then glued to it by the
same follow loop the drag ghost uses (global cursor → `setPosition` per
frame, `ui/tab-window-drag.ts`). A window's ONLY tab never tears: pulling it
moves the whole window (`startWholeWindowDrag` — the move starts from the
pressed window's own pointer grab). The SOURCE window keeps the pointer
(capture moves to the bar when the grabbed tab unmounts), so it also keeps
the release: dropping on another app window commands the torn-off window to
hand its tab there and close (`dropTornWindow` → `commandTornWindowDrop`, a
retried `torn-window-drop` event the torn-off window acks — it may still be
booting); over empty desktop the window is just focused where it stands.
Every failure degrades to the window standing open with the tab — never a
lost tab.

LINUX HAS NO LIVE TEAR-OFF — deliberately. The compositor route (spawn
unpositioned, then `startDragging` the new window) was tried and reverted:
Wayland forbids placing a window at the cursor, so even a compositor that
honors the cross-surface move (KWin) moves a window the cursor was never
holding — it appears elsewhere and rides out of sync, which reads as broken
(the same reasoning that reverted the X11 ghost enablement). Linux keeps the
release-time path below for every drag-out.

Releasing a drag outside the window without crossing the vertical threshold
(on Linux: any drag-out) runs the release-time path: the tab lands in
the app window under the cursor or tears off at the release point (the
session controller's `dropTabOut` makes the call). While a drag is live the
source tab dims; on WINDOWS a ghost of the tab additionally rides the
cursor, in two halves: a DOM pill inside the window (TabBar's DragGhost),
and a tiny always-on-top, click-through, non-focusable ghost WINDOW (label
`ghost-*`, `ui/tab-drag-ghost.ts`) that takes over when the cursor leaves
the window — and bridges the spawn gap of a live tear-off. Only Windows has
all the OS half's prerequisites (global cursor coordinates, app-positioned
windows, flag-free transparent webviews), and a lone DOM ghost dying at the
window edge reads as broken — so other platforms show no ghost at all
(`osGhostAvailable`). Ghost windows are not the app: `?ghost=1` renders just
the pill (no controller, no manifest), every window enumeration skips
`ghost-*`, and the window-state plugin is filtered off them. The model:

- **Every window is the full app** — same `main.tsx` boot, own JS context,
  own stores, own session controller. The window label decides the role:
  `main` vs `w-<nanoid>` (torn-off).
- **One manifest per window, in the one session dir**: `session.json` for
  main, `session-<label>.json` for secondaries. `buffers/` is shared (tab
  ids are global nanoids). Note-slug collisions across windows are guarded
  by re-listing the notes dir at the start of every flush.
- **Handoff is disk-first**: the source window flushes the tab, detaches it
  (`detachTab` — no delete tombstones), flushes its manifest again, and only
  THEN spawns the window, passing a one-tab manifest in the `?adopt=` URL
  param. A crash mid-handoff can therefore never restore the tab in two
  windows; worst case it's in neither manifest but its files are on disk.
- **A terminal tab takes its SHELLS with it.** The pty registry is app-wide
  (Rust), so only the listener is per-webview: a descriptor built for a live
  window (`persistedDescriptor(tab, { handover: true })` →
  `snapshot(tabId, { handover: true })`) names each pane's pty, `detachTab`
  RELEASES the panes instead of closing them (`releaseSession`, so the
  unmounting pane calls `pty_detach` and not `pty_kill`), and the receiving
  pane attaches to that same pty (`adoptPtyId` → `PtyProvider.attach`)
  instead of spawning. The backend replays its recent output, so the screen
  comes back and a running command keeps running. Two things make the restored
  screen correct rather than merely present: the pty is resized to the new
  pane's grid BEFORE the replay (so the shell's redraw is part of it), and the
  engine's query responses go through `PtyHandle.report`, which swallows them
  until the replay's end marker — a replay carries the queries the shell asked
  in the OLD window, and answering one afterwards hands a live shell a stale
  cursor report, which is what left the caret inside the prompt. A pty id NEVER reaches
  disk — ids are per-process, so a persisted one would name somebody else's
  shell after a restart; a manifest snapshot therefore has none and restore
  respawns as before. A shell that is already gone (NOT_FOUND on attach)
  falls back to a fresh spawn.
- **Session restore covers windows**: at boot, main lists
  `session-*.json` (a dedicated Rust command) and re-spawns each window;
  the window-state plugin restores per-label geometry.
- **A second launch never teleports the user across virtual desktops**
  (Windows 11): the single-instance handoff in `src-tauri/src/lib.rs`
  focuses an existing window only if that window is on the desktop the user
  is looking at right now; otherwise it builds a fresh `w-<millis>` window,
  which Windows places on the active desktop. Files a REUSED window gets
  over the `open-files` event; a NEW window has no listener yet when it is
  built, so they ride its `?open=` URL param (a JSON array of paths) the way
  a tear-off's tab rides `?adopt=`. Release builds only — debug skips
  single-instance entirely so a dev build can coexist with an installed one.
- **Closing a torn-off window closes its tabs** — no handoff. Note files
  keep their latest text (a note outlives its tab as a real file in the
  notes workspace); unsaved file-buffer edits die with the window, like a
  tab close. The flusher is disposed BEFORE `session-<label>.json` is
  deleted, so no armed timer or blur-triggered flush can resurrect the
  manifest and respawn the window next boot. Terminal tabs close through
  the store first so the panes' unmount cleanup kills their shells (the
  handover above is the one path that releases them alive instead). The
  exception is the LAST window standing: closing it quits the app, and quit
  preserves the session — its tabs fold into main's manifest
  (`bequeathTabsToMain`), so relaunch opens one window with everything.
  Closing MAIN keeps `session.json`; windows close independently and the
  app exits when the last one is destroyed.
- **Dropping a tab on another window** reuses the same pair: the source
  flushes + detaches (the moveTabOut ownership dance), `emitTo`s the target's
  label, and adopts the tab right back if no ack comes. WHICH window is under
  the cursor is `findDropWindow` in main.tsx — Tauri global cursor + every
  window's outer bounds, all physical px — with overlap resolved by focus
  recency (each window broadcasts `window-focused`; most recent ≈ topmost);
  the rule itself is `pickDropWindow` (core/window-drop.ts, pure, tested).
  The context menu's "Move to window …" rows reach the same handover
  explicitly (target picked by name, no coordinates) — which is why they
  exist: it is the one route into an existing window that Wayland permits.
- **Tab sync (mirrors)**: a FILE may be open in several tabs — "Duplicate
  tab" / "Duplicate in new window" in the tab menu, a file opened from the OS
  into a second window, a tab dropped beside its twin. Each mirror keeps its
  own DocModel; `ui/doc-sync.ts` attaches every file tab to the pure hub in
  `core/doc-sync.ts`, which fans edits out to sibling tabs directly and to
  other windows over the `doc-sync` event (whole text, own echo dropped by
  label), announces saves so mirrors adopt the new baseline
  (`adoptMergedText`) instead of raising the ConflictBanner, and lets the
  conflict probe recognise a mirror's write that raced its announcement
  (`mirrorKnowsText`). `retargetFilePath` moves all mirrors; explorer delete
  closes all of them. NOTE tabs never mirror: a note's file follows one tab.
- **Presenter view**: `ui/presenter.ts` + `components/PresenterView.tsx`. One
  helper window, fixed label `w-presenter` (`?presenter=1` boot branch in
  main.tsx: themed, but no controller/manifest/tabs; `isHelperWindow` keeps it
  out of drop targets, "Move to window" and the last-window count). The
  opening window feeds it the deck text (`presenter-deck`, re-sent on edits
  and on `presenter-ready`); `deck-slide` broadcasts the current slide both
  ways through `slideStore`, which `DeckShow` publishes to and follows.
- **Cross-window invariants**: the controller's `adoptTabs` skips NOTES a
  local tab already owns (a file tab is adopted as a mirror — see above);
  file-open entry points (argv, `open-files`) target main only; the
  notes-dir change flow is main-only; settings changes broadcast via a
  `settings-changed` event so theme/fonts stay uniform — except a theme a
  window pinned to itself (`stores/window-theme`), which neither leaves nor
  accepts the broadcast, and the explorer tree shape (collapsed workspaces /
  expanded folders), which each window keeps to itself on ingest
  (`keepWindowLocalSettings`, core/settings.ts) so expanding a folder in one
  window doesn't expand it everywhere (it still persists — last saver wins
  the boot state).
- **Platform gating**: live tear-off is Windows/macOS-only
  (`EAGER_TEAR_OFF = CAN_TEAR_OFF && globalCoordsTrusted()` — see above for
  why Linux was reverted). On Linux (Wayland offers no global cursor
  position or app-side window placement) a drag-out release is judged in
  client coordinates and the new window spawns unpositioned — the
  compositor places it. The drop-on-window hit-test needs REAL global
  coordinates (`ui/global-coords.ts`), which Linux is treated as not
  having — a drag out always tears off there, never a junk-coordinate drop
  into the wrong window — and the ghost visuals are Windows-only (see
  above). Android is single-window; there only in-strip reorder exists
  (`CAN_TEAR_OFF`). The context-menu items ("Move to new window", "Move to
  window …") work everywhere.

## Live Edit (shared cloud folders)

The mode for a Drive/OneDrive folder several people edit at once: Auto save
plus a merge of whatever the other person saves, while the file is open.
Policy is `core/live-edit.ts`, the merge is `core/merge.ts`; the ui side is
one seam and three surfaces.

**Where a tab becomes live.** `WorkspaceEntry.liveEdit` (the explorer's
workspace menu → "Live edit (shared folder)", `session.setWorkspaceLiveEdit`)
covers every file under that root; `TabState.liveEdit` (the Save menu's
"Live edit (shared file)", `tabsStore.setLiveEdit`) overrides it either way
for one tab and rides the manifest. `session/live-merge.ts#isTabLive` is the
one resolver the session uses. Notes are never live: a note's file belongs to
the flusher, and the default notes dir has no `WorkspaceEntry` to flag.

**The seam is the conflict probe.** `session/conflict-probe.ts` already
answers "did this file change behind our back?" for the banner, the focus
check, the `fs-changed` listener and `saveFileTab`'s pre-write guard. For a
live tab a real change goes to `mergeDiskChange` instead of `setConflict`:

```
base   = pickMergeBase(snapshot + history, theirs)   ← see "Which base"
mine   = model.getText()                             ← the editor now
theirs = fresh read from disk                        ← their save
result = mergeThreeWay(base, mine, theirs)           ← disk wins a collision
if result.removed and a CM6 adapter is attached:
    adapter.flashRanges(result.removed, 'removed')   → red on the lines about to go
    wait REMOVE_FLASH_MS (live save held: hasPendingMerge), then recompute
model.pushText(result.text, 'programmatic')          → minimal diff, caret survives
tabsStore.adoptMergedText(id, { diskText: theirs, mtimeMs })
                                                     → 'file' baseline := theirs; dirty iff merged ≠ theirs
adapter.clearFlash('removed'); flashRanges(result.theirs, 'added')
                                                     → green fade on the lines that arrived
result.lost → liveEditStore.setLost(id, blocks)      → LiveEditBanner: Restore mine / Dismiss
```

Where both sides changed the same lines, THEIRS (disk) wins — the one rule
under which two machines converge instead of each re-saving its own version
(keep-both was tried first and rejected: it filled a collaborative document
with duplicate lines). What the local author loses is never silent: the red
flash first, then `LiveEditBanner` above the editor with the overwritten
lines held in `liveEditStore.lost`; `restoreLostLines` reinserts them right
after their replacement (`restoreLostBlocks`, green flash) and the next
flush saves that, `dismissLostLines` forgets them. CM6's own history also
has the merge transaction, so Ctrl+Z is a further escape hatch.

The next flush live-saves whatever the merge left that disk lacks (the
flusher saves a live tab whatever `settings.liveSave` says, except while a
red flash is pending). `saveFileTab` needs no special case: its pre-check
runs the same probe, so a save that races an external write merges first
and then writes the result. Disk catching up to exactly the editor's text
just marks the tab saved. If a merge cannot be applied (an editor refused
the push) the probe falls back to the banner, so nothing is ever lost.

**Which base.** The sync client resolves a write race last-writer-wins, so
a text can arrive that was built on the snapshot BEFORE our last write (our
write never reached that machine — observed on Google Drive, 2026-09-10).
Against our latest snapshot that reads as "they deleted my line" — a plain
edit, so no banner. `mergeDiskChange` therefore hands `pickMergeBase` the
current snapshot plus `model.getPersistedHistory('file')` (the last few
`file` snapshots, kept by DocModel) and merges against the one `theirs` is
closest to; the older base makes the collision visible, so the author gets
the red flash and the Restore-mine offer. The trade-off is documented in
`merge.test.ts`: a tweak of a line we only just inserted is
indistinguishable from a concurrent insert and also raises the offer.

**Watching.** `fs-changed` already covers workspace roots; `main.tsx` adds
`extraLiveWatchDirs` (folders of overridden files outside every root) and
re-arms on tab-store changes too. Merges also run on window focus via
`checkAllFileConflicts`, and — because Google Drive's streaming volume
(`G:`) does not reliably deliver directory-change events — on a
`LIVE_EDIT_POLL_MS` timer while any live tab is open. Cloud volumes also
lie about mtime (that volume reports FAT32: 2 s granularity), so a live tab
never takes the mtime shortcut: the probe and `saveFileTab`'s pre-write
check always READ the file and compare content. Small files, rare events.
Latency is the sync client's, not ours.

**Modes.** Raw/Split get the minimal-diff patch and the highlight. WYSIWYG
re-renders from the merged markdown (no highlight, the caret may move) — an
accepted trade-off, not a bug to fix by pausing merges.

## Keyboard shortcuts (single registry)

One `keydown` listener installed at bootstrap, dispatching store actions —
components do not bind their own global keys. `mod` = Cmd on macOS, Ctrl
elsewhere (`navigator.platform`-based helper).

| Keys | Action | Milestone |
| --- | --- | --- |
| mod+N | new OS window with one empty note (`session/windows.ts` `openEmptyWindow`) | M8 |
| + button / palette "New tab" | new tab, of the type in front (`core/new-tab.ts`) | M1/M9 |
| mod+Shift+N | new-tab type picker (note / drawing / Marp presentation / terminal) | M9 |
| mod+W | close tab (confirm per semantics) | M1/M2 |
| mod+Tab / mod+Shift+Tab | next / previous tab | M1 |
| F2 | rename tab | M1 |
| mod+F | editor search panel | M1 (CM6 handles it when focused) |
| mod+1 / mod+2 / mod+3 | raw / split / wysiwyg | M1 (targets exist M4/M5) |
| mod+O | open file | M3 |
| mod+S / mod+Shift+S | save / save as | M3 |
| mod+, | settings | M6 |
| mod+= / mod+- / mod+0 | font size up / down / reset | M6 |
| mod+Shift+G | Git: source control — the git tab for the repository around the active tab (`ui/git-open.ts`; also passes through a focused terminal) | git |

Don't intercept keys CM6 needs while the editor is focused unless the
shortcut is in this table (the listener checks `defaultPrevented` and
event target).

### Terminal tabs

A focused shell owns almost every key, so `keyEventToAction` takes a
CONTEXT. In `'terminal'` it answers for a short allowlist and returns
`null` for everything else, which is then encoded and sent to the child —
mod+S is XOFF, mod+O and mod+U are readline, mod+1..4 mean whatever the
running program says. `TerminalPane` asks the keymap first and calls
`preventDefault()` only on what it handles; the global listener's
`defaultPrevented` guard keeps the two from both firing.

| Keys | Action |
| --- | --- |
| mod+Shift+C / mod+Shift+V | copy / paste |
| mod+C | copy **only when something is selected** — otherwise it encodes as SIGINT |
| mod+Shift+A | select all |
| mod+Shift+K | clear scrollback |
| mod+Shift+D / mod+Shift+E | split right / split down |
| mod+Shift+X | close pane (the last one closes the tab) |
| mod+Shift+[ / mod+Shift+] | previous / next pane |
| Shift+PgUp / Shift+PgDn | scrollback by a page |
| mod+Shift+↑ / ↓ | scrollback by a line |
| mod+Shift+Home / End | scrollback to top / bottom |
| mod+= / mod+- / mod+0 | zoom THIS pane only (not the app-wide editor font) |

Still available from a terminal: new/close tab, next/prev tab, rename tab,
settings, palette, full screen. Nothing else.

## UI conventions

- Notices (flush errors, normalization hint, "note file missing") go to the
  StatusBar notice area — auto-dismiss after ~6s, never modal.
- The webview must NEVER navigate. `link-guard.ts` (installed once from
  main.tsx) cancels every anchor click the surface that rendered it did not
  already claim — an `http(s)` link that gets through replaces the whole app
  with a chrome-less remote page and there is no way back. External links go
  through `stores/external-link.ts` → `ExternalLinkPrompt` → the OS browser;
  the confirmation step exists because a markdown link's real destination is
  invisible until it is clicked. TerminalPane's detected link clicks take the
  same route.

### Link policy (app-wide)

The webview must NEVER navigate. A remote page loaded into the window replaces
the entire app with something that has no chrome, no Back and no way out — a
soft lock. `link-guard.ts` installs one delegated `click`/`auxclick` listener on
`document` (from main.tsx, for the window's lifetime) that prevents the default
on EVERY anchor, and hands `http(s)` ones to `stores/external-link`:

- Clicks a surface already handled (`defaultPrevented`) are skipped — the
  preview pane runs its own richer handler and prevents the default itself.
- The wysiwyg (ProseMirror) document is the case the guard exists for: its
  anchors belong to no handler, so without it a click navigates the window.
- Nothing opens without confirmation. `ExternalLinkPrompt` names the host the
  URL really resolves to (userinfo stripped — `https://github.com@evil.example`
  reaches `evil.example`) and warns before "Open in browser" reaches
  `openUrl`. Esc or ~15s of no answer dismisses it.
- Ctrl/Cmd-clicking a URL detected in terminal output takes the same path.

### Context-menu policy (app-wide)

The webview's own menu (Back / Reload / Inspect Element) must never appear over
app chrome — the window is undecorated and meant to read as a native app, so a
devtools menu on the minimize button is a leak, not a feature.
`context-menu-guard.ts` installs one delegated `contextmenu` listener on
`document` (from main.tsx, alongside the link guard, for the window's lifetime)
that prevents the default everywhere except:

- targets a surface already claimed (`defaultPrevented`) — FileExplorer,
  TabBar, Ribbon and TerminalPane open their own menus and cancel it themselves;
- text entry (`input`, `textarea`, `contenteditable` — CodeMirror and milkdown
  are the latter), where the native menu is the editors' only right-click
  copy/paste.

Per-component swallows (StatusBar, Ribbon) predate the guard and are now
belt-and-braces; a new surface needs no guard of its own unless it has a menu.

- Modals are reserved for: close-tab confirmation, save/discard/cancel on
  dirty file close, settings. Use `@tauri-apps/plugin-dialog` for native
  confirm dialogs (they match the OS), custom DOM only for SettingsDialog.
- The window title mirrors the active tab: `<title> — MD Specpad`
  (`getCurrentWindow().setTitle`), updated from a store subscription.
- Drag-reorder of tabs: pointer-events implementation, no dnd library
  (dependency freeze), and NOT HTML5 drag-and-drop — Tauri's OS drag-drop
  interception swallows webview-internal HTML5 drags on Windows (same
  constraint as the FileExplorer's useFileDrag). The drag also handles
  group membership (drop inside a run joins, boundaries leave, chip
  appends) and hands releases outside the window to the M8 tear-off.

## Settings (M6)

- Persisted via `tauri-plugin-store` (`settings.json` in appDataDir), wrapped
  in `src/ipc/settings-store.ts` (the only place the store plugin is touched).
  `main.tsx` loads + `normalizeSettings` BEFORE resolving paths/mounting, then
  arms a debounced write-through subscription (so the initial load doesn't echo
  a save). A corrupt/missing store degrades to defaults — never a crash.
- `SettingsDialog` writes every field straight through `settingsStore.update`,
  so changes apply immediately: theme/ligatures/font size via the DOM
  subscription (`applyDomSettings`), word wrap via EditorHost reconfiguring the
  live CM6 adapter, default mode on the NEXT new tab.
- Theme picking has two surfaces — the "+ ⌄" picker (or the tab bar's own
  menu) → **Themes** (the theme
  list plus Open folder / New theme… / Reload / Help) and the Settings **Theme**
  dropdown. Both go through `ui/theme-actions.ts` (side effects) and
  `stores/theme-registry`'s `currentThemeValue` / `themeSelectionPatch` (the
  pure "which entry is current / what does this choice mean" pair, unit-tested),
  so the two can't drift.
- **Window-only theme** (right-click in the Themes list, or the Settings box): the
  pinned theme still lives in the settings store — every consumer reads the
  theme from there — and `stores/window-theme` instead guards the two edges
  where settings cross the window boundary. `sharedSettings` swaps the shared
  theme back in before `main.tsx` saves/broadcasts; `mergeIncomingSettings`
  takes a sibling's settings minus the theme, which is also what stops the echo
  of our own broadcast from undoing the pin. Not persisted — it lasts as long
  as the window.
- **Smooth scrolling** is the ENGINE's, on purpose — do not reintroduce a JS
  scroll animation. One was built (a window-level wheel listener springing
  `scrollTop` per rAF) and removed: it ran on the main thread, so every frame
  fought CM6's viewport re-render and the result was jitter no spring tuning
  could fix, while `preventDefault` suppressed the engine's own
  compositor-thread animation that does this properly. Now DOM surfaces scroll
  natively everywhere, and the setting means: on Linux, `main.tsx` flips
  WebKitGTK's `enable-smooth-scrolling` via `ipc.setSmoothScrolling`
  (`src-tauri/src/commands/webview.rs`); on Windows, WebView2 (Chromium)
  already animates wheel scrolls and there is nothing to flip; on macOS,
  wheels step and trackpads carry OS momentum. The terminal is the exception
  that still animates — a canvas has no native scrolling — with the spring in
  `core/smooth-scroll.ts` (renderer/README), gated by the same setting.
- **Font size is CSS-variable driven** (`--editor-font-size`): CM6, preview,
  and wysiwyg all read it, so `mod+=/-/0` and the dialog just update the setting
  — no per-editor plumbing. Word wrap is the one setting that needs an editor
  hook (CM6's `setWordWrap`), applied without re-mounting (I7).
- **Updates** (`ui/update.ts`) are INFORMATIONAL until clicked — nothing ever
  downloads on its own. Two surfaces offer the install: the status-bar
  `UpdateChip` and Settings' **Update now** button, both calling the same
  `downloadAndInstall` (flush → install → relaunch). The automatic check is
  `settings.autoUpdateCheck` (default on): `startAutoUpdateChecks` runs one
  3s after boot in the MAIN window only (never on Android, never in dev) and
  then re-asks hourly, so a window left open across a Sunday still becomes
  due. Whether a check is due at all is the pure `core/update-schedule.ts`
  decision over `settings.lastUpdateCheck` — at most once a week, on/after
  Sunday. That stamp is written only when the endpoint was actually REACHED,
  so an offline Sunday retries rather than skipping the week; a manual check
  stamps it too.
- Notes-dir change: the flow lives on the session controller
  (`changeNotesDir`) — folder picker → optional move of existing notes (pure
  set from `core/notes-move.ts`) → repoint the live `notesDir` so the next
  flush writes there. Moved notes' tabs are retargeted via `applyFlushResult`;
  files that can't move are left behind and reported in a status-bar notice.

## Testing expectations

Stores (`stores/*.ts`) get full Vitest coverage — tab lifecycle, rename
override, close bookkeeping (`closedNotePaths` tombstones), shortcut
dispatch decisions (pure `keyEventToAction(e, platform)` helper). JSX stays
declarative and thin.

## Review notes — composer, markers, overview

The user-facing name is **Review notes** (the ribbon buttons, the composer's
title and labels, the notices): a note is typed on desktop and spoken on
Android, so the name says what they are for. Module and setting names keep
`voice…` — the sidecar format, the Settings tab and its `voiceNotes*` keys
are unchanged.

**The composer is inline.** There is no sheet: holding a line (or a code
card) opens `components/NoteComposer.tsx` right under it, inside the Review
pane. `EditorHost` owns one `div` per tab (`composerSlot`) and portals the
composer into it while the store's `phase` is open for that tab; the pane
places the slot (`mountComposer(line | unitId, slot)` — `preview/README.md`)
and `EditorHost`'s per-pane `syncNotesPane` keeps placement, markers and the
hold gesture in step with the store on every tick. Saving closes the
composer and asks the pane to show the note landing (`requestReveal` →
`reveal` in the store → the matching pane's `revealNotes`, cleared with
`clearReveal(seq)`; a reveal older than `REVEAL_TTL_MS` is dropped). A code
note whose spoken names were snapped stops at `phase: 'saved'` first, with
the undo chips, until Done.

**Markers** — while the toggle is armed, each Review pane marks every
line/card that already has a note and expands it in place. The notes come
from the store's `marks: Record<tabId, VoiceComment[]>`: `EditorHost` calls
`loadMarks(tabId)` whenever armed (the entry appears empty at once, so
repeat asks are no-ops, then fills from the sidecar; a missing or
unreadable sidecar leaves it empty without a notice), feeds
`pane.setNotes(marks[tabId])`, and `dropMarks(tabId)` on unmount so the
next mount reads afresh. Every write (`writeSidecar` → `syncMarks`) pushes
the saved list into each marked tab on that document; disarming clears the
map. A callout's edit and delete go through `editNote(tabId, id, text)` /
`deleteNote(tabId, id)`, thin wrappers over `mutateNotes(notePath, sidecar,
change)`: a read → change → write of the sidecar that keeps the preamble's
review context (`core/comments parseReviewContext`), refreshes the marks and
an open composer's `comments`, and tells `onNotesChanged` listeners.

**Initialize Workspace.** `workspace-init.ts` +
`components/InitWorkspaceDialog.tsx` gather the inputs for
`core/workspace-modules.ts` (folder, the user's `<appData>/agent-modules/*.md`,
the files already there), write what it plans, and register the folder as a
workspace; opened with a root (context menu "Workspace directives…") it is the
re-run, which also drops any retired module's block (`RETIRED_MODULE_IDS`).
Desktop only. The app never launches an agent: the user pastes into their own
terminal.

**The overview** ("All notes" in the ribbon and in every callout;
`Show all review notes` in the palette; Escape closes) is
`notes-overview.ts` + `components/NotesOverview.tsx`: opening walks every
workspace root through the storage provider (`listDir`, breadth-first,
dot-dirs and build trees skipped, capped at `DIR_CAP` directories and
`SIDECAR_CAP` files — `truncated` says when a cap hit) plus the open tabs'
sidecars, reads each `*.comments.md` into a `NoteDoc`
(`core/notes-overview.ts` resolves the document from the entry's `file:`
reference and does the searching, grouping and relative times), and shows
them newest-first or by document, scoped to all documents or the active
tab's. Edits and deletes there use `mutateNotes` too, and the store keeps
its list current by listening to `onNotesChanged` rather than writing
itself. "Go to" closes the panel, arms review notes, `requestReveal`s the
note, opens the document (`openNotePath`) and switches its tab to Review —
waiting for the tab to appear when the open is asynchronous.

## Voice notes — engines

`voice-comments.ts` is the controller; `components/NoteComposer.tsx` the
inline composer. `noteEngine()` picks the composer's engine: on Android the
recognizer or **Whisper** (`androidDictationEngine`, 'system' or 'whisper')
— voice first, the keyboard is awkward there (the text box is there too, for
a tablet with one); on desktop always Whisper, because the note is
**typed**: the composer is a text box (`draft`, `updateDraft`) with a Save
button (`saveDraft`), a hint that the OS's own dictation types into it
(Win+H, the macOS Dictation key — suggested, never pressed by the app), and
a Whisper microphone whose transcript is appended to the draft. Until the
chosen model is on disk (`whisperReady`) the microphone's place is an
Install button (`installWhisper` → the models store's download, progress in
the sheet). `dictationEngine()` — the `desktopDictationEngine` setting,
'auto' = Windows voice typing on Windows, Whisper elsewhere — only steers
the edit modes' voice typing now. The ribbon's Review-mode button is always
there.

Whisper's flow: the first tap opens the mic through `pcm-capture.ts` (an
`AudioWorkletNode` collecting 16 kHz f32 frames in memory — nothing touches
disk) and, in parallel, `ipc.whisperPrepare` warms the model so a missing
one fails the capture before anything is said. The second tap stops the mic
and enters the `transcribing` phase: the PCM goes to `ipc.whisperTranscribe`
as a raw body and the answer becomes the note (Android) or lands in the
draft (desktop, `deliver`). Closing the composer mid-way
cancels the mic or drops the pending words. At `MAX_CAPTURE_SECONDS` the
capture stops itself and transcribes what it has. Models are downloaded from
Settings ▸ Voice notes through `stores/whisper-models.ts`, which sequences
the `whisper_model_*` commands and projects `core/whisper-models.ts`'s
`downloadReducer`; the same store learns the machine's accelerator
(`whisper_accelerator`) for the "Run on the GPU" row and what an earlier
version left behind (`whisper_models_stray`). `stores/whisper-setup.ts` is
the first-launch offer: `main.tsx` calls `consider()` once after boot, core's
`shouldOfferSetup` decides (never twice, never with a model installed, never
on Android), and `components/WhisperSetupPrompt.tsx` — the ExternalLinkPrompt
bar shape — starts the recommended download through the models store or
sends the offer away for good (`whisperSetupOffered`). `pcm-capture.ts` is
DOM plumbing and untested by policy; everything with a decision in it lives
in core or the stores.

## Voice typing (edit modes)

`voice-typing.ts` drives the ribbon's microphone in Raw, Split and Edit: the
same `dictationEngine()` engines, but the transcript goes into the document
at the caret instead of a sidecar. It types into the tab the capture started
on, through the editor that tab shows when the words arrive — the CM6
adapter (raw/split) or the Milkdown one (wysiwyg), both looked up in
`editor-registry.ts` and both exposing `insertText` (spacing from core's
`joinDictation`). Windows voice typing is a one-shot hand-off: focus the
editor, press Win+H, and the shell types straight into it — its own panel
owns the listening state, which the app can't see, so the store stays
`idle`. Whisper and Android get a real two-tap `listening` state
(`transcribing` for Whisper). Failures are status-bar notices. The ribbon
button finishes a live capture when the active tab changes or the edit
controls unmount (a switch to Review or Draw).
