// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from '../../term';
import { TermInput, type ClipboardAdapter, type InputView, type TermInputOptions } from '../input';
import type { Selection } from '../selection';

const CELL = { width: 8, height: 16 };

/**
 * A stub view. The real `TermView` needs a canvas 2D context, which jsdom has
 * not got; everything the input layer asks of it is geometry and callbacks, so
 * a stub tests the wiring exactly.
 */
class FakeView implements InputView {
  readonly cellMetrics = CELL;
  selection: Selection | null = null;
  focused: boolean | null = null;
  renders = 0;
  /** Where the stub pretends the canvas is, for the auto-scroll edge tests. */
  rect = { top: 0, bottom: 80 };

  readonly canvas = {
    getBoundingClientRect: () => this.rect,
  };

  constructor(private terminal: Terminal) {}

  positionAt(event: { clientX: number; clientY: number }) {
    return {
      line: this.terminal.topLine + Math.floor(event.clientY / CELL.height),
      col: Math.floor(event.clientX / CELL.width),
    };
  }

  setFocused(focused: boolean) {
    this.focused = focused;
  }

  setSelection(selection: Selection | null) {
    this.selection = selection;
  }

  requestRender() {
    this.renders++;
  }

  scrollLines(lines: number) {
    this.terminal.scrollViewport(lines);
    this.renders++;
  }

  /** Every fractional line handed to the stream path, in call order. */
  tracked: number[] = [];
  private trackRemainder = 0;

  trackScroll(lines: number) {
    this.tracked.push(lines);
    // Quantize like the real view does with smooth scrolling off, so combined
    // notch+stream sequences still land on whole lines in these tests.
    this.trackRemainder += lines;
    const whole = Math.trunc(this.trackRemainder);
    this.trackRemainder -= whole;
    if (whole !== 0) this.terminal.scrollViewport(whole);
    this.renders++;
  }

  scrollToBottom() {
    this.terminal.scrollToBottom();
    this.renders++;
  }
}

interface Harness {
  host: HTMLDivElement;
  term: Terminal;
  view: FakeView;
  input: TermInput;
  textarea: HTMLTextAreaElement;
  /** Everything written toward the pty, decoded as text. */
  written: string[];
  clipboard: { text: string } & ClipboardAdapter;
}

const decoder = new TextDecoder();

function harness(extra: Partial<TermInputOptions> = {}): Harness {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const term = new Terminal({ cols: 20, rows: 5 });
  const view = new FakeView(term);
  const written: string[] = [];
  const clipboard = {
    text: '',
    read: async () => clipboard.text,
    write: async (value: string) => {
      clipboard.text = value;
    },
  };
  const input = new TermInput(host, {
    terminal: term,
    view,
    write: (data) => written.push(typeof data === 'string' ? data : decoder.decode(data)),
    clipboard,
    ...extra,
  });
  const textarea = host.querySelector('textarea')!;
  return { host, term, view, input, textarea, written, clipboard };
}

function keydown(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function mouse(
  target: EventTarget,
  type: string,
  init: MouseEventInit & { detail?: number } = {},
): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  target.dispatchEvent(event);
  return event;
}

let h: Harness;

afterEach(() => {
  h?.input.dispose();
  document.body.innerHTML = '';
});

