# Themes

A **theme** sets the colors the app uses — the background, the text, the accent
on links and headings, and so on. Themes are what make long reading and writing
sessions comfortable, so it's worth finding (or making) one you like.

Pick a theme in the **⌄ menu → Themes** — the arrow beside the `+` button on
the tab bar. Every installed theme is listed there, with a ✓ on the one you're
using, and picking one applies it instantly.
(The same list is also in **Settings → Theme**.) It starts with **System**
(the app's built-in green palette, light or dark to match your computer and
switching live when it changes), then every theme grouped by its declared
mode:

- **Light** — **Light Green**, **Beacon** (maximum-contrast black-on-white),
  **Skylark** (color-vision-friendly), **Lagoon** (shallow tropical water),
  **Marmalade** (orange), **Honeycomb** (yellow), **Ultramarine** (blue),
  **Dragonfruit** (magenta), and any light theme you add yourself.
- **Dark** — **Dark Green**, **Vantablack** (maximum-contrast white-on-black),
  **Nightjar** (color-vision-friendly), **Abyss** (lightless deep ocean),
  **Garnet** (red), **Cyanotype** (blueprint cyan), **Amethyst** (violet), and
  any dark theme you add yourself.

Two pairs deserve a special note:

- **Beacon / Vantablack** are the high-contrast pair — pure black-and-white
  grounds with hard borders and a loud selection color, for harsh glare,
  low-vision use, and OLED screens.
- **Skylark / Nightjar** are built entirely from the Okabe–Ito palette, whose
  colors stay distinguishable under the common forms of color-vision
  deficiency — nothing in them relies on telling red from green.

Unlike **System**, each named theme keeps its one look — light stays light and
dark stays dark, whatever your computer's light/dark setting. You pick the
mood, not the machine.

The best part: **themes are just small files you can edit or create yourself** —
no programming needed, and an AI assistant can write a whole theme for you in
seconds. Read on.

## The themes folder

Every theme is one small `.json` file in your **themes folder**. Below the
theme list in **⌄ menu → Themes** are the buttons for managing it:

