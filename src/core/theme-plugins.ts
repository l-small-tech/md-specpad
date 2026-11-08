/**
 * Theme plugins — the pure model behind pluggable color schemes.
 *
 * The whole app styles itself through a small set of CSS variables (see
 * styles/base.css), selected by `data-color-scheme` on <html>. A "theme plugin"
 * is a single `branding` palette — the ten semantic variables plus the brand
 * trio (primary/secondary/tertiary) — a declared `mode` ('light' | 'dark'),
 * and an optional flat `syntax` block that recolors individual markdown
 * elements (headings, bold, links, …) — authored as a small JSON file the user
 * drops in the themes folder (loaded by ipc/theme-loader.ts). This module is
 * DOM/Tauri-free: it validates a parsed JSON blob into a `ThemePlugin` and
 * renders a plugin to the scoped CSS the app injects at boot.
 *
 * Design notes:
 * - A theme presents ONE look; `mode` declares whether it is a light or dark
 *   look. The UI groups the theme picker by mode and pins `data-theme` on
 *   <html> to it while the theme is selected, so base.css's mode-matching
 *   defaults are the fallback for any key the theme omits.
 * - Branding/syntax values are validated as *safe* color strings — anything
 *   containing `;{}:` or a newline is dropped, so a hand-edited value can't break
 *   out of its declaration and corrupt the whole stylesheet. Missing keys are
 *   simply omitted; the app falls back to base.css's default for that variable
 *   (and each `--md-*` var itself falls back to a palette var in the consuming
 *   stylesheet), so a partial theme still works.
 * - The brand trio feeds the whiteboard ink derivation in base.css; when a
 *   theme omits it, base.css derives a trio from the theme's own
 *   accent/danger/fg.
 * - `terminal` is an optional block of terminal colors (16 ANSI names plus
 *   background/foreground/cursor/selection). Absent — the case for every
 *   theme shipped today — the palette is DERIVED from `branding` by
 *   `core/terminal-palette.ts`, so no theme has to think about it.
 * - The same block also carries the console SURFACE: `backgroundImage` (a
 *   plain file name next to the theme file, which ipc/theme-loader.ts inlines
 *   as a data: URL — the app's CSP allows no remote or file:// images) and
 *   `backgroundOpacity` (0–1 over the app behind the pane). Both are
 *   presentation, not palette, so they are parsed into `consoleBackground`
 *   rather than into the color map the renderer takes.
 * - `css` is an intentional escape hatch: verbatim CSS the author scopes
 *   themselves (for spacing/font tweaks the variables can't express). It is
 *   emitted as-is — the themes folder is the user's own machine.
 */

import { ANSI_NAMES, type TerminalPalette } from './terminal-palette';

/** The ten semantic palette keys (JSON field → CSS custom property). Every
 *  scheme block in the app is these variables; see styles/base.css. */
export const PALETTE_KEYS = {
  bg: '--bg',
  editorBg: '--editor-bg',
  bgAlt: '--bg-alt',
  bgHover: '--bg-hover',
  fg: '--fg',
  fgMuted: '--fg-muted',
  accent: '--accent',
  border: '--border',
  danger: '--danger',
  selection: '--selection',
} as const;

/** The brand trio (JSON field → CSS custom property): the theme's identity
 *  colors, consumed by the whiteboard ink derivation in styles/base.css. */
export const BRAND_KEYS = {
  primary: '--brand-primary',
  secondary: '--brand-secondary',
  tertiary: '--brand-tertiary',
} as const;

/** The branding keys: the ten semantic palette keys plus the brand trio. */
export const BRANDING_KEYS = { ...PALETTE_KEYS, ...BRAND_KEYS } as const;

/**
 * Optional markdown-element colors (JSON field → CSS custom property). Each maps
 * to a `--md-*` variable consumed by the three rendering surfaces (editors/cm6.ts,
 * styles/preview.css, styles/wysiwyg.css). Every consumer references its var with
 * a fallback to the previous palette-derived color, so an unset key changes
 * nothing. `heading` sets all levels; `heading1`…`heading6` override per level.
 */
export const SYNTAX_KEYS = {
  heading: '--md-heading',
  heading1: '--md-heading1',
  heading2: '--md-heading2',
  heading3: '--md-heading3',
  heading4: '--md-heading4',
  heading5: '--md-heading5',
  heading6: '--md-heading6',
  bold: '--md-bold',
  italic: '--md-italic',
  strikethrough: '--md-strike',
  link: '--md-link',
  code: '--md-code',
  quote: '--md-quote',
  list: '--md-list',
  mention: '--md-mention',
} as const;

export type ThemeMode = 'light' | 'dark';

/**
 * The console (terminal) surface behind the cells: the pane paints this and
 * the renderer leaves default-background cells transparent over it (see
 * renderer/README.md), which is what lets an image or a translucent
 * background show through at all.
 */
