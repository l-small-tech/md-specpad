/**
 * Shell integration: teaching a plain shell to report its working directory.
 *
 * The app follows a terminal's `cd` through OSC 7 (`ESC ] 7 ; file://host/path
 * ESC \`), which the engine already decodes — but no stock shell emits it. So a
 * PLAIN SHELL profile (one naming no `program` of its own: the app's Shell
 * setting or the platform default) is launched with a few extra arguments that
 * wrap the user's prompt to print the sequence after every command. The wrap is
 * additive — `$PROFILE`, `~/.bashrc`, `~/.zshrc` and `config.fish` still load,
 * and the prompt looks exactly as before. A profile that names its own program
 * (an agent CLI, ssh, a shell the user configured by hand) is never touched.
 *
 * Per shell:
 *
 *   pwsh / powershell  `-NoLogo -NoExit -Command <snippet>` — the snippet is an
 *                      inline command string, not a script file, because a
 *                      stock Windows PowerShell 5 runs under a `Restricted`
 *                      execution policy that refuses every .ps1 on disk.
 *   cmd                `/K prompt $E]7;file:///$P$E\%PROMPT%` — cmd defines
 *                      `PROMPT=$P$G` at startup when nothing else did, so the
 *                      user's prompt is kept whatever it was.
 *   bash               `--rcfile <dir>/bash/bashrc` — the file sources the
 *                      files bash would have (`/etc/bash.bashrc`, `~/.bashrc`)
 *                      and then chains a `PROMPT_COMMAND`.
 *   zsh                `ZDOTDIR=<dir>/zsh` — a `.zshenv` / `.zprofile` /
 *                      `.zshrc` trio that hands straight back to the user's
 *                      own files, then adds a `precmd` hook.
 *   fish               `--init-command <function>` — a `fish_prompt` event
 *                      handler; `config.fish` runs first as usual.
 *   sh                 nothing — POSIX sh has no prompt hook to speak of.
 *
 * bash and zsh need files on disk (there is no inline form for them). The
 * texts live here as constants (`SHELL_INTEGRATION_FILES`) and the app writes
 * them under its own data dir at first use (`ui/shell-integration.ts`) — Rust
 * stays a dumb file writer. Everything in this module is pure and tested; the
 * scripts themselves were exercised against real shells by hand (see the
 * docs page and the PR notes), which is the one thing Vitest cannot do.
 */

import type { ShellKind } from './terminal-shells';

/** What a shell needs appended to its launch to report its cwd. */
export interface ShellLaunchExtras {
  /** Appended AFTER the profile's own args (`-Command` and `/K` must be last). */
  args: string[];
  /** Merged UNDER the profile's env, so a profile can still override. */
  env: Record<string, string>;
}

/** One script the app keeps on disk; `path` is relative to the scripts dir, `/`-separated. */
export interface ShellIntegrationFile {
  path: string;
  text: string;
}

/* ------------------------------------------------------------------ PowerShell */

/**
 * One line, single quotes only. The argument travels through `CreateProcess`
 * quoting (portable-pty wraps an argument with spaces in double quotes, and
 * escapes any double quote inside it) and is then re-parsed by PowerShell —
 * keeping `"` out of the snippet is what makes that round trip a non-event.
 *
 * The user's `prompt` is invoked FIRST so `$?` inside it still reflects the
 * user's last command (a prompt showing a red glyph on failure keeps working);
 * the OSC is appended only for filesystem locations — a registry or
 * certificate drive has no directory to report. `[System.Uri]::AbsoluteUri`
 * yields `file:///C:/Users/Name%20With%20Spaces`, which is exactly what the
 * app's decoder expects.
 */
export const POWERSHELL_SNIPPET = [
  "if ($function:prompt) { $Global:__MdSpecpadPrompt = $function:prompt } else { $Global:__MdSpecpadPrompt = { 'PS ' + $PWD.Path + '> ' } }",
  'function Global:prompt {',
  '$t = [string](& $Global:__MdSpecpadPrompt)',
  '$l = $ExecutionContext.SessionState.Path.CurrentLocation',
  "if ($l.Provider.Name -eq 'FileSystem') { $e = [char]27; $t = $t + $e + ']7;' + ([System.Uri]$l.ProviderPath).AbsoluteUri + $e + '\\' }",
  '$t',
  '}',
].join('; ');

/* ------------------------------------------------------------------------ cmd */

/**
 * `$E` is ESC, `$P` the current drive and path; `%PROMPT%` is expanded by cmd
 * when it parses the `/K` command, after it has defaulted the variable to
 * `$P$G` — so this composes with a user's own PROMPT and falls back to the
 * standard one. Best effort: `$P` is not percent-encoded, so a folder whose
 * name contains `%`, `#` or `?` may not decode.
 */
export const CMD_PROMPT_COMMAND = 'prompt $E]7;file:///$P$E\\%PROMPT%';

/* ----------------------------------------------------------------------- fish */

