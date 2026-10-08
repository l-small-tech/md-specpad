/**
 * PDF → markdown converter (best effort, explicitly lossy). Text comes from
 * getTextContent() and is reassembled by pdf-text.ts; embedded raster images
 * are pulled out of each page's operator list, re-encoded as PNG via canvas,
 * and anchored inline by the y position where they were painted.
 *
 * Touches pdf.js and the DOM (canvas) but never ipc — the session controller
 * owns all disk IO. pdf.js comes from the shared lazy loader (`./pdfjs.ts`),
 * the same instance the PDF tab's viewer uses.
 */

import { base64ToBytes } from '../images';
import type { ImportResult, ImportedImage } from './registry';
import { pagesToMarkdown, pageToMarkdown, type PdfImageItem, type PdfTextItem } from './pdf-text';
import { loadPdfjs, pdfResourceOptions } from './pdfjs';

type Pdfjs = typeof import('pdfjs-dist');

/** Raw decoded image data as pdf.js hands it out of page.objs. */
interface PdfImageObj {
  width: number;
  height: number;
  data?: Uint8ClampedArray | Uint8Array;
  kind?: number;
  bitmap?: ImageBitmap;
}

/** Re-encode one decoded PDF image as PNG base64, or null when unusable. */
async function imageToPngBase64(pdfjs: Pdfjs, obj: PdfImageObj): Promise<string | null> {
  const { width, height } = obj;
  if (!width || !height || (width < 16 && height < 16)) {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return null;
  }
  if (obj.bitmap) {
    ctx.drawImage(obj.bitmap, 0, 0);
  } else if (obj.data) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    const src = obj.data;
    if (obj.kind === pdfjs.ImageKind.RGBA_32BPP) {
      rgba.set(src.subarray(0, rgba.length));
    } else if (obj.kind === pdfjs.ImageKind.RGB_24BPP) {
      for (let i = 0, j = 0; j < rgba.length; i += 3, j += 4) {
        rgba[j] = src[i] ?? 0;
        rgba[j + 1] = src[i + 1] ?? 0;
        rgba[j + 2] = src[i + 2] ?? 0;
        rgba[j + 3] = 255;
      }
    } else if (obj.kind === pdfjs.ImageKind.GRAYSCALE_1BPP) {
      const rowBytes = (width + 7) >> 3;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const bit = ((src[y * rowBytes + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1;
          const v = bit ? 255 : 0;
          const j = (y * width + x) * 4;
          rgba[j] = rgba[j + 1] = rgba[j + 2] = v;
          rgba[j + 3] = 255;
        }
      }
    } else {
      return null;
    }
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  } else {
    return null;
  }
  const dataUrl = canvas.toDataURL('image/png');
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : null;
}

/** Max time to wait for one image XObject before giving up on it. */
const OBJ_TIMEOUT_MS = 5000;

/**
 * Await a named object from page.objs / page.commonObjs (callback API). The
 * callback API can register a listener that pdf.js never invokes on a broken or
 * partial page, so the Promise is raced against a timeout: a stuck object
 * resolves to null (skip its image) instead of hanging the whole import.
 */
function getPageObj(page: PdfPage, name: string): Promise<PdfImageObj | null> {
  const store = name.startsWith('g_') ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    let settled = false;
    const done = (obj: PdfImageObj | null) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(obj);
      }
    };
    const timer = setTimeout(() => done(null), OBJ_TIMEOUT_MS);
    try {
      store.get(name, (obj: PdfImageObj | null) => done(obj));
    } catch {
      // Synchronous throw (broken/partial page) — skip the image.
      done(null);
    }
  });
}

interface PdfObjStore {
  get(name: string, callback?: (obj: PdfImageObj | null) => void): PdfImageObj | null;
}
interface PdfPage {
  objs: PdfObjStore;
  commonObjs: PdfObjStore;
  getTextContent(): Promise<{ items: unknown[] }>;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
}

/** Text runs of a page as plain items (PDF user space, y grows up). */
function textItems(content: { items: unknown[] }): PdfTextItem[] {
  const out: PdfTextItem[] = [];
  for (const raw of content.items) {
    const it = raw as { str?: string; transform?: number[]; height?: number };
    if (typeof it.str !== 'string' || !it.transform) {
      continue;
    }
    const size =
      Math.abs(it.transform[3] ?? 0) || Math.abs(it.transform[0] ?? 0) || it.height || 10;
    out.push({ str: it.str, x: it.transform[4] ?? 0, y: it.transform[5] ?? 0, size });
  }
  return out;
}

/**
 * Extract the page's raster images: scan the operator list for paint ops,
 * tracking the latest transform's ty as the best-effort inline anchor.
 * Repeated uses of the same image object on a page are deduped.
 */
async function pageImages(
  pdfjs: Pdfjs,
  page: PdfPage,
  images: ImportedImage[],
  baseName: string,
): Promise<PdfImageItem[]> {
  const { OPS } = pdfjs;
  const anchors: PdfImageItem[] = [];
  let ops;
  try {
    ops = await page.getOperatorList();
  } catch {
    return anchors;
  }
  const seen = new Set<string>();
  let currentY = Number.MAX_SAFE_INTEGER; // top of page until a transform says otherwise
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.transform && Array.isArray(args) && args.length >= 6) {
      // ty === 0 is a legitimate anchor (image at the page origin); only fall
      // back to the previous transform when the value isn't a real number.
      const ty = Number(args[5]);
      currentY = Number.isFinite(ty) ? ty : currentY;
      continue;
    }
    const isRef = fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat;
    const isInline = fn === OPS.paintInlineImageXObject;
    if (!isRef && !isInline) {
      continue;
    }
    let obj: PdfImageObj | null;
    if (isRef) {
      const name = String(args?.[0] ?? '');
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      obj = await getPageObj(page, name);
    } else {
      obj = (args?.[0] as PdfImageObj) ?? null;
    }
    if (!obj) {
      continue;
    }
    let png: string | null = null;
    try {
      png = await imageToPngBase64(pdfjs, obj);
    } catch {
      // Undecodable image — skip it, keep the rest of the page.
    }
    if (!png) {
      continue;
    }
    anchors.push({ imageIndex: images.length, y: currentY });
    images.push({ base64: png, ext: '.png', name: `${baseName}-img-${images.length + 1}` });
  }
  return anchors;
}

/** Convert one PDF (base64 bytes) to markdown + extracted images. */
export async function convertPdf(bytesBase64: string, name: string): Promise<ImportResult> {
  const pdfjs = await loadPdfjs();
  const data = base64ToBytes(bytesBase64);
  // The CMaps matter here too: without them CJK text in a CID font
  // extracts as nothing.
  const task = pdfjs.getDocument({
    data,
    useSystemFonts: true,
    ...pdfResourceOptions(location.href),
  });
  const doc = await task.promise;
  const baseName = name.replace(/\.[^.]*$/, '').toLowerCase() || 'import';
  const images: ImportedImage[] = [];
  const pages: string[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      try {
        const page = (await doc.getPage(n)) as unknown as PdfPage;
        const content = await page.getTextContent();
        const anchors = await pageImages(pdfjs, page, images, baseName);
        pages.push(pageToMarkdown(textItems(content), anchors));
      } catch {
        pages.push(`> [Import: page ${n} could not be converted]`);
      }
    }
  } finally {
    void task.destroy();
  }
  return { markdown: pagesToMarkdown(pages), images };
}
