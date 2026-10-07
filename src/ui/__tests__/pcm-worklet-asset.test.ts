/**
 * The offline-dictation audio worklet must load from a SAME-ORIGIN file in
 * the built app. The release CSP (src-tauri/tauri.conf.json) has no
 * `script-src`, so worklet modules fall back to `default-src 'self'` — and
 * Tauri, when it adds nonces, writes `script-src 'self' 'nonce-…'`. Neither
 * allows `blob:` or `data:`, so a Blob-URL or inlined worklet makes
 * `audioWorklet.addModule` reject in installed builds only (`tauri dev`
 * applies no CSP). This builds pcm-capture.ts with Vite and checks the
 * output, because Vite's asset inlining is exactly what would regress it.
 */
import { join } from 'node:path';
import { build, type Rollup } from 'vite';
import { describe, expect, test } from 'vitest';

const UI = join(__dirname, '..');

describe('pcm-capture — the worklet ships as a same-origin asset', () => {
  test('the build emits the worklet file and loads it by URL, never blob:/data:', async () => {
    const result = (await build({
      configFile: false,
      logLevel: 'silent',
      root: UI,
      build: {
        write: false,
        minify: false,
        // The app's own default; a small file under it would be inlined as a
        // data: URL unless the import opts out.
        assetsInlineLimit: 4096,
        // Keep the module's exports: an app build drops an entry's exports,
        // which would tree-shake pcm-capture.ts down to nothing.
        rollupOptions: { input: join(UI, 'pcm-capture.ts'), preserveEntrySignatures: 'strict' },
      },
    })) as Rollup.RollupOutput | Rollup.RollupOutput[];
    const output = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output);

    const worklet = output.find(
      (o): o is Rollup.OutputAsset =>
        o.type === 'asset' && /pcm-tap\.worklet.*\.js$/.test(o.fileName),
    );
    expect(worklet, 'worklet asset emitted').toBeDefined();
    expect(String(worklet!.source)).toContain("registerProcessor('pcm-tap'");

    const code = output
      .filter((o): o is Rollup.OutputChunk => o.type === 'chunk')
      .map((c) => c.code)
      .join('\n');
    expect(code).toContain(worklet!.fileName);
    expect(code).not.toContain('createObjectURL');
    expect(code).not.toMatch(/data:(text|application)\/javascript/);
  }, 60_000);
});