- **Open harness here** — opens your AI agent (Claude, ChatGPT, Gemini, Grok,
  Copilot or opencode — pick which in **Settings → Harness**, which also
  installs one for you if it isn't yet) in a terminal tab, already standing in
  the themes folder. The folder holds an `AGENTS.md` that explains the file
  format; ask the agent to read it, then tell it what you want — "make
  Lagoon's background a touch darker", "create a warm sepia light theme" —
  and it edits or creates the files for you. *(Desktop only.)*
- **Reload** — re-reads the folder after you (or the AI) have edited or added
  files, so your changes show up right away.
- **Help** — opens this page.

The fifteen example themes live here too — open any of them to see exactly how
a theme is built, or copy one as a starting point.

## What a theme file looks like

A theme is a name, a **mode** (`"light"` or `"dark"` — the look it presents),
and one **branding** block of colors. Here's a complete one:

```json
{
  "name": "Midnight",
  "mode": "dark",
  "branding": {
    "primary": "#6ea1ff",
    "secondary": "#ff6b5e",
    "tertiary": "#8a63d2",
    "bg": "#0f1419",
    "editorBg": "#0b0f14",
    "bgAlt": "#1a212b",
    "bgHover": "#242d3a",
    "fg": "#e6e6e6",
    "fgMuted": "#8a94a3",
    "accent": "#6ea1ff",
    "border": "#2a3240",
    "danger": "#ff6b5e",
    "selection": "#264066"
  }
}
```

Save it as, say, `midnight.json` in the themes folder, click **Reload**, and
"Midnight" appears in the Theme dropdown's Dark group. The **file name**
(without `.json`) is the theme's id, so keep it simple: lowercase letters,
numbers, and dashes.

### The branding colors

Colors can be written as hex (`#rrggbb`), `rgb(...)`, `hsl(...)`, or a named
color like `navy`.

First, the **brand trio** — your theme's three identity colors. They drive the
vector drawings' themed ink palette (the pens automatically match your theme):

| Key         | What it is |
| ----------- | ---------- |
| `primary`   | The theme's signature color — usually the same as `accent`. |
| `secondary` | The strongest supporting color. |
| `tertiary`  | A third distinct color to round out the set. |

Then the ten interface colors:

| Key          | What it colors |
| ------------ | -------------- |
| `bg`         | The main app background (toolbar, tabs, sidebar). |
| `editorBg`   | The diff, terminal, and whiteboard surface — usually a hair brighter than `bg`. Text views paint on `bg`. |
| `bgAlt`      | Secondary panels and subtle raised areas. |
| `bgHover`    | The highlight when you hover over a button or list row. |
| `fg`         | The main text color. |
| `fgMuted`    | Secondary text — hints, labels, inactive items. |
| `accent`     | Links, headings, and active highlights. |
| `border`     | Lines between panels and around controls. |
| `danger`     | Warnings and destructive actions (e.g. delete). |
| `selection`  | The highlight behind selected text. |

You don't have to include everything — any key you leave out simply uses the
Default value for your theme's mode, and a missing trio is derived from your
`accent`, `danger`, and `fg`. But for a polished result, set them all.

### Coloring markdown elements (optional)

The branding colors cover the whole app. If you also want to recolor
**individual markdown elements** — give headings their own color, tint links,
make code stand out — add an optional `"syntax"` block. Any key you set applies
in every view (source, Edit, and Review). Leave the block out entirely, or leave
any key unset, and that element keeps its normal color.

```json
{
  "name": "Inky",
  "mode": "light",
  "branding": { "bg": "#ffffff", "fg": "#1f1f1f", "accent": "#3574f0" },
  "syntax": {
    "heading": "#8a101f",
    "bold": "#1f1f1f",
    "italic": "#6e6e6e",
    "link": "#3574f0",
    "code": "#b23a2b",
    "quote": "#6e6e6e",
    "list": "#6e6e6e"
  }
}
```

The keys:

| Key             | What it colors |
| --------------- | -------------- |
| `heading`       | All headings (levels 1–6). |
| `heading1`…`heading6` | A single heading level — overrides `heading` for that level. |
| `bold`          | **Bold** text. |
| `italic`        | *Italic* text. |
| `strikethrough` | ~~Struck-through~~ text. |
| `link`          | Links and URLs. |
| `code`          | Inline code and code blocks. |
| `quote`         | Blockquotes. |
| `list`          | List bullets and numbers. |

To color each heading level differently, set `heading1` through `heading6`
instead of (or on top of) `heading`.

### Terminal colors (optional)

Terminal tabs paint with a 16-color ANSI palette plus a background,
foreground, cursor and selection. You don't have to supply any of it: the
palette is **derived from your branding colors** — `accent` becomes blue and
the cursor, `danger` becomes red, `fgMuted` becomes bright black, `editorBg`
and `fg` become the surface and the text — and each derived color is checked
against the background and nudged until it's comfortably readable. Every theme
therefore arrives with a working terminal palette and nothing to decide.

In a **light** theme the palette is deliberately inverted from what the names
suggest: "bright" colors are *darker* than their plain twins, and `white` /
`brightWhite` are inks rather than paper. That is because a program written for
a dark terminal writes its ordinary text in exactly those colors — leave them
pale and the text disappears. Every derived light color clears the WCAG AA
ratio (4.5:1) against the surface, except `black`, which stays dark so programs
can still use it as a background.

If you want exact control, add an optional `"terminal"` block. Anything you
leave out stays derived, so setting one key sets one key:

```json
{
  "name": "Midnight",
  "mode": "dark",
  "branding": { "editorBg": "#0b0f14", "fg": "#e6e6e6", "accent": "#6ea1ff" },
  "terminal": {
    "cursor": "#ffcc00",
    "red": "#ff6b5e",
    "green": "#9ece6a",
    "blue": "#6ea1ff"
  }
}
```

The keys:

| Key | What it colors |
| --- | -------------- |
| `background` / `foreground` | The terminal surface and its default text. |
| `cursor` | The block/bar cursor. |
| `cursorText` | The character *under* a block cursor. `null` = the background color. |
| `selection` | The highlight behind selected terminal text. |
| `selectionText` | Text inside a selection. `null` = each character keeps its own color. |
| `black` `red` `green` `yellow` `blue` `magenta` `cyan` `white` | ANSI colors 0–7. |
| `brightBlack` `brightRed` `brightGreen` `brightYellow` `brightBlue` `brightMagenta` `brightCyan` `brightWhite` | ANSI colors 8–15. |

### The console background: an image, or see-through

The same `terminal` block can also style the *surface* the shell sits on:

| Key | What it does |
| --- | ------------ |
| `backgroundImage` | File name of a picture in your themes folder — put the file right next to the `.json` and name it here (just the name: `"forest.png"`, not a folder path or a web address). It fills the terminal, scaled to cover. |
| `backgroundOpacity` | How solid the whole console background is, from `0` (invisible) to `1` (the default, fully solid). Lower it and the app behind the terminal shows through. |

```json
{
  "name": "Midnight",
  "mode": "dark",
  "branding": { "editorBg": "#0b0f14", "fg": "#e6e6e6", "accent": "#6ea1ff" },
  "terminal": {
    "background": "#0b0f14",
    "backgroundImage": "forest.png",
    "backgroundOpacity": 0.85
  }
}
```

Text and any colored output stay fully solid — only the background behind them
fades — so a picture never costs you readability. `png`, `jpg`, `webp`, `gif`
and `avif` files work; keep them modest in size, since the picture is loaded
with the theme. If the file is missing, the theme still applies, just without
the picture.

The terminal's **font** is not part of the theme: it comes from **Settings →
Terminal → Font** (Fira Code by default, or *Match editor font*), and its size
follows the editor's font size, so Ctrl/Cmd `+` / `-` resizes it too (inside a
terminal those chords zoom just that pane).

