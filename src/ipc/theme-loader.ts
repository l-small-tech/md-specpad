/**
 * Loads pluggable theme files from the themes folder (see ipc/paths.ts for the
 * location). Kept in `src/ipc` because it does file I/O; the pure model
 * (validation, CSS rendering) lives in core/theme-plugins.ts.
 *
 * Flow (see `loadThemePlugins`): ensure the folder exists → list `*.json` → seed
 * any missing built-in example and refresh any stale one (an older SEED_VERSION
 * stamp) → read + validate each. Invalid or unreadable files are skipped
 * individually, never failing the batch, so one bad hand-edit can't strip every
 * theme. Files in the retired `{ light, dark }` format have no `branding` and
 * are skipped by the parser — deliberately never rewritten or deleted (only
 * seeded copies, identified by their `version` stamp, are ever touched).
 *
 * The themes folder is always app-owned local storage (internal on desktop, the
 * external files dir on Android), never a SAF synced tree, so this talks to the
 * std::fs-backed `ipc` commands directly rather than going through the storage
 * provider.
 */

import { join } from '@tauri-apps/api/path';
import { ipc, IpcError } from './commands';
import {
  parseThemePlugin,
  type ThemePlugin,
  type ThemeMode,
  type Branding,
  type SyntaxPalette,
} from '../core/theme-plugins';
import { BUILT_IN_THEMES, RETIRED_THEME_IDS } from '../core/theme-seeds';
import { seedImageBase64 } from './theme-seed-images';

/** Filename slug (no extension), lowercased and reduced to a safe id. */
function slugFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const noExt = base.replace(/\.[^.]*$/, '');
  const slug = noExt
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'theme';
}

