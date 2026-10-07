# Terminal tabs

A terminal tab (desktop only) puts a real shell — or an AI coding agent —
right next to your notes. Open one from the **+ ⌄** picker next to the tabs,
from the sidebar's right-click **New** page (it starts in that folder), or with
the `+` button while a terminal is in front (it makes another of whatever kind
of tab is in front). This page covers the two things that make
a terminal tab feel like part of the notepad: it *knows where it is*, and it
can *type for you*.

## The tab wears its workspace's color

Every tab is colored by the workspace its file lives in — the same accent the
sidebar section wears. A terminal tab does the same, using the folder its shell
is currently standing in:

- Open a terminal in a workspace → the tab takes that workspace's color.
- Type `cd` into a folder that belongs to another workspace → the tab changes
  color to match, as soon as the prompt comes back.
- `cd` somewhere outside every open workspace (your home folder, another
  drive) → the tab shows no color at all.

With a split terminal, the tab follows the pane that has the keyboard. Hover the
tab to see the folder in its tooltip. If **Settings → Arrange tabs by
workspace** is on, a terminal that moves into a workspace is slotted in next to
that workspace's other tabs, just like a newly opened file.

### How the app knows where the shell is

Shells don't normally tell a terminal their current folder, so the app adds a
tiny bit of *shell integration* when it starts a plain shell: it wraps your
prompt so that, after every command, the shell also prints an invisible
message (`OSC 7`) naming the folder. Nothing about your prompt's appearance
changes, and your own startup files still run — `$PROFILE` in PowerShell,
`~/.bashrc`, `~/.zshrc`, `config.fish`.

What is added, per shell:

| Shell                                 | What the app passes                                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| PowerShell 7 / Windows PowerShell 5   | `-NoLogo -NoExit -Command <a one-line snippet>` that wraps the existing `prompt` function                                      |
| Command Prompt (cmd)                  | `/K prompt $E]7;file:///$P$E\%PROMPT%` — your `PROMPT` is kept, with the folder report in front                               |
| bash                                  | `--rcfile <app data>/shell-integration/bash/bashrc` — a file that runs `/etc/bash.bashrc` and `~/.bashrc`, then adds a `PROMPT_COMMAND` |
| zsh                                   | `ZDOTDIR=<app data>/shell-integration/zsh` — its `.zshenv`/`.zprofile`/`.zshrc` hand straight back to yours, then add a `precmd` hook |
| fish                                  | `--init-command` defining a `fish_prompt` event handler                                                                       |
| sh / dash                             | nothing (no prompt hook exists)                                                                                               |

`<app data>` is the app's own data folder (the same place as `settings.json`);
the scripts there are rewritten by the app, so don't edit them.

This only ever applies to the **plain shell**: the profile that runs whatever
**Settings → Terminal → Shell** says (or the platform default). A terminal
profile in `settings.json` that names its own `program` — an AI agent, `ssh`,
a shell you configured by hand — is started exactly as written, with nothing
added. That is also the way to opt out: give the shell profile an explicit
`program`.

Known limits: cmd doesn't encode its path, so a folder whose name contains
`%`, `#` or `?` may not be recognized; a zsh `ZDOTDIR` that is set only by
your desktop environment (rather than in `~/.zshenv`) isn't followed; Git Bash
reports Windows-style paths (`C:/Users/...`) so the app can match them to your
workspaces.

## Right-click helpers: let the app type for you

If the shell feels intimidating, right-click inside a terminal pane. Below
Copy / Paste you'll find three helpers. Each one **types an ordinary command at
the prompt and presses Enter** — nothing hidden, exactly what you would have
typed, so you can watch and learn it. Hover an item and its tooltip spells the
command out.

- **Change directory…** — opens the system folder picker, starting at the
  shell's current folder. Pick one and the app types `cd` to it: a *relative*
  path when the folder is inside the workspace you're already in (`cd ..\docs`
  in PowerShell, `cd ../docs` in bash), the full path otherwise. Spaces and
  odd characters are quoted the way that shell wants (`cd 'C:\My Notes'`,
  `cd /d "C:\My Notes"` in cmd).
- **List files** — types `ls` (PowerShell), `dir` (cmd) or `ls -l` (bash,
  zsh, fish).
- **Open Claude** (or whichever harness **Settings → Harness** names) — types the
  agent's command line so it starts in the current folder.

The helpers appear only when there is a prompt to type at: on a plain shell,
and not while a full-screen program (an agent, `vim`, `less`) has taken over
the pane. On a harness tab you get the usual Copy / Paste / Split menu without
them.