### Light themes and AI agents

Coding agents draw their own interface, and most of them ship a dark look by
default. On a light theme that can mean grey-on-white text until the agent
learns where it is. md-specpad tells it three ways, all automatically:

- It answers the **background-color query** (`OSC 11`, and `OSC 10`/`12` for
  the foreground and cursor) with the live theme colors, in xterm's format and
  terminated the way the question was asked — several agents give up after
  100ms and assume "dark".
- It sets **`COLORFGBG`** in the shell's environment (`0;15` on a light theme,
  `15;0` on a dark one), which is what agents read *before* their first frame.
- It supports the newer **light/dark notification** protocol (DEC mode 2031 /
  `CSI ? 996 n`), so an agent that subscribes is told the moment you switch
  themes and re-colors itself without restarting.

What each agent does with that, and how to fix it by hand if it guesses wrong:

| Agent | How it decides | If it still looks dark |
| ----- | -------------- | ---------------------- |
| **Claude Code** | `COLORFGBG` first, then the `OSC 11` query — but only when its theme is set to `auto`. | `/theme` → **auto** (or **Light**). For a look that follows *this* theme's palette instead of its own, pick **light-ansi**. |
| **GitHub Copilot CLI** | The `OSC 11` query, on a short timeout. | `/theme` → pick a lighter color mode. It paints in fixed 24-bit color, so the theme's ANSI palette can't help it. |
| **OpenAI Codex CLI** | Uses `OSC 10` + `OSC 11` only for its input box; the rest of its interface uses your terminal's own colors, so it follows this theme already. | `/theme` changes syntax highlighting only. On Windows it reads the console attributes instead of asking, and can get the input box wrong. |
| **Gemini CLI** | Polls `OSC 11` and switches between its Default and Default Light themes on its own. | `/theme` → **ANSI Light** to use this theme's palette, or **Default Light**. |
| **opencode** | The DEC 2031 notification, falling back to `OSC 11`. | `/theme` → **system**, which paints with this theme's ANSI colors. |
| **Grok CLI** | Your *operating system's* light/dark setting first, then `OSC 11`. md-specpad also sets `GROK_APPEARANCE` so it follows the app's theme rather than the OS's. | `/theme` → a light theme, or run `grok --minimal` for a terminal-native look. |

