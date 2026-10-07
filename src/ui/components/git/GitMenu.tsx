/**
 * GitMenu — a small anchored popover (a branch pill's actions, the status
 * bar's branch picker). Rendered in place, positioned `fixed` from the
 * anchor's rect so it escapes any overflow clipping; a transparent backdrop
 * catches the click that closes it, Escape closes it too. Rendering only:
 * what goes inside is the caller's.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuAnchor {
  x: number;
  y: number;
  /** `up`: open above the anchor (the status bar); `down`: below it. */
  dir: 'up' | 'down';
  /** `end`: right-align the menu's right edge at `x` (the status bar's right side). */
  align?: 'start' | 'end';
}

/** The anchor for a popover opening from `el`'s edge. */
export function anchorFor(el: HTMLElement, dir: 'up' | 'down', align: 'start' | 'end' = 'start') {
  const r = el.getBoundingClientRect();
  return {
    x: align === 'end' ? r.right : r.left,
    y: dir === 'up' ? r.top - 4 : r.bottom + 4,
    dir,
    align,
  } satisfies MenuAnchor;
}

export function GitMenu({
  anchor,
  onClose,
  children,
  className,
  width,
}: {
  anchor: MenuAnchor;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  /** A fixed width (the picker); menus size to content otherwise. */
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.x, top: anchor.y });

  // Keep the menu on screen once its size is known.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchor.align === 'end' ? anchor.x - rect.width : anchor.x;
    let top = anchor.dir === 'up' ? anchor.y - rect.height : anchor.y;
    left = Math.max(4, Math.min(left, vw - rect.width - 4));
    top = Math.max(4, Math.min(top, vh - rect.height - 4));
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <>
      <div
        className="git-menu-backdrop"
        onPointerDown={onClose}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div
        ref={ref}
        className={`git-menu${className ? ` ${className}` : ''}`}
        role="menu"
        style={{ left: pos.left, top: pos.top, width }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </>
  );
}

/** One action line of a menu. */
export function MenuItem({
  children,
  onClick,
  disabled,
  danger,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`git-menu-item${danger ? ' is-danger' : ''}`}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
