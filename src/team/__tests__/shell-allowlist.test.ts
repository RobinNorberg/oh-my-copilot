import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAX_ALLOWLIST_COMMAND_CHARS, reviewShellAllowlist } from '../shell-allowlist.js';

let root: string;
let wt: string;
const decide = (cmd: string, extra: Record<string, unknown> = {}) =>
  reviewShellAllowlist({ kind: 'shell', fullCommandText: cmd, ...extra }, { cwd: wt });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'omg-allowlist-'));
  wt = join(root, 'wt');
  mkdirSync(join(wt, 'src'), { recursive: true });
  writeFileSync(join(wt, 'src', 'a.ts'), 'x\n');
  mkdirSync(join(root, 'outside'));
  try { symlinkSync(join(root, 'outside'), join(wt, 'link'), 'junction'); } catch { /* no symlink rights: the case below is skipped by its guard */ }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('reviewShellAllowlist accepts read-only commands', () => {
  it.each([
    'git diff main...HEAD',
    'git --no-pager log --oneline -20',
    'git -P show --stat HEAD',
    'git --no-optional-locks status --porcelain',
    'git show HEAD:src/a.ts',
    'git show :src/a.ts',
    'git log -c -1',
    'git log --format=%h,%s -5',
    'git diff --no-ext-diff --no-textconv HEAD~1 -- src/a.ts',
    'git blame src/a.ts',
    'git merge-base main HEAD',
    'git ls-files src',
    'git ls-tree -r HEAD',
    'git cat-file -p HEAD',
    'git rev-parse --show-toplevel',
    'git grep -n foo -- src',
    'git for-each-ref --format=%H refs/heads',
    'git rev-list --count main..HEAD',
    'rg -n foo src',
    'rg -g "*.ts" foo',
    'rg --files src',
    'grep -rn foo src',
    'findstr foo src\\a.ts',
    'Select-String -Path src/a.ts -Pattern foo',
    'cat src/a.ts',
    'type src\\a.ts',
    'Get-Content src/a.ts | Select-Object -First 50',
    'gc src/a.ts | Select-Object -Skip 10 -First 5',
    'Get-Content -Raw src/a.ts',
    'head -n 20 src/a.ts',
    'tail -5 src/a.ts',
    'wc -l src/a.ts',
    'ls -la src',
    'dir',
    'Get-ChildItem -Recurse src',
    'pwd',
    'Get-Location',
    'find . -name "*.ts"',
    'git log --oneline | head -5',
    'git diff --stat | sort | head -3',
    'rg -c foo src | Sort-Object',
    'ls src | Measure-Object',
    'git.exe status',
    'GIT status',
  ])('approves %s', (cmd) => {
    expect(decide(cmd), cmd).toEqual({ approve: true, reason: 'review allowlist' });
  });
});

