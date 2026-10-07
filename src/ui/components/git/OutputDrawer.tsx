/**
 * OutputDrawer — the bottom of the detail column while a fetch / pull / push
 * exists: git's streamed lines (stderr dimmed — that is where progress goes),
 * the one-line reading of a failure as text (a selectable `<code>`, never a
 * button that would run something), Cancel while it runs, Dismiss after.
 *
 * A push reads differently: a progress bar and one plain sentence
 * (core/git/push-progress.ts), with git's own lines behind "Show log" — the
 * people pressing Push are often the ones git's output means least to.
 */

import { useEffect, useRef, useState } from 'react';
import { firstGitLine } from '../../../core/git/hints';
import { pushProgress } from '../../../core/git/push-progress';
import { gitStore, type GitOpState } from '../../stores/git';
import { Icon, Spinner } from './icons';
import { useRepoSlice } from './shared';

const TAIL = 200;

export function OutputDrawer({ root }: { root: string }) {
  const op = useRepoSlice(root, (r) => r.op) ?? null;
  if (op === null) {
    return null;
  }
  if (op.kind === 'push') {
    return <PushCard root={root} op={op} />;
  }
  const actions = gitStore.getState();
  const label = op.kind === 'fetch' ? 'Fetch' : 'Pull';
  const outcome = op.running
    ? `${label}…`
    : op.error
      ? `${label} — ${op.error}`
      : op.result?.ok
        ? `${label} done`
        : `${label} failed${op.result?.exitCode != null ? ` (exit ${op.result.exitCode})` : ''}`;
  const failed = !op.running && (op.error !== null || op.result?.ok === false);

  return (
    <div className={`git-drawer${failed ? ' is-failed' : ''}`} role="log" aria-live="polite">
      <div className="git-drawer-head">
        {op.running && <Spinner title={outcome} />}
        <span className="git-drawer-title">{outcome}</span>
        <span className="git-header-spacer" />
        {op.running ? (
          <button
            type="button"
            className="git-btn"
            title="Stop git"
            onClick={() => actions.cancelOp(root)}
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="git-btn"
            title="Close this output"
            onClick={() => actions.dismissOp(root)}
          >
            Dismiss
          </button>
        )}
      </div>
      <OpLog op={op} />
      {op.hint && (
        <p className="git-drawer-hint">
          <code>{op.hint}</code>
        </p>
      )}
    </div>
  );
}

/** git's streamed lines, following the tail while they arrive. */
function OpLog({ op }: { op: GitOpState }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const lineCount = op.lines.length;

  useEffect(() => {
    const el = bodyRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lineCount]);

  const lines = op.lines.slice(-TAIL);
  return (
    <div className="git-drawer-body" ref={bodyRef}>
      {lines.length === 0 ? (
        <div className="git-drawer-line is-err">{op.running ? 'Waiting for git…' : ''}</div>
      ) : (
        lines.map((line, i) => (
          <div key={i} className={`git-drawer-line${line.stream === 'err' ? ' is-err' : ''}`}>
            {line.text}
          </div>
        ))
      )}
    </div>
  );
}

function PushCard({ root, op }: { root: string; op: GitOpState }) {
  const upstream = useRepoSlice(root, (r) => r.status?.upstream) ?? null;
  const [showLog, setShowLog] = useState(false);
  const actions = gitStore.getState();

  const cancelled = op.error === 'Cancelled';
  const failed = !op.running && !cancelled && (op.error !== null || op.result?.ok === false);
  const succeeded = !op.running && op.error === null && op.result?.ok === true;
  const progress = pushProgress(op.lines, succeeded);
  const where = upstream ?? 'the remote';

  const title = op.running
    ? upstream
      ? `Pushing to ${upstream}`
      : 'Publishing your branch'
    : succeeded
      ? progress.upToDate
        ? `Already up to date with ${where}`
        : `Pushed to ${where}`
      : cancelled
        ? 'Push cancelled'
        : 'Push didn’t finish';
  const detail = op.running
    ? progress.step
    : succeeded
      ? progress.upToDate
        ? 'There was nothing new to send.'
        : 'Your commits are saved on the server.'
      : cancelled
        ? 'Nothing more was sent.'
        : (op.hint ??
          op.error ??
          (firstGitLine(op.result?.stderr ?? '') || 'Git stopped before the push finished.'));
  const percent = op.running ? progress.percent : succeeded ? 100 : (progress.percent ?? 100);
  const state = op.running
    ? ''
    : succeeded
      ? ' is-done'
      : cancelled
        ? ' is-cancelled'
        : ' is-failed';

  return (
    <div className={`git-drawer git-push${state}`}>
      <div className="git-push-head" role="status" aria-live="polite">
        <Icon
          name={succeeded ? 'check' : failed ? 'close' : 'cloud-up'}
          className="git-push-icon"
        />
        <span className="git-push-title">{title}</span>
        {op.running && percent !== null && <span className="git-push-pct">{percent}%</span>}
        <span className="git-header-spacer" />
        <button
          type="button"
          className="git-btn"
          title="Show what git printed"
          aria-expanded={showLog}
          onClick={() => setShowLog((v) => !v)}
        >
          {showLog ? 'Hide log' : 'Show log'}
        </button>
        {op.running ? (
          <button
            type="button"
            className="git-btn"
            title="Stop the push"
            onClick={() => actions.cancelOp(root)}
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="git-btn"
            title="Close this"
            onClick={() => actions.dismissOp(root)}
          >
            Dismiss
          </button>
        )}
      </div>
      <div
        className="settings-progress git-push-bar"
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <div
          className={`settings-progress-bar${percent === null ? ' settings-progress-indeterminate' : ''}`}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      <p className="git-push-detail">{detail}</p>
      {showLog && <OpLog op={op} />}
    </div>
  );
}