export interface ConsoleBackground {
  /**
   * File name of an image in the themes folder — a BARE name (no folders, no
   * `..`, no URL), because a theme has to stay a single portable file next to
   * its assets and the loader is what turns it into a data: URL.
   */
  image?: string;
  /**
   * The resolved `data:` URL for {@link image}. Never authored: the loader
   * fills it in after reading the file, and it is empty when the file is
   * missing or unreadable (the theme still applies, just without the image).
   */
  imageUrl?: string;
  /**
   * Opacity of the WHOLE console background — color and image alike — so the
   * app behind the terminal pane shows through. 0–1; 1 (opaque) is the default.
   */
  opacity?: number;
}

/** Image types a console background may use (extension → allowed). */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'] as const;

export type PaletteKey = keyof typeof PALETTE_KEYS;
export type BrandKey = keyof typeof BRAND_KEYS;
export type BrandingKey = keyof typeof BRANDING_KEYS;
export type SyntaxKey = keyof typeof SYNTAX_KEYS;

export const PALETTE_KEY_LIST = Object.keys(PALETTE_KEYS) as PaletteKey[];
export const BRANDING_KEY_LIST = Object.keys(BRANDING_KEYS) as BrandingKey[];
export const SYNTAX_KEY_LIST = Object.keys(SYNTAX_KEYS) as SyntaxKey[];

/** A theme's palette: any subset of the branding keys → color string. */
export type Branding = Partial<Record<BrandingKey, string>>;
/** A markdown-element palette: any subset of the syntax keys. */
export type SyntaxPalette = Partial<Record<SyntaxKey, string>>;

export interface ThemePlugin {
  /** Slug (from the filename); also the `data-color-scheme` value. */
  id: string;
  /** Display name for the settings dropdown. */
  name: string;
  /** The one look this theme presents, whatever the OS setting. Groups the
   *  picker and drives `data-theme` while the theme is selected. */
  mode: ThemeMode;
  branding: Branding;
  /** Optional markdown-element colors (the `--md-*` vars), flat. */
  syntax?: SyntaxPalette;
  /**
   * Optional terminal colors. Absent = derived from `branding`
   * (core/terminal-palette.ts). A partial block merges over the derived
   * palette, so setting one key sets one key.
   */
  terminal?: TerminalPalette;
  /**
   * Optional console surface (image / opacity), parsed from the same
   * `terminal` block as the colors. Absent = an opaque background painted in
   * the terminal palette's own background color.
   */
  consoleBackground?: ConsoleBackground;
  /** Optional verbatim CSS appended after the branding block. */
  css?: string;
  /** Seed-content version, stamped only on the built-in examples we write to the
   *  themes folder. Lets the loader refresh a stale copy when the shipped
   *  definition changes (see ipc/theme-loader.ts). User-authored themes omit it. */
  version?: number;
}

/**
 * The keys a `terminal` block may carry. Split from `ANSI_NAMES` so this
 * module keeps its own list of what is parseable; the two are held together
 * by `terminal-palette.test.ts`.
 */
const TERMINAL_COLOR_KEYS = [
  ...ANSI_NAMES,
  'background',
  'foreground',
  'cursor',
  'selection',
] as const;

/** These two are meaningfully NULLABLE: null means "no override". */
const TERMINAL_NULLABLE_KEYS = ['cursorText', 'selectionText'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * A color value is accepted only if it's a non-empty string free of the
 * characters that would let it escape a `--var: <value>;` declaration. We do
 * NOT try to parse color syntax — hex, rgb(), hsl(), and named colors all pass;
 * garbage merely renders as an invalid (ignored) declaration.
 */
function isSafeColor(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[;{}:\n\r]/.test(value);
}

/** Keep only the given keys with safe values; drop everything else silently. */
function pickSafe<K extends string>(raw: unknown, keys: readonly K[]): Partial<Record<K, string>> {
  if (!isRecord(raw)) {
    return {};
  }
  const out: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const value = raw[key];
    if (isSafeColor(value)) {
      out[key] = value.trim();
    }
  }
  return out;
}

/**
 * Validate a parsed JSON blob into a `ThemePlugin`. Returns null only when the
 * input is unusable (not an object, or no `branding` values at all after
 * validation) — a lenient parse so a slightly-malformed theme degrades rather
 * than disappearing. The empty-branding guard is also what rejects files in the
 * retired `{ light, dark }` format. A missing or misspelled `mode` defaults to
 * 'light' (the theme still works, it just lands in the Light group). `id` is
 * supplied by the caller (the filename slug).
 */
