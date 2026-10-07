/**
 * The heading right-click menu both text editors share (Raw/Split's CM6 and
 * Edit mode's Milkdown): Mark running / Mark complete / Clear mark, with the
 * current choice ticked. Decides nothing — the caller reads the heading's
 * mark (`core/heading-mark.ts`) and applies the one picked.
 *
 * Where the items go depends on the platform. The spell checker's
 * suggestions live only in the webview's native menu (no web API exposes
 * them), so cancelling it to show our own would hide them on a misspelled
 * heading word:
 *
 * - Windows: the native menu opens as usual and the items join it.
 *   `src-tauri/src/native_menu.rs` reads them from `window.__mdSpecpadNativeMenu`
 *   while the menu is being built and calls `select(id)` on a pick.
 * - elsewhere: the app's own DOM menu replaces the native one (no native
 *   hook yet), as before.
 */

import { HEADING_MARKS, HEADING_MARK_LABELS, type HeadingMark } from '../core/heading-mark';
import { isWindows } from '../ui/platform';
import { openContextMenu, type ContextMenuItem } from './whiteboard-menu';

/** One item for the native menu (the shape native_menu.rs deserializes). */
export interface NativeMenuItem {
  id?: string;
  label?: string;
  checked?: boolean;
  enabled?: boolean;
  separator?: boolean;
}

/** What a right-click hands the native menu; null between right-clicks. */
interface NativeMenuStash {
  items: NativeMenuItem[];
  select: (id: string) => void;
}

declare global {
  interface Window {
    __mdSpecpadNativeMenu?: NativeMenuStash | null;
  }
}

const CLEAR_ID = 'clear';

// Every right-click starts with an empty stash (capture phase: before any
// editor's own handler), so a heading's items never leak into the menu of a
// later right-click somewhere else.
if (typeof document !== 'undefined') {
  document.addEventListener(
    'contextmenu',
    () => {
      window.__mdSpecpadNativeMenu = null;
    },
    true,
  );
}

/** The heading items as native-menu entries (pure; exported for tests). */
export function headingMarkNativeItems(current: HeadingMark | null): NativeMenuItem[] {
  return [
    ...HEADING_MARKS.map((mark) => ({
      id: mark,
      label: `Mark ${HEADING_MARK_LABELS[mark].toLowerCase()}`,
      checked: current === mark,
    })),
    { separator: true },
    { id: CLEAR_ID, label: 'Clear mark', enabled: current !== null },
  ];
}

/**
 * Offer the mark menu for a heading right-click. Call from the editor's
 * `contextmenu` handler; this decides whether the native menu is cancelled.
 * Returns true when it took the right-click over (the app's own menu), false
 * when the native menu must still open — return that from the handler as is:
 * CM6 calls `preventDefault()` on any handler that returns true.
 */
export function openHeadingMarkMenu(
  current: HeadingMark | null,
  event: MouseEvent,
  apply: (mark: HeadingMark | null) => void,
): boolean {
  if (isWindows()) {
    window.__mdSpecpadNativeMenu = {
      items: headingMarkNativeItems(current),
      select: (id) => {
        window.__mdSpecpadNativeMenu = null;
        const mark = HEADING_MARKS.find((m) => m === id);
        if (mark || id === CLEAR_ID) {
          apply(mark ?? null);
        }
      },
    };
    return false;
  }
  event.preventDefault();
  const items: ContextMenuItem[] = [
    ...HEADING_MARKS.map((mark) => ({
      label: `Mark ${HEADING_MARK_LABELS[mark].toLowerCase()}`,
      checked: current === mark,
      onSelect: () => apply(mark),
    })),
    'separator',
    { label: 'Clear mark', disabled: current === null, onSelect: () => apply(null) },
  ];
  openContextMenu(items, event.clientX, event.clientY, undefined, 'Heading');
  return true;
}

/** The class list a marked heading carries in either editor. */
export function headingMarkClass(mark: HeadingMark): string {
  return `heading-mark heading-mark-${mark}`;
}
