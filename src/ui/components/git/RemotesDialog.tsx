/**
 * RemotesDialog — connecting the workspace to a repository someone made on
 * GitHub, Gitea or any other host, written for people who have never typed
 * `git remote add`. Every view is a store state (`RemotesDialog.view`):
 *
 * - connect — paste the address (a copied page URL is forgiven; the line
 *   under the field says what was understood), optionally upload right away;
 * - checking — the remote is being fetched (a sign-in window may appear);
 * - bring-in — the server already has files (a README made with the repo):
 *   bring them in, then upload;
 * - failed — why, in plain words, with Change address / Try again;
 * - list / edit — the remotes there are, change an address, disconnect.
 *
 * Settings-dialog chrome like NewWorktreeDialog; Escape closes (GitTab).
 */

import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { parseRemoteUrl } from '../../../core/git/remotes';
import type { GitRefRelation, GitRemote } from '../../../core/git/types';
import { gitStore, type RemotesDialog as Dialog } from '../../stores/git';
import { Icon, Spinner } from './icons';
import { useRepoSlice } from './shared';

/** `ann/notes on GitHub`; for a folder, its name (`notes.git` → `notes`). */
function describeUrl(url: string): string {
  const parsed = parseRemoteUrl(url);
  if ('error' in parsed || parsed.repo === null) {
    const last = url.split(/[\\/]/).filter((s) => s !== '');
    return last.at(-1)?.replace(/\.git$/i, '') ?? url;
  }
  return parsed.provider ? `${parsed.repo} on ${parsed.provider}` : parsed.repo;
}

function describe(remotes: readonly GitRemote[], name: string | null): string {
  const url = remotes.find((r) => r.name === name)?.url;
  return url ? describeUrl(url) : (name ?? 'the server');
}

/** What the pasted address was understood as — or why it was not. */
function UrlReading({ url }: { url: string }) {
  if (url.trim() === '') {
    return null;
  }
  const parsed = parseRemoteUrl(url);
  if ('error' in parsed) {
    return <p className="git-remote-reading is-bad">{parsed.error}</p>;
  }
  return (
    <p className="git-remote-reading">
      <Icon name="check" />
      {parsed.repo
        ? parsed.provider
          ? `${parsed.repo} on ${parsed.provider}`
          : parsed.repo
        : 'A folder on this computer or network'}
    </p>
  );
}

function bringInText(relation: GitRefRelation | null, where: string, branch: string): string {
  switch (relation) {
    case 'unrelated':
      return `${where} already has files in it — usually a README or licence added when the repository was created. Bring them into your workspace, then your work is uploaded alongside them.`;
    case 'unborn':
      return `${where} already has files, and this workspace has no commits yet. Bring them in to start from the server’s copy.`;
    default:
      return `${where} has changes on ${branch} that this workspace does not have yet. Bring them in first, then your work is uploaded.`;
  }
}

export function RemotesDialog({ root }: { root: string }) {
  const d = useRepoSlice(root, (r) => r.remotesDialog) ?? null;
  const remotes = useRepoSlice(root, (r) => r.remotes) ?? [];
  const op = useRepoSlice(root, (r) => r.op) ?? null;
  const actions = gitStore.getState();
  if (d === null) {
    return null;
  }
  const close = () => actions.closeRemotes(root);

  let title: string;
  let body: ReactNode;
  let footer: ReactNode;
  switch (d.view) {
    case 'connect':
    case 'edit':
      ({ title, body, footer } = formView(root, d, remotes));
      break;
    case 'checking':
      title = 'Connecting';
      body = (
        <div className="git-remote-wait">
          <Spinner title="Checking the repository" />
          <div>
            <p className="git-remote-lead">Checking {describe(remotes, d.remote)}…</p>
            <p className="git-dialog-preview">
              If a sign-in window opens, sign in there — the app never asks for your password.
            </p>
          </div>
        </div>
      );
      footer = (
        <button
          type="button"
          className="git-btn"
          disabled={op?.running !== true}
          onClick={() => actions.cancelOp(root)}
        >
          Cancel
        </button>
      );
      break;
    case 'bring-in': {
      const where = describe(remotes, d.remote);
      const branch = d.target?.slice((d.remote?.length ?? 0) + 1) ?? 'this branch';
      title = 'This repository already has files';
      body = (
        <>
          <p className="git-remote-lead">{bringInText(d.relation, where, branch)}</p>
          <p className="git-dialog-preview">
            Nothing of yours is overwritten. If the same file changed on both sides, the app shows
            it under Merge conflicts for you (or your agent) to settle.
          </p>
          {d.error && <p className="git-field-error">{d.error}</p>}
        </>
      );
      footer = (
        <>
          <button type="button" className="git-btn" disabled={d.busy} onClick={close}>
            Not now
          </button>
          <button
            type="button"
            className="git-btn git-btn-accent"
            disabled={d.busy}
            title={`git merge ${d.relation === 'unrelated' ? '--allow-unrelated-histories ' : ''}${d.target ?? ''}, then git push -u`}
            onClick={() => void actions.bringInRemote(root)}
          >
            {d.busy ? 'Bringing them in…' : 'Bring them in and upload'}
          </button>
        </>
      );
      break;
    }
    case 'failed': {
      const url = remotes.find((r) => r.name === d.remote)?.url ?? '';
      title = 'Could not connect';
      body = (
        <>
          <p className="git-remote-lead">{d.error}</p>
          {url && (
            <p className="git-dialog-preview">
              Address: <code>{url}</code>
            </p>
          )}
        </>
      );
      footer = (
        <>
          {d.remote && (
            <button
              type="button"
              className="git-btn"
              onClick={() => actions.editRemote(root, d.remote!)}
            >
              Change address
            </button>
          )}
          <span className="git-header-spacer" />
          <button type="button" className="git-btn" onClick={close}>
            Close
          </button>
          <button
            type="button"
            className="git-btn git-btn-accent"
            onClick={() => void actions.retryRemoteCheck(root)}
          >
            Try again
          </button>
        </>
      );
      break;
    }
    case 'list':
      title = 'Remotes';
      body = (
        <>
          <p className="git-dialog-preview">
            The servers this repository uploads to. Push and Pull use{' '}
            <code>{remotes.find((r) => r.name === 'origin') ? 'origin' : remotes[0]?.name}</code>.
          </p>
          <ul className="git-remote-list">
            {remotes.map((r) => (
              <li key={r.name} className="git-remote-row">
                <Icon name="cloud" />
                <div className="git-remote-text">
                  <span className="git-remote-name">
                    {describeUrl(r.url)}
                    <span className="git-chip">{r.name}</span>
                  </span>
                  <span className="git-remote-url" title={r.pushUrl ? `push: ${r.pushUrl}` : r.url}>
                    {r.url}
                  </span>
                </div>
                <button
                  type="button"
                  className="git-btn"
                  title={`git remote set-url ${r.name} …`}
                  onClick={() => actions.editRemote(root, r.name)}
                >
                  Change address
                </button>
                <button
                  type="button"
                  className="git-btn is-icon"
                  title={`Disconnect — git remote remove ${r.name}`}
                  aria-label={`Remove ${r.name}`}
                  onClick={() => void actions.removeRemote(root, r.name)}
                >
                  <Icon name="trash" />
                </button>
              </li>
            ))}
          </ul>
        </>
      );
      footer = (
        <>
          <button type="button" className="git-btn" onClick={close}>
            Close
          </button>
          <button
            type="button"
            className="git-btn git-btn-accent"
            onClick={() => actions.showRemotesView(root, 'connect')}
          >
            <Icon name="plus" />
            Connect another…
          </button>
        </>
      );
      break;
  }

  return (
    <div
      className="settings-backdrop git-dialog-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !d.busy) {
          close();
        }
      }}
    >
      <div
        className="settings-dialog git-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="settings-header">
          <h2 className="settings-title">{title}</h2>
          <button className="settings-close" aria-label="Close" onClick={close}>
            ×
          </button>
        </header>
        <div className="git-dialog-body">{body}</div>
        <footer className="git-dialog-footer">{footer}</footer>
      </div>
    </div>
  );
}

