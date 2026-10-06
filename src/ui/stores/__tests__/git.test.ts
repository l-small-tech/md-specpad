import { describe, expect, test, vi, type Mock } from 'vitest';
import type { ClipboardProvider } from '../../../ipc/clipboard';
import { IpcError, type GitRepoInfo } from '../../../ipc/commands';
import type { GitNetOp, GitNetRunner } from '../../../ipc/git-ops';
import type {
  GitBranch,
  GitCommit,
  GitNetResult,
  GitStatus,
  GitStatusEntry,
  GitWorktreeSummary,
} from '../../../core/git/types';
import {
  createGitStore,
  LOG_PAGE,
  OP_LINE_CAP,
  REFRESH_THROTTLE_MS,
  WORKTREE_REMOVE_RETRY_MS,
  repoKey,
  type GitIpc,
  type GitStoreDeps,
  type GitTerminalTab,
} from '../git';

/* --------------------------------- fixtures -------------------------------- */

const MAIN = 'C:/repo';
const WT = 'C:/repo/worktrees/a';

const info: GitRepoInfo = {
  root: MAIN,
  mainRoot: MAIN,
  rel: '',
  branch: 'development',
  head: 'aaa1111',
  isWorktree: false,
  baseBranch: 'development',
  baseRef: null,
  worktrees: [
    { path: MAIN, branch: 'development', head: 'aaa1111' },
    { path: WT, branch: 'feat/a', head: 'bbb2222' },
  ],
};

const summary = (path: string, branch: string, isMain: boolean): GitWorktreeSummary => ({
  path,
  branch,
  head: isMain ? 'aaa1111' : 'bbb2222',
  isMain,
  locked: false,
  missing: false,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  state: 'clean',
  ahead: null,
  behind: null,
});

const entry = (
  path: string,
  index: string,
  worktree: string,
  kind: GitStatusEntry['kind'] = 'ordinary',
): GitStatusEntry => ({ path, origPath: null, index, worktree, kind });

const statusFor = (root: string, over: Partial<GitStatus> = {}): GitStatus => ({
  head: root === WT ? 'bbb2222' : 'aaa1111',
  branch: root === WT ? 'feat/a' : 'development',
  upstream: root === WT ? null : 'origin/development',
  ahead: 0,
  behind: 0,
  unborn: false,
  state: 'clean',
  mergeHead: null,
  entries: [],
  ...over,
});

const branch = (name: string, current = false): GitBranch => ({
  name,
  kind: 'local',
  head: 'aaa1111',
  current,
  upstream: null,
  ahead: null,
  behind: null,
  gone: false,
  committedAt: '2026-09-24T00:00:00Z',
});

