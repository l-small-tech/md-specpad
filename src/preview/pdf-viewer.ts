/**
 * The PDF tab's Review surface: pdf.js's own viewer component (`PDFViewer`
 * from `pdfjs-dist/web/pdf_viewer.mjs`) driven by a small imperative handle.
 * pdf.js brings the hard parts — lazy page rendering, the text layer (select
 * and copy), the annotation layer (links), and the find controller with its
 * match highlighting — and this module adapts them to the app:
 *
 * - **Zoom** is a pdf.js `currentScaleValue`: a fit (`auto`, `page-width`,
 *   `page-fit`, `page-actual`) or a number. pdf.js's viewer component does not
 *   re-fit on resize (its full app does), so `refit` re-applies a fitted zoom
 *   whenever the container's width changes — including the first time a tab
 *   restored in the background becomes visible (it loaded at width 0).
 * - **Links**: internal jumps are pdf.js's (`PDFLinkService`); an external
 *   link is a plain `<a href>` that the app-wide link guard (`ui/link-guard`)
 *   turns into the open-in-browser prompt, the same as anywhere else. Outline
 *   entries with a URL go through `onExternalLink` for the same prompt.
 * - **Read-only**: annotations render (`AnnotationMode.ENABLE`) but form
 *   fields are not interactive and no editor layer exists.
 *
 * Layering (I9): core only. pdf.js itself is loaded once, shared with the
 * importer (`core/import/pdfjs.ts`); its viewer module and stylesheet load
 * on the first PDF tab.
 */

import { loadPdfjs, pdfResourceOptions } from '../core/import/pdfjs';
import {
  flattenPdfOutline,
  isFitZoom,
  type PdfOutlineEntry,
  type PdfOutlineNode,
} from '../core/pdf';

type ViewerModule = typeof import('pdfjs-dist/web/pdf_viewer.mjs');
type PdfDocument = import('pdfjs-dist').PDFDocumentProxy;

export interface PdfViewerCallbacks {
  /** The page at the top of the view changed (or the document loaded). */
  onPage(page: number, pages: number): void;
  /** The zoom changed: the effective scale and the value it came from. */
  onScale(scale: number, value: string): void;
  /**
   * Find progress: pdf.js `FindState` (null when only the counts moved), the
   * current match (1-based) and the total.
   */
  onFind(state: number | null, current: number, total: number): void;
  /** An outline entry or other non-anchor surface wants to open a URL. */
  onExternalLink(url: string): void;
}

export interface PdfFindOptions {
  /** Step to the next/previous match of the same query instead of starting over. */
  again?: boolean;
  previous?: boolean;
}

export interface PdfViewerHandle {
  /** The document's bookmarks, flattened; empty when it has none. */
  readonly outline: readonly PdfOutlineEntry[];
  readonly pages: number;
  setZoom(value: string | number): void;
  /** Step the zoom in (+) or out (−) one notch, as pdf.js's buttons do. */
  zoomBy(steps: number): void;
  /** Multiply the zoom, keeping the document point under `origin` (client px) still. */
  zoomAt(factor: number, origin: [number, number]): void;
  goToPage(page: number): void;
  nextPage(): void;
  previousPage(): void;
  goToOutline(entry: PdfOutlineEntry): void;
  find(query: string, options?: PdfFindOptions): void;
  /** Drop the find highlights (the find bar closed). */
  closeFind(): void;
  /** Re-apply a fitted zoom after the container changed size. */
  refit(): void;
  dispose(): void;
}

let viewerModule: Promise<ViewerModule> | null = null;

/**
 * pdf_viewer.mjs reads `globalThis.pdfjsLib` when it evaluates, so it must be
 * imported after pdf.js itself has loaded — never statically.
 */
function loadViewerModule(): Promise<ViewerModule> {
  viewerModule ??= loadPdfjs().then(async () => {
    const [mod] = await Promise.all([
      import('pdfjs-dist/web/pdf_viewer.mjs'),
      import('pdfjs-dist/web/pdf_viewer.css'),
    ]);
    return mod;
  });
  return viewerModule;
}

/** Why a PDF would not open, in words for the view's status line. */
export function pdfLoadErrorText(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'PasswordException') {
    return 'This PDF is password-protected, which isn’t supported yet.';
  }
  if (name === 'InvalidPDFException') {
    return 'This file isn’t a valid PDF (or it is damaged).';
  }
  return 'Could not open this PDF.';
}

/**
 * Open `bytes` in `container`. The container must be absolutely positioned
 * (pdf.js checks) and hold a single empty `<div>` the pages go into. Rejects
 * when the document cannot be opened; `pdfLoadErrorText` words the reason.
 */
