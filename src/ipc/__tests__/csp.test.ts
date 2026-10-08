import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/** The release CSP from tauri.conf.json, as a directive → sources map. */
function releaseCsp(): Map<string, string[]> {
  const conf = JSON.parse(
    readFileSync(resolve(__dirname, '../../../src-tauri/tauri.conf.json'), 'utf8'),
  ) as { app: { security: { csp: string } } };
  const directives = new Map<string, string[]>();
  for (const part of conf.app.security.csp.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name, sources);
  }
  return directives;
}

describe('release CSP', () => {
  // Tauri's invoke() POSTs to the IPC custom protocol (http://ipc.localhost on
  // Windows/Android, ipc://localhost elsewhere). Without a connect-src that
  // allows it, default-src 'self' blocks the fetch and Tauri quietly falls
  // back to its slower postMessage path, which hurts big payloads such as
  // the raw audio whisper_transcribe sends. Only the installed release
  // shows this: `tauri dev` applies no CSP.
  test('connect-src allows the IPC protocol', () => {
    const connect = releaseCsp().get('connect-src');
    expect(connect).toBeDefined();
    expect(connect).toEqual(expect.arrayContaining(['ipc:', 'http://ipc.localhost']));
  });

  test("connect-src keeps 'self', which it would otherwise inherit from default-src", () => {
    expect(releaseCsp().get('connect-src')).toContain("'self'");
  });
});
