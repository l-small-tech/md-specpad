/**
 * OutlinePanel — a right-side drawer listing the active document's headings;
 * clicking one jumps the editor/preview there. Mirrors the FileExplorer's
 * drawer integration (mounted in App's .editor-area, rendered only while
 * `uiStore.outlineOpen`) on the opposite edge.
 *
 * The heading list comes from the pure line scanner (core/outline.ts), fed by
 * a direct DocModel subscription debounced ~300ms — same event flow as the
 * preview, without touching the tabs store on every keystroke. The click's
 * HOW is the pure `planOutlineJump` (ui/outline-jump.ts): source line for
 * raw/split, rendered-heading index for read (via the preview-nav registered
 * reveal) and Edit mode (via the adapter's optional revealHeading).
 *
 * Image/import tabs have no markdown model — the panel shows the empty state.
 * A PDF tab lists the document's own bookmarks instead (ui/stores/pdf-view.ts);
 * a click goes to the viewer's registered jump.
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { DocModel } from '../../core/doc-model';
import { extractOutline, type OutlineHeading } from '../../core/outline';
import { isPdfPath } from '../../core/pdf';
import { getSourceAdapter } from '../editor-registry';
import { planOutlineJump } from '../outline-jump';
import { jumpPdfOutline, usePdfViewStore } from '../stores/pdf-view';
import { hasPreviewReveal, revealPreviewHeading } from '../stores/preview-nav';
import { tabsStore, useTabsStore } from '../stores/tabs';
import { uiStore, useUiStore } from '../stores/ui';

const OUTLINE_DEBOUNCE_MS = 300;

/** Execute a heading click against whatever reveal mechanism the mode has. */
function jumpTo(index: number, line: number): void {
  const state = tabsStore.getState();
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  if (!tab) {
    return;
  }
  const source = getSourceAdapter(tab.id);
  const plan = planOutlineJump(
    tab.mode,
    source !== undefined,
    hasPreviewReveal(tab.id),
    index,
    line,
  );
  if (plan.kind === 'line') {
    source?.revealLine(plan.line);
    return;
  }
  if (plan.kind === 'heading') {
    if (tab.mode === 'read') {
      revealPreviewHeading(tab.id, plan.index);
      return;
    }
    const adapter = tab.modeSync?.getActiveAdapter?.();
    if (adapter?.revealHeading) {
      adapter.revealHeading(plan.index);
      return;
    }
  }
  uiStore.getState().showNotice('Cannot jump to that heading right now.');
}

export function OutlinePanel() {
  const open = useUiStore((s) => s.outlineOpen);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  if (!open) {
    return null;
  }
  // Keyed by tab: the body mounts fresh per tab, so its model never changes
  // while mounted and the initial outline can be computed in the useState
  // initializer (no setState-in-effect).
  return <OutlinePanelSwitch key={activeTabId} />;
}

function OutlinePanelSwitch() {
  const pdfTabId = useTabsStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab?.kind === 'import' && tab.filePath && isPdfPath(tab.filePath) ? tab.id : null;
  });
  return pdfTabId !== null ? <PdfOutlineBody tabId={pdfTabId} /> : <OutlinePanelBody />;
}

function OutlineFrame({ children }: { children: ReactNode }) {
  return (
    <div className="outline-panel">
      <div className="outline-header">
        <span className="outline-title">Outline</span>
        <button
          className="outline-close"
          aria-label="Close outline"
          title="Close outline"
          onClick={() => uiStore.getState().toggleOutline()}
        >
          ×
        </button>
      </div>
      <div className="outline-list">{children}</div>
    </div>
  );
}

/** A PDF's bookmarks, indented by depth like headings. */
function PdfOutlineBody({ tabId }: { tabId: string }) {
  const outline = usePdfViewStore((s) => s.byTab[tabId]?.outline);
  return (
    <OutlineFrame>
      {(outline ?? []).map((entry, i) => (
        <button
          key={i}
          className="outline-item"
          style={{ paddingLeft: 10 + (entry.level - 1) * 12 }}
          title={entry.url ?? entry.title}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (!jumpPdfOutline(tabId, i)) {
              uiStore.getState().showNotice('Cannot jump to that bookmark right now.');
            }
          }}
        >
          {entry.title || '(untitled)'}
        </button>
      ))}
      {outline !== undefined && outline.length === 0 && (
        <div className="outline-empty">This PDF has no bookmarks</div>
      )}
    </OutlineFrame>
  );
}

function OutlinePanelBody() {
  // The model reference is stable for the (keyed) tab, so this selector never
  // re-renders on keystrokes — those flow through the subscription below.
  // Image/import tabs carry no markdown text: model = null → empty state.
  const model = useTabsStore<DocModel | null>((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab && tab.kind !== 'image' && tab.kind !== 'import' ? tab.model : null;
  });
  const [outline, setOutline] = useState<OutlineHeading[]>(() =>
    model ? extractOutline(model.getText()) : [],
  );

  useEffect(() => {
    if (!model) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = model.subscribe(() => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        setOutline(extractOutline(model.getText()));
      }, OUTLINE_DEBOUNCE_MS);
    });
    return () => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      unsubscribe();
    };
  }, [model]);

  return (
    <OutlineFrame>
      {outline.map((h, i) => (
        <button
          key={`${h.line}-${i}`}
          className="outline-item"
          style={{ paddingLeft: 10 + (h.level - 1) * 12 }}
          title={h.text}
          // Keep focus where it is — revealLine refocuses the editor itself.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => jumpTo(i, h.line)}
        >
          {h.text || '(untitled)'}
        </button>
      ))}
      {outline.length === 0 && <div className="outline-empty">No headings</div>}
    </OutlineFrame>
  );
}
