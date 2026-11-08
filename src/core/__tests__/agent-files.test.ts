import { describe, expect, test } from 'vitest';
import { AGENT_IMPORT_RE, agentImports, isAgentFilePath } from '../agent-files';

describe('isAgentFilePath', () => {
  test('matches the three agent files by base name, whatever the case or separator', () => {
    expect(isAgentFilePath('C:/proj/CLAUDE.md')).toBe(true);
    expect(isAgentFilePath('C:\\proj\\sub\\GEMINI.md')).toBe(true);
    expect(isAgentFilePath('/home/ann/notes/AGENTS.md')).toBe(true);
    expect(isAgentFilePath('claude.md')).toBe(true);
    expect(isAgentFilePath('/x/Agents.MD')).toBe(true);
  });

  test('anything else is not one', () => {
    expect(isAgentFilePath('C:/proj/notes.md')).toBe(false);
    expect(isAgentFilePath('C:/proj/CLAUDE.md.bak')).toBe(false);
    expect(isAgentFilePath('C:/proj/MY-AGENTS.md')).toBe(false);
    expect(isAgentFilePath('C:/proj/CLAUDE.md/readme.md')).toBe(false);
    expect(isAgentFilePath(null)).toBe(false);
    expect(isAgentFilePath(undefined)).toBe(false);
    expect(isAgentFilePath('')).toBe(false);
  });
});

describe('AGENT_IMPORT_RE', () => {
  test('finds imports at the line start and after whitespace or a parenthesis', () => {
    const text = [
      '@AGENTS.md',
      'See @docs/style.md and @~/.claude/shared.md',
      'Also (@./local.md) and  @../up/x.md',
      '  @CLAUDE.md',
      'Windows too: @docs\\win.md',
    ].join('\n');
    expect(agentImports(text)).toEqual([
      '@AGENTS.md',
      '@docs/style.md',
      '@~/.claude/shared.md',
      '@./local.md',
      '@../up/x.md',
      '@CLAUDE.md',
      '@docs\\win.md',
    ]);
  });

  test('leaves e-mail addresses, bare @ and mid-word @ alone', () => {
    expect(agentImports('mail ann@example.com or ann@b')).toEqual([]);
    expect(agentImports('a lone @ sign and @')).toEqual([]);
    expect(agentImports('foo@bar.md')).toEqual([]);
    expect(agentImports('npm i @scope/pkg')).toEqual(['@scope/pkg']);
  });

  test('stops before trailing punctuation and at whitespace', () => {
    expect(agentImports('read @docs/x.md.')).toEqual(['@docs/x.md']);
    expect(agentImports('read @docs/x.md, then @y.md; done')).toEqual(['@docs/x.md', '@y.md']);
    expect(agentImports('is it @docs/x.md?')).toEqual(['@docs/x.md']);
    expect(agentImports('@a.md @b.md')).toEqual(['@a.md', '@b.md']);
  });

  test('is global and multiline, as a MatchDecorator needs', () => {
    expect(AGENT_IMPORT_RE.flags).toContain('g');
    expect(AGENT_IMPORT_RE.flags).toContain('m');
  });
});
