import { describe, expect, it } from 'vitest';
import {
  BUILTIN_MODULES,
  composeAgentsFile,
  initPlanPaths,
  installedModuleIds,
  planWorkspaceInit,
  RETIRED_MODULE_IDS,
  userModuleFrom,
  type WorkspaceModule,
} from '../workspace-modules';

const mod = (id: string, directive = `## ${id}\nrule`): WorkspaceModule => ({
  id,
  title: id,
  description: '',
  directive,
  files: [],
  recommended: false,
  source: 'builtin',
});

describe('composeAgentsFile', () => {
  it('starts a fresh file with a title and the modules in order', () => {
    const text = composeAgentsFile(null, [mod('a'), mod('b')], 'My Project');
    expect(text.startsWith('# My Project\n')).toBe(true);
    expect(installedModuleIds(text)).toEqual(['a', 'b']);
    expect(text.endsWith('<!-- /module:b -->\n')).toBe(true);
  });

  it('re-run: refreshes in place, removes the unselected, appends the new, keeps user text', () => {
    const first = composeAgentsFile(null, [mod('a'), mod('b')], 'P');
    const edited =
      first.replace('<!-- module:b -->', 'My own rule.\n\n<!-- module:b -->') + '\nTail note.\n';
    const next = composeAgentsFile(edited, [mod('b', '## b\nnew rule'), mod('c')], 'P');
    expect(installedModuleIds(next)).toEqual(['b', 'c']);
    expect(next).toContain('My own rule.');
    expect(next).toContain('Tail note.');
    expect(next).toContain('new rule');
    expect(next).not.toContain('## a');
    expect(next).not.toMatch(/\n{3,}/);
    // Idempotent.
    expect(composeAgentsFile(next, [mod('b', '## b\nnew rule'), mod('c')], 'P')).toBe(next);
  });

  it('leaves a marked block it was not offered alone', () => {
    const first = composeAgentsFile(null, [mod('a'), mod('user-gone')], 'P');
    const next = composeAgentsFile(first, [], 'P', new Set(['a']));
    expect(installedModuleIds(next)).toEqual(['user-gone']);
  });

  it('reads CRLF files', () => {
    const crlf = composeAgentsFile(null, [mod('a')], 'P').replace(/\n/g, '\r\n');
    expect(installedModuleIds(crlf)).toEqual(['a']);
  });
});

describe('userModuleFrom', () => {
  it('takes title and description from the file and demotes a top heading', () => {
    const m = userModuleFrom('My Soul.md', '# Soul\n\nBe a builder.\n\n## Temperament\nSteady.');
    expect(m).toMatchObject({
      id: 'user-my-soul',
      title: 'Soul',
      description: 'Be a builder.',
      source: 'user',
    });
    expect(m!.directive.startsWith('## Soul\n')).toBe(true);
  });
  it('rejects an empty file', () => {
    expect(userModuleFrom('x.md', '  \n')).toBeNull();
  });
});

describe('BUILTIN_MODULES', () => {
  it('has unique ids and a directive heading each', () => {
    const ids = BUILTIN_MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of BUILTIN_MODULES) {
      expect(m.directive).toMatch(/^## \S/);
    }
  });

  it('nothing is ticked by default', () => {
    expect(BUILTIN_MODULES.every((m) => !m.recommended)).toBe(true);
  });

  it('a retired module is no longer offered, and a re-run drops its block', () => {
    expect(BUILTIN_MODULES.some((m) => RETIRED_MODULE_IDS.includes(m.id))).toBe(false);
    const old = [
      '# P',
      '',
      '<!-- module:prompt-status -->',
      '## Prompt status',
      'old',
      '<!-- /module:prompt-status -->',
      '',
      '<!-- module:a -->',
      '## a',
      'rule',
      '<!-- /module:a -->',
      '',
    ].join('\n');
    const known = new Set(['a', ...RETIRED_MODULE_IDS]);
    const next = composeAgentsFile(old, [mod('a')], 'P', known);
    expect(installedModuleIds(next)).toEqual(['a']);
    expect(next).not.toContain('Prompt status');
  });

  it('marp-decks: off by default, seeds the example deck its directive points at', () => {
    const marp = BUILTIN_MODULES.find((m) => m.id === 'marp-decks')!;
    expect(marp.recommended).toBe(false);
    const seed = marp.files.find((f) => f.path === 'decks/example-deck.md')!;
    expect(seed.refresh).toBeUndefined(); // the user's edits to it survive a re-run
    expect(seed.text.startsWith('---\nmarp: true\n')).toBe(true);
    expect(marp.directive).toContain('decks/example-deck.md');
    expect(marp.directive).toContain('marp: true');
  });

  it('todo: seeds a TODO.md checklist with the headings its directive names', () => {
    const todo = BUILTIN_MODULES.find((m) => m.id === 'todo')!;
    expect(todo.files).toHaveLength(1);
    const seed = todo.files[0]!;
    expect(seed.path).toBe('TODO.md');
    expect(seed.refresh).toBeUndefined(); // the user's list survives a re-run
    for (const heading of ['## Now', '## Later', '## Done']) {
      expect(seed.text).toContain(`
${heading}
`);
      expect(todo.directive).toContain(heading);
    }
    expect(todo.directive).toContain('- [ ]');
  });
});

describe('planWorkspaceInit', () => {
  it('writes everything into an empty folder', () => {
    const writes = planWorkspaceInit({
      workspaceName: 'P',
      modules: BUILTIN_MODULES,
      stubs: ['CLAUDE.md', 'GEMINI.md'],
      existing: new Map(),
    });
    expect(writes.map((w) => w.path).sort()).toEqual(
      [...new Set(initPlanPaths(BUILTIN_MODULES))].sort(),
    );
    expect(writes.find((w) => w.path === 'CLAUDE.md')!.text).toBe('@AGENTS.md\n');
  });

  it('re-run: never overwrites seeds, refreshes the script, appends to stubs and .gitignore', () => {
    const existing = new Map([
      ['CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n- mine\n'],
      ['.notepad/status.py', 'old'],
      ['CLAUDE.md', '# My rules\n'],
      ['GEMINI.md', 'see @AGENTS.md\n'],
      ['.gitignore', 'node_modules/\r\n'],
    ]);
    const writes = new Map(
      planWorkspaceInit({
        workspaceName: 'P',
        modules: BUILTIN_MODULES,
        stubs: ['CLAUDE.md', 'GEMINI.md'],
        existing,
      }).map((w) => [w.path, w.text]),
    );
    expect(writes.has('CHANGELOG.md')).toBe(false);
    expect(writes.has('GEMINI.md')).toBe(false);
    expect(writes.get('.notepad/status.py')).not.toBe('old');
    expect(writes.get('CLAUDE.md')).toBe('# My rules\n\n@AGENTS.md\n');
    expect(writes.get('.gitignore')).toBe('node_modules/\r\nworktrees/\n');
  });

  it('plans nothing when nothing changed', () => {
    const input = {
      workspaceName: 'P',
      modules: BUILTIN_MODULES,
      stubs: ['CLAUDE.md'],
      existing: new Map<string, string>(),
    };
    const done = new Map(planWorkspaceInit(input).map((w) => [w.path, w.text]));
    expect(planWorkspaceInit({ ...input, existing: done })).toEqual([]);
  });
});