export function parseThemePlugin(id: string, raw: unknown): ThemePlugin | null {
  if (!isRecord(raw)) {
    return null;
  }
  const branding = pickSafe(raw.branding, BRANDING_KEY_LIST);
  if (Object.keys(branding).length === 0) {
    // Nothing to apply — treat as invalid so the loader skips it.
    return null;
  }
  const mode: ThemeMode = raw.mode === 'dark' ? 'dark' : 'light';
  const name = typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : id;
  const css = typeof raw.css === 'string' && raw.css.trim().length > 0 ? raw.css : undefined;

  const syntaxPicked = pickSafe(raw.syntax, SYNTAX_KEY_LIST);
  const syntax = Object.keys(syntaxPicked).length > 0 ? syntaxPicked : undefined;

  const terminal = parseTerminalPalette(raw.terminal);
  const consoleBackground = parseConsoleBackground(raw.terminal);

  return {
    id,
    name,
    mode,
    branding,
    ...(syntax ? { syntax } : {}),
    ...(terminal ? { terminal } : {}),
    ...(consoleBackground ? { consoleBackground } : {}),
    ...(css ? { css } : {}),
  };
}

/**
 * The optional `terminal` block. Same `isSafeColor` discipline as branding —
 * these values never reach CSS, but a hand-edited theme should degrade the
 * same way everywhere. Returns undefined when nothing usable is in it.
 */
function parseTerminalPalette(raw: unknown): TerminalPalette | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const out: TerminalPalette = pickSafe(raw, TERMINAL_COLOR_KEYS);
  for (const key of TERMINAL_NULLABLE_KEYS) {
    const value = raw[key];
    if (value === null || isSafeColor(value)) {
      out[key] = value === null ? null : (value as string).trim();
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The console surface keys of a `terminal` block. `backgroundImage` is held to
 * a BARE image file name — no separators, no `..`, no scheme, no quotes — both
 * because the loader resolves it inside the themes folder and because the name
 * ends up inside a `url("…")`, where a stray quote would break out of the
 * declaration. `backgroundOpacity` is clamped rather than rejected, so a theme
 * that says `2` simply means "opaque".
 */
function parseConsoleBackground(raw: unknown): ConsoleBackground | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const out: ConsoleBackground = {};
  const image = raw.backgroundImage;
  if (typeof image === 'string' && isSafeImageName(image.trim())) {
    out.image = image.trim();
  }
  const opacity = raw.backgroundOpacity;
  if (typeof opacity === 'number' && Number.isFinite(opacity)) {
    out.opacity = Math.min(1, Math.max(0, opacity));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A bare image file name: no path, no traversal, nothing quote-like. */
function isSafeImageName(name: string): boolean {
  if (name.length === 0 || /[\\/:"'()\s;{}]/.test(name) || name.includes('..')) {
    return false;
  }
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** CSS-escape a single-quoted attribute value (id is already slug-safe, but be
 *  defensive against quotes/backslashes ever reaching here). */
function escapeAttrValue(id: string): string {
  return id.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Render `values` as `--var: color;` lines for the keys that are present. */
function declarations<K extends string>(
  values: Partial<Record<K, string>>,
  vars: Record<K, string>,
  keys: readonly K[],
): string {
  return keys
    .filter((key) => values[key] !== undefined)
    .map((key) => `  ${vars[key]}: ${values[key]};`)
    .join('\n');
}

/**
 * Bare `--x: value;` declarations (branding + syntax) of a plugin — for
 * injecting a chosen theme into the standalone export stylesheet, where no
 * `data-theme`/`data-color-scheme` attributes exist to scope against. The
 * caller wraps them in its own `:root { … }` block.
 */
export function themeDeclarations(plugin: ThemePlugin): string {
  return [
    declarations(plugin.branding, BRANDING_KEYS, BRANDING_KEY_LIST),
    plugin.syntax ? declarations(plugin.syntax, SYNTAX_KEYS, SYNTAX_KEY_LIST) : '',
  ]
    .filter((block) => block.length > 0)
    .join('\n');
}

/**
 * Render a plugin to the CSS the app injects: one `:root[data-color-scheme]`
 * block holding the branding + syntax declarations, then the verbatim `css`.
 * The block is deliberately NOT scoped by `data-theme` — a theme presents one
 * look, and the UI pins `data-theme` to the plugin's `mode` while it is
 * selected, so base.css's matching mode block supplies the defaults for any
 * key the theme omits. This stylesheet is appended after base.css, so at equal
 * specificity the theme's own declarations win by source order.
 */
export function themePluginToCss(plugin: ThemePlugin): string {
  const attr = escapeAttrValue(plugin.id);
  const blocks: string[] = [];
  const decls = themeDeclarations(plugin);
  if (decls) {
    blocks.push(`:root[data-color-scheme='${attr}'] {\n${decls}\n}`);
  }
  if (plugin.css) {
    blocks.push(plugin.css);
  }
  return blocks.join('\n');
}

/** Concatenate every plugin's CSS into one stylesheet body. */
export function themePluginsToCss(plugins: readonly ThemePlugin[]): string {
  return plugins.map(themePluginToCss).join('\n\n');
}