export async function createPdfViewer(
  container: HTMLDivElement,
  bytes: Uint8Array,
  callbacks: PdfViewerCallbacks,
  initialZoom: string = 'auto',
): Promise<PdfViewerHandle> {
  const [pdfjs, viewer] = await Promise.all([loadPdfjs(), loadViewerModule()]);
  const { EventBus, PDFLinkService, PDFFindController, PDFViewer, LinkTarget } = viewer;

  // `data` is transferred to the worker; the caller's array is left detached.
  const task = pdfjs.getDocument({
    data: bytes,
    useSystemFonts: true,
    ...pdfResourceOptions(location.href),
  });
  let doc: PdfDocument;
  try {
    doc = await task.promise;
  } catch (error) {
    void task.destroy();
    throw error;
  }

  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.NONE });
  const findController = new PDFFindController({ linkService, eventBus });
  const abort = new AbortController();
  // `abortSignal` (stops the viewer's resize observer and scroll listener on
  // dispose) is honoured by pdf_viewer.mjs but missing from its typings.
  const pdfViewer = new PDFViewer({
    container,
    eventBus,
    linkService,
    findController,
    annotationMode: pdfjs.AnnotationMode.ENABLE,
    ...({ abortSignal: abort.signal } as object),
  });
  linkService.setViewer(pdfViewer);

  // The last zoom the user asked for. A fit keeps being a fit across resizes.
  let zoomValue = initialZoom;
  let findQuery = '';

  eventBus.on('pagesinit', () => {
    pdfViewer.currentScaleValue = zoomValue;
  });
  eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
    callbacks.onPage(pageNumber, pdfViewer.pagesCount);
  });
  eventBus.on(
    'scalechanging',
    ({ scale, presetValue }: { scale: number; presetValue?: string }) => {
      callbacks.onScale(scale, presetValue ?? String(scale));
    },
  );
  type MatchesCount = { current: number; total: number };
  eventBus.on(
    'updatefindcontrolstate',
    ({ state, matchesCount }: { state: number; matchesCount: MatchesCount }) => {
      callbacks.onFind(state, matchesCount.current, matchesCount.total);
    },
  );
  eventBus.on('updatefindmatchescount', ({ matchesCount }: { matchesCount: MatchesCount }) => {
    callbacks.onFind(null, matchesCount.current, matchesCount.total);
  });

  pdfViewer.setDocument(doc);
  linkService.setDocument(doc, null);
  findController.setDocument(doc);
  callbacks.onPage(1, doc.numPages);

  let outline: PdfOutlineEntry[] = [];
  try {
    outline = flattenPdfOutline((await doc.getOutline()) as PdfOutlineNode[] | null);
  } catch {
    // A broken outline is not worth failing the document over.
  }

  let lastWidth = container.clientWidth;
  const resize = new ResizeObserver(() => {
    const width = container.clientWidth;
    if (width === 0 || width === lastWidth) {
      return;
    }
    lastWidth = width;
    handle.refit();
  });
  resize.observe(container);

  const dispatchFind = (type: '' | 'again', previous: boolean): void => {
    eventBus.dispatch('find', {
      source: null,
      type,
      query: findQuery,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    });
  };

  const handle: PdfViewerHandle = {
    outline,
    pages: doc.numPages,
    setZoom(value) {
      zoomValue = String(value);
      pdfViewer.currentScaleValue = zoomValue;
    },
    zoomBy(steps) {
      if (steps > 0) {
        pdfViewer.increaseScale({ steps });
      } else if (steps < 0) {
        pdfViewer.decreaseScale({ steps: -steps });
      }
      zoomValue = String(pdfViewer.currentScale);
    },
    zoomAt(factor, origin) {
      pdfViewer.updateScale({ scaleFactor: factor, origin });
      zoomValue = String(pdfViewer.currentScale);
    },
    goToPage(page) {
      linkService.goToPage(page);
    },
    nextPage() {
      pdfViewer.nextPage();
    },
    previousPage() {
      pdfViewer.previousPage();
    },
    goToOutline(entry) {
      if (entry.url) {
        callbacks.onExternalLink(entry.url);
      } else if (entry.dest !== null) {
        void linkService.goToDestination(entry.dest as string | unknown[]);
      }
    },
    find(query, options = {}) {
      const again = options.again === true && query === findQuery;
      findQuery = query;
      if (query === '') {
        handle.closeFind();
        return;
      }
      dispatchFind(again ? 'again' : '', options.previous === true);
    },
    closeFind() {
      findQuery = '';
      eventBus.dispatch('findbarclose', { source: null });
    },
    refit() {
      if (container.clientWidth > 0 && isFitZoom(zoomValue)) {
        pdfViewer.currentScaleValue = zoomValue;
      }
      pdfViewer.update();
    },
    dispose() {
      resize.disconnect();
      abort.abort();
      pdfViewer.setDocument(null as unknown as PdfDocument);
      linkService.setDocument(null, null);
      findController.setDocument(null as unknown as PdfDocument);
      void task.destroy();
    },
  };
  return handle;
}
