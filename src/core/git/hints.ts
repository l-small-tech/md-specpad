/**
 * Failure text — git's stderr and the IPC error codes turned into one line
 * the user can act on. Pure; no DOM, no Tauri, no React.
 *
 * This is where "the app never types into a terminal" bites: a fetch that
 * needs credentials fails fast (`GIT_TERMINAL_PROMPT=0`) and the ONLY thing
 * the panel does about it is show a sentence naming the fix. `networkHint`
 * is a first-match table over stderr; add a row, add a test.
 *
 * Errors are matched structurally (`{ code: string }` on an `Error`) because
 * core imports nothing from `ipc/` — the shape is `IpcError`'s.
 */

/** An error that carries an IPC code (`IpcError`'s shape). */
export function errorCode(err: unknown): string | null {
  if (err instanceof Error) {
    const code: unknown = (err as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return null;
}

/** The Review header's hint for a git failure (moved here from `ui/code-review-git.ts`). */
export function gitHint(err: unknown): string {
  switch (errorCode(err)) {
    case 'GIT_NOT_FOUND':
      return 'Git not found';
    case 'GIT_NOT_A_REPO':
      return 'Not a git repository';
    case 'GIT_UNTRUSTED':
      return 'Git does not trust this folder';
    case 'GIT_TIMEOUT':
      return 'Git timed out';
    default:
      return 'Git unavailable';
  }
}

const NETWORK_HINTS: readonly [RegExp, string][] = [
  [
    /terminal prompts disabled|could not read Username|could not read Password|No credential helper|Authentication failed|Invalid username or (?:password|token)|HTTP Basic: Access denied/i,
    'Git could not ask for credentials — this app never prompts in a terminal. Configure a credential helper (`git config --global credential.helper manager` on Windows, `osxkeychain` on macOS, `libsecret` on Linux) or use SSH with an agent, then try again.',
  ],
  [
    /Permission denied \(publickey|Host key verification failed|no matching host key type|Could not read from remote repository/i,
    'SSH refused the connection. Start ssh-agent with your key loaded (`ssh-add`), check `~/.ssh/config` for this host, or switch the remote to HTTPS.',
  ],
  [
    /Could not resolve host|Failed to connect|Connection timed out|Network is unreachable|Connection refused|Temporary failure in name resolution|SSL_connect|OpenSSL SSL_read/i,
    'The remote could not be reached — check your network, VPN or proxy and try again.',
  ],
  [
    /non-fast-forward|fetch first|Updates were rejected because|rejected.*stale info/i,
    'The remote has commits you do not have. Pull first (this app merges, it never rebases), then push again.',
  ],
  [
    /no upstream branch|has no upstream|set-upstream|The current branch .* has no upstream/i,
    'This branch is not published yet — use Publish branch to push it and set its upstream.',
  ],
  [
    /There is no tracking information|not something we can merge|Please specify which branch you want to merge/i,
    'This branch tracks no remote branch. Publish it first, or fetch and merge the remote branch you want explicitly.',
  ],
  [
    /Your local changes to the following files would be overwritten|You have unstaged changes|Please commit your changes or stash them|not possible to fast-forward|Not possible to fast-forward/i,
    'Uncommitted changes are in the way — commit or discard them, then try again.',
  ],
  [
    /refusing to merge unrelated histories/i,
    'The two histories share no common commit; this app does not merge unrelated histories.',
  ],
  [
    /protected branch|pre-receive hook declined|GH006|GH013|remote rejected/i,
    'The remote refused the push — a protected branch or a server-side hook. Push another branch or open a pull request instead.',
  ],
  [
    /repository not found|does not appear to be a git repository|remote error: access denied|The project you were looking for could not be found/i,
    'The remote URL points at nothing Git can reach — check `git remote -v` and your access to it.',
  ],
  [
    /No such remote|does not appear to be a git repository|No remote configured|no such remote|'origin' does not appear/i,
    'No remote is configured for this repository — add one with `git remote add origin <url>`.',
  ],
];

/**
 * One line naming the fix for a failed fetch / pull / push, from its stderr;
 * null when the table has nothing to say (the drawer then shows stderr alone).
 */
export function networkHint(stderr: string): string | null {
  for (const [pattern, hint] of NETWORK_HINTS) {
    if (pattern.test(stderr)) {
      return hint;
    }
  }
  return null;
}

/** git's own words: the first non-empty line, `fatal: ` / `error: ` prefixes dropped. */
export function firstGitLine(message: string): string {
  const line = message
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '');
  return (line ?? '').replace(/^(?:fatal|error|warning): /, '');
}

/** The notice for a rejected git command — what the status bar says. */
export function gitFailureText(err: unknown): string {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  switch (errorCode(err)) {
    case 'GIT_NOT_FOUND':
      return 'Git is not installed or not on PATH';
    case 'GIT_NOT_A_REPO':
      return 'Not a git repository';
    case 'GIT_UNTRUSTED':
      return 'Git does not trust this folder — it is owned by another user';
    case 'GIT_TIMEOUT':
      return message ? `Git timed out — ${firstGitLine(message)}` : 'Git timed out';
    case 'GIT_CANCELLED':
      return 'Cancelled';
    case 'GIT_BUSY':
      return 'Another fetch, pull or push is already running for this repository';
    case 'GIT_INVALID_ARG':
      return `Git refused an argument: ${firstGitLine(message)}`;
    case 'GIT_FAILED': {
      const line = firstGitLine(message);
      return line === '' ? 'Git failed' : `Git: ${line}`;
    }
    default: {
      const line = firstGitLine(message);
      return line === '' ? 'Git failed' : line;
    }
  }
}
