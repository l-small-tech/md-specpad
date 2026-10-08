# Settings

Open Settings from the **⌄ menu** beside the `+` button on the tab bar
(**Settings**), or press **Ctrl+,** (Cmd+, on Mac). Changes apply immediately —
there's no OK button to press — and are remembered. Press Esc or click outside
the panel to close it.

The dialog is split into tabs along its top — **Appearance**, **Editor**,
**Files**, **Voice notes**, **Terminal**, **Harness** and **Updates** (the last
three only on desktop) — and reopens on the tab you last used. The **Open Docs**
button in its header opens this guide.

## Appearance

- **Theme** — one list that combines the light/dark mode and the color scheme:
  - **System** follows your computer's light/dark setting, switching live
    when it changes, using the app's built-in green palette.
  - Below it every theme is grouped by its declared mode: **Light**
    (**Light Green**, **Beacon**, **Skylark**, **Lagoon**, **Marmalade**,
    **Honeycomb**, **Ultramarine**, **Dragonfruit**) and **Dark** (**Dark
    Green**, **Vantablack**, **Nightjar**, **Abyss**, **Garnet**, **Cyanotype**,
    **Amethyst**) — themes you add yourself join the group their `mode`
    declares. They all ship as example *theme files* you can edit, and each
    keeps its one look — light or dark — whatever your computer's light/dark
    setting.

  See **[Themes](themes.md)** for how to make your own (an AI can write one for
  you in seconds) — a theme can set the whole palette *and* recolor individual
  markdown elements (headings, bold, links, …). The same list — plus the
  **Open harness here**, **Reload**, and **Help** buttons — lives in
  the **⌄ menu → Themes** (the arrow beside the `+` button on the tab bar).
- **This window only** — a theme normally applies to every open window and is
  remembered for next launch. Tick this box (or **right-click** a theme in the
  **⌄ menu → Themes** list) to dress just the window you're in — handy for
  telling two windows apart at a glance. The other
  windows keep the shared theme, and picking further themes here keeps
  affecting only this window until you untick the box (or choose **Use shared
  theme** in that menu). A window-only theme lasts as long as the window: on
  the next launch it follows the shared theme again.
- **Font size** — the size of text in the editor and previews. You can also
  change it any time with **Ctrl+=** / **Ctrl+-** (and **Ctrl+0** to
  reset), which is especially handy in Review mode.
- **Editor font** — the typeface for your notes, in the editor and in
  previews. Seven open-source coding fonts ship with the app: **Fira Code**
  (the default, and our recommendation), JetBrains Mono, Cascadia Code,
  Source Code Pro, IBM Plex Mono, Inconsolata, and Victor Mono (known for
  its cursive italics).
- **Interface font** — the typeface for the app's own chrome: tabs, the
  sidebar, dialogs. **Match editor font** (the default) keeps the classic
  monospace-everywhere look; **Inter** is a clean sans-serif made for user
  interfaces, worth trying if you'd like the chrome to stay out of the way
  of your text; **System sans-serif** uses your operating system's UI font.
- **Font ligatures** — fonts that support it (Fira Code, JetBrains Mono,
  Cascadia Code, Victor Mono) can join character pairs like `->` into a
  single arrow glyph. Purely cosmetic; turn it off if you prefer to see
  the characters as typed.
- **Review mode margins** — how wide the text column is in Review mode:
  **Narrow** margins put more text on screen, **Normal** (the default) is in
  between, and **Wide** margins give a centered, book-like column.

## Editor

- **Default mode (new tabs)** — which of the four viewing modes
  ([explained here](editing-modes.md)) a new tab starts in: Raw, Split,
  Edit, or Review.
- **Cursor style** — the shape of the editing caret: **Bar** (the default, a
  slim vertical line), **Thin** (a hairline bar), **Thick** (a bold bar), or
  **Underscore** (an underline beneath the character).
- **Word wrap** — when on (the default), long lines wrap to fit the window.
  When off, long lines run sideways and you scroll horizontally.
