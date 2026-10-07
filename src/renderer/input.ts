/**
 * `TermInput` — everything the user does with a keyboard, mouse or clipboard,
 * turned into pty bytes or local terminal state.
 *
 *   const input = new TermInput(paneElement, { terminal, view, write });
 *   input.focus();
 *
 * It owns a hidden textarea, because that is the only way a web view will run
 * IME composition (a plain div receives no composition events), and it doubles
 * as the target for native paste. Everything else — encoding, mouse reports,
 * paste hygiene — lives in the pure modules next door; this file is the glue
 * that turns DOM events into calls on them.
 *
 * Framework-free, like the rest of `src/renderer`: React only creates it.
 */

import { NotchUnitTracker, WheelSourceTracker, type WheelKind } from '../core/smooth-scroll';
import type { Terminal } from '../term';
import { encodeKey, keyStateFromModes, type KeyEncodeState } from './keys';
import { encodeFocus, encodeMouse, wantsMouse, type MouseInput, type MouseState } from './mouse';
import { isMultiline, preparePaste } from './paste';
import {
  expandToWord,
  isEmpty as isSelectionEmpty,
  selectionText,
  type LineSource,
  type Point,
  type Range,
  type Selection,
} from './selection';

/** The clipboard seam — the DOM one by default, a fake in tests. */
export interface ClipboardAdapter {
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

/**
 * The slice of `TermView` the input layer uses. A real view satisfies it; a
 * test can supply a stub, which is what keeps this file testable without a
 * canvas 2D context (jsdom has none).
 */
export interface InputView {
  readonly canvas: { getBoundingClientRect(): { top: number; bottom: number } };
  readonly cellMetrics: { width: number; height: number };
  positionAt(event: { clientX: number; clientY: number }): { line: number; col: number };
  setFocused(focused: boolean): void;
  setSelection(selection: Selection | null): void;
  requestRender(): void;
  /** Move the viewport by whole lines; the view decides whether it eases. */
  scrollLines(lines: number): void;
  /** Follow a touchpad stream by fractional lines, 1:1 (see `TermView`). */
  trackScroll(lines: number): void;
  /** Back to the live screen at once (a keystroke, a paste). */
  scrollToBottom(): void;
}

export interface TermInputOptions {
  terminal: Terminal;
  view: InputView;
  /** Where encoded bytes go — the pty. */
  write: (data: Uint8Array | string) => void;
  /**
   * App shortcuts get first refusal on every key; returning true means handled
   * (`src/ui/keymap.ts` resolves the action). Anything it declines is encoded
   * for the terminal.
   */
  keymap?: (event: KeyboardEvent) => boolean;
  clipboard?: ClipboardAdapter;
  /** Copy as soon as a drag ends (the X11 habit). */
  copyOnSelect?: boolean;
  altSendsEscape?: boolean;
  backspaceSendsDelete?: boolean;
  /** Lines per wheel notch for line-wise wheel events. */
  scrollLines?: number;
  /** Asked before a multi-line paste; false cancels it. */
  confirmPaste?: (text: string) => boolean | Promise<boolean>;
  onSelectionChange?: (selection: Selection | null) => void;
  /**
   * A right-click the application did not ask for. The host opens its own menu;
   * the web view's is always suppressed, because it offers a Paste that pastes
   * into the hidden textarea and a Copy that copies nothing.
   */
  onContextMenu?: (event: MouseEvent) => void;
}

type DragMode = 'none' | 'char' | 'word' | 'line';

const DEFAULT_SCROLL_LINES = 3;

export const domClipboard: ClipboardAdapter = {
  async read() {
    return (await navigator.clipboard?.readText()) ?? '';
  },
  async write(text) {
    await navigator.clipboard?.writeText(text);
  },
};

export class TermInput {
  private readonly textarea: HTMLTextAreaElement;
  private options: TermInputOptions;
  private terminal: Terminal;
  private view: InputView;

