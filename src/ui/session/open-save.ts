/**
 * Open + save — the M3 file actions: opening paths as tabs (with the preview /
 * pin dance and the concurrent-open dedupe), the native open/save dialogs,
 * Android external-file copy-in, file-tab rename-on-disk, link insertion, and
 * the conflict check/reload/keep-mine trio behind the ConflictBanner.
 */

import { baseName, dirName, extName, joinPath, relativePath } from '../../core/session/plan-flush';
import { docFamilyFor } from '../../core/doc-family';
import { withErrorDetail } from '../../core/error-text';
import { isAudioPath } from '../../core/audio';
import { isImagePath } from '../../core/images';
import { converterFor } from '../../core/import/registry';
import {
  deriveImportName,
  dropTrailingExtension,
  sanitizeFileBaseName,
  slugifyTitle,
  stripExtension,
} from '../../core/title';
import { getSourceAdapter } from '../editor-registry';
import { ipc as nativeIpc } from '../../ipc/commands';
import { isAndroid } from '../platform';
import { conflictEligible, probeTabConflict, tabDocPath } from './conflict-probe';
import { diffViewStore } from '../stores/diff-view';
import { tabsStore } from '../stores/tabs';
import { uiStore } from '../stores/ui';
import type { SessionCtx } from './context';
import { isReadOnlyPath, pathKey } from './facade';

