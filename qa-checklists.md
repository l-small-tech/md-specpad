# Manual QA checklists

Execute the section for the milestone you just built, on your dev OS, in a
real `pnpm run tauri dev` session (release-build checks are called out
explicitly). Check every box in the milestone's PR/commit message. The full
3-OS sweep happens at M7.

Conventions: "kill" = hard-kill the process (Task Manager / `taskkill /f
/im md-specpad.exe` / `kill -9`), never a graceful quit. `notesDir` and
`sessionDir` per your platform (see root README table; session dir is the
sibling `session/` folder).

## M1 — Shell

- [ ] Launch → single tab "Untitled", caret in the editor, no console errors.
- [ ] Type `# Grocery list` → tab title becomes "Grocery list" (no `#`),
      window title "Grocery list — MD Specpad". Delete the line → back to
      "Untitled".
- [ ] Type `-> => != >= <=` → each renders as a single ligature glyph.
      Arrow keys step through the ligature's underlying characters.
- [ ] Markdown highlighting: heading, `**bold**`, `` `code` ``, link, list
      markers each styled distinctly.
- [ ] Ctrl+F opens CM6 search inside the editor; Esc closes it.
- [ ] Create 10 tabs, put distinct text + scroll positions in each, switch
      rapidly (mouse + Ctrl+Tab): cursor/selection/scroll are per-tab, no
      flicker, no cross-tab bleed.
- [ ] F2 rename to "My Ideas" → title stops following the first line;
      renaming to empty string reverts to auto-derive.
- [ ] Middle-click closes a tab; Ctrl+W closes the active tab; closing the
      last tab leaves one fresh "Untitled" (Notepad behavior).
- [ ] Mode segment: raw⇄split⇄wysiwyg switch shows the honest "coming in
      M4/M5" pane and switches back losslessly.
- [ ] OS dark mode on launch → dark theme; flip OS theme while running →
      app follows live (editor included). With a theme selected the app pins
      that theme's declared mode instead: a dark theme under a light OS shows
      dark chrome AND dark mermaid diagrams.
- [ ] Drop an old-format (`light`/`dark` keys) theme file in the themes folder
      + Reload → it is silently absent from the list; the file is untouched.
- [ ] Resize window small (400×300): layout stays usable, no overflow.

## M2 — Session persistence

- [ ] Fresh start (delete notesDir + sessionDir first): type "Buy milk" in
      a new tab → within 5s `notesDir/buy-milk.md` exists with the content.
- [ ] **Kill drill**: type continuously for ~10s, kill the process
      mid-typing, relaunch → all tabs restored (order, active tab, cursor
      position), text loss ≤ ~5s of typing.
- [ ] Change the first line to "Weekend plan" → after the next flush the
      file is `weekend-plan.md`, `buy-milk.md` is gone.
- [ ] Two tabs both titled "Idea" → `idea.md` + `idea-2.md`; both survive
      restart with correct contents.
- [ ] Empty new tab, restart → tab restored, still no file in notesDir.
- [ ] Close a non-empty note tab → confirm dialog; accept → tab gone AND
      its `.md` deleted on next flush; cancel → nothing happens.
- [ ] Corrupt `session.json` (replace content with `garbage{{{`) while app
      closed → relaunch: no crash, `session.json.bad-*` created, recent
      notes reopened from notesDir.
- [ ] Delete sessionDir entirely while app closed → relaunch self-heals
      the same way.
- [ ] Blur flush: type, immediately click another window, kill the app →
      relaunch has the text (blur triggered `flushNow`).
- [ ] Graceful close (X button) mid-typing → relaunch shows the very last
      keystroke (close-requested flush).

## M3 — Files

- [ ] Ctrl+O a `.md` with LF endings → correct content; edit → dirty dot;
      Ctrl+S → dot clears; file on disk correct, endings still LF.
- [ ] Ctrl+Shift+S to a new path works; tab tracks the new file.
- [ ] Save (Ctrl+S) on a NOTE tab → Save-As dialog; after saving, the note
      file is removed from notesDir and the tab is a file tab.
- [ ] Launch from CLI: `md-specpad some.md` opens it. Second instance
      (double-click a file while running) → existing window focuses, file
      opens as a tab, no second window. Opening an already-open file
      focuses its tab instead of duplicating.
- [ ] Edit a file tab, DON'T save, kill, relaunch → edits restored, dirty
      dot shown, on-disk file untouched.
- [ ] External change: with a file tab open, modify the file in another
      editor → refocus the app → banner appears. Reload shows external
      content (dirty dot cleared). Repeat; choose Keep-mine then Ctrl+S →
      your version wins.
