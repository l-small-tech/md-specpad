# The Git tab

If a workspace is a git repository, MD Notepad can show you its source
control in a tab of its own: what changed, what is committed, which branches
and worktrees exist, and the buttons to move work along. It is built for
working with AI agents — several of them at once, each in its own worktree —
without ever leaving the app or pasting commands into a terminal.

The Git tab is available on Windows, macOS and Linux (not Android) and needs
`git` on your PATH. It never types into a terminal on your behalf: every
action runs git directly, and the two "terminal" buttons only open a shell
or your AI agent in the right folder.

## Opening it

Any of these opens the repository's tab, or brings it to the front if it is
already open:

- Right-click a workspace heading in the sidebar → **Git**.
- Command palette (Ctrl+K) → **Git: source control**.
- **Ctrl+Shift+G** (⇧⌘G on a Mac) — for the repository of whatever tab you
  are looking at.

There is one Git tab per repository, however many workspaces or worktrees of
it you have. It survives restarts like any other tab, and tears off into a
second window like any other tab.

## The layout

The tab is a picture of the repository, top to bottom:

**Worktree cards** run across the top — the main folder first, then every
linked worktree. A card is the checkout picker: click one and the panel
shows that checkout's changes and branch. Each card shows its branch (with a
*base* chip on the base branch), a bar of what is dirty there (staged in the
accent, changed in amber, untracked in grey, conflicted in red) or *clean*,
two small meters for how far the branch is ahead of and behind the base
branch, a dot when one of this window's terminals is standing inside it, and
chips for *merging*, *missing* or *locked*. The actions appear on the card
you hover or have selected; the dashed card at the end is **New worktree**.

**Changes**, on the left: staged, unstaged and untracked files in three
groups. Hover a row for stage / unstage / discard / open; the group headers
stage or unstage everything at once. Click a row to see its diff. Below the
groups: the commit message box (Ctrl+Enter commits), an **Amend** switch,
and **Commit**. When Commit is disabled, its tooltip says why. A **Merge
conflicts** group appears above when a merge stops on conflicts.

**History**, on the right: the whole repository's commits as a graph, newest
first. Each line of history keeps one colour and one column from its tip
down to where it joins another; a hollow node is a merge, the glowing one
is where the selected checkout stands. Pills on a commit name what points
at it: a **branch** (solid; the checked-out one filled in; a little cloud
when its remote twin is on the same commit), a **remote** branch (dashed),
a **tag**, and a **worktree** standing there (folder — click it to show that
checkout). Click a branch pill to switch to it, merge it into the current
branch, or delete it. Click the row to see the commit's message and files;
click a file to see what the commit did to it. **Load more history** pages
further back.

**The detail** opens under the graph when you select something — a file's
diff, a commit, a worktree's files against the base branch, or the Finish
stepper — and closes with its × or Esc. Drag the divider between the graph
and the detail, or between the two columns, to resize.

**The status bar** carries the controls while a Git tab is active: the
current branch with its upstream (click it for the branch picker — filter,
switch, merge, delete, or type a name to create a branch here), a chip when
the checkout is in the middle of something (merging, rebasing, a detached
HEAD), then **Fetch**, **Pull** (with a count when you are behind) and
**Push** (with a count when you are ahead; **Publish** when the branch has no
upstream yet), and refresh.

## Worktrees

A git worktree is a second folder checked out from the same repository on its
own branch. It is how several agents can work in parallel without stepping on
each other, and it is what the **Git worktree workflow** directive in
*Initialize workspace* tells agents to do: `worktrees/<slug>` on
`feat/<slug>`.

The worktree cards across the top show every checkout: its branch, what is
dirty, how far it is ahead of or behind the base branch, and a dot when one
of this window's terminals is standing inside it. Each card offers:

- **Open as workspace** — add the folder to the sidebar so you can browse and
  edit its files.
- **Terminal here** / **Harness here** — open a shell, or your AI agent, in
  that folder. Nothing is typed into it.
- **Diff vs base** — the files the branch changed since it left the base.
- **Merge** — the base into this branch (to catch up), or this branch into
  the base (in the main checkout).
- **Finish…** — the guided end of a worktree, below.
- **Remove** — remove the worktree. A dirty one is refused; you can force it.

**New worktree** asks for a slug and does the whole dance: creates
`worktrees/<slug>` on `<prefix><slug>` from the base branch, makes sure
`worktrees/` is in `.gitignore`, adds the folder as a workspace, and — if you
leave the switch on — opens your harness in it, ready for a prompt.

### Finishing a worktree

**Finish…** walks the steps the directive asks agents for, one at a time,
and pauses wherever you are needed:

1. Merge the base branch into the worktree's branch.
2. **Verify** — a pause. Open a terminal in the worktree, run the build and
   the tests, then **Continue** (or **Skip**).
3. Merge the branch into the base, in the main checkout.
4. Clean up — close the terminals inside the worktree and drop its workspace
   entry (it asks first).
5. Remove the worktree.
6. Delete the branch.

If a step fails, the stepper shows git's message with **Retry** and **Abort**.
If a merge hits conflicts, the flow pauses on the conflict actions below and
carries on by itself once the merge is committed. Before starting, the flow
checks that the main checkout is on the base branch and clean, and that the
worktree is clean; if not, it lists what to settle first.

## Merge conflicts — hand them to your agent

When a merge or a pull stops on conflicts, a **Merge conflicts** section
appears with the files, and the primary button is **Copy conflict prompt**.
It puts a short brief on the clipboard: which branch is merging into which,
the conflicted files, the rule to keep both sides' behaviour (the other
change is another agent's intentional work), and how to finish — remove the
markers, re-verify, `git add` each file, and *not* commit. Paste it into your
agent (**Harness here** opens one in the right folder).

The panel watches the files as the agent works: each row flips from
*markers* to *clean*, and **Continue merge** becomes available once every
file is staged and marker-free. **Abort merge** puts everything back. If you
would rather do a file by hand, click it: it opens as plain text with the
conflict markers, and **Mark resolved** stages it when you are done.

## Fetch, pull and push

The three status-bar buttons stream git's output into a drawer at the bottom
of the right column, with **Cancel** while it runs. Nothing prompts for a password:
if git needs credentials, a credential helper with its own window (Git
Credential Manager on Windows and macOS) or an SSH agent answers, and if
nothing does the drawer shows git's message with a one-line reading of it —
for example that no credential helper is set up, or that you need to pull
first. The fix is always something to do in your own terminal or settings;
the app will not run it for you.

## What the app never does

- It never types or pastes into a terminal. **Terminal here** and **Harness
  here** open a shell or an agent in a folder, and stop there.
- It never resolves a conflict for you or edits your files: the agent, or
  you, do that.
- It never force-pushes, rebases, stashes or rewrites history. Those stay in
  your terminal for now.