/** The on-disk JSON shape (the plugin minus its filename-derived id). */
function toFileJson(plugin: ThemePlugin): string {
  const terminal = terminalBlock(plugin);
  const body: {
    name: string;
    version?: number;
    mode: ThemeMode;
    branding: Branding;
    syntax?: SyntaxPalette;
    terminal?: Record<string, unknown>;
    css?: string;
  } = {
    name: plugin.name,
    ...(plugin.version !== undefined ? { version: plugin.version } : {}),
    mode: plugin.mode,
    branding: plugin.branding,
    ...(plugin.syntax ? { syntax: plugin.syntax } : {}),
    ...(terminal ? { terminal } : {}),
    ...(plugin.css ? { css: plugin.css } : {}),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * The on-disk `terminal` block: the palette overrides plus the console-surface
 * keys, which `parseThemePlugin` splits back apart on read. Undefined when the
 * plugin carries neither, so themes without one stay byte-identical to before.
 */
function terminalBlock(plugin: ThemePlugin): Record<string, unknown> | undefined {
  const surface = plugin.consoleBackground;
  const block: Record<string, unknown> = {
    ...(plugin.terminal ?? {}),
    ...(surface?.image !== undefined ? { backgroundImage: surface.image } : {}),
    ...(surface?.opacity !== undefined ? { backgroundOpacity: surface.opacity } : {}),
  };
  return Object.keys(block).length > 0 ? block : undefined;
}

/**
 * Read the `version` stamp of an existing theme file. Returns:
 *  - the number, when the file is valid JSON carrying a finite `version`;
 *  - `null` for valid JSON with NO `version` field — a user-authored file
 *    (the built-ins we write always carry a stamp), so the caller must PRESERVE
 *    it and never overwrite, even when its id happens to slug to a built-in;
 *  - `null` when the file can't be read or parsed, so the caller leaves it
 *    alone rather than risk clobbering a locked or hand-broken file.
 *
 * The refresh path only fires for a file that actually carries a `version`
 * older than SEED_VERSION (a genuine built-in copy from an earlier build).
 */
async function readSeededVersion(path: string): Promise<number | null> {
  try {
    const { text } = await ipc.readTextFile(path);
    const raw: unknown = JSON.parse(text);
    if (raw && typeof raw === 'object') {
      const v = (raw as Record<string, unknown>).version;
      if (typeof v === 'number' && Number.isFinite(v)) {
        return v;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Ensure every built-in example is present and current. Writes a built-in when
 * no file for its id exists, and refreshes an existing copy whose stamped
 * version is older than the shipped SEED_VERSION (so a fixed color or added
 * syntax block reaches devices seeded by an earlier build). A copy that is
 * already current — or that a user has bumped past ours — is left untouched, as
 * is any unreadable file. Returns the number of files written. `existingById`
 * maps a built-in id to its actual on-disk path (which may differ in case from
 * `<id>.json`), so a refresh overwrites the user's real file rather than
 * spawning a case-variant duplicate.
 */
async function seedBuiltIns(themesDir: string, existingById: Map<string, string>): Promise<number> {
  let written = 0;
  for (const theme of BUILT_IN_THEMES) {
    const existingPath = existingById.get(theme.id);
    if (existingPath) {
      const onDisk = await readSeededVersion(existingPath);
      if (onDisk === null || onDisk >= (theme.version ?? 0)) {
        continue;
      }
    }
    const path = existingPath ?? (await join(themesDir, `${theme.id}.json`));
    try {
      await ipc.atomicWriteText(path, toFileJson(theme));
      written += 1;
    } catch {
      // A failed seed/refresh is non-fatal: the theme just keeps its old copy
      // (or won't appear until writable); the rest of the folder still loads.
      continue;
    }
    await seedConsoleImage(themesDir, theme);
  }
  return written;
}

/**
 * Write the bundled console background image a seeded theme references (see
 * ipc/theme-seed-images.ts) next to its JSON. Runs when the theme file itself
 * is seeded or refreshed — the moment the image BYTES may have changed (an
 * existing file is overwritten with the current asset). A file that later
 * goes missing is restored by the self-heal in `withConsoleImage` instead,
 * so an image write that fails here once isn't permanent. Non-fatal: the theme
 * simply applies without its image until the next refresh.
 */
async function seedConsoleImage(themesDir: string, theme: ThemePlugin): Promise<void> {
  const image = theme.consoleBackground?.image;
  const base64 = image !== undefined ? seedImageBase64(image) : undefined;
  if (image === undefined || base64 === undefined) {
    return;
  }
  try {
    await ipc.writeFileBase64(await join(themesDir, image), base64);
  } catch {
    // Non-fatal (see above).
  }
}

/**
 * Delete themes-folder copies of RETIRED built-ins (ids we used to seed but no
 * longer ship). Only a file still carrying our seed `version` stamp is removed
 * — a stamp-less file is user-authored (or a seeded copy the user adopted by
 * dropping the stamp) and must survive. Returns the number of files deleted.
 */
async function removeRetiredSeeds(existingById: Map<string, string>): Promise<number> {
  let removed = 0;
  for (const id of RETIRED_THEME_IDS) {
    const path = existingById.get(id);
    if (!path) {
      continue;
    }
    if ((await readSeededVersion(path)) === null) {
      continue; // user-authored or unreadable — leave it alone
    }
    try {
      await ipc.deletePath(path);
      existingById.delete(id);
      removed += 1;
    } catch {
      // A locked/undeletable file is non-fatal: it just keeps showing up.
    }
  }
  return removed;
}

/**
 * Ensure the themes folder exists, seed missing built-ins and refresh stale
 * ones, then read and validate every `*.json` into a `ThemePlugin`. Duplicate
 * ids resolve to the first (sorted) file. Never throws for a missing folder or a
 * bad file.
 */
export async function loadThemePlugins(themesDir: string): Promise<ThemePlugin[]> {
  try {
    await ipc.createDir(themesDir);
  } catch (e) {
    // EXISTS is expected after first run; anything else means we can't use the
    // folder — return no plugins and let the app fall back to the default palette.
    if (!(e instanceof IpcError && e.code === 'EXISTS')) {
      return [];
    }
  }

  let paths = await ipc.listThemeFiles(themesDir).catch(() => [] as string[]);
  // First path wins per id (matches the dedup in the read loop below), so a
  // refresh targets the same file the registry will end up loading.
  const existingById = new Map<string, string>();
  for (const path of paths) {
    const id = slugFromPath(path);
    if (!existingById.has(id)) {
      existingById.set(id, path);
    }
  }
  const removed = await removeRetiredSeeds(existingById);
  const seeded = await seedBuiltIns(themesDir, existingById);

  // Re-list only if we wrote or deleted files this run (a fresh seed adds new
  // paths; a refresh rewrites an existing one, which the read loop re-reads).
  if (seeded > 0 || removed > 0) {
    paths = await ipc.listThemeFiles(themesDir).catch(() => paths);
  }

  const byId = new Map<string, ThemePlugin>();
  for (const path of paths) {
    const id = slugFromPath(path);
    if (byId.has(id)) {
      continue;
    }
    const plugin = await readThemeFile(path, id);
    if (plugin) {
      byId.set(id, plugin);
    }
  }
  return [...byId.values()];
}

async function readThemeFile(path: string, id: string): Promise<ThemePlugin | null> {
  let plugin: ThemePlugin | null;
  try {
    const { text } = await ipc.readTextFile(path);
    plugin = parseThemePlugin(id, JSON.parse(text));
  } catch {
    // Unreadable or not valid JSON — skip this one file.
    return null;
  }
  return plugin === null ? plugin : await withConsoleImage(plugin, path);
}

/** MIME type for the extensions `parseThemePlugin` lets through. */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

/**
 * Resolve a theme's `terminal.backgroundImage` into the `data:` URL the pane
 * can actually paint.
 *
 * Inlined rather than linked because the app's CSP allows `img-src 'self'
 * data:` and nothing else — there is no asset protocol to point a `url()` at.
 * The file is read from the theme's OWN folder (the name is validated as a
 * bare file name upstream), so a theme is its `.json` plus its picture, and
 * both travel together. A missing or unreadable file is not an error: the
 * theme applies without the image.
 */
async function withConsoleImage(plugin: ThemePlugin, themePath: string): Promise<ThemePlugin> {
  const image = plugin.consoleBackground?.image;
  if (!image) {
    return plugin;
  }
  const mime = IMAGE_MIME[image.toLowerCase().split('.').pop() ?? ''];
  if (!mime) {
    return plugin;
  }
  const dir = themePath.slice(0, Math.max(themePath.lastIndexOf('/'), themePath.lastIndexOf('\\')));
  const path = await join(dir, image);
  let base64: string;
  try {
    base64 = await ipc.readFileBase64(path);
  } catch {
    // Self-heal: when the referenced name is one of OUR bundled assets, a
    // missing file is restored from the bundle and used directly — an image
    // write that failed at seed time (or a file lost since) costs one boot,
    // not the image forever. Anything else missing stays a theme-without-image.
    const bundled = seedImageBase64(image);
    if (bundled === undefined) {
      return plugin;
    }
    void ipc.writeFileBase64(path, bundled).catch(() => {});
    base64 = bundled;
  }
  return {
    ...plugin,
    consoleBackground: { ...plugin.consoleBackground, imageUrl: `data:${mime};base64,${base64}` },
  };
}

/**
 * First line of the AGENTS.md the app maintains in the themes folder. The
 * whole file is regenerated whenever this marker changes (bump the version to
 * ship a new guide) and left alone while it matches — so a user's own edits
 * survive updates only by removing the marker line, which also opts the file
 * out of regeneration for good.
 */
const AGENT_GUIDE_MARKER =
  '<!-- md-specpad themes agent guide v2 (auto-written; delete this line to keep your own edits) -->';

const AGENT_GUIDE = `${AGENT_GUIDE_MARKER}

# Editing this app's themes (guide for AI agents)

You are in the themes folder of md-specpad, a markdown notepad app. Every
\`.json\` file here is one color theme. Your job: edit these files (or add new
ones) to make the changes the user asks for.

## The rules that matter most

1. **A theme file is strict JSON** — no comments, no trailing commas. One bad
   file is skipped by the app (it does not break the others).
2. **The file name is the theme's id** — lowercase letters, numbers and
   dashes, ending in \`.json\` (\`midnight.json\` → theme "midnight"). To make
   a NEW theme, create a new file; do not rename existing ones.
3. **If you edit a built-in theme file, DELETE its top-level \`"version"\`
   field.** Files carrying \`"version"\` are the app's own seeded copies and
   get overwritten on app updates — removing the field marks the file as
   user-owned so your edit survives. (Better: copy it to a new file name and
   edit the copy.)
4. **Changes are NOT picked up automatically.** After saving, tell the user:
   click the tab bar's ⌄ button → Themes → Reload, then select the theme.
5. Respect \`"mode"\`: \`"light"\` themes = dark text on light backgrounds,
   \`"dark"\` = light text on dark. Keep text/background contrast comfortable
   (aim for WCAG AA, ~4.5:1 for body text).

## File format

\`\`\`json
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
\`\`\`

Colors may be hex, \`rgb(...)\`, \`hsl(...)\`, or named CSS colors.

\`branding\` keys — the brand trio: \`primary\` (signature color, usually =
\`accent\`), \`secondary\`, \`tertiary\` (drive the drawing-pen palette). The
interface: \`bg\` (app chrome), \`editorBg\` (writing surface, a hair off
\`bg\`), \`bgAlt\` (panels), \`bgHover\` (hover highlight), \`fg\` (main text),
\`fgMuted\` (secondary text), \`accent\` (links/headings), \`border\`,
\`danger\` (warnings/delete), \`selection\` (selected-text highlight). Missing
keys fall back to the app default for the theme's mode — set them all for a
polished result.

## Optional blocks (add only when asked or clearly needed)

- \`"syntax"\`: recolor markdown elements. Keys: \`heading\` (or
  \`heading1\`…\`heading6\`), \`bold\`, \`italic\`, \`strikethrough\`,
  \`link\`, \`code\`, \`quote\`, \`list\`. Unset keys keep their normal color.
- \`"terminal"\`: exact terminal colors (otherwise derived from branding).
  Keys: \`background\`, \`foreground\`, \`cursor\`, \`cursorText\`,
  \`selection\`, \`selectionText\`, the 8 ANSI names \`black\`…\`white\` and
  \`brightBlack\`…\`brightWhite\`. Also \`backgroundImage\` (file name of an
  image placed in THIS folder, e.g. \`"forest.png"\` — never a path or URL)
  and \`backgroundOpacity\` (0–1; below 1 the app shows through the console).
  In a LIGHT theme these colors are inks, not paper: "bright" variants must be
  DARKER than their plain twins, and \`white\`/\`brightWhite\` must be dark
  enough to read on the surface (4.5:1), because a program written for a dark
  terminal writes its ordinary text in them. \`black\` is the exception — leave
  it dark, applications use it as a background. Getting this wrong is what
  makes coding agents unreadable on light themes.
- \`"css"\`: raw CSS applied while the theme is selected. Last resort.

## Workflow

1. Ask the user what they want changed (which theme, what look) if they
   haven't said.
2. List the folder to see the themes; read the relevant file before editing.
3. Make the edit (remember rule 3 for built-ins).
4. Tell the user: ⌄ menu → Themes → Reload, then pick the theme — and ask if
   it looks right. Iterate.
`;

/**
 * Write (or refresh) the AGENTS.md guide the "AI theme" terminal points its
 * agent at. Regenerated only when the version marker on line 1 is absent or
 * stale, so a file the user de-marked stays theirs. Failures are swallowed —
 * the agent session still works, just with less context.
 */
export async function ensureThemesAgentGuide(themesDir: string): Promise<void> {
  const path = await join(themesDir, 'AGENTS.md');
  try {
    const { text } = await ipc.readTextFile(path);
    if (text.split(/\r?\n/, 1)[0] === AGENT_GUIDE_MARKER) {
      return;
    }
    // md-notepad: the marker written before the app was renamed to MD Specpad.
    if (!/md-(?:specpad|notepad) themes agent guide/.test(text)) {
      // No marker anywhere: the user took the file over (or wrote their own).
      return;
    }
  } catch {
    // Missing or unreadable — write it fresh.
  }
  await ipc.atomicWriteText(path, AGENT_GUIDE).catch(() => {});
}