- [ ] Delete the file on disk while its tab is open → save recreates it;
      restore-after-kill shows the error notice, not a crash.
- [ ] Dirty file tab + close (Ctrl+W) → save/discard/cancel prompt; all
      three paths behave.
- [ ] Explorer drag ACROSS workspaces: drag a file from one workspace onto a
      folder row (and onto the header) of another → confirm → the file lands
      there and its tab follows. Repeat with the two workspaces on DIFFERENT
      drives (C: → D:) — the move still works.
- [ ] Drag a NOTE tab's file out of the Notes workspace → the tab becomes a
      plain file tab (renaming the tab no longer renames the file); wait 5s,
      then close the tab → the moved file is still there.
- [ ] Rename a file and a folder to the SAME name with different capitals
      (`notes` → `Notes`) → the sidebar shows the new spelling, no "already
      exists" notice, and an open tab from that folder still saves.
- [ ] CLOUD STORAGE (a workspace inside Google Drive `G:\My Drive\…` and one
      inside OneDrive): rename a file, rename it again changing only capitals,
      rename a folder, drag a file from the cloud workspace onto a local one
      and back. Each succeeds and the sidebar shows the result; a failure
      notice must name the reason ("Could not move …: io error: …"), never a
      bare "Could not move".

## M4 — Preview

- [ ] Kitchen-sink doc (headings, table, task list, strikethrough,
      autolink, blockquote, fenced code with language, hr, footnote):
      everything renders in GFM style; preview updates ≤300ms after
      typing pauses; no scroll jumping while typing.
- [ ] ```mermaid flowchart renders as a diagram. While typing it
      half-finished: red-bordered error box with message + source, no
      console spam; completing the code heals it live.
- [ ] Doc WITHOUT mermaid: `dist/assets` check (release build) or devtools
      network: mermaid chunk not loaded until a mermaid block exists (I8).
- [ ] Theme flip re-renders diagrams in matching colors.
- [ ] `<script>alert(1)</script>`, `<img src=x onerror=alert(1)>`,
      `[x](javascript:alert(1))` → all inert (I6).
- [ ] `https://` link click → system browser opens, app doesn't navigate;
      relative/anchor links do nothing.
- [ ] Split divider drags; layout persists while switching tabs; raw⇄split
      toggle keeps editor state (same instance, I7).

## M5 — WYSIWYG

- [ ] **Byte-identity drill**: open a heavily formatted note, switch to
      wysiwyg, scroll/click/select for 30s WITHOUT editing, switch back →
      `git diff`/file compare of the note file after flush shows ZERO
      change (I2); no dirty dot on a file tab under the same drill.
- [ ] First keystroke in wysiwyg: normalization hint appears once for that
      tab, not again; content preserved (formatting may re-shape).
- [ ] Type rapidly then IMMEDIATELY switch to raw → last keystrokes present.
- [ ] Tables: edit cells via Crepe UI; back in raw: valid GFM pipe table.
- [ ] Task list checkbox toggles → serializes `- [x]` / `- [ ]`.
- [ ] Mermaid block in wysiwyg shows as a code block (not rendered) and
      survives a wysiwyg edit elsewhere in the doc.
- [ ] Mash mod+1/2/3 for 10s while typing → no text loss, no crash, mode
      lands on the last pressed.
- [ ] First wysiwyg use loads the milkdown chunk (devtools); raw/split-only
      sessions never load it (I8).
- [ ] GFM round-trip audit performed; any dropped construct listed in root
      README known limitations.

## M6 — Settings

- [ ] Every setting: change → immediate effect → restart → persisted.
- [ ] Corrupt settings.json → defaults, no crash, file healed on next save.
- [ ] Notes-dir change with 5+ notes: "move" flow moves files, session
      intact after restart; a locked/duplicate file is reported and left
      behind gracefully.
- [ ] Ligatures OFF → `->` renders as two glyphs everywhere (editor,
      preview, wysiwyg).