export const FISH_INIT_COMMAND =
  "function __mdn_report_cwd --on-event fish_prompt; printf '\\e]7;file://%s%s\\e\\\\' $hostname (string escape --style=url $PWD); end";

/* ----------------------------------------------------------------------- bash */

export const BASH_RCFILE_PATH = 'bash/bashrc';

const BASH_RC = [
  '# MD Specpad shell integration for bash.',
  '#',
  '# bash was started with "--rcfile <this file>", which takes the place of its',
  '# usual startup files - so the first job is to run those exactly as bash would',
  '# have. Then the prompt is taught to report the working directory to the app',
  '# (OSC 7) so it can follow "cd". Nothing about your prompt\'s look changes.',
  '#',
  '# This file is rewritten by the app; edits do not persist. To opt out, give the',
  '# terminal profile its own "program" in settings.json.',
  '',
  'if [ -r /etc/bash.bashrc ]; then . /etc/bash.bashrc; fi',
  'if [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi',
  '',
  '# Percent-encode a path for a file:// URL, byte by byte (LC_ALL=C makes the',
  '# string indexing bytewise, so UTF-8 comes out as %XX per byte).',
  '__mdn_url_encode() {',
  '  local LC_ALL=C s="$1" out="" i c',
  '  for (( i = 0; i < ${#s}; i++ )); do',
  '    c="${s:i:1}"',
  '    case "$c" in',
  '      [a-zA-Z0-9/._~:-]) out+="$c" ;;',
  '      *) printf -v c \'%%%02X\' "\'$c"; out+="$c" ;;',
  '    esac',
  '  done',
  '  printf \'%s\' "$out"',
  '}',
  '',
  '__mdn_report_cwd() {',
  '  local status=$?',
  '  local path="$PWD"',
  '  # Git Bash / MSYS: hand the app a Windows path (C:/Users/...), which is what',
  '  # its file dialogs and workspaces speak; /c/Users/... means nothing to them.',
  '  if [ -n "${MSYSTEM-}" ] && command -v cygpath >/dev/null 2>&1; then',
  '    path="/$(cygpath -m "$PWD")"',
  '  fi',
  '  printf \'\\033]7;file://%s%s\\033\\\\\' "${HOSTNAME-}" "$(__mdn_url_encode "$path")"',
  '  return $status',
  '}',
  '',
  '# Chain onto whatever PROMPT_COMMAND already is. bash 5.1+ may hold an array;',
  '# the string form is wrapped so the original still sees the real $? and its',
  '# own final status is what PS1 gets, exactly as without us.',
  'if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then',
  '  PROMPT_COMMAND+=(__mdn_report_cwd)',
  'else',
  '  __mdn_original_prompt_command="${PROMPT_COMMAND-}"',
  '  __mdn_prompt_command() {',
  '    local status=$?',
  '    if [ -n "$__mdn_original_prompt_command" ]; then',
  '      ( exit $status )',
  '      eval "$__mdn_original_prompt_command"',
  '      status=$?',
  '    fi',
  '    __mdn_report_cwd',
  '    return $status',
  '  }',
  '  PROMPT_COMMAND=__mdn_prompt_command',
  'fi',
  '',
].join('\n');

/* ------------------------------------------------------------------------ zsh */

export const ZSH_DOTDIR_PATH = 'zsh';

/**
 * The hand-back dance every file repeats: zsh reads `$ZDOTDIR/<file>`, so
 * while the user's file runs ZDOTDIR must be THEIRS (unset when it is $HOME,
 * as a stock setup has it), and afterwards ours again so zsh keeps reading
 * this folder. A custom ZDOTDIR set in `~/.zshenv` is picked up on the way;
 * one set only in the desktop environment is not (documented limitation).
 */
const ZSH_HAND_BACK =
  'if [[ "${MDN_USER_ZDOTDIR:-$HOME}" == "$HOME" ]]; then unset ZDOTDIR; else ZDOTDIR="$MDN_USER_ZDOTDIR"; fi';

const ZSH_ENV = [
  '# MD Specpad shell integration for zsh: ZDOTDIR points at this folder so the',
  '# app can add a prompt hook. Each file here hands straight back to your own.',
  '# Rewritten by the app; edits do not persist. To opt out, give the terminal',
  '# profile its own "program" in settings.json.',
  'export MDN_ZDOTDIR="$ZDOTDIR"',
  'export MDN_USER_ZDOTDIR="${MDN_USER_ZDOTDIR:-$HOME}"',
  ZSH_HAND_BACK,
  'if [[ -r "${ZDOTDIR:-$HOME}/.zshenv" ]]; then source "${ZDOTDIR:-$HOME}/.zshenv"; fi',
  '# ~/.zshenv is where a custom ZDOTDIR is usually set - follow it from here on.',
  'export MDN_USER_ZDOTDIR="${ZDOTDIR:-$HOME}"',
  'ZDOTDIR="$MDN_ZDOTDIR"',
  '',
].join('\n');

