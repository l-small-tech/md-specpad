/**
 * milkdown.ts — the Milkdown/Crepe WYSIWYG adapter (recipe in ./README.md).
 *
 * Loaded ONLY via a dynamic import from EditorHost's wysiwyg AdapterFactory
 * (invariant I8): importing this module pulls the whole @milkdown/crepe chunk
 * plus its theme CSS, so startup must never touch it. The two CSS imports below
 * therefore ride along in this lazy chunk — never in the entry bundle.
 *
 * Like CM6 this is a projection of the DocModel (I1), but WYSIWYG editors
 * NORMALIZE markdown, so the write-back rule is stricter (I2): serialization is
 * pushed into the model ONLY after a genuine user edit since attach. Merely
 * opening a note in Edit mode and switching back must be byte-identical. That
 * guarantee is enforced by the write-back guard (core/mode-sync.ts) fed at the
 * ProseMirror transaction level — see "the transaction-tagging pattern" below.
 */

import { Crepe } from '@milkdown/crepe';
import {
  editorViewCtx,
  editorViewOptionsCtx,
  nodeViewCtx,
  parserCtx,
  remarkStringifyOptionsCtx,
  serializerCtx,
} from '@milkdown/kit/core';
import { Slice, type Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView, NodeView, NodeViewConstructor } from '@milkdown/kit/prose/view';
import type { Transaction } from '@milkdown/kit/prose/state';
import { joinDictation } from '../core/dictation-insert';
import type { DocModel } from '../core/doc-model';
import { imageMimeType, localImageToInline } from '../core/images';
import { createWritebackGuard, type EditorAdapter, type WritebackGuard } from '../core/mode-sync';
import { dirName } from '../core/session/plan-flush';
import { boardColorModeOf } from '../core/whiteboard/color-mode';
import type { BoardColorMode } from '../core/whiteboard/scene';
import {
  boardThemeFingerprint,
  injectBoardThemeVars,
  isThemableBoardSvg,
  WB_THEME_VAR_NAMES,
} from '../core/whiteboard/theme-inject';
import { ipc } from '../ipc/commands';
import { markdownNormalizes, shouldShowNormalizationHint } from './wysiwyg-normalize';
import { imageFilesFromDataTransfer, readImageFile } from './image-paste';
import { headingMarksPlugin } from './heading-marks-milkdown';
import '@milkdown/crepe/theme/common/style.css';
import '../styles/wysiwyg.css';

/**
 * Transaction meta flag marking content WE set (initial load, model→editor
 * sync). Such transactions change the doc but are not user edits, so the guard
 * must ignore them — otherwise opening a doc in Edit mode would immediately
 * normalize it.
 */
const PROGRAMMATIC_META = 'md-specpad-programmatic';

/**
 * The app theme's resolved `--wb-*` palette, read off `<html>` — the same
 * source the draw adapter and the preview pane use (no ui import; I9) — with
 * `--wb-bg` replaced by the colour of the surface the image actually sits on.
 * The palette's default background is the whiteboard surface (`--editor-bg`),
 * but the Edit-mode editor paints on the chrome colour (`--bg`), so a board keyed
 * to the palette default would show as a pale rectangle on it; the board
 * should vanish into whatever is behind it.
 */
function readBoardThemeVars(surface: Element | null): Map<string, string> {
  const resolved = getComputedStyle(document.documentElement);
  const vars = new Map<string, string>();
  for (const name of WB_THEME_VAR_NAMES) {
    const value = resolved.getPropertyValue(name).trim();
    if (value.length > 0) {
      vars.set(name, value);
    }
  }
  const bg = surfaceBackground(surface);
  if (bg) {
    vars.set('--wb-bg', bg);
  }
  return vars;
}

/** The first non-transparent computed background colour at or above `el`. */
function surfaceBackground(el: Element | null): string | null {
  for (let node = el; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    if (color && color !== 'transparent' && !/^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\)$/.test(color)) {
      return color;
    }
  }
  return null;
}

