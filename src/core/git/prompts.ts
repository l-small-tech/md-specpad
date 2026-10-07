/**
 * The conflict prompt — what "Copy conflict prompt" puts on the clipboard for
 * the user to paste into their agent. Pure; no DOM, no Tauri, no React.
 *
 * Same voice as the app's other agent briefs: the task, the facts the
 * agent would otherwise have to discover (where, what is merging into what,
 * which files), the rules, and a trailing machine-readable line
 * (`Merge-context:`) so the agent can report against it. The rule about
 * keeping both sides is the worktree directive's own wording
 * (`workspace-module-texts.ts`, `WORKTREES_DIRECTIVE` step 4), and the
 * finishing rule stops short of the commit: the user reviews and presses
 * Continue in the app.
 */

import { checkoutKey } from './checkouts';

export interface ConflictPromptInput {
  /** The repository's main checkout. */
  mainRoot: string;
  /** The checkout the merge is running in (may equal `mainRoot`). */
  checkoutPath: string;
  /** Branch names as the panel shows them. */
  into: string;
  from: string;
  /** Paths git reported unmerged, relative to `checkoutPath`. */
  files: readonly string[];
}

/** The rule quoted from the worktree directive. */
export const KEEP_BOTH_SIDES_RULE =
  "keeping both sides' behavior (the other change is another agent's intentional work)";

export function conflictPrompt(input: ConflictPromptInput): string {
  const inMain = checkoutKey(input.checkoutPath) === checkoutKey(input.mainRoot);
  const where = inMain
    ? `${input.checkoutPath} (the main checkout)`
    : `${input.checkoutPath} (a linked worktree of ${input.mainRoot})`;
  const fileList = input.files.map((f) => `- ${f}`).join('\n');
  const n = input.files.length;
  return `# Resolve merge conflicts

Working directory: ${where}

A \`git merge\` of \`${input.from}\` into \`${input.into}\` stopped on conflicts in ${n === 1 ? 'this file' : `these ${n} files`}:

${fileList}

Do this:

1. Open each file above and resolve every \`<<<<<<<\` / \`=======\` / \`>>>>>>>\` block, ${KEEP_BOTH_SIDES_RULE}. Read enough surrounding code to merge the intent of both changes, not just the lines.
2. Change nothing outside the conflict blocks, and do not reformat the rest of the file.
3. When every marker is gone, re-verify: run the project's build and tests and fix anything the merge broke.
4. Run \`git add -- <file>\` for each resolved file.
5. Do NOT commit, and do not run \`git merge --abort\`, \`git reset\`, \`git checkout\` or \`git stash\`. The user reviews the result and continues the merge from their editor.

Report which files you resolved and anything you were unsure about.

Merge-context: ${input.checkoutPath} into=${input.into} from=${input.from}
`;
}
