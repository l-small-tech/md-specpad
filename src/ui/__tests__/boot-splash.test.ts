import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { restoreStatusText } from '../boot-splash';

describe('restoreStatusText', () => {
  test('nothing outstanding is the generic restore line', () => {
    expect(restoreStatusText([])).toBe('Restoring your tabs…');
  });

  test('one file is named', () => {
    expect(restoreStatusText(['notes.md'])).toBe('Waiting for notes.md…');
  });

  test('several files name the first and count the rest', () => {
    expect(restoreStatusText(['a.md', 'b.md', 'c.md'])).toBe('Waiting for a.md and 2 more…');
  });
});

describe('index.html', () => {
  // Tauri stamps a nonce on every inline <style> in index.html at build time
  // and adds it to the CSP's style-src. Once a nonce is present the browser
  // ignores 'unsafe-inline', so every stylesheet the app injects at runtime
  // (CodeMirror's theme, the theme plugins, ProseMirror's) is blocked — in the
  // installed release only, never under `tauri dev`, where no CSP applies.
  // v0.10.2 shipped exactly that (the boot splash's inline styles): no editor
  // padding, no highlighting, no scrolling, default colours. Splash styles
  // live in src/styles/boot-splash.css, linked from the head, for this reason.
  test('carries no inline <style> (Tauri would nonce it into the CSP)', () => {
    const html = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8').replace(
      /<!--[\s\S]*?-->/g,
      '',
    );
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html).toMatch(/<link rel="stylesheet" href="\/src\/styles\/boot-splash\.css" \/>/);
  });
});
