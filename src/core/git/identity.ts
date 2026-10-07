/**
 * The commit identity — the name and email git stamps on every commit. A
 * first commit on a fresh machine fails without them, so the git tab asks
 * for them in the commit box instead of sending the user to a terminal.
 * Pure; no DOM, no Tauri, no React.
 */

/** `user.name` / `user.email` as git resolves them; null = not set. */
export interface CommitIdentity {
  name: string | null;
  email: string | null;
}

/** git cannot commit until both are set. */
export function identityMissing(id: CommitIdentity | null): boolean {
  return id !== null && (id.name === null || id.email === null);
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * What is wrong with the form, in the user's words; null when it can be
 * saved. Mirrors Rust's `safe_arg` (no leading `-`, no control characters)
 * plus a loose email shape — git itself accepts almost anything, so this
 * only catches typos, it does not police addresses.
 */
export function validateIdentity(name: string, email: string): string | null {
  const n = name.trim();
  const e = email.trim();
  if (n === '') {
    return 'Enter your name';
  }
  if (e === '') {
    return 'Enter your email';
  }
  if (n.startsWith('-') || CONTROL.test(n) || /[<>]/.test(n)) {
    return 'That name has characters git cannot store';
  }
  if (e.startsWith('-') || CONTROL.test(e) || !/^[^\s@<>]+@[^\s@<>]+$/.test(e)) {
    return 'That does not look like an email address';
  }
  return null;
}
