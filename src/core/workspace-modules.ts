/**
 * Initialize Workspace — composing AGENTS.md out of modular directives
 * (pure; tested).
 *
 * A MODULE is one directive (a markdown section) plus the files it needs
 * seeded. Built-ins ship here; any `.md` in the user's modules folder becomes
 * one too (`userModuleFrom`). The chosen modules are written INLINE into
 * AGENTS.md — the one file every harness reads — each between a pair of
 * markers:
 *
 *     <!-- module:changelog -->
 *     ## Changelog
 *     …
 *     <!-- /module:changelog -->
 *
 * so the dialog can be re-run on a live workspace: `composeAgentsFile`
 * refreshes the marked blocks it is given, removes marked blocks it is not,
 * and never touches a byte outside the markers. `installedModuleIds` reads
 * the current selection back.
 *
 * `planWorkspaceInit` turns a selection into the file writes. Seed files are
 * create-only — re-running never overwrites a manifest or changelog that has
 * since been filled in; a seed marked `refresh: true` is the app's own and
 * is rewritten on every run.
 *
 * `RETIRED_MODULE_IDS` are modules the app no longer ships. Passing them in
 * `knownIds` makes a re-run drop their blocks instead of keeping them as
 * unknown user text.
 */

import {
  CHANGELOG_DIRECTIVE,
  CHANGELOG_SEED,
  LESSONS_DIRECTIVE,
  LESSONS_SEED,
  MANIFEST_DIRECTIVE,
  MANIFEST_SEED,
  MARP_DECKS_DIRECTIVE,
  TODO_DIRECTIVE,
  TODO_SEED,
  WORKTREES_DIRECTIVE,
} from './workspace-module-texts';
import { EXAMPLE_DECK, EXAMPLE_DECK_PATH } from './deck-template';
import { appendMissingLines } from './git/worktree-plan';

export interface SeedFile {
  /** Workspace-relative, forward slashes. */
  path: string;
  text: string;
  /** Overwrite on re-run (app-owned files only). Default: create-only. */
  refresh?: boolean;
  /** Append these lines to the file when it exists and lacks them (.gitignore). */
  ensureLines?: boolean;
}

export interface WorkspaceModule {
  id: string;
  title: string;
  /** One line for the checklist. */
  description: string;
  /** The markdown written between the markers. */
  directive: string;
  files: SeedFile[];
  /** Ticked by default in a fresh dialog (currently none: the user opts in). */
  recommended: boolean;
  source: 'builtin' | 'user';
}

/** Built-in modules since removed; their blocks are dropped on a re-run. */
export const RETIRED_MODULE_IDS: readonly string[] = ['prompt-status'];

export const BUILTIN_MODULES: readonly WorkspaceModule[] = [
  {
    id: 'manifest',
    title: 'File manifest',
    description: 'Agents keep MANIFEST.md — what every file is for — and read it before exploring.',
    directive: MANIFEST_DIRECTIVE,
    files: [{ path: 'MANIFEST.md', text: MANIFEST_SEED }],
    recommended: false,
    source: 'builtin',
  },
  {
    id: 'changelog',
    title: 'Changelog',
    description: 'Agents add a line to CHANGELOG.md for every change you would notice.',
    directive: CHANGELOG_DIRECTIVE,
    files: [{ path: 'CHANGELOG.md', text: CHANGELOG_SEED }],
    recommended: false,
    source: 'builtin',
  },
  {
    id: 'todo',
    title: 'TODO list',
    description:
      'TODO.md is a checklist you and your agents share: they read it, tick items off and log follow-ups.',
    directive: TODO_DIRECTIVE,
    files: [{ path: 'TODO.md', text: TODO_SEED }],
    recommended: false,
    source: 'builtin',
  },
  {
    id: 'lessons',
    title: 'Memory / lessons learned',
    description: 'LESSONS.md carries what agents learn from one session to the next.',
    directive: LESSONS_DIRECTIVE,
    files: [{ path: 'LESSONS.md', text: LESSONS_SEED }],
    recommended: false,
    source: 'builtin',
  },
  {
    id: 'worktrees',
    title: 'Git worktree workflow',
    description: 'For code projects with parallel agents: one git worktree and branch per task.',
    directive: WORKTREES_DIRECTIVE,
    files: [{ path: '.gitignore', text: 'worktrees/\n', ensureLines: true }],
    recommended: false,
    source: 'builtin',
  },
  {
    id: 'marp-decks',
    title: 'Marp presentations',
    description:
      'Agents write slide decks as Marp markdown this app can show, edit and present (decks/example-deck.md).',
    directive: MARP_DECKS_DIRECTIVE,
    files: [{ path: EXAMPLE_DECK_PATH, text: EXAMPLE_DECK }],
    recommended: false,
    source: 'builtin',
  },
];

/** The harness entry files that only point at AGENTS.md. */
export const HARNESS_STUBS: readonly { path: string; label: string }[] = [
  { path: 'CLAUDE.md', label: 'Claude Code' },
  { path: 'GEMINI.md', label: 'Gemini CLI' },
];

const IMPORT_LINE = '@AGENTS.md';

