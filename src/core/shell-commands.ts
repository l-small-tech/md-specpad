/**
 * Commands the app TYPES into a shell on the user's behalf — the right-click
 * helpers on a terminal pane ("Change directory…", "Up a folder", "List
 * files", "Show hidden files", "Search in files…", "Find files by name…",
 * "Open in File Explorer", "Open <agent>"). Each must run as typed in
 * PowerShell 5 and 7 and in bash/zsh on Windows, macOS and Linux — so
 * PowerShell gets a cmdlet name wherever its alias would hit a native program
 * with other flags on macOS and Linux (`ls -Force`). The point of those helpers is to teach: what gets typed is what
 * the user would have typed, so each command is spelled the way that shell
 * expects it and quoted only when it has to be (`cd ..\src`, not
 * `cd '..\src'`).
 *
 * Everything here is pure and tested. Three quoting dialects:
 *
 *   PowerShell  single quotes, `'` doubled; `cd` (the alias of Set-Location
 *               everyone knows) with `-LiteralPath` only when the path holds
 *               a wildcard character. A program that needs quoting is invoked
 *               with `&`.
 *   cmd         double quotes when the token has a space or a metacharacter;
 *               `cd /d` so a change of drive works too.
 *   POSIX       single quotes, `'` as `'\''`; `cd --` for a name that begins
 *               with `-`. fish additionally doubles `\` inside the quotes.
 *
 * `relativePath` decides how a folder picked in the OS dialog is spelled:
 * relative when it lies in the same workspace as the pane's cwd (`cdTarget`),
 * absolute otherwise. Windows paths compare case-insensitively and never cross
 * a drive letter (or a UNC share); POSIX paths compare exactly.
 */

import type { DesktopOs, ShellKind } from './terminal-shells';
import { workspaceForPath, type WorkspaceRoot } from './tab-workspaces';

/** How paths are compared and rooted — the OS, not the shell (Git Bash on Windows walks Windows paths). */
export type PathOs = 'windows' | 'posix';

interface ParsedDir {
  /** `c:` / `//server/share` (lowercased) on Windows, `/` on POSIX. */
  root: string;
  segments: string[];
}

/** Split an absolute directory into root + normalized segments; null for a relative or unrecognized path. */
function parseDir(path: string, os: PathOs): ParsedDir | null {
  let root: string;
  let rest: string;
  if (os === 'windows') {
    const p = path.replaceAll('\\', '/');
    const drive = /^([A-Za-z]):(?:\/|$)/.exec(p);
    const unc = drive ? null : /^\/\/([^/]+)\/([^/]+)(?:\/|$)/.exec(p);
    if (drive) {
      root = `${drive[1]!.toLowerCase()}:`;
      rest = p.slice(drive[0].length);
    } else if (unc) {
      root = `//${unc[1]}/${unc[2]}`.toLowerCase();
      rest = p.slice(unc[0].length);
    } else {
      return null;
    }
  } else {
    if (!path.startsWith('/')) {
      return null;
    }
    root = '/';
    rest = path.slice(1);
  }
  const segments: string[] = [];
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return { root, segments };
}

/**
 * `toDir` relative to `fromDir`, `/`-separated (`../src/app`), or `.` when
 * they are the same folder. Null when no relative form exists: a different
 * drive or share on Windows, or an input that is not an absolute path.
 */
export function relativePath(fromDir: string, toDir: string, os: PathOs): string | null {
  const from = parseDir(fromDir, os);
  const to = parseDir(toDir, os);
  if (!from || !to || from.root !== to.root) {
    return null;
  }
  const same =
    os === 'windows'
      ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
      : (a: string, b: string) => a === b;
  let common = 0;
  while (
    common < from.segments.length &&
    common < to.segments.length &&
    same(from.segments[common]!, to.segments[common]!)
  ) {
    common++;
  }
  const parts = [
    ...Array.from({ length: from.segments.length - common }, () => '..'),
    ...to.segments.slice(common),
  ];
  return parts.length === 0 ? '.' : parts.join('/');
}

/**
 * How to spell a folder the user picked: relative to the pane's cwd when both
 * lie in the SAME open workspace (the everyday case — moving around inside a
 * project), absolute otherwise (another workspace, another drive, no cwd yet).
 */
export function cdTarget(
  cwd: string | null,
  target: string,
  roots: readonly WorkspaceRoot[],
  os: PathOs,
): { path: string; relative: boolean } {
  if (cwd) {
    const from = workspaceForPath(cwd, roots);
    const to = workspaceForPath(target, roots);
    if (from && to && from.key === to.key) {
      const relative = relativePath(cwd, target, os);
      if (relative !== null) {
        return { path: relative, relative: true };
      }
    }
  }
  return { path: target, relative: false };
}

