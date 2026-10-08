/**
 * The one pdf.js instance the app loads — shared by the PDF importer
 * (`./pdf.ts`) and the PDF tab's viewer (`preview/pdf-viewer.ts`), so both
 * talk to a single worker. Dynamically imported so its ~1 MB (plus the
 * worker) stays out of the startup bundle.
 *
 * `pdfResourceOptions` points pdf.js at the data it fetches on demand: the 14
 * standard fonts (for PDFs that name Helvetica/Times without embedding them),
 * the CMaps (CJK text), the ICC profile and the image-decoder WebAssembly
 * (JBIG2 / JPEG 2000 — what scanned PDFs are made of). They are copied out of
 * `pdfjs-dist` under `/pdfjs/` by the `pdfjsResources` plugin in
 * vite.config.ts (served from node_modules in dev, emitted into dist on build).
 */

type Pdfjs = typeof import('pdfjs-dist');

let pdfjsPromise: Promise<Pdfjs> | null = null;

/** Load pdf.js once and point it at the Vite-bundled module worker. */
export function loadPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(
      new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url),
      { type: 'module' },
    );
    return pdfjs;
  });
  return pdfjsPromise;
}

/** Where the `pdfjsResources` Vite plugin serves pdf.js's data files. */
export const PDFJS_RESOURCE_BASE = 'pdfjs/';

/**
 * The `getDocument` options naming those data files. Absolute URLs: pdf.js
 * only lets its worker fetch them itself (no round trip through the main
 * thread) when every one is a valid absolute URL.
 */
export function pdfResourceOptions(baseHref: string): {
  cMapUrl: string;
  cMapPacked: boolean;
  standardFontDataUrl: string;
  wasmUrl: string;
  iccUrl: string;
} {
  const root = new URL(`${import.meta.env.BASE_URL}${PDFJS_RESOURCE_BASE}`, baseHref).href;
  return {
    cMapUrl: `${root}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${root}standard_fonts/`,
    wasmUrl: `${root}wasm/`,
    iccUrl: `${root}iccs/`,
  };
}