  private composing = false;
  private selection: Selection | null = null;
  private drag: DragMode = 'none';
  /** True between a reported press and its release (an application's drag). */
  private appDragging = false;
  /** The word/line range the drag started from, so extension can flip sides. */
  private dragOrigin: Range | null = null;
  private wheelRemainder = 0;
  private wheelTracker = new WheelSourceTracker();
  private notchUnits = new NotchUnitTracker();
  private disposed = false;

  constructor(
    private host: HTMLElement,
    options: TermInputOptions,
  ) {
    this.options = options;
    this.terminal = options.terminal;
    this.view = options.view;

    const doc = host.ownerDocument;
    this.textarea = doc.createElement('textarea');
    this.textarea.className = 'term-input';
    this.textarea.setAttribute('autocapitalize', 'off');
    this.textarea.setAttribute('autocorrect', 'off');
    this.textarea.setAttribute('autocomplete', 'off');
    this.textarea.setAttribute('spellcheck', 'false');
    this.textarea.setAttribute('aria-label', 'Terminal input');
    host.appendChild(this.textarea);

    this.textarea.addEventListener('keydown', this.onKeyDown);
    this.textarea.addEventListener('input', this.onInput);
    this.textarea.addEventListener('compositionstart', this.onCompositionStart);
    this.textarea.addEventListener('compositionend', this.onCompositionEnd);
    this.textarea.addEventListener('paste', this.onPaste);
    this.textarea.addEventListener('copy', this.onCopy);
    this.textarea.addEventListener('focus', this.onFocus);
    this.textarea.addEventListener('blur', this.onBlur);
    host.addEventListener('mousedown', this.onMouseDown);
    host.addEventListener('mousemove', this.onHostMouseMove);
    host.addEventListener('wheel', this.onWheel, { passive: false });
    host.addEventListener('contextmenu', this.onContextMenu);
  }

  /** Apply changed settings (Phase 5 wires this to the settings store). */
  configure(changes: Partial<Omit<TermInputOptions, 'terminal' | 'view' | 'write'>>): void {
    this.options = { ...this.options, ...changes };
  }

  focus(): void {
    this.textarea.focus({ preventScroll: true });
  }

  get focused(): boolean {
    return this.textarea.ownerDocument.activeElement === this.textarea;
  }

  // ---------------------------------------------------------------- keyboard

  private keyState(): KeyEncodeState {
    const options: Pick<KeyEncodeState, 'altSendsEscape' | 'backspaceSendsDelete'> = {};
    if (this.options.altSendsEscape !== undefined) {
      options.altSendsEscape = this.options.altSendsEscape;
    }
    if (this.options.backspaceSendsDelete !== undefined) {
      options.backspaceSendsDelete = this.options.backspaceSendsDelete;
    }
    return keyStateFromModes(this.terminal.modes(), options);
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    // While an IME is composing, the keys belong to the IME, not the shell.
    if (event.isComposing || this.composing) return;

    if (this.options.keymap?.(event)) {
      event.preventDefault();
      return;
    }

    const encoded = encodeKey(
      {
        key: event.key,
        code: event.code,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        meta: event.metaKey,
        altGraph: event.getModifierState?.('AltGraph') ?? false,
      },
      this.keyState(),
    );
    if (encoded === null) return;
    event.preventDefault();
    this.send(encoded);
  };

  /**
   * Text that arrived without a keydown we could encode: an IME commit, a
   * dictation result, a soft keyboard. The textarea is drained on every one so
   * nothing accumulates in it.
   */
  private onInput = (event: Event): void => {
    if ((event as InputEvent).isComposing || this.composing) return;
    const text = this.textarea.value;
    this.textarea.value = '';
    if (text === '') return;
    this.send(text);
  };

  private onCompositionStart = (): void => {
    this.composing = true;
    this.positionTextarea();
  };

  private onCompositionEnd = (): void => {
    this.composing = false;
    // Chrome delivers the committed string in the input event that follows;
    // WebKit sometimes does not, so flush whatever is in the textarea.
    const text = this.textarea.value;
    this.textarea.value = '';
    if (text !== '') this.send(text);
  };

