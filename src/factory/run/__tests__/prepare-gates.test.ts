/**
 * `omg factory run` PR 3: prepare in the engine-owned checkout, the
 * conflict-fix and ci-fix lanes, the gates loop (head-checked), the human
 * merge gate and `clean`. Fake lanes, real git with a local bare remote,
 * scripted gh and node behind the exec seam, a fake clock for the gate polls.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseProgressLog } from '../../../lib/agent-progress.js';
import { readShipState } from '../../../ship/state.js';
import { DEFAULT_FACTORY_RUN_LIMITS, type FactoryRunLimits } from '../budget.js';
import { cleanFactoryRun } from '../clean.js';
import { EXIT_AWAITING_HUMAN, runFactoryEngine, type FactoryEngineOptions } from '../engine.js';
import { factoryGuardExec } from '../exec.js';
import { checkoutPath } from '../prepare.js';
import { factoryProgressFile } from '../progress.js';
import { readFactoryState, requestFactoryCancel } from '../state.js';
import type { Exec, ExecResult } from '../../../ship/exec.js';
import {
  commitFile, failedGates, FakeLanes, FakeProcesses, gitIn, greenGates, harness, ISSUE, PR, pendingGates, remoteHead, review, testGateConfig,
  type GatesRead, type Harness, type LaneScript,
} from './fake-lanes.js';

let h: Harness;
let t: number;

beforeEach(() => {
  h = harness('omg-factory-pr3-');
  // The engine's own base merges commit in the prepare checkout.
  gitIn(h.root, 'config', 'user.name', 't');
  gitIn(h.root, 'config', 'user.email', 't@example.invalid');
  t = Date.parse('2026-10-27T10:00:00.000Z');
});

afterEach(() => {
  rmSync(h.dir, { recursive: true, force: true });
});

const limits = (over: Partial<FactoryRunLimits> = {}): FactoryRunLimits => ({ ...DEFAULT_FACTORY_RUN_LIMITS, ...over });

function run(scripts: LaneScript[], over: Partial<FactoryEngineOptions> = {}) {
  const lanes = new FakeLanes(h.root, scripts);
  const done = runFactoryEngine({
    root: h.root, issue: ISSUE, exec: h.exec, lanes, limits: limits(), base: 'dev', pollMs: 5,
    owner: { pid: 4242, hostname: 'test-host', isAlive: () => false }, ledgerDir: h.ledgerDir, processes: new FakeProcesses(),
    gateConfig: testGateConfig, now: () => t, sleep: async (ms) => { t += ms; },
    ...over,
  });
  return { lanes, done };
}

/** Move dev on the remote from a separate clone (the engine's main checkout is never touched). */
function moveBase(path: string, content: string): string {
  const other = join(h.dir, `other-${Math.random().toString(36).slice(2, 8)}`);
  gitIn(h.dir, 'clone', '-q', '-b', 'dev', h.bare, other);
  mkdirSync(join(other, path, '..'), { recursive: true });
  writeFileSync(join(other, path), content);
  gitIn(other, 'add', '--', path);
  gitIn(other, 'commit', '-q', '-m', `base: ${path}`);
  gitIn(other, 'push', '-q', 'origin', 'dev');
  return gitIn(other, 'rev-parse', 'HEAD');
}

/** The first PR view of prepare (and of every later phase): GitHub's base sha is read here. */
const PREPARE_VIEW = `gh pr view ${PR} --json number,`;

/** Run `fn` once, right before the first command that starts with `prefix`. */
function before(prefix: string, fn: () => void): void {
  let fired = false;
  h.onCall = (call) => {
    if (!fired && call.startsWith(prefix)) {
      fired = true;
      fn();
    }
  };
}

const events = () => parseProgressLog(readFileSync(factoryProgressFile(h.root, ISSUE), 'utf8'));

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

