/**
 * Light up `@path` imports in agent instruction files (CLAUDE.md, GEMINI.md,
 * AGENTS.md) in the raw editor.
 *
 * A `MatchDecorator` walks the visible text with `AGENT_IMPORT_RE`
 * (core/agent-files.ts) and wraps each token in `.cm-agent-import`
 * (base.css; themes recolor it through `--md-mention`). Tokens inside code —
 * a fenced block, an indented code block or inline backticks — are skipped,
 * since there `@x` is code, not an import; the markdown syntax tree says
 * which. cm6.ts adds the extension only when the mounted file is an agent
 * file (`Cm6Options.agentFile`).
 */

import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import {
  Decoration,
  MatchDecorator,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view';
import { AGENT_IMPORT_RE } from '../core/agent-files';

const CODE_NODES = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'CodeText', 'CodeMark']);

/** True when `pos` sits inside any code construct of the markdown tree. */
function inCode(state: EditorState, pos: number): boolean {
  let node: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(
    pos,
    1,
  );
  while (node) {
    if (CODE_NODES.has(node.name)) {
      return true;
    }
    node = node.parent;
  }
  return false;
}

const mark = Decoration.mark({ class: 'cm-agent-import' });

const agentImports = new MatchDecorator({
  // A RegExp of its own: MatchDecorator keeps `lastIndex` to itself.
  regexp: new RegExp(AGENT_IMPORT_RE.source, AGENT_IMPORT_RE.flags),
  decorate: (add, from, to, _match, view) => {
    if (!inCode(view.state, from + 1)) {
      add(from, to, mark);
    }
  },
});

export const agentImportsExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = agentImports.createDeco(view);
    }
    update(update: ViewUpdate) {
      // A reparse can move a token in or out of code with no text change at
      // that spot (closing a fence above it), so rebuild on a new tree too.
      this.decorations =
        syntaxTree(update.startState) !== syntaxTree(update.state)
          ? agentImports.createDeco(update.view)
          : agentImports.updateDeco(update, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);
