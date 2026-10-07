/**
 * The TEXT of the built-in workspace modules: the directive each one adds to
 * AGENTS.md and the files it seeds. Kept apart from `workspace-modules.ts` so
 * the composition logic reads without pages of prose in the way.
 *
 * Directives are written for an agent, in the imperative, and stay short:
 * every line here is paid for in tokens on every run of every harness.
 */

export const MANIFEST_DIRECTIVE = `## File manifest

\`MANIFEST.md\` lists every file and folder that matters in this workspace with one line on what it is for. Read it before exploring — it is cheaper than listing directories. When you add, move, rename or delete a file, update its line in the same change. Generated and vendored content (build output, dependencies) gets one line for the folder, not one per file.
`;

export const MANIFEST_SEED = `# Manifest

What each file and folder here is for. Agents keep this current (see AGENTS.md).

| Path | Purpose |
|---|---|
| AGENTS.md | Instructions for AI agents working in this folder |
`;

export const CHANGELOG_DIRECTIVE = `## Changelog

\`CHANGELOG.md\` keeps an \`## [Unreleased]\` section at the top. When you finish a change the user would notice, add one short line there in the same change — what it means for them, not which files moved. Do not list refactors or internal churn. On a release, rename \`[Unreleased]\` to \`## [X.Y.Z] — YYYY-MM-DD\` and start a fresh \`[Unreleased]\` above it.
`;

export const CHANGELOG_SEED = `# Changelog

## [Unreleased]
`;

export const LESSONS_DIRECTIVE = `## Lessons learned

\`LESSONS.md\` is this workspace's memory across sessions. Read it at the start of every task. Add an entry when something cost you time that a note would have prevented: a wrong assumption about this project, a command that fails here, a correction or preference from the user. One entry = a dated heading, the fact, and how to apply it. Update or delete entries that turn out wrong; never record what the files already say.
`;

export const LESSONS_SEED = `# Lessons learned

Things agents found out the hard way. Newest first. (See AGENTS.md.)
`;

export const TODO_DIRECTIVE = `## TODO list

\`TODO.md\` is the shared task list for this workspace — the user and agents both add to it. Read it at the start of every task. Items are GitHub task-list lines (\`- [ ] …\`), one task per line, most important first, under three headings: \`## Now\`, \`## Later\`, \`## Done\`.

- When you start an item, move it to the top of \`## Now\`. When it is finished and verified, tick it (\`- [x]\`), move it to the top of \`## Done\` and append the date (\`— YYYY-MM-DD\`).
- Found work you will not do now (a bug, a follow-up, a loose end)? Add it under \`## Later\` with one line of context instead of doing it unasked.
- Edit only the lines you touch; never reword, reorder or delete the user's items, and ask before removing one.
`;

export const TODO_SEED = `# TODO

Shared task list for people and agents (see AGENTS.md). Tick items off as they are done.

## Now

## Later

## Done
`;

export const WORKTREES_DIRECTIVE = `## Git worktree workflow

Several agents may work here at once, so never change files on the main checkout.

1. Pull the default branch, then \`git worktree add worktrees/<slug> -b feat/<slug>\` (short kebab-case slug). \`worktrees/\` is gitignored.
2. Install dependencies inside the worktree before building. Make every change there only.
3. When finished: verify the project builds and its tests pass, commit with a concise message, and tell the user the worktree path. Leave nothing running.
4. Merge only after the user confirms: pull the default branch, merge it INTO your branch first, resolve conflicts keeping both sides' behavior (the other change is another agent's intentional work), re-verify, then merge your branch in.
5. When the user ends the task: leave the worktree directory in every shell, then \`git worktree remove worktrees/<slug>\` and \`git branch -d feat/<slug>\`. If removal fails on uncommitted changes, ask before forcing.
`;

export const MARP_DECKS_DIRECTIVE = `## Marp presentations

A slide deck in this workspace is one markdown file whose YAML frontmatter starts with \`marp: true\` (Marp syntax: https://marpit.marp.app/markdown). The user's editor renders, edits, presents and exports such a file in place, so write decks it can show well. \`decks/example-deck.md\` demonstrates every convention below — start new decks from it.

- **One \`.md\` per deck.** Frontmatter: \`marp: true\`, \`theme: default\` (or \`gaia\` / \`uncommon\`, or \`./name.css\` for a stylesheet beside the file), \`paginate: true\`. A line with only \`---\` separates slides.
- **Images live next to the deck** and are referenced by relative path (\`![](diagram.svg)\`, \`![bg right:40%](photo.jpg)\`, \`![w:400](chart.png)\`). Never inline base64 and never link to remote images — the editor shows local files only. Prefer \`.svg\` for diagrams.
- **Per-slide settings** are HTML comments at the top of the slide (\`<!-- _class: lead -->\`, \`<!-- _backgroundColor: #123 -->\`); the same key without the underscore applies from that slide onwards. Any other HTML comment in a slide is its speaker notes — write them, the presenter window shows them.
- **Plain HTML only.** \`<div>\`, \`<span>\`, \`<img>\` and inline \`style\` render; \`<script>\`, \`<iframe>\` and event handlers are stripped. Math (\`$…$\`), fenced code and \`:shortcode:\` emoji render offline.
- **Keep slides short**: one idea per slide, a heading and at most six lines or one image; split long content across slides rather than shrinking it.
- **Edit only the lines you were asked to change.** The user tweaks decks by hand in the editor's Edit mode, which touches single lines; do not reformat, re-wrap or re-serialise the rest of the file, and leave directive comments and \`![bg]\` syntax exactly as written.
`;