Each of those `/theme` commands is a one-time choice the agent remembers.

A profile's own environment always wins: set `COLORFGBG` (or `GROK_APPEARANCE`)
in a terminal profile's `env` and md-specpad's hint steps aside.

### Advanced: the `css` field (optional)

If you want to go beyond colors — say, add letter-spacing in Review mode or tweak
a font — you can add an optional `"css"` field with raw CSS. It's applied only
when your theme is selected. Most people never need this; skip it unless you
know CSS.

```json
{
  "name": "Airy",
  "mode": "light",
  "branding": { "bg": "#fbfbfa", "fg": "#2b2b2b" },
  "css": ".markdown-body { line-height: 1.8; }"
}
```

## Let an AI build your theme

You don't have to pick the colors yourself. **Open harness here** above is
the fast path: it opens your agent right in the themes folder — point it at
`AGENTS.md`, say what you'd like, and it edits the files itself; you just
click **Reload** after.

No agent CLI installed? Paste the prompt below into any AI assistant (ChatGPT,
Claude, Gemini, …), describe the mood you want, and drop the result into your
themes folder.

> I'm making a color theme for a markdown notepad app. A theme is a JSON file
> with a `name`, a `mode` (either `"light"` or `"dark"` — the one look the
> theme presents), and a `branding` palette. The palette has these keys, all
> color strings (hex is fine):
>
> - `primary`, `secondary`, `tertiary` — the theme's three identity colors
>   (`primary` is usually the same as `accent`)
> - `bg` — main app background
> - `editorBg` — the diff/terminal/whiteboard surface (a hair off `bg`)
> - `bgAlt` — secondary panels
> - `bgHover` — hover highlight
> - `fg` — main text
> - `fgMuted` — secondary text
> - `accent` — links and headings
> - `border` — dividing lines
> - `danger` — warnings/delete
> - `selection` — selected-text highlight
>
> Optionally also add a flat `syntax` object to recolor markdown elements,
> using any of these keys: `heading` (or `heading1`…`heading6` for per-level),
> `bold`, `italic`, `strikethrough`, `link`, `code`, `quote`, `list`.
>
> Please output only a valid JSON file. Make it **[describe what you want — e.g.
> "a warm, low-contrast sepia theme that's easy on the eyes at night"]**. If the
> mode is light, use dark text on light backgrounds; if dark, light text on dark
> backgrounds — with enough contrast to read comfortably.

Save the AI's output as `something.json` in your themes folder, click
**Reload**, and select it. If it doesn't look right, ask the AI to adjust and
reload again.

## Tips & troubleshooting

- **It's not in the list** — click **Reload**. Make sure the file ends in
  `.json` and is valid JSON (a missing comma or quote will make the app skip
  it), and that the colors sit inside a `"branding"` block — files from older
  versions with separate `"light"`/`"dark"` blocks are skipped. Pasting the
  file's contents back to your AI and asking it to "convert to the branding
  format" usually sorts it out.
- **Some colors look wrong** — you may have left those keys out (they fall back
  to Default) or set a `mode` that doesn't match your palette's brightness.
- **A theme disappeared** — if you delete a theme's file while it's selected,
  the app quietly falls back to the Default palette. Pick another scheme, or add
  the file back.
- **Editing on the fly** — keep the file open in the app (or an editor), tweak a
  color, save, and click **Reload** to see it instantly.
- **Multiple windows** — a newly added theme shows up in other open windows
  after you click **Reload** in each (or restart the app).

The fifteen example themes are yours to modify — if you change one and want the
original back, just delete your version and reopen Settings (the app re-creates
any missing example on the next launch).
