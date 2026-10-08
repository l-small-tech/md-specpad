/**
 * PdfView — a PDF tab's Review mode: the rendered pages under a slim toolbar.
 * A PDF tab is an `import`-kind tab routed here by extension (core/pdf.ts), so
 * the conversion the import card used to offer lives on in the toolbar as
 * "Import as Markdown" (or "Open <note>.md" once a same-named note exists).
 *
 * Read-only for now: select and copy text, zoom, page through, find, follow
 * links and bookmarks (the Outline panel lists them, ui/stores/pdf-view.ts).
 * The pdf.js side — rendering, text layer, find highlighting — is the
 * `preview/pdf-viewer.ts` handle; this component owns the chrome and keys.
 *
 * Keys, while focus is inside the view: mod+F find (Enter / Shift+Enter,
 * F3 / Shift+F3 step, Esc closes), mod+= / mod+- / mod+0 zoom in / out /
 * back to automatic (claimed before the app's font-size chords), mod+wheel
 * zooms around the pointer, PageUp/PageDown/Home/End scroll natively.
 *
 * The bytes load once per path (a rename retargets the tab and reloads it).
 * Like the other viewer tabs it stays mounted while hidden, so switching back
 * keeps the page and zoom.
 */

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  PDF_FIT_ZOOMS,
  PDF_ZOOM_PERCENTS,
  findStatusText,
  fitZoomLabel,
  isFitZoom,
  parsePageInput,
  zoomPercentLabel,
} from '../../core/pdf';
import { baseName, dirName } from '../../core/session/plan-flush';
import { createPdfViewer, pdfLoadErrorText, type PdfViewerHandle } from '../../preview/pdf-viewer';
import { checkImportStatus, importDocumentInto, loadFileBytes, openNotePath } from '../session';
import { externalLinkStore } from '../stores/external-link';
import {
  pdfViewStore,
  registerPdfOutlineJump,
  unregisterPdfOutlineJump,
  usePdfViewStore,
} from '../stores/pdf-view';
import { useTabsStore } from '../stores/tabs';
import '../../styles/pdf.css';

const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform ?? '');

/** Keyed by the path it was loaded for: a stale path reads as "Loading…". */
type LoadState =
  | { readonly path: string; readonly status: 'ready' }
  | { readonly path: string; readonly status: 'failed'; readonly message: string };

interface FindInfo {
  readonly state: number | null;
  readonly current: number;
  readonly total: number;
}

const NO_FIND: FindInfo = { state: null, current: 0, total: 0 };