describe('keyboard', () => {
  beforeEach(() => {
    h = harness();
  });

  it('writes the encoded key and swallows the event', () => {
    const event = keydown(h.textarea, 'a');
    expect(h.written).toEqual(['a']);
    expect(event.defaultPrevented).toBe(true);
  });

  it("encodes with the engine's live modes", () => {
    h.term.write('\x1b[?1h'); // DECCKM
    keydown(h.textarea, 'ArrowUp');
    expect(h.written).toEqual(['\x1bOA']);
  });

  it('leaves a key it cannot encode to the browser', () => {
    const event = keydown(h.textarea, 'F24');
    expect(h.written).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('snaps back to the live screen when a key is pressed', () => {
    h.term.write('line\r\n'.repeat(20));
    h.term.scrollViewport(5);
    expect(h.term.viewportOffset).toBe(5);
    keydown(h.textarea, 'a');
    expect(h.term.viewportOffset).toBe(0);
  });

  it('gives the app keymap first refusal', () => {
    const claimed: string[] = [];
    h.input.dispose();
    h = harness({
      keymap: (event) => {
        if (!event.ctrlKey || !event.shiftKey) return false;
        claimed.push(event.key);
        return true;
      },
    });
    keydown(h.textarea, 'C', { ctrlKey: true, shiftKey: true });
    keydown(h.textarea, 'c', { ctrlKey: true });
    expect(claimed).toEqual(['C']);
    expect(h.written).toEqual(['\x03']);
  });

  it('types AltGr characters (Windows reports Ctrl+Alt) instead of escape chords', () => {
    // German AltGr+Q and AltGr+7, as WebView2 delivers them.
    keydown(h.textarea, '@', { code: 'KeyQ', ctrlKey: true, altKey: true });
    keydown(h.textarea, '{', { code: 'Digit7', ctrlKey: true, altKey: true });
    // Swiss AltGr+ü is on the US [ key: only the AltGraph state tells it apart.
    keydown(h.textarea, '[', {
      code: 'BracketLeft',
      ctrlKey: true,
      altKey: true,
      modifierAltGraph: true,
    } as KeyboardEventInit);
    // A real US Ctrl+Alt chord is still a chord.
    keydown(h.textarea, 'a', { code: 'KeyA', ctrlKey: true, altKey: true });
    expect(h.written).toEqual(['@', '{', '[', '\x1b\x01']);
  });
});

describe('IME composition', () => {
  beforeEach(() => {
    h = harness();
  });

  it('lets the IME own keys while composing, then sends the commit', () => {
    h.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    // The Enter that confirms a candidate must not reach the shell as CR.
    keydown(h.textarea, 'Enter');
    expect(h.written).toEqual([]);

    h.textarea.value = '日本語';
    h.textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    expect(h.written).toEqual(['日本語']);
    expect(h.textarea.value).toBe('');
  });

  it('flushes text that arrives without a keydown, and drains the textarea', () => {
    h.textarea.value = 'dictated';
    h.textarea.dispatchEvent(new Event('input', { bubbles: true }));
    expect(h.written).toEqual(['dictated']);
    expect(h.textarea.value).toBe('');
  });
});

describe('focus', () => {
  beforeEach(() => {
    h = harness();
  });

  it('drives the view and reports focus only when asked', () => {
    h.textarea.dispatchEvent(new FocusEvent('focus'));
    expect(h.view.focused).toBe(true);
    expect(h.written).toEqual([]);

    h.term.write('\x1b[?1004h');
    h.textarea.dispatchEvent(new FocusEvent('focus'));
    h.textarea.dispatchEvent(new FocusEvent('blur'));
    expect(h.written).toEqual(['\x1b[I', '\x1b[O']);
    expect(h.view.focused).toBe(false);
  });
});

describe('selection', () => {
  beforeEach(() => {
    h = harness();
    h.term.write('hello world\r\nsecond line');
  });

  it('drags a character selection', () => {
    mouse(h.host, 'mousedown', { clientX: 0, clientY: 0, detail: 1 });
    mouse(document, 'mousemove', { clientX: 5 * CELL.width, clientY: 0, buttons: 1 });
    mouse(document, 'mouseup', { clientX: 5 * CELL.width, clientY: 0 });
    expect(h.input.selectionText()).toBe('hello');
    expect(h.view.selection).not.toBeNull();
  });

  it('selects a word on a double click and a whole line on a triple click', () => {
    mouse(h.host, 'mousedown', { clientX: 2 * CELL.width, clientY: 0, detail: 2 });
    expect(h.input.selectionText()).toBe('hello');
    mouse(document, 'mouseup', { clientX: 2 * CELL.width, clientY: 0 });

    mouse(h.host, 'mousedown', { clientX: 2 * CELL.width, clientY: 0, detail: 3 });
    expect(h.input.selectionText()).toBe('hello world');
  });

  it('extends a word drag by whole words, in either direction', () => {
    // Double-click "world", drag back over "hello": both words stay selected.
    mouse(h.host, 'mousedown', { clientX: 7 * CELL.width, clientY: 0, detail: 2 });
    mouse(document, 'mousemove', { clientX: 1 * CELL.width, clientY: 0, buttons: 1 });
    expect(h.input.selectionText()).toBe('hello world');
  });

  it('extends with Shift+click and clears on a plain click', () => {
    mouse(h.host, 'mousedown', { clientX: 0, clientY: 0, detail: 1 });
    mouse(document, 'mouseup', { clientX: 0, clientY: 0 });
    expect(h.view.selection).toBeNull();

    mouse(h.host, 'mousedown', { clientX: 0, clientY: 0, detail: 1 });
    mouse(document, 'mouseup', { clientX: 0, clientY: 0 });
    mouse(h.host, 'mousedown', { clientX: 0, clientY: 0, detail: 1 });
    mouse(h.host, 'mousedown', { clientX: 5 * CELL.width, clientY: 0, shiftKey: true, detail: 1 });
    expect(h.input.selectionText()).toBe('hello');
  });

  it('joins a soft-wrapped line into one line of text', () => {
    h.input.dispose();
    h = harness();
    // 20 columns: this wraps without a newline ever being typed.
    h.term.write('echo aaaaaaaaaaaaaaaaaaaaaaaaa');
    mouse(h.host, 'mousedown', { clientX: 0, clientY: 0, detail: 3 });
    expect(h.input.selectionText()).toBe('echo aaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('copies on selection when the setting is on', async () => {
    h.input.dispose();
    h = harness({ copyOnSelect: true });
    h.term.write('hello world');
    mouse(h.host, 'mousedown', { clientX: 0, clientY: 0, detail: 1 });
    mouse(document, 'mousemove', { clientX: 5 * CELL.width, clientY: 0, buttons: 1 });
    mouse(document, 'mouseup', { clientX: 5 * CELL.width, clientY: 0 });
    await vi.waitFor(() => expect(h.clipboard.text).toBe('hello'));
  });

  it('selects the whole buffer, scrollback included', () => {
    h.input.dispose();
    h = harness();
    h.term.write('one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\nseven');
    h.input.selectAll();
    expect(h.input.selectionText().split('\n')).toEqual([
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven',
    ]);
  });

  it('scrolls when a drag leaves the top edge', () => {
    h.input.dispose();
    h = harness();
    h.term.write('line\r\n'.repeat(30));
    mouse(h.host, 'mousedown', { clientX: 0, clientY: 40, detail: 1 });
    mouse(document, 'mousemove', { clientX: 0, clientY: -10, buttons: 1 });
    expect(h.term.viewportOffset).toBe(1);
  });
});

describe('clipboard', () => {
  beforeEach(() => {
    h = harness();
    h.term.write('hello world');
  });

  it('knows whether there is a selection, which is what gates Ctrl+C', () => {
    expect(h.input.hasSelection).toBe(false);
    // A click is not a selection: an empty one must not eat the shell's SIGINT.
    mouse(h.host, 'mousedown', { clientX: 0, clientY: 0, detail: 1 });
    mouse(document, 'mouseup', { clientX: 0, clientY: 0 });
    expect(h.input.hasSelection).toBe(false);
    mouse(h.host, 'mousedown', { clientX: 0, clientY: 0, detail: 2 });
    expect(h.input.hasSelection).toBe(true);
    h.input.clearSelection();
    expect(h.input.hasSelection).toBe(false);
  });

  it('copies the selection and reports when there is nothing to copy', async () => {
    expect(await h.input.copySelection()).toBe(false);
    mouse(h.host, 'mousedown', { clientX: 0, clientY: 0, detail: 2 });
    expect(await h.input.copySelection()).toBe(true);
    expect(h.clipboard.text).toBe('hello');
  });

  it('pastes bracketed when the application asked for it', async () => {
    h.clipboard.text = 'one\ntwo';
    await h.input.pasteFromClipboard();
    expect(h.written.join('')).toBe('one\rtwo');

    h.written.length = 0;
    h.term.write('\x1b[?2004h');
    await h.input.pasteFromClipboard();
    expect(h.written.join('')).toBe('\x1b[200~one\rtwo\x1b[201~');
  });

  it('asks before a multi-line paste and honors a refusal', async () => {
    const asked: string[] = [];
    h.input.dispose();
    h = harness({
      confirmPaste: (text) => {
        asked.push(text);
        return false;
      },
    });
    await h.input.paste('one\ntwo');
    expect(asked).toEqual(['one\rtwo']);
    expect(h.written).toEqual([]);

    await h.input.paste('single line');
    expect(asked).toHaveLength(1);
    expect(h.written).toEqual(['single line']);
  });

  it('takes a native paste event instead of letting it reach the textarea', () => {
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: () => 'pasted' },
    });
    h.textarea.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(h.written).toEqual(['pasted']);
  });
});

