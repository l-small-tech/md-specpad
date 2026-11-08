/**
 * Agent instruction files — `CLAUDE.md`, `GEMINI.md`, `AGENTS.md` — and the
 * `@path` import lines they carry.
 *
 * Coding agents read these files from the folder they work in, and each lets
 * a line such as `@AGENTS.md` or `@docs/style.md` pull another file in. The
 * raw editor lights those tokens up (editors/agent-imports.ts) when the open
 * file is one of these by name; this module decides which files and which
 * tokens, and nothing else.
 */

/** Base names of the files agents read, as the tools spell them. */
export const AGENT_FILE_NAMES = ['CLAUDE.md', 'GEMINI.md', 'AGENTS.md'] as const;

const AGENT_NAMES_LOWER = new Set<string>(AGENT_FILE_NAMES.map((n) => n.toLowerCase()));

/**
 * True when `path` (any separator style; null/undefined for an unsaved note)
 * names one of the agent files, case-insensitively — Windows and macOS do not
 * tell `claude.md` from `CLAUDE.md`, so neither do we.
 */
export function isAgentFilePath(path: string | null | undefined): boolean {
  if (!path) {
    return false;
  }
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  return AGENT_NAMES_LOWER.has(base.toLowerCase());
}

/**
 * An `@path` import token: `@` at the start of a line or right after
 * whitespace or an opening parenthesis, followed by a path — a run of path
 * characters with no spaces. The boundary rule keeps e-mail addresses
 * (`ann@example.com`) and mid-word `@` out. Trailing sentence punctuation is
 * left outside the token so `see @docs/x.md.` keeps its full stop. Global so
 * a `MatchDecorator` can walk a document with it; callers that use `exec`
 * must reset `lastIndex`.
 */
export const AGENT_IMPORT_RE = /(?<=^|[\s(])@(?:~|\.{1,2})?\/?[\w.-][\w./\\~-]*(?<![.,;:!?])/gmu;

/** Every import token in `text`, in order — the `@path` text each time. */
export function agentImports(text: string): string[] {
  return Array.from(text.matchAll(AGENT_IMPORT_RE), (m) => m[0]);
}
