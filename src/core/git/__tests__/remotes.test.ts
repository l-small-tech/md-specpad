import { describe, expect, it } from 'vitest';
import {
  connectPlan,
  parseRemoteUrl,
  publishRemote,
  remoteBranchNames,
  suggestRemoteName,
  validateRemoteName,
} from '../remotes';
import type { GitRemote } from '../types';

const remote = (name: string): GitRemote => ({ name, url: `https://x/${name}`, pushUrl: null });

describe('parseRemoteUrl', () => {
  it('takes clone addresses as they are', () => {
    expect(parseRemoteUrl('https://github.com/ann/notes.git')).toEqual({
      url: 'https://github.com/ann/notes.git',
      provider: 'GitHub',
      repo: 'ann/notes',
    });
    expect(parseRemoteUrl('  git@github.com:ann/notes.git ')).toEqual({
      url: 'git@github.com:ann/notes.git',
      provider: 'GitHub',
      repo: 'ann/notes',
    });
    expect(parseRemoteUrl('ssh://git@git.example.org:2222/ann/notes.git')).toEqual({
      url: 'ssh://git@git.example.org:2222/ann/notes.git',
      provider: 'git.example.org',
      repo: 'ann/notes',
    });
  });

  it('forgives a copied page URL', () => {
    expect(parseRemoteUrl('https://github.com/ann/notes/tree/main/docs')).toMatchObject({
      url: 'https://github.com/ann/notes',
    });
    expect(parseRemoteUrl('https://github.com/ann/notes/?tab=readme#top')).toMatchObject({
      url: 'https://github.com/ann/notes',
    });
    expect(parseRemoteUrl('https://gitea.home.lan/ann/notes/src/branch/main')).toEqual({
      url: 'https://gitea.home.lan/ann/notes',
      provider: 'gitea.home.lan',
      repo: 'ann/notes',
    });
    expect(parseRemoteUrl('https://gitlab.com/team/sub/notes/-/tree/main')).toMatchObject({
      url: 'https://gitlab.com/team/sub/notes',
      repo: 'sub/notes',
    });
  });

  it('accepts local folders', () => {
    for (const p of [
      'C:\\repos\\notes.git',
      'D:/x.git',
      '\\\\nas\\git\\n.git',
      '/srv/n.git',
      './up',
    ]) {
      expect(parseRemoteUrl(p)).toEqual({ url: p, provider: null, repo: null });
    }
    expect(parseRemoteUrl('file:///srv/n.git')).toMatchObject({ url: 'file:///srv/n.git' });
  });

  it('explains what is wrong in plain words', () => {
    const err = (s: string) => (parseRemoteUrl(s) as { error: string }).error;
    expect(err('   ')).toMatch(/Paste/);
    expect(err('https://github.com')).toMatch(/website/);
    expect(err('https://github.com/ann')).toMatch(/profile/);
    expect(err('ftp://host/a/b')).toMatch(/ftp/);
    expect(err('my notes')).toMatch(/does not look/);
    expect(err('--upload-pack=x')).toMatch(/does not look/);
    expect(err('notes')).toMatch(/https:\/\//);
  });
});

describe('remote names', () => {
  it('validates', () => {
    expect(validateRemoteName('origin', [])).toBeNull();
    expect(validateRemoteName('', [])).toMatch(/name/);
    expect(validateRemoteName('my remote', [])).toMatch(/letters/);
    expect(validateRemoteName('-x', [])).toMatch(/letters/);
    expect(validateRemoteName('a..b', [])).toMatch(/letters/);
    expect(validateRemoteName('origin', [remote('origin')])).toMatch(/already/);
  });

  it('suggests origin, then the provider, then a number', () => {
    expect(suggestRemoteName([])).toBe('origin');
    expect(suggestRemoteName([remote('origin')], 'GitHub')).toBe('github');
    expect(suggestRemoteName([remote('origin')], 'gitea.home.lan')).toBe('gitea-home-lan');
    expect(suggestRemoteName([remote('origin'), remote('github')], 'GitHub')).toBe('remote-2');
    expect(suggestRemoteName([remote('origin'), remote('remote-2')])).toBe('remote-3');
  });

  it('publishes to origin, else the first remote', () => {
    expect(publishRemote([])).toBeNull();
    expect(publishRemote([remote('a'), remote('origin')])).toBe('origin');
    expect(publishRemote([remote('a'), remote('b')])).toBe('a');
  });

  it('lists a remote’s branches without HEAD', () => {
    const branches = [
      { name: 'main', kind: 'local' as const },
      { name: 'origin/HEAD', kind: 'remote' as const },
      { name: 'origin/main', kind: 'remote' as const },
      { name: 'origin/feat/x', kind: 'remote' as const },
      { name: 'originals/main', kind: 'remote' as const },
    ];
    expect(remoteBranchNames(branches, 'origin')).toEqual(['main', 'feat/x']);
  });
});

describe('connectPlan', () => {
  it('publishes when the server holds nothing we lack', () => {
    for (const r of ['missing', 'same', 'ahead'] as const) {
      expect(connectPlan(r, false)).toEqual({ kind: 'publish' });
    }
  });
  it('brings the server’s commits in first', () => {
    expect(connectPlan('unrelated', false)).toEqual({ kind: 'bring-in', allowUnrelated: true });
    for (const r of ['behind', 'diverged', 'unborn'] as const) {
      expect(connectPlan(r, r === 'unborn')).toEqual({ kind: 'bring-in', allowUnrelated: false });
    }
  });
  it('waits for a first commit when both sides are empty', () => {
    expect(connectPlan('missing', true)).toEqual({ kind: 'first-commit' });
  });
});
