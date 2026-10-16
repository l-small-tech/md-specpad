/**
 * deck-editor.ts — Edit mode on a Marp deck: a filmstrip, the real rendered
 * slide, and an inspector (src/editors/README.md "deck-editor.ts").
 *
 * The workflow it serves: an agent writes the deck, a person tweaks it to
 * perfection. So nothing here re-serialises the document. Every gesture is one
 * of the line-precise edits in `core/deck-edit.ts`, pushed into the DocModel
 * at once — there is no editor-side document to normalise, which makes the
 * write-back guard's promise ("mount → look → leave is byte-identical") hold
 * by construction: no gesture, no push.
 *
 * - Filmstrip: select, drag to reorder, add / duplicate / delete.
 * - Stage: the slide exactly as Marp renders it, stamped with source lines
 *   (`stampLines`). Click a heading, paragraph, list item or code fence and
 *   you type into it where it stands (`deck-inline.ts`); anything richer (an
 *   image, a table, math) opens a popover over THAT block's markdown, the
 *   slide following as you type. Click away to finish; Esc puts it back.
 * - Inspector: this slide's spot directives (`_class`, `_backgroundColor`…),
 *   its `![bg]` image, and the deck-wide frontmatter settings.
 * - Notes: the slide's speaker notes, one comment.
 *
 * Rendering is INJECTED (`DeckEngine`): Marp lives in `src/preview/marp.ts`,
 * and editors never import preview (I9) — `ui` hands the engine over, the same
 * way the whiteboard is handed its camera.
 *
 * Undo is the adapter's own (the source editor's history is per-editor and is
 * not attached in this mode): one entry per gesture, typing coalesced.
 */

import { frontmatterValue, slideIndexForLine, splitSlides, type SlideRange } from '../core/deck';
import {
  appendBlock,
  appendedBlockRange,
  blockRange,
  deleteSlide,
  duplicateSlide,
  getImageWidth,
  getLines,
  getSlideBackground,
  getSlideDirective,
  getSlideNotes,
  insertSlide,
  moveSlide,
  replaceLines,
  setFrontmatterValue,
  setImageWidth,
  setSlideBackground,
  setSlideDirective,
  setSlideNotes,
  type BackgroundFit,
  type BackgroundSide,
} from '../core/deck-edit';
import type { DocModel } from '../core/doc-model';
import { extractOutline } from '../core/outline';
import { dirName } from '../core/session/plan-flush';
import type { EditorAdapter } from './adapter';
import {
  canEditInline,
  inlineKindOf,
  inlineMarkdown,
  inlineSource,
  rebuildInline,
  type InlineKind,
  type InlineSource,
} from './deck-inline';

/** What the editor needs of Marp — `preview/marp.ts`, handed over by `ui`. */
export interface DeckEngine {
  render(
    markdown: string,
    options: { docPath: string | null; stampLines: boolean },
  ): Promise<{
    css: string;
    slides: { html: string }[];
    width: number;
    height: number;
  }>;
  mountSlide(root: ShadowRoot, css: string, html: string, force?: boolean): boolean;
  inlineImages(
    root: ParentNode,
    docDir: string | null,
    resolve: (absPath: string) => Promise<string | null>,
  ): Promise<void>;
  createImageResolver(): (absPath: string) => Promise<string | null>;
  applyBrowser(root: ParentNode): () => void;
  stripStamps(html: string): string;
}

export interface DeckEditorOptions {
  engine: DeckEngine;
  /** The document's path now (an untitled note gains one later). */
  getDocPath: () => string | null;
  /** Browse… for a background: the path to WRITE (relative when possible). */
  pickImage?: () => Promise<string | null>;
  /** "Source": show this line in the source editor. */
  onOpenSource?: (line: number) => void;
}

export interface DeckEditorAdapter extends EditorAdapter {
  /** First source line of the slide on the stage (the mode-switch anchor). */
  getCurrentLine(): number | null;
  /** Put the slide holding `line` on the stage. */
  showLine(line: number): void;
}

const RENDER_DEBOUNCE_MS = 60;
const TYPING_DEBOUNCE_MS = 200;
const DRAG_SLOP_PX = 6;
const UNDO_LIMIT = 200;
const THEMES = ['default', 'gaia', 'uncover'];
const LAYOUTS = ['lead', 'invert', 'lead invert'];

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/** `#abc` / `#aabbcc` → the `#rrggbb` a colour input takes; anything else null. */
function hexColor(value: string): string | null {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) {
    return v.toLowerCase();
  }
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v);
  return short
    ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase()
    : null;
}

interface Thumb {
  wrapper: HTMLDivElement;
  number: HTMLSpanElement;
  root: ShadowRoot;
  stopBrowser: () => void;
}

interface Pop {
  start: number;
  end: number;
  /** The whole document as it was when the block was opened (Esc). */
  originalDoc: string;
  key: string;
  box: HTMLDivElement;
  area: HTMLTextAreaElement;
  timer: ReturnType<typeof setTimeout> | null;
}

/** A block being typed into where it stands, on the stage itself. */
interface Inline {
  start: number;
  end: number;
  originalDoc: string;
  key: string;
  block: HTMLElement;
  kind: InlineKind;
  parts: InlineSource;
  /** The body as last written to the document (at first: as it was opened). */
  written: string;
  timer: ReturnType<typeof setTimeout> | null;
}

/** A form field whose typing is pushed after a pause, and at once on demand. */
interface Writer {
  flush(): void;
}