/** connect / edit: the address field (and, when there are remotes already, a name). */
function formView(
  root: string,
  d: Dialog,
  remotes: readonly GitRemote[],
): { title: string; body: ReactNode; footer: ReactNode } {
  const actions = gitStore.getState();
  const connect = d.view === 'connect';
  const canSave = !d.busy && d.url.trim() !== '' && (!connect || d.name.trim() !== '');
  const save = () => void actions.saveRemote(root);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && canSave) {
      e.preventDefault();
      save();
    }
  };
  const back = () =>
    remotes.length > 0 ? actions.showRemotesView(root, 'list') : actions.closeRemotes(root);

  const body = (
    <>
      {connect && (
        <p className="git-remote-lead">
          Create an <strong>empty</strong> repository on GitHub, Gitea or another host, copy its
          address (the <strong>Code</strong> or <strong>Clone</strong> button shows it) and paste it
          here.
        </p>
      )}
      <label className="git-field">
        <span className="git-field-label">
          {connect ? 'Repository address' : `Address of ${d.name}`}
        </span>
        <input
          className="git-input"
          type="text"
          value={d.url}
          autoFocus
          spellCheck={false}
          placeholder="https://github.com/you/notes.git"
          disabled={d.busy}
          onKeyDown={onKeyDown}
          onChange={(e) => actions.setRemotesField(root, { url: e.target.value })}
        />
        <UrlReading url={d.url} />
      </label>
      {connect && remotes.length > 0 && (
        <label className="git-field">
          <span className="git-field-label">Name — a short label for this connection</span>
          <input
            className="git-input"
            type="text"
            value={d.name}
            spellCheck={false}
            disabled={d.busy}
            onKeyDown={onKeyDown}
            onChange={(e) => actions.setRemotesField(root, { name: e.target.value.trim() })}
          />
        </label>
      )}
      {connect && (
        <label className="git-check">
          <input
            type="checkbox"
            checked={d.publish}
            disabled={d.busy}
            onChange={(e) => actions.setRemotesField(root, { publish: e.target.checked })}
          />
          Upload my work now
        </label>
      )}
      {d.error && <p className="git-field-error">{d.error}</p>}
    </>
  );
  const footer = (
    <>
      <button type="button" className="git-btn" disabled={d.busy} onClick={back}>
        {connect && remotes.length === 0 ? 'Cancel' : 'Back'}
      </button>
      <button
        type="button"
        className="git-btn git-btn-accent"
        disabled={!canSave}
        title={
          connect
            ? `git remote add ${d.name || 'origin'} <address>`
            : `git remote set-url ${d.name}`
        }
        onClick={save}
      >
        {d.busy ? (connect ? 'Connecting…' : 'Saving…') : connect ? 'Connect' : 'Save'}
      </button>
    </>
  );
  return {
    title: connect ? 'Connect to GitHub, Gitea…' : 'Change address',
    body,
    footer,
  };
}
