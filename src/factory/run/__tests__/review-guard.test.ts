import { appendFileSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
    usage: { premiumRequests: 1, credits: 2, source: 'measured', detail: '' }, remoteId: 'cr-rev', error: null, notes: [],
  };
}

/** Problems after `tamper` ran during a review lane (snapshot before the lane starts, check after it ends). */
function problemsAfter(tamper: () => void): string[] {
  const before = snapshotRepo(exec, h.root);
  addLaneWorktree();
  tamper();
  const after = snapshotRepo(exec, h.root);
  return [...compareSnapshots(before, after, { [`refs/heads/${branch}`]: head }), ...verifyReviewWorktree(exec, laneResult(), head)];
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
});
