/**
 * Presenter view — the slides full screen in one window, a presenter window
 * (current + next slide, speaker notes, clock, timer) in another, both on the
 * same slide.
 *
 * Two pieces, both plain Tauri events (same shape as `settings-changed`):
 *
 *   - `deck-slide` — "this deck is on slide n", broadcast by whichever window
 *     the user drove and folded into {@link slideStore} by every other one.
 *     The show (`DeckShow`) and the presenter window both publish and follow,
 *     so either can drive; a mirror tab's show in another window follows too.
 *   - `presenter-deck` — the deck itself (text + where its images resolve
 *     from), sent to the presenter window by the window that opened it, again
 *     after every edit, and whenever the presenter says `presenter-ready`.
 *     The presenter renders it with the same `renderDeck` the panes use; it
 *     runs no session controller and owns no tab (see main.tsx's boot branch).
 *
 * The presenter window has ONE fixed label, so there is one per app, the
 * window-state plugin remembers which monitor it lives on, and `w-*` already
 * covers it in the capability files.
 */

import { emit, emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { createStore } from 'zustand/vanilla';
import { slideIndexForLine, splitSlides } from '../core/deck';
import type { PresenterDeck, SlideMessage } from '../core/presenter';
import { pathKey } from '../core/tab-workspaces';
import { readSurfaceTopLine } from './mode-scroll';
import { deckPaneFor } from './stores/deck-show';
import { tabDisplayTitle, tabsStore, type TabEntry } from './stores/tabs';
import { uiStore } from './stores/ui';

export const PRESENTER_LABEL = 'w-presenter';
export const SLIDE_EVENT = 'deck-slide';
export const DECK_EVENT = 'presenter-deck';
export const READY_EVENT = 'presenter-ready';
/** Another window took over the presenter: stop feeding it from here. */
const CLAIM_EVENT = 'presenter-claim';

const DECK_DEBOUNCE_MS = 200;

/** The slide each deck is on, by deck key — only decks someone has driven. */
export const slideStore = createStore<{ byKey: Record<string, number> }>(() => ({ byKey: {} }));

function windowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return 'main'; // outside a Tauri webview (tests)
  }
}

/** A deck's identity across windows: its file, else (an unsaved note) its tab. */
export function deckKeyFor(tab: Pick<TabEntry, 'id' | 'filePath' | 'notePath'>): string {
  const path = tab.filePath ?? tab.notePath;
  return path ? pathKey(path) : `tab:${tab.id}`;
}

function setSlide(key: string, index: number): boolean {
  const { byKey } = slideStore.getState();
  if (byKey[key] === index) {
    return false;
  }
  slideStore.setState({ byKey: { ...byKey, [key]: index } });
  return true;
}

/** This window moved deck `key` to slide `index`: record it and tell the rest. */
export function publishSlide(key: string, index: number): void {
  if (setSlide(key, index)) {
    const message: SlideMessage = { from: windowLabel(), key, index };
    void emit(SLIDE_EVENT, message).catch(() => {});
  }
}

/**
 * The slide a show opens on: where the presenter view already has the deck,
 * else whatever the surface underneath has on top.
 */
export function startSlide(tabId: string): number {
  const tab = tabsStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab) {
    return 0;
  }
  const driven = slideStore.getState().byKey[deckKeyFor(tab)];
  if (driven !== undefined && presentingTabId === tabId) {
    return driven;
  }
  const pane = deckPaneFor(tabId);
  if (pane) {
    return pane.getTopSlide();
  }
  const line = readSurfaceTopLine(tabId, tab.mode);
  return line === null ? 0 : slideIndexForLine(splitSlides(tab.model.getText()), line);
}

/* ---- Feeding the presenter window -------------------------------------- */

let presentingTabId: string | null = null;
let stopFeeding: (() => void) | null = null;

