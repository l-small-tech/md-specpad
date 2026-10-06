/**
 * The FileExplorer's right-click menus, unified into one component. Two
 * variants, selected by which props are given:
 * - `entry` — a file row's menu (Rename / Reveal in explorer / Delete);
 * - `dir` — a directory or workspace-root menu (see DirMenuProps).
 * Both carry the clipboard group (Cut / Copy / Paste, backed by
 * `stores/explorer.ts`) and **Copy path**; a file pastes into its own folder,
 * exactly as VSCode does.
 * Session-level actions (delete, import, workspace color/remove) are imported
 * directly — same module dispatch the container used; only the callbacks that
 * touch the container's state arrive as props (new file/folder among them, so
 * the created row can jump straight into an inline rename).
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { placeMenu, type MenuPlacement } from '../../../core/menu-position';
import { baseName, dirName } from '../../../core/session/plan-flush';
import { harnessName } from '../../../core/settings';
import { isMarkdownPath } from '../../../core/text-files';
import { HARNESS_PROFILE_ID, WORKSPACE_COLORS, type WorkspaceColor } from '../../../core/types';
import { isAndroid } from '../../platform';
import { openTerminal } from '../../terminal-open';
import { openGitTab } from '../../git-open';
import { useSettingsStore } from '../../stores/settings';
import { harnessInstalled, useHarnessAvailability } from '../../stores/harness-availability';
import {
  deleteExplorerEntry,
  deleteExplorerFolder,
  createDeckIn,
  createWhiteboardIn,
  importDocumentInto,
  openExportPreviewForFile,
  openFileInNewWindow,
  pasteExplorerEntryInto,
  removeWorkspace,
  setWorkspaceColor,
  setWorkspaceLiveEdit,
  toggleShowAllFilesFor,
  toggleShowHiddenFiles,
  type ExplorerEntry,
} from '../../session';
import { explorerStore, useExplorerStore } from '../../stores/explorer';
import { uiStore } from '../../stores/ui';
import { setActiveWorkspace } from '../../active-workspace';
import { openWorkspaceInit } from '../../workspace-init';
import { scanImageInto } from '../../scan-image';
import { scanWhiteboardInto } from '../../scan-photo';

interface CommonProps {
  /** Close the menu (clears the container's `menuFor`). */
  onClose: () => void;
  /** Start the inline rename on the row for this path. */
  onRename: (path: string) => void;
}

/** File-row menu: rename / reveal / open in new window / copy path / delete. */
interface FileMenuProps extends CommonProps {
  entry: ExplorerEntry;
}

/**
 * The right-click menu for a directory: a "New" drill-in page (file, folder,
 * drawing, plus terminal / Harness sessions started in THIS dir on desktop);
 * "Set active" at workspace level (a plain header click no longer selects);
 * "Rename" + "Delete folder" for subfolders (`renameTarget` given); the
 * workspace color swatches only at workspace level (`wsColor` given = a
 * workspace); a "Remove workspace" item for removable workspaces
 * (`removableWs`). Workspace roots are neither renamable nor deletable here —
 * their path anchors settings, so removal goes through "Remove workspace".
 */
interface DirMenuProps extends CommonProps {
  dir: string;
  wsColor?: WorkspaceColor | null;
  /**
   * Live Edit flag of an ADDED workspace (given = the toggle is offered; the
   * default notes dir and read-only/synced workspaces leave it undefined).
   */
  wsLiveEdit?: boolean;
  /**
   * "Show unsupported files" state of this dir (core/text-files
   * showAllFilesState); undefined = not offered (read-only workspace).
   */
  showAll?: { show: boolean; explicit: boolean };
  renameTarget?: ExplorerEntry;
  removableWs?: boolean;
  readOnly?: boolean;
  /** Create a file in `dir` and jump into renaming it (container's startNewFile). */
  onNewFile: (dir: string) => Promise<void>;
  /** Create a subfolder in `dir` and jump into renaming it (container's startNewFolder). */
  onNewFolder: (dir: string) => Promise<void>;
  /** Select `dir` as the paste destination (container's setSelectedDir). */
  onSelectDir: (dir: string) => void;
}

export type ExplorerContextMenuProps = FileMenuProps | DirMenuProps;

