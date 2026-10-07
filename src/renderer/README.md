# src/renderer/ — the terminal surface

Screen model in, pixels out; DOM events in, pty bytes out. Like `term/`, this
is a portable library: it owns a canvas and a hidden textarea, but it imports
**no** React and **no** Tauri (invariant I9, lint-enforced). It may import
`term/` and `core/`. Ported verbatim from `smooth-terminal`.

The host (`src/ui/components/TerminalPane.tsx`) hands it an element, a
`Terminal`, a resolved `TerminalTheme` and a `FontSpec`. The renderer never
reads CSS variables or the DOM for configuration — everything is passed in.

## What lives here

| File | Role |
| --- | --- |
| `view.ts` | `TermView` — the mountable surface. Owns the canvas, frame loop, `ResizeObserver`, devicePixelRatio, web-font readiness, focus, link hover, and the scroll animation; reports grid size so the host can resize the pty. |
| `renderer.ts` | The canvas painter: dirty rows → `clearRect` → background spans → text runs → decorations. |
| `runs.ts` | Row → draw runs. Batches consecutive cells into background spans and text runs so a line is a couple of canvas calls, not a hundred. |
| `colors.ts` | Cell attributes → painted colors. A *default* background resolves to `null` and that area is left unpainted, so the page background shows through. |
| `theme.ts` | `TerminalTheme`: 16 ANSI colors + background/foreground/cursor/selection, as numbers. Defaults mirrored as hex in `core/terminal-palette.ts`. |
| `metrics.ts` | Font measurement and cell geometry — measured from the real font once per font/size change, never guessed. |
| `selection.ts` | Selection model in absolute buffer lines (so it stays anchored while output scrolls), plus text extraction. |
| `links.ts` | OSC 8 hyperlinks and implicit URL detection under the pointer. |
| `keys.ts` | Pure keyboard encoding: a `KeyInput` description → the bytes xterm would send. Legacy/modifyOtherKeys encoding by default. AltGr characters (Windows reports AltGr as Ctrl+Alt) go out as plain text — `core/altgr.ts` decides. |
| `mouse.ts` | Pointer events → mouse-tracking escape sequences. Byte-oriented (X10 puts coordinates above 0x7f). |
| `paste.ts` | Paste sanitizing + chunked writes. The one path where the terminal sends text the user did not type key by key. |
| `input.ts` | `TermInput` — the only DOM-event file. Owns the hidden textarea (the only way a web view runs IME composition) and glues events onto the pure modules above. |
| `index.ts` | The barrel — import from `'../renderer'`. |

## Contracts you must not break

1. **No React, no Tauri.** The host wires callbacks; the renderer knows
   nothing about stores, tabs or IPC.
2. **Scrolling goes through the view.** `TermView.scrollLines` (wheel notches,
   spring-animated) / `trackScroll` (touchpad streams, followed 1:1 at
   fractional lines, settling onto a whole line when the stream goes quiet) /
   `scrollToBottom` are the only way input and the host move the viewport,
   because smooth scrolling splits the position in two: the engine holds the
   integer line offset and the renderer holds the sub-line remainder
   (`setScrollFraction`), which shifts the grid UP and paints one extra row
   below to fill the gap — so the engine's offset is the CEILING of the
   animated position and the fraction brings it forward, never the floor
   (which would render a whole line ahead and snap back when the scroll
   stops). A shifted grid disables the dirty-row fast path, so the fraction is
   0 whenever nothing is animating — which is also why a quiet touchpad stream
   settles onto a whole line instead of resting mid-line. Drag auto-scroll
   deliberately stays instant — the pointer is picking cells. A ratcheted
   wheel's notch scrolls `scrollLines` lines (default 3) per notch on every
   platform: `NotchUnitTracker` (core/smooth-scroll) learns the webview's
   per-notch pixel step, so WebKitGTK's 40px and WebView2's 120px notch move
   the grid the same distance.
3. **Configuration is passed, not read.** Theme, font and cursor style arrive
   as options and are re-applied idempotently, which is what makes live
   re-theming a prop change rather than a shell restart.
4. **Measure the font you will PAINT with.** A view that mounts before the web
   font has loaded measures the fallback face, and then every cell position —
   the cursor included — is computed from a width the canvas does not paint
   with: runs overhang their cells and overlap the run before them. `TermView`
   waits on `document.fonts.ready` and re-measures (`remeasure`), which is why
   a pane in a window that has JUST opened (a torn-off tab, a restored
   session) looks the same as one mounted a second later.
5. **Never let the surface collapse.** A 0×0 element resizes the pty to 1×1
   and every running TUI redraws into a corner — see invariant I10 in
   `src/ui/README.md`. That is why terminal tab pages are hidden with
   `visibility: hidden`, never `display: none`.
6. **Encoding stays pure.** `keys.ts`, `mouse.ts`, `paste.ts` and `runs.ts`
   take plain values, not events or canvases, so the whole matrix is
   unit-testable (and diffable against `showkey -a`).
