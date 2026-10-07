/**
 * Import + images — drag-drop copy-in, foreign-document (PDF/DOCX) conversion
 * to markdown, and image placement: pasted/dropped images land in the
 * settings-driven images location and come back as ready-to-insert markdown
 * references.
 */

import { baseName, dirName, extName, joinPath } from '../../core/session/plan-flush';
import { isAudioPath } from '../../core/audio';
import { isImagePath } from '../../core/images';
import { isEditableTextPath } from '../../core/text-files';
import { imageTargetDir } from '../../core/image-insert';
import { converterFor, replaceImagePlaceholders } from '../../core/import/registry';
import { deriveImportName, sanitizeFileBaseName, stripExtension } from '../../core/title';
import { ipc as nativeIpc } from '../../ipc/commands';
import { settingsStore } from '../stores/settings';
import { tabsStore } from '../stores/tabs';
import { uiStore } from '../stores/ui';
import type { SessionCtx } from './context';
import { pathKey, type ImageRef, type PastedFile } from './facade';

export function createImportImages(
  ctx: SessionCtx,
  openPaths: (paths: string[], opts?: { preview?: boolean }) => Promise<void>,
) {
  /**
   * Drag-drop import: COPY (never move) each markdown/image file into `dir`,
   * suffixing collisions. Other file types are skipped, mirroring what the
   * explorer lists. One summary notice at the end.
   */
  async function importFiles(dir: string, paths: string[]): Promise<void> {
    if (ctx.refuseReadOnly(dir)) {
      return;
    }
    let copied = 0;
    let skipped = 0;
    let failed = 0;
    let converted = 0;
    for (const path of paths) {
      const ext = extName(path);
      if (!isEditableTextPath(path) && !isImagePath(path) && !isAudioPath(path)) {
        if (converterFor(ext)) {
          // A convertible document (e.g. a PDF) — import it as markdown.
          await importDocument(dir, path);
          converted += 1;
        } else {
          skipped += 1;
        }
        continue;
      }
      if (pathKey(dirName(path)) === pathKey(dir)) {
        continue; // already exactly there; a copy would only make "x-2.md"
      }
      try {
        const target = await ctx.uniquePathIn(dir, stripExtension(baseName(path)), ext);
        await ctx.ipc.copyPath(path, target);
        copied += 1;
      } catch (error) {
        failed += 1;
        ctx.deps.onError?.(error);
      }
    }
    const parts: string[] = [];
    if (copied > 0) {
      parts.push(`Added ${copied} file(s)`);
    }
    if (skipped > 0) {
      parts.push(`skipped ${skipped} unsupported`);
    }
    if (failed > 0) {
      parts.push(`${failed} failed`);
    }
    if (parts.length > 0) {
      uiStore.getState().showNotice(`${parts.join(', ')}.`);
    }
    if (copied > 0 || converted > 0) {
      uiStore.getState().refreshExplorer();
    }
  }

  /**
   * The .md path {@link importDocument} would write for `srcPath`: same folder,
   * the source's basename sanitized (`report.pdf` → `report.md`). Mirrors the
   * skip-check in {@link importDocumentBytes} so "already imported?" and the
   * import itself agree on the target name.
   */
  function importedMdPathFor(srcPath: string): string {
    const base = sanitizeFileBaseName(stripExtension(baseName(srcPath))) || 'imported';
    return joinPath(dirName(srcPath), `${base}.md`);
  }

  /**
   * ImportView → controller: has `srcPath` already been imported? Returns the
   * expected note path and whether it exists on disk, so the card can show a
   * link to the note instead of the import button. A stat failure reads as
   * "not imported" (the card then offers the import).
   */
  async function importStatusFor(srcPath: string): Promise<{ mdPath: string; imported: boolean }> {
    // A content:// URI's tail is an opaque document id, not a filename (the real
    // name comes from the picker's displayName at import time), so a name-based
    // "already exists" check off it is meaningless — report "not imported" and
    // let the card just offer the import rather than show misleading info.
    if (/^content:\/\//i.test(srcPath)) {
      return { mdPath: '', imported: false };
    }
    const mdPath = importedMdPathFor(srcPath);
    try {
      return { mdPath, imported: (await ctx.ipc.statPath(mdPath)).exists };
    } catch {
      return { mdPath, imported: false };
    }
  }

  /**
   * Import a foreign document (registry.ts converter, e.g. PDF) into `dir` as
   * a new markdown file: read the source bytes, convert (lossy, best effort),
   * save any extracted images through the standard image placement, write the
   * .md, and open it. Without `srcPath` the user picks the file via a native
   * dialog filtered to importable formats.
   */
  async function importDocument(
    dir: string,
    srcPath?: string,
    options: { allowDuplicate?: boolean } = {},
  ): Promise<void> {
    if (ctx.refuseReadOnly(dir)) {
      return;
    }
    const src = srcPath ?? (await ctx.pickFile('import'));
    if (!src) {
      return;
    }
    // An Android picker hands back a content:// URI whose tail is an opaque
    // document id (no extension) — the real filename and bytes come from the
    // androidfs native bridge, like copyInExternal. Local paths read directly.
    let name: string;
    let bytes: string;
    try {
      if (/^content:\/\//i.test(src)) {
        const { base64, displayName } = await nativeIpc.readContentUri(src);
        const derived = deriveImportName(displayName);
        name = `${derived.base}${derived.ext}`;
        bytes = base64;
      } else {
        name = baseName(src);
        bytes = await ctx.ipc.readFileBase64(src);
      }
    } catch (error) {
      uiStore.getState().showNotice(`Could not read "${baseName(src)}".`);
      ctx.deps.onError?.(error);
      return;
    }
    await importDocumentBytes(dir, bytes, name, options);
  }

  /**
   * Convert already-read document bytes into a new .md in `dir` and open it.
   * With `allowDuplicate`, the same-name skip is bypassed and the note is
   * written to a non-colliding suffixed path (e.g. `report-2.md`) — the
   * "Import anyway" override for when the existing note is unrelated.
   */
  async function importDocumentBytes(
    dir: string,
    bytes: string,
    name: string,
    options: { allowDuplicate?: boolean } = {},
  ): Promise<void> {
    const conv = converterFor(extName(name));
    if (!conv) {
      uiStore.getState().showNotice(`No importer for "${name}".`);
      return;
    }
    if (conv.available === false) {
      // Recognized (drop/share of e.g. a DOCX) but its converter isn't built.
      uiStore.getState().showNotice(`${conv.label} import isn't available yet.`);
      return;
    }
    const base = sanitizeFileBaseName(stripExtension(name)) || 'imported';
    // Skip if a note with this basename already exists — re-importing the same
    // document (e.g. report.pdf when report.md is already here) would otherwise
    // create a suffixed duplicate (report-2.md). Convert only after this check.
    // The check is name-based (no provenance link), so the caller can override
    // it via `allowDuplicate` when the existing note is a different document.
    const mdPath = joinPath(dir, `${base}.md`);
    if (!options.allowDuplicate) {
      try {
        if ((await ctx.ipc.statPath(mdPath)).exists) {
          uiStore
            .getState()
            .showNotice(`"${baseName(mdPath)}" already exists — skipped importing "${name}".`);
          return;
        }
      } catch {
        // Can't stat → fall through and let the import proceed as usual.
      }
    }
    uiStore.getState().showNotice(`Importing "${name}"…`);
    try {
      const result = await conv.convert(bytes, name);
      if (!result.markdown.trim()) {
        // Empty conversion (e.g. a PDF with no extractable text or images, like
        // docx's empty '' result) — surface a notice instead of writing a blank
        // note reported as a successful import.
        uiStore.getState().showNotice(`No text or images could be extracted from "${name}".`);
        return;
      }
      const target = await ctx.uniquePathIn(dir, base, '.md');
      // Save extracted images via the standard placement (settings-driven
      // location) and swap their placeholders for real markdown links.
      const links: (string | null)[] = [];
      for (const image of result.images) {
        const ref = await placeImage(target, image);
        links.push(ref ? `![${ref.alt}](${markdownDest(ref.src)})` : null);
      }
      const markdown = replaceImagePlaceholders(result.markdown, links);
      await ctx.ipc.atomicWriteText(target, markdown);
      uiStore.getState().refreshExplorer();
      await openPaths([target]);
      const dropped = links.filter((l) => l === null).length;
      uiStore
        .getState()
        .showNotice(
          `Imported "${name}" → "${baseName(target)}".` +
            (dropped > 0 ? ` (${dropped} image(s) could not be saved.)` : ''),
        );
    } catch (error) {
      uiStore.getState().showNotice(`Could not import "${name}".`);
      ctx.deps.onError?.(error);
    }
  }

  /** The directory a `mdPath`'s images go in, per the user's image settings. */
  function imagesDirFor(mdPath: string): string {
    const mdDir = mdPath ? dirName(mdPath) : ctx.notesDir;
    const { imagePasteLocation, imageFolderName } = settingsStore.getState().settings;
    return imageTargetDir({
      mdDir,
      workspaceRoot: ctx.workspaceRootFor(mdPath || mdDir),
      location: imagePasteLocation,
      // Sanitize so a hand-edited setting can't escape the folder or add separators.
      folderName: sanitizeFileBaseName(imageFolderName),
      join: joinPath,
    });
  }

  /** A markdown destination — angle-wrapped when it contains whitespace, the
   *  same convention the editor's link insertion uses (cm6.ts). */
  function markdownDest(src: string): string {
    return /\s/.test(src) ? `<${src}>` : src;
  }

  /** `pasted-YYYYMMDD-HHMMSS` from the injected clock; the fallback image name. */
  function timestampBase(): string {
    const stamp = new Date(ctx.now());
    const pad = (n: number) => String(n).padStart(2, '0');
    return (
      `pasted-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}` +
      `-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`
    );
  }

  /**
   * Save/relocate one image for `mdPath` and return how to reference it (alt +
   * an absolute forward-slashed path — absolute refs are the app default so
   * agent CLIs can resolve them from anywhere). `source` is either an existing
   * file to place (drag) or raw bytes to write (paste). Returns null on failure.
   *
   * A dragged file that ALREADY lives in the markdown file's workspace is left
   * exactly where it is and referenced in place — only images coming from
   * outside that workspace (or already in the target images dir) are copied
   * into the configured images location. Pasted bytes always go there.
   */
  async function placeImage(
    mdPath: string,
    source: { copyFrom: string } | { base64: string; ext: string; name: string | null },
  ): Promise<ImageRef | null> {
    const mdDir = mdPath ? dirName(mdPath) : ctx.notesDir;
    const targetDir = imagesDirFor(mdPath);
    try {
      let savedPath: string;
      if ('copyFrom' in source) {
        const from = source.copyFrom;
        const sameWorkspace =
          pathKey(ctx.workspaceRootFor(from)) === pathKey(ctx.workspaceRootFor(mdPath || mdDir));
        if (sameWorkspace || pathKey(dirName(from)) === pathKey(targetDir)) {
          // In the same workspace (or already in the images dir) — reference it
          // where it lives, don't duplicate it into the images folder.
          savedPath = from;
        } else {
          savedPath = await ctx.uniquePathIn(
            targetDir,
            stripExtension(baseName(from)),
            extName(from),
          );
          await ctx.ipc.copyPath(from, savedPath);
        }
      } else {
        const base = (source.name ? sanitizeFileBaseName(source.name) : '') || timestampBase();
        savedPath = await ctx.uniquePathIn(targetDir, base, source.ext);
        await ctx.ipc.writeFileBase64(savedPath, source.base64);
      }
      const src = savedPath.replace(/\\/g, '/');
      return { alt: stripExtension(baseName(savedPath)), src };
    } catch (error) {
      ctx.deps.onError?.(error);
      return null;
    }
  }

  /**
   * Drag-drop onto an md file row: embed the dropped image(s) at the END of that
   * markdown file, after a confirmation prompt. Each image is saved into the
   * configured images location (referenced in place if already there). When a
   * tab already owns the file the append goes through its live model — so the
   * user sees it immediately and the flusher/live-save persists it — rather than
   * writing under the open editor and provoking a conflict.
   */
  async function appendImagesToMarkdown(mdPath: string, paths: string[]): Promise<void> {
    if (ctx.refuseReadOnly(mdPath)) {
      return;
    }
    const images = paths.filter((p) => isImagePath(p));
    if (images.length === 0) {
      return;
    }
    const ok = await ctx.confirm(
      images.length === 1
        ? `Insert this image into "${baseName(mdPath)}"?`
        : `Insert ${images.length} images into "${baseName(mdPath)}"?`,
      'Insert image',
    );
    if (!ok) {
      return;
    }
    const refs: string[] = [];
    let failed = 0;
    for (const img of images) {
      const ref = await placeImage(mdPath, { copyFrom: img });
      if (ref) {
        refs.push(`![${ref.alt}](${markdownDest(ref.src)})`);
      } else {
        failed += 1;
      }
    }
    if (refs.length === 0) {
      uiStore.getState().showNotice('Could not add the image(s).');
      return;
    }
    const block = refs.join('\n\n');
    const appended = (text: string): string =>
      text.trim().length === 0 ? `${block}\n` : `${text.replace(/\s*$/, '')}\n\n${block}\n`;

    const owner = ctx.tabOwning(pathKey(mdPath));
    if (owner && owner.kind !== 'image') {
      owner.model.pushText(appended(owner.model.getText()), 'programmatic');
      ctx.flusher.request();
    } else {
      let existing = '';
      try {
        existing = (await ctx.ipc.readTextFile(mdPath)).text;
      } catch {
        // Unreadable/missing — start fresh; atomicWriteText recreates the file.
      }
      try {
        await ctx.ipc.atomicWriteText(mdPath, appended(existing));
      } catch (error) {
        uiStore.getState().showNotice(`Could not update "${baseName(mdPath)}".`);
        ctx.deps.onError?.(error);
        return;
      }
    }
    uiStore.getState().refreshExplorer();
    const suffix = failed > 0 ? ` (${failed} failed)` : '';
    uiStore
      .getState()
      .showNotice(`Added ${refs.length} image(s) to "${baseName(mdPath)}"${suffix}.`);
  }

  /**
   * Editor paste: save one clipboard image into the configured images location
   * for `tabId`'s document and return its reference for the editor to insert at
   * the caret. Note tabs with no file yet resolve against the notes dir.
   */
  async function savePastedImage(
    tabId: string,
    file: { base64: string; ext: string; name: string | null },
  ): Promise<ImageRef | null> {
    const tab = tabsStore.getState().tabs.find((t) => t.id === tabId);
    if (!tab || tab.kind === 'image') {
      return null;
    }
    const ref = await placeImage(tab.notePath ?? tab.filePath ?? '', file);
    if (ref) {
      uiStore.getState().refreshExplorer();
    } else {
      uiStore.getState().showNotice('Could not save the pasted image.');
    }
    return ref;
  }

  /** Clipboard paste: write one file's bytes into `dir` under a safe name. */
  async function savePastedFile(dir: string, file: PastedFile): Promise<void> {
    if (ctx.refuseReadOnly(dir)) {
      return;
    }
    const base = (file.name !== null ? sanitizeFileBaseName(file.name) : '') || timestampBase();
    try {
      const target = await ctx.uniquePathIn(dir, base, file.ext);
      await ctx.ipc.writeFileBase64(target, file.base64);
      uiStore.getState().showNotice(`Saved "${baseName(target)}".`);
      uiStore.getState().refreshExplorer();
    } catch (error) {
      uiStore.getState().showNotice('Could not save the pasted image.');
      ctx.deps.onError?.(error);
    }
  }

  return {
    importFiles,
    importStatusFor,
    importDocument,
    importDocumentBytes,
    appendImagesToMarkdown,
    savePastedImage,
    savePastedFile,
  };
}
