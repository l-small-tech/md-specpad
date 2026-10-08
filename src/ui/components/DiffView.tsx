/**
 * DiffView — read-only diff of two texts, VS Code-style: a slim header (path,
 * `+N −M`, change counter, ↑/↓, inline ⇄ side-by-side), line-number gutters,
 * tinted removed / added lines with stronger intra-line highlights, syntax
 * colour inferred from `path`, long unchanged runs folded behind
 * "⋯ N unchanged lines" bars, and an overview ruler on the right edge.
 *
 * Everything decided here is pure and tested elsewhere: core/diff.ts compares,
 * core/diff-layout.ts builds the inline rows, the folds, the change blocks and
 * the ruler marks, core/diff-syntax.ts tokenises each side ONCE and merges
 * tokens with the intra-line ranges. This component renders and scrolls.
 *
 * Side by side is two scroll containers (each column scrolls sideways on its
 * own, like VS Code) whose vertical positions are kept equal on every scroll;
 * every row — lines, fillers and fold bars — is exactly one line tall, so the
 * columns stay aligned. Keyboard (focus inside the diff): F7 / Shift+F7 or
 * Alt+↓ / Alt+↑ step through changes.
 *
 * Callers: git/GitDetail (a file's diff), EditorHost (conflict "View diff",
 * on disk ↔ in editor).
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { buildDiffRows, diffLines, diffStats, type DiffRow, type DiffSide } from '../../core/diff';
import {
  buildUnifiedRows,
  changeBlocks,
  expandFold,
  foldRows,
  rulerMarks,
  sideLayoutRows,
  stepChange,
  unifiedLayoutRows,
  type DiffSegment,
  type FoldExpansions,
  type UnifiedRow,
} from '../../core/diff-layout';
import { mergeSpans, tokenizeLines, type TokenSpan } from '../../core/diff-syntax';
import { settingsStore, useSettingsStore } from '../stores/settings';
import '../../styles/diff.css';

/** Rows a fold's ↑ / ↓ buttons reveal. */
const EXPAND_STEP = 20;

type Tokens = TokenSpan[][] | null;

/* ---------------------------------- glyphs --------------------------------- */

const GLYPHS = {
  up: <path d="M4 10l4-4 4 4" />,
  down: <path d="M4 6l4 4 4-4" />,
  // Two columns: side by side.
  split: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M8 3v10" />
    </>
  ),
  // One column of − / + lines: inline.
  inline: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M5 6.5h6M5 9.5h6" />
    </>
  ),
  expandUp: <path d="M5 7l3-3 3 3M8 4v8" />,
  expandDown: <path d="M5 9l3 3 3-3M8 12V4" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
} as const;

function Glyph({ name }: { name: keyof typeof GLYPHS }) {
  return (
    <svg className="diff-glyph" viewBox="0 0 16 16" aria-hidden="true">
      {GLYPHS[name]}
    </svg>
  );
}

/* ----------------------------------- rows ---------------------------------- */

/** A line's text: syntax tokens composed with the intra-line changed range. */
function LineText({
  text,
  tokens,
  hi,
}: {
  text: string;
  tokens: TokenSpan[] | undefined;
  hi: [number, number] | null;
}) {
  if (!tokens && !hi) {
    return <span className="diff-text">{text}</span>;
  }
  return (
    <span className="diff-text">
      {mergeSpans(text, tokens, hi).map((seg, i) => {
        const cls = [seg.cls, seg.hi ? 'diff-hi' : null].filter(Boolean).join(' ');
        return cls ? (
          <span key={i} className={cls}>
            {seg.text}
          </span>
        ) : (
          seg.text
        );
      })}
    </span>
  );
}

function SideLine({
  cell,
  row,
  side,
  tokens,
}: {
  cell: DiffSide | null;
  row: number;
  side: 'left' | 'right';
  tokens: Tokens;
}) {
  if (!cell) {
    return (
      <div className="diff-line diff-line-filler" data-row={row}>
        <span className="diff-gutter" />
      </div>
    );
  }
  const kind = cell.changed ? (side === 'left' ? 'del' : 'ins') : null;
  return (
    <div className={`diff-line${kind ? ` diff-line-${kind}` : ''}`} data-row={row}>
      <span className="diff-gutter">
        <span className="diff-num">{cell.num}</span>
        <span className="diff-sign">{kind === 'del' ? '−' : kind === 'ins' ? '+' : ''}</span>
      </span>
      <LineText text={cell.text} tokens={tokens?.[cell.num - 1]} hi={cell.hi} />
    </div>
  );
}

