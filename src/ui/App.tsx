/**
 * App — the layout shell: TabBar / editor stack / StatusBar.
 *
 * All EditorHosts stay mounted (I7); only the active one is visible. When the
 * active tab changes, App focuses that tab's editor once its ModeSync has
 * finished its initial/last attach (whenIdle), so launch lands the caret in
 * the editor and tab switches keep focus in the right place.
 */

import { useEffect, useState } from 'react';
import { isAudioPath } from '../core/audio';
import { TabBar } from './components/TabBar';
import { Ribbon } from './components/Ribbon';
import { FileExplorer } from './components/FileExplorer';
import { OutlinePanel } from './components/OutlinePanel';
import { EditorHost } from './components/EditorHost';
import { AudioView } from './components/AudioView';
import { ImageView } from './components/ImageView';
import { ImportView } from './components/ImportView';
import { TerminalTab } from './components/TerminalTab';
import { GitTab } from './components/git/GitTab';
import { StatusBar } from './components/StatusBar';
import { SettingsDialog } from './components/SettingsDialog';
import { ExportPreviewDialog } from './components/ExportPreviewDialog';
import { BoardColorMenu } from './components/BoardColorMenu';
import { DiagramViewer } from './components/DiagramViewer';
import { CommandPalette } from './components/CommandPalette';
import { ExternalLinkPrompt } from './components/ExternalLinkPrompt';
import { WhisperSetupPrompt } from './components/WhisperSetupPrompt';
import { SearchPanel } from './components/SearchPanel';
import { NotesOverview } from './components/NotesOverview';
import { InitWorkspaceDialog } from './components/InitWorkspaceDialog';
import { FullscreenMenu, useFullscreenLongPress } from './components/FullscreenMenu';
import { ResizeBorders } from './components/ResizeBorders';
import { IS_MAC } from './components/AppMenu';
import { setDistractionFree, setOsFullscreen } from './fullscreen';
import { DeckShow } from './components/DeckShow';
import { tabsStore, useTabsStore } from './stores/tabs';
import { uiStore, useUiStore } from './stores/ui';
import { goBackPreview, usePreviewNav } from './stores/preview-nav';
import { isAndroid } from './platform';