describe('mouse reporting', () => {
  beforeEach(() => {
    h = harness();
  });

  it('reports clicks and releases in SGR form once an app asks', () => {
    h.term.write('\x1b[?1000h\x1b[?1006h');
    mouse(h.host, 'mousedown', { clientX: 3 * CELL.width, clientY: 2 * CELL.height });
    mouse(document, 'mouseup', { clientX: 3 * CELL.width, clientY: 2 * CELL.height });
    expect(h.written).toEqual(['\x1b[<0;4;3M', '\x1b[<0;4;3m']);
    expect(h.view.selection).toBeNull();
  });

  it('reports drags only in button-event tracking', () => {
    h.term.write('\x1b[?1002h\x1b[?1006h');
    mouse(h.host, 'mousedown', { clientX: 0, clientY: 0 });
    mouse(document, 'mousemove', { clientX: CELL.width, clientY: 0, buttons: 1 });
    mouse(document, 'mousemove', { clientX: 2 * CELL.width, clientY: 0, buttons: 0 });
    expect(h.written).toEqual(['\x1b[<0;1;1M', '\x1b[<32;2;1M']);
  });

  it('gives selection back to the user while Shift is held', () => {
    h.term.write('hello\x1b[?1000h\x1b[?1006h');
    mouse(h.host, 'mousedown', { clientX: 0, clientY: 0, shiftKey: true, detail: 1 });
    mouse(document, 'mousemove', { clientX: 5 * CELL.width, clientY: 0, buttons: 1 });
    expect(h.written).toEqual([]);
    expect(h.view.selection).not.toBeNull();
  });
});