export interface MilkdownOptions {
  /**
   * Called once per tab when entering Edit mode WOULD reformat the current
   * markdown (content preserved). EditorHost surfaces the status-bar hint.
   */
  onNormalizationHint?: () => void;
  /**
   * Ghost text shown while the document is EMPTY (Crepe's placeholder feature
   * in `doc` mode — never per-block). Multi-line; rendered `pre-wrap`.
   */
  placeholder?: string;
  /**
   * Save a pasted image and return how to reference it (alt + src), or null on
   * failure. When set, a paste carrying image files is intercepted and an image
   * node inserted at the caret instead of the raw bytes.
   */
  saveImage?: (data: {
    base64: string;
    ext: string;
    name: string | null;
  }) => Promise<{ alt: string; src: string } | null>;
  /**
   * Current path of the document being edited (or null when unsaved). Used to
   * resolve RELATIVE image references so they can be read off disk and shown
   * inline — the app CSP blocks loading a local file by path, so a raw `<img>`
   * would otherwise render broken. A getter, not a value: a note tab is assigned
   * its path AFTER it first opens, and a rename can move it later.
   */
  getDocPath?: () => string | null;
  /**
   * A whiteboard image (a `.svg` carrying the dual colour representation, see
   * `core/whiteboard/color-mode.ts`) was right-clicked. The host opens its
   * "theme colours / true colours" menu; the editor only reports the board's
   * absolute path, the mode it renders in now, and the pointer position. Other
   * images keep the webview's native menu. Omit and board right-clicks are
   * native too.
   */
  onBoardContextMenu?: (info: { path: string; mode: BoardColorMode; x: number; y: number }) => void;
}

/** The Edit adapter's extras beyond the mode-sync contract. */
export interface MilkdownAdapter extends EditorAdapter {
  /**
   * The files at these absolute paths changed on disk (the colour-mode toggle
   * rewrote a board): drop their cached data URLs and reload every live image
   * node that shows one. Paths not in the document cost nothing.
   */
  refreshImages(paths: readonly string[]): void;
  /**
   * The app theme changed: re-apply every live image node so boards re-bake
   * the new `--wb-*` palette (cache keys carry the theme fingerprint, so this
   * is a re-read only when the resolved values actually moved).
   */
  refreshTheme(): void;
  /** Voice typing: put a dictated phrase at the caret (`joinDictation` spacing). */
  insertText(text: string): void;
  /**
   * The heading whose section is at the top of the viewport, as an index into
   * the document's headings (what `revealHeading` takes back). -1 = above the
   * first heading; null while detached or hidden. The mode-switch scroll
   * anchor's Edit-editor half — see `core/mode-scroll`.
   */
  getTopHeadingIndex(): number | null;
}

/** Everything an image node view needs from its adapter, shared by all of them. */
interface ImageViewContext {
  /** Adapter-lifetime abs-path(+theme fingerprint) → data-URL map. */
  cache: Map<string, string>;
  /** abs svg path → colour mode (null = not a board), filled with the cache. */
  boardModes: Map<string, BoardColorMode | null>;
  /** Live views' re-apply hooks, for `refreshImages` / `refreshTheme`. */
  live: Map<HTMLImageElement, () => void>;
  /** The attach host — the surface whose background boards blend into. */
  host: HTMLElement;
  getDocPath: () => string | null;
  onBoardContextMenu: MilkdownOptions['onBoardContextMenu'];
}

/**
 * ProseMirror node view for the `image` node that shows local images inline.
 * It resolves the node's (relative or local) `src` to a data URL read off disk
 * and puts THAT on the DOM `<img>`, while never touching `node.attrs.src` — so
 * serialization (I2 write-back) still emits the original path, not a giant data
 * URL. Being a leaf node view, ProseMirror ignores our async `src` mutation
 * (its default `ignoreMutation`), so the swap can't echo back into the doc.
 *
 * `cache` is the adapter-lifetime abs-path → data-URL map (one disk read per
 * image); `getDocPath` supplies the directory relative refs resolve against.
 */