  /**
   * Park the (invisible) textarea over the cursor cell so the IME candidate
   * window appears where the user is typing rather than in a corner.
   */
  private positionTextarea(): void {
    const { width, height } = this.view.cellMetrics;
    const cursor = this.terminal.cursor;
    this.textarea.style.left = `${Math.round(cursor.x * width)}px`;
    this.textarea.style.top = `${Math.round(cursor.y * height)}px`;
  }

  /** Bytes for the application: a keypress always returns to the live screen. */
  private send(data: string | Uint8Array): void {
    if (this.terminal.viewportOffset > 0) {
      this.view.scrollToBottom();
    }
    this.options.write(data);
  }

  // --------------------------------------------------------------- focus

  private onFocus = (): void => {
    this.view.setFocused(true);
    if (this.terminal.modes().focusReporting) this.options.write(encodeFocus(true));
  };

  private onBlur = (): void => {
    this.view.setFocused(false);
    // A drag that ends outside the window must not stay armed.
    this.endDrag();
    if (this.terminal.modes().focusReporting) this.options.write(encodeFocus(false));
  };

  // ----------------------------------------------------------------- clipboard

  private get clipboard(): ClipboardAdapter {
    return this.options.clipboard ?? domClipboard;
  }

  private lineSource(): LineSource {
    const terminal = this.terminal;
    return {
      lineChars: (line) => terminal.bufferRow(line)?.columnChars() ?? null,
      // `Row.wrapped` marks a row as the *continuation* of the one above it.
      isWrapped: (line) => terminal.bufferRow(line + 1)?.wrapped ?? false,
      cols: terminal.cols,
    };
  }

  /** The selected text, or '' when there is no selection. */
  selectionText(): string {
    if (!this.selection || isSelectionEmpty(this.selection)) return '';
    return selectionText(this.selection, this.lineSource());
  }

  /** True when something is selected — what decides whether Ctrl+C copies. */
  get hasSelection(): boolean {
    return this.selection !== null && !isSelectionEmpty(this.selection);
  }

  /** Copy the selection; false when there was nothing to copy or it failed. */
  async copySelection(): Promise<boolean> {
    const text = this.selectionText();
    if (text === '') return false;
    try {
      await this.clipboard.write(text);
      return true;
    } catch {
      return false;
    }
  }

  /** Read the clipboard and paste it. */
  async pasteFromClipboard(): Promise<void> {
    try {
      await this.paste(await this.clipboard.read());
    } catch {
      // A denied clipboard read is the user's decision, not an error to raise.
    }
  }

  /** Paste `text`: sanitized, confirmed if multi-line, bracketed and chunked. */
  async paste(text: string): Promise<void> {
    if (text === '') return;
    const { chunks, text: clean } = preparePaste(text, this.terminal.modes().bracketedPaste);
    if (chunks.length === 0) return;
    if (isMultiline(clean) && this.options.confirmPaste) {
      if (!(await this.options.confirmPaste(clean))) return;
      if (this.disposed) return;
    }
    if (this.terminal.viewportOffset > 0) {
      this.view.scrollToBottom();
    }
    for (const chunk of chunks) this.options.write(chunk);
  }

  private onPaste = (event: ClipboardEvent): void => {
    event.preventDefault();
    void this.paste(event.clipboardData?.getData('text/plain') ?? '');
  };

  /** Ctrl+C is SIGINT, so this only fires for menu/Ctrl+Insert style copies. */
  private onCopy = (event: ClipboardEvent): void => {
    const text = this.selectionText();
    if (text === '') return;
    event.preventDefault();
    event.clipboardData?.setData('text/plain', text);
  };

  // ----------------------------------------------------------------- selection

  get currentSelection(): Selection | null {
    return this.selection;
  }

  clearSelection(): void {
    this.setSelection(null);
  }

  /** Select everything retained: the whole scrollback plus the live screen. */
  selectAll(): void {
    const historyBase = this.terminal.topLine + this.terminal.viewportOffset;
    const first = historyBase - this.terminal.scrollbackLength;
    const last = historyBase + this.terminal.rows - 1;
    this.setSelection({
      anchor: { line: first, col: 0 },
      head: { line: last, col: this.terminal.cols },
    });
  }