/** The 20-unit outline glyphs the ribbon draws with, so the toolbar matches it. */
function ToolIcon({ d }: { d: string }) {
  return (
    <svg
      className="pdf-tool-icon"
      viewBox="0 0 20 20"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

const ICON_UP = 'M5.5 12.5L10 8l4.5 4.5';
const ICON_DOWN = 'M5.5 7.5L10 12l4.5-4.5';
const ICON_MINUS = 'M5.5 10h9';
const ICON_PLUS = 'M5.5 10h9M10 5.5v9';
const ICON_FIND = 'M8.8 14.1a5.3 5.3 0 1 0 0-10.6 5.3 5.3 0 0 0 0 10.6zM12.6 12.6l4 4';
const ICON_CLOSE = 'M6 6l8 8M14 6l-8 8';

function PdfViewImpl({ tabId, active }: { tabId: string; active: boolean }) {
  const filePath = useTabsStore((s) => s.tabs.find((t) => t.id === tabId)?.filePath ?? null);
  const page = usePdfViewStore((s) => s.byTab[tabId]?.page ?? 1);
  const pages = usePdfViewStore((s) => s.byTab[tabId]?.pages ?? 0);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<PdfViewerHandle | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);

  const [load, setLoad] = useState<LoadState | null>(null);
  const [scale, setScale] = useState<{ value: string; scale: number }>({
    value: 'auto',
    scale: 1,
  });
  const [pageText, setPageText] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [find, setFind] = useState<FindInfo>(NO_FIND);

  // Import status (the toolbar's Import / Open note button), re-checked like
  // the import card did: on activation, on rename, and after an import.
  const [imported, setImported] = useState<{ path: string; mdPath: string; is: boolean } | null>(
    null,
  );
  const [importing, setImporting] = useState(false);
  const [importRefresh, setImportRefresh] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!filePath || !container) {
      return;
    }
    let cancelled = false;
    let handle: PdfViewerHandle | null = null;
    // The pdf.js viewer appends its pages to this child; start it empty.
    const pagesEl = container.firstElementChild as HTMLDivElement;
    pagesEl.replaceChildren();
    void (async () => {
      try {
        const bytes = await loadFileBytes(filePath);
        if (cancelled) {
          return;
        }
        handle = await createPdfViewer(container, bytes, {
          onPage: (n, total) => {
            pdfViewStore.getState().setInfo(tabId, { page: n, pages: total });
          },
          onScale: (s, value) => setScale({ scale: s, value }),
          onFind: (state, current, total) =>
            setFind((prev) => ({ state: state ?? prev.state, current, total })),
          onExternalLink: (url) => externalLinkStore.getState().request(url),
        });
        if (cancelled) {
          handle.dispose();
          return;
        }
        handleRef.current = handle;
        const outline = handle.outline;
        pdfViewStore.getState().setInfo(tabId, { outline, pages: handle.pages });
        registerPdfOutlineJump(tabId, (index) => {
          const entry = outline[index];
          if (entry) {
            handle?.goToOutline(entry);
          }
        });
        setLoad({ path: filePath, status: 'ready' });
      } catch (error) {
        if (!cancelled) {
          setLoad({ path: filePath, status: 'failed', message: pdfLoadErrorText(error) });
        }
      }
    })();
    return () => {
      cancelled = true;
      handle?.dispose();
      handleRef.current = null;
      unregisterPdfOutlineJump(tabId);
      pdfViewStore.getState().clear(tabId);
    };
  }, [filePath, tabId]);

  useEffect(() => {
    if (!filePath) {
      return;
    }
    let cancelled = false;
    void checkImportStatus(filePath).then(({ mdPath, imported: is }) => {
      if (!cancelled) {
        setImported({ path: filePath, mdPath, is });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [filePath, active, importRefresh]);

  // Coming back to the tab: hand focus to the pages so the scroll keys work.
  const loadedStatus = load?.status ?? null;
  useEffect(() => {
    if (active && loadedStatus === 'ready') {
      containerRef.current?.focus({ preventScroll: true });
    }
  }, [active, loadedStatus]);

  const onImport = useCallback(
    async (allowDuplicate = false) => {
      if (!filePath) {
        return;
      }
      setImporting(true);
      try {
        // Imports beside the source and opens the new note in front.
        await importDocumentInto(dirName(filePath), filePath, { allowDuplicate });
      } finally {
        setImporting(false);
        setImportRefresh((n) => n + 1);
      }
    },
    [filePath],
  );

  const openFind = useCallback(() => {
    setFindOpen(true);
    // The bar may be mounting this very render: select once it exists.
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFind(NO_FIND);
    handleRef.current?.closeFind();
    containerRef.current?.focus({ preventScroll: true });
  }, []);

  const step = useCallback(
    (previous: boolean) => {
      handleRef.current?.find(query, { again: true, previous });
    },
    [query],
  );

  // Keys for the whole view (toolbar, find bar and pages). Claimed with
  // preventDefault so the app's global listener — which skips handled events —
  // does not also treat mod+= as "bigger editor font".
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const mod = IS_MAC ? event.metaKey : event.ctrlKey;
    const key = event.key;
    if (mod && !event.altKey && !event.shiftKey && key.toLowerCase() === 'f') {
      event.preventDefault();
      openFind();
      return;
    }
    if (key === 'F3' && findOpen) {
      event.preventDefault();
      step(event.shiftKey);
      return;
    }
    if (key === 'Escape' && findOpen) {
      event.preventDefault();
      closeFind();
      return;
    }
    if (mod && !event.altKey && (key === '=' || key === '+')) {
      event.preventDefault();
      handleRef.current?.zoomBy(1);
      return;
    }
    if (mod && !event.altKey && (key === '-' || key === '_')) {
      event.preventDefault();
      handleRef.current?.zoomBy(-1);
      return;
    }
    if (mod && !event.altKey && key === '0') {
      event.preventDefault();
      handleRef.current?.setZoom('auto');
    }
  };

  // mod+wheel zooms around the pointer. A native listener: React's wheel
  // handler is passive, so it could not stop the page from scrolling too.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const onWheel = (event: WheelEvent): void => {
      if (!(IS_MAC ? event.metaKey : event.ctrlKey) || !handleRef.current) {
        return;
      }
      event.preventDefault();
      const factor = Math.exp(-event.deltaY / 400);
      handleRef.current.zoomAt(factor, [event.clientX, event.clientY]);
    };
    // pdf.js makes every page's text layer focusable, so a click on text
    // focuses a node that the next zoom replaces — and focus falls to <body>,
    // where the keys above no longer reach. Once the click or drag is over,
    // focus moves back to the scroller. Not sooner: moving it during the
    // mousedown cancels the text selection the drag is starting (moving it
    // afterwards keeps the selection). Tab still visits the layers for
    // screen readers.
    const onPointerUp = (): void => {
      const focused = document.activeElement;
      if (focused instanceof Element && focused.classList.contains('textLayer')) {
        container.focus({ preventScroll: true });
      }
    };
    const onPointerDown = (): void => {
      // A drag can end outside the view, so listen on the document.
      document.addEventListener('pointerup', onPointerUp, { once: true });
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('pointerdown', onPointerDown);
    return () => {
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('pointerup', onPointerUp);
    };
  }, []);

  const current = load !== null && load.path === filePath ? load : null;
  const ready = current?.status === 'ready';
  const status = imported !== null && imported.path === filePath ? imported : null;
  const name = filePath ? baseName(filePath) : '';
  const zoomIsFit = isFitZoom(scale.value);
  const zoomIsPreset =
    zoomIsFit || PDF_ZOOM_PERCENTS.some((p) => Math.abs(p / 100 - scale.scale) < 0.001);
  const zoomSelectValue = zoomIsFit
    ? scale.value
    : zoomIsPreset
      ? String(Math.round(scale.scale * 100) / 100)
      : 'custom';
  const findText = findStatusText(query, find.state, find.current, find.total);

  const commitPage = (text: string): void => {
    const target = parsePageInput(text, pages);
    if (target !== null) {
      handleRef.current?.goToPage(target);
    }
    setPageText(null);
  };

  return (
    <div
      className="editor-host pdf-host"
      style={{ display: active ? 'flex' : 'none' }}
      onKeyDown={onKeyDown}
    >
      <div className="pdf-toolbar" role="toolbar" aria-label="PDF">
        <span className="import-card-badge">PDF</span>
        <span className="pdf-name" title={filePath ?? undefined}>
          {name}
        </span>

        <div className="pdf-group" role="group" aria-label="Pages">
          <button
            className="pdf-tool"
            title="Previous page"
            aria-label="Previous page"
            disabled={!ready || page <= 1}
            onClick={() => handleRef.current?.previousPage()}
          >
            <ToolIcon d={ICON_UP} />
          </button>
          <input
            className="pdf-page-input"
            aria-label="Page"
            inputMode="numeric"
            disabled={!ready}
            value={pageText ?? String(page)}
            size={Math.max(2, String(pages).length)}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setPageText(e.target.value)}
            onBlur={(e) => commitPage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitPage(e.currentTarget.value);
                containerRef.current?.focus({ preventScroll: true });
              } else if (e.key === 'Escape') {
                setPageText(null);
                containerRef.current?.focus({ preventScroll: true });
              }
            }}
          />
          <span className="pdf-page-count">/ {pages || '–'}</span>
          <button
            className="pdf-tool"
            title="Next page"
            aria-label="Next page"
            disabled={!ready || page >= pages}
            onClick={() => handleRef.current?.nextPage()}
          >
            <ToolIcon d={ICON_DOWN} />
          </button>
        </div>

        <div className="pdf-group" role="group" aria-label="Zoom">
          <button
            className="pdf-tool"
            title={`Zoom out (${IS_MAC ? '⌘' : 'Ctrl+'}−)`}
            aria-label="Zoom out"
            disabled={!ready}
            onClick={() => handleRef.current?.zoomBy(-1)}
          >
            <ToolIcon d={ICON_MINUS} />
          </button>
          <select
            className="pdf-zoom"
            aria-label="Zoom"
            title="Zoom"
            disabled={!ready}
            value={zoomSelectValue}
            onChange={(e) => {
              handleRef.current?.setZoom(e.target.value);
              containerRef.current?.focus({ preventScroll: true });
            }}
          >
            {PDF_FIT_ZOOMS.map((fit) => (
              <option key={fit} value={fit}>
                {fit === scale.value
                  ? `${fitZoomLabel(fit)} (${zoomPercentLabel(scale.scale)})`
                  : fitZoomLabel(fit)}
              </option>
            ))}
            {PDF_ZOOM_PERCENTS.map((p) => (
              <option key={p} value={String(p / 100)}>
                {p}%
              </option>
            ))}
            {!zoomIsPreset && (
              <option value="custom" disabled>
                {zoomPercentLabel(scale.scale)}
              </option>
            )}
          </select>
          <button
            className="pdf-tool"
            title={`Zoom in (${IS_MAC ? '⌘' : 'Ctrl+'}+)`}
            aria-label="Zoom in"
            disabled={!ready}
            onClick={() => handleRef.current?.zoomBy(1)}
          >
            <ToolIcon d={ICON_PLUS} />
          </button>
        </div>

        <button
          className="pdf-tool"
          title={`Find in PDF (${IS_MAC ? '⌘' : 'Ctrl+'}F)`}
          aria-label="Find in PDF"
          aria-pressed={findOpen}
          disabled={!ready}
          onClick={() => (findOpen ? closeFind() : openFind())}
        >
          <ToolIcon d={ICON_FIND} />
        </button>

        <div className="pdf-toolbar-spacer" />

        {status?.is ? (
          <>
            {/* Name-based match only — a same-named note exists, but it may
                be unrelated, so don't claim this PDF was imported. */}
            <button
              className="pdf-action"
              title={`A note named ${baseName(status.mdPath)} sits beside this PDF`}
              onClick={() => openNotePath(status.mdPath)}
            >
              Open {baseName(status.mdPath)}
            </button>
            <button
              className="pdf-action pdf-action-quiet"
              title="Convert the PDF again, into a new note with a numbered name"
              disabled={importing}
              onClick={() => void onImport(true)}
            >
              {importing ? 'Importing…' : 'Import again'}
            </button>
          </>
        ) : (
          <button
            className="pdf-action"
            title="Convert this PDF into a Markdown note beside it (best-effort formatting)"
            disabled={importing || status === null}
            onClick={() => void onImport()}
          >
            {importing ? 'Importing…' : 'Import as Markdown'}
          </button>
        )}
      </div>

      {findOpen && (
        <div className="pdf-findbar" role="search">
          <input
            ref={findInputRef}
            className="pdf-find-input"
            type="text"
            placeholder="Find in PDF"
            aria-label="Find in PDF"
            value={query}
            onChange={(e) => {
              const next = e.target.value;
              setQuery(next);
              if (next === '') {
                setFind(NO_FIND);
              }
              handleRef.current?.find(next);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                step(e.shiftKey);
              }
            }}
          />
          <span className="pdf-find-status" role="status">
            {findText}
          </span>
          <button
            className="pdf-tool"
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
            disabled={query === ''}
            onClick={() => step(true)}
          >
            <ToolIcon d={ICON_UP} />
          </button>
          <button
            className="pdf-tool"
            title="Next match (Enter)"
            aria-label="Next match"
            disabled={query === ''}
            onClick={() => step(false)}
          >
            <ToolIcon d={ICON_DOWN} />
          </button>
          <button
            className="pdf-tool"
            title="Close (Esc)"
            aria-label="Close find"
            onClick={closeFind}
          >
            <ToolIcon d={ICON_CLOSE} />
          </button>
        </div>
      )}

      <div className="pdf-stage">
        <div ref={containerRef} className="pdf-scroll" tabIndex={0}>
          <div className="pdfViewer" />
        </div>
        {!ready && (
          <div className="pdf-status">
            {current?.status === 'failed' ? current.message : 'Loading…'}
          </div>
        )}
      </div>
    </div>
  );
}

export const PdfView = memo(PdfViewImpl);