export function createOpenSave(ctx: SessionCtx, saveFileTab: (id: string) => Promise<boolean>) {
  async function saveActive(): Promise<void> {
    const tab = tabsStore.getState().activeTab();
    if (!tab || tab.kind === 'image' || tab.kind === 'terminal' || tab.kind === 'git') {
      return; // no text document behind this tab
    }
    if (tab.readOnly) {
      uiStore.getState().showNotice('This document is read-only.');
      return;
    }
    if (tab.kind === 'note') {
      // Save on a note tab behaves as Save As.
      await saveAsActive();
      return;
    }
    await saveFileTab(tab.id);
  }

  async function saveAsActive(): Promise<void> {
    const tab = tabsStore.getState().activeTab();
    if (!tab || tab.kind === 'image' || tab.kind === 'terminal' || tab.kind === 'git') {
      return; // an image viewer or terminal has no text to save
    }
    if (tab.readOnly) {
      uiStore.getState().showNotice('This document is read-only.');
      return;
    }
    const suggested =
      tab.kind === 'file' ? (tab.filePath ?? undefined) : `${slugifyTitle(tab.title)}.md`;
    const target = await ctx.saveDialog(suggested);
    if (!target) {
      return; // user cancelled
    }
    try {
      // Record exactly what was written — edits made during the await stay dirty.
      const text = tab.model.getText();
      await ctx.ipc.atomicWriteText(target, text);
      const stat = await ctx.ipc.statPath(target);
      tabsStore.getState().saveToPath(tab.id, {
        filePath: target,
        mtimeMs: stat.mtimeMs ?? ctx.now(),
        savedText: text,
      });
    } catch (error) {
      uiStore.getState().showNotice(`Could not save "${tab.title}".`);
      ctx.deps.onError?.(error);
    }
  }

  /**
   * Open each path as a tab (focusing an existing one). `preview` (explorer
   * single-click) opens a reusable italic preview tab; a non-preview open of an
   * already-preview tab PROMOTES it to permanent (explorer double-click / Ctrl+O).
   */
  async function openPaths(paths: string[], opts: { preview?: boolean } = {}): Promise<void> {
    const preview = opts.preview ?? false;
    for (const path of paths) {
      const lower = pathKey(path);
      // Focus the created/existing tab, and pin it when this open wasn't a
      // preview (or a concurrent pinned request asked for it while it opened).
      const settle = (id: string): void => {
        tabsStore.getState().activateTab(id);
        if (!preview || ctx.pinOnOpen.delete(lower)) {
          tabsStore.getState().promoteTab(id);
        }
      };
      // Already open (as a file OR a note tab) → just focus (and maybe pin) it.
      const existing = ctx.tabOwning(lower);
      if (existing) {
        settle(existing.id);
        continue;
      }
      // A concurrent request is already opening this exact path — a rapid
      // double-click in the file browser fires two opens before the first has
      // created its tab, so the pre-await check above misses. Let the in-flight
      // open win rather than reading the file and creating a second tab; if THIS
      // is the pinning (double-click) open, leave a note so the creator pins it.
      if (ctx.openingPaths.has(lower)) {
        if (!preview) {
          ctx.pinOnOpen.add(lower);
        }
        continue;
      }
      ctx.openingPaths.add(lower);
      try {
        if (converterFor(extName(path))) {
          // A recognized document (PDF/DOCX) can't be edited as text — open a
          // read-only import CARD instead (explorer click, Ctrl+O, editor-area
          // drop). The card offers a one-click conversion (no dialog) or, once
          // imported, a link to the resulting note. Existence is checked up
          // front so a bad path errors here rather than inside the view.
          const stat = await ctx.ipc.statPath(path);
          if (!stat.exists) {
            throw new Error(`not found: ${path}`);
          }
          const owner = ctx.tabOwning(lower);
          if (owner) {
            settle(owner.id);
          } else {
            settle(
              tabsStore.getState().openImportTab({
                filePath: path,
                savedMtimeMs: stat.mtimeMs,
                preview,
                readOnly: isReadOnlyPath(path),
              }),
            );
          }
          continue;
        }
        // An .svg is BOTH an image type and an editable document. In a writable
        // workspace it opens as a whiteboard (a normal file tab whose text is
        // the SVG source, in draw mode — openFileTab picks that from the path);
        // in a read-only workspace it stays the image viewer it always was.
        const isWhiteboard = docFamilyFor(path) === 'svg' && !isReadOnlyPath(path);
        if ((isImagePath(path) && !isWhiteboard) || isAudioPath(path)) {
          // Images and audio open as a read-only viewer tab (the view is picked
          // by extension, core/audio.ts); existence check up front so
          // a bad path errors here (like a failed read) instead of in the view.
          const stat = await ctx.ipc.statPath(path);
          if (!stat.exists) {
            throw new Error(`not found: ${path}`);
          }
          const owner = ctx.tabOwning(lower);
          if (owner) {
            settle(owner.id);
          } else {
            settle(
              tabsStore.getState().openImageTab({
                filePath: path,
                savedMtimeMs: stat.mtimeMs,
                preview,
                readOnly: isReadOnlyPath(path),
              }),
            );
          }
          continue;
        }
        const { text, mtimeMs } = await ctx.ipc.readTextFile(path);
        // Re-check after the await: a tab for this path may have appeared while
        // we were reading (e.g. a note tab the flusher just assigned a path).
        const now = ctx.tabOwning(lower);
        if (now) {
          settle(now.id);
        } else {
          settle(
            tabsStore.getState().openFileTab({
              filePath: path,
              text,
              savedMtimeMs: mtimeMs,
              preview,
              readOnly: isReadOnlyPath(path),
            }),
          );
        }
      } catch (error) {
        // INVALID_DATA from read_text_file = binary / not UTF-8. Listed because
        // unsupported files are shown; say why it won't open rather than "could not".
        const notText = (error as { code?: unknown } | null)?.code === 'INVALID_DATA';
        uiStore
          .getState()
          .showNotice(
            notText
              ? `"${baseName(path)}" isn't a text file, so it can't be opened here.`
              : `Could not open "${baseName(path)}".`,
          );
        ctx.deps.onError?.(error);
      } finally {
        ctx.openingPaths.delete(lower);
        ctx.pinOnOpen.delete(lower);
      }
    }
  }

  async function openFileDialog(): Promise<void> {
    const selected = await ctx.openDialog();
    if (!selected || selected.length === 0) {
      return;
    }
    // On Android the picker hands back content:// URIs that std::fs can't read;
    // copy them into the notes dir and open the local copies instead.
    if (isAndroid()) {
      await copyInExternal(selected);
    } else {
      await openPaths(selected);
    }
  }

  /**
   * Android: copy external file(s) — content:// URIs from the picker or an
   * "Open with" intent — INTO the notes dir, then open the local copies. std::fs
   * can't read a content URI, so we read the bytes once via the androidfs plugin
   * (`readContentUri`, a native bridge, not a storage op — hence the direct ipc
   * call) and write a note. Edits then save to the app copy, not the original.
   */
  async function copyInExternal(uris: string[]): Promise<void> {
    const targets: string[] = [];
    let failed = 0;
    for (const uri of uris) {
      try {
        const { base64, displayName } = await nativeIpc.readContentUri(uri);
        const { base, ext } = deriveImportName(displayName);
        if (converterFor(ext)) {
          // A convertible document (e.g. a PDF opened/shared from Drive) —
          // import it as markdown instead of copying the raw bytes in.
          await ctx.importDocumentBytes(ctx.notesDir, base64, `${base}${ext}`);
          continue;
        }
        const target = await ctx.uniquePathIn(ctx.notesDir, base, ext);
        await ctx.ipc.writeFileBase64(target, base64);
        targets.push(target);
      } catch (error) {
        failed += 1;
        ctx.deps.onError?.(error);
      }
    }
    if (targets.length > 0) {
      await openPaths(targets);
    }
    if (failed > 0) {
      uiStore.getState().showNotice(`Could not open ${failed} file(s).`);
    }
  }

  /**
   * Rename a FILE tab's file on disk, preserving its extension and the user's
   * casing/spacing. Guards against clobbering an existing file; content and
   * dirty state are untouched (the bytes moved, they weren't saved).
   */
  async function renameFileTab(id: string, newName: string): Promise<void> {
    const tab = tabsStore.getState().tabs.find((t) => t.id === id);
    if (
      !tab ||
      (tab.kind !== 'file' && tab.kind !== 'image' && tab.kind !== 'import') ||
      !tab.filePath
    ) {
      return;
    }
    if (tab.readOnly || isReadOnlyPath(tab.filePath)) {
      uiStore.getState().showNotice('This document is read-only.');
      return;
    }
    const oldPath = tab.filePath;
    const ext = extName(oldPath);
    // If the user typed the extension too ("notes.md"), don't double it.
    const safeBase = sanitizeFileBaseName(dropTrailingExtension(newName.trim(), ext));
    if (!safeBase) {
      uiStore.getState().showNotice('That name can’t be used for a file.');
      return;
    }
    const newPath = joinPath(dirName(oldPath), `${safeBase}${ext}`);
    // Basenames, not pathKey: the directory is unchanged by construction, and
    // pathKey lowercases — a case-only rename ("Notes.md") is a real rename.
    // (Raw paths can't be compared either: joinPath uses "/" while an open
    // tab's path may carry Windows "\" separators.)
    if (baseName(newPath) === baseName(oldPath)) {
      return; // nothing changed
    }
    // A case-only target "exists" on Windows/macOS because it IS this file —
    // the collision guard must skip it (rename_path draws the same line).
    const caseOnly = pathKey(newPath) === pathKey(oldPath);
    try {
      const existing = caseOnly ? { exists: false } : await ctx.ipc.statPath(newPath);
      if (existing.exists) {
        uiStore.getState().showNotice(`A file named "${safeBase}${ext}" already exists.`);
        return;
      }
    } catch {
      // A transient stat failure must not block the rename; renamePath below
      // will surface a real problem.
    }
    try {
      await ctx.ipc.renamePath(oldPath, newPath);
      let mtimeMs = tab.savedMtimeMs ?? ctx.now();
      try {
        const after = await ctx.ipc.statPath(newPath);
        mtimeMs = after.mtimeMs ?? mtimeMs;
      } catch {
        // Keep the prior baseline; the next save re-stats anyway.
      }
      tabsStore.getState().retargetFilePath(id, { filePath: newPath, mtimeMs });
    } catch (error) {
      uiStore.getState().showNotice(withErrorDetail(`Could not rename "${tab.title}"`, error));
      ctx.deps.onError?.(error);
    }
  }

  /**
   * Browse for a file/image and insert a markdown reference to it at the caret
   * of the active tab's source editor. Inserts an absolute path by default;
   * `absolute: false` (Alt-click) prefers a path relative to the current
   * document, falling back to absolute when the document is unsaved or the
   * target lives on another drive/root.
   */
  async function insertLinkFromDialog({
    image,
    absolute,
  }: {
    image: boolean;
    absolute: boolean;
  }): Promise<void> {
    const tab = tabsStore.getState().activeTab();
    if (!tab) {
      return;
    }
    if (tab.mode === 'wysiwyg') {
      uiStore.getState().showNotice('Link controls work in Markdown and Split modes.');
      return;
    }
    const adapter = getSourceAdapter(tab.id);
    if (!adapter) {
      return;
    }
    const picked = await ctx.pickFile(image ? 'image' : 'any');
    if (!picked) {
      return; // cancelled
    }
    const docPath = tab.filePath ?? tab.notePath;
    let url: string | null = null;
    if (!absolute && docPath) {
      url = relativePath(dirName(docPath), picked);
      if (url === null) {
        uiStore.getState().showNotice('No relative path to that location — used an absolute path.');
      }
    }
    if (url === null) {
      // Absolute (requested, unsaved doc, or cross-root): forward-slash it so
      // the markdown destination is uniform and valid on every OS.
      url = picked.replace(/\\/g, '/');
    }
    adapter.insertLinkTo(stripExtension(baseName(picked)), url, image);
  }

  async function checkConflict(id: string): Promise<void> {
    // A flush may be mid-write (its baselines not yet recorded); probing
    // during that window would misread our own write as an external change.
    await ctx.flushInFlight;
    await probeTabConflict(ctx, id);
  }

  /** Every open file AND note tab (window focus, restore, fs-changed). */
  async function checkAllFileConflicts(): Promise<void> {
    await ctx.flushInFlight;
    const ids = tabsStore
      .getState()
      .tabs.filter((t) => conflictEligible(t))
      .map((t) => t.id);
    await Promise.all(ids.map((id) => probeTabConflict(ctx, id)));
  }

  async function reloadFromDisk(id: string): Promise<void> {
    const tab = tabsStore.getState().tabs.find((t) => t.id === id);
    const path = tab ? tabDocPath(tab) : null;
    if (!tab || !path) {
      return;
    }
    try {
      const { text, mtimeMs } = await ctx.ipc.readTextFile(path);
      tab.model.pushText(text, 'file-load');
      tabsStore.getState().markSaved(id, mtimeMs, text);
      diffViewStore.getState().close(id);
    } catch (error) {
      uiStore.getState().showNotice(`Could not reload "${tab.title}".`);
      ctx.deps.onError?.(error);
    }
  }

  /** ConflictBanner "View diff": read the on-disk text and open the inline
   *  DiffView (disk ↔ editor) for the tab. */
  async function viewDiff(id: string): Promise<void> {
    const tab = tabsStore.getState().tabs.find((t) => t.id === id);
    const path = tab ? tabDocPath(tab) : null;
    if (!tab || !path) {
      return;
    }
    try {
      const { text } = await ctx.ipc.readTextFile(path);
      diffViewStore.getState().open(id, text);
    } catch (error) {
      uiStore.getState().showNotice(`Could not read "${tab.title}" from disk.`);
      ctx.deps.onError?.(error);
    }
  }

  async function keepMine(id: string): Promise<void> {
    const tab = tabsStore.getState().tabs.find((t) => t.id === id);
    const path = tab ? tabDocPath(tab) : null;
    if (!tab || !path) {
      return;
    }
    let mtimeMs = tab.savedMtimeMs ?? ctx.now();
    try {
      const stat = await ctx.ipc.statPath(path);
      mtimeMs = stat.mtimeMs ?? mtimeMs;
    } catch {
      // Keep the previous baseline; the next save will re-stat anyway.
    }
    tabsStore.getState().acknowledgeConflict(id, mtimeMs);
    diffViewStore.getState().close(id);
  }

  return {
    saveActive,
    saveAsActive,
    openPaths,
    openFileDialog,
    copyInExternal,
    renameFileTab,
    insertLinkFromDialog,
    checkConflict,
    checkAllFileConflicts,
    reloadFromDisk,
    keepMine,
    viewDiff,
  };
}