describe('reviewShellAllowlist refuses everything else', () => {
  it.each([
    // Substitution, chaining, redirection, escapes.
    'git $p',
    'git log; rm -rf .',
    '& git push',
    'echo a > b',
    'cat src/a.ts > out',
    'git log `whoami`',
    'git show $(whoami)',
    'git log && git push',
    'cat @args',
    '[IO.File]::ReadAllText("x")',
    'git log\ngit push',
    'git log {a,b}',
    '!ls',
    // Not on the allowlist.
    'iex \'x\'',
    'powershell -enc ZQBjAGgAbwA=',
    'pwsh -c ls',
    'cmd /c dir',
    'bash -c ls',
    'node -e 1',
    'npm test',
    'npx vitest',
    'python x.py',
    'sed -n 1p src/a.ts',
    'awk 1 src/a.ts',
    'xargs cat',
    'cat src/a.ts | tee out',
    'env',
    'curl https://example.com',
    'wget https://example.com',
    'Invoke-WebRequest https://example.com',
    'Set-Content x y',
    'Remove-Item x',
    'Start-Process x',
    'echo hi',
    'git log | sed 1d',
    'git log | git push',
    'git log | head | tail | wc',
    // Quoting tricks.
    '"g"it push',
    'g""it status',
    "git 'status",
    // git: subcommands and options.
    'git push',
    'git commit -m x',
    'git config user.name',
    'git -c alias.x=push x',
    'git -C .. status',
    'git --git-dir=../x log',
    'git --work-tree=.. status',
    'git --exec-path=/x status',
    'git --config-env=a=b status',
    'git -p log',
    'git --paginate log',
    'git diff --output=../x',
    'git diff --outp=x',
    'git diff --ext-diff',
    'git log -p --textconv',
    'git diff --no-index src/a.ts /etc/passwd',
    'git cat-file --filters HEAD:src/a.ts',
    'git grep -O vim x',
    'git grep -nOvim x',
    'git grep --open-files-in-pager x',
    'git grep --open x',
    'git',
    // rg / sort / find / select-object options.
    'rg --pre sh x',
    'rg --pre=sh x',
    'rg --pre-glob "*" x',
    'rg -z x',
    'rg -nz x',
    'rg --search-zip x',
    'rg --hostname-bin x x',
    'git log | sort -o out',
    'git log | sort --output=out',
    'git log | sort --compress-program=x',
    'find . -delete',
    'find . -exec rm {} +',
    'find . -execdir x',
    'find . -ok x',
    'find . -fprint out',
    'find . -fls out',
    'git log | Select-Object -ExpandProperty x',
    'git log | Select-Object -First x',
    // Paths outside the worktree.
    'cat ../../.gitconfig',
    'cat C:\\Users\\x\\.ssh\\id_rsa',
    'cat /etc/passwd',
    'type \\\\host\\share',
    'cat //host/share',
    'cat ~/.ssh/id_rsa',
    'cat ~',
    'rg foo ..',
    'grep -r foo /',
    'Get-Content env:GH_TOKEN',
    'Get-Content -Path:C:\\x',
    'gc src/a.ts,../x',
    'cat -',
    'ls .*',
    'ls src/.*/x',
    'rg --ignore-file=../x foo',
    'git diff --relative=../x',
    'git show HEAD:../x',
    'git log -- ../x',
    'rg -f/etc/passwd x',
    'find / -name x',
  ])('refuses %s', (cmd) => {
    const out = decide(cmd);
    expect(out.approve, cmd).toBe(false);
    expect(out.reason, cmd).toMatch(/^review allowlist: /);
  });

  it('refuses a path that leaves the worktree through a junction', () => {
    let linked = false;
    try { linked = realpathSync(join(wt, 'link')) !== join(wt, 'link'); } catch { /* not created */ }
    if (!linked) return;
    for (const cmd of ['ls link', 'cat link/x', 'cat link/*']) expect(decide(cmd).approve, cmd).toBe(false);
  });

  it('refuses a runtime-parse identifier mismatch, accepts a matching one', () => {
    expect(decide('git status', { commands: [{ identifier: 'git', readOnly: true }], commandSegments: [{ identifier: 'git', fullCommandText: 'git status' }] }).approve).toBe(true);
    expect(decide('git log | head -5', { commands: [{ identifier: 'C:\\Program Files\\Git\\cmd\\git.exe' }, { identifier: 'head' }] }).approve).toBe(true);
    const out = decide('git status', { commands: [{ identifier: 'git' }, { identifier: 'Remove-Item' }] });
    expect(out.approve).toBe(false);
    expect(out.reason).toContain('runtime parsed command "remove-item"');
  });

  it('refuses redirection the runtime saw, empty and oversized commands, and other kinds', () => {
    expect(decide('cat src/a.ts', { hasWriteFileRedirection: true }).reason).toContain('file redirection');
    expect(decide('   ').approve).toBe(false);
    expect(decide(`cat ${'a'.repeat(MAX_ALLOWLIST_COMMAND_CHARS)}`).reason).toContain('longer than');
    expect(reviewShellAllowlist({ kind: 'write', path: 'x' }, { cwd: wt }).approve).toBe(false);
  });
});