export function App() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activeMode = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.mode);
  const activeKind = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.kind);
  const activeDeck = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.deck);
  const distractionFree = useUiStore((s) => s.distractionFree);
  const osFullscreen = useUiStore((s) => s.osFullscreen);
  // The deck show covers everything (see below). A presentation is not a
  // knowledge base being browsed, so the workspace pane's ways in stay away.
  const deckShowing = osFullscreen && !!activeDeck && !!activeTabId;

  // Tap-and-hold anywhere while chrome-less opens the escape-hatch menu.
  useFullscreenLongPress(distractionFree);

  useEffect(() => {
    const sync = tabsStore.getState().tabs.find((t) => t.id === activeTabId)?.modeSync;
    if (!sync) {
      return;
    }
    let cancelled = false;
    void sync.whenIdle().then(() => {
      if (cancelled || tabsStore.getState().activeTabId !== activeTabId) {
        return;
      }
      // Never yank focus out of an open text field. Opening a tab is async, so
      // this can resolve after an inline rename input has taken focus (the
      // explorer's "New file" does exactly that) — stealing it there would fire
      // the input's blur-commit and cancel the rename the user never got to type.
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        return;
      }
      sync.focus();
    });
    return () => {
      cancelled = true;
    };
  }, [activeTabId]);

  // A terminal tab is not a document: the ribbon, explorer, outline and status
  // bar all read editor state it does not have, so they are NOT RENDERED (not
  // merely hidden) while one is in front. Their open/closed flags in uiStore
  // are untouched, so switching back to a document restores exactly what was
  // there. The TabBar stays — it is the window titlebar.
  const terminalActive = activeKind === 'terminal';
  // A TOOL tab (the git tab) is not a document either, but it lives beside
  // the workspace it acts on: the explorer and the status bar (notices) stay,
  // and only the document chrome — ribbon and outline — goes.
  const toolActive = activeKind === 'git';

  return (
    <div
      className={distractionFree ? 'app app-fullscreen' : 'app'}
      data-tab-kind={activeKind ?? 'note'}
    >
      <TabBar />
      {!terminalActive && !toolActive && <Ribbon />}
      <div className="editor-area">
        {!terminalActive && <FileExplorer />}
        <div className="editor-stack">
          {tabs.map((tab) =>
            // A tab's kind never changes, so each branch is stable per key and
            // never remounts an editor (I7 holds).
            tab.kind === 'image' && tab.filePath && isAudioPath(tab.filePath) ? (
              <AudioView key={tab.id} tabId={tab.id} active={tab.id === activeTabId} />
            ) : tab.kind === 'image' ? (
              <ImageView key={tab.id} tabId={tab.id} active={tab.id === activeTabId} />
            ) : tab.kind === 'import' ? (
              <ImportView key={tab.id} tabId={tab.id} active={tab.id === activeTabId} />
            ) : tab.kind === 'terminal' ? (
              <TerminalTab key={tab.id} tabId={tab.id} active={tab.id === activeTabId} />
            ) : tab.kind === 'git' ? (
              <GitTab key={tab.id} tabId={tab.id} active={tab.id === activeTabId} />
            ) : (
              <EditorHost key={tab.id} tabId={tab.id} active={tab.id === activeTabId} />
            ),
          )}
        </div>
        {!terminalActive && !toolActive && <OutlinePanel />}
      </div>
      {!terminalActive && <StatusBar />}
      {/* Full screen on a deck is the show: one slide on a dark stage, keys
          to move (ui/components/DeckShow). Escape leaves full screen as in
          every mode, which is the light table on the slide that was showing. */}
      {deckShowing && activeTabId && <DeckShow key={activeTabId} tabId={activeTabId} />}
      <SettingsDialog />
      <ExportPreviewDialog />
      <DiagramViewer />
      <BoardColorMenu />
      <CommandPalette />
      <ExternalLinkPrompt />
      <WhisperSetupPrompt />
      <SearchPanel />
      <NotesOverview />
      <InitWorkspaceDialog />
      {/* Desktop keeps the hover-revealed cluster; Android's way out is the
          tap-and-hold menu (which works on a board too, where the old
          double-tap-the-edge gesture never reached the window). */}
      {distractionFree && !isAndroid() && (
        <FullscreenControls
          osFullscreen={osFullscreen}
          showExplorerToggle={!terminalActive && !deckShowing}
        />
      )}
      {distractionFree && !isAndroid() && !terminalActive && !deckShowing && <WorkspacePull />}
      <FullscreenMenu />
      {/* Distraction-free hides all chrome and leaves the OS window in place, so
          there's no titlebar to grab. A strip over the top of the view doubles as
          the grab-to-move handle in every mode. It fires only on itself, so content
          below stays interactive. In Review mode it's tall (~3 lines of top
          whitespace); in edit modes it's titlebar-height so it doesn't swallow the
          first editor lines. Android has no draggable OS window, and a fullscreen
          window has nowhere to go, so it's desktop-and-windowed only. The git
          tab's header is its own drag region (WorktreeStrip): the strip would
          lie exactly on the worktree cards' top line and take their clicks. */}
      {distractionFree && !osFullscreen && !isAndroid() && !toolActive && (
        <div
          className={`fullscreen-drag-strip${activeMode === 'read' ? ' fullscreen-drag-strip-read' : ''}`}
          data-tauri-drag-region=""
        />
      )}
      {/* Custom resize hitboxes for the undecorated window (macOS keeps native
          decorations; a fullscreen window has nothing to resize). Rendered last
          so the strips layer over all chrome. */}
      {!osFullscreen && !IS_MAC && !isAndroid() && <ResizeBorders />}
    </div>
  );
}

/**
 * The chrome (with the ribbon's distraction-free button) is hidden while
 * distraction-free, so this floating cluster is the DESKTOP way back. It holds
 * the full-screen toggle (⛶ enter / ⤢ leave, the same F11 does), an exit ✕
 * that brings the chrome back, and — when browsing a followed link in the
 * preview — a ← Back that pops the page. Back lives here (not as an in-pane
 * bar) while chrome-less so it hides with the rest.
 *
 * The cluster is tucked just above the top-CENTER edge and slides down when
 * summoned. Nothing spans the full width (that full-width reveal bar read as
 * cheap/janky). Window dragging while chrome-less lives in a separate strip
 * over the top of the view (see App), not here.
 *
 * Reveal is JS-driven (not `:hover`) so the cluster survives the pointer
 * overshooting the top edge: it appears while the pointer is in the top reveal
 * zone and, once the pointer drops below, lingers briefly then hides.
 * `:focus-within` (CSS) also holds it open so it's reachable by keyboard.
 *
 * Android has no cluster at all — the tap-and-hold menu (FullscreenMenu) is its
 * single, mode-independent way out, including on a whiteboard.
 */