const commit = (sha: string): GitCommit => ({
  sha,
  short: sha.slice(0, 7),
  parents: [],
  author: 'me',
  at: '2026-09-24T00:00:00Z',
  subject: `commit ${sha}`,
  refs: [],
  body: '',
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async (n = 4) => {
  for (let i = 0; i < n; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
};

/* ---------------------------------- fakes ---------------------------------- */

type FakeIpc = { [K in keyof GitIpc]: Mock };

function fakeIpc(): FakeIpc {
  return {
    gitRepoInfo: vi.fn(() => Promise.resolve(info)),
    gitShowFile: vi.fn(() => Promise.resolve(null)),
    gitStatus: vi.fn((root: string) => Promise.resolve(statusFor(root))),
    gitBranches: vi.fn(() => Promise.resolve([branch('development', true), branch('feat/a')])),
    gitLog: vi.fn(() => Promise.resolve([commit('c1c1c1c1')])),
    gitCommitFiles: vi.fn(() => Promise.resolve([])),
    gitDiffNames: vi.fn(() => Promise.resolve([])),
    gitWorktrees: vi.fn(() =>
      Promise.resolve([summary(MAIN, 'development', true), summary(WT, 'feat/a', false)]),
    ),
    gitCheckIgnore: vi.fn(() => Promise.resolve(true)),
    gitStage: vi.fn(() => Promise.resolve()),
    gitUnstage: vi.fn(() => Promise.resolve()),
    gitDiscard: vi.fn(() => Promise.resolve()),
    gitCommit: vi.fn(() => Promise.resolve('newsha')),
    gitSwitch: vi.fn(() => Promise.resolve()),
    gitCreateBranch: vi.fn(() => Promise.resolve()),
    gitDeleteBranch: vi.fn(() => Promise.resolve()),
    gitMerge: vi.fn(() => Promise.resolve({ outcome: 'merged', head: 'm', conflicted: [] })),
    gitMergeAbort: vi.fn(() => Promise.resolve()),
    gitWorktreeAdd: vi.fn(() => Promise.resolve()),
    gitWorktreeRemove: vi.fn(() => Promise.resolve()),
    gitTrustDirectory: vi.fn(() => Promise.resolve()),
    readTextFile: vi.fn(() => Promise.resolve({ text: '', mtimeMs: 0 })),
    atomicWriteText: vi.fn(() => Promise.resolve()),
  };
}

interface NetCall {
  kind: string;
  options: unknown;
  emit: (stream: 'out' | 'err', text: string) => void;
  finish: (result: GitNetResult) => void;
  reject: (err: unknown) => void;
  cancel: Mock;
}

/** A runner whose ops the test settles by hand. */
function fakeNet() {
  const calls: NetCall[] = [];
  const runner: GitNetRunner = (kind, options, onLine) => {
    const d = deferred<GitNetResult>();
    const cancel = vi.fn();
    calls.push({
      kind,
      options,
      emit: (stream, text) => onLine({ stream, text }),
      finish: d.resolve,
      reject: d.reject,
      cancel,
    });
    const op: GitNetOp = { done: d.promise, cancel };
    return op;
  };
  return { calls, runner };
}

const okResult = (over: Partial<GitNetResult> = {}): GitNetResult => ({
  ok: true,
  exitCode: 0,
  stderr: '',
  merge: null,
  ...over,
});

function harness(opts: { active?: string | null; terminals?: GitTerminalTab[] } = {}) {
  const ipc = fakeIpc();
  const net = fakeNet();
  const order: string[] = [];
  let clock = 10_000;
  let clipboardText = '';
  const clipboard: ClipboardProvider = {
    read: () => Promise.resolve(clipboardText),
    write: (t) => {
      clipboardText = t;
      return Promise.resolve();
    },
  };
  ipc.gitWorktreeRemove.mockImplementation(() => {
    order.push('gitWorktreeRemove');
    return Promise.resolve();
  });
  const deps: GitStoreDeps = {
    ipc: ipc as unknown as GitIpc,
    net: net.runner,
    now: () => clock,
    baseBranchSetting: () => '',
    activeWorkspaceDir: () => opts.active ?? null,
    terminalTabs: () => opts.terminals ?? [],
    confirm: vi.fn(() => Promise.resolve(true)),
    notice: vi.fn(),
    clipboard: () => clipboard,
    openTerminalAt: vi.fn((_cwd: string, _harness: boolean) => {}),
    openFile: vi.fn(),
    saveTabAt: vi.fn(() => Promise.resolve()),
    addWorkspace: vi.fn(),
    removeWorkspace: vi.fn(() => {
      order.push('removeWorkspace');
    }),
    closeTabs: vi.fn(() => {
      order.push('closeTabs');
      return Promise.resolve();
    }),
    refreshWatchedDirs: vi.fn(() => {
      order.push('refreshWatchedDirs');
      return Promise.resolve();
    }),
  };
  const store = createGitStore(() => deps);
  const s = () => store.getState();
  const r = () => s().repos[repoKey(MAIN)]!;
  return {
    ipc,
    net,
    deps,
    order,
    store,
    s,
    r,
    clipboard: () => clipboardText,
    tick: (ms: number) => {
      clock += ms;
    },
    notices: () => (deps.notice as Mock).mock.calls.map((c) => c[0] as string),
    async open(checkout?: string | null) {
      s().ensureRepo(MAIN, checkout);
      await s().refresh(MAIN, { force: true });
    },
  };
}

/* ---------------------------------- tests ---------------------------------- */

describe('refresh', () => {
  test('loads the repository, then the selected checkout; main by default', async () => {
    const h = harness();
    await h.open();
    const repo = h.r();
    expect(repo.info).toEqual(info);
    expect(repo.checkouts.map((c) => [c.path, c.isMain, c.summary !== null])).toEqual([
      [MAIN, true, true],
      [WT, false, true],
    ]);
    expect(repo.selectedCheckout).toBe(MAIN);
    expect(repo.status?.branch).toBe('development');
    expect(repo.branches).toHaveLength(2);
    expect(repo.log.map((c) => c.sha)).toEqual(['c1c1c1c1']);
    expect(repo.logExhausted).toBe(true);
    expect(repo.unavailable).toBeNull();
    expect(repo.loading).toEqual({ status: false, branches: false, log: false, worktrees: false });
    expect(h.ipc.gitStatus).toHaveBeenCalledWith(MAIN);
    expect(h.ipc.gitLog).toHaveBeenCalledWith(MAIN, null, LOG_PAGE, 0, true);
    expect(h.ipc.gitRepoInfo).toHaveBeenCalledWith(MAIN, undefined);
  });

  test("the default checkout is the active workspace's; an explicit one is remembered", async () => {
    const active = harness({ active: `${WT}/src` });
    await active.open();
    expect(active.r().selectedCheckout).toBe(WT);
    expect(active.ipc.gitStatus).toHaveBeenLastCalledWith(WT);

    const explicit = harness({ active: `${WT}/src` });
    await explicit.open(MAIN);
    expect(explicit.r().selectedCheckout).toBe(MAIN);

    const outside = harness({ active: 'D:/elsewhere' });
    await outside.open();
    expect(outside.r().selectedCheckout).toBe(MAIN);
  });

  test('a remembered checkout that disappears falls back to main', async () => {
    const h = harness();
    await h.open(WT);
    expect(h.r().selectedCheckout).toBe(WT);
    h.ipc.gitWorktrees.mockResolvedValue([summary(MAIN, 'development', true)]);
    h.ipc.gitRepoInfo.mockResolvedValue({ ...info, worktrees: [info.worktrees[0]!] });
    await h.s().refresh(MAIN, { force: true });
    expect(h.r().selectedCheckout).toBe(MAIN);
    expect(h.r().status?.branch).toBe('development');
  });

  test('throttled to once a second unless forced', async () => {
    const h = harness();
    await h.open();
    expect(h.ipc.gitStatus).toHaveBeenCalledTimes(1);
    await h.s().refresh(MAIN);
    expect(h.ipc.gitStatus).toHaveBeenCalledTimes(1);
    h.tick(REFRESH_THROTTLE_MS);
    await h.s().refresh(MAIN, { parts: ['status'] });
    expect(h.ipc.gitStatus).toHaveBeenCalledTimes(2);
    expect(h.ipc.gitBranches).toHaveBeenCalledTimes(1);
  });

  test('a stale status answer is dropped when the checkout changed meanwhile', async () => {
    const h = harness();
    await h.open();
    const slow = deferred<GitStatus>();
    h.ipc.gitStatus.mockImplementation((root: string) =>
      root === MAIN
        ? slow.promise
        : Promise.resolve(statusFor(WT, { entries: [entry('x', 'M', '.')] })),
    );
    void h.s().refresh(MAIN, { force: true, parts: ['status'] });
    h.s().selectCheckout(MAIN, WT);
    await flush();
    expect(h.r().status?.branch).toBe('feat/a');
    slow.resolve(statusFor(MAIN, { entries: [entry('stale', 'M', '.')] }));
    await flush();
    expect(h.r().selectedCheckout).toBe(WT);
    expect(h.r().status?.branch).toBe('feat/a');
    expect(h.r().groups.staged.map((e) => e.path)).toEqual(['x']);
  });

  test('git being absent or the folder not a repo is a state, not an error', async () => {
    const h = harness();
    h.ipc.gitRepoInfo.mockRejectedValue(new IpcError('GIT_NOT_A_REPO', 'nope'));
    await h.open();
    expect(h.r().unavailable).toBe('not-a-repo');
    expect(h.r().error).toBeNull();
    expect(h.ipc.gitStatus).not.toHaveBeenCalled();
    expect(h.notices()).toEqual([]);

    h.ipc.gitRepoInfo.mockRejectedValue(new IpcError('GIT_FAILED', 'fatal: broken'));
    await h.s().refresh(MAIN, { force: true });
    expect(h.r().error).toEqual({ code: 'GIT_FAILED', message: 'Git: broken' });
    expect(h.notices()).toEqual(['Git: broken']);
  });

  test('an untrusted repository is a state; trusting it confirms, trusts and reloads', async () => {
    const h = harness();
    h.ipc.gitRepoInfo.mockRejectedValue(new IpcError('GIT_UNTRUSTED', 'owned by another user'));
    await h.open();
    expect(h.r().unavailable).toBe('untrusted');
    expect(h.notices()).toEqual([]);

    // Declined: nothing is written to the git config.
    (h.deps.confirm as Mock).mockResolvedValueOnce(false);
    expect(await h.s().trustFolder(MAIN)).toBe(false);
    expect(h.ipc.gitTrustDirectory).not.toHaveBeenCalled();
    expect(h.r().unavailable).toBe('untrusted');

    // Confirmed: trusted, and the tab comes back to life.
    h.ipc.gitRepoInfo.mockResolvedValue(info);
    expect(await h.s().trustFolder(MAIN)).toBe(true);
    expect(h.ipc.gitTrustDirectory).toHaveBeenCalledWith(MAIN);
    await flush();
    expect(h.r().unavailable).toBeNull();
    expect(h.ipc.gitStatus).toHaveBeenCalled();
  });

  test('a failed trust is a notice and reports false', async () => {
    const h = harness();
    h.ipc.gitTrustDirectory.mockRejectedValue(
      new IpcError('GIT_FAILED', 'error: could not lock config file'),
    );
    expect(await h.s().trustFolder('D:/proj')).toBe(false);
    expect(h.notices()).toEqual(['Git: could not lock config file']);
  });

  test('forget drops the repository', async () => {
    const h = harness();
    await h.open();
    h.s().forget(MAIN);
    expect(h.s().repos).toEqual({});
    expect(h.s().watchRoots()).toEqual([]);
  });
});

describe('selection and diffs', () => {
  test('a staged file compares HEAD with the index; an unstaged one the index with the file', async () => {
    const h = harness();
    h.ipc.gitStatus.mockResolvedValue(
      statusFor(MAIN, { entries: [entry('a.ts', 'M', 'M'), entry('n.md', '?', '?', 'untracked')] }),
    );
    await h.open();
    h.ipc.gitShowFile.mockImplementation((_root: string, rev: string) =>
      Promise.resolve(rev === 'HEAD' ? 'head\r\n' : 'index\n'),
    );
    h.ipc.readTextFile.mockResolvedValue({ text: 'index\r\n', mtimeMs: 1 });

    h.s().select(MAIN, { kind: 'file', group: 'staged', path: 'a.ts' });
    await flush();
    expect(h.ipc.gitShowFile).toHaveBeenCalledWith(MAIN, 'HEAD', 'a.ts');
    expect(h.ipc.gitShowFile).toHaveBeenCalledWith(MAIN, ':0', 'a.ts');
    expect(h.r().diff).toMatchObject({
      path: 'a.ts',
      leftText: 'head\n',
      rightText: 'index\n',
      binary: false,
      eolOnly: false,
    });

    h.s().select(MAIN, { kind: 'file', group: 'unstaged', path: 'a.ts' });
    await flush();
    expect(h.ipc.readTextFile).toHaveBeenCalledWith('C:/repo/a.ts');
    expect(h.r().diff).toMatchObject({ leftText: 'index\n', rightText: 'index\n', eolOnly: true });

    h.s().select(MAIN, { kind: 'file', group: 'untracked', path: 'n.md' });
    await flush();
    expect(h.r().diff).toMatchObject({ leftText: null, rightText: 'index\n' });

    h.s().select(MAIN, null);
    expect(h.r().diff).toBeNull();
  });

  test('a commit file compares sha^ with sha; a root commit has no left side', async () => {
    const h = harness();
    await h.open();
    h.ipc.gitShowFile.mockImplementation((_root: string, rev: string) =>
      rev.endsWith('^')
        ? Promise.reject(new IpcError('GIT_FAILED', 'unknown revision'))
        : Promise.resolve('now\n'),
    );
    h.s().select(MAIN, { kind: 'commit', sha: 'c1c1c1c1', path: 'f.ts' });
    await flush();
    expect(h.ipc.gitCommitFiles).toHaveBeenCalledWith(MAIN, 'c1c1c1c1');
    expect(h.r().diff).toMatchObject({ leftText: null, rightText: 'now\n' });
  });

  test('loadMoreLog appends the next page', async () => {
    const h = harness();
    h.ipc.gitLog.mockResolvedValue(Array.from({ length: LOG_PAGE }, (_, i) => commit(`s${i}`)));
    await h.open();
    expect(h.r().logExhausted).toBe(false);
    h.ipc.gitLog.mockResolvedValue([commit('last')]);
    await h.s().loadMoreLog(MAIN);
    expect(h.ipc.gitLog).toHaveBeenLastCalledWith(MAIN, null, LOG_PAGE, LOG_PAGE, true);
    expect(h.r().log).toHaveLength(LOG_PAGE + 1);
    expect(h.r().logExhausted).toBe(true);
  });
});

describe('changes and commit', () => {
  test('commit sends the draft, clears it and refreshes', async () => {
    const h = harness();
    await h.open();
    h.s().setCommitDraft(MAIN, '-leading dash\n\nbody');
    const statusCalls = h.ipc.gitStatus.mock.calls.length;
    await h.s().commit(MAIN);
    expect(h.ipc.gitCommit).toHaveBeenCalledWith(MAIN, '-leading dash\n\nbody', false);
    expect(h.r().commitDraft).toBe('');
    expect(h.ipc.gitStatus.mock.calls.length).toBe(statusCalls + 1);
    expect(h.notices()).toContain('Committed');
  });

  test('an empty draft is refused, except when merging or amending (git keeps the message)', async () => {
    const h = harness();
    await h.open();
    await h.s().commit(MAIN);
    expect(h.ipc.gitCommit).not.toHaveBeenCalled();
    expect(h.notices()).toContain('Enter a commit message');

    h.s().toggleAmend(MAIN);
    await h.s().commit(MAIN);
    expect(h.ipc.gitCommit).toHaveBeenLastCalledWith(MAIN, null, true);
    expect(h.r().amend).toBe(false);

    h.ipc.gitStatus.mockResolvedValue(statusFor(MAIN, { state: 'merging', mergeHead: 'zzz' }));
    await h.s().refresh(MAIN, { force: true, parts: ['status'] });
    await h.s().commit(MAIN);
    expect(h.ipc.gitCommit).toHaveBeenLastCalledWith(MAIN, null, false);
  });

  test('a failed call lands in error and a notice; the refresh still happens', async () => {
    const h = harness();
    await h.open();
    h.ipc.gitStage.mockRejectedValue(
      new IpcError('GIT_FAILED', "fatal: pathspec 'x' did not match"),
    );
    await h.s().stage(MAIN, ['x']);
    expect(h.r().error?.message).toBe("Git: pathspec 'x' did not match");
    expect(h.notices()).toContain("Git: pathspec 'x' did not match");
    expect(h.ipc.gitStatus).toHaveBeenCalledTimes(2);
  });

  test('discard confirms and splits tracked from untracked paths', async () => {
    const h = harness();
    h.ipc.gitStatus.mockResolvedValue(
      statusFor(MAIN, {
        entries: [entry('a.ts', '.', 'M'), entry('new.md', '?', '?', 'untracked')],
      }),
    );
    await h.open();
    (h.deps.confirm as Mock).mockResolvedValueOnce(false);
    await h.s().discard(MAIN, ['a.ts', 'new.md']);
    expect(h.ipc.gitDiscard).not.toHaveBeenCalled();
    await h.s().discard(MAIN, ['a.ts', 'new.md']);
    expect(h.deps.confirm).toHaveBeenLastCalledWith(
      expect.stringContaining('1 untracked file will be deleted'),
      'Discard changes',
    );
    expect(h.ipc.gitDiscard).toHaveBeenCalledWith(MAIN, ['a.ts'], ['new.md']);
  });
});

describe('branches', () => {
  test('createBranch validates before calling; switchBranch tracks a remote', async () => {
    const h = harness();
    await h.open();
    await h.s().createBranch(MAIN, 'bad..name', null, true);
    expect(h.ipc.gitCreateBranch).not.toHaveBeenCalled();
    expect(h.notices()).toContain('A branch name cannot contain ..');
    await h.s().createBranch(MAIN, 'feat/new', 'development', true);
    expect(h.ipc.gitCreateBranch).toHaveBeenCalledWith(MAIN, 'feat/new', 'development', true);

    await h.s().switchBranch(MAIN, { ...branch('origin/feat/r'), kind: 'remote' });
    expect(h.ipc.gitSwitch).toHaveBeenCalledWith(MAIN, 'feat/r', 'origin');
    await h.s().switchBranch(MAIN, branch('feat/a'));
    expect(h.ipc.gitSwitch).toHaveBeenLastCalledWith(MAIN, 'feat/a', null);
  });

  test('deleteBranch is pre-empted when a worktree holds the branch', async () => {
    const h = harness();
    await h.open();
    await h.s().deleteBranch(MAIN, 'feat/a');
    expect(h.ipc.gitDeleteBranch).not.toHaveBeenCalled();
    expect(h.notices()).toContain(
      'feat/a is checked out in worktrees/a — remove that worktree first',
    );
    await h.s().deleteBranch(MAIN, 'feat/gone', { force: true });
    expect(h.ipc.gitDeleteBranch).toHaveBeenCalledWith(MAIN, 'feat/gone', true);
  });
});

describe('network ops', () => {
  test('streams lines (capped), records the result and a hint on failure', async () => {
    const h = harness();
    await h.open();
    const push = h.s().push(MAIN, { setUpstream: true });
    const call = h.net.calls[0]!;
    expect(call.kind).toBe('push');
    expect(call.options).toEqual({ root: MAIN, remote: null, setUpstream: true });
    expect(h.r().op).toMatchObject({ kind: 'push', running: true, lines: [] });
    for (let i = 0; i < OP_LINE_CAP + 10; i++) {
      call.emit('err', `line ${i}`);
    }
    expect(h.r().op?.lines).toHaveLength(OP_LINE_CAP);
    expect(h.r().op?.lines[0]).toEqual({ stream: 'err', text: 'line 10' });
    call.finish(
      okResult({ ok: false, exitCode: 1, stderr: '! [rejected] main -> main (non-fast-forward)' }),
    );
    await push;
    expect(h.r().op).toMatchObject({ running: false, error: null });
    expect(h.r().op?.result?.ok).toBe(false);
    expect(h.r().op?.hint).toContain('Pull first');
    // A success has no hint, and the op can then be dismissed.
    const fetch = h.s().fetch(MAIN, { prune: true });
    h.net.calls[1]!.finish(okResult());
    await fetch;
    expect(h.net.calls[1]!.options).toEqual({ root: MAIN, remote: null, prune: true });
    expect(h.r().op?.hint).toBeNull();
    h.s().dismissOp(MAIN);
    expect(h.r().op).toBeNull();
  });

  test('a second op while one runs surfaces GIT_BUSY as op.error; cancel reaches the op', async () => {
    const h = harness();
    await h.open();
    const first = h.s().fetch(MAIN);
    const second = h.s().push(MAIN);
    h.net.calls[1]!.reject(new IpcError('GIT_BUSY', 'busy'));
    await second;
    expect(h.r().op).toMatchObject({
      kind: 'push',
      running: false,
      error: 'Another fetch, pull or push is already running for this repository',
    });
    h.net.calls[0]!.finish(okResult());
    await first;
    // The busy answer stays on screen; the first op's result does not overwrite it.
    expect(h.r().op?.kind).toBe('push');

    const third = h.s().fetch(MAIN);
    h.s().cancelOp(MAIN);
    expect(h.net.calls[2]!.cancel).toHaveBeenCalled();
    h.net.calls[2]!.reject(new IpcError('GIT_CANCELLED', ''));
    await third;
    expect(h.r().op?.error).toBe('Cancelled');
  });

  test('pull ending in conflicts arms the tracker', async () => {
    const h = harness();
    await h.open();
    const pull = h.s().pull(MAIN);
    h.ipc.gitStatus.mockResolvedValue(
      statusFor(MAIN, {
        state: 'merging',
        mergeHead: 'zzz',
        entries: [entry('a.ts', 'U', 'U', 'unmerged'), entry('b.ts', 'U', 'U', 'unmerged')],
      }),
    );
    h.ipc.readTextFile.mockImplementation((path: string) =>
      Promise.resolve({
        text: path.endsWith('a.ts') ? '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> t\n' : 'clean\n',
        mtimeMs: 0,
      }),
    );
    h.net.calls[0]!.finish(
      okResult({
        ok: true,
        merge: { outcome: 'conflicts', head: 'aaa1111', conflicted: ['a.ts', 'b.ts'] },
      }),
    );
    await pull;
    await flush();
    expect(h.r().conflictTracker).toEqual({
      root: MAIN,
      into: 'development',
      from: 'origin/development',
      files: ['a.ts', 'b.ts'],
      markerFree: { 'a.ts': false, 'b.ts': true },
      markerCounts: { 'a.ts': 1, 'b.ts': 0 },
    });
    expect(h.r().groups.conflicted).toHaveLength(2);
  });
});

describe('merge into an expected branch', () => {
  test('refuses when the checkout is on another branch, and merges when it matches', async () => {
    const h = harness();
    await h.open();
    // MAIN is on development; a worktree row asking to merge "into main" is wrong.
    await h.s().merge(MAIN, 'feat/a', { root: MAIN, into: 'main' });
    expect(h.ipc.gitMerge).not.toHaveBeenCalled();
    expect(h.notices().at(-1)).toBe(
      'Cannot merge into main: that checkout is on development — switch it first',
    );
    await h.s().merge(MAIN, 'feat/a', { root: MAIN, into: 'development' });
    expect(h.ipc.gitMerge).toHaveBeenCalledWith(MAIN, 'feat/a', false);
  });
});

describe('conflicts', () => {
  async function merging(h: ReturnType<typeof harness>) {
    await h.open();
    h.ipc.gitMerge.mockResolvedValueOnce({
      outcome: 'conflicts',
      head: 'aaa1111',
      conflicted: ['a.ts'],
    });
    h.ipc.gitStatus.mockResolvedValue(
      statusFor(MAIN, {
        state: 'merging',
        mergeHead: 'zzz',
        entries: [entry('a.ts', 'U', 'U', 'unmerged')],
      }),
    );
    h.ipc.readTextFile.mockResolvedValue({
      text: 'a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> feat/a\n',
      mtimeMs: 0,
    });
    await h.s().merge(MAIN, 'feat/a');
    await flush();
  }

  test('Continue is gated on git AND the marker scan; then commits --no-edit', async () => {
    const h = harness();
    await merging(h);
    expect(h.r().conflictTracker).toMatchObject({
      root: MAIN,
      into: 'development',
      from: 'feat/a',
      files: ['a.ts'],
      markerFree: { 'a.ts': false },
    });
    expect(h.notices().at(-1)).toContain('stopped on 1 conflicted file');

    // git still reports the file unmerged.
    await h.s().continueMerge(MAIN);
    expect(h.ipc.gitCommit).not.toHaveBeenCalled();
    expect(h.notices().at(-1)).toBe('Cannot continue the merge: 1 file is still unmerged');

    // The agent ran `git add` but left the markers in.
    h.ipc.gitStatus.mockResolvedValue(
      statusFor(MAIN, { state: 'merging', mergeHead: 'zzz', entries: [entry('a.ts', 'M', '.')] }),
    );
    await h.s().continueMerge(MAIN);
    expect(h.ipc.gitCommit).not.toHaveBeenCalled();
    expect(h.notices().at(-1)).toBe('Cannot continue the merge: Conflict markers remain in a.ts');

    // Markers gone too.
    h.ipc.readTextFile.mockResolvedValue({ text: 'resolved\n', mtimeMs: 0 });
    h.ipc.gitStatus.mockResolvedValue(statusFor(MAIN));
    await h.s().continueMerge(MAIN);
    expect(h.ipc.gitCommit).toHaveBeenCalledWith(MAIN, null, false);
    expect(h.r().conflictTracker).toBeNull();
  });

  test('markResolved saves the tab first, then stages; copy puts the prompt on the clipboard', async () => {
    const h = harness();
    await merging(h);
    await h.s().markResolved(MAIN, 'a.ts');
    expect(h.deps.saveTabAt).toHaveBeenCalledWith('C:/repo/a.ts');
    expect(h.ipc.gitStage).toHaveBeenCalledWith(MAIN, ['a.ts']);
    expect((h.deps.saveTabAt as Mock).mock.invocationCallOrder[0]!).toBeLessThan(
      h.ipc.gitStage.mock.invocationCallOrder[0]!,
    );

    await h.s().copyConflictPrompt(MAIN);
    expect(h.clipboard()).toContain('Merge-context: C:/repo into=development from=feat/a');
    expect(h.clipboard()).toContain('- a.ts');
    expect(h.notices().at(-1)).toBe('Conflict prompt copied — paste it into your AI agent');
  });

  test('abortMerge drops the tracker; a merge finished outside the app retires it on refresh', async () => {
    const h = harness();
    await merging(h);
    await h.s().abortMerge(MAIN);
    expect(h.ipc.gitMergeAbort).toHaveBeenCalledWith(MAIN);
    expect(h.r().conflictTracker).toBeNull();

    await merging(h);
    expect(h.r().conflictTracker).not.toBeNull();
    h.ipc.gitStatus.mockResolvedValue(statusFor(MAIN, { head: 'moved' }));
    h.s().onRepoChanged([MAIN]);
    await flush();
    expect(h.r().conflictTracker).toBeNull();
  });

  test('a watcher poke is skipped while an action is in flight', async () => {
    const h = harness();
    await h.open();
    const slow = deferred<void>();
    h.ipc.gitStage.mockReturnValue(slow.promise);
    const staging = h.s().stage(MAIN, ['x']);
    const calls = h.ipc.gitStatus.mock.calls.length;
    h.s().onRepoChanged([`${MAIN}/.git`]);
    await flush();
    expect(h.ipc.gitStatus.mock.calls.length).toBe(calls);
    slow.resolve();
    await staging;
    expect(h.ipc.gitStatus.mock.calls.length).toBe(calls + 1);
  });
});

describe('worktrees', () => {
  test('createWorktree: validation errors stop before any ipc call', async () => {
    const h = harness();
    await h.open();
    h.s().openNewWorktree(MAIN);
    h.s().setNewWorktreeField(MAIN, { slug: 'Bad Slug' });
    await h.s().createWorktree(MAIN);
    expect(h.r().newWorktree.error).toBe(
      'Use lowercase letters, digits and single hyphens (kebab-case)',
    );
    expect(h.ipc.gitCheckIgnore).not.toHaveBeenCalled();
    expect(h.ipc.gitWorktreeAdd).not.toHaveBeenCalled();
    expect(h.r().newWorktree.open).toBe(true);
  });

  test('createWorktree: ignore check → worktree add → workspace → terminal (two arguments)', async () => {
    const h = harness();
    await h.open();
    // Once added, git lists the new worktree.
    h.ipc.gitWorktreeAdd.mockImplementation((_root: string, path: string, name: string) => {
      h.ipc.gitWorktrees.mockResolvedValue([
        summary(MAIN, 'development', true),
        summary(WT, 'feat/a', false),
        summary(path, name, false),
      ]);
      return Promise.resolve();
    });
    h.s().openNewWorktree(MAIN);
    h.s().setNewWorktreeField(MAIN, { slug: 'new-thing' });
    await h.s().createWorktree(MAIN);
    expect(h.ipc.gitCheckIgnore).toHaveBeenCalledWith(MAIN, 'worktrees/');
    expect(h.ipc.readTextFile).not.toHaveBeenCalled();
    expect(h.ipc.atomicWriteText).not.toHaveBeenCalled();
    expect(h.ipc.gitWorktreeAdd).toHaveBeenCalledWith(
      MAIN,
      'C:/repo/worktrees/new-thing',
      'feat/new-thing',
      'development',
      true,
    );
    expect(h.deps.addWorkspace).toHaveBeenCalledWith('C:/repo/worktrees/new-thing');
    expect(h.deps.openTerminalAt).toHaveBeenCalledWith('C:/repo/worktrees/new-thing', true);
    expect((h.deps.openTerminalAt as Mock).mock.calls[0]).toHaveLength(2);
    expect(h.r().newWorktree.open).toBe(false);
    expect(h.r().selectedCheckout).toBe('C:/repo/worktrees/new-thing');
    // Nothing is ever typed: the dep takes exactly (cwd, harness).
    const params: [string, boolean] = null as unknown as Parameters<GitStoreDeps['openTerminalAt']>;
    void params;
    expect(h.deps.openTerminalAt.length).toBe(2);
  });

  test('createWorktree appends worktrees/ to .gitignore only when git does not ignore it', async () => {
    const h = harness();
    await h.open();
    h.ipc.gitCheckIgnore.mockResolvedValue(false);
    h.ipc.readTextFile.mockResolvedValue({ text: 'node_modules/\n', mtimeMs: 0 });
    h.s().setNewWorktreeField(MAIN, { slug: 'x', openTerminal: 'none', base: 'main' });
    await h.s().createWorktree(MAIN);
    expect(h.ipc.readTextFile).toHaveBeenCalledWith('C:/repo/.gitignore');
    expect(h.ipc.atomicWriteText).toHaveBeenCalledWith(
      'C:/repo/.gitignore',
      'node_modules/\nworktrees/\n',
    );
    expect(h.ipc.gitWorktreeAdd).toHaveBeenCalledWith(
      MAIN,
      'C:/repo/worktrees/x',
      'feat/x',
      'main',
      true,
    );
    expect(h.deps.openTerminalAt).not.toHaveBeenCalled();

    // A missing .gitignore is created; an already-listed line is left alone.
    h.ipc.readTextFile.mockRejectedValue(new IpcError('IO', 'missing'));
    h.s().setNewWorktreeField(MAIN, { slug: 'y' });
    await h.s().createWorktree(MAIN);
    expect(h.ipc.atomicWriteText).toHaveBeenLastCalledWith('C:/repo/.gitignore', 'worktrees/\n');
    h.ipc.atomicWriteText.mockClear();
    h.ipc.readTextFile.mockResolvedValue({ text: 'worktrees/\n', mtimeMs: 0 });
    h.s().setNewWorktreeField(MAIN, { slug: 'z' });
    await h.s().createWorktree(MAIN);
    expect(h.ipc.atomicWriteText).not.toHaveBeenCalled();
  });

  test('createWorktree: a git failure shows under the field and the dialog stays open', async () => {
    const h = harness();
    await h.open();
    h.ipc.gitWorktreeAdd.mockRejectedValue(
      new IpcError('GIT_FAILED', "fatal: 'worktrees/x' already exists"),
    );
    h.s().openNewWorktree(MAIN);
    h.s().setNewWorktreeField(MAIN, { slug: 'x' });
    await h.s().createWorktree(MAIN);
    expect(h.r().newWorktree).toMatchObject({
      open: true,
      busy: false,
      error: "Git: 'worktrees/x' already exists",
    });
    expect(h.deps.addWorkspace).not.toHaveBeenCalled();
  });

  test('removeWorktree: closeTabs → removeWorkspace → refreshWatchedDirs → gitWorktreeRemove', async () => {
    const terminals: GitTerminalTab[] = [
      { id: 't1', title: 'pwsh', cwd: `${WT}/src` },
      { id: 't2', title: 'main shell', cwd: MAIN },
    ];
    const h = harness({ terminals });
    await h.open(WT);
    await h.s().removeWorktree(MAIN, WT);
    expect(h.deps.confirm).toHaveBeenCalledWith(
      expect.stringContaining('1 terminal tab inside it will be closed: pwsh'),
      'Remove worktree',
    );
    expect(h.deps.closeTabs).toHaveBeenCalledWith(['t1']);
    expect(h.deps.removeWorkspace).toHaveBeenCalledWith(WT);
    expect(h.ipc.gitWorktreeRemove).toHaveBeenCalledWith(MAIN, WT, false);
    expect(h.order).toEqual([
      'closeTabs',
      'removeWorkspace',
      'refreshWatchedDirs',
      'gitWorktreeRemove',
    ]);
    expect(h.r().selectedCheckout).toBe(MAIN);
  });

  test('removeWorktree: a directory still held by a closing shell gets one delayed retry', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      await h.open();
      h.ipc.gitWorktreeRemove
        .mockRejectedValueOnce(
          new IpcError(
            'GIT_FAILED',
            "fatal: failed to delete 'C:/repo/worktrees/a': The process cannot access the file because it is being used by another process.",
          ),
        )
        .mockResolvedValueOnce(undefined);
      const done = h.s().removeWorktree(MAIN, WT);
      await vi.advanceTimersByTimeAsync(WORKTREE_REMOVE_RETRY_MS + 1);
      await done;
      expect(h.ipc.gitWorktreeRemove).toHaveBeenCalledTimes(2);
      expect(h.notices().at(-1)).toBe('Removed worktrees/a');
    } finally {
      vi.useRealTimers();
    }
  });

  test('removeWorktree: declined confirm does nothing; the main checkout is refused', async () => {
    const h = harness();
    await h.open();
    (h.deps.confirm as Mock).mockResolvedValueOnce(false);
    await h.s().removeWorktree(MAIN, WT, { force: true });
    expect(h.order).toEqual([]);
    await h.s().removeWorktree(MAIN, MAIN);
    expect(h.deps.confirm).toHaveBeenCalledTimes(1);
    expect(h.notices()).toContain('The main checkout cannot be removed');
  });

  test('openWorktreeAsWorkspace / openTerminalIn pass straight through', async () => {
    const h = harness();
    await h.open();
    h.s().openWorktreeAsWorkspace(MAIN, WT);
    expect(h.deps.addWorkspace).toHaveBeenCalledWith(WT);
    h.s().openTerminalIn(MAIN, WT, false);
    expect(h.deps.openTerminalAt).toHaveBeenCalledWith(WT, false);
  });
});

describe('finish flow', () => {
  const stepStatuses = (h: ReturnType<typeof harness>) =>
    h.r().finish!.steps.map((s) => `${s.id}:${s.status}`);

  test('happy path: merge in, pause to verify, merge into base in MAIN, cleanup, remove, delete', async () => {
    const terminals: GitTerminalTab[] = [{ id: 't1', title: 'agent', cwd: WT }];
    const h = harness({ terminals });
    await h.open();
    await h.s().startFinish(MAIN, WT);
    expect(h.ipc.gitMerge).toHaveBeenCalledWith(WT, 'development', false);
    expect(h.r().selected).toEqual({ kind: 'finish' });
    expect(stepStatuses(h)).toEqual([
      'merge-base-in:done',
      'verify:paused',
      'merge-into-base:pending',
      'cleanup:pending',
      'remove-worktree:pending',
      'delete-branch:pending',
    ]);
    expect(h.ipc.gitMerge).toHaveBeenCalledTimes(1);

    await h.s().continueFinish(MAIN);
    expect(h.ipc.gitMerge).toHaveBeenLastCalledWith(MAIN, 'feat/a', false);
    expect(h.deps.confirm).toHaveBeenCalledWith(
      expect.stringContaining('1 terminal tab inside it will be closed: agent'),
      'Finish worktree',
    );
    expect(h.order).toEqual([
      'closeTabs',
      'removeWorkspace',
      'refreshWatchedDirs',
      'gitWorktreeRemove',
    ]);
    expect(h.ipc.gitWorktreeRemove).toHaveBeenCalledWith(MAIN, WT, false);
    expect(h.ipc.gitDeleteBranch).toHaveBeenCalledWith(MAIN, 'feat/a', false);
    expect(h.r().finish).toMatchObject({ finished: true, aborted: false, current: 6 });
    expect(stepStatuses(h).every((s) => s.endsWith(':done'))).toBe(true);
    const gitOrder = [
      h.ipc.gitMerge.mock.invocationCallOrder[0]!,
      h.ipc.gitMerge.mock.invocationCallOrder[1]!,
      (h.deps.closeTabs as Mock).mock.invocationCallOrder[0]!,
      h.ipc.gitWorktreeRemove.mock.invocationCallOrder[0]!,
      h.ipc.gitDeleteBranch.mock.invocationCallOrder[0]!,
    ];
    expect([...gitOrder].sort((a, b) => a - b)).toEqual(gitOrder);
    h.s().dismissFinish(MAIN);
    expect(h.r().finish).toBeNull();
    expect(h.r().selected).toBeNull();
  });

  test('preflight blockers stop the flow before any git call', async () => {
    const h = harness();
    h.ipc.gitWorktrees.mockResolvedValue([
      { ...summary(MAIN, 'development', true), unstaged: 2 },
      summary(WT, 'feat/a', false),
    ]);
    await h.open();
    await h.s().startFinish(MAIN, WT);
    expect(h.r().finish).toMatchObject({ finished: true, aborted: false });
    expect(h.r().finish?.blockers?.map((b) => b.code)).toEqual(['main-dirty']);
    expect(h.ipc.gitMerge).not.toHaveBeenCalled();
    await h.s().startFinish(MAIN, MAIN);
    expect(h.r().finish?.blockers?.map((b) => b.code)).toEqual(['worktree-is-main']);
  });

  test('a conflict at step 1 pauses on the tracker and resumes on conflicts-cleared', async () => {
    const h = harness();
    await h.open();
    h.ipc.gitMerge.mockResolvedValueOnce({
      outcome: 'conflicts',
      head: 'bbb2222',
      conflicted: ['src/x.ts'],
    });
    h.ipc.gitStatus.mockImplementation((root: string) =>
      Promise.resolve(
        root === WT
          ? statusFor(WT, {
              state: 'merging',
              mergeHead: 'aaa1111',
              entries: [entry('src/x.ts', 'U', 'U', 'unmerged')],
            })
          : statusFor(root),
      ),
    );
    h.ipc.readTextFile.mockResolvedValue({
      text: '<<<<<<< HEAD\n=======\n>>>>>>> d\n',
      mtimeMs: 0,
    });
    await h.s().startFinish(MAIN, WT);
    await flush();
    expect(stepStatuses(h)[0]).toBe('merge-base-in:conflicts');
    expect(h.r().finish?.conflicts).toEqual(['src/x.ts']);
    expect(h.r().conflictTracker).toMatchObject({
      root: WT,
      into: 'feat/a',
      from: 'development',
      files: ['src/x.ts'],
      markerFree: { 'src/x.ts': false },
    });
    // The panel switched to the conflicted checkout.
    expect(h.r().selectedCheckout).toBe(WT);
    expect(h.r().groups.conflicted.map((e) => e.path)).toEqual(['src/x.ts']);
    // Skip is refused on a conflicts step; continueFinish does nothing (not paused).
    await h.s().skipFinishStep(MAIN);
    await h.s().continueFinish(MAIN);
    expect(stepStatuses(h)[0]).toBe('merge-base-in:conflicts');

    // The agent resolves and stages; the user presses Continue merge.
    h.ipc.readTextFile.mockResolvedValue({ text: 'resolved\n', mtimeMs: 0 });
    h.ipc.gitStatus.mockImplementation((root: string) => Promise.resolve(statusFor(root)));
    await h.s().continueMerge(MAIN);
    await flush();
    expect(h.ipc.gitCommit).toHaveBeenCalledWith(WT, null, false);
    expect(h.r().conflictTracker).toBeNull();
    expect(stepStatuses(h).slice(0, 2)).toEqual(['merge-base-in:done', 'verify:paused']);
  });

  test('a merge the agent committed itself is noticed by the watcher poke', async () => {
    const h = harness();
    await h.open();
    h.ipc.gitMerge.mockResolvedValueOnce({
      outcome: 'conflicts',
      head: 'bbb2222',
      conflicted: ['a'],
    });
    h.ipc.gitStatus.mockImplementation((root: string) =>
      Promise.resolve(
        root === WT
          ? statusFor(WT, {
              state: 'merging',
              mergeHead: 'x',
              entries: [entry('a', 'U', 'U', 'unmerged')],
            })
          : statusFor(root),
      ),
    );
    await h.s().startFinish(MAIN, WT);
    await flush();
    expect(stepStatuses(h)[0]).toBe('merge-base-in:conflicts');
    h.ipc.gitStatus.mockImplementation((root: string) =>
      Promise.resolve(root === WT ? statusFor(WT, { head: 'ccc3333' }) : statusFor(root)),
    );
    h.s().onRepoChanged([`${WT}/.git`]);
    await flush(8);
    expect(stepStatuses(h).slice(0, 2)).toEqual(['merge-base-in:done', 'verify:paused']);
    expect(h.r().conflictTracker).toBeNull();
  });

  test('an abort outside the app fails the merge step instead of advancing', async () => {
    const h = harness();
    await h.open();
    h.ipc.gitMerge.mockResolvedValueOnce({
      outcome: 'conflicts',
      head: 'bbb2222',
      conflicted: ['a'],
    });
    h.ipc.gitStatus.mockImplementation((root: string) =>
      Promise.resolve(
        root === WT
          ? statusFor(WT, {
              state: 'merging',
              mergeHead: 'x',
              entries: [entry('a', 'U', 'U', 'unmerged')],
            })
          : statusFor(root),
      ),
    );
    await h.s().startFinish(MAIN, WT);
    await flush();
    // HEAD unchanged, merge gone: aborted.
    h.ipc.gitStatus.mockImplementation((root: string) => Promise.resolve(statusFor(root)));
    h.s().onFocus();
    await flush(8);
    expect(h.r().finish?.steps[0]).toEqual({
      id: 'merge-base-in',
      status: 'failed',
      error: 'The merge was aborted outside the app',
    });
    expect(h.r().finish?.finished).toBe(false);
  });

  test('a failure at the remove step stops the flow; retry re-runs it, skip moves on', async () => {
    const h = harness();
    await h.open();
    h.ipc.gitWorktreeRemove.mockRejectedValueOnce(
      new IpcError('GIT_FAILED', "fatal: 'worktrees/a' contains modified or untracked files"),
    );
    await h.s().startFinish(MAIN, WT);
    await h.s().continueFinish(MAIN);
    expect(stepStatuses(h)).toEqual([
      'merge-base-in:done',
      'verify:done',
      'merge-into-base:done',
      'cleanup:done',
      'remove-worktree:failed',
      'delete-branch:pending',
    ]);
    expect(h.r().finish?.steps[4]?.error).toBe(
      "Git: 'worktrees/a' contains modified or untracked files",
    );
    expect(h.r().finish?.finished).toBe(false);
    expect(h.ipc.gitDeleteBranch).not.toHaveBeenCalled();

    await h.s().retryFinishStep(MAIN);
    expect(h.ipc.gitWorktreeRemove).toHaveBeenCalledTimes(2);
    expect(h.ipc.gitDeleteBranch).toHaveBeenCalledTimes(1);
    expect(h.r().finish?.finished).toBe(true);
  });

  test('a declined cleanup confirm pauses; Continue asks again; skip moves on', async () => {
    const h = harness();
    await h.open();
    (h.deps.confirm as Mock).mockResolvedValueOnce(false);
    await h.s().startFinish(MAIN, WT);
    await h.s().continueFinish(MAIN);
    expect(stepStatuses(h)[3]).toBe('cleanup:paused');
    expect(h.deps.removeWorkspace).not.toHaveBeenCalled();
    await h.s().skipFinishStep(MAIN);
    expect(stepStatuses(h)[3]).toBe('cleanup:skipped');
    expect(h.deps.confirm).toHaveBeenCalledTimes(1);
    expect(h.r().finish?.finished).toBe(true);
  });

  test('abortFinish during conflicts aborts the merge and ends the flow', async () => {
    const h = harness();
    await h.open();
    h.ipc.gitMerge.mockResolvedValueOnce({
      outcome: 'conflicts',
      head: 'bbb2222',
      conflicted: ['a'],
    });
    h.ipc.gitStatus.mockImplementation((root: string) =>
      Promise.resolve(
        root === WT
          ? statusFor(WT, {
              state: 'merging',
              mergeHead: 'x',
              entries: [entry('a', 'U', 'U', 'unmerged')],
            })
          : statusFor(root),
      ),
    );
    await h.s().startFinish(MAIN, WT);
    await h.s().abortFinish(MAIN);
    expect(h.ipc.gitMergeAbort).toHaveBeenCalledWith(WT);
    expect(h.r().conflictTracker).toBeNull();
    expect(h.r().finish).toMatchObject({ finished: true, aborted: true });
    expect(h.r().finish?.steps[0]?.status).toBe('failed');
    // A second flow may start once the first is over.
    await h.s().startFinish(MAIN, WT);
    expect(h.r().finish?.aborted).toBe(false);
  });
});