describe('conflict-fix lane', () => {
  it('a base conflict outside inventory/ discards the checkout and starts a fresh write lane at the PR head, then a new review', async () => {
    let baseSha = '';
    before(PREPARE_VIEW, () => { baseSha = moveBase('README.md', 'base side\n'); });
    const resolve: LaneScript = ({ worktree }) => {
      try { gitIn(worktree, 'merge', '--no-ff', '--no-edit', baseSha); } catch { /* conflicts, resolved below */ }
      writeFileSync(join(worktree, 'README.md'), 'both sides\n');
      gitIn(worktree, 'add', '--', 'README.md');
      gitIn(worktree, 'commit', '-q', '--no-edit');
      return { finalText: 'Merged.' };
    };
    const { lanes, done } = run([commitFile('README.md', 'lane side\n'), review('approve'), resolve, review('approve')]);
    const out = await done;
    expect(out.gate?.name, out.message).toBe('merge');
    const state = readFactoryState(h.root, ISSUE)!;
    expect(lanes.started.map((s) => [s.laneId, s.profile])).toEqual([
      [`issue-${ISSUE}-implement-1`, 'write'], [`issue-${ISSUE}-review-1`, 'review'],
      [`issue-${ISSUE}-conflict-fix-1`, 'write'], [`issue-${ISSUE}-review-2`, 'review'],
    ]);
    const firstHead = state.lanes[0].endSha!;
    expect(lanes.started[2].baseRef).toBe(firstHead);
    expect(lanes.started[2].prompt).toContain('README.md');
    expect(lanes.started[2].prompt).toContain(`git merge --no-ff ${baseSha}`);
    expect(lanes.started[3].baseRef).toBe(state.head);
    expect(h.calls).toContain('git merge --abort');
    expect(state.history.some((e) => e.to === 'conflict-fix' && /README\.md/.test(e.note))).toBe(true);
    // The lane's merge is not housekeeping: ship holds a second approve on the new head.
    const ship = readShipState(h.root, PR)!;
    expect(ship.verdicts.map((v) => v.sha)).toEqual([firstHead, state.head]);
    expect(gitIn(h.root, 'merge-base', '--is-ancestor', baseSha, state.head!)).toBe('');
  });
});