function UnifiedLine({
  r,
  row,
  oldTokens,
  newTokens,
}: {
  r: UnifiedRow;
  row: number;
  oldTokens: Tokens;
  newTokens: Tokens;
}) {
  const tokens = r.kind === 'del' ? oldTokens?.[r.oldNum! - 1] : newTokens?.[(r.newNum ?? 1) - 1];
  return (
    <div className={`diff-line${r.kind === 'equal' ? '' : ` diff-line-${r.kind}`}`} data-row={row}>
      <span className="diff-gutter">
        <span className="diff-num">{r.oldNum ?? ''}</span>
        <span className="diff-num">{r.newNum ?? ''}</span>
        <span className="diff-sign">{r.kind === 'del' ? '−' : r.kind === 'ins' ? '+' : ''}</span>
      </span>
      <LineText text={r.text} tokens={tokens} hi={r.hi} />
    </div>
  );
}

function FoldBar({
  seg,
  onExpand,
}: {
  seg: Extract<DiffSegment, { type: 'fold' }>;
  onExpand: (key: string, how: 'all' | 'top' | 'bottom') => void;
}) {
  const hidden = seg.end - seg.start;
  return (
    <div className="diff-fold">
      <span className="diff-gutter">
        {hidden > EXPAND_STEP && (
          <>
            <button
              type="button"
              className="diff-fold-step"
              title={`Show ${EXPAND_STEP} more lines below the code above`}
              onClick={() => onExpand(seg.key, 'top')}
            >
              <Glyph name="expandDown" />
            </button>
            <button
              type="button"
              className="diff-fold-step"
              title={`Show ${EXPAND_STEP} more lines above the code below`}
              onClick={() => onExpand(seg.key, 'bottom')}
            >
              <Glyph name="expandUp" />
            </button>
          </>
        )}
      </span>
      <button
        type="button"
        className="diff-fold-label"
        title="Show all unchanged lines here"
        onClick={() => onExpand(seg.key, 'all')}
      >
        ⋯ {hidden} unchanged line{hidden === 1 ? '' : 's'}
      </button>
    </div>
  );
}

/** One column's (or the inline view's) rows. Memoised: navigation and the
 *  ruler re-render the header, never thousands of lines. */
const Rows = memo(function Rows({
  segments,
  sideRows,
  side,
  unified,
  oldTokens,
  newTokens,
  onExpand,
}: {
  segments: DiffSegment[];
  sideRows: DiffRow[];
  side: 'left' | 'right' | null;
  unified: UnifiedRow[] | null;
  oldTokens: Tokens;
  newTokens: Tokens;
  onExpand: (key: string, how: 'all' | 'top' | 'bottom') => void;
}) {
  const out: React.ReactNode[] = [];
  for (const seg of segments) {
    if (seg.type === 'fold') {
      out.push(<FoldBar key={`f${seg.key}`} seg={seg} onExpand={onExpand} />);
      continue;
    }
    for (let i = seg.start; i < seg.end; i += 1) {
      if (unified) {
        out.push(
          <UnifiedLine
            key={i}
            r={unified[i]!}
            row={i}
            oldTokens={oldTokens}
            newTokens={newTokens}
          />,
        );
      } else {
        const r = sideRows[i]!;
        out.push(
          <SideLine
            key={i}
            row={i}
            side={side!}
            cell={side === 'left' ? r.left : r.right}
            tokens={side === 'left' ? oldTokens : newTokens}
          />,
        );
      }
    }
  }
  return <div className="diff-rows">{out}</div>;
});

/* ---------------------------------- header --------------------------------- */

function PathTitle({ path }: { path: string }) {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return (
    <span className="diff-path" title={path}>
      <span className="diff-path-base">{path.slice(cut + 1)}</span>
      {cut > 0 && <span className="diff-path-dir">{path.slice(0, cut)}</span>}
    </span>
  );
}

/* ---------------------------------- view ----------------------------------- */

