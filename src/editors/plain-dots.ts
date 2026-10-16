/**
 * Keep `...` as three dots — and markdown's `**` / `__` / `~~` markers as
 * plain characters — in the raw editor.
 *
 * Coding fonts with ligatures (Fira Code, Cascadia Code, JetBrains Mono)
 * carry a `...` ligature that squeezes three periods into one narrow glyph —
 * at editor sizes it reads as a single dot, which is wrong for prose.
 *
 * They also ligate `**` (and `***`, `__`, `~~`): the first character becomes
 * an empty spacer and the second a double-width glyph drawn back over it. The
 * markdown highlighter often splits such a run across differently-styled
 * spans mid-edit (while typing `**bold*` the first `*` is plain text and the
 * second an emphasis mark), and Chromium clips each span's glyphs to that
 * span — so the run renders as ` *`, one asterisk seemingly gone, and comes
 * back once the reparse puts both in one span again.
 *
 * The "font ligatures" setting stays on for the arrows and operators it
 * exists for; this decoration just wraps every such run in a span that opts
 * out of ligatures (see `.cm-plain-dots` in base.css).
 */

import {
  Decoration,
  MatchDecorator,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
  type EditorView,
} from '@codemirror/view';

const plainDots = new MatchDecorator({
  regexp: /\.{2,}|\*{2,}|_{2,}|~{2,}/g,
  decoration: Decoration.mark({ class: 'cm-plain-dots' }),
});

export const plainDotsExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = plainDots.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.decorations = plainDots.updateDeco(update, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);