describe('wheel', () => {
  beforeEach(() => {
    h = harness();
    h.term.write('line\r\n'.repeat(30));
  });

  function wheel(init: WheelEventInit): WheelEvent {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
    h.host.dispatchEvent(event);
    return event;
  }

  it('scrolls the viewport and never the document', () => {
    const event = wheel({ deltaY: -3 * CELL.height, deltaMode: 0 });
    expect(h.term.viewportOffset).toBe(3);
    expect(event.defaultPrevented).toBe(true);
    wheel({ deltaY: 3 * CELL.height, deltaMode: 0 });
    expect(h.term.viewportOffset).toBe(0);
  });

  it('accumulates sub-line touchpad deltas instead of dropping them', () => {
    for (let i = 0; i < 4; i++) wheel({ deltaY: -CELL.height / 2, deltaMode: 0 });
    expect(h.term.viewportOffset).toBe(2);
  });

  it('scrolls by whole notches for line-wise wheels', () => {
    wheel({ deltaY: -1, deltaMode: 1 });
    expect(h.term.viewportOffset).toBe(3);
  });

  it('routes a fractional touchpad stream to the view unquantized', () => {
    // A fractional pixel delta marks a touchpad; from then on the stream goes
    // to trackScroll as fractional lines rather than accumulating to notches.
    wheel({ deltaY: -CELL.height / 4 - 0.5, deltaMode: 0 }); // -4.5px → 0.28125 lines
    wheel({ deltaY: -CELL.height / 2, deltaMode: 0 });
    expect(h.view.tracked).toEqual([4.5 / CELL.height, 0.5]);
  });

  it('keeps the alternate screen on whole-line arrows even for a stream', () => {
    wheel({ deltaY: -0.5, deltaMode: 0 }); // latch the stream
    h.term.write('\x1b[?1049h');
    h.written.length = 0;
    for (let i = 0; i < 4; i++) wheel({ deltaY: -CELL.height / 2, deltaMode: 0 });
    expect(h.written.join('')).toBe('\x1b[A\x1b[A');
  });

  it('reports the wheel when an application asked for the mouse', () => {
    h.term.write('\x1b[?1000h\x1b[?1006h');
    wheel({ deltaY: -CELL.height, deltaMode: 0 });
    wheel({ deltaY: CELL.height, deltaMode: 0 });
    expect(h.written).toEqual(['\x1b[<64;1;1M', '\x1b[<65;1;1M']);
    expect(h.term.viewportOffset).toBe(0);
  });

  it('sends arrow keys on the alternate screen, which has no scrollback', () => {
    h.term.write('\x1b[?1049h');
    // A notch-sized pixel delta (≥ NOTCH_MIN_PX) is one ratchet notch, which
    // scrolls scrollLines (3) lines regardless of the platform's pixel step.
    wheel({ deltaY: -2 * CELL.height, deltaMode: 0 });
    expect(h.written).toEqual(['\x1b[A\x1b[A\x1b[A']);
    h.written.length = 0;
    h.term.write('\x1b[?1h');
    wheel({ deltaY: CELL.height, deltaMode: 0 });
    expect(h.written).toEqual(['\x1bOB']);
  });
});

