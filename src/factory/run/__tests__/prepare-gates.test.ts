import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { readShipState } from '../../../ship/state.js';
import { cleanFactoryRun } from '../clean.js';
import { checkoutPath } from '../prepare.js';
import { readFactoryState } from '../state.js';
import { commitFile, gitIn, ISSUE, PR, remoteHead, review } from './fake-lanes.js';
import { scaleTiming } from '../../../__tests__/helpers/platform.js';
import { h, usePrepareGatesHarness, run, moveBase, PREPARE_VIEW, before } from './prepare-gates-harness.js';

// Every engine run here drives a few hundred real git processes (the lane
// tamper snapshots, prepare merges, the bare remote). No assertion measures
// time, so the timeout only bounds a hang and must leave a loaded host's
// process spawns room.
vi.setConfig({ testTimeout: scaleTiming(90_000) });

usePrepareGatesHarness();

describe('prepare in the engine-owned checkout', () => {
  it('clean prepare: gh pr ready, checks on the changed files in the checkout, nothing to push, then gates and the merge park', async () => {
    const { done } = run([commitFile('src/greet.ts', 'export const greet = () => "hi";\n'), review('approve')]);
    const out = await done;
    expect(out.gate?.name, out.message).toBe('merge');
    const state = readFactoryState(h.root, ISSUE)!;
    expect(h.calls).toContain(`gh pr ready ${PR}`);
    expect(h.calls.some((c) => c.startsWith(`git worktree add -B omc-team/factory-run/issue-${ISSUE} `) && c.endsWith(` ${state.lanes[0].endSha}`))).toBe(true);
    expect(h.calls).toContain('node node_modules/typescript/bin/tsc --noEmit');
    expect(h.calls).toContain('node node_modules/eslint/bin/eslint.js src/greet.ts');
    expect(h.calls).toContain('node scripts/generate-inventory-graph.mjs --verify');
    // Ship's prepare never pushes from the checkout; the base was already merged, so there was nothing to push at all.
    expect(h.calls.filter((c) => c.startsWith('git push '))).toHaveLength(1);
    expect(h.calls.some((c) => c.includes('HEAD:refs/heads/'))).toBe(false);
    expect(readShipState(h.root, PR)!.housekeepingCommits).toEqual([]);
    expect(existsSync(checkoutPath(h.root, ISSUE))).toBe(true);
  });

  it('a checkout branch rewritten as a symref to main is refused before `worktree add -B`; main does not move', async () => {
    const mainRef = gitIn(h.root, 'symbolic-ref', 'HEAD');
    const main = gitIn(h.root, 'rev-parse', mainRef);
    const common = gitIn(h.root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    // Planted after the pre-prepare recheck (the first common-dir read after gh pr ready), as the engine reads the common dir for the branch check.
    let reads = -1;
    h.onCall = (call) => {
      if (call === `gh pr ready ${PR}`) reads = 0;
      else if (reads >= 0 && call === 'git rev-parse --git-common-dir' && ++reads === 2) {
        mkdirSync(join(common, 'refs', 'heads', 'omc-team', 'factory-run'), { recursive: true });
        writeFileSync(join(common, 'refs', 'heads', 'omc-team', 'factory-run', `issue-${ISSUE}`), `ref: ${mainRef}\n`);
      }
    };
    const { done } = run([commitFile('src/greet.ts', 'export const greet = () => "hi";\n'), review('approve')]);
    const out = await done;
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    expect(out.gate?.reason).toMatch(/omc-team\/factory-run\/issue-\d+ is not a plain commit ref/);
    expect(h.calls.some((c) => c.startsWith('git worktree add '))).toBe(false);
    expect(gitIn(h.root, 'rev-parse', mainRef)).toBe(main);
  });

  it('an inventory-only base conflict is resolved with the base\'s inventory, pushed as housekeeping, and merge still allows the head', async () => {
    before(PREPARE_VIEW, () => moveBase('inventory/graph.json', '{"base":true}\n'));
    const { done } = run([commitFile('inventory/graph.json', '{"lane":true}\n'), review('approve')]);
    const out = await done;
    expect(out.gate?.name, out.message).toBe('merge');
    const state = readFactoryState(h.root, ISSUE)!;
    const ship = readShipState(h.root, PR)!;
    expect(state.head).toBe(remoteHead(h));
    expect(state.head).not.toBe(ship.verdicts[0].sha);
    expect(ship.housekeepingCommits).toEqual([state.head]);
    expect(gitIn(h.root, 'show', `${state.head}:inventory/graph.json`)).toBe('{"base":true}');
    expect(h.calls).toContain(`git push origin ${state.head}:refs/heads/factory/issue-${ISSUE}`);
    // One implement and one review lane: housekeeping needs no new verdict.
    expect(state.lanes.map((l) => l.kind)).toEqual(['implement', 'review']);
    expect(out.mergeCommand).toBe(`gh pr merge ${PR} --admin --merge --match-head-commit ${state.head}`);
  });
});

describe('omg factory run clean', () => {
  it('removes the lane worktrees and the prepare checkout of a merged run, keeps what would be lost, and refuses an unfinished run', async () => {
    await run([commitFile('a.ts'), review('approve')]).done;
    const clean = () => cleanFactoryRun({ root: h.root, issue: ISSUE, exec: h.exec, ledgerDir: h.ledgerDir });
    expect(clean).toThrow(/merged or cancelled run only/);

    h.gh.merged = true;
    await run([]).done;
    const state = readFactoryState(h.root, ISSUE)!;
    const reviewTree = state.lanes[1].worktree!;
    writeFileSync(join(reviewTree, 'notes.txt'), 'a human left this\n');
    const rawBefore = h.raw.length;
    const result = clean();
    // clean's fetch and ls-remote run hardened like the engine's: no hooks, no fsmonitor.
    for (const sub of ['fetch', 'ls-remote']) {
      const call = h.raw.slice(rawBefore).find((c) => c.cmd === 'git' && c.args.includes(sub))!;
      expect(call.args.slice(0, 4)).toEqual(['-c', `core.hooksPath=${join(h.ledgerDir, 'empty-hooks')}`, '-c', 'core.fsmonitor=false']);
    }
    expect(result.removed).toEqual(expect.arrayContaining([state.lanes[0].worktree, checkoutPath(h.root, ISSUE)]));
    expect(existsSync(state.lanes[0].worktree!)).toBe(false);
    expect(existsSync(checkoutPath(h.root, ISSUE))).toBe(false);
    expect(result.kept.map((k) => k.worktree)).toEqual([reviewTree]);
    expect(result.kept[0].reason).toMatch(/worktree_dirty/);
    expect(existsSync(join(reviewTree, 'notes.txt'))).toBe(true);
    // The lane branch is gone with its worktree; the PR branch on the remote stays.
    expect(gitIn(h.root, 'branch', '--list', `omc-team/copilot-run/${state.lanes[0].jobId}`)).toBe('');
    expect(remoteHead(h)).toBe(state.head);
  });

  it('keeps a lane worktree holding a commit nothing else holds', async () => {
    const { done } = run([commitFile('a.ts'), review('approve')]);
    await done;
    h.gh.merged = true;
    await run([]).done;
    const state = readFactoryState(h.root, ISSUE)!;
    const implTree = state.lanes[0].worktree!;
    writeFileSync(join(implTree, 'extra.ts'), 'x\n');
    gitIn(implTree, 'add', '--', 'extra.ts');
    gitIn(implTree, 'commit', '-q', '-m', 'unpushed');
    const result = cleanFactoryRun({ root: h.root, issue: ISSUE, exec: h.exec, ledgerDir: h.ledgerDir });
    expect(result.kept.map((k) => k.worktree)).toEqual([implTree]);
    expect(result.kept[0].reason).toMatch(/worktree_unmerged_commits/);
    expect(existsSync(implTree)).toBe(true);
  });
});
