import { describe, expect, test } from 'vitest';
import {
  cdCommand,
  cdTarget,
  fileManagerName,
  listAllCommand,
  listCommand,
  openFolderCommand,
  quoteArg,
  quoteCommand,
  relativePath,
  searchCommand,
  shellPath,
  upCommand,
} from '../shell-commands';
import type { WorkspaceRoot } from '../tab-workspaces';

describe('relativePath', () => {
  test('Windows: descends, climbs, and compares case-insensitively', () => {
    expect(relativePath('C:\\Work\\proj', 'C:\\Work\\proj\\src\\app', 'windows')).toBe('src/app');
    expect(relativePath('C:\\Work\\proj\\src', 'C:\\Work\\proj\\docs', 'windows')).toBe('../docs');
    expect(relativePath('c:/work/PROJ/src', 'C:\\Work\\proj', 'windows')).toBe('..');
    expect(relativePath('C:\\Work', 'C:\\WORK', 'windows')).toBe('.');
  });

  test('Windows: never crosses a drive letter or a share', () => {
    expect(relativePath('C:\\Work', 'D:\\Work\\x', 'windows')).toBeNull();
    expect(relativePath('\\\\srv\\share\\a', '\\\\srv\\other\\a', 'windows')).toBeNull();
    expect(relativePath('\\\\srv\\share\\a', '\\\\SRV\\Share\\a\\b', 'windows')).toBe('b');
  });

  test('Windows: an MSYS-style or relative input has no relative form', () => {
    expect(relativePath('/c/Users', 'C:\\Users\\x', 'windows')).toBeNull();
    expect(relativePath('C:\\Users', 'x\\y', 'windows')).toBeNull();
  });

  test('POSIX: exact case, `.` and `..` segments normalized', () => {
    expect(relativePath('/home/u/proj', '/home/u/proj/src', 'posix')).toBe('src');
    expect(relativePath('/home/u/proj/src/', '/home/u/other', 'posix')).toBe('../../other');
    expect(relativePath('/home/u/Proj', '/home/u/proj/src', 'posix')).toBe('../proj/src');
    expect(relativePath('/a/b/../c', '/a/c/d/./e', 'posix')).toBe('d/e');
    expect(relativePath('/a', 'b', 'posix')).toBeNull();
  });
});

const ROOTS: WorkspaceRoot[] = [
  { path: 'C:\\Work\\proj', color: 'blue' },
  { path: 'C:\\Notes', color: 'green' },
];

describe('cdTarget', () => {
  test('inside the same workspace: relative', () => {
    expect(cdTarget('C:\\Work\\proj\\src', 'C:\\Work\\proj\\docs', ROOTS, 'windows')).toEqual({
      path: '../docs',
      relative: true,
    });
  });

  test('a different workspace, or outside every workspace: absolute', () => {
    expect(cdTarget('C:\\Work\\proj', 'C:\\Notes\\daily', ROOTS, 'windows')).toEqual({
      path: 'C:\\Notes\\daily',
      relative: false,
    });
    expect(cdTarget('C:\\Work\\proj', 'D:\\elsewhere', ROOTS, 'windows')).toEqual({
      path: 'D:\\elsewhere',
      relative: false,
    });
    // cwd outside every workspace, target inside one
    expect(cdTarget('C:\\Temp', 'C:\\Work\\proj', ROOTS, 'windows').relative).toBe(false);
  });

  test('no cwd known yet: absolute', () => {
    expect(cdTarget(null, 'C:\\Work\\proj\\x', ROOTS, 'windows')).toEqual({
      path: 'C:\\Work\\proj\\x',
      relative: false,
    });
  });
});

describe('shellPath', () => {
  test('Windows-style shells write backslashes, POSIX shells forward slashes', () => {
    expect(shellPath('pwsh', 'C:/Users/x')).toBe('C:\\Users\\x');
    expect(shellPath('cmd', '../docs')).toBe('..\\docs');
    expect(shellPath('bash', 'C:\\Users\\x')).toBe('C:/Users/x');
  });
});