const ZSH_PROFILE = [
  "# MD Specpad shell integration (see .zshenv): run the user's .zprofile.",
  ZSH_HAND_BACK,
  'if [[ -r "${ZDOTDIR:-$HOME}/.zprofile" ]]; then source "${ZDOTDIR:-$HOME}/.zprofile"; fi',
  'ZDOTDIR="$MDN_ZDOTDIR"',
  '',
].join('\n');

const ZSH_RC = [
  "# MD Specpad shell integration (see .zshenv): run the user's .zshrc, then",
  '# report the working directory to the app after every command (OSC 7).',
  ZSH_HAND_BACK,
  'if [[ -r "${ZDOTDIR:-$HOME}/.zshrc" ]]; then source "${ZDOTDIR:-$HOME}/.zshrc"; fi',
  '# ZDOTDIR stays yours from here: .zlogin and any nested zsh read your files.',
  '',
  '__mdn_url_encode() {',
  '  local LC_ALL=C s="$1" out="" c',
  '  for c in ${(s::)s}; do',
  '    case "$c" in',
  '      [a-zA-Z0-9/._~:-]) out+="$c" ;;',
  '      *) out+="$(printf \'%%%02X\' "\'$c")" ;;',
  '    esac',
  '  done',
  '  printf \'%s\' "$out"',
  '}',
  '',
  '__mdn_report_cwd() {',
  '  printf \'\\e]7;file://%s%s\\e\\\\\' "${HOST-}" "$(__mdn_url_encode "$PWD")"',
  '}',
  '',
  'autoload -Uz add-zsh-hook',
  'add-zsh-hook precmd __mdn_report_cwd',
  '',
].join('\n');

/** Every script the app keeps on disk, in the layout the launch args expect. */
export const SHELL_INTEGRATION_FILES: readonly ShellIntegrationFile[] = [
  { path: BASH_RCFILE_PATH, text: BASH_RC },
  { path: `${ZSH_DOTDIR_PATH}/.zshenv`, text: ZSH_ENV },
  { path: `${ZSH_DOTDIR_PATH}/.zprofile`, text: ZSH_PROFILE },
  { path: `${ZSH_DOTDIR_PATH}/.zshrc`, text: ZSH_RC },
];

/** True for the shells whose integration needs `SHELL_INTEGRATION_FILES` on disk. */
export function integrationNeedsScripts(kind: ShellKind): boolean {
  return kind === 'bash' || kind === 'zsh';
}

/** `dir` + `rel` with a single `/` between — Rust and every shell normalize the rest. */
function joinScript(dir: string, rel: string): string {
  return `${dir.replace(/[\\/]+$/, '')}/${rel}`;
}

/**
 * The launch extras for a shell, or null when it gets none: `sh`, or a
 * bash/zsh with no scripts dir to point at (the write failed — the shell
 * still opens, it just cannot be followed).
 */
export function shellIntegrationLaunch(
  kind: ShellKind,
  scriptsDir: string | null,
): ShellLaunchExtras | null {
  switch (kind) {
    case 'pwsh':
    case 'powershell':
      return { args: ['-NoLogo', '-NoExit', '-Command', POWERSHELL_SNIPPET], env: {} };
    case 'cmd':
      return { args: ['/K', CMD_PROMPT_COMMAND], env: {} };
    case 'fish':
      return { args: ['--init-command', FISH_INIT_COMMAND], env: {} };
    case 'bash':
      return scriptsDir
        ? { args: ['--rcfile', joinScript(scriptsDir, BASH_RCFILE_PATH)], env: {} }
        : null;
    case 'zsh':
      return scriptsDir
        ? { args: [], env: { ZDOTDIR: joinScript(scriptsDir, ZSH_DOTDIR_PATH) } }
        : null;
    case 'sh':
      return null;
  }
}

/**
 * Fold the extras into a profile's own launch: profile args first (ours end
 * with the command-taking flag), profile env on top (a deliberate override
 * wins over our ZDOTDIR).
 */
export function withShellIntegration(
  launch: { args: string[]; env: Record<string, string> },
  extras: ShellLaunchExtras | null,
): { args: string[]; env: Record<string, string> } {
  if (!extras) {
    return launch;
  }
  return { args: [...launch.args, ...extras.args], env: { ...extras.env, ...launch.env } };
}

/**
 * `file://host/path` (OSC 7) → a plain path a pty can be spawned in, or null
 * for anything that is not a file URL. Windows drive paths arrive as
 * `file:///C:/Users/...` and cmd's unencoded `file:///C:\Users\...` — both
 * parse to a pathname of `/C:/Users/...`, whose artificial leading slash is
 * stripped. A path with a stray `%` (cmd does not encode) is kept raw rather
 * than dropped.
 */
export function pathFromFileUrl(url: string): string | null {
  let pathname: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') {
      return null;
    }
    pathname = parsed.pathname;
  } catch {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }
  return (/^\/[A-Za-z]:(\/|$)/.test(decoded) ? decoded.slice(1) : decoded) || null;
}