describe('gates loop', () => {
  it('pending -> green across watch windows: a window that ends pending is a heartbeat, not a stop', async () => {
    // 30 s polls: 25 pending reads cross the 9-minute ship window once.
    h.gh.gates = [...Array<GatesRead>(25).fill(pendingGates()), greenGates()];
    const { done } = run([commitFile('a.ts'), review('approve')]);
    const out = await done;
    expect(out.gate?.name, out.message).toBe('merge');
    expect(h.calls.filter((c) => c.startsWith(`gh pr checks ${PR}`)).length).toBeGreaterThanOrEqual(26);
    const ship = readShipState(h.root, PR)!;
    expect(ship.phase).toBe('ready');
    expect(ship.lastGates?.verdict).toBe('green');
    expect(events().some((e) => e.phase === 'gates' && e.status === 'heartbeat' && /watch window elapsed/.test(e.note ?? ''))).toBe(true);
  });

  it('pending -> red -> one ci-fix lane -> a new review on the new head -> green', async () => {
    h.gh.gates = [pendingGates(100), failedGates(100), greenGates(101)];
    h.gh.logs['200'] = 'Test\tRun tests\t2026-10-27T10:00:00.0000000Z  FAIL  src/greet.test.ts > greet > returns hi\n';
    const { lanes, done } = run([commitFile('src/greet.ts', 'x\n'), review('approve'), commitFile('src/greet.ts', 'hi\n'), review('approve')]);
    const out = await done;
    expect(out.gate?.name, out.message).toBe('merge');
    const state = readFactoryState(h.root, ISSUE)!;
    expect(lanes.started.map((s) => s.laneId)).toEqual([
      `issue-${ISSUE}-implement-1`, `issue-${ISSUE}-review-1`, `issue-${ISSUE}-ci-fix-1`, `issue-${ISSUE}-review-2`,
    ]);
    const redHead = state.lanes[0].endSha!;
    expect(lanes.started[2].baseRef).toBe(redHead);
    expect(lanes.started[2].prompt).toContain('- Test');
    expect(lanes.started[2].prompt).toContain('src/greet.test.ts > greet > returns hi');
    expect(lanes.started[3].baseRef).toBe(state.head);
    expect(state.head).not.toBe(redHead);
    expect(state.ciFixRounds).toBe(1);
    expect(readShipState(h.root, PR)!.verdicts.map((v) => v.sha)).toEqual([redHead, state.head]);
  });

  it('a second real failure after the one ci-fix round parks at ci-failed', async () => {
    h.gh.gates = [failedGates(100)];
    const { lanes, done } = run([commitFile('a.ts'), review('approve'), commitFile('b.ts'), review('approve')]);
    const out = await done;
    expect(out.exitCode).toBe(EXIT_AWAITING_HUMAN);
    expect(out.gate?.name).toBe('ci-failed');
    expect(lanes.started.filter((s) => s.laneId.includes('ci-fix'))).toHaveLength(1);
  });

  it('a stale head and a failed read from another commit\'s runs are ignored, never acted on', async () => {
    // In the gates phase (its PR view is the second full one, after prepare's), GitHub first still reports the base,
    // an ancestor of the pushed head; then a failure from a run of another commit.
    let views = 0;
    let armed = false;
    h.onCall = (call) => {
      if (call.startsWith(PREPARE_VIEW) && ++views === 2) armed = true;
      else if (armed && call === `gh pr view ${PR} --json headRefOid,state`) {
        armed = false;
        h.gh.headSequence.push(gitIn(h.root, 'rev-parse', 'refs/remotes/origin/dev'));
      }
    };
    h.gh.gates = [{ checks: failedGates(99).checks, runs: greenGates(100).runs }, greenGates(100)];
    const { lanes, done } = run([commitFile('a.ts'), review('approve')]);
    const out = await done;
    expect(out.gate?.name, out.message).toBe('merge');
    expect(lanes.started).toHaveLength(2);
    const state = readFactoryState(h.root, ISSUE)!;
    expect(state.ciFixRounds).toBe(0);
    expect(state.ciFailure).toBeUndefined();
    expect(h.calls.filter((c) => c === `gh pr view ${PR} --json headRefOid,state`).length).toBeGreaterThanOrEqual(3);
  });

  it('a head GitHub reports that the engine never pushed parks at head-moved-externally', async () => {
    let views = 0;
    let armed = false;
    h.onCall = (call) => {
      // After the gates phase's own PR view (the second full one), the driver's head read sees a foreign head.
      if (call.startsWith(PREPARE_VIEW) && ++views === 2) armed = true;
      else if (armed && call === `gh pr view ${PR} --json headRefOid,state`) {
        armed = false;
        h.gh.headSequence.push('f'.repeat(40));
      }
    };
    const { done } = run([commitFile('a.ts'), review('approve')]);
    const out = await done;
    expect(out.gate?.name).toBe('head-moved-externally');
    expect(readFactoryState(h.root, ISSUE)!.phase).toBe('gates');
  });

  it('gates that never settle park at gates-timeout after factory.run.gatesTimeoutMinutes', async () => {
    h.gh.gates = [pendingGates()];
    const { done } = run([commitFile('a.ts'), review('approve')], { limits: limits({ gatesTimeoutMs: 20 * 60_000 }) });
    const out = await done;
    expect(out.gate?.name).toBe('gates-timeout');
    expect(readFactoryState(h.root, ISSUE)!.phase).toBe('gates');
  });
});