export function DiffView({
  oldText,
  newText,
  oldLabel,
  newLabel,
  path,
  notice,
  onClose,
  closeTitle = 'Close the diff',
}: {
  oldText: string;
  newText: string;
  oldLabel: string;
  newLabel: string;
  /** The file being compared: shown in the header and picks the syntax
   *  colouring (none for an unknown extension). */
  path?: string | null;
  /** A one-line note under the header ("Only line endings differ…"). */
  notice?: string | null;
  /** Shows a close button at the header's end. */
  onClose?: () => void;
  closeTitle?: string;
}) {
  const inline = useSettingsStore((s) => s.settings.diffInline);

  const { rows, stats } = useMemo(() => {
    const ops = diffLines(oldText, newText);
    return { rows: buildDiffRows(ops), stats: diffStats(ops) };
  }, [oldText, newText]);
  const unified = useMemo(() => (inline ? buildUnifiedRows(rows) : null), [inline, rows]);
  const layoutRows = useMemo(
    () => (unified ? unifiedLayoutRows(unified) : sideLayoutRows(rows)),
    [unified, rows],
  );
  const oldTokens = useMemo(() => tokenizeLines(oldText, path), [oldText, path]);
  const newTokens = useMemo(() => tokenizeLines(newText, path), [newText, path]);

  // Fold expansions and the change counter belong to these two texts; new
  // texts start folded again. (Fold keys are old line numbers, so they DO
  // survive an inline ⇄ side-by-side switch.)
  const [expansions, setExpansions] = useState<FoldExpansions>({});
  const [current, setCurrent] = useState<number | null>(null);
  const [shown, setShown] = useState({ oldText, newText });
  if (shown.oldText !== oldText || shown.newText !== newText) {
    setShown({ oldText, newText });
    setExpansions({});
    setCurrent(null);
  }

  const blocks = useMemo(() => changeBlocks(layoutRows), [layoutRows]);
  const segments = useMemo(() => foldRows(layoutRows, expansions), [layoutRows, expansions]);
  const marks = useMemo(() => rulerMarks(blocks, segments), [blocks, segments]);

  const onExpand = useCallback((key: string, how: 'all' | 'top' | 'bottom') => {
    setExpansions((e) => expandFold(e, key, how, EXPAND_STEP));
  }, []);

  /* ---- scrolling ---- */

  const leftRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null); // the right column, or the inline pane
  const viewportRef = useRef<HTMLDivElement>(null);
  /** Where the last ↑/↓ left the view — while it has not been scrolled since,
   *  the next step continues from that block instead of the viewport. */
  const navRef = useRef<{ block: number; scrollTop: number } | null>(null);

  const syncRuler = useCallback(() => {
    const el = mainRef.current;
    const box = viewportRef.current;
    if (!el || !box) {
      return;
    }
    const h = el.scrollHeight || 1;
    const visible = el.clientHeight >= el.scrollHeight;
    box.style.display = visible ? 'none' : '';
    box.style.top = `${(el.scrollTop / h) * 100}%`;
    box.style.height = `${(el.clientHeight / h) * 100}%`;
  }, []);

  const onScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const self = e.currentTarget;
      const other = self === leftRef.current ? mainRef.current : leftRef.current;
      if (other && other.scrollTop !== self.scrollTop) {
        other.scrollTop = self.scrollTop;
      }
      syncRuler();
    },
    [syncRuler],
  );

  useLayoutEffect(() => {
    syncRuler();
  }, [syncRuler, segments, inline]);

  useEffect(() => {
    const el = mainRef.current;
    if (!el || typeof ResizeObserver === 'undefined') {
      return;
    }
    const ro = new ResizeObserver(syncRuler);
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncRuler, inline]);

  /** First row (index) at least partly visible in the main pane. */
  const topRow = useCallback((): number => {
    const el = mainRef.current;
    if (!el) {
      return 0;
    }
    const lines = el.querySelectorAll<HTMLElement>('[data-row]');
    let lo = 0;
    let hi = lines.length - 1;
    let found = lines.length > 0 ? Number(lines[lines.length - 1]!.dataset.row) : 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const line = lines[mid]!;
      if (line.offsetTop + line.offsetHeight > el.scrollTop) {
        found = Number(line.dataset.row);
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return found;
  }, []);

  const goToBlock = useCallback(
    (index: number) => {
      const el = mainRef.current;
      const block = blocks[index];
      if (!el || !block) {
        return;
      }
      const line = el.querySelector<HTMLElement>(`[data-row="${block.start}"]`);
      if (!line) {
        return;
      }
      el.scrollTop = Math.max(0, line.offsetTop - el.clientHeight / 3);
      if (leftRef.current) {
        leftRef.current.scrollTop = el.scrollTop;
      }
      navRef.current = { block: index, scrollTop: el.scrollTop };
      setCurrent(index);
      syncRuler();
    },
    [blocks, syncRuler],
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      const el = mainRef.current;
      if (!el) {
        return;
      }
      const nav = navRef.current;
      const from =
        nav && blocks[nav.block] && Math.abs(el.scrollTop - nav.scrollTop) < 2
          ? blocks[nav.block]!.start
          : topRow() - (dir === 1 ? 0.5 : 0);
      const next = stepChange(blocks, from, dir);
      if (next !== null) {
        goToBlock(next);
      }
    },
    [blocks, goToBlock, topRow],
  );

  // A different layout invalidates the remembered block.
  useEffect(() => {
    navRef.current = null;
  }, [blocks]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    let dir: 1 | -1 | 0 = 0;
    if (e.key === 'F7' && !e.altKey && !e.ctrlKey && !e.metaKey) {
      dir = e.shiftKey ? -1 : 1;
    } else if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      dir = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    }
    if (dir !== 0) {
      e.preventDefault();
      e.stopPropagation();
      step(dir);
    }
  };

  const onRulerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = mainRef.current;
    if (!el) {
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const f = (e.clientY - rect.top) / Math.max(1, rect.height);
    el.scrollTop = f * el.scrollHeight - el.clientHeight / 2;
  };

  const toggleInline = () => {
    navRef.current = null;
    setCurrent(null);
    settingsStore.getState().update({ diffInline: !inline });
  };

  const digits = String(Math.max(oldText.split('\n').length, newText.split('\n').length)).length;
  const count = blocks.length;
  const counter =
    count === 0
      ? 'No changes'
      : current !== null && current < count
        ? `${current + 1} of ${count}`
        : `${count} change${count === 1 ? '' : 's'}`;

  return (
    <div
      className={`diff-view${inline ? ' diff-view-inline' : ' diff-view-split'}`}
      style={{ '--diff-digits': digits } as React.CSSProperties}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="diff-header">
        <span className="diff-title">
          {path && <PathTitle path={path} />}
          <span className="diff-sides">
            {oldLabel} <span className="diff-sides-arrow">↔</span> {newLabel}
          </span>
        </span>
        <span className="diff-stats">
          <span className="diff-stat-ins">+{stats.added}</span>
          <span className="diff-stat-del">−{stats.removed}</span>
        </span>
        <span className="diff-counter">{counter}</span>
        <button
          type="button"
          className="diff-btn"
          title="Previous change (Shift+F7, Alt+↑)"
          aria-label="Previous change"
          disabled={count === 0}
          onClick={() => step(-1)}
        >
          <Glyph name="up" />
        </button>
        <button
          type="button"
          className="diff-btn"
          title="Next change (F7, Alt+↓)"
          aria-label="Next change"
          disabled={count === 0}
          onClick={() => step(1)}
        >
          <Glyph name="down" />
        </button>
        <button
          type="button"
          className="diff-btn"
          title={inline ? 'Show side by side' : 'Show inline'}
          aria-label={inline ? 'Show side by side' : 'Show inline'}
          onClick={toggleInline}
        >
          <Glyph name={inline ? 'split' : 'inline'} />
        </button>
        {onClose && (
          <button
            type="button"
            className="diff-btn"
            title={closeTitle}
            aria-label={closeTitle}
            onClick={onClose}
          >
            <Glyph name="close" />
          </button>
        )}
      </div>
      {notice && <div className="diff-notice">{notice}</div>}
      <div className="diff-body">
        {inline ? (
          <div ref={mainRef} className="diff-pane" onScroll={onScroll}>
            <Rows
              segments={segments}
              sideRows={rows}
              side={null}
              unified={unified}
              oldTokens={oldTokens}
              newTokens={newTokens}
              onExpand={onExpand}
            />
          </div>
        ) : (
          <>
            <div ref={leftRef} className="diff-pane diff-pane-left" onScroll={onScroll}>
              <Rows
                segments={segments}
                sideRows={rows}
                side="left"
                unified={null}
                oldTokens={oldTokens}
                newTokens={newTokens}
                onExpand={onExpand}
              />
            </div>
            <div className="diff-divider" />
            <div ref={mainRef} className="diff-pane diff-pane-right" onScroll={onScroll}>
              <Rows
                segments={segments}
                sideRows={rows}
                side="right"
                unified={null}
                oldTokens={oldTokens}
                newTokens={newTokens}
                onExpand={onExpand}
              />
            </div>
          </>
        )}
        <div className="diff-ruler" onClick={onRulerClick} aria-hidden="true">
          {marks.map((m) => (
            <div
              key={m.block}
              className={`diff-mark diff-mark-${m.kind}${m.block === current ? ' is-current' : ''}`}
              style={{ top: `${m.top * 100}%`, height: `${m.height * 100}%` }}
              onClick={(e) => {
                e.stopPropagation();
                goToBlock(m.block);
              }}
            />
          ))}
          <div ref={viewportRef} className="diff-ruler-viewport" />
        </div>
      </div>
    </div>
  );
}
