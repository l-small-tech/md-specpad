/**
 * DiffWindowView — the whole UI of the diff window (`?diff=1`): one DiffView
 * filling it. It owns no tab and no repository: the window that opened it
 * sends the texts (`diff-content`) and sends them again when the diff it
 * came from changes. See ui/diff-window.ts.
 */

import { useEffect, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { DIFF_CONTENT_EVENT, DIFF_READY_EVENT, type DiffWindowContent } from '../diff-window';
import { DiffView } from './DiffView';

function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return path.slice(cut + 1);
}

export function DiffWindowView() {
  const [content, setContent] = useState<DiffWindowContent | null>(null);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<DiffWindowContent>(DIFF_CONTENT_EVENT, (event) => {
      setContent(event.payload);
    })
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
          // Listening now: ask for the diff (nothing is lost to a slow boot).
          void emit(DIFF_READY_EVENT).catch(() => {});
        }
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const path = content?.path ?? null;
  useEffect(() => {
    const title = path ? `${baseName(path)} — Diff — MD Specpad` : 'Diff — MD Specpad';
    void getCurrentWindow()
      .setTitle(title)
      .catch(() => {});
  }, [path]);

  return (
    <div className="diff-window">
      {content === null ? (
        <div className="diff-window-hint">Waiting for the diff…</div>
      ) : (
        <DiffView
          oldText={content.oldText}
          newText={content.newText}
          oldLabel={content.oldLabel}
          newLabel={content.newLabel}
          path={content.path}
          notice={content.notice}
          onClose={() => void getCurrentWindow().close()}
          closeTitle="Close this window"
        />
      )}
    </div>
  );
}