/* --------------------------------------------------------------------- quoting */

/** Characters a token may hold and still go bare, per dialect. */
const POSIX_BARE = /^[A-Za-z0-9_./:@%+=,-]+$/;
const POWERSHELL_BARE = /^[A-Za-z0-9_.:\\/-]+$/;
const CMD_BARE = /^[A-Za-z0-9_.:\\/~=+,-]+$/;

export function quotePosix(arg: string): string {
  if (arg !== '' && POSIX_BARE.test(arg)) {
    return arg;
  }
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * fish is POSIX quoting with one twist: inside single quotes `\\` still
 * collapses to `\`, so a backslash (a regex's `\.`) has to be doubled.
 */
export function quoteFish(arg: string): string {
  if (arg !== '' && POSIX_BARE.test(arg)) {
    return arg;
  }
  return `'${arg.replaceAll('\\', '\\\\').replaceAll("'", `'\\''`)}'`;
}

/** PowerShell also closes a single-quoted string on the typographic quotes `‘ ’ ‚ ‛`. */
const POWERSHELL_QUOTES = /['‘’‚‛]/g;

export function quotePowerShell(arg: string): string {
  if (arg !== '' && POWERSHELL_BARE.test(arg)) {
    return arg;
  }
  return `'${arg.replace(POWERSHELL_QUOTES, (quote) => quote + quote)}'`;
}

/** cmd has no escape for `"` inside a quoted token — and no Windows path can contain one. */
export function quoteCmd(arg: string): string {
  if (arg !== '' && CMD_BARE.test(arg)) {
    return arg;
  }
  return `"${arg}"`;
}

/** Quote one word — a program argument — for a shell. */
export function quoteArg(kind: ShellKind, arg: string): string {
  switch (kind) {
    case 'pwsh':
    case 'powershell':
      return quotePowerShell(arg);
    case 'cmd':
      return quoteCmd(arg);
    case 'fish':
      return quoteFish(arg);
    default:
      return quotePosix(arg);
  }
}

/**
 * Quote a word that should LOOK quoted even when it needs nothing — a regex
 * or a name the user typed. Quoting a pattern is the habit worth teaching:
 * the next one will hold a `|` or a `$`. Null when cmd cannot represent it
 * (a `"` has no escape inside cmd's double quotes).
 */
function quoteAlways(kind: ShellKind, arg: string): string | null {
  switch (kind) {
    case 'pwsh':
    case 'powershell':
      return `'${arg.replace(POWERSHELL_QUOTES, (quote) => quote + quote)}'`;
    case 'cmd':
      return arg.includes('"') ? null : `"${arg}"`;
    case 'fish':
      return `'${arg.replaceAll('\\', '\\\\').replaceAll("'", `'\\''`)}'`;
    default:
      return `'${arg.replaceAll("'", `'\\''`)}'`;
  }
}

/** True for the shells that read `\` as the path separator. */
function windowsStyle(kind: ShellKind): boolean {
  return kind === 'pwsh' || kind === 'powershell' || kind === 'cmd';
}

/** A path spelled with the separator that shell's users write. */
export function shellPath(kind: ShellKind, path: string): string {
  return windowsStyle(kind) ? path.replaceAll('/', '\\') : path.replaceAll('\\', '/');
}

/* -------------------------------------------------------------------- commands */

/** `cd` into a folder — the form a user of that shell should learn. */
export function cdCommand(kind: ShellKind, path: string): string {
  const target = shellPath(kind, path);
  switch (kind) {
    case 'pwsh':
    case 'powershell': {
      // A bare word starting with `-` would parse as a parameter name, and
      // Set-Location's -Path treats `[`, `]`, `*` and `?` as wildcards.
      const quoted = target.startsWith('-') ? `'${target}'` : quotePowerShell(target);
      return /[[\]*?]/.test(target) ? `cd -LiteralPath ${quoted}` : `cd ${quoted}`;
    }
    case 'cmd':
      return `cd /d ${quoteCmd(target)}`;
    default: {
      const quoted = quoteArg(kind, target);
      return target.startsWith('-') ? `cd -- ${quoted}` : `cd ${quoted}`;
    }
  }
}

/** Up one folder. The one command every shell spells the same. */
export function upCommand(): string {
  return 'cd ..';
}

/** The directory listing a user of that shell would type. */
export function listCommand(kind: ShellKind): string {
  switch (kind) {
    case 'pwsh':
    case 'powershell':
      return 'ls';
    case 'cmd':
      return 'dir';
    default:
      return 'ls -l';
  }
}

/**
 * The listing with hidden files too (dotfiles, `.git`, `.env`). PowerShell
 * gets the cmdlet's own name: on macOS and Linux `ls` there is the native
 * one, which has no `-Force`.
 */
export function listAllCommand(kind: ShellKind): string {
  switch (kind) {
    case 'pwsh':
    case 'powershell':
      return 'Get-ChildItem -Force';
    case 'cmd':
      return 'dir /a';
    default:
      return 'ls -la';
  }
}

/** The desktop's file manager, as the menu names it. */
export function fileManagerName(os: DesktopOs): string {
  switch (os) {
    case 'windows':
      return 'File Explorer';
    case 'mac':
      return 'Finder';
    case 'linux':
      return 'file manager';
  }
}

/**
 * Open the current folder in the desktop's file manager. Which program does
 * that is the OS's business, not the shell's — except that Git Bash and WSL
 * reach Windows programs only by their `.exe` name.
 */
export function openFolderCommand(kind: ShellKind, os: DesktopOs): string {
  switch (os) {
    case 'windows':
      return windowsStyle(kind) ? 'explorer .' : 'explorer.exe .';
    case 'mac':
      return 'open .';
    case 'linux':
      return 'xdg-open .';
  }
}

/** What the search helper looks at: file CONTENTS (grep) or file NAMES (find). */
export type SearchTarget = 'contents' | 'names';

export interface SearchOptions {
  target: SearchTarget;
  /** Case-sensitive match; off by default, as people search. */
  matchCase: boolean;
}

/**
 * Search the current folder, recursively, for a regular expression — in the
 * files' text or in their paths. Null when there is nothing to search for or
 * the shell cannot spell the pattern (a `"` in cmd).
 *
 *   POSIX       grep -rniE --exclude-dir=.git 'TODO|FIXME' .
 *               find . -type f -not -path '*\/.git/*' | grep -iE '\.test\.ts$'
 *   PowerShell  Get-ChildItem -Recurse -File | Select-String -Pattern 'TODO|FIXME'
 *               Get-ChildItem -Recurse -File -Name | Select-String -Pattern '\.test\.ts$'
 *   cmd         findstr /s /n /i /r /c:"TODO" *
 *               dir /s /b /a-d | findstr /i /r /c:"\.test\.ts$"
 *
 * The dialects differ — grep -E is POSIX extended (no `\d`: use `[0-9]`),
 * PowerShell is .NET, findstr knows only `. * ^ $ [ ]` — but the everyday
 * pattern (`TODO|FIXME`, `\.md$`, `^import`) means the same in grep and
 * PowerShell. Both skip `.git`: PowerShell does not recurse into hidden
 * folders, grep and find are told to. A name search matches the path from
 * the current folder, so `src/.*\.ts$` works as well as `\.ts$`.
 */
export function searchCommand(
  kind: ShellKind,
  pattern: string,
  { target, matchCase }: SearchOptions,
): string | null {
  if (pattern === '') {
    return null;
  }
  const quoted = quoteAlways(kind, pattern);
  if (quoted === null) {
    return null;
  }
  switch (kind) {
    case 'pwsh':
    case 'powershell': {
      const files =
        target === 'names' ? 'Get-ChildItem -Recurse -File -Name' : 'Get-ChildItem -Recurse -File';
      const sensitive = matchCase ? ' -CaseSensitive' : '';
      return `${files} | Select-String -Pattern ${quoted}${sensitive}`;
    }
    case 'cmd': {
      const insensitive = matchCase ? '' : ' /i';
      return target === 'names'
        ? `dir /s /b /a-d | findstr${insensitive} /r /c:${quoted}`
        : `findstr /s /n${insensitive} /r /c:${quoted} *`;
    }
    default: {
      // A pattern starting with `-` would read as an option without `-e`.
      const expr = pattern.startsWith('-') ? `-e ${quoted}` : quoted;
      const i = matchCase ? '' : 'i';
      return target === 'names'
        ? `find . -type f -not -path ${quoteAlways(kind, '*/.git/*')} | grep -${i}E ${expr}`
        : `grep -rn${i}E --exclude-dir=.git ${expr} .`;
    }
  }
}

/**
 * A program with its arguments as one typed line. PowerShell needs the call
 * operator for a quoted program (`& 'C:\Tools\my agent.exe' --fast`); the
 * others just quote the token.
 */
export function quoteCommand(kind: ShellKind, program: string, args: readonly string[]): string {
  const words = args.map((arg) => quoteArg(kind, arg));
  let head: string;
  if (kind === 'pwsh' || kind === 'powershell') {
    const quoted = quotePowerShell(program);
    head = quoted === program ? program : `& ${quoted}`;
  } else {
    head = quoteArg(kind, program);
  }
  return [head, ...words].join(' ');
}