- [ ] Font size mod+= / mod+- / mod+0 affects all three modes and persists.
- [ ] Word wrap toggle affects raw/split immediately.
- [ ] Settings → Harness (desktop): six harness rows + Custom…, radio semantics
      (one selected; the new-tab Harness row's label follows). Harnesses on PATH
      show ✓ + path; ones not on PATH are dimmed with an **Install** button; a
      fresh launch shows neither for an instant, then fills in (no start-up
      delay). Re-check flips a row after installing/uninstalling by hand.
- [ ] Automatic default (never-configured profile, `harness` absent from
      settings.json): with Claude on PATH the row says Claude; with Claude gone
      and codex present it says ChatGPT; with neither, the first other harness
      found. The pick is written to settings.json once and then never moves on
      its own — installing a second harness does not change it.
- [ ] No harness installed at all: the new-tab menu's **Harness** row is
      labelled "Harness" and opens Settings on the Harness tab (not a terminal).
      Install one from there → the row launches it.
- [ ] Harness → Install on a missing harness: a new terminal tab opens in the
      default workspace, the shell prompt appears, then the official install
      command is typed and runs (correct dialect for PowerShell / cmd / bash).
      Closing that tab re-checks and un-dims the row without a restart —
      including when the installer added a new PATH directory (Windows).
- [ ] Harness / AI theme tabs render 2px larger than the editor font; Ctrl+= /
      Ctrl+- in the pane still zooms from there; a plain shell tab is unchanged.
- [ ] Perf spot-check: cold start (release build) feels ≈1s; typing in a
      1MB doc has no visible lag; idle RAM (Task Manager, all processes
      summed) < 150MB on Windows.

## M7 — Packaging & release

- [ ] `pnpm run tauri build` locally: installer produced, installs, runs,
      uninstalls cleanly.
- [ ] Tag drill (`v0.1.0-rc.*`): draft release contains exe + dmg + deb +
      rpm + AppImage + `latest.json` + `.sig` per updater asset +
      `SHA256SUMS`.
- [ ] `sha256sum -c` and `gh attestation verify` pass for every asset.
- [ ] Clean Windows 11 VM: SmartScreen → Run anyway → installs; `.md`
      double-click opens in MD Specpad (file association).
- [ ] Stock Ubuntu LTS: AppImage runs; deb installs.
- [ ] macOS: right-click-Open works; universal binary (check both archs if
      hardware allows).
- [ ] Updater drill: install rc.N, publish rc.N+1 → app offers update,
      installs, relaunches into N+1.
- [ ] Full M1–M6 checklist re-run on the release build of the primary OS.

## M8 — Multi-window tab tear-off

- [ ] Windows/macOS: pull a tab vertically ~40px past the bar (M8.6 live
      tear-off) → the tab becomes a real window IMMEDIATELY, riding the
      cursor; releasing drops it there (text, mode, cursor intact); the
      source window no longer has it. Side-to-side never tears — it reorders.
- [ ] Windows/macOS: while riding, release the torn-off window over ANOTHER
      app window → that window adopts the tab and the torn-off window closes.
- [ ] Windows/macOS: drag a window's ONLY tab vertically → the WHOLE window
      moves (no tear-off, no fresh-Untitled leftover).
- [ ] Drag a tab out of the window and release → a new window opens at the
      drop point (on Windows/macOS this is the horizontal-exit path; on
      Linux it is EVERY drag-out).
- [ ] Right-click a tab → "Move to new window" does the same (OS-placed).
- [ ] Tear off a DIRTY file tab → the new window shows the unsaved edits,
      dirty dot intact; Ctrl+S there writes the file once.
- [ ] Tear off an unflushed note ("Buy milk", immediately drag out) → the
      note file exists and the new window owns it; no duplicate in source.
- [ ] Tear off a TERMINAL tab (run `echo test` first) → the new window shows
      the SAME shell: the scrollback is there, the shell did not restart, and
      typing still lands in it. Repeat with a long-running command (`ping -t`
      / `sleep 60`) → it keeps running across the move; and with a split
      terminal → both panes come over live.
- [ ] Tear off a Harness tab mid-session → the agent's screen and its
      conversation survive the move (a full-screen TUI may need one keystroke
      to repaint).
- [ ] Drop a terminal tab onto ANOTHER window, then drag it back → the shell
      survives both hops. Closing the tab (or the window) still kills it.
- [ ] In a WINDOW THAT HAS JUST OPENED, terminal text is aligned: even
      spacing, nothing overlapping, caret directly after the prompt. A pane
      that mounts before the web font loads measured the wrong cell (see
      src/renderer/README.md) — the tell is runs sliding into each other,
      worse the further right they sit.
- [ ] Type in both windows simultaneously → each window's notes flush;
      `sessionDir` shows `session.json` plus one `session-w-*.json`.
- [ ] Quit via the MAIN window's X with a torn-off window open → both close;
      relaunch restores BOTH windows (tabs, active tab, geometry).
- [ ] **Kill drill with two windows**: type in both, kill, relaunch → both
      windows return with ≤ ~5s text loss each.
- [ ] Close a torn-off window with its X → its tabs CLOSE with it (no
      handoff; note files keep their text); its `session-w-*.json` is gone;
      relaunch does NOT resurrect the window. Exception: the LAST window
      standing folds its tabs into main's manifest instead.
- [ ] Tear a tab off, then in the torn-off window close its last real tab →
      window shows a fresh Untitled (Notepad invariant holds per window).
- [ ] Settings change in one window (theme, editor font) → the other window
      follows within ~a second.
- [ ] Update check / notes-folder change attempted from a torn-off window →
      notes-folder change is refused with a pointer to the main window.
- [ ] Double-click a `.md` in the file manager while both windows are open →
      it opens in the MAIN window.
- [ ] Linux: NO live tear-off (reverted — see src/ui/README.md): a vertical
      pull inside the window does nothing until the cursor leaves the
      window; releasing outside tears off (compositor-placed). Drop-onto-
      window by drag never happens there — the context-menu
      "Move to window …" is the route.
- [ ] Chrome text never selects: dragging a tab across the ribbon (B/I/S…),
      the bar, or an open menu selects/ghosts no text.

## QoL — Palette, outline, search, export

- [ ] Ctrl+K opens the command palette; typing filters fuzzily ("nwt" finds
      "New tab"); ArrowUp/Down wrap; Enter runs and closes; Esc closes;
      Ctrl+K again while open closes. While open, global shortcuts
      (Ctrl+N, Ctrl+W…) do NOT fire.
- [ ] Palette shows platform-correct shortcut hints; commands needing an
      active tab (Save, Rename tab…) are absent/disabled on an image tab.
- [ ] Ctrl+Shift+O toggles the outline panel; headings indent by level;
      headings inside ``` fences and YAML frontmatter do NOT appear.
- [ ] Outline click in raw/split → editor scrolls to the heading line
      (centered, focused). In Review mode → preview scrolls. In wysiwyg →
      rendered heading scrolls. Editing a heading updates the outline
      ≤ ~300ms after the pause.
- [ ] Ctrl+Shift+F opens workspace search (Ctrl+F still opens CM6's
      in-document search). Two chars minimum; results grouped by file with
      line numbers; footer shows match count.
- [ ] Search click on a closed file → file opens AND jumps to the line;
      on an already-open tab → jumps without reopening. Results from a
      second workspace open correctly.
- [ ] Search a workspace containing a `.comments.md` sidecar and a dotfile
      → neither appears in results.
- [ ] Palette → "Export as HTML" on a note with a table, code block,
      image, and mermaid diagram → save dialog suggests `<title>.html`;
      the file opens standalone in a browser: styles present, image
      embedded (works offline), diagram rendered. Dark theme active at
      export time → dark page.
- [ ] `<script>alert(1)</script>` in the source note → inert in the
      exported HTML (sanitizer applies to exports).
- [ ] Palette → "Print / Save as PDF" → the system print dialog appears
      over the app; Save-as-PDF produces a readable PDF; app usable after
      closing the dialog.
- [ ] Android: ribbon buttons open palette / outline / search; "Print /
      Save as PDF" is not offered; "Export as HTML" works via SAF save.

## Terminal — light themes and AI agents

Run these with a light theme selected (**Light Green** and **Beacon** are the
two extremes: a tinted near-white surface and pure white). Repeat the first
three on a dark theme to confirm nothing regressed.

- [ ] `echo -e '\e]11;?\a'` in a terminal tab prints the theme's surface color
      as `rgb:RRRR/GGGG/BBBB`. Switch theme (⌄ → Themes) without restarting the
      shell and run it again → the NEW color, no shell restart needed.
- [ ] `printf '\e[?996n'` prints `^[[?997;2n` under a light theme and
      `^[[?997;1n` under a dark one.
- [ ] `echo $COLORFGBG` in a fresh terminal tab → `0;15` on a light theme,
      `15;0` on a dark one. Set `COLORFGBG` in a terminal profile's `env` →
      the profile's value is what the shell sees.
- [ ] Run a color test (`for i in $(seq 0 15); do printf "\e[3${i}m%02d " $i;
      done`) on a light theme: every number is comfortably readable, including
      7 (white) and 15 (bright white). Nothing is a pale ghost.
- [ ] `ls --color`, `git log --oneline --decorate`, `git diff` on a light
      theme: added/removed lines, branch names and hashes are all readable.
- [ ] Harness tab with **Claude Code** on a light theme: with `/theme` set to
      `auto` it comes up light. `/theme` → `light-ansi` follows this theme's
      own palette. Check the input box, the "thinking" spinner, and dim
      helper text ("esc to interrupt") — dim must be *fainter* than body
      text, never darker/heavier.
- [ ] Same with **GitHub Copilot CLI**: it should start light. If it starts
      dark, `/theme` once — it paints in fixed 24-bit color, so a wrong guess
      cannot be fixed by the palette.
- [ ] Switch from a light theme to a dark one while an agent is running: the
      console surface and any palette-colored output re-theme immediately; an
      agent that supports live re-theming (opencode) follows.
- [ ] A TUI that paints on an ANSI-black background (`printf '\e[40;37m bar
      \e[0m'`) is the known trade-off on light themes: readable, but low
      contrast. Confirm it is not *invisible*.

## Terminal — shell integration, workspace cue, right-click helpers

- [ ] New terminal (plain shell) with two colored workspaces open → the tab
      wears the color of the workspace it started in. `cd` into a folder of
      the OTHER workspace → the tab changes color when the prompt returns.
      `cd` to your home folder (outside every workspace) → no color. `cd`
      back → color returns. Tooltip on the tab shows the current folder.
- [ ] Same check on each shell your OS offers in Settings → Terminal → Shell
      (Windows: pwsh, Windows PowerShell, cmd; macOS: zsh, bash, fish;
      Linux: bash, zsh, fish). The prompt looks exactly as before (your
      `$PROFILE` / `.bashrc` / `.zshrc` / `config.fish` still ran); no
      stray `]7;` text is visible; PowerShell shows no logo banner.
- [ ] A shell whose prompt shows the last command's status (e.g.
      oh-my-posh / starship, or `function prompt { if ($?) {'ok> '} else
      {'bad> '} }`) still reports failures correctly after a failing command.
- [ ] Split pane (Ctrl+Shift+D), `cd` into another workspace in the new
      pane → tab recolors; click the first pane → tab shows the first pane's
      workspace again. Close a pane → the survivor's folder decides.
- [ ] Restart the app with a terminal tab open → the restored tab wears the
      recorded pane's workspace color before the shell's first prompt.
- [ ] With Settings → Arrange tabs by workspace ON: a terminal that `cd`s
      into a workspace moves next to that workspace's tabs; one that leaves
      every workspace stays where it is.
- [ ] Right-click a plain-shell pane → below Clear scrollback: **Change
      directory…**, **List files**, **Open <agent>**, each with a tooltip
      naming the exact command. Right-click a harness tab (or a shell running
      `vim` / `less`) → those three items are absent.
- [ ] **List files** types `ls` (PowerShell) / `dir` (cmd) / `ls -l` (POSIX)
      and it runs — even with bracketed paste on (PSReadLine, zsh, bash 5.1+).
- [ ] **Change directory…** → picker opens at the pane's current folder. Pick
      a subfolder of the workspace you're in → a RELATIVE `cd` (`cd sub`,
      `cd ..\other` / `cd ../other`). Pick a folder in another workspace or on
      another drive → an ABSOLUTE `cd`. A folder with spaces → quoted for the
      shell (`cd 'C:\My Notes'`, cmd: `cd /d "C:\My Notes"`). Cancel → nothing
      typed. The tab recolors after the `cd`.
- [ ] **Open <agent>** types the configured harness command (Settings → Harness;
      a custom command with spaces/args is quoted correctly) and the agent
      starts. With an EMPTY custom command the item is absent.
- [ ] A terminal profile in `settings.json` that names its own `program`
      (e.g. `pwsh.exe`) starts with no integration args and no helpers —
      the opt-out route.
- [ ] `<appDataDir>/shell-integration/` holds `bash/bashrc` and
      `zsh/.zshenv`, `.zprofile`, `.zshrc` after the first bash/zsh terminal;
      hand-edit one, open another terminal → it is NOT rewritten until the
      app restarts (once per process), and IS rewritten after a restart.

## Drawing (SVG whiteboard)

- [ ] New vector drawing (blank board), then draw a pen stroke AND a rect with
      the mouse. Each stays on the board after the button is released — the
      overlay that shows the in-progress shape must be transparent even though
      the board's own palette stylesheet paints `svg.wb-board` surfaces.
      Repeat after toggling the ◐ colour-mode button (fixed colours) and in a
      dark theme.

## Mobile (Android)

- [ ] Tap the editor text → the soft keyboard opens and the caret lands where
      tapped. Double-tap the text → the keyboard retracts and the full document
      is visible; no word stays selected.
- [ ] After a double-tap dismiss, tap the text again → the keyboard reopens and
      typing continues normally.
- [ ] Scroll the document with a drag (a moving gesture, not two taps) → the
      keyboard is NOT dismissed mid-scroll.
- [ ] Desktop regression: double-CLICK with a mouse still selects a word (the
      dismiss gesture is touch-only and must not fire).