  private setSelection(selection: Selection | null): void {
    this.selection = selection;
    this.view.setSelection(selection);
    this.options.onSelectionChange?.(selection);
  }

  // --------------------------------------------------------------- mouse

  private mouseState(): MouseState {
    const modes = this.terminal.modes();
    return { tracking: modes.mouseTracking, encoding: modes.mouseEncoding };
  }

  /** Viewport cell under the pointer (mouse reports are viewport-relative). */
  private cellAt(event: MouseEvent): { col: number; row: number } {
    const { line, col } = this.view.positionAt(event);
    return { col, row: line - this.terminal.topLine };
  }

  private report(event: MouseEvent, input: Omit<MouseInput, 'col' | 'row'>): boolean {
    const cell = this.cellAt(event);
    const bytes = encodeMouse(
      {
        ...input,
        ...cell,
        shift: event.shiftKey,
        alt: event.altKey || event.metaKey,
        ctrl: event.ctrlKey,
      },
      this.mouseState(),
    );
    if (!bytes) return false;
    this.options.write(bytes);
    return true;
  }

  /**
   * Shift is the universal escape hatch: while an application is grabbing the
   * mouse, holding Shift gives the selection back to the user.
   */
  private appWantsMouse(event: MouseEvent, kind: MouseInput['kind']): boolean {
    if (event.shiftKey) return false;
    return wantsMouse(this.mouseState(), { kind, buttons: event.buttons });
  }

  private onMouseDown = (event: MouseEvent): void => {
    this.focus();

    if (this.appWantsMouse(event, 'press')) {
      event.preventDefault();
      this.report(event, { kind: 'press', button: event.button });
      this.beginAppDrag();
      return;
    }

    // Right-click is left alone (a context menu is Phase 8 polish); middle
    // click would be a primary-selection paste, which the web view cannot read.
    if (event.button !== 0) return;

    event.preventDefault();
    const point = this.view.positionAt(event);

    // Shift+click extends the existing selection instead of starting a new one.
    if (event.shiftKey && this.selection) {
      this.drag = 'char';
      this.dragOrigin = null;
      this.setSelection({ anchor: this.selection.anchor, head: point });
      this.listenForDrag();
      return;
    }

    const clicks = event.detail;
    if (clicks >= 3) {
      this.drag = 'line';
      const range = this.logicalLineRange(point.line);
      this.dragOrigin = range;
      this.setSelection({ anchor: range.start, head: range.end });
    } else if (clicks === 2) {
      this.drag = 'word';
      const range = this.wordRange(point);
      this.dragOrigin = range;
      this.setSelection({ anchor: range.start, head: range.end });
    } else {
      this.drag = 'char';
      this.dragOrigin = null;
      this.setSelection({ anchor: point, head: point });
    }
    this.listenForDrag();
  };

  /**
   * Motion while an application holds the mouse (1002/1003 tracking). A move
   * over the pane also bubbles to the document listener a drag installs, so
   * both drag paths bow out here to avoid reporting the same move twice.
   */
  private onHostMouseMove = (event: MouseEvent): void => {
    if (this.drag !== 'none' || this.appDragging) return;
    if (!this.appWantsMouse(event, 'move')) return;
    this.report(event, { kind: 'move', button: 0, buttons: event.buttons });
  };

  /**
   * Selection drags and application drags both continue outside the pane, so
   * the moves are tracked on the document until the button comes back up.
   */
  private listenForDrag(): void {
    const doc = this.host.ownerDocument;
    doc.addEventListener('mousemove', this.onDocumentMouseMove);
    doc.addEventListener('mouseup', this.onDocumentMouseUp);
  }

  private beginAppDrag(): void {
    this.drag = 'none';
    this.appDragging = true;
    const doc = this.host.ownerDocument;
    doc.addEventListener('mousemove', this.onAppMouseMove);
    doc.addEventListener('mouseup', this.onAppMouseUp);
  }

