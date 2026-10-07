import { describe, expect, test } from 'vitest';
import { errorCode, firstGitLine, gitFailureText, gitHint, networkHint } from '../hints';

class CodedError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

describe('networkHint', () => {
  test.each([
    [
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      'credential helper',
    ],
    [
      'remote: Invalid username or token. Password authentication is not supported',
      'credential helper',
    ],
    [
      'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
      'SSH refused',
    ],
    [
      "fatal: unable to access 'https://x/': Could not resolve host: github.com",
      'could not be reached',
    ],
    [
      '! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs',
      'Pull first',
    ],
    ['fatal: The current branch feat/x has no upstream branch.', 'Publish branch'],
    ['There is no tracking information for the current branch.', 'tracks no remote branch'],
    [
      'error: Your local changes to the following files would be overwritten by merge:',
      'Uncommitted changes',
    ],
    ['fatal: refusing to merge unrelated histories', 'unrelated histories'],
    [
      'remote: error: GH006: Protected branch update failed for refs/heads/main.',
      'refused the push',
    ],
    ['remote: Repository not found.', 'points at nothing'],
    ["error: No such remote 'origin'", 'not connected'],
    [
      "fatal: 'origin' does not appear to be a git repository\nfatal: Could not read from remote repository.",
      'not connected',
    ],
    [
      "fatal: 'C:/t/nope.git' does not appear to be a git repository\nfatal: Could not read from remote repository.",
      'points at nothing',
    ],
    [
      'ERROR: Repository not found.\nfatal: Could not read from remote repository.',
      'points at nothing',
    ],
  ])('%s → %s', (stderr, fragment) => {
    expect(networkHint(stderr)).toContain(fragment);
  });

  test('null when nothing matches', () => {
    expect(networkHint('Everything up-to-date')).toBeNull();
    expect(networkHint('')).toBeNull();
  });

  test('the credential hint names the helper config and says the app never prompts', () => {
    const hint = networkHint('terminal prompts disabled')!;
    expect(hint).toContain('git config --global credential.helper manager');
    expect(hint).toContain('never prompts');
  });
});

describe('gitFailureText', () => {
  test('a commit without a name and email points at the commit box form', () => {
    const err = new CodedError(
      'GIT_FAILED',
      'Author identity unknown\n\n*** Please tell me who you are.\n\nRun\n',
    );
    expect(gitFailureText(err)).toMatch(/name and email/);
  });

  test("one line per code, git's own words for GIT_FAILED", () => {
    expect(gitFailureText(new CodedError('GIT_NOT_FOUND', 'x'))).toBe(
      'Git is not installed or not on PATH',
    );
    expect(gitFailureText(new CodedError('GIT_NOT_A_REPO', 'x'))).toBe('Not a git repository');
    expect(gitFailureText(new CodedError('GIT_UNTRUSTED', 'x'))).toBe(
      'Git does not trust this folder — it is owned by another user',
    );
    expect(gitFailureText(new CodedError('GIT_TIMEOUT', 'git status exceeded 3 s'))).toBe(
      'Git timed out — git status exceeded 3 s',
    );
    expect(gitFailureText(new CodedError('GIT_CANCELLED', ''))).toBe('Cancelled');
    expect(gitFailureText(new CodedError('GIT_BUSY', ''))).toBe(
      'Another fetch, pull or push is already running for this repository',
    );
    expect(gitFailureText(new CodedError('GIT_INVALID_ARG', 'branch name starts with -'))).toBe(
      'Git refused an argument: branch name starts with -',
    );
    expect(
      gitFailureText(
        new CodedError('GIT_FAILED', "\nerror: The branch 'feat/x' is not fully merged.\nhint: …"),
      ),
    ).toBe("Git: The branch 'feat/x' is not fully merged.");
    expect(gitFailureText(new CodedError('GIT_FAILED', ''))).toBe('Git failed');
  });

  test('plain errors and strings pass their first line through', () => {
    expect(gitFailureText(new Error('boom\nmore'))).toBe('boom');
    expect(gitFailureText('fatal: nope')).toBe('nope');
    expect(gitFailureText(42)).toBe('Git failed');
  });

  test('firstGitLine and errorCode', () => {
    expect(firstGitLine('\n  warning: careful  \nnext')).toBe('careful');
    expect(errorCode(new CodedError('GIT_BUSY', ''))).toBe('GIT_BUSY');
    expect(errorCode(new Error('x'))).toBeNull();
    expect(errorCode('x')).toBeNull();
  });
});

describe('gitHint (moved from ui/code-review-git.ts)', () => {
  test('names the reason git is out', () => {
    expect(gitHint(new CodedError('GIT_NOT_FOUND', 'x'))).toBe('Git not found');
    expect(gitHint(new CodedError('GIT_NOT_A_REPO', 'x'))).toBe('Not a git repository');
    expect(gitHint(new CodedError('GIT_UNTRUSTED', 'x'))).toBe('Git does not trust this folder');
    expect(gitHint(new CodedError('GIT_TIMEOUT', 'x'))).toBe('Git timed out');
    expect(gitHint(new CodedError('GIT_FAILED', 'x'))).toBe('Git unavailable');
    expect(gitHint(new Error('boom'))).toBe('Git unavailable');
  });
});