describe('merge gate (always human)', () => {
  it('parks with the exact command and a PR comment, never merges; a later run detects the human merge and finishes as merged', async () => {
    const first = await run([commitFile('a.ts'), review('approve')]).done;
    expect(first.exitCode).toBe(0);
    expect(first.gate?.name).toBe('merge');
    const head = readFactoryState(h.root, ISSUE)!.head!;
    const cmd = `gh pr merge ${PR} --admin --merge --match-head-commit ${head}`;
    expect(first.mergeCommand).toBe(cmd);
    expect(first.message).toContain(cmd);
    const comment = h.calls.filter((c) => c.startsWith(`gh pr comment ${PR} --body-file `)).map((c) => c.split('--body-file ')[1]).find((f) => f.includes('merge'))!;
    expect(readFileSync(comment, 'utf8')).toContain(cmd);
    expect(h.calls.some((c) => c.startsWith('gh pr merge'))).toBe(false);
    expect(events().at(-1)).toMatchObject({ phase: 'merge', status: 'blocked' });

    // A rerun before the human merged parks again without a second comment.
    const commentsBefore = h.calls.filter((c) => c.startsWith('gh pr comment ') || c.startsWith('gh issue comment ')).length;
    const again = await run([]).done;
    expect(again.gate?.name).toBe('merge');
    expect(h.calls.filter((c) => c.startsWith('gh pr comment ') || c.startsWith('gh issue comment ')).length).toBe(commentsBefore);

    h.gh.merged = true;
    const done = await run([]).done;
    expect(done.exitCode).toBe(0);
    expect(done.phase).toBe('merged');
    expect(readFactoryState(h.root, ISSUE)!.phase).toBe('merged');
    expect(readShipState(h.root, PR)!.phase).toBe('merged');
    expect(events().at(-1)).toMatchObject({ phase: 'merged', status: 'done' });
    expect(h.calls.some((c) => c.startsWith('gh pr merge'))).toBe(false);
  });

  it('the factory guard refuses gh pr merge outright', () => {
    expect(() => factoryGuardExec(h.exec)('gh', ['pr', 'merge', String(PR), '--admin', '--merge', '--match-head-commit', 'a'.repeat(40)])).toThrow(/refuses/);
  });

  it('every human gate posts one issue comment with the gate, its reason and the resume command', async () => {
    h.gh.issue.body = 'no plan here';
    const out = await run([]).done;
    expect(out.gate?.name).toBe('needs-plan');
    const files = h.calls.filter((c) => c.startsWith(`gh issue comment ${ISSUE} --body-file `)).map((c) => c.split('--body-file ')[1]);
    expect(files).toHaveLength(1);
    const body = readFileSync(files[0], 'utf8');
    expect(body).toContain('**needs-plan**');
    expect(body).toContain(`omg factory run ${ISSUE}`);
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

const okRun: ExecResult = { status: 0, stdout: '', stderr: '' };
const isTsc = (args: string[]) => args.some((a) => a.includes('typescript/bin/tsc'));
const pushes = () => h.calls.filter((c) => c.startsWith('git push '));

describe('prepare: crash window, PR code and failing checks', () => {
  it('a crash right after the prepare push resumes from the recorded prepare instead of parking at head-moved-externally', async () => {
    before(PREPARE_VIEW, () => moveBase('inventory/graph.json', '{"base":true}\n'));
    let n = 0;
    const crashing: Exec = (cmd, args, opts) => {
      const res = h.exec(cmd, args, opts);
      if (cmd === 'git' && args.includes('push') && ++n === 2) throw new Error('simulated crash after the prepare push');
      return res;
    };
    const first = await run([commitFile('inventory/graph.json', '{"lane":true}\n'), review('approve')], { exec: crashing }).done;
    expect(first.exitCode, first.message).toBe(1);
    const crashed = readFactoryState(h.root, ISSUE)!;
    expect(crashed.phase).toBe('prepare');
    expect(crashed.prepared?.head).toBe(remoteHead(h));
    expect(crashed.head).not.toBe(remoteHead(h));

    const out = await run([]).done;
    expect(out.gate?.name, out.message).toBe('merge');
    const state = readFactoryState(h.root, ISSUE)!;
    expect(state.head).toBe(remoteHead(h));
    expect(state.prepared).toBeUndefined();
    expect(readShipState(h.root, PR)!.housekeepingCommits).toEqual([state.head]);
    // Nothing was prepared or pushed again.
    expect(pushes()).toHaveLength(2);
  });

  it.each<[string, () => void, RegExp]>([
    ['sets a pushurl', () => gitIn(h.root, 'config', 'remote.origin.pushurl', 'https://github.com/evil/r.git'), /common git config changed/],
    ['creates a ref', () => gitIn(h.root, 'branch', 'evil', 'HEAD'), /ref refs\/heads\/evil was created/],
  ])('PR code run by prepare\'s checks that %s parks at lane-tampered and nothing is pushed', async (_label, tamper, problem) => {
    h.node = (args) => { if (isTsc(args)) tamper(); return okRun; };
    const out = await run([commitFile('src/greet.ts', 'x\n'), review('approve')]).done;
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    expect(out.message).toMatch(problem);
    expect(out.message).toMatch(/prepare's checks/);
    expect(readFactoryState(h.root, ISSUE)!.phase).toBe('prepare');
    expect(pushes()).toHaveLength(1);
    expect(readShipState(h.root, PR)!.phase).toBe('prepare');
  });

  it('origin/dev moved by prepare\'s checks to a sha that is not GitHub\'s base parks at lane-tampered', async () => {
    h.node = (args) => {
      if (isTsc(args)) gitIn(h.root, 'update-ref', 'refs/remotes/origin/dev', readFactoryState(h.root, ISSUE)!.head!);
      return okRun;
    };
    const out = await run([commitFile('src/greet.ts', 'x\n'), review('approve')]).done;
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    expect(out.message).toMatch(/refs\/remotes\/origin\/dev is at .*, not GitHub's base/);
    expect(pushes()).toHaveLength(1);
  });

  it('a failing prepare check starts one ci-fix lane at the checkout head, then a new review and a clean prepare', async () => {
    let tsc = 0;
    h.node = (args) => (isTsc(args) && ++tsc === 1 ? { status: 1, stdout: 'src/greet.ts(1,1): error TS1005: expected', stderr: '' } : okRun);
    const { lanes, done } = run([commitFile('src/greet.ts', 'x\n'), review('approve'), commitFile('src/greet.ts', 'fixed\n'), review('approve')]);
    const out = await done;
    expect(out.gate?.name, out.message).toBe('merge');
    expect(lanes.started.map((s) => s.laneId)).toEqual([
      `issue-${ISSUE}-implement-1`, `issue-${ISSUE}-review-1`, `issue-${ISSUE}-ci-fix-1`, `issue-${ISSUE}-review-2`,
    ]);
    const state = readFactoryState(h.root, ISSUE)!;
    expect(lanes.started[2].baseRef).toBe(state.lanes[0].endSha);
    expect(lanes.started[2].prompt).toContain('- prepare tsc');
    expect(lanes.started[2].prompt).toContain('engine\'s local checks');
    expect(state.ciFixRounds).toBe(1);
    expect(tsc).toBe(2);
  });
});

describe('conflict-fix checks', () => {
  /** A conflict-fix lane that merges the fetched base, resolves README.md, then (optionally) moves the base again. */
  const resolveAndMoveBase = (again?: string): LaneScript => ({ worktree }) => {
    const base = gitIn(worktree, 'rev-parse', 'refs/remotes/origin/dev');
    try { gitIn(worktree, 'merge', '--no-ff', '--no-edit', base); } catch { /* conflicts, resolved below */ }
    writeFileSync(join(worktree, 'README.md'), `both sides ${again ?? ''}\n`);
    gitIn(worktree, 'add', '--', 'README.md');
    gitIn(worktree, 'commit', '-q', '--no-edit');
    if (again) moveBase('README.md', `${again}\n`);
    return { finalText: 'Merged.' };
  };

  it('a conflict-fix lane whose head does not contain the base parks at conflict-fix-failed and nothing is pushed', async () => {
    before(PREPARE_VIEW, () => { moveBase('README.md', 'base side\n'); });
    const { done } = run([commitFile('README.md', 'lane side\n'), review('approve'), commitFile('README.md', 'only the lane side\n')]);
    const out = await done;
    expect(out.gate?.name, out.message).toBe('conflict-fix-failed');
    expect(out.message).toMatch(/does not contain the base/);
    expect(pushes()).toHaveLength(1);
  });

  it('base conflicts after two conflict-fix rounds park at merge-conflicts', async () => {
    before(PREPARE_VIEW, () => { moveBase('README.md', 'base side\n'); });
    const { lanes, done } = run([
      commitFile('README.md', 'lane side\n'), review('approve'),
      resolveAndMoveBase('base side 2'), review('approve'),
      resolveAndMoveBase('base side 3'), review('approve'),
    ]);
    const out = await done;
    expect(out.gate?.name, out.message).toBe('merge-conflicts');
    expect(lanes.started.filter((s) => s.laneId.includes('conflict-fix'))).toHaveLength(2);
  });

  it('a conflict-fix lane that changes shared git state parks at lane-tampered and nothing is pushed', async () => {
    before(PREPARE_VIEW, () => { moveBase('README.md', 'base side\n'); });
    const tampering: LaneScript = (ctx) => { const r = resolveAndMoveBase()(ctx); gitIn(h.root, 'config', 'core.sshCommand', 'evil'); return r; };
    const out = await run([commitFile('README.md', 'lane side\n'), review('approve'), tampering]).done;
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    expect(out.message).toMatch(/conflict-fix lane/);
    expect(pushes()).toHaveLength(1);
  });
});

describe('gates: ci-fix tampering, cancel and resume', () => {
  it('a ci-fix lane that changes shared git state parks at lane-tampered and nothing is pushed', async () => {
    h.gh.gates = [failedGates(100)];
    const tampering: LaneScript = (ctx) => { const r = commitFile('src/fix.ts')(ctx); gitIn(h.root, 'branch', 'evil', ctx.baseSha); return r ?? undefined; };
    const out = await run([commitFile('a.ts'), review('approve'), tampering]).done;
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    expect(out.message).toMatch(/ci-fix lane .*refs\/heads\/evil was created/);
    expect(pushes()).toHaveLength(1);
  });

  it('cancel while the gates loop polls stops the run as cancelled', async () => {
    h.gh.gates = [pendingGates()];
    let checks = 0;
    h.onCall = (c) => { if (c.startsWith(`gh pr checks ${PR}`) && ++checks === 3) requestFactoryCancel(h.root, ISSUE, new Date(t).toISOString()); };
    const out = await run([commitFile('a.ts'), review('approve')]).done;
    expect(out.phase, out.message).toBe('cancelled');
    expect(readFactoryState(h.root, ISSUE)!.phase).toBe('cancelled');
    // It lands at ship's next poll, not at the end of the 9-minute watch window.
    expect(h.calls.filter((c) => c.startsWith(`gh pr checks ${PR}`))).toHaveLength(3);
  });

  it('a crash mid-gates resumes the gates loop on the same head and reaches the merge park', async () => {
    h.gh.gates = [pendingGates()];
    let checks = 0;
    const crashing: Exec = (cmd, args, opts) => {
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'checks' && ++checks === 3) throw new Error('simulated crash mid-gates');
      return h.exec(cmd, args, opts);
    };
    const first = await run([commitFile('a.ts'), review('approve')], { exec: crashing }).done;
    expect(first.exitCode, first.message).toBe(1);
    const head = readFactoryState(h.root, ISSUE)!.head;
    expect(readFactoryState(h.root, ISSUE)!.phase).toBe('gates');
    h.gh.gates = [greenGates()];
    const out = await run([]).done;
    expect(out.gate?.name, out.message).toBe('merge');
    expect(readFactoryState(h.root, ISSUE)!.head).toBe(head);
    expect(readShipState(h.root, PR)!.phase).toBe('ready');
    expect(pushes()).toHaveLength(1);
  });

  it('a merge-rule gate read that keeps disagreeing with the gates loop parks at gates-disagree instead of cycling', async () => {
    h.gh.gates = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? greenGates() : failedGates()));
    const out = await run([commitFile('a.ts'), review('approve')]).done;
    expect(out.gate?.name, out.message).toBe('gates-disagree');
    expect(h.calls.some((c) => c.startsWith('gh pr merge'))).toBe(false);
  });
});