  private onAppMouseMove = (event: MouseEvent): void => {
    if (!wantsMouse(this.mouseState(), { kind: 'move', buttons: event.buttons })) return;
    this.report(event, { kind: 'move', button: 0, buttons: event.buttons });
  };

  private onAppMouseUp = (event: MouseEvent): void => {
    this.appDragging = false;
    const doc = this.host.ownerDocument;
    doc.removeEventListener('mousemove', this.onAppMouseMove);
    doc.removeEventListener('mouseup', this.onAppMouseUp);
    this.report(event, { kind: 'release', button: event.button });
  };

  private onDocumentMouseMove = (event: MouseEvent): void => {
    if (this.drag === 'none' || !this.selection) return;
    event.preventDefault();
    this.autoScroll(event);
    const point = this.view.positionAt(event);

    if (this.drag === 'char') {
      this.setSelection({ anchor: this.selection.anchor, head: point });
      return;
    }

    // Word/line drags snap both ends to whole words or lines, and flip which
    // end is the anchor once the pointer passes the origin.
    const origin = this.dragOrigin;
    if (!origin) return;
    const range = this.drag === 'word' ? this.wordRange(point) : this.logicalLineRange(point.line);
    const beforeOrigin =
      range.start.line < origin.start.line ||
      (range.start.line === origin.start.line && range.start.col < origin.start.col);
    this.setSelection(
      beforeOrigin
        ? { anchor: origin.end, head: range.start }
        : { anchor: origin.start, head: range.end },
    );
  };

  private onDocumentMouseUp = (event: MouseEvent): void => {
    this.endDrag();
    if (event.button !== 0) return;
    if (this.selection && isSelectionEmpty(this.selection)) {
      // A plain click is a click, not an empty selection.
      this.setSelection(null);
      return;
    }
    if (this.options.copyOnSelect) void this.copySelection();
  };

  private endDrag(): void {
    if (this.drag === 'none') return;
    this.drag = 'none';
    this.dragOrigin = null;
    const doc = this.host.ownerDocument;
    doc.removeEventListener('mousemove', this.onDocumentMouseMove);
    doc.removeEventListener('mouseup', this.onDocumentMouseUp);
  }

  /**
   * Dragging past the top or bottom edge scrolls the viewport — one line per
   * event, and deliberately NOT eased: the pointer is picking cells, and a
   * grid gliding under it would select rows the user is not pointing at.
   */
  private autoScroll(event: MouseEvent): void {
    const rect = this.view.canvas.getBoundingClientRect();
    if (event.clientY < rect.top) this.terminal.scrollViewport(1);
    else if (event.clientY > rect.bottom) this.terminal.scrollViewport(-1);
    else return;
    this.view.requestRender();
  }

  private wordRange(point: Point): Range {
    const chars = this.terminal.bufferRow(point.line)?.columnChars() ?? [];
    const { start, end } = expandToWord(chars, point.col);
    return { start: { line: point.line, col: start }, end: { line: point.line, col: end } };
  }

  /**
   * A triple click selects the *logical* line: a command that soft-wrapped over
   * three rows is one line, and selecting it must paste back as one command.
   */
  private logicalLineRange(line: number): Range {
    let first = line;
    while (this.terminal.bufferRow(first)?.wrapped) first--;
    let last = line;
    while (this.terminal.bufferRow(last + 1)?.wrapped) last++;
    return { start: { line: first, col: 0 }, end: { line: last, col: this.terminal.cols } };
  }

  private onContextMenu = (event: MouseEvent): void => {
    // The web view's own menu never appears: an application asking for mouse
    // reporting needs the right button, and everywhere else the host's menu is
    // the one that knows what "copy" means in a terminal.
    event.preventDefault();
    if (this.mouseState().tracking !== 'none' && !event.shiftKey) return;
    this.options.onContextMenu?.(event);
  };

  // ------------------------------------------------------------------- wheel