export function createDeckEditorAdapter(options: DeckEditorOptions): DeckEditorAdapter {
  const { engine } = options;
  let host: HTMLElement | null = null;
  let model: DocModel | null = null;
  let unsubscribe: (() => void) | null = null;
  let teardown: (() => void) | null = null;
  let pushingSelf = false;
  /** Survives detach → attach: coming back to Edit lands on the same slide. */
  let current = 0;

  /* Everything below is per-attach and is rebuilt by `attach`. */
  let ranges: SlideRange[] = [];
  let refresh: (external: boolean) => void = () => {};
  let select: (index: number) => void = () => {};
  let focusStrip: () => void = () => {};

  function build(root: HTMLElement, doc: DocModel): () => void {
    const dom = root.ownerDocument;
    const undoStack: string[] = [];
    const redoStack: string[] = [];
    let lastKey: string | null = null;
    let renderTimer: ReturnType<typeof setTimeout> | null = null;
    let renderSeq = 0;
    let alive = true;
    let deck: Awaited<ReturnType<DeckEngine['render']>> | null = null;
    let resolveImage = engine.createImageResolver();
    let resolverDir: string | null = null;
    const thumbs: Thumb[] = [];
    const writers: Writer[] = [];
    let pop: Pop | null = null;
    let inline: Inline | null = null;
    /** The stage's DOM was typed into: the next mount must replace it. */
    let stageDirty = false;
    let popSerial = 0;

    /* ---- skeleton ------------------------------------------------------ */

    root.classList.add('deck-edit');
    root.replaceChildren();
    const strip = el(dom, 'div', 'deck-edit-strip');
    strip.tabIndex = 0;
    strip.setAttribute('role', 'listbox');
    strip.setAttribute('aria-label', 'Slides');
    const drop = el(dom, 'div', 'deck-edit-drop');
    drop.hidden = true;
    const main = el(dom, 'div', 'deck-edit-main');
    const toolbar = el(dom, 'div', 'deck-edit-toolbar');
    const stage = el(dom, 'div', 'deck-edit-stage');
    const frame = el(dom, 'div', 'deck-edit-frame');
    const stageRoot = frame.attachShadow({ mode: 'open' });
    const stopStageBrowser = engine.applyBrowser(stageRoot);
    const outline = el(dom, 'div', 'deck-edit-outline');
    outline.hidden = true;
    stage.append(frame, outline);
    const notesBox = el(dom, 'div', 'deck-edit-notes');
    const notesLabel = el(dom, 'label', 'deck-edit-label', 'Speaker notes');
    const notesArea = el(dom, 'textarea', 'deck-edit-notes-text');
    notesArea.placeholder = 'What you will say on this slide…';
    notesArea.spellcheck = true;
    notesBox.append(notesLabel, notesArea);
    main.append(toolbar, stage, notesBox);
    const inspector = el(dom, 'div', 'deck-edit-inspector');
    root.append(strip, main, inspector);

    /* ---- pushing, undo -------------------------------------------------- */

    function push(next: string, coalesce: string | null = null): void {
      const prev = doc.getText();
      if (next === prev) {
        return;
      }
      if (coalesce === null || coalesce !== lastKey) {
        undoStack.push(prev);
        if (undoStack.length > UNDO_LIMIT) {
          undoStack.shift();
        }
      }
      lastKey = coalesce;
      redoStack.length = 0;
      apply(next);
    }

    function apply(next: string): void {
      pushingSelf = true;
      try {
        doc.pushText(next, 'deck-edit');
      } finally {
        pushingSelf = false;
      }
      refresh(false);
    }

    function flushWriters(): void {
      for (const writer of writers) {
        writer.flush();
      }
    }

    function step(from: string[], to: string[]): void {
      flushWriters();
      closePop(true);
      const target = from.pop();
      if (target === undefined) {
        return;
      }
      to.push(doc.getText());
      lastKey = null;
      apply(target);
    }

    /* ---- toolbar -------------------------------------------------------- */

    function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
      const b = el(dom, 'button', 'deck-edit-button', label);
      b.type = 'button';
      b.title = title;
      b.addEventListener('click', onClick);
      return b;
    }

    function slideOp(op: (text: string, index: number) => string, land: (index: number) => number) {
      return () => {
        flushWriters();
        closePop(true);
        const index = current;
        const next = op(doc.getText(), index);
        current = Math.max(0, land(index));
        push(next);
      };
    }

    const addText = button('+ Text', 'Add a text block to this slide', () => {
      flushWriters();
      closePop(true);
      const before = doc.getText();
      const after = appendBlock(before, current, 'New text');
      const range = appendedBlockRange(before, after);
      push(after);
      if (range) {
        openPop(range.start, range.end, null, true);
      }
    });
    const undoButton = button('Undo', 'Undo (Ctrl/Cmd+Z)', () => step(undoStack, redoStack));
    const redoButton = button('Redo', 'Redo (Ctrl/Cmd+Shift+Z)', () => step(redoStack, undoStack));
    const counter = el(dom, 'span', 'deck-edit-count');
    const moveUp = button('↑', 'Move slide earlier (Alt+Up)', () => moveBy(-1));
    const moveDown = button('↓', 'Move slide later (Alt+Down)', () => moveBy(1));
    const addSlide = button(
      '+ Slide',
      'New slide after this one',
      slideOp(insertSlide, (i) => i + 1),
    );
    const duplicate = button(
      'Duplicate',
      'Duplicate slide (Ctrl/Cmd+D)',
      slideOp(duplicateSlide, (i) => i + 1),
    );
    const remove = button(
      'Delete',
      'Delete slide (Delete)',
      slideOp(deleteSlide, (i) => Math.min(i, ranges.length - 2)),
    );
    const spacer = el(dom, 'span', 'deck-edit-spacer');
    toolbar.append(addText, undoButton, redoButton, spacer, counter, moveUp, moveDown);
    toolbar.append(addSlide, duplicate, remove);
    if (options.onOpenSource) {
      toolbar.append(
        button('Source', 'Show this slide in the source editor', () => {
          const line = ranges[current]?.start;
          if (line !== undefined) {
            options.onOpenSource?.(line);
          }
        }),
      );
    }

    function moveBy(delta: number): void {
      const to = current + delta;
      if (to < 0 || to >= ranges.length) {
        return;
      }
      flushWriters();
      closePop(true);
      const next = moveSlide(doc.getText(), current, to);
      current = to;
      push(next);
    }

    /* ---- inspector ------------------------------------------------------ */

    /** Fields re-read from the document by `syncInspector`. */
    const syncers: ((text: string, external: boolean) => void)[] = [];

    function section(title: string): HTMLDivElement {
      const box = el(dom, 'div', 'deck-edit-section');
      box.appendChild(el(dom, 'div', 'deck-edit-section-title', title));
      inspector.appendChild(box);
      return box;
    }

    // A <div>, not a <label>: a label wrapping two buttons clicks the first
    // one wherever it is pressed. The controls are named for a screen reader.
    function row(parent: HTMLElement, label: string, ...controls: HTMLElement[]): HTMLDivElement {
      const line = el(dom, 'div', 'deck-edit-row');
      line.appendChild(el(dom, 'span', 'deck-edit-row-label', label));
      if (label !== '') {
        controls[0]?.setAttribute('aria-label', label);
      }
      const slot = el(dom, 'span', 'deck-edit-row-controls');
      slot.append(...controls);
      line.appendChild(slot);
      parent.appendChild(line);
      return line;
    }

    /** A value may be overwritten from the document unless the user is in it. */
    function settable(field: HTMLElement, external: boolean): boolean {
      return external || dom.activeElement !== field;
    }

    /**
     * A text field: typing is pushed after a pause (one undo entry per visit),
     * `read` refills it from the document.
     */
    function textField(
      key: string,
      placeholder: string,
      read: (text: string) => string,
      write: (text: string, value: string) => string,
    ): HTMLInputElement {
      const input = el(dom, 'input', 'deck-edit-input');
      input.type = 'text';
      input.placeholder = placeholder;
      input.spellcheck = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let visit = 0;
      const flush = () => {
        if (timer === null) {
          return;
        }
        clearTimeout(timer);
        timer = null;
        push(write(doc.getText(), input.value.trim()), `${key}:${current}:${visit}`);
      };
      input.addEventListener('input', () => {
        if (timer !== null) {
          clearTimeout(timer);
        }
        timer = setTimeout(flush, TYPING_DEBOUNCE_MS);
      });
      input.addEventListener('focus', () => visit++);
      input.addEventListener('blur', flush);
      writers.push({ flush });
      syncers.push((text, external) => {
        if (timer === null && settable(input, external)) {
          input.value = read(text);
        }
      });
      return input;
    }

    function selectField(
      choices: readonly (readonly [value: string, label: string])[],
      read: (text: string) => string,
      write: (text: string, value: string) => string,
    ): HTMLSelectElement {
      const field = el(dom, 'select', 'deck-edit-input');
      for (const [value, label] of choices) {
        const option = el(dom, 'option', undefined, label);
        option.value = value;
        field.appendChild(option);
      }
      field.addEventListener('change', () => {
        flushWriters();
        push(write(doc.getText(), field.value));
      });
      syncers.push((text) => {
        const value = read(text);
        // A value from the file this list does not know (a custom theme or
        // class) is offered as itself rather than shown as something else.
        if (![...field.options].some((o) => o.value === value)) {
          const option = el(dom, 'option', undefined, value);
          option.value = value;
          field.appendChild(option);
        }
        field.value = value;
      });
      return field;
    }

    /** A colour: free text (`aqua`, `#fff`, `rgb(…)`) with a swatch beside it. */
    function colorField(key: string, directive: string): HTMLElement[] {
      const text = textField(
        key,
        'inherited',
        (t) => getSlideDirective(t, current, directive) ?? '',
        (t, value) => setSlideDirective(t, current, directive, value),
      );
      const swatch = el(dom, 'input', 'deck-edit-swatch');
      swatch.type = 'color';
      swatch.title = 'Pick a colour';
      swatch.addEventListener('input', () => {
        text.value = swatch.value;
        text.dispatchEvent(new Event('input'));
      });
      swatch.addEventListener('change', () => text.dispatchEvent(new Event('blur')));
      syncers.push(() => {
        swatch.value = hexColor(text.value) ?? '#ffffff';
      });
      return [text, swatch];
    }

    const slideBox = section('Slide');
    row(
      slideBox,
      'Layout',
      selectField(
        [['', 'Default'], ...LAYOUTS.map((l) => [l, l] as const)],
        (t) => getSlideDirective(t, current, 'class') ?? '',
        (t, value) => setSlideDirective(t, current, 'class', value),
      ),
    );
    row(slideBox, 'Background', ...colorField('bgcolor', 'backgroundColor'));
    row(slideBox, 'Text colour', ...colorField('color', 'color'));
    row(
      slideBox,
      'Page number',
      selectField(
        [
          ['', 'As the deck'],
          ['true', 'Show'],
          ['false', 'Hide'],
        ],
        (t) => getSlideDirective(t, current, 'paginate') ?? '',
        (t, value) => setSlideDirective(t, current, 'paginate', value),
      ),
    );
    row(
      slideBox,
      'Header',
      textField(
        'header',
        'inherited',
        (t) => getSlideDirective(t, current, 'header') ?? '',
        (t, value) => setSlideDirective(t, current, 'header', value),
      ),
    );
    row(
      slideBox,
      'Footer',
      textField(
        'footer',
        'inherited',
        (t) => getSlideDirective(t, current, 'footer') ?? '',
        (t, value) => setSlideDirective(t, current, 'footer', value),
      ),
    );

    const imageBox = section('Background image');
    /** The image line the four fields below describe, from their current values. */
    function writeBackground(text: string): string {
      const src = bgSrc.value.trim();
      if (src === '') {
        return setSlideBackground(text, current, null);
      }
      return setSlideBackground(text, current, {
        src,
        side: bgSide.value as BackgroundSide,
        sideSize: bgSide.value === 'full' ? null : bgShare.value.trim() || null,
        fit: (bgFit.value || null) as BackgroundFit | null,
        extra: getSlideBackground(text, current)?.extra ?? [],
      });
    }
    const bgSrc = textField(
      'bgsrc',
      'none — path or URL',
      (t) => getSlideBackground(t, current)?.src ?? '',
      (t) => writeBackground(t),
    );
    const bgSide = selectField(
      [
        ['full', 'Whole slide'],
        ['left', 'Left, beside the text'],
        ['right', 'Right, beside the text'],
      ],
      (t) => getSlideBackground(t, current)?.side ?? 'full',
      (t) => writeBackground(t),
    );
    const bgShare = textField(
      'bgshare',
      'half — e.g. 40%',
      (t) => getSlideBackground(t, current)?.sideSize ?? '',
      (t) => writeBackground(t),
    );
    const bgFit = selectField(
      [
        ['', 'Fill (crop to fit)'],
        ['contain', 'Show whole image'],
        ['auto', 'Original size'],
      ],
      (t) => {
        const fit = getSlideBackground(t, current)?.fit ?? '';
        return fit === 'cover' ? '' : fit === 'fit' ? 'contain' : fit;
      },
      (t) => writeBackground(t),
    );
    const bgButtons: HTMLElement[] = [];
    if (options.pickImage) {
      bgButtons.push(
        button('Browse…', 'Choose an image file', () => {
          void options.pickImage?.().then((path) => {
            if (path && alive) {
              flushWriters();
              bgSrc.value = path;
              push(writeBackground(doc.getText()));
            }
          });
        }),
      );
    }
    const bgRemove = button('Remove', 'Remove the background image', () => {
      flushWriters();
      push(setSlideBackground(doc.getText(), current, null));
    });
    bgButtons.push(bgRemove);
    row(imageBox, 'Image', bgSrc);
    row(imageBox, '', ...bgButtons);
    const sideRow = row(imageBox, 'Placement', bgSide);
    const shareRow = row(imageBox, 'Width', bgShare);
    const fitRow = row(imageBox, 'Sizing', bgFit);
    syncers.push((text) => {
      const bg = getSlideBackground(text, current);
      const none = bg === null;
      bgRemove.disabled = none;
      sideRow.hidden = none;
      fitRow.hidden = none;
      shareRow.hidden = none || bg.side === 'full';
    });

    const deckBox = section('Whole deck');
    row(
      deckBox,
      'Theme',
      selectField(
        THEMES.map((t) => [t, t] as const),
        (t) => frontmatterValue(t, 'theme') ?? 'default',
        (t, value) => setFrontmatterValue(t, 'theme', value === 'default' ? null : value),
      ),
    );
    row(
      deckBox,
      'Slide size',
      selectField(
        [
          ['16:9', 'Widescreen 16:9'],
          ['4:3', 'Standard 4:3'],
        ],
        (t) => frontmatterValue(t, 'size') ?? '16:9',
        (t, value) => setFrontmatterValue(t, 'size', value === '16:9' ? null : value),
      ),
    );
    row(
      deckBox,
      'Page numbers',
      selectField(
        [
          ['', 'Hidden'],
          ['true', 'Shown'],
        ],
        (t) => (frontmatterValue(t, 'paginate') === 'true' ? 'true' : ''),
        (t, value) => setFrontmatterValue(t, 'paginate', value === '' ? null : value),
      ),
    );
    row(
      deckBox,
      'Header',
      textField(
        'deck-header',
        'none',
        (t) => frontmatterValue(t, 'header') ?? '',
        (t, value) => setFrontmatterValue(t, 'header', value),
      ),
    );
    row(
      deckBox,
      'Footer',
      textField(
        'deck-footer',
        'none',
        (t) => frontmatterValue(t, 'footer') ?? '',
        (t, value) => setFrontmatterValue(t, 'footer', value),
      ),
    );

    /* ---- speaker notes -------------------------------------------------- */

    let notesTimer: ReturnType<typeof setTimeout> | null = null;
    let notesVisit = 0;
    const flushNotes = () => {
      if (notesTimer === null) {
        return;
      }
      clearTimeout(notesTimer);
      notesTimer = null;
      push(
        setSlideNotes(doc.getText(), current, notesArea.value),
        `notes:${current}:${notesVisit}`,
      );
    };
    // The box grows with the notes (to a cap) rather than scrolling a few
    // lines at a time: a short box let the wheel jump past a whole line.
    const fitNotes = () => {
      notesArea.style.height = 'auto';
      notesArea.style.height = `${notesArea.scrollHeight + notesArea.offsetHeight - notesArea.clientHeight}px`;
    };
    notesArea.addEventListener('input', () => {
      fitNotes();
      if (notesTimer !== null) {
        clearTimeout(notesTimer);
      }
      notesTimer = setTimeout(flushNotes, TYPING_DEBOUNCE_MS);
    });
    notesArea.addEventListener('focus', () => notesVisit++);
    notesArea.addEventListener('blur', flushNotes);
    writers.push({ flush: flushNotes });
    syncers.push((text, external) => {
      if (notesTimer === null && settable(notesArea, external)) {
        notesArea.value = getSlideNotes(text, current);
        fitNotes();
      }
    });

    /* ---- rendering ------------------------------------------------------ */

    function docDir(): string | null {
      const path = options.getDocPath();
      const dir = path ? dirName(path) : null;
      if (dir !== resolverDir) {
        resolverDir = dir;
        resolveImage = engine.createImageResolver();
      }
      return dir;
    }

    function createThumb(): Thumb {
      const wrapper = el(dom, 'div', 'deck-edit-thumb');
      wrapper.setAttribute('role', 'option');
      const number = el(dom, 'span', 'deck-edit-thumb-num');
      const thumbFrame = el(dom, 'div', 'deck-edit-thumb-frame');
      const thumbRoot = thumbFrame.attachShadow({ mode: 'open' });
      wrapper.append(number, thumbFrame);
      return { wrapper, number, root: thumbRoot, stopBrowser: engine.applyBrowser(thumbRoot) };
    }

    function mountStage(): void {
      const slide = deck?.slides[current];
      if (!deck || !slide) {
        return;
      }
      // The block being typed into IS the stage: a remount would take the
      // caret with it. The slide catches up when the typing ends.
      if (inline) {
        return;
      }
      const force = stageDirty;
      stageDirty = false;
      if (engine.mountSlide(stageRoot, deck.css, slide.html, force)) {
        void engine.inlineImages(stageRoot, docDir(), resolveImage);
      }
      // A remount leaves the hover outline around an element that is gone;
      // an open block's outline is re-drawn around its new one.
      outline.hidden = true;
      placePop();
    }

    function applyRender(): void {
      if (!deck) {
        return;
      }
      const dir = docDir();
      root.style.setProperty('--deck-aspect', String(deck.width / deck.height));
      while (thumbs.length > deck.slides.length) {
        const thumb = thumbs.pop()!;
        thumb.stopBrowser();
        thumb.wrapper.remove();
      }
      deck.slides.forEach((slide, i) => {
        let thumb = thumbs[i];
        if (!thumb) {
          thumb = createThumb();
          thumbs.push(thumb);
          strip.insertBefore(thumb.wrapper, drop);
        }
        thumb.wrapper.dataset.slide = String(i);
        thumb.number.textContent = String(i + 1);
        // Unstamped: a thumbnail must not remount because a line moved above it.
        if (engine.mountSlide(thumb.root, deck!.css, engine.stripStamps(slide.html))) {
          void engine.inlineImages(thumb.root, dir, resolveImage);
        }
      });
      markCurrent(false);
      mountStage();
    }

    async function render(): Promise<void> {
      const token = ++renderSeq;
      let next: Awaited<ReturnType<DeckEngine['render']>>;
      try {
        next = await engine.render(doc.getText(), {
          docPath: options.getDocPath(),
          stampLines: true,
        });
      } catch (error) {
        console.error('[deck-editor] render failed', error);
        return; // keep the last good render (never break mid-edit)
      }
      if (!alive || token !== renderSeq) {
        return;
      }
      deck = next;
      applyRender();
    }

    function scheduleRender(): void {
      if (renderTimer !== null) {
        clearTimeout(renderTimer);
      }
      renderTimer = setTimeout(() => {
        renderTimer = null;
        void render();
      }, RENDER_DEBOUNCE_MS);
    }

    function markCurrent(scroll: boolean): void {
      thumbs.forEach((thumb, i) => {
        thumb.wrapper.classList.toggle('deck-edit-thumb-current', i === current);
        thumb.wrapper.setAttribute('aria-selected', String(i === current));
      });
      const wrapper = thumbs[current]?.wrapper;
      if (scroll && wrapper && typeof wrapper.scrollIntoView === 'function') {
        wrapper.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }

    function syncInspector(external: boolean): void {
      const text = doc.getText();
      for (const sync of syncers) {
        sync(text, external);
      }
      counter.textContent = `${current + 1} / ${ranges.length}`;
      moveUp.disabled = current === 0;
      moveDown.disabled = current >= ranges.length - 1;
      undoButton.disabled = undoStack.length === 0;
      redoButton.disabled = redoStack.length === 0;
    }

    refresh = (external) => {
      ranges = splitSlides(doc.getText());
      current = Math.min(Math.max(current, 0), ranges.length - 1);
      if (external) {
        closePop(false);
        undoStack.length = 0;
        redoStack.length = 0;
        lastKey = null;
      }
      syncInspector(external);
      scheduleRender();
    };

    select = (index) => {
      const next = Math.min(Math.max(index, 0), ranges.length - 1);
      if (next === current) {
        return;
      }
      flushWriters();
      closePop(true);
      current = next;
      lastKey = null;
      syncInspector(true);
      markCurrent(true);
      mountStage();
    };

    focusStrip = () => strip.focus({ preventScroll: true });

    /* ---- the block popover (click-to-edit) ------------------------------- */

    function stampedAt(event: Event): { block: HTMLElement; target: Element } | null {
      const path = event.composedPath();
      const target = path[0];
      if (!(target instanceof Element)) {
        return null;
      }
      for (const node of path) {
        if (node === frame) {
          break;
        }
        if (node instanceof HTMLElement && node.dataset.line !== undefined) {
          return { block: node, target };
        }
      }
      return null;
    }

    /** The box to draw for a block: a fence's stamp sits on `<code>`, inside the `<pre>`. */
    function boxOf(block: Element): DOMRect {
      const shown = block.tagName === 'CODE' && block.parentElement ? block.parentElement : block;
      return shown.getBoundingClientRect();
    }

    function placeOutline(block: Element | null, editing = false): void {
      outline.classList.toggle('deck-edit-outline-editing', editing);
      if (!block) {
        outline.hidden = true;
        return;
      }
      const box = boxOf(block);
      const base = stage.getBoundingClientRect();
      outline.hidden = false;
      outline.style.left = `${box.left - base.left - 3}px`;
      outline.style.top = `${box.top - base.top - 3}px`;
      outline.style.width = `${box.width + 6}px`;
      outline.style.height = `${box.height + 6}px`;
    }

    function placePop(): void {
      if (inline) {
        placeOutline(inline.block, true);
        return;
      }
      if (!pop) {
        return;
      }
      const base = stage.getBoundingClientRect();
      const block = stageRoot.querySelector(`[data-line="${pop.start}"]`);
      const box = block ? boxOf(block) : null;
      const width = Math.min(Math.max(box?.width ?? 0, 360), Math.max(base.width - 16, 200));
      pop.box.style.width = `${width}px`;
      const height = pop.box.offsetHeight;
      let top = box ? box.bottom - base.top + 8 : base.height - height - 8;
      if (box && top + height > base.height - 8) {
        const above = box.top - base.top - height - 8;
        top = above >= 8 ? above : Math.max(base.height - height - 8, 8);
      }
      const left = box ? box.left - base.left : (base.width - width) / 2;
      pop.box.style.top = `${Math.max(top, 8)}px`;
      pop.box.style.left = `${Math.min(Math.max(left, 8), Math.max(base.width - width - 8, 8))}px`;
      pop.box.classList.toggle('deck-edit-pop-editing', true);
      placeOutline(block);
    }

    function commitPop(): void {
      if (!pop) {
        return;
      }
      if (pop.timer !== null) {
        clearTimeout(pop.timer);
        pop.timer = null;
      }
      const value = pop.area.value.replace(/\s+$/, '');
      if (value.trim() === '') {
        return; // an emptied block is only removed on Done — mid-typing it stays
      }
      const next = replaceLines(doc.getText(), pop.start, pop.end, value);
      pop.end = pop.start + value.split('\n').length - 1;
      push(next, pop.key);
    }

    function closePop(commit: boolean): void {
      closeInline(commit);
      const closing = pop;
      if (!closing) {
        return;
      }
      if (commit) {
        commitPop();
        if (closing.area.value.trim() === '') {
          push(replaceLines(doc.getText(), closing.start, closing.end, ''), closing.key);
        }
      } else if (closing.timer !== null) {
        clearTimeout(closing.timer);
      }
      pop = null;
      closing.box.remove();
      outline.hidden = true;
    }

    function openPop(start: number, end: number, imageIndex: number | null, fresh = false): void {
      closePop(true);
      flushWriters();
      const text = doc.getText();
      const range = blockRange(text, start, end);
      const source = getLines(text, range.start, range.end);
      const box = el(dom, 'div', 'deck-edit-pop');
      const area = el(dom, 'textarea', 'deck-edit-pop-text');
      area.value = source;
      area.spellcheck = true;
      area.rows = Math.min(Math.max(source.split('\n').length + 1, 2), 12);
      const opened: Pop = {
        start: range.start,
        end: range.end,
        originalDoc: fresh ? (undoStack[undoStack.length - 1] ?? text) : text,
        key: `pop:${++popSerial}`,
        box,
        area,
        timer: null,
      };
      const onTyped = () => {
        if (opened.timer !== null) {
          clearTimeout(opened.timer);
        }
        opened.timer = setTimeout(commitPop, TYPING_DEBOUNCE_MS);
      };
      if (imageIndex !== null) {
        const width = el(dom, 'input', 'deck-edit-input');
        width.type = 'text';
        width.placeholder = 'auto — e.g. 300px or 50%';
        width.value = getImageWidth(source, imageIndex) ?? '';
        width.addEventListener('input', () => {
          area.value = setImageWidth(area.value, imageIndex, width.value || null);
          onTyped();
        });
        width.setAttribute('aria-label', 'Image width');
        const line = el(dom, 'div', 'deck-edit-row');
        line.append(el(dom, 'span', 'deck-edit-row-label', 'Image width'), width);
        box.appendChild(line);
      }
      area.addEventListener('input', onTyped);
      // Finishing is clicking away (or Ctrl/Cmd+Enter): no buttons to aim at.
      box.addEventListener('focusout', (event) => {
        const to = event.relatedTarget;
        if (pop === opened && dom.hasFocus() && !(to instanceof Node && box.contains(to))) {
          closePop(true);
        }
      });
      const hint = el(
        dom,
        'span',
        'deck-edit-pop-hint',
        'Markdown · click away when done · Esc reverts',
      );
      box.append(area, hint);
      stage.appendChild(box);
      pop = opened;
      placePop();
      area.focus({ preventScroll: true });
      if (fresh) {
        area.select();
      }
    }

    function revertPop(): void {
      const closing = inline ?? pop;
      if (!closing) {
        return;
      }
      closePop(false);
      push(closing.originalDoc, closing.key);
    }

    /* ---- typing into the slide itself (deck-inline.ts) -------------------- */

    /** The stamped block a press lands on, when it can be typed into in place. */
    function inlineTarget(block: HTMLElement): InlineKind | null {
      const kind = inlineKindOf(block.tagName);
      return kind && canEditInline(block, kind) ? kind : null;
    }

    /**
     * Lines moved under the stage's stale stamps (the typed block grew or
     * shrank, and the slide is not remounted until the typing ends): shift
     * every stamp below the block, and the end of every block around it.
     */
    function shiftStamps(oldEnd: number, delta: number): void {
      if (delta === 0) {
        return;
      }
      for (const node of stageRoot.querySelectorAll<HTMLElement>('[data-line]')) {
        const line = Number(node.dataset.line);
        const end = Number(node.dataset.lineEnd ?? line);
        if (line > oldEnd) {
          node.dataset.line = String(line + delta);
          node.dataset.lineEnd = String(end + delta);
        } else if (end >= oldEnd) {
          node.dataset.lineEnd = String(end + delta);
        }
      }
    }

    function lineCount(text: string): number {
      return text.split('\n').length;
    }

    function writeInline(state: Inline, body: string): void {
      const before = doc.getText();
      const next = replaceLines(before, state.start, state.end, rebuildInline(state.parts, body));
      const delta = lineCount(next) - lineCount(before);
      shiftStamps(state.end, delta);
      state.end += delta;
      state.written = body;
      push(next, state.key);
    }

    function commitInline(): void {
      const state = inline;
      if (!state) {
        return;
      }
      if (state.timer !== null) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      const body = inlineMarkdown(state.block, state.kind);
      // Untouched stays byte-identical; emptied is only removed on close.
      if (body === state.written || (body.trim() === '' && state.kind !== 'code')) {
        return;
      }
      writeInline(state, body);
    }

    function closeInline(commit: boolean): void {
      const closing = inline;
      if (!closing) {
        return;
      }
      if (commit) {
        commitInline();
        if (closing.kind !== 'code' && inlineMarkdown(closing.block, closing.kind).trim() === '') {
          writeInline(closing, '');
        }
      } else if (closing.timer !== null) {
        clearTimeout(closing.timer);
      }
      inline = null;
      closing.block.removeAttribute('contenteditable');
      outline.hidden = true;
      outline.classList.remove('deck-edit-outline-editing');
      // The typed DOM is not Marp's: let a fresh render replace it.
      stageDirty = true;
      scheduleRender();
    }

    function openInline(block: HTMLElement, kind: InlineKind): boolean {
      closePop(true); // may shift this block's stamp: read it after
      flushWriters();
      const text = doc.getText();
      const start = Number(block.dataset.line);
      const range = blockRange(text, start, Number(block.dataset.lineEnd ?? start));
      const parts = inlineSource(getLines(text, range.start, range.end), kind);
      if (!parts) {
        return false;
      }
      const opened: Inline = {
        start: range.start,
        end: range.end,
        originalDoc: text,
        key: `pop:${++popSerial}`,
        block,
        kind,
        parts,
        written: inlineMarkdown(block, kind),
        timer: null,
      };
      block.contentEditable = kind === 'code' ? 'plaintext-only' : 'true';
      block.spellcheck = kind !== 'code';
      block.addEventListener('input', () => {
        if (inline !== opened) {
          return;
        }
        if (opened.timer !== null) {
          clearTimeout(opened.timer);
        }
        opened.timer = setTimeout(commitInline, TYPING_DEBOUNCE_MS);
        placeOutline(block, true);
      });
      // Clicking anywhere else finishes; leaving the window does not.
      block.addEventListener('focusout', () => {
        if (inline === opened && dom.hasFocus()) {
          closePop(true);
        }
      });
      block.addEventListener('paste', (event) => {
        const pasted = event.clipboardData?.getData('text/plain');
        if (inline !== opened || pasted === undefined) {
          return;
        }
        event.preventDefault();
        dom.execCommand(
          'insertText',
          false,
          kind === 'heading' ? pasted.replace(/\s+/g, ' ') : pasted,
        );
      });
      inline = opened;
      placeOutline(block, true);
      return true;
    }

    function onInlineKey(event: KeyboardEvent, state: Inline): void {
      const mod = event.ctrlKey || event.metaKey;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        revertPop();
        focusStrip();
      } else if (event.key === 'Enter' && (mod || state.kind === 'heading')) {
        event.preventDefault();
        closePop(true);
        focusStrip();
      } else if (event.key === 'Enter' && !event.isComposing) {
        // A line break inside the block, never a browser <div>.
        event.preventDefault();
        dom.execCommand(state.kind === 'code' ? 'insertText' : 'insertLineBreak', false, '\n');
      }
      // Everything else is the text's own: arrows, native undo, bold.
    }

    /* ---- events ---------------------------------------------------------- */

    function onStageMove(event: PointerEvent): void {
      if (!pop && !inline) {
        placeOutline(stampedAt(event)?.block ?? null);
      }
    }

    function onStageLeave(): void {
      if (!pop && !inline) {
        outline.hidden = true;
      }
    }

    /*
     * A press on a block that can be typed into makes it editable BEFORE the
     * browser handles the press, so the caret lands where the press did.
     */
    function onStageDown(event: PointerEvent): void {
      if (event.pointerType === 'mouse' && event.button !== 0) {
        return;
      }
      const path = event.composedPath();
      if ((inline && path.includes(inline.block)) || (pop && path.includes(pop.box))) {
        return;
      }
      const hit = stampedAt(event);
      const kind = hit ? inlineTarget(hit.block) : null;
      if (hit && kind) {
        openInline(hit.block, kind);
      }
    }

    function onStageClick(event: MouseEvent): void {
      if (pop && event.composedPath().includes(pop.box)) {
        return;
      }
      // The window must never navigate, whatever was clicked inside a slide.
      event.preventDefault();
      if (inline && event.composedPath().includes(inline.block)) {
        return;
      }
      const hit = stampedAt(event);
      if (!hit) {
        closePop(true);
        return;
      }
      const start = Number(hit.block.dataset.line);
      const end = Number(hit.block.dataset.lineEnd ?? start);
      if (pop && pop.start === start) {
        return;
      }
      const images = [...hit.block.querySelectorAll('img')];
      const image = hit.target instanceof HTMLImageElement ? images.indexOf(hit.target) : -1;
      openPop(start, end, image >= 0 ? image : null);
    }

    /* Filmstrip: a press is a select, a press that travels is a reorder. */
    let drag: { from: number; x: number; y: number; active: boolean; slot: number } | null = null;

    function slotAt(x: number, y: number): number {
      const horizontal = getComputedStyle(strip).flexDirection === 'row';
      let slot = 0;
      for (const thumb of thumbs) {
        const box = thumb.wrapper.getBoundingClientRect();
        const passed = horizontal ? x > box.left + box.width / 2 : y > box.top + box.height / 2;
        if (passed) {
          slot++;
        }
      }
      return slot;
    }

    function showDrop(slot: number): void {
      const horizontal = getComputedStyle(strip).flexDirection === 'row';
      const before = thumbs[slot]?.wrapper;
      const last = thumbs[thumbs.length - 1]!.wrapper;
      drop.hidden = false;
      drop.classList.toggle('deck-edit-drop-vertical', horizontal);
      if (horizontal) {
        const at = before ? before.offsetLeft - 5 : last.offsetLeft + last.offsetWidth + 3;
        drop.style.left = `${at}px`;
        drop.style.top = `${last.offsetTop}px`;
        drop.style.height = `${last.offsetHeight}px`;
        drop.style.width = '';
      } else {
        const at = before ? before.offsetTop - 5 : last.offsetTop + last.offsetHeight + 3;
        drop.style.top = `${at}px`;
        drop.style.left = `${last.offsetLeft}px`;
        drop.style.width = `${last.offsetWidth}px`;
        drop.style.height = '';
      }
    }

    function onStripDown(event: PointerEvent): void {
      if (event.pointerType === 'mouse' && event.button !== 0) {
        return;
      }
      const wrapper = (event.target as Element).closest<HTMLElement>('.deck-edit-thumb');
      if (!wrapper) {
        return;
      }
      drag = {
        from: Number(wrapper.dataset.slide),
        x: event.clientX,
        y: event.clientY,
        active: false,
        slot: 0,
      };
    }

    function onStripMove(event: PointerEvent): void {
      if (!drag) {
        return;
      }
      if (!drag.active) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_SLOP_PX) {
          return;
        }
        // A touch that travels is a scroll of the strip, not a reorder.
        if (event.pointerType === 'touch') {
          drag = null;
          return;
        }
        drag.active = true;
        strip.setPointerCapture(event.pointerId);
        thumbs[drag.from]?.wrapper.classList.add('deck-edit-thumb-dragging');
      }
      drag.slot = slotAt(event.clientX, event.clientY);
      showDrop(drag.slot);
    }

    function onStripUp(): void {
      const ended = drag;
      drag = null;
      drop.hidden = true;
      if (!ended) {
        return;
      }
      thumbs[ended.from]?.wrapper.classList.remove('deck-edit-thumb-dragging');
      if (!ended.active) {
        select(ended.from);
        return;
      }
      const to = ended.slot > ended.from ? ended.slot - 1 : ended.slot;
      if (to !== ended.from) {
        flushWriters();
        closePop(true);
        const next = moveSlide(doc.getText(), ended.from, to);
        current = to;
        push(next);
      }
    }

    function onStripCancel(): void {
      if (drag) {
        thumbs[drag.from]?.wrapper.classList.remove('deck-edit-thumb-dragging');
      }
      drag = null;
      drop.hidden = true;
    }

    function onKeyDown(event: KeyboardEvent): void {
      const mod = event.ctrlKey || event.metaKey;
      const target = event.target;
      if (inline && event.composedPath().includes(inline.block)) {
        onInlineKey(event, inline);
        return;
      }
      if (pop && target === pop.area) {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          revertPop();
        } else if (event.key === 'Enter' && mod) {
          event.preventDefault();
          closePop(true);
        }
        return;
      }
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return; // a field keeps its own keys, native undo included
      }
      const key = event.key.toLowerCase();
      if (mod && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) {
          step(redoStack, undoStack);
        } else {
          step(undoStack, redoStack);
        }
      } else if (mod && key === 'y') {
        event.preventDefault();
        step(redoStack, undoStack);
      } else if (mod && key === 'd') {
        event.preventDefault();
        duplicate.click();
      } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowLeft')) {
        event.preventDefault();
        moveBy(-1);
      } else if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowRight')) {
        event.preventDefault();
        moveBy(1);
      } else if (mod || event.altKey) {
        return;
      } else if (['ArrowUp', 'ArrowLeft', 'PageUp'].includes(event.key)) {
        event.preventDefault();
        select(current - 1);
      } else if (['ArrowDown', 'ArrowRight', 'PageDown'].includes(event.key)) {
        event.preventDefault();
        select(current + 1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        select(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        select(ranges.length - 1);
      } else if (event.key === 'Delete' && target === strip) {
        event.preventDefault();
        remove.click();
      } else if (event.key === 'Escape' && pop) {
        event.preventDefault();
        revertPop();
      }
    }

    const resize =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            placePop();
            fitNotes(); // a narrower column wraps the notes onto more lines
          });
    resize?.observe(stage);

    strip.appendChild(drop);
    stage.addEventListener('pointermove', onStageMove);
    stage.addEventListener('pointerleave', onStageLeave);
    stage.addEventListener('pointerdown', onStageDown);
    stage.addEventListener('click', onStageClick);
    strip.addEventListener('pointerdown', onStripDown);
    strip.addEventListener('pointermove', onStripMove);
    strip.addEventListener('pointerup', onStripUp);
    strip.addEventListener('pointercancel', onStripCancel);
    root.addEventListener('keydown', onKeyDown);

    refresh(true);

    return () => {
      // The contract: nothing typed may be lost to a mode switch.
      flushWriters();
      closePop(true);
      alive = false;
      if (renderTimer !== null) {
        clearTimeout(renderTimer);
      }
      resize?.disconnect();
      stopStageBrowser();
      for (const thumb of thumbs) {
        thumb.stopBrowser();
      }
      root.removeEventListener('keydown', onKeyDown);
      root.classList.remove('deck-edit');
      root.style.removeProperty('--deck-aspect');
      root.replaceChildren();
      refresh = () => {};
      select = () => {};
      focusStrip = () => {};
    };
  }

  return {
    attach(target, doc) {
      host = target;
      model = doc;
      teardown = build(target, doc);
      unsubscribe = doc.subscribe(() => {
        if (!pushingSelf) {
          refresh(true); // someone else changed the document
        }
      });
    },
    detach() {
      teardown?.();
      teardown = null;
      unsubscribe?.();
      unsubscribe = null;
      host = null;
      model = null;
    },
    focus: () => focusStrip(),
    revealLine(line) {
      this.showLine(line);
    },
    revealHeading(index) {
      const heading = model ? extractOutline(model.getText())[index] : undefined;
      if (heading) {
        this.showLine(heading.line);
      }
    },
    getCurrentLine: () => (host ? (ranges[current]?.start ?? null) : null),
    showLine(line) {
      if (host) {
        select(slideIndexForLine(ranges, line));
      }
    },
  };
}