describe('dispose', () => {
  it('detaches every listener and removes the textarea', () => {
    h = harness();
    const { host, textarea } = h;
    h.input.dispose();
    keydown(textarea, 'a');
    mouse(host, 'mousedown', { clientX: 0, clientY: 0, detail: 1 });
    expect(h.written).toEqual([]);
    expect(host.querySelector('textarea')).toBeNull();
  });
});

describe('the context menu', () => {
  beforeEach(() => {
    h = harness();
  });

  it('suppresses the web view menu and reports the right-click', () => {
    const seen: MouseEvent[] = [];
    h.input.dispose();
    h = harness({ onContextMenu: (event) => seen.push(event) });
    const event = mouse(h.host, 'contextmenu', { button: 2, clientX: 30, clientY: 12 });
    expect(event.defaultPrevented).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.clientX).toBe(30);
  });

  it('leaves the right button to an application that tracks the mouse', () => {
    const seen: MouseEvent[] = [];
    h.input.dispose();
    h = harness({ onContextMenu: (event) => seen.push(event) });
    h.term.write('\x1b[?1000h');
    const event = mouse(h.host, 'contextmenu', { button: 2 });
    expect(event.defaultPrevented).toBe(true);
    expect(seen).toHaveLength(0);
    // Shift is the escape hatch everywhere else in this file, and here too.
    mouse(h.host, 'contextmenu', { button: 2, shiftKey: true });
    expect(seen).toHaveLength(1);
  });

  it('keeps the selection, so right-clicking one and choosing Copy works', () => {
    h.term.write('hello world');
    mouse(h.host, 'mousedown', { clientX: 0, clientY: 0, detail: 2 });
    expect(h.input.selectionText()).toBe('hello');
    mouse(h.host, 'mousedown', { button: 2, clientX: 0, clientY: 0 });
    mouse(h.host, 'contextmenu', { button: 2, clientX: 0, clientY: 0 });
    expect(h.input.selectionText()).toBe('hello');
  });
});