  private onWheel = (event: WheelEvent): void => {
    // Swallow the event whatever happens: the pane must never scroll like a
    // document.
    event.preventDefault();
    const kind = this.wheelTracker.classify(event.deltaY, event.deltaMode, event.timeStamp);
    const raw = this.rawWheelLines(event, kind);
    if (raw === 0) return;

    if (this.appWantsMouse(event, 'wheel')) {
      const lines = this.quantizeWheel(raw);
      const button = lines > 0 ? 0 : 1; // WHEEL_UP / WHEEL_DOWN
      for (let i = 0; i < Math.abs(lines); i++) {
        this.report(event, { kind: 'wheel', button });
      }
      return;
    }

    const modes = this.terminal.modes();
    if (modes.altScreen) {
      // No scrollback on the alternate screen: full-screen apps that did not
      // ask for mouse reporting still expect the wheel to move their cursor.
      const lines = this.quantizeWheel(raw);
      if (lines === 0) return;
      const arrow = modes.applicationCursorKeys ? '\x1bO' : '\x1b[';
      const key = lines > 0 ? 'A' : 'B';
      this.options.write((arrow + key).repeat(Math.abs(lines)));
      return;
    }

    if (kind === 'stream') {
      // A touchpad stream tracks 1:1 at fractional lines — the view keeps the
      // sub-line part, so the whole-line remainder here must not double-count.
      this.wheelRemainder = 0;
      this.view.trackScroll(raw);
      return;
    }
    const lines = this.quantizeWheel(raw);
    if (lines !== 0) this.view.scrollLines(lines);
  };

  /**
   * A wheel delta in lines, fractional. Positive is up (back into history),
   * matching `scrollViewport`.
   */
  private rawWheelLines(event: WheelEvent, kind: WheelKind): number {
    const perNotch = this.options.scrollLines ?? DEFAULT_SCROLL_LINES;
    if (event.deltaMode === 1) return -event.deltaY * perNotch;
    if (event.deltaMode === 2) return -event.deltaY * this.terminal.rows;
    if (kind === 'notch') {
      // A ratcheted wheel scrolls perNotch lines per notch on every platform —
      // NOT its pixel delta divided by the cell height, which turns the same
      // notch into ~1.3 lines on WebKitGTK and ~3+ on WebView2 (the webviews
      // disagree on pixels per notch; NotchUnitTracker learns the step).
      const notches = this.notchUnits.notches(event.deltaY);
      if (notches !== 0) return -notches * perNotch;
    }
    const cell = this.view.cellMetrics.height || 16;
    return -event.deltaY / cell;
  }

  /**
   * Fractional lines into whole ones, keeping the remainder so a stream of
   * small deltas still adds up instead of being lost — for the consumers that
   * can only take whole lines (mouse reporting, alternate-screen arrows, a
   * ratcheted wheel's glide).
   */
  private quantizeWheel(lines: number): number {
    this.wheelRemainder += lines;
    const whole = Math.trunc(this.wheelRemainder);
    this.wheelRemainder -= whole;
    return whole;
  }

  // ---------------------------------------------------------------- teardown

  dispose(): void {
    this.disposed = true;
    this.endDrag();
    this.appDragging = false;
    const doc = this.host.ownerDocument;
    doc.removeEventListener('mousemove', this.onAppMouseMove);
    doc.removeEventListener('mouseup', this.onAppMouseUp);
    this.textarea.removeEventListener('keydown', this.onKeyDown);
    this.textarea.removeEventListener('input', this.onInput);
    this.textarea.removeEventListener('compositionstart', this.onCompositionStart);
    this.textarea.removeEventListener('compositionend', this.onCompositionEnd);
    this.textarea.removeEventListener('paste', this.onPaste);
    this.textarea.removeEventListener('copy', this.onCopy);
    this.textarea.removeEventListener('focus', this.onFocus);
    this.textarea.removeEventListener('blur', this.onBlur);
    this.host.removeEventListener('mousedown', this.onMouseDown);
    this.host.removeEventListener('mousemove', this.onHostMouseMove);
    this.host.removeEventListener('wheel', this.onWheel);
    this.host.removeEventListener('contextmenu', this.onContextMenu);
    this.textarea.remove();
  }
}
