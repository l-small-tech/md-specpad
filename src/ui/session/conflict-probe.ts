/**
 * Conflict probe — the one place that decides "did this tab's document change
 * on disk behind our back?". Used by the focus/fs-changed check
 * (checkAllFileConflicts) AND by the flusher's pre-write guard for note tabs,
 * so both paths agree on what a conflict is.
 *
 * mtime alone lies: touch, a sync client rewriting identical bytes, or a
 * wall-clock fallback baseline all move it without changing anything. So an
 * mtime mismatch is only a trigger to READ the file; the banner is raised
 * only when the content differs both from the last persisted snapshot (what
 * we believe we wrote/loaded) and from the current editor text (disk matching
 * the editor means there is nothing to resolve). A benign mtime move quietly
 * adopts the new baseline — WITHOUT requestFlush, so the flusher itself may
 * call this.
 *
 * File tabs compare against the 'file' snapshot (last explicit save/load);
 * note tabs against the 'session' snapshot (last flush write). A note with no
 * baseline yet (never written this session — its file may not even exist) is
 * never flagged: planFlush's existingNoteFiles guard covers foreign files.
 */

import { mirrorKnowsText } from '../doc-sync';
import { tabsStore, type TabEntry } from '../stores/tabs';
import type { SessionCtx } from './context';
import { isTabLive, mergeDiskChange } from './live-merge';

/** The disk path a tab's document lives at, or null when it has none. */
export function tabDocPath(tab: TabEntry): string | null {
  if (tab.kind === 'file') {
    return tab.filePath;
  }
  if (tab.kind === 'note') {
    return tab.notePath;
  }
  return null;
}

/** Is this a tab the conflict check watches at all? */
export function conflictEligible(tab: TabEntry): boolean {
  if (tab.kind === 'file') {
    return tab.filePath !== null;
  }
  return tab.kind === 'note' && tab.notePath !== null && tab.savedMtimeMs !== null;
}

/**
 * Re-check one tab against disk; updates the store (conflict flag, or a
 * quietly adopted baseline) and resolves with whether the tab is conflicted.
 * Transient stat failures resolve with the tab's current flag unchanged.
 */
export async function probeTabConflict(ctx: SessionCtx, id: string): Promise<boolean> {
  const tab = tabsStore.getState().tabs.find((t) => t.id === id);
  if (!tab || !conflictEligible(tab)) {
    return false;
  }
  const path = tabDocPath(tab)!;
  try {
    const stat = await ctx.ipc.statPath(path);
    const mtimeMoved = stat.exists && stat.mtimeMs !== null && stat.mtimeMs !== tab.savedMtimeMs;
    // A Live Edit tab always reads: cloud drives lie about mtime (a FAT-style
    // 2 s granularity on Google Drive's streaming volume, server timestamps
    // on others), and the file is small. Content is the only honest signal.
    const live = tab.kind === 'file' && isTabLive(tab);
    if (!mtimeMoved && !(live && stat.exists)) {
      tabsStore.getState().setConflict(id, false);
      return false;
    }
    let changed = true;
    let baseline = stat.mtimeMs ?? tab.savedMtimeMs ?? ctx.now();
    try {
      const { text, mtimeMs } = await ctx.ipc.readTextFile(path);
      const persisted = tab.model.getPersisted(tab.kind === 'file' ? 'file' : 'session');
      changed = text !== persisted && text !== tab.model.getText();
      baseline = mtimeMs;
      // Tab sync: the file holds a text a MIRROR of this tab (same file, in
      // another tab or window) had moments ago — a mirror saved while typing
      // carried on here. That is our own write, not an external change: take
      // it as the baseline and stay dirty by whatever was typed since.
      if (changed && tab.kind === 'file' && mirrorKnowsText(path, text)) {
        tabsStore.getState().adoptMergedText(id, { diskText: text, mtimeMs });
        return false;
      }
      // Live Edit (shared folder): a change from disk is MERGED into the
      // editor rather than flagged. Disk matching the editor exactly (the
      // other side wrote what we already hold) just makes the tab clean.
      if (live) {
        if (changed && mergeDiskChange(ctx, tab, text, mtimeMs)) {
          return false;
        }
        if (!changed && text !== persisted) {
          tabsStore.getState().markSaved(id, mtimeMs, text);
          return false;
        }
        if (!changed) {
          tabsStore.getState().adoptBaseline(id, mtimeMs);
          return false;
        }
      }
    } catch {
      // Unreadable (e.g. rewritten as non-UTF-8) counts as changed.
    }
    if (changed) {
      tabsStore.getState().setConflict(id, true);
      return true;
    }
    tabsStore.getState().adoptBaseline(id, baseline);
    return false;
  } catch {
    // A transient stat failure is not itself a conflict signal.
    return tab.conflict;
  }
}