function createImageNodeView(node: ProseNode, ctx: ImageViewContext): NodeView {
  const { cache, boardModes, getDocPath } = ctx;
  const img = document.createElement('img');
  let current = node;

  /** Tag a board for the right-click handler; clear the tag for anything else. */
  function tagBoard(abs: string | null): void {
    const mode = abs ? boardModes.get(abs) : undefined;
    if (mode) {
      img.dataset.wbPath = abs!;
      img.dataset.wbMode = mode;
    } else {
      delete img.dataset.wbPath;
      delete img.dataset.wbMode;
    }
  }

  img.addEventListener('contextmenu', (event) => {
    const path = img.dataset.wbPath;
    const mode = img.dataset.wbMode;
    if (!path || (mode !== 'themed' && mode !== 'fixed') || !ctx.onBoardContextMenu) {
      return; // not a board — the native menu stays (contenteditable exemption)
    }
    event.preventDefault();
    ctx.onBoardContextMenu({ path, mode, x: event.clientX, y: event.clientY });
  });

  function apply(n: ProseNode): void {
    current = n;
    tagBoard(null);
    const alt = (n.attrs.alt as string) ?? '';
    const title = (n.attrs.title as string) ?? '';
    const raw = (n.attrs.src as string) ?? '';
    img.alt = alt;
    if (title) {
      img.title = title;
    } else {
      img.removeAttribute('title');
    }
    // Tag the element with the src it currently WANTS, so a slow disk read that
    // resolves after the node was edited to a different image is discarded.
    img.dataset.mdSrc = raw;
    const docPath = getDocPath();
    const abs = localImageToInline(docPath ? dirName(docPath) : null, raw);
    if (abs === null) {
      // External, already-inlined, or unresolvable — use the src verbatim.
      img.setAttribute('src', raw);
      return;
    }
    // A whiteboard `.svg` gets the app theme's resolved `--wb-*` palette baked
    // into its data URL — inside an `<img>` the page's variables can't reach
    // it (see core/whiteboard/theme-inject.ts). The cache key carries the theme
    // fingerprint so a theme change misses instead of pinning stale colours.
    const svg = abs.toLowerCase().endsWith('.svg');
    // The surface: the image itself once mounted, else the editor root (the
    // `.milkdown` element Crepe paints — its host may be transparent).
    const themeVars = svg
      ? readBoardThemeVars(
          img.isConnected ? img : (ctx.host.querySelector('.milkdown') ?? ctx.host),
        )
      : null;
    const key = themeVars ? `${abs}|${boardThemeFingerprint(themeVars)}` : abs;
    const cached = cache.get(key);
    if (cached !== undefined) {
      img.setAttribute('src', cached);
      tagBoard(abs);
      return;
    }
    // Blank until the bytes arrive, to avoid a broken-image flash on the path.
    img.removeAttribute('src');
    const load = themeVars
      ? ipc.readTextFile(abs).then(({ text }) => {
          boardModes.set(abs, boardColorModeOf(text));
          const themed = isThemableBoardSvg(text) ? injectBoardThemeVars(text, themeVars) : text;
          return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(themed)}`;
        })
      : ipc.readFileBase64(abs).then((b64) => `data:${imageMimeType(abs)};base64,${b64}`);
    void load
      .then((dataUrl) => {
        cache.set(key, dataUrl);
        if (img.dataset.mdSrc === raw) {
          img.setAttribute('src', dataUrl);
          tagBoard(abs);
        }
      })
      .catch(() => {
        // Missing/unreadable — fall back to the raw path (renders broken, which
        // is the honest signal that the image can't be found).
        if (img.dataset.mdSrc === raw) {
          img.setAttribute('src', raw);
        }
      });
  }

  apply(node);
  ctx.live.set(img, () => apply(current));
  // The first apply ran before the node was mounted, so the surface colour
  // came from the editor root; once in the DOM, re-read it from the image's
  // own ancestry (a cache hit when nothing differs).
  requestAnimationFrame(() => {
    if (img.isConnected && ctx.live.has(img)) {
      apply(current);
    }
  });
  return {
    dom: img,
    update(updated: ProseNode): boolean {
      if (updated.type.name !== 'image') {
        return false;
      }
      apply(updated);
      return true;
    },
    destroy() {
      ctx.live.delete(img);
    },
  };
}

/**
 * Insert an image at the current selection. Uses the schema's inline `image`
 * node (present in Crepe's commonmark preset even with the ImageBlock upload
 * feature disabled); falls back to typing the markdown if that node is ever
 * absent. The dispatch routes through the adapter's dispatchTransaction, so the
 * write-back guard serializes it into the model.
 */
function insertImageNode(view: EditorView, alt: string, src: string): void {
  const { state } = view;
  const imageType = state.schema.nodes.image;
  if (imageType) {
    view.dispatch(state.tr.replaceSelectionWith(imageType.create({ src, alt }), false));
  } else {
    view.dispatch(state.tr.insertText(`![${alt}](${src})`));
  }
}

export function createMilkdownAdapter(options: MilkdownOptions = {}): MilkdownAdapter {
  let crepe: Crepe | null = null;
  let view: EditorView | null = null;
  let guard: WritebackGuard | null = null;
  let unsubscribe: (() => void) | null = null;
  /** One-time-per-tab hint gate; the adapter instance lives for the tab. */
  let hintShown = false;
  /**
   * Reentrancy flag guarding the model→editor path against our own write-back
   * echo (the guard pushes with source 'milkdown', which re-enters the model
   * subscription synchronously — the doc-model.ts echo-suppression pattern).
   */
  let pushingSelf = false;
  /** The image node views' shared state; rebuilt per attach. */
  let imageViews: ImageViewContext | null = null;

  /** Current editor markdown. Empty before create / after destroy. */
  function serialize(): string {
    return crepe ? crepe.getMarkdown() : '';
  }

  /**
   * Replace the whole document from markdown, tagged programmatic so the guard
   * never counts it as a user edit. Used for external model changes (e.g. a
   * file-reload while the tab sits in Edit mode).
   */
  function setContentProgrammatic(text: string): void {
    crepe?.editor.action((ctx) => {
      const v = ctx.get(editorViewCtx);
      const doc = ctx.get(parserCtx)(text);
      if (!doc) {
        return;
      }
      const tr = v.state.tr.replace(0, v.state.doc.content.size, new Slice(doc.content, 0, 0));
      tr.setMeta(PROGRAMMATIC_META, true);
      v.dispatch(tr);
    });
  }

  async function attach(host: HTMLElement, model: DocModel): Promise<void> {
    const initialText = model.getText();

    guard = createWritebackGuard({
      serialize,
      push: (text) => {
        pushingSelf = true;
        try {
          model.pushText(text, 'milkdown');
        } finally {
          pushingSelf = false;
        }
      },
    });
    const boundGuard = guard;

    crepe = new Crepe({
      root: host,
      defaultValue: initialText,
      // Trim features that fight the minimal look or are non-goals for v1:
      // no image upload UI, no LaTeX math, no AI, no document top bar. The
      // slash menu / selection toolbar / table UI stay — they're the point.
      features: {
        [Crepe.Feature.ImageBlock]: false,
        [Crepe.Feature.Latex]: false,
        [Crepe.Feature.AI]: false,
        [Crepe.Feature.TopBar]: false,
        // The per-block "Please enter..." ghost is noise; only the whole-doc
        // hint for an empty note is wanted, and only when the host asks.
        [Crepe.Feature.Placeholder]: Boolean(options.placeholder),
      },
      featureConfigs: {
        [Crepe.Feature.Placeholder]: { text: options.placeholder ?? '', mode: 'doc' },
      },
    });

    // The transaction-tagging pattern (README "#1 pitfall"): route EVERY
    // ProseMirror transaction through the guard. Milkdown does not set its own
    // dispatchTransaction (it spreads editorViewOptionsCtx into the view), so
    // we own it — which means we must apply the new state ourselves, exactly
    // as ProseMirror's default dispatch would, then report to the guard.
    imageViews = {
      cache: new Map(),
      boardModes: new Map(),
      live: new Map(),
      host,
      getDocPath: options.getDocPath ?? (() => null),
      onBoardContextMenu: options.onBoardContextMenu,
    };
    const views = imageViews;

    crepe.editor.config((ctx) => {
      // Serialize bullet lists with `-`, matching what the raw editor's
      // auto-bullet/Tab handling writes (cm6.ts) — remark-stringify's default
      // is `*`, which would silently rewrite every bullet marker on the first
      // edit in Edit mode.
      ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, bullet: '-' as const }));

      // Render local images inline (see createImageNodeView). Registered through
      // nodeViewCtx — Milkdown merges these entries into the view's nodeViews
      // (last wins), so we add `image` without clobbering the node views Crepe's
      // other features register. With the ImageBlock feature off nothing else
      // claims `image`, so ours is the only one.
      const imageEntry: [string, NodeViewConstructor] = [
        'image',
        (imgNode) => createImageNodeView(imgNode, views),
      ];
      ctx.update(nodeViewCtx, (views) => [
        ...views.filter(([name]) => name !== 'image'),
        imageEntry,
      ]);
      ctx.update(editorViewOptionsCtx, (prev) => ({
        ...prev,
        // Intercept a paste carrying image files: save each and insert an image
        // node at the caret (a normal, non-programmatic edit, so the guard
        // writes it back to the model). Non-image pastes fall through.
        handlePaste(v: EditorView, event: ClipboardEvent): boolean {
          if (!options.saveImage) {
            return false;
          }
          const files = imageFilesFromDataTransfer(event.clipboardData);
          if (files.length === 0) {
            return false;
          }
          event.preventDefault();
          void (async () => {
            for (const file of files) {
              const ref = await options.saveImage!(await readImageFile(file));
              if (ref) {
                insertImageNode(v, ref.alt, ref.src);
              }
            }
          })();
          return true;
        },
        dispatchTransaction(tr: Transaction) {
          if (!view) {
            return;
          }
          view.updateState(view.state.apply(tr));
          boundGuard.noteTransaction({
            docChanged: tr.docChanged,
            programmatic: tr.getMeta(PROGRAMMATIC_META) === true,
          });
        },
      }));
    });

    // Right-click a heading → Mark running / complete (heading-marks-milkdown.ts).
    crepe.editor.use(headingMarksPlugin);

    await crepe.create();
    view = crepe.editor.action((ctx) => ctx.get(editorViewCtx));

    // Normalization hint: if parse→serialize of the current text differs, Edit
    // mode will reformat syntax on the first edit. Warn once per tab.
    if (!hintShown) {
      const roundTripped = crepe.editor.action((ctx) => {
        const parse = ctx.get(parserCtx);
        const stringify = ctx.get(serializerCtx);
        const doc = parse(initialText);
        return doc ? stringify(doc) : initialText;
      });
      if (shouldShowNormalizationHint(markdownNormalizes(initialText, roundTripped), hintShown)) {
        hintShown = true;
        options.onNormalizationHint?.();
      }
    }

    // Model → editor: apply external changes (not our own write-back echo).
    // Re-parse programmatically so the guard never sees them as user edits.
    unsubscribe = model.subscribe((change) => {
      if (pushingSelf) {
        return;
      }
      if (change.text === serialize()) {
        return;
      }
      setContentProgrammatic(change.text);
    });
  }

  function detach(): void {
    // MUST flush pending write-back BEFORE tearing down (EditorAdapter contract
    // — this is what makes fast mode-toggling lossless). flushSync serializes
    // the current editor state and pushes it while the editor still exists.
    guard?.flushSync();
    guard?.dispose();
    guard = null;
    unsubscribe?.();
    unsubscribe = null;
    view = null;
    // Crepe.destroy is async; we don't await it (detach is sync by contract).
    // The host element is owned by mode-sync/EditorHost, which clears it.
    void crepe?.destroy();
    crepe = null;
    imageViews = null;
  }

  return {
    attach,
    detach,
    refreshTheme() {
      // Next frame: the caller reacts to the store tick that swaps the theme
      // stylesheet, and the vars must be READ after the new CSS applies.
      requestAnimationFrame(() => {
        for (const reapply of imageViews?.live.values() ?? []) {
          reapply();
        }
      });
    },
    refreshImages(paths) {
      const views = imageViews;
      if (!views || paths.length === 0) {
        return;
      }
      let hit = false;
      for (const abs of paths) {
        for (const key of [...views.cache.keys()]) {
          if (key === abs || key.startsWith(`${abs}|`)) {
            views.cache.delete(key);
            hit = true;
          }
        }
        if (views.boardModes.delete(abs)) {
          hit = true;
        }
      }
      if (hit) {
        for (const reapply of views.live.values()) {
          reapply();
        }
      }
    },
    focus() {
      view?.focus();
    },
    insertText(text) {
      if (!view) {
        return;
      }
      const { state } = view;
      const { from, to } = state.selection;
      const before = state.doc.textBetween(Math.max(0, from - 1), from, '\n', ' ');
      const after = state.doc.textBetween(to, Math.min(state.doc.content.size, to + 1), '\n', ' ');
      const insert = joinDictation(before, text, after);
      if (!insert) {
        return;
      }
      // Routed through dispatchTransaction, so the write-back serializes it.
      view.dispatch(state.tr.insertText(insert, from, to).scrollIntoView());
      view.focus();
    },
    revealHeading(index, place = 'center') {
      // The outline indexes headings in document order; the rendered DOM lists
      // them in the same order, so the nth h1–h6 in the ProseMirror root is the
      // one. Out-of-range (outline a debounce behind the doc) is a no-op.
      if (!view || index < 0) {
        return;
      }
      const heading = view.dom.querySelectorAll('h1,h2,h3,h4,h5,h6')[index];
      heading?.scrollIntoView({ block: place, behavior: 'auto' });
    },
    getTopHeadingIndex() {
      // The inverse of revealHeading, for the mode-switch scroll anchor: the
      // last heading at or above the viewport's top edge is the section being
      // read. -1 means "above the first heading" — the top of the document.
      // Rendered nodes carry no source lines, so headings are the finest
      // landmark this editor and a line-addressed surface both understand
      // (`core/mode-scroll`).
      const scroller = view?.dom.closest<HTMLElement>('.milkdown');
      if (!view || !scroller) {
        return null;
      }
      const box = scroller.getBoundingClientRect();
      if (box.height === 0) {
        return null; // hidden (display:none) — every rect reads zero
      }
      const headings = view.dom.querySelectorAll('h1,h2,h3,h4,h5,h6');
      let index = -1;
      for (let i = 0; i < headings.length; i++) {
        if (headings[i]!.getBoundingClientRect().top <= box.top + 1) {
          index = i;
        } else {
          break;
        }
      }
      return index;
    },
  };
}
