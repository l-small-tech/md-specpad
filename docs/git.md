# The Git tab

If a workspace is a git repository, MD Specpad can show you its source
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

## A folder that is not a repository yet

Open the Git tab on a workspace that git does not track yet and, instead of the
repository, it shows a panel with one button: **Start tracking with Git**. That
runs `git init` in the workspace folder (the first branch is `main` unless your
git config says otherwise), reloads the tab as a repository, and puts *Initial
commit* in the message box ready for your first commit. A folder that already
sits inside a repository is left alone — nothing is nested.

### Who's making these commits?

Git stamps a name and email on every commit, and a fresh computer has none set.
When that is the case the commit box asks **Who's making these commits?** with a
name and an email field; saving writes them to your *global* git config (every
repository on this computer commits as you from then on), and the commit goes
ahead. If git refuses a commit for the same reason later, the form comes back.

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

**The inspector**, on the left, shows whatever is selected in the graph.
With nothing selected it is the working tree: the commit message box
(Ctrl+Enter commits), an **Amend** switch and **Commit** on top, then one
list of every file that differs from the last commit. Each row's checkbox
is its staging state (ticked = staged, half = partly staged, empty = not
staged) and the way to change it; the header's **Stage all** / **Unstage
all** do the whole list. Untracked files show a `?` and a dimmed name. Hover
a row to discard its changes (or delete an untracked file) — note that a
brand-new file you have staged and then edited is removed from disk by
Discard rather than reverted to the staged copy; click a row to see
its diff against the last commit. When Commit is disabled, its tooltip says
why. A **Merge conflicts** group appears above when a merge stops on
conflicts. Select a commit and the same column shows that commit instead —
its message and files; a worktree card's *vs base* shows the files its
branch changes; the Finish stepper lives here too. The bar on top (or Esc)
brings the working tree back.

**History**, on the right: the whole repository's commits as a graph, newest
first. While the selected checkout has something to commit, a dashed
**ghost row** heads the graph — the commit those changes would make, hanging
off HEAD by a dashed line — and it is the row that is selected whenever no
commit is; click it to get back to the changes after looking at a commit.
Each line of history keeps one colour and one column from its tip down to
where it joins another; a hollow node is a merge, the glowing one is where
the selected checkout stands. Pills on a commit name what points at it: a
**branch** (solid; the checked-out one filled in; a little cloud when its
remote twin is on the same commit), a **remote** branch (dashed), a **tag**,
and a **worktree** standing there (folder — click it to show that checkout).
Click a branch pill to switch to it, merge it into the current branch, or
delete it. Click the row to see the commit's message and files in the
inspector; click a file there to see what the commit did to it. **Load more
history** pages further back.

**The diff** opens under the graph when you pick a file — one of the
working tree's changes or one of a commit's files — and closes with its ×
or Esc (which steps back to the commit, then to the working tree). Drag the
divider between the graph and the diff, or between the two columns, to
resize.

**The status bar** carries the controls while a Git tab is active: a folder
button that shows or hides the workspace pane, the
current branch with its upstream (click it for the branch picker — filter,
switch, merge, delete, or type a name to create a branch here), a chip when
the checkout is in the middle of something (merging, rebasing, a detached
HEAD), then **Fetch**, **Pull** (with a count when you are behind) and
**Push** (with a count when you are ahead; **Publish** when the branch has no
upstream yet), the cloud button for **Remotes**, and refresh.

**Distraction-free** — the ⤢ at the right end of the worktree cards hides
the tab bar, exactly as it does on a document; the status bar stays, since
the branch picker and the network buttons live there. Move the mouse to the
top edge for the exit cluster (or press **Esc**), and **F11** still toggles
full screen. While chrome-less and windowed, drag the empty part of the
worktree strip to move the window.

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
- **Remove** — remove the worktree (it asks first). A worktree with
  uncommitted or untracked files is refused by git — commit or discard them
  first.

**New worktree** asks for a slug and does the whole dance: creates
`worktrees/<slug>` on `<prefix><slug>` from the base branch, makes sure
`worktrees/` is in `.gitignore`, adds the folder as a workspace, and — if you
leave the switch on — opens your harness in it, ready for a prompt.

A repository with many worktrees gets a long strip. The **Active worktrees
only** button at its end hides the clean ones — a worktree stays on the strip
while it has uncommitted changes or an operation in progress, while one of this
window's terminals is open inside it, or while its folder is missing; the main
checkout and the selected card always stay. A faint *+N clean* tally stands
where the hidden cards were; click the button again to show all. The choice is
remembered (it is the `gitActiveWorktreesOnly` setting).

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

## Connecting to GitHub, Gitea and other hosts

A repository on your computer does not upload anywhere until it is connected
to one on a server. To connect it:

1. Create a new repository on GitHub, Gitea, GitLab, Codeberg or wherever you
   keep your work. Leave it empty if the site asks; a README is fine too.
2. Copy its address. The **Code** or **Clone** button shows it, and the
   address in your browser's bar works as well.
3. In the Git tab, click **Publish** (or the cloud button) and paste the
   address. The line under the field says what the app understood, for
   example *ann/notes on GitHub*.
4. Leave **Upload my work now** ticked and click **Connect**.

The app checks the repository first. If a sign-in window opens (Git
Credential Manager on Windows and macOS), sign in there; the app itself never
asks for a password. Then:

- **The server repository is empty:** your branch is uploaded with the usual
  progress bar, and Push and Pull work from then on.
- **The server repository already has files** (usually a README or licence
  the site added): the app explains this and offers **Bring them in and
  upload**. That merges the server's files into your workspace and then
  uploads. Nothing of yours is overwritten. If the same file changed on both
  sides, it shows up under **Merge conflicts** like any other merge.
- **Your workspace has no commits yet:** it is connected, and Publish uploads
  your first commit once you make it.
- **Something went wrong** (a typo in the address, no access, no network):
  the app says what in plain words, with **Change address** and **Try again**.

The cloud button lists the connections (*remotes*) afterwards. From there
you can change an address, connect another server, or disconnect. Disconnecting
deletes nothing on the server and none of your files or commits; it only
forgets the server's branches as git last saw them (`origin/…`). Push and Pull use the one
called `origin`, or the only one there is.

## Fetch, pull and push

The three status-bar buttons stream git's output into a drawer at the bottom
of the right column, with **Cancel** while it runs. **Push** shows a progress
bar instead, with one plain sentence about what is happening (packing,
uploading, the server saving your changes); **Show log** opens git's own
output underneath. Nothing prompts for a password:
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