describe('quoteArg', () => {
  test('PowerShell: bare when safe, single quotes with doubling otherwise', () => {
    expect(quoteArg('pwsh', 'C:\\Users\\x')).toBe('C:\\Users\\x');
    expect(quoteArg('powershell', 'C:\\My Docs')).toBe("'C:\\My Docs'");
    expect(quoteArg('pwsh', "it's")).toBe("'it''s'");
    expect(quoteArg('pwsh', '$HOME')).toBe("'$HOME'");
    expect(quoteArg('pwsh', '')).toBe("''");
  });

  test('cmd: double quotes for spaces and metacharacters', () => {
    expect(quoteArg('cmd', 'C:\\Users\\x')).toBe('C:\\Users\\x');
    expect(quoteArg('cmd', 'C:\\My Docs')).toBe('"C:\\My Docs"');
    expect(quoteArg('cmd', 'a&b')).toBe('"a&b"');
    expect(quoteArg('cmd', '')).toBe('""');
  });

  test("POSIX: bare when safe, single quotes with '\\'' otherwise", () => {
    expect(quoteArg('bash', '/home/u/proj')).toBe('/home/u/proj');
    expect(quoteArg('zsh', '/home/u/my notes')).toBe("'/home/u/my notes'");
    expect(quoteArg('fish', "o'brien")).toBe("'o'\\''brien'");
    expect(quoteArg('sh', '$HOME')).toBe("'$HOME'");
    expect(quoteArg('bash', '~')).toBe("'~'");
    expect(quoteArg('bash', '')).toBe("''");
  });

  test('fish: a backslash inside single quotes is doubled', () => {
    expect(quoteArg('fish', 'a\\b c')).toBe("'a\\\\b c'");
    expect(quoteArg('bash', 'a\\b c')).toBe("'a\\b c'");
  });

  test('PowerShell: typographic single quotes are doubled too', () => {
    expect(quoteArg('pwsh', 'it’s')).toBe("'it’’s'");
  });
});

describe('cdCommand', () => {
  test('PowerShell teaches plain cd, quoting only when needed', () => {
    expect(cdCommand('pwsh', '..\\src')).toBe('cd ..\\src');
    expect(cdCommand('pwsh', 'C:/Users/Logan')).toBe('cd C:\\Users\\Logan');
    expect(cdCommand('powershell', 'C:\\path with spaces')).toBe("cd 'C:\\path with spaces'");
    expect(cdCommand('pwsh', "C:\\it's")).toBe("cd 'C:\\it''s'");
  });

  test('PowerShell: wildcard characters need -LiteralPath, a leading dash needs quotes', () => {
    expect(cdCommand('pwsh', 'C:\\a[1]')).toBe("cd -LiteralPath 'C:\\a[1]'");
    expect(cdCommand('pwsh', '-x')).toBe("cd '-x'");
  });

  test('cmd: cd /d, quoted when the path has a space', () => {
    expect(cdCommand('cmd', '..\\src')).toBe('cd /d ..\\src');
    expect(cdCommand('cmd', 'D:/Data/My Files')).toBe('cd /d "D:\\Data\\My Files"');
  });

  test('POSIX shells: forward slashes, single quotes, cd -- for a dash', () => {
    expect(cdCommand('bash', '../src')).toBe('cd ../src');
    expect(cdCommand('zsh', '/home/u/my notes')).toBe("cd '/home/u/my notes'");
    expect(cdCommand('fish', "/tmp/o'brien")).toBe("cd '/tmp/o'\\''brien'");
    expect(cdCommand('bash', 'C:\\Users\\x')).toBe('cd C:/Users/x');
    expect(cdCommand('sh', '-x')).toBe('cd -- -x');
  });
});

describe('listCommand', () => {
  test('per shell', () => {
    expect(listCommand('pwsh')).toBe('ls');
    expect(listCommand('powershell')).toBe('ls');
    expect(listCommand('cmd')).toBe('dir');
    expect(listCommand('bash')).toBe('ls -l');
    expect(listCommand('zsh')).toBe('ls -l');
    expect(listCommand('fish')).toBe('ls -l');
    expect(listCommand('sh')).toBe('ls -l');
  });
});

describe('quoteCommand', () => {
  test('a bare program with flags stays readable in every shell', () => {
    expect(quoteCommand('pwsh', 'claude', ['--model', 'opus'])).toBe('claude --model opus');
    expect(quoteCommand('cmd', 'codex', [])).toBe('codex');
    expect(quoteCommand('bash', 'gemini', ['-y'])).toBe('gemini -y');
  });

  test('PowerShell needs the call operator for a quoted program', () => {
    expect(quoteCommand('pwsh', 'C:\\Tools\\my agent.exe', ['--fast', 'a b'])).toBe(
      "& 'C:\\Tools\\my agent.exe' --fast 'a b'",
    );
  });

  test('cmd and POSIX just quote the tokens', () => {
    expect(quoteCommand('cmd', 'C:\\Tools\\my agent.exe', ['a b'])).toBe(
      '"C:\\Tools\\my agent.exe" "a b"',
    );
    expect(quoteCommand('zsh', '/opt/my agent', ['--prompt', "it's"])).toBe(
      "'/opt/my agent' --prompt 'it'\\''s'",
    );
  });
});

