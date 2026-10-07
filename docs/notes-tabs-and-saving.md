# Notes, tabs, and saving

MD Specpad works with two kinds of tabs: **notes** and **files**. Knowing
the difference explains everything about saving.

## Notes — the tabs you never save

Any tab you create with **Ctrl+N** (Cmd+N on Mac) or the `+` button is a
*note*. Notes save themselves:

- Everything you type is stored on your computer automatically, within a few
  seconds of typing it.
- Quit the app, restart your computer, even lose power — your notes come
  back, tabs and all.
- Each note is quietly kept as a real markdown file in your **notes folder**
  (you can see and change that folder in Settings). The file is named after
  the note's first line.

**Closing a note deletes it.** That's the Notepad way: a note lives exactly
as long as its tab. The app asks you to confirm before discarding a note
that has any text in it. If you want to keep a note *and* close its tab,
save it as a file first (Ctrl+Shift+S) — see below.

## Files — regular documents you open and save

Open an existing markdown document with **Ctrl+O**, by dragging it onto the
window, or by double-clicking it in your system's file manager. That tab is a
*file* tab, and it behaves like a traditional editor:

- Your edits are **not** written to the file until you press **Ctrl+S**.
- A dot on the tab means "you have unsaved changes".
- Closing the tab with unsaved changes asks whether to save, discard, or
  cancel.
- Even here you're protected: unsaved edits survive a crash or restart —
  the tab reopens with your edits still in it, still marked unsaved.

Prefer files to save themselves too? Turn on **Live save** in Settings — or
press and hold the toolbar's save button and pick **Auto save** — and open
files are written automatically as you type, like notes.

### Live edit: working on one file together

Keep a folder in Google Drive or OneDrive that several people share? Add it
to the sidebar as a workspace, right-click its heading and turn on
**Live edit (shared folder)**. Every file you open from that folder then:

- saves itself as you type (whatever the Live save setting says), and
- watches the file on disk, so when someone else's save arrives it is
  **merged into your editor** rather than reported as a conflict — their new
  lines glow briefly in the accent colour, a **Live** chip in the status bar
  pulses, and your caret stays where it was.

Edits to different lines simply combine. Lines someone else deleted or
rewrote glow red for a moment before they go, so nothing vanishes without
you seeing it. If you and someone else changed the very same lines, the
version on disk wins (that is the only rule under which both computers end
up with the same text) — but a bar appears above the editor: **Another
editor replaced N lines you wrote — Restore mine / Dismiss**. Restore mine
puts your lines back, right after theirs, so you can decide which to keep.
Ctrl+Z also still undoes the change like any other edit.

To make a single file live without flagging its whole folder — or to switch
it off for one file inside a live folder — press and hold the save button and
pick **Live edit (shared file)**. The choice sticks to that tab.

A few honest limits: changes travel at the speed of your sync client, so
expect a few seconds' delay; a file is only watched while it is open; and if
both of you save inside the same second the sync client may still leave one
of its own "conflicted copy" files in the folder.

### The save button

The toolbar's floppy-disk button saves the current document, and its icon also
tells you which mode you're in: a plain floppy means you save (Ctrl+S), and a
floppy with a small circular arrow, drawn in the accent colour, means auto save
is on and the app is saving for you. Press and hold it (or right-click) to
toggle auto save or to reach Save As.

### Save and Save As

- **Ctrl+S** — save the current file. On a *note* tab this acts as Save As,
  turning the note into a regular file wherever you choose.
- **Ctrl+Shift+S** — Save As: save a copy under a new name or location. The
  tab switches over to the new file.

### Export and print

- **Export as HTML** — **right-click the tab → Export…** (or the command
  palette) saves the document as a single standalone `.html` file: styling is
  built in, local images are embedded, and mermaid diagrams are rendered —
  ready to share or open in any browser.
- **Print / Save as PDF** — in the command palette (desktop only). Opens the
  system print dialog with a clean, print-styled copy of the document; on
  Windows the dialog includes "Save as PDF". On Android, use Export as HTML
  instead.

### If a file changes behind your back

If another program (or a sync service like Dropbox) changes a file while
you have it open, a banner appears at the top of that tab:

- **Reload** — throw away your version and load what's on disk.
- **Keep mine** — keep your version; the file is overwritten the next time
  you save.

## Working with tabs

- **New tab**: Ctrl+N or the `+` button.
- **Switch tabs**: click, or Ctrl+Tab / Ctrl+Shift+Tab to cycle.
- **Close**: the × on the tab, Ctrl+W, or middle-click. Closing the last tab
  always leaves one fresh empty note.
- **Close all**: right-click a tab for the menu, or right-click the empty
  space in the tab bar.
- **Tab bar menu**: right-click the empty space beside the tabs for New tab,
  the command palette, Themes, Settings, full screen, and Close all tabs.
- **Reorder**: drag tabs left and right.
- **Rename**: double-click the tab name, press F2, or right-click →
  Rename. Renaming also renames the file on disk, so tab and file always
  match. Rename a note to a blank name to go back to automatic naming.

## Multiple windows

Want two documents side by side? Drag a tab out of the window and release
it — the tab opens in its own window right where you dropped it. You can
also right-click a tab and pick **Move to new window** (on Linux this menu
item is the way to do it).

Extra windows are full editors: everything above about notes, files, and
saving applies in each one. They're part of your session too — quit the app
and they come back, tabs and all. Closing an extra window with its × doesn't
lose anything: its tabs slide back into the main window.

Your notes are ordinary markdown files in your notes folder — you can back
them up, sync them, or open them in any other app whenever you like.
