/**
 * WebdriverIO config for the EXPERIMENTAL e2e smoke test (see e2e/specs/).
 *
 * The app is driven through tauri-driver (https://crates.io/crates/tauri-driver),
 * a pre-alpha WebDriver intermediary that launches the compiled Tauri binary
 * and proxies WebDriver commands to the platform's native driver (msedgedriver
 * on Windows, WebKitWebDriver on Linux; macOS is unsupported by tauri-driver).
 *
 * Prerequisites (this config launches tauri-driver itself — `pnpm run e2e` is
 * the only command you need once these exist):
 *   1. A debug build of the app: `pnpm run build`, then `cargo build` in
 *      src-tauri (produces src-tauri/target/debug/md-specpad.exe).
 *   2. tauri-driver: `cargo install tauri-driver --locked`. Found on PATH by
 *      default; override with the TAURI_DRIVER_BIN env var (absolute path).
 *   3. Windows: msedgedriver.exe matching the installed Edge/WebView2 major
 *      version. Set TAURI_NATIVE_DRIVER to its absolute path; if unset,
 *      tauri-driver looks for msedgedriver.exe on PATH.
 *
 * WARNING: the smoke test runs the REAL app, which persists session state
 * (tabs, note files) under the OS appdata dir. Running it locally mutates
 * your actual MD Specpad session. CI runs it on a throwaway runner where
 * that is acceptable.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Debug binary built by `cargo build` in src-tauri. The name comes from the
// Cargo package name (`md-specpad` — src-tauri/Cargo.toml has no [[bin]]
// override). Windows-only for now; a Linux run would drop the .exe suffix.
// TAURI_APP_BIN overrides it for a build that used its own CARGO_TARGET_DIR —
// whisper's Vulkan shader generator needs a short one on Windows (MAX_PATH).
const application =
  process.env.TAURI_APP_BIN ??
  resolve(here, '..', 'src-tauri', 'target', 'debug', 'md-specpad.exe');

// tauri-driver's default listen port. The wdio runner connects here instead
// of to a browser driver; tauri-driver spawns the native driver internally.
const TAURI_DRIVER_HOST = '127.0.0.1';
const TAURI_DRIVER_PORT = 4444;

let tauriDriver: ChildProcess | undefined;

/**
 * Poll a TCP port until something is listening. tauri-driver has no health
 * endpoint we can rely on, but it binds its port immediately on startup, so a
 * successful connect means it is ready to accept the wdio session request.
 */
function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePort, rejectPort) => {
    const attempt = (): void => {
      const socket = createConnection({ host, port }, () => {
        socket.destroy();
        resolvePort();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() > deadline) {
          rejectPort(
            new Error(
              `tauri-driver did not start listening on ${host}:${port} within ${timeoutMs}ms. ` +
                'Is tauri-driver installed (cargo install tauri-driver --locked) and on PATH ' +
                '(or pointed at via TAURI_DRIVER_BIN)?',
            ),
          );
        } else {
          setTimeout(attempt, 250);
        }
      });
    };
    attempt();
  });
}

export const config: WebdriverIO.Config = {
  runner: 'local',

  // Talk to tauri-driver, not a browser grid.
  hostname: TAURI_DRIVER_HOST,
  port: TAURI_DRIVER_PORT,

  // Resolved relative to this config file.
  specs: ['./specs/**/*.e2e.ts'],

  // One app instance at a time — the app uses tauri-plugin-single-instance,
  // and tauri-driver manages exactly one child process per session anyway.
  maxInstances: 1,

  capabilities: [
    // 'tauri:options' is tauri-driver's vendor extension (not in wdio's
    // Capabilities type, hence the cast); 'wry' is the browserName
    // tauri-driver advertises for the embedded webview.
    {
      browserName: 'wry',
      'tauri:options': {
        application,
      },
    } as WebdriverIO.Capabilities,
  ],

  logLevel: 'info',

  // Generous waits: app launch + session restore on a cold CI runner is slow,
  // and this suite is a smoke test, not a latency benchmark.
  waitforTimeout: 15000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 2,

  framework: 'mocha',
  // Sole reporter. Without one, wdio prints only a pass/fail tally — useless
  // for diagnosing a red run from CI logs, which is this job's entire value.
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    // Must cover the deliberate 6.5s persistence wait plus a full app
    // relaunch inside a single test (see smoke.e2e.ts).
    timeout: 120000,
  },

  /**
   * Spawn tauri-driver before the session starts and wait for its port, so
   * `pnpm run e2e` is a single command with no orchestration script around it.
   */
  onPrepare: async (): Promise<void> => {
    if (!existsSync(application)) {
      throw new Error(
        `App binary not found: ${application}\n` +
          'Build it first: `pnpm run build`, then `cargo build` in src-tauri.',
      );
    }

    const driverBin = process.env.TAURI_DRIVER_BIN ?? 'tauri-driver';
    // On Windows tauri-driver needs msedgedriver; --native-driver skips its
    // PATH lookup when CI (or a local run) downloaded the driver elsewhere.
    const nativeDriver = process.env.TAURI_NATIVE_DRIVER;
    const args = nativeDriver ? ['--native-driver', nativeDriver] : [];

    tauriDriver = spawn(driverBin, args, {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    tauriDriver.on('error', (err) => {
      // Don't throw from the event handler (it would be an unhandled
      // exception in a callback) — log it; waitForPort below turns the
      // failure into a clear, actionable error.
      console.error(`Failed to spawn ${driverBin}:`, err);
    });

    await waitForPort(TAURI_DRIVER_HOST, TAURI_DRIVER_PORT, 15000);
  },

  onComplete: (): void => {
    // Kill tauri-driver (it kills its app + native-driver children).
    tauriDriver?.kill();
  },
};

// Belt and braces: if the wdio process dies abnormally (Ctrl+C, crash),
// don't leave an orphaned tauri-driver holding port 4444.
process.on('exit', () => {
  tauriDriver?.kill();
});
