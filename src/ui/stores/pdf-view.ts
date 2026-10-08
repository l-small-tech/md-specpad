/**
 * What the chrome needs to know about each open PDF tab: the page at the top
 * of the view and the page count (the status bar's `Page 3 / 12`), and the
 * document's bookmarks (the Outline panel). Its own tiny store — NOT the tabs
 * store — so scrolling through a PDF never re-renders the TabBar (same
 * reasoning as `preview-nav.ts`).
 *
 * The outline jump is a plain function with the viewer's lifetime, so it
 * lives in a module map rather than reactive state (preview-nav's pattern).
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { PdfOutlineEntry } from '../../core/pdf';

export interface PdfTabInfo {
  readonly page: number;
  readonly pages: number;
  readonly outline: readonly PdfOutlineEntry[];
}

interface PdfViewState {
  /** tabId → its viewer's facts; absent until the document has loaded. */
  byTab: Record<string, PdfTabInfo>;
  setInfo: (tabId: string, patch: Partial<PdfTabInfo>) => void;
  clear: (tabId: string) => void;
}

const EMPTY: PdfTabInfo = { page: 1, pages: 0, outline: [] };

export const pdfViewStore = createStore<PdfViewState>()((set) => ({
  byTab: {},
  setInfo(tabId, patch) {
    set((s) => {
      const prev = s.byTab[tabId] ?? EMPTY;
      const next = { ...prev, ...patch };
      if (next.page === prev.page && next.pages === prev.pages && next.outline === prev.outline) {
        return s;
      }
      return { byTab: { ...s.byTab, [tabId]: next } };
    });
  },
  clear(tabId) {
    set((s) => {
      if (!(tabId in s.byTab)) {
        return s;
      }
      const next = { ...s.byTab };
      delete next[tabId];
      return { byTab: next };
    });
  },
}));

export const usePdfViewStore = <T>(selector: (s: PdfViewState) => T): T =>
  useStore(pdfViewStore, selector);

const outlineJumps = new Map<string, (index: number) => void>();

export function registerPdfOutlineJump(tabId: string, jump: (index: number) => void): void {
  outlineJumps.set(tabId, jump);
}

export function unregisterPdfOutlineJump(tabId: string): void {
  outlineJumps.delete(tabId);
}

/** Outline panel → the tab's viewer: go to bookmark `index`. False when no viewer is live. */
export function jumpPdfOutline(tabId: string, index: number): boolean {
  const jump = outlineJumps.get(tabId);
  if (!jump) {
    return false;
  }
  jump(index);
  return true;
}