- **Collapsible headings** — off by default. When on, Raw and Split modes
  get a fold gutter next to the text: move the mouse over the gutter column
  and click the arrow beside a heading to collapse everything under it up to
  the next heading of the same level (lists, code blocks, quotes and tables
  fold too), just like functions in a code editor. The arrows stay out of sight until the
  pointer is over the gutter; a collapsed section's arrow always shows. Ctrl+Shift+[
  and Ctrl+Shift+] fold and unfold the section the caret is in; Ctrl+Alt+[ and
  Ctrl+Alt+] fold and unfold them all. A heading you mark **running** (see
  [Editing modes](editing-modes.md#marking-headings-running-focus-backburner-complete))
  collapses on its own the moment the mark lands, whether you set it from the
  right-click menu or an AI agent writes it into the file. On a Mac the fold
  chords are Cmd+Alt+[ and Cmd+Alt+].
- **Line numbers** — off by default. When on, Raw and Split modes show a
  line-number gutter beside the text.
- **Smooth scrolling** — on by default; eases scrolling in the editor, the
  preview and terminal panes.
- **Arrange tabs by workspace** — off by default, so tabs stay wherever you
  drag them. Turn it on and the tabs of one workspace are kept side by side:
  opening or dragging a tab slots it next to the others from its folder. Either
  way, a tab always wears the color of the workspace its file lives in, so the
  strip reads like the sidebar.
- **Preview tabs** — when on (the default), single-clicking a file in the
  sidebar opens it in a reusable, italicized preview tab, and double-click
  (or editing) keeps it open permanently. When off, every click opens its
  own tab.

## Files

- **Live save** — when on, files you've opened save themselves as you type,
  just like notes do. When off (the default), files wait for Ctrl+S. You can
  also flip it without opening Settings: press and hold the toolbar's save
  button and pick **Auto save**. (A workspace marked **Live edit** in the
  sidebar saves its files as you type regardless — see
  [Live edit](notes-tabs-and-saving.md#live-edit-working-on-one-file-together).)
- **Confirm before moving files between folders** — whether dragging a file
  to a new folder in the sidebar asks "are you sure?" first.
- **Pasted / dropped images** — where pictures you paste or drag in are
  stored, relative to the note that uses them. See
  [Pictures in your notes](pictures-and-images.md).
- **Image folder name** — the name of the images folder used by the
  "subfolder" and "workspace root" choices.
- **Review baseline branch** — which branch a code file's "what changed" view
  compares against. Leave it empty (the default) and md-specpad looks for
  `development`, then `main`, then `master`. Only used when the file lives in a
  git repository and git is installed; on Android the view is hidden.
- **Notes folder** — shows where your notes live, with a **Change…** button
  to move them. When you pick a new folder the app offers to bring your
  existing notes along. The default location is inside your personal app-data
  folder; many people point it at a synced folder (Dropbox, OneDrive, etc.)
  instead so notes follow them between computers.

## Voice notes

Voice notes are dictated comments about a line of a document, made in Review
mode: turn on the toolbar's voice-notes button, press and hold a line, then
tap the microphone to start and again to finish. Your speech is turned into
text and no audio is kept. The document itself is never changed; each note
goes into a separate `<name>.comments.md` file that names the document, the
line, a quote of that line and the time — ready for a person or an AI agent
to act on. Each file opens with a hidden note saying it came from a voice
transcript and may contain small recognition errors, so an agent reading it
knows to read for intent.

- **Android** turns speech into text on the phone with the device's own
  recognizer, or with Whisper if you choose it below.
- **Windows** uses Windows voice typing (the Win+H feature) unless you pick
  Whisper below. When you tap the microphone, md-specpad starts it and your
  words appear in a box under the microphone, where you can fix them. The
  note saves by itself a few seconds after voice typing stops (when you stop
  talking, or click its own microphone button), or tap the microphone again
  to finish sooner. Voice typing may need **Online speech recognition**
  turned on in Windows Settings > Privacy & security > Speech, and while you
  speak your voice is sent to Microsoft to be transcribed.
- **macOS and Linux** (and Windows or Android, if you choose it) use
  **Whisper**: an open speech model that runs on your own computer, offline.
  Tap the microphone, talk, tap again, and the note appears after a moment
  of transcribing. It needs a model file, downloaded once — the first time
  the app opens it offers to fetch the recommended one, and this section
  can do it any time.

- **Keep voice notes** — where the notes files are kept. **Shared folder at
  workspace root** (the default) collects them in one folder at the top of
  the workspace, mirroring the document's sub-folders inside it. **Next to
  the file** keeps each one beside its document, hidden from the sidebar.
- **Voice notes folder name** — the shared folder's name. Default
  `Voice Notes`.
- **Transcription engine** — on desktop, **Automatic** is Windows voice
  typing on Windows and Whisper elsewhere; **Windows voice typing** (Windows
  only) and **Whisper (offline)** choose one outright. On Android, **This
  device's speech recognizer** (the default, no download) or **Whisper
  (offline)**.
- **Run on the GPU** — shown when the app can use one (Vulkan on Windows and
  Linux, Metal on macOS). On, Whisper transcribes several times faster; turn
  it off only if transcription fails or a graphics driver misbehaves.
  Setting the environment variable `MD_SPECPAD_NO_VULKAN` before starting
  the app (Windows) keeps it from loading Vulkan at all.
- **Whisper models** — the models you can download, with their size and a
  rough speed. **Small (English)** is the recommended balance (190 MB; a
  30-second note takes about ten seconds on a laptop's CPU, a couple on its
  GPU). Tiny and Base are faster and less accurate — good on a phone; Large
  v3 Turbo (570 MB) is the most accurate and understands any language.
  Every file is the compact ("quantized") version of its model: a fraction
  of the size for a difference you will not hear. **Download** fetches a
  model from Hugging Face and verifies it; a download can be cancelled and
  resumed later. **Use** makes an installed model the one that transcribes;
  **Delete** removes its file. **Open folder** shows where the files live
  (`whisper` inside the app's data folder). If an earlier version left
  larger model files behind, a **Remove** button under the list clears
  them. No audio is ever saved, and nothing about your notes leaves the
  computer.

## Terminal (desktop only)

Terminal tabs have their own group of settings; none of these exist on
Android, which has no terminal.

- **Shell** — the shell every terminal runs. **Automatic** picks your
  system's usual one (PowerShell 7 on Windows, zsh on macOS, bash on Linux);
  the list offers the common alternatives, and **Custom…** takes any program
  name or full path. Applies to terminals opened from now on.
- **Font** — the typeface for terminal text. **Fira Code** by default —
  terminals want box-drawing and column alignment more than prose does — or
  **Match editor font** to follow your notes. The *size* always follows the
  editor's **Font size** (and **Ctrl+=** / **Ctrl+-** inside a terminal zooms
  just that pane).
- **Default profile** — which launch configuration a plain **New terminal**
  uses. Profiles are edited by hand in `settings.json` under
  `terminalProfiles`; each has an `id`, a `name`, optional `program` and
  `args`, an optional starting folder `cwd`, extra `env`, and two optional
  size fields: `fontSize` (an absolute cell size in pixels) or
  `fontSizeDelta` (pixels added to the editor's font size — `2` means "two
  larger than my notes", and it keeps following Ctrl+= / Ctrl+-). If both are
  present, `fontSize` wins.
- **Cursor style**, **Blinking cursor**, **Scrollback**, **Lines per
  scroll**, **Bell** (never a sound — the cursor changes shape, the pane
  flashes, or nothing), **Copy on select**, **Confirm multi-line paste**,
  **Confirm closing a running shell**, **Keep the pane open after the shell
  exits**, **Alt sends Escape**, **Backspace sends DEL**, and **Let programs
  set the clipboard (OSC 52)** — the usual terminal-emulator knobs, each
  explained on its row.

## Harness (desktop only)

A **harness** is a terminal coding agent — the thing the new-tab menu's
**Harness** row opens in a terminal tab.

- **Harness** — which one that row launches: **Claude** (Claude Code),
  **ChatGPT** (the `codex` CLI), **Gemini**, **Grok**, **Copilot** (GitHub
  Copilot CLI), **opencode**, or **Custom…** with your own command line
  (`aider --model sonnet`).

  Until you choose, the app picks for you: Claude if it's installed, else
  ChatGPT, else whichever of the others it finds first. It makes that choice
  once — the first time it sees a harness on your machine — and then leaves
  it alone, so you can change it here and it stays changed. With none
  installed, the **Harness** row in the new-tab menu opens this page instead
  of a terminal, so you can install one.

  The app checks which harnesses are actually installed — at start-up,
  whenever this dialog opens, and on **Re-check** — and shows each one's
  status:
  - Found: a check mark and where the command lives.
  - Not found: the name is dimmed (you can still pick it) with an **Install**
    button beside it. Install opens a terminal tab and types the tool's
    official install command into your shell — a package manager you already
    have (winget, Homebrew, scoop) when the tool ships there, otherwise its own
    user-space installer, otherwise `npm install -g` (with Node.js installed
    first if you have no `npm`). Nothing runs hidden: you see the exact
    command, answer any prompt yourself, and keep the shell afterwards. Close
    that tab (or press **Re-check**) and the row updates.

A harness tab renders a touch larger than your notes — two pixels over the
editor's font size — since an agent's output is mostly read, not typed. It
still follows Ctrl+= / Ctrl+-. (**Open harness here** in the **⌄ menu → Themes**
opens the same harness in your themes folder, and **Open harness in docs** in
**⌄ menu → Help…** opens it in this user guide's folder.)

The app only ever *opens* a harness — in effect a `cd` into the folder and
then the harness's own command. It never types a prompt into it or adds flags
of its own; what the harness does next is up to you.

## Updates

The **Updates** tab shows the version you're running, a **Check for updates**
button, and the **Check for updates automatically** box (on by default). With
it on, the app checks quietly on its own at most once a week and never installs
anything by itself:

- If a newer version exists, a small **"Update available"** chip appears in
  the status bar — nothing pops up over your work.
- Click the chip and the update downloads, installs, and restarts the app.
  Your open tabs are written to disk first, so updating never loses a word —
  if they can't be written (a full disk, say), the app does not restart and
  tells you so; the installed update then applies the next time you start it.
- Every update is cryptographically checked before it's installed, and a
  failed check-for-updates never bothers you (if you're offline, nothing
  happens).