function FullscreenControls({
  osFullscreen,
  showExplorerToggle,
}: {
  osFullscreen: boolean;
  showExplorerToggle: boolean;
}) {
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const canGoBack = usePreviewNav(
    (s) => (activeTabId != null && s.canGoBack[activeTabId]) || false,
  );
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const HIDE_MS = 600; // linger before auto-hiding
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    // Local mirror of the reveal state — lets the listener gate on "currently
    // shown" without a render-time ref read (setRevealed is the only writer).
    let shown = false;
    const clearHide = () => {
      if (hideTimer !== undefined) {
        clearTimeout(hideTimer);
        hideTimer = undefined;
      }
    };
    const show = () => {
      clearHide();
      shown = true;
      setRevealed(true);
    };
    const hide = () => {
      clearHide();
      shown = false;
      setRevealed(false);
    };
    const scheduleHide = () => {
      clearHide();
      hideTimer = setTimeout(hide, HIDE_MS);
    };

    // Reveal near the top; once the pointer drops below the zone, a single
    // linger timer hides it (continued movement below doesn't reset it, so it
    // hides promptly instead of clinging while the mouse wanders).
    const REVEAL_Y = 72;
    const onMove = (e: MouseEvent) => {
      if (e.clientY <= REVEAL_Y) {
        show();
      } else if (shown && hideTimer === undefined) {
        scheduleHide();
      }
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      clearHide();
    };
  }, []);

  const buttons = (
    <>
      {/* The workspace pane, so a knowledge base can be browsed without leaving
          the view. The left-edge pull tab (WorkspacePull) opens it too. Not
          on a terminal, and not over a deck show. */}
      {showExplorerToggle && (
        <button
          className="fullscreen-btn"
          aria-label="Toggle file explorer"
          title="Workspaces"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => uiStore.getState().toggleExplorer()}
        >
          <FolderIcon />
        </button>
      )}
      {canGoBack && (
        <button
          className="fullscreen-btn"
          aria-label="Back"
          title="Back"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (activeTabId) {
              goBackPreview(activeTabId);
            }
          }}
        >
          ←
        </button>
      )}
      {/* The OS full-screen toggle, mirroring F11. */}
      {osFullscreen ? (
        <button
          className="fullscreen-btn"
          aria-label="Exit full screen"
          title="Exit full screen (F11)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOsFullscreen(false)}
        >
          ⤢
        </button>
      ) : (
        <button
          className="fullscreen-btn"
          aria-label="Full screen"
          title="Full screen (F11)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOsFullscreen(true)}
        >
          ⛶
        </button>
      )}
      <button
        className="fullscreen-btn"
        aria-label="Exit distraction-free"
        title="Exit distraction-free (Esc)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setDistractionFree(false)}
      >
        ✕
      </button>
    </>
  );

  return <div className={`fullscreen-topcenter${revealed ? ' is-revealed' : ''}`}>{buttons}</div>;
}

/** The ribbon's explorer glyph — a folder reads as "files". */
function FolderIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 20 20"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    >
      <path d="M2.7 15.3V4.7h4.6l1.7 2.2h8.3v8.4z" />
      <path d="M2.7 6.9h14.6" />
    </svg>
  );
}

/**
 * The workspace pane's pull tab while distraction-free (desktop). Going
 * chrome-less still shuts the pane — the document and nothing else — but Review
 * mode there is how a markdown knowledge base gets read, and reading one means
 * moving between files. So the pane stays one gesture away: push the pointer
 * against the LEFT edge and a small tab slides out from where the pane lives;
 * clicking it pulls the pane out. Same JS-driven reveal-and-linger as the top
 * cluster, for the same overshoot reason.
 *
 * Only rendered while the pane is shut. Once it is out, Escape puts it away
 * (ui/fullscreen `escapeFullscreen`), as does the cluster's folder button.
 */
function WorkspacePull() {
  const explorerOpen = useUiStore((s) => s.explorerOpen);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (explorerOpen) {
      return;
    }
    const HIDE_MS = 600;
    const REVEAL_X = 28;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    let shown = false;
    const clearHide = () => {
      if (hideTimer !== undefined) {
        clearTimeout(hideTimer);
        hideTimer = undefined;
      }
    };
    const onMove = (e: MouseEvent) => {
      if (e.clientX <= REVEAL_X) {
        clearHide();
        shown = true;
        setRevealed(true);
      } else if (shown && hideTimer === undefined) {
        hideTimer = setTimeout(() => {
          hideTimer = undefined;
          shown = false;
          setRevealed(false);
        }, HIDE_MS);
      }
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      clearHide();
      setRevealed(false);
    };
  }, [explorerOpen]);

  if (explorerOpen) {
    return null;
  }
  return (
    <button
      className={`fullscreen-btn fullscreen-pull${revealed ? ' is-revealed' : ''}`}
      aria-label="Open file explorer"
      title="Workspaces"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => uiStore.getState().openExplorer()}
    >
      <FolderIcon />
    </button>
  );
}
