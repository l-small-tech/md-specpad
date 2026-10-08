/// <reference types="vitest/config" />
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
// Single source of truth for the version shown in Settings (releasing keeps
// package.json, tauri.conf.json and Cargo.toml in agreement — README §Releasing).
import { version } from './package.json';

// `tauri android dev` (and iOS) exports TAURI_DEV_HOST with the LAN IP the
// device must reach the dev server on; desktop `tauri dev` never sets it. We
// use its presence to distinguish the two so BOTH can run at once:
//   - desktop  → localhost:1420 (default HMR on the same port)
//   - mobile   → bind the LAN host on 1430, HMR websocket on 1431
// The matching devUrl ports live in tauri.conf.json (desktop, 1420) and
// tauri.android.conf.json (mobile, 1430). Different ports = no collision when
// tauri:dev and android:dev run side by side.
const host = process.env.TAURI_DEV_HOST;

/**
 * pdf.js fetches some data files at run time rather than importing them: the
 * standard fonts, the CMaps, the ICC profile and the image-decoder wasm
 * (`core/import/pdfjs.ts` names the URLs). This serves them under `/pdfjs/`
 * straight from node_modules in dev and copies them into dist on build. Only
 * what the viewer and importer use: no licence files and no QuickJS (that is
 * pdf.js's form-scripting sandbox, and scripts never run here).
 */
function pdfjsResources(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const wanted: Record<string, (name: string) => boolean> = {
    cmaps: (name) => name.endsWith('.bcmap'),
    standard_fonts: (name) => /\.(pfb|ttf)$/.test(name),
    // The decoders' JS fallbacks too: pdf.js `import()`s them when wasm cannot
    // compile, which a CSP without 'wasm-unsafe-eval' can cause. (The release
    // CSP doesn't reach the worker on Windows — it is a header on the page
    // only — but the WebKit and Android webviews are not verified.)
    wasm: (name) =>
      !name.startsWith('quickjs') &&
      (name.endsWith('.wasm') || name.endsWith('_nowasm_fallback.js')),
    iccs: (name) => name.endsWith('.icc'),
  };
  const files = (): { url: string; path: string }[] =>
    Object.entries(wanted).flatMap(([dir, keep]) =>
      readdirSync(join(root, dir))
        .filter(keep)
        .map((name) => ({ url: `pdfjs/${dir}/${name}`, path: join(root, dir, name) })),
    );
  return {
    name: 'pdfjs-resources',
    configureServer(server) {
      const byUrl = new Map(files().map((f) => [`/${f.url}`, f.path]));
      server.middlewares.use((req, res, next) => {
        const path = byUrl.get((req.url ?? '').split('?')[0] ?? '');
        if (!path) {
          next();
          return;
        }
        res.setHeader(
          'Content-Type',
          path.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream',
        );
        res.end(readFileSync(path));
      });
    },
    generateBundle() {
      for (const f of files()) {
        this.emitFile({ type: 'asset', fileName: f.url, source: readFileSync(f.path) });
      }
    },
  };
}
const port = host ? 1430 : 1420;

export default defineConfig({
  plugins: [react(), pdfjsResources()],

  define: {
    __APP_VERSION__: JSON.stringify(version),
  },

  // Tauri-recommended dev-server settings: fixed port, no screen clearing
  // (Tauri CLI output shares the terminal), ignore src-tauri for HMR.
  clearScreen: false,
  server: {
    // Desktop pins 127.0.0.1 rather than the default localhost: Node binds
    // whichever loopback family the resolver lists first (observed ::1-only
    // on Fedora), and a webview that resolves localhost to the other family
    // gets "connection refused" — seen once from a torn-off window on Linux.
    // A literal address on both sides (devUrl in tauri.conf.json matches)
    // takes name resolution out of the path entirely.
    host: host || '127.0.0.1',
    port,
    strictPort: true,
    hmr: host ? { protocol: 'ws', host, port: port + 1 } : undefined,
    watch: {
      // src-tauri: Rust, not the frontend — cargo watches it. worktrees/: a
      // sibling agent's checkout is a whole second copy of this app, and
      // watching it means their `pnpm install` reloads OUR dev window (and
      // floods the terminal) for changes that aren't ours.
      ignored: ['**/src-tauri/**', '**/worktrees/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],

  build: {
    // Windows uses WebView2 (Chromium), macOS/Linux use WebKit.
    target: ['es2022', 'chrome105', 'safari15'],
    sourcemap: false,
  },

  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
