# Workspaces and the file browser

Click the **folder** button (top-left) to open the sidebar — a file browser for
your notes and any other folders you care about.

## What's in the sidebar

- **Notes** — your notes folder, always at the top. Every note tab you've
  written lives here as a markdown file.
- **Workspaces you add** — any other folder on your computer. Click the `+`
  at the top of the sidebar and pick a folder; it appears as its own
  section. A workspace is just a window onto that folder — nothing is
  copied or moved.
- **Documentation** — this user guide, if you've opened it from Settings.
  It's read-only.

Handy things to know:

- Click a section heading to collapse or expand it. Click a folder to see
  inside it. The **double chevron** at the top of the drawer shuts the whole
  tree at once (▲▲); press it again (▼▼) to reopen the workspaces.
- **Single-click** a file to peek at it: it opens in a *preview* tab (shown
  in italics) that gets reused as you click around, so you don't pile up
  tabs. **Double-click** — or just start editing — to keep it open for
  real. (You can turn preview tabs off in Settings.)
- Files you have open are highlighted; the one you're looking at is
  highlighted more.
- Drag the sidebar's right edge to make it wider or narrower.

## Giving workspaces colors

Right-click a workspace heading and pick a color swatch. The workspace gets
a colored stripe so you can tell your sections apart at a glance. New
workspaces pick an unused color automatically.

The color follows your files into the **tab strip**: every open tab wears a
stripe and a faint wash in the color of the workspace its file lives in, so you
can see at a glance which project a tab belongs to. If you'd also like tabs from
one workspace kept side by side, turn on **Arrange tabs by workspace** in
Settings → Behavior; otherwise tabs stay wherever you drag them.

## Sharing a folder with other people (Live edit)

For a workspace that lives in a shared Google Drive or OneDrive folder,
right-click its heading and turn on **Live edit (shared folder)**. Files
opened from it save as you type and merge the changes other people save,
while you both have the file open — see
[Live edit](notes-tabs-and-saving.md#live-edit-working-on-one-file-together).

## Showing other files (code, configs…)

The sidebar normally lists only what the app is made for: markdown and text
notes, images, drawings, and PDF/Word documents to import. To see everything
else too — `.js`, `.ts`, `.json`, `.rc`, files with no extension — right-click
a workspace heading (or any folder) and turn on **Show unsupported files**. It
applies to that folder and every folder inside it.

You can still hide them folder by folder: right-click a folder inside and
turn the option off there (or back on). Changing it on a workspace heading —
or any folder — resets everything inside it, so all its folders follow it
again.

These files open as plain text in the source editor (no Edit or preview
modes) and save like any other file. A file that isn't text at all — a
program, a zip — won't open; you'll get a notice saying so.

## Creating, renaming, moving, deleting

Right-click gets you everywhere:

- **Right-click a workspace or folder** → **New** → **Markdown File** or
  **Folder** (the same page also makes a vector drawing, a Marp presentation,
  a terminal, or an AI session in that folder). A new file opens immediately with its name ready to
  type.
- **Right-click a file** → **Rename**, **Reveal in explorer** (shows the
  file in your system's file manager), or **Delete** (delete asks first —
  there is no undo). Renaming to the same word with different capitals
  (`notes` → `Notes`) works too.
- **Drag a file onto a folder** (or a workspace heading) to move it there —
  including a folder in a *different* workspace, even one on another drive.
  The app asks before moving; you can turn that question off in Settings.
  Note tabs that leave the Notes folder become ordinary file tabs (they keep
  their file; only the "the tab title names the file" behavior stops).
- **Cloud-synced folders** (Google Drive, OneDrive, Dropbox) work like any
  other workspace, including the capitals-only rename and moves to and from a
  local folder. If a rename or move does fail there, the notice quotes the
  filesystem's own reason so you can tell a sync lock from a real collision.

## Getting files in from elsewhere

- **Drag files from your computer** onto a workspace or folder in the
  sidebar to **copy** them in. Markdown files, plain text (`.txt`)
  files, and images are accepted; anything else is skipped. The originals stay where they were.
- **Drop a document anywhere else** in the window (over the editor, say)
  to just open it in a tab without copying anything.
- **Paste** works too: copy a file or a screenshot, click the workspace or
  folder you want it in, and press Ctrl+V.
- **Drop an image onto a markdown file's row** in the sidebar to attach the
  picture to the end of that document (it asks first).

## Setting a workspace up for AI agents

AI coding agents (Claude Code, Codex, Gemini CLI…) read a file called
`AGENTS.md` in the folder they work in. **Create new workspace…** (the **+**
in the sidebar header, or the command palette, `Ctrl+Shift+P`) writes one for
you; **Initialize workspace…** does the same for a folder you pick later:

1. **Choose or create a folder.** It becomes a workspace in the sidebar.
2. **Tick the directives** the agent should follow:
   - **File manifest** — the agent keeps `MANIFEST.md`, a list of what every
     file is for.
   - **Changelog** — the agent adds a line to `CHANGELOG.md` for every change
     you would notice.
   - **Memory / lessons learned** — `LESSONS.md` carries what the agent learns
     from one session to the next.
   - **Git worktree workflow** — for code projects where several agents work
     at once.
   - **Marp presentations** — how to write slide decks this app can show,
     edit and present (see [Editing modes](editing-modes.md)); it also drops
     in `decks/example-deck.md` as the reference.
   - **Your own** — any `.md` file you put in *your directives folder* (the
     link in the dialog opens it) appears in the list.
3. **Create.** Besides `AGENTS.md` you get a one-line `CLAUDE.md` and
   `GEMINI.md` that point at it, so those tools pick it up too.

To change your mind later, right-click the workspace → **Workspace
directives…**. Ticking adds a section, unticking removes it. Anything you
wrote in `AGENTS.md` yourself stays, and files the agent has filled in are
never overwritten.

## Removing a workspace

Right-click the workspace heading → **Remove workspace**. This only removes
the section from the sidebar — the folder and every file in it stay exactly
where they are on your computer. (The built-in Notes section can't be
removed.)

## The read-only Documentation workspace

This guide appears as a workspace named **Documentation** (Settings →
**Open docs**). Because it's part of the app, it works a little
differently: its pages open in Review mode and can't be edited, renamed,
moved, or deleted, and you can't add files to it. Everything else — reading,
searching, copying text out — works as usual.