function sendDeck(): void {
  const tab = tabsStore.getState().tabs.find((t) => t.id === presentingTabId);
  if (!tab) {
    return;
  }
  const key = deckKeyFor(tab);
  const deck: PresenterDeck = {
    key,
    title: tabDisplayTitle(tab),
    text: tab.model.getText(),
    docPath: tab.filePath ?? tab.notePath,
    index: slideStore.getState().byKey[key] ?? 0,
  };
  void emitTo(PRESENTER_LABEL, DECK_EVENT, deck).catch(() => {});
}

function stopPresenting(): void {
  stopFeeding?.();
  stopFeeding = null;
  presentingTabId = null;
}

function feed(tab: TabEntry): void {
  stopPresenting();
  presentingTabId = tab.id;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribeModel = tab.model.subscribe(() => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(sendDeck, DECK_DEBOUNCE_MS);
  });
  // The tab closing (or moving to another window) ends the feed.
  const unsubscribeTabs = tabsStore.subscribe((s) => {
    if (!s.tabs.some((t) => t.id === tab.id)) {
      stopPresenting();
    }
  });
  stopFeeding = () => {
    unsubscribeModel();
    unsubscribeTabs();
    if (timer !== null) {
      clearTimeout(timer);
    }
  };
}

/**
 * Open the presenter window for deck tab `tabId` (or re-point and focus the
 * one already open). The window asks for its deck once it has mounted
 * (`presenter-ready`), so nothing is lost to a slow boot.
 */
export async function openPresenterView(tabId: string): Promise<void> {
  const tab = tabsStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab || !tab.deck) {
    uiStore.getState().showNotice('Presenter view is for slide decks (marp: true).');
    return;
  }
  const key = deckKeyFor(tab);
  if (slideStore.getState().byKey[key] === undefined) {
    // Seed from the surface BEFORE claiming the deck (startSlide prefers the
    // driven slide once this tab is the one being presented).
    setSlide(key, startSlide(tabId));
  }
  feed(tab);
  void emit(CLAIM_EVENT, { from: windowLabel() }).catch(() => {});
  try {
    const existing = await WebviewWindow.getByLabel(PRESENTER_LABEL);
    if (existing) {
      sendDeck();
      await existing.setFocus();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const w = new WebviewWindow(PRESENTER_LABEL, {
        url: 'index.html?presenter=1',
        title: 'Presenter view — MD Specpad',
        width: 1100,
        height: 680,
        minWidth: 560,
        minHeight: 360,
      });
      void w.once('tauri://created', () => resolve());
      void w.once('tauri://error', (e) => reject(new Error(JSON.stringify(e.payload))));
    });
  } catch (error) {
    stopPresenting();
    uiStore.getState().showNotice('Could not open the presenter view.');
    console.error('[presenter] open failed', error);
  }
}

/** Open the presenter view for the active tab (palette / shortcut). */
export function openPresenterForActiveTab(): void {
  const tab = tabsStore.getState().activeTab();
  if (tab) {
    void openPresenterView(tab.id);
  }
}

/**
 * App windows, once at boot (main.tsx): follow slide changes made elsewhere,
 * answer a presenter window that just mounted, and yield the presenter when
 * another window claims it.
 */
export function listenPresenter(): void {
  const self = windowLabel();
  void listen<SlideMessage>(SLIDE_EVENT, (event) => {
    const { from, key, index } = event.payload;
    if (from === self || !setSlide(key, index)) {
      return;
    }
    // No show running here: keep the light table / split column on that slide,
    // so the window beside the presenter is never somewhere else entirely.
    if (!uiStore.getState().osFullscreen) {
      for (const tab of tabsStore.getState().tabs) {
        if (tab.deck && deckKeyFor(tab) === key) {
          deckPaneFor(tab.id)?.scrollToSlide(index);
        }
      }
    }
  }).catch(() => {});
  void listen(READY_EVENT, () => sendDeck()).catch(() => {});
  void listen<{ from: string }>(CLAIM_EVENT, (event) => {
    if (event.payload.from !== self) {
      stopPresenting();
    }
  }).catch(() => {});
}