export function ExplorerContextMenu(props: ExplorerContextMenuProps) {
  const { onClose, onRename } = props;
  /** Which page of the directory menu is showing (see the New/Import rows below). */
  const [page, setPage] = useState<'root' | 'new' | 'import'>('root');
  const aiName = useSettingsStore((s) => harnessName(s.settings));
  const showHidden = useSettingsStore((s) => s.settings.showHiddenFiles);
  const clipboard = useExplorerStore((s) => s.clipboard);
  const harnessReady = useHarnessAvailability(harnessInstalled);
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** Viewport-fixed placement, measured after the menu renders (null = first pass). */
  const [pos, setPos] = useState<MenuPlacement | null>(null);

  /**
   * Keep the whole menu on screen: a row near the bottom of the drawer used to
   * push the menu's tail below the viewport (and out of the scrolling tree),
   * so measure the row and the menu and hand the geometry to placeMenu. The
   * anchor is the row wrapper the menu renders into; the menu itself is out of
   * flow once fixed, so it doesn't inflate that rect. Re-runs per page — the
   * drill-in pages are different heights.
   */
  useLayoutEffect(() => {
    const el = menuRef.current;
    const anchor = el?.parentElement;
    if (!el || !anchor) {
      return;
    }
    const rect = anchor.getBoundingClientRect();
    // scrollHeight (+ borders) is the CONTENT height — offsetHeight would be
    // the capped one once a previous pass applied a maxHeight.
    const height = Math.max(el.offsetHeight, el.scrollHeight + 2);
    setPos(
      placeMenu(
        rect,
        { width: el.offsetWidth, height },
        {
          width: window.innerWidth,
          height: window.innerHeight,
        },
      ),
    );
  }, [page]);

  /** Overlay + popover shared by every context menu in the drawer. */
  function menuShell(children: ReactNode): ReactNode {
    return (
      <>
        {/* Click-away layer under the menu. */}
        <div className="context-menu-overlay" onClick={onClose} />
        <div
          ref={menuRef}
          className="context-menu"
          role="menu"
          style={
            pos
              ? { position: 'fixed', top: pos.top, left: pos.left, maxHeight: pos.maxHeight }
              : undefined
          }
        >
          {children}
        </div>
      </>
    );
  }

  /** "Rename" menu item — starts the inline rename on `entry`'s row. */
  function renderRenameItem(entry: ExplorerEntry): ReactNode {
    return (
      <button
        className="context-menu-item"
        role="menuitem"
        onClick={() => {
          onClose();
          onRename(entry.path);
        }}
      >
        Rename
      </button>
    );
  }

  /**
   * "Reveal in explorer" menu item — shows the file in the OS file manager.
   * Desktop, real-filesystem paths only: Android has no file manager to target
   * and `saf://` ids aren't OS paths, so those rows just omit the item.
   */
  function renderRevealItem(entry: ExplorerEntry): ReactNode {
    if (isAndroid() || entry.path.startsWith('saf://')) {
      return null;
    }
    return (
      <button
        className="context-menu-item"
        role="menuitem"
        onClick={() => {
          onClose();
          void revealItemInDir(entry.path).catch(() => {});
        }}
      >
        Reveal in explorer
      </button>
    );
  }

  /** "Delete" menu item — removes a file (the controller confirms first). */
  function renderDeleteItem(entry: ExplorerEntry): ReactNode {
    return (
      <button
        className="context-menu-item is-danger"
        role="menuitem"
        onClick={() => {
          onClose();
          void deleteExplorerEntry(entry.path);
        }}
      >
        Delete
      </button>
    );
  }

  /**
   * The Cut / Copy pair for a row. `cuttable` is false for a workspace root:
   * its path anchors the settings entry, so it is removed, never moved (the
   * same reason it has no Rename).
   */
  function renderClipboardItems(
    row: { path: string; name: string; isDir: boolean },
    cuttable: boolean,
  ): ReactNode {
    return (
      <>
        {cuttable && (
          <button
            className="context-menu-item"
            role="menuitem"
            onClick={() => {
              onClose();
              explorerStore.getState().put(row, 'cut');
            }}
          >
            Cut
          </button>
        )}
        <button
          className="context-menu-item"
          role="menuitem"
          onClick={() => {
            onClose();
            explorerStore.getState().put(row, 'copy');
          }}
        >
          Copy
        </button>
      </>
    );
  }

  /** "Paste" — only when something is on the explorer clipboard. `destDir` is
   *  the folder itself for a directory row, the parent folder for a file. */
  function renderPasteItem(destDir: string): ReactNode {
    if (!clipboard) {
      return null;
    }
    return (
      <button
        className="context-menu-item"
        role="menuitem"
        title={`${clipboard.mode === 'cut' ? 'Move' : 'Copy'} "${clipboard.name}" here`}
        onClick={() => {
          onClose();
          void pasteExplorerEntryInto(clipboard, destDir);
        }}
      >
        Paste
      </button>
    );
  }

  /** "Copy path" — the absolute path of a file, folder or workspace root. */
  function renderCopyPathItem(path: string): ReactNode {
    return (
      <button className="context-menu-item" role="menuitem" onClick={() => copyToClipboard(path)}>
        Copy path
      </button>
    );
  }

  /** Copy `text` to the clipboard, confirming (or failing) via a notice. */
  function copyToClipboard(text: string): void {
    onClose();
    void navigator.clipboard
      .writeText(text)
      .then(() => uiStore.getState().showNotice('Path copied.'))
      .catch(() => uiStore.getState().showNotice('Could not access the clipboard.'));
  }

  if ('entry' in props) {
    return menuShell(
      <>
        {renderRenameItem(props.entry)}
        {renderRevealItem(props.entry)}
        {/* Multi-window is desktop-only (Android has a single activity). */}
        {!isAndroid() && (
          <button
            className="context-menu-item"
            role="menuitem"
            onClick={() => {
              onClose();
              openFileInNewWindow(props.entry.path);
            }}
          >
            Open in new window
          </button>
        )}
        {renderClipboardItems(
          { path: props.entry.path, name: props.entry.name, isDir: false },
          true,
        )}
        {renderPasteItem(dirName(props.entry.path))}
        {renderCopyPathItem(props.entry.path)}
        {/* Export works on markdown only — other rows (.txt, images) omit it.
            Opens the preview dialog (format + theme picked there); the file
            need not be open — an open tab's live text wins over disk. */}
        {isMarkdownPath(props.entry.name) && (
          <button
            className="context-menu-item"
            role="menuitem"
            onClick={() => {
              onClose();
              openExportPreviewForFile(props.entry.path);
            }}
          >
            Export…
          </button>
        )}
        {renderDeleteItem(props.entry)}
      </>,
    );
  }

  const {
    dir,
    wsColor,
    wsLiveEdit,
    showAll,
    renameTarget,
    removableWs,
    readOnly,
    onNewFile,
    onNewFolder,
    onSelectDir,
  } = props;

  // Terminals need a real path to spawn in: no pty on Android, and synced
  // (SAF) workspaces are opaque document ids, not directories.
  const canTerminal = !isAndroid() && !dir.startsWith('saf://');

  if (page === 'new') {
    return menuShell(
      <>
        <button
          className="context-menu-item context-menu-nav"
          role="menuitem"
          onClick={() => setPage('root')}
        >
          <span className="context-menu-more">‹</span>
          <span>Back</span>
        </button>
        {!readOnly && (
          <button
            className="context-menu-item"
            role="menuitem"
            onClick={() => {
              onClose();
              void onNewFile(dir);
            }}
          >
            Markdown File
          </button>
        )}
        {!readOnly && (
          <button
            className="context-menu-item"
            role="menuitem"
            onClick={() => {
              onClose();
              void onNewFolder(dir);
            }}
          >
            Folder
          </button>
        )}
        {!readOnly && (
          <button
            className="context-menu-item"
            role="menuitem"
            onClick={() => {
              onClose();
              onSelectDir(dir);
              void createWhiteboardIn(dir);
            }}
          >
            Vector drawing
          </button>
        )}
        {/* The example deck (core/deck-template): a `marp: true` markdown file
            whose slides explain themselves, opened at once so the first thing
            the user sees is slides, not a blank note. */}
        {!readOnly && (
          <button
            className="context-menu-item"
            role="menuitem"
            onClick={() => {
              onClose();
              onSelectDir(dir);
              void createDeckIn(dir);
            }}
          >
            Marp presentation
          </button>
        )}
        {/* Sessions start HERE — the dir that was right-clicked — not in the
            active workspace: an explicit cwd wins over workspaceCwd() in
            openTerminal. The harness row wears the configured harness's name,
            same as the new-tab picker — and, with none installed, opens the
            Harness settings instead of spawning a missing command. */}
        {canTerminal && (
          <button
            className="context-menu-item"
            role="menuitem"
            title={
              harnessReady
                ? 'Harness — switch the harness in Settings'
                : 'No harness installed — open Settings to install one'
            }
            onClick={() => {
              onClose();
              if (harnessReady) {
                openTerminal(HARNESS_PROFILE_ID, dir);
              } else {
                uiStore.getState().openSettings('harness');
              }
            }}
          >
            {harnessReady ? `${aiName} session` : 'Harness session'}
          </button>
        )}
        {canTerminal && (
          <button
            className="context-menu-item"
            role="menuitem"
            onClick={() => {
              onClose();
              openTerminal(undefined, dir);
            }}
          >
            Terminal
          </button>
        )}
      </>,
    );
  }

  if (page === 'import') {
    return menuShell(
      <>
        <button
          className="context-menu-item context-menu-nav"
          role="menuitem"
          onClick={() => setPage('root')}
        >
          <span className="context-menu-more">‹</span>
          <span>Back</span>
        </button>
        <button
          className="context-menu-item"
          role="menuitem"
          onClick={() => {
            onClose();
            onSelectDir(dir);
            void importDocumentInto(dir);
          }}
        >
          Document…
        </button>
        {/* Creates the drawing first, then opens its scan screen: a scan has
            to land somewhere, and "a new drawing in this folder" is the answer
            that needs no further questions. Scanning INTO an existing drawing
            is the ribbon's camera button. */}
        <button
          className="context-menu-item"
          role="menuitem"
          onClick={() => {
            onClose();
            onSelectDir(dir);
            void scanWhiteboardInto(dir);
          }}
        >
          Scan whiteboard as drawing…
        </button>
        {/* The same scan screen with one less step: nothing is traced — the
            cleaned board is saved as a PNG file here instead of landing in a
            drawing. */}
        <button
          className="context-menu-item"
          role="menuitem"
          onClick={() => {
            onClose();
            onSelectDir(dir);
            void scanImageInto(dir);
          }}
        >
          Scan whiteboard as image…
        </button>
      </>,
    );
  }

  return menuShell(
    <>
      {/* Workspace level only (`wsColor` given): making a workspace active is
          an explicit action — this item — a plain click only
          collapses/expands (double-click was removed: too easy to hit by
          accident). Offered even read-only: the active dir also seeds new
          terminal tabs' cwd. Like the theme picker, clicking applies to every
          window; right-clicking keeps it to this one (desktop only — Android
          is a single webview with no right-click). */}
      {wsColor !== undefined && (
        <button
          className="context-menu-item"
          role="menuitem"
          title={isAndroid() ? undefined : 'Set for all windows (right-click: this window only)'}
          onClick={() => {
            onClose();
            setActiveWorkspace(dir);
          }}
          onContextMenu={
            isAndroid()
              ? undefined
              : (e) => {
                  e.preventDefault();
                  onClose();
                  setActiveWorkspace(dir, { thisWindowOnly: true });
                }
          }
        >
          Set active
        </button>
      )}
      {/* Re-run Initialize Workspace here: add or remove AGENTS.md directives.
          Desktop only, local folders only (the writes are plain fs). */}
      {wsColor !== undefined && !isAndroid() && !dir.startsWith('saf://') && (
        <button
          className="context-menu-item"
          role="menuitem"
          title="Choose the instructions AI agents get in this folder (AGENTS.md)"
          onClick={() => {
            onClose();
            void openWorkspaceInit(dir);
          }}
        >
          Workspace directives…
        </button>
      )}
      {/* The git tab for the repository this workspace is in (or a notice when
          it is not in one). Same gate as the directives row: desktop, local. */}
      {wsColor !== undefined && !isAndroid() && !dir.startsWith('saf://') && (
        <button
          className="context-menu-item"
          role="menuitem"
          title="Source control: status, commits, branches and worktrees for this repository"
          onClick={() => {
            onClose();
            void openGitTab(dir);
          }}
        >
          Git
        </button>
      )}
      {/* Live Edit: a shared Drive/OneDrive folder. Files opened from it save
          as you type and merge what others save, live (core/live-edit.ts). A
          checkable row — the glyph column shows the state. */}
      {wsLiveEdit !== undefined && (
        <button
          className="context-menu-item"
          role="menuitemcheckbox"
          aria-checked={wsLiveEdit}
          title="Shared folder: files save as you type and merge changes other people save, while they are open"
          onClick={() => {
            onClose();
            setWorkspaceLiveEdit(dir, !wsLiveEdit);
            uiStore
              .getState()
              .showNotice(
                wsLiveEdit
                  ? 'Live edit is off for this workspace.'
                  : 'Live edit is on: files here save as you type and merge changes from others.',
              );
          }}
        >
          <span className="context-menu-check" aria-hidden="true">
            {wsLiveEdit ? '✓' : ''}
          </span>
          Live Edit
        </button>
      )}
      {/* List every file here and in subfolders, not just notes/images/docs;
          they open as plain source text. The check shows what this folder
          does, inherited or not; toggling always works — a subfolder can hide
          what its workspace shows — and resets the subfolders below it. */}
      {showAll !== undefined && (
        <button
          className="context-menu-item"
          role="menuitemcheckbox"
          aria-checked={showAll.show}
          title={
            (showAll.explicit
              ? 'Set on this folder'
              : showAll.show
                ? 'Following a parent folder'
                : 'Off') +
            ' — list every file here and in subfolders; other files open as plain text. Changing it resets the subfolders to follow this one.'
          }
          onClick={() => {
            onClose();
            toggleShowAllFilesFor(dir);
          }}
        >
          <span className="context-menu-check" aria-hidden="true">
            {showAll.show ? '✓' : ''}
          </span>
          Unsupported Files
        </button>
      )}
      {/* One global switch (every workspace), unlike the per-folder one above:
          the platform's hidden entries — dot-names, plus the Windows hidden
          attribute / macOS hidden flag. Same as the header's eye button. */}
      <button
        className="context-menu-item"
        role="menuitemcheckbox"
        aria-checked={showHidden}
        title="List hidden files and folders (dot-names, and items the OS marks hidden) in every workspace"
        onClick={() => {
          onClose();
          toggleShowHiddenFiles();
        }}
      >
        <span className="context-menu-check" aria-hidden="true">
          {showHidden ? '✓' : ''}
        </span>
        Hidden Files
      </button>
      {/* Everything created here — files, folders, drawings, terminal and AI
          sessions — lives on one drill-in page (same pattern as Import).
          Shown read-only too when a terminal can spawn: a session in a
          read-only workspace writes nothing. */}
      {(!readOnly || canTerminal) && (
        <button
          className="context-menu-item context-menu-nav"
          role="menuitem"
          aria-haspopup="menu"
          onClick={() => setPage('new')}
        >
          <span>New</span>
          <span className="context-menu-more">›</span>
        </button>
      )}
      {/* A drill-in page, not a hover flyout: Android has no hover, and one
          panel behaves identically under a finger and a mouse. Phase 4's
          "Whiteboard scan…" joins this page, so the shape is already right. */}
      {!readOnly && (
        <button
          className="context-menu-item context-menu-nav"
          role="menuitem"
          aria-haspopup="menu"
          onClick={() => setPage('import')}
        >
          <span>Import</span>
          <span className="context-menu-more">›</span>
        </button>
      )}
      {/* The clipboard group. A workspace root is neither cut nor copied —
          its path anchors the settings entry — but it is a paste destination
          like any other writable folder, and its path is copyable. */}
      {renameTarget !== undefined &&
        renderClipboardItems({ path: dir, name: baseName(dir), isDir: true }, !readOnly)}
      {!readOnly && renderPasteItem(dir)}
      {renderCopyPathItem(dir)}
      {!readOnly && renameTarget !== undefined && renderRenameItem(renameTarget)}
      {/* Delete a subfolder (recursive). Workspace roots omit this — they carry
          "Remove workspace" instead — so it's gated on a rename target. */}
      {!readOnly && renameTarget !== undefined && (
        <button
          className="context-menu-item is-danger"
          role="menuitem"
          onClick={() => {
            onClose();
            void deleteExplorerFolder(dir);
          }}
        >
          Delete folder
        </button>
      )}
      {wsColor !== undefined && (
        <div className="context-menu-swatches" aria-label="Workspace color">
          <button
            className="color-swatch"
            data-color="none"
            data-active={wsColor === null || undefined}
            aria-label="No color"
            title="None"
            onClick={() => {
              setWorkspaceColor(dir, null);
              onClose();
            }}
          />
          {WORKSPACE_COLORS.map((color) => (
            <button
              key={color}
              className="color-swatch"
              data-color={color}
              data-active={wsColor === color || undefined}
              aria-label={color}
              title={color}
              onClick={() => {
                setWorkspaceColor(dir, color);
                onClose();
              }}
            />
          ))}
        </div>
      )}
      {removableWs && (
        <button
          className="context-menu-item is-danger"
          role="menuitem"
          onClick={() => {
            onClose();
            removeWorkspace(dir);
          }}
        >
          Remove workspace
        </button>
      )}
    </>,
  );
}