describe('upCommand', () => {
  test('is cd .. everywhere', () => {
    expect(upCommand()).toBe('cd ..');
  });
});

describe('listAllCommand', () => {
  test('PowerShell uses the cmdlet: `ls` is the native one on macOS/Linux', () => {
    expect(listAllCommand('pwsh')).toBe('Get-ChildItem -Force');
    expect(listAllCommand('powershell')).toBe('Get-ChildItem -Force');
    expect(listAllCommand('cmd')).toBe('dir /a');
    expect(listAllCommand('bash')).toBe('ls -la');
    expect(listAllCommand('fish')).toBe('ls -la');
  });
});

describe('openFolderCommand', () => {
  test('per OS; POSIX shells on Windows need the .exe', () => {
    expect(openFolderCommand('pwsh', 'windows')).toBe('explorer .');
    expect(openFolderCommand('cmd', 'windows')).toBe('explorer .');
    expect(openFolderCommand('bash', 'windows')).toBe('explorer.exe .');
    expect(openFolderCommand('zsh', 'mac')).toBe('open .');
    expect(openFolderCommand('pwsh', 'mac')).toBe('open .');
    expect(openFolderCommand('bash', 'linux')).toBe('xdg-open .');
    expect(openFolderCommand('pwsh', 'linux')).toBe('xdg-open .');
  });

  test('names the file manager', () => {
    expect(fileManagerName('windows')).toBe('File Explorer');
    expect(fileManagerName('mac')).toBe('Finder');
    expect(fileManagerName('linux')).toBe('file manager');
  });
});

describe('searchCommand', () => {
  const contents = { target: 'contents', matchCase: false } as const;
  const names = { target: 'names', matchCase: false } as const;

  test('nothing to search for', () => {
    expect(searchCommand('bash', '', contents)).toBeNull();
    expect(searchCommand('pwsh', '', names)).toBeNull();
  });

  test('POSIX: grep -E for contents, find | grep for names, .git skipped', () => {
    expect(searchCommand('bash', 'TODO|FIXME', contents)).toBe(
      "grep -rniE --exclude-dir=.git 'TODO|FIXME' .",
    );
    expect(searchCommand('zsh', '\\.md$', names)).toBe(
      "find . -type f -not -path '*/.git/*' | grep -iE '\\.md$'",
    );
  });

  test('POSIX: match case drops -i; a leading dash goes behind -e', () => {
    expect(searchCommand('bash', 'Foo', { target: 'contents', matchCase: true })).toBe(
      "grep -rnE --exclude-dir=.git 'Foo' .",
    );
    expect(searchCommand('bash', 'x', { target: 'names', matchCase: true })).toBe(
      "find . -type f -not -path '*/.git/*' | grep -E 'x'",
    );
    expect(searchCommand('sh', '--force', contents)).toBe(
      "grep -rniE --exclude-dir=.git -e '--force' .",
    );
  });

  test('POSIX: quotes survive in the pattern', () => {
    expect(searchCommand('bash', "it's", contents)).toBe(
      "grep -rniE --exclude-dir=.git 'it'\\''s' .",
    );
    expect(searchCommand('fish', '\\d+', contents)).toBe(
      "grep -rniE --exclude-dir=.git '\\\\d+' .",
    );
  });

  test('PowerShell: Get-ChildItem | Select-String, case-insensitive unless asked', () => {
    expect(searchCommand('pwsh', 'TODO|FIXME', contents)).toBe(
      "Get-ChildItem -Recurse -File | Select-String -Pattern 'TODO|FIXME'",
    );
    expect(searchCommand('powershell', '\\.md$', names)).toBe(
      "Get-ChildItem -Recurse -File -Name | Select-String -Pattern '\\.md$'",
    );
    expect(searchCommand('pwsh', "it's $x", { target: 'contents', matchCase: true })).toBe(
      "Get-ChildItem -Recurse -File | Select-String -Pattern 'it''s $x' -CaseSensitive",
    );
  });

  test('cmd: findstr, and no way to spell a double quote', () => {
    expect(searchCommand('cmd', 'TODO', contents)).toBe('findstr /s /n /i /r /c:"TODO" *');
    expect(searchCommand('cmd', '\\.md$', { target: 'names', matchCase: true })).toBe(
      'dir /s /b /a-d | findstr /r /c:"\\.md$"',
    );
    expect(searchCommand('cmd', 'say "hi"', contents)).toBeNull();
  });
});
