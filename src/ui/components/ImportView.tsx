/**
 * ImportView — the card behind an `import` tab (DOCX; a PDF's import tab shows
 * the PDF itself instead — PdfView, with the import in its toolbar). Fills the editor
 * stack like an EditorHost/ImageView does, but renders a small centered card
 * offering a one-click conversion to Markdown instead of mounting any editor.
 *
 * No confirm dialog: clicking an importable document in the explorer opens this
 * card, and the conversion is a button here. If the document has already been
 * imported (a note of the same basename sits beside it), the card links to that
 * note instead of offering the conversion again — the status is re-checked
 * whenever the tab becomes active or an import completes.
 */

import { memo, useCallback, useEffect, useState } from 'react';
import { baseName, dirName, extName } from '../../core/session/plan-flush';
import { converterFor } from '../../core/import/registry';
import { checkImportStatus, importDocumentInto, openNotePath } from '../session';
import { useTabsStore } from '../stores/tabs';

function ImportViewImpl({ tabId, active }: { tabId: string; active: boolean }) {
  const filePath = useTabsStore((s) => s.tabs.find((t) => t.id === tabId)?.filePath ?? null);
  // The async "already imported?" result, keyed by the path it was checked for
  // (a stale path renders as "checking", like ImageView's loaded-image guard).
  const [checked, setChecked] = useState<{
    path: string;
    imported: boolean;
    mdPath: string;
  } | null>(null);
  const [importing, setImporting] = useState(false);
  // Bumped after an import completes so the effect re-checks and the card flips
  // to its "already imported" state without needing a tab switch.
  const [refresh, setRefresh] = useState(0);

  const conv = filePath ? converterFor(extName(filePath)) : null;
  const available = conv !== null && conv.available !== false;
  const ext = filePath ? extName(filePath).replace(/^\./, '').toUpperCase() : '';

  useEffect(() => {
    if (!filePath || !available) {
      return;
    }
    let cancelled = false;
    void checkImportStatus(filePath).then(({ mdPath, imported }) => {
      if (!cancelled) {
        setChecked({ path: filePath, imported, mdPath });
      }
    });
    return () => {
      cancelled = true;
    };
    // `active` and `refresh` re-check: returning to the card (or finishing an
    // import) re-stats so a note imported meanwhile is reflected. `filePath`
    // covers a rename; `available` is derived from it.
  }, [filePath, available, active, refresh]);

  const onImport = useCallback(
    async (allowDuplicate = false) => {
      if (!filePath || !conv) {
        return;
      }
      setImporting(true);
      try {
        // Imports beside the source and opens the resulting note (which steals
        // focus); this card stays open behind it, showing the link on return.
        // `allowDuplicate` bypasses the same-name skip, writing a suffixed note.
        await importDocumentInto(dirName(filePath), filePath, { allowDuplicate });
      } finally {
        setImporting(false);
        setRefresh((n) => n + 1);
      }
    },
    [filePath, conv],
  );

  const name = filePath ? baseName(filePath) : '';
  const status = checked !== null && checked.path === filePath ? checked : null;

  return (
    <div className="editor-host import-host" style={{ display: active ? 'flex' : 'none' }}>
      <div className="import-view" tabIndex={0}>
        <div className="import-card">
          <div className="import-card-head">
            {ext && <span className="import-card-badge">{ext}</span>}
            <span className="import-card-name" title={filePath ?? undefined}>
              {name}
            </span>
          </div>
          {!available ? (
            <p className="import-card-note">
              {conv ? `${conv.label} import isn’t available yet.` : 'This file can’t be imported.'}
            </p>
          ) : status === null ? (
            <p className="import-card-note">Checking…</p>
          ) : status.imported ? (
            <>
              {/* Name-based match only — a same-named note exists, but it may be
                  an unrelated file, so don't claim this document was imported. */}
              <p className="import-card-note">
                A note named {baseName(status.mdPath)} already exists.
              </p>
              <button className="import-card-btn" onClick={() => openNotePath(status.mdPath)}>
                Open {baseName(status.mdPath)}
              </button>
              <button
                className="import-card-btn"
                onClick={() => void onImport(true)}
                disabled={importing}
              >
                {importing ? 'Importing…' : 'Import anyway'}
              </button>
            </>
          ) : (
            <>
              <p className="import-card-note">
                This {conv.label} can be converted to a Markdown note. Formatting is approximated
                (best-effort).
              </p>
              <button
                className="import-card-btn"
                onClick={() => void onImport()}
                disabled={importing}
              >
                {importing ? 'Importing…' : 'Import as Markdown'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export const ImportView = memo(ImportViewImpl);