const slugId = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * A module from a file in the user's modules folder. Title = first heading
 * (else the file name), description = first paragraph line; the whole file is
 * the directive. Ids are `user-<file-slug>` so they cannot collide with a
 * built-in.
 */
export function userModuleFrom(fileName: string, text: string): WorkspaceModule | null {
  const body = text.replace(/\r\n/g, '\n').trim();
  const stem = fileName.replace(/\.(md|markdown)$/i, '');
  const id = slugId(stem);
  if (!body || !id) {
    return null;
  }
  const lines = body.split('\n');
  const heading = lines.find((l) => /^#{1,6}\s+\S/.test(l));
  const para = lines.find((l) => l.trim() !== '' && !/^(#{1,6}\s|<!--|---)/.test(l));
  return {
    id: `user-${id}`,
    title: heading ? heading.replace(/^#{1,6}\s+/, '').trim() : stem,
    description: (para ?? '').trim().slice(0, 160),
    // A top-level `# Title` would fight AGENTS.md's own; demote it.
    directive: `${body.replace(/^# (?=\S)/, '## ')}\n`,
    files: [],
    recommended: false,
    source: 'user',
  };
}

const BLOCK = /<!-- module:([a-z0-9-]+) -->\n[\s\S]*?<!-- \/module:\1 -->\n?/g;

/** Ids of the marked modules in an AGENTS.md, in file order. */
export function installedModuleIds(agents: string): string[] {
  return [...agents.replace(/\r\n/g, '\n').matchAll(BLOCK)].map((m) => m[1]!);
}

const block = (m: WorkspaceModule) =>
  `<!-- module:${m.id} -->\n${m.directive.trim()}\n<!-- /module:${m.id} -->\n`;

/**
 * AGENTS.md with exactly `selected` as its marked modules. Existing blocks
 * are refreshed where they stand, unselected ones removed, new ones appended
 * in selection order; text outside the markers is preserved verbatim.
 */
export function composeAgentsFile(
  existing: string | null,
  selected: readonly WorkspaceModule[],
  workspaceName: string,
  /** Ids the caller can offer. A marked block outside this set (a user module
   *  whose file is gone) is somebody's text we cannot re-create: left alone. */
  known?: ReadonlySet<string>,
): string {
  const byId = new Map(selected.map((m) => [m.id, m]));
  const base =
    existing && existing.trim() !== ''
      ? existing.replace(/\r\n/g, '\n')
      : `# ${workspaceName}\n\nInstructions for AI agents working in this folder. Sections between \`module\` markers are managed by md-specpad (Workspace directives…); write your own instructions outside them.\n`;

  const placed = new Set<string>();
  let text = base.replace(BLOCK, (all: string, id: string) => {
    if (known && !known.has(id)) {
      return all;
    }
    const m = byId.get(id);
    if (!m || placed.has(id)) {
      return '';
    }
    placed.add(id);
    return block(m);
  });

  const fresh = selected.filter((m) => !placed.has(m.id));
  if (fresh.length > 0) {
    text = `${text.replace(/\n*$/, '\n')}\n${fresh.map(block).join('\n')}`;
  }
  // Removing a block can leave a run of blank lines behind.
  return text.replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
}

export interface InitWrite {
  path: string;
  text: string;
}

export interface InitPlanInput {
  workspaceName: string;
  modules: readonly WorkspaceModule[];
  /** Every module id the dialog offered (see `composeAgentsFile`). */
  knownIds?: ReadonlySet<string>;
  /** Which of `HARNESS_STUBS` to write. */
  stubs: readonly string[];
  /** Current text of every file the plan might touch that exists (relative path → text). */
  existing: ReadonlyMap<string, string>;
}

/** Every relative path a plan for these modules may read or write. */
export function initPlanPaths(modules: readonly WorkspaceModule[]): string[] {
  return [
    'AGENTS.md',
    ...HARNESS_STUBS.map((s) => s.path),
    ...modules.flatMap((m) => m.files.map((f) => f.path)),
  ];
}

export function planWorkspaceInit(input: InitPlanInput): InitWrite[] {
  const writes: InitWrite[] = [];
  const put = (path: string, text: string) => {
    if (input.existing.get(path) !== text) {
      writes.push({ path, text });
    }
  };

  put(
    'AGENTS.md',
    composeAgentsFile(
      input.existing.get('AGENTS.md') ?? null,
      input.modules,
      input.workspaceName,
      input.knownIds,
    ),
  );

  for (const stub of input.stubs) {
    const current = input.existing.get(stub);
    if (current === undefined) {
      put(stub, `${IMPORT_LINE}\n`);
    } else if (!current.includes(IMPORT_LINE)) {
      put(stub, `${current.replace(/\n*$/, '\n')}\n${IMPORT_LINE}\n`);
    }
  }

  for (const file of input.modules.flatMap((m) => m.files)) {
    const current = input.existing.get(file.path);
    if (current === undefined || file.refresh) {
      put(file.path, file.text);
    } else if (file.ensureLines) {
      const appended = appendMissingLines(current, file.text.split('\n'));
      if (appended !== null) {
        put(file.path, appended);
      }
    }
  }
  return writes;
}
