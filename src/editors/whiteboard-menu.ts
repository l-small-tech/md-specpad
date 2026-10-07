/**
 * The board's right-click menu — plain DOM, styled like every other menu in
 * the app (`.tab-menu` rows with a shortcut column, as the terminal pane's).
 *
 * Split out of `whiteboard.ts` for the same reason the layers panel is: this
 * is markup and dismissal wiring and nothing else. It decides nothing — the
 * adapter hands it a list of items already marked enabled or disabled from
 * the pure predicates in `core/whiteboard/{arrange,groups}.ts`, and each item
 * calls back into the adapter. That list is the extension point: the connector
 * items (route, Detach) were added by pushing onto it.
 *
 * Dismissal follows the ribbon popovers: a press anywhere outside, Escape, the
 * window resizing or losing focus. The stage keeps its own contextmenu event
 * cancelled, which is what tells the app-wide guard (`ui/context-menu-guard`)
 * that this surface owns the right-click.
 */

export type ContextMenuItem =
  | {
      readonly label: string;
      /** The keyboard shortcut, shown right-aligned. */
      readonly chord?: string;
      readonly disabled?: boolean;
      /** A radio-style item that is the current choice (a tick in front). */
      readonly checked?: boolean;
      readonly onSelect: () => void;
    }
  | 'separator';

export interface ContextMenu {
  close(): void;
}

/** Keep the menu on screen: flip left/up when it would run off the edge. */
function place(menu: HTMLElement, x: number, y: number): void {
  const { innerWidth, innerHeight } = window;
  const rect = menu.getBoundingClientRect();
  const left = x + rect.width > innerWidth - 4 ? Math.max(4, x - rect.width) : x;
  const top = y + rect.height > innerHeight - 4 ? Math.max(4, y - rect.height) : y;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

export function openContextMenu(
  items: readonly ContextMenuItem[],
  x: number,
  y: number,
  onClose?: () => void,
  /** The menu's accessible name. */
  ariaLabel = 'Board',
): ContextMenu {
  const menu = document.createElement('div');
  menu.className = 'tab-menu wb-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', ariaLabel);
  // Presses inside the menu must not reach the window listener that closes it.
  menu.addEventListener('pointerdown', (event) => event.stopPropagation());
  menu.addEventListener('contextmenu', (event) => event.preventDefault());

  let closed = false;
  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    window.removeEventListener('pointerdown', close);
    window.removeEventListener('resize', close);
    window.removeEventListener('blur', close);
    window.removeEventListener('keydown', onKey, true);
    menu.remove();
    onClose?.();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };

  for (const item of items) {
    if (item === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'tab-menu-sep';
      menu.append(sep);
      continue;
    }
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'tab-menu-item';
    row.setAttribute('role', 'menuitem');
    row.disabled = item.disabled === true;
    if (item.checked !== undefined) {
      row.setAttribute('role', 'menuitemradio');
      row.setAttribute('aria-checked', String(item.checked));
    }
    const label = document.createElement('span');
    label.textContent = item.checked ? `✓ ${item.label}` : item.label;
    row.append(label);
    if (item.chord) {
      const chord = document.createElement('span');
      chord.className = 'tab-menu-chord';
      chord.textContent = item.chord;
      row.append(chord);
    }
    row.addEventListener('click', () => {
      close();
      item.onSelect();
    });
    menu.append(row);
  }

  document.body.append(menu);
  place(menu, x, y);
  // Deferred so the pointerdown that opened the menu cannot also close it.
  requestAnimationFrame(() => {
    if (!closed) {
      window.addEventListener('pointerdown', close);
      window.addEventListener('resize', close);
      window.addEventListener('blur', close);
      window.addEventListener('keydown', onKey, true);
    }
  });
  return { close };
}
