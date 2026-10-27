import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseProgressLog } from '../../../lib/agent-progress.js';
import { readShipState } from '../../../ship/state.js';
import { DEFAULT_FACTORY_RUN_LIMITS, type FactoryRunLimits } from '../budget.js';
import { EXIT_AWAITING_HUMAN, runFactoryEngine, type FactoryEngineOptions } from '../engine.js';
import { factoryProgressFile } from '../progress.js';
import {
  factoryOwnerPath,
  factoryStateDir,
  factoryStatePath,
  readFactoryState,
  requestFactoryCancel,
  updateFactoryState,
} from '../state.js';
import { commitFile, FakeLanes, gitIn, harness, ISSUE, noCommit, PR, remoteHead, review, type Harness, type LaneScript } from './fake-lanes.js';

let h: Harness;

beforeEach(() => {
  h = harness();
});

afterEach(() => {
  rmSync(h.dir, { recursive: true, force: true });
});

const limits = (over: Partial<FactoryRunLimits> = {}): FactoryRunLimits => ({ ...DEFAULT_FACTORY_RUN_LIMITS, ...over });

function opts(lanes: FakeLanes, over: Partial<FactoryEngineOptions> = {}): FactoryEngineOptions {
  return {
    root: h.root,
    issue: ISSUE,
    exec: h.exec,
    lanes,
    limits: limits(),
    base: 'dev',
    pollMs: 5,
    owner: { pid: 4242, hostname: 'test-host', isAlive: () => false },
    ...over,
  };
}

const run = (scripts: LaneScript[], over: Partial<FactoryEngineOptions> = {}, polls: number[] = []) => {
  const lanes = new FakeLanes(h.root, scripts, polls);
  return { lanes, done: runFactoryEngine(opts(lanes, over)) };
};

describe('omg factory run engine (fake lanes, real git, scripted gh)', () => {
  it('happy path: implement -> push -> draft PR -> independent review approve -> park at prepare', async () => {
    const { lanes, done } = run([commitFile('src/greet.ts', 'export const greet = () => "hi";\n'), review('approve')]);
    const out = await done;

    expect(out.exitCode).toBe(0);
    expect(out.gate?.name).toBe('prepare');
    const state = readFactoryState(h.root, ISSUE)!;
    expect(state.phase).toBe('prepare');
    expect(state.pr).toBe(PR);
    expect(state.head).toBe(remoteHead(h));
    expect(state.plan?.source).toBe('issue-body');

    // Lanes: write profile for the implementer, review profile on the exact head, every start capped.
    expect(lanes.started.map((s) => [s.laneId, s.profile, s.maxCredits])).toEqual([
      [`issue-${ISSUE}-implement-1`, 'write', 30],
      [`issue-${ISSUE}-review-1`, 'review', 30],
    ]);
    expect(lanes.started[0].baseRef).toBe(gitIn(h.root, 'rev-parse', 'origin/dev'));
    expect(lanes.started[1].baseRef).toBe(state.head);
    expect(lanes.started[1].prompt).toContain('greet');
    expect(lanes.started[1].prompt).not.toContain('Committed.');

    // Engine-only push and draft PR; credits recorded per lane.
    expect(h.calls).toContain(`git push origin ${state.head}:refs/heads/factory/issue-${ISSUE}`);
    const create = h.calls.find((c) => c.startsWith('gh pr create'))!;
    expect(create).toContain('--draft --base dev --head factory/issue-7');
    const body = readFileSync(create.split('--body-file ')[1], 'utf8');
    expect(body).toContain(`Closes #${ISSUE}`);
    expect(state.lanes.map((l) => [l.status, l.usage?.credits])).toEqual([['completed', 5], ['completed', 3]]);
    expect(state.lanes[1].verdict).toBe('approve');

    // Ship holds the verdict, by a reviewer that is not the implementer.
    const ship = readShipState(h.root, PR)!;
    expect(ship.implementer).toBe(`factory-impl-${ISSUE}`);
    expect(ship.phase).toBe('prepare');
    expect(ship.verdicts).toHaveLength(1);
    expect(ship.verdicts[0]).toMatchObject({ verdict: 'approve', sha: state.head, reviewer: `factory-review-${ISSUE}-cr-fake2` });
    expect(h.calls.some((c) => c.startsWith(`gh pr comment ${PR}`))).toBe(true);

    // Progress: phases start/ok, the gate is blocked.
    const events = parseProgressLog(readFileSync(factoryProgressFile(h.root, ISSUE), 'utf8'));
    expect(events.every((e) => e.agent === `factory-${ISSUE}`)).toBe(true);
    for (const phase of ['intake', 'plan', 'implement', 'publish', 'review']) {
      expect(events.some((e) => e.phase === phase && e.status === 'start')).toBe(true);
      expect(events.some((e) => e.phase === phase && e.status === 'ok')).toBe(true);
    }
    expect(events.at(-1)).toMatchObject({ phase: 'prepare', status: 'blocked' });
    expect(events.at(-1)!.note).toMatch(/^prepare:/);
    expect(existsSync(factoryOwnerPath(h.root, ISSUE))).toBe(false);
  });

  it('changes-requested: a fresh fix lane at the head, a plain push, then a new review on the new head', async () => {
    const finding = { severity: 'major', file: 'src/greet.ts', line: 1, summary: 'greet must return hi' };
    const { lanes, done } = run([commitFile('src/greet.ts', 'x\n'), review('request-changes', [finding]), commitFile('src/greet.ts', 'hi\n'), review('approve')]);
    const out = await done;
    expect(out.gate?.name).toBe('prepare');
    const state = readFactoryState(h.root, ISSUE)!;
    expect(lanes.started.map((s) => s.laneId)).toEqual([`issue-${ISSUE}-implement-1`, `issue-${ISSUE}-review-1`, `issue-${ISSUE}-fix-1`, `issue-${ISSUE}-review-2`]);
    const firstHead = state.lanes[0].endSha!;
    expect(lanes.started[2].baseRef).toBe(firstHead);
    expect(lanes.started[2].profile).toBe('write');
    expect(lanes.started[2].prompt).toContain('greet must return hi');
    expect(lanes.started[3].baseRef).toBe(state.head);
    expect(state.head).not.toBe(firstHead);
    expect(h.calls.filter((c) => c.startsWith('git push '))).toHaveLength(2);
    expect(h.calls.filter((c) => c.startsWith('gh pr create'))).toHaveLength(1);
    const ship = readShipState(h.root, PR)!;
    expect(ship.fixRounds).toBe(1);
    expect(ship.verdicts.map((v) => v.verdict)).toEqual(['changes-requested', 'approve']);
  });

  it('an approve carrying a blocker or major finding counts as changes-requested', async () => {
    const { done } = run([commitFile('a.ts'), review('approve', [{ severity: 'blocker', summary: 'breaks build' }])], { limits: limits({ maxFixRounds: 0 }) });
    const out = await done;
    expect(out.exitCode).toBe(EXIT_AWAITING_HUMAN);
    expect(out.gate?.name).toBe('fix-rounds-spent');
    const ship = readShipState(h.root, PR)!;
    expect(ship.verdicts[0].verdict).toBe('changes-requested');
    expect(ship.phase).toBe('blocked');
    expect(readFactoryState(h.root, ISSUE)!.lanes[1].verdict).toBe('changes-requested');
  });

  it('no Acceptance criteria and no omg-plan link parks at needs-plan without a lane', async () => {
    h.gh.issue.body = 'please add greet';
    const { lanes, done } = run([]);
    const out = await done;
    expect(out.gate?.name).toBe('needs-plan');
    expect(lanes.started).toHaveLength(0);
  });

  it('an omg-plan link (optional) is read from the base branch with its blob sha', async () => {
    h.gh.issue.body = 'see plan';
    h.gh.issue.comments = [{ body: 'omg-plan: docs/plan.md' }];
    const { lanes, done } = run([commitFile('a.ts'), review('approve')]);
    await done;
    const state = readFactoryState(h.root, ISSUE)!;
    expect(state.plan).toMatchObject({ source: 'link', path: 'docs/plan.md', blob: gitIn(h.root, 'rev-parse', 'origin/dev:docs/plan.md') });
    expect(lanes.started[0].prompt).toContain('Add greet().');
  });

  it('a lane without commits gets one fresh retry, then implement-failed', async () => {
    const { lanes, done } = run([noCommit, noCommit]);
    const out = await done;
    expect(out.gate?.name).toBe('implement-failed');
    expect(lanes.started.map((s) => s.laneId)).toEqual([`issue-${ISSUE}-implement-1`, `issue-${ISSUE}-implement-2`]);
    expect(remoteHead(h)).toBeNull();
  });

  it('a lane writing a merge-rule path parks at protected-paths and pushes nothing', async () => {
    const { done } = run([commitFile('.github/workflows/ci.yml', 'on: push\n')]);
    const out = await done;
    expect(out.gate?.name).toBe('protected-paths');
    expect(remoteHead(h)).toBeNull();
    expect(h.calls.some((c) => c.startsWith('git push'))).toBe(false);
  });

  it('maxRunCredits stops at a step boundary with a resumable awaiting-human: budget', async () => {
    const first = run([commitFile('a.ts', 'a\n', 15)], { limits: limits({ maxRunCredits: 40 }) });
    const out = await first.done;
    expect(out.gate?.name).toBe('budget');
    expect(out.gate?.reason).toMatch(/15\.00 of factory\.run\.maxRunCredits 40/);
    expect(readFactoryState(h.root, ISSUE)!.phase).toBe('review');

    // The owner raises the limit and reruns: the run resumes at review, the lane cap is what is left.
    const second = run([review('approve')], { limits: limits({ maxRunCredits: 50 }) });
    const resumed = await second.done;
    expect(resumed.gate?.name).toBe('prepare');
    expect(second.lanes.started[0].maxCredits).toBe(30);
    expect(readFactoryState(h.root, ISSUE)!.history.some((e) => e.note === 'rerun after awaiting-human: budget')).toBe(true);
  });

  it('lowers a lane cap to what maxRunCredits leaves', async () => {
    const { lanes, done } = run([commitFile('a.ts', 'a\n', 40), review('approve')], { limits: limits({ maxRunCredits: 75, laneMaxCredits: 40 }) });
    const out = await done;
    expect(out.gate?.name).toBe('prepare');
    expect(lanes.started.map((s) => s.maxCredits)).toEqual([40, 35]);
  });

  it('refuses to start without a resolved per-lane credit cap at or above the CLI minimum', async () => {
    const lanes = new FakeLanes(h.root, []);
    await expect(runFactoryEngine(opts(lanes, { limits: limits({ laneMaxCredits: 10 }) }))).rejects.toThrow(/below the Copilot CLI minimum of 30/);
    await expect(runFactoryEngine(opts(lanes, { limits: { ...limits(), laneMaxCredits: undefined as unknown as number } }))).rejects.toThrow(/no per-lane AI-credit cap/);
    expect(existsSync(factoryStatePath(h.root, ISSUE))).toBe(false);
  });

  it('an invalid review output gets one fresh retry, then review-invalid; no verdict is recorded', async () => {
    const bad: LaneScript = () => ({ finalText: 'looks fine to me' });
    const { lanes, done } = run([commitFile('a.ts'), bad, bad]);
    const out = await done;
    expect(out.gate?.name).toBe('review-invalid');
    expect(lanes.started.filter((s) => s.profile === 'review')).toHaveLength(2);
    expect(readShipState(h.root, PR)!.verdicts).toHaveLength(0);
    expect(readFactoryState(h.root, ISSUE)!.lanes.slice(1).map((l) => l.verdict)).toEqual(['invalid', 'invalid']);
  });

  it.each([
    ['a new ref', (c: { root: string }) => gitIn(c.root, 'branch', 'evil', 'HEAD'), /ref refs\/heads\/evil was created/],
    ['an appended git config line', (c: { root: string }) => appendFileSync(join(c.root, '.git', 'config'), '[alias]\n\tp = push\n'), /common git config changed/],
  ])('a review lane that leaves %s fails as review-tampered and its approve is discarded', async (_name, tamper, problem) => {
    const { done } = run([commitFile('a.ts'), review('approve', [], tamper)]);
    const out = await done;
    expect(out.gate?.name).toBe('review-tampered');
    expect(out.gate?.reason).toMatch(problem);
    expect(readShipState(h.root, PR)!.verdicts).toHaveLength(0);
    expect(readFactoryState(h.root, ISSUE)!.lanes[1].verdict).toBe('invalid');
  });

  it('a lost lane is respawned once; a second loss in a row parks at lane-lost', async () => {
    const lost: LaneScript = () => ({ lost: true });
    const { lanes, done } = run([lost, lost]);
    const out = await done;
    expect(out.gate?.name).toBe('lane-lost');
    expect(lanes.started).toHaveLength(2);
    expect(readFactoryState(h.root, ISSUE)!.lanes.map((l) => l.status)).toEqual(['lost', 'lost']);
  });

  it('resume: a lane recorded running is lost, its worktree kept, and one fresh lane starts', async () => {
    // First run parks at needs-plan; then a crashed lane is simulated in the state.
    h.gh.issue.body = 'nothing yet';
    await run([]).done;
    updateFactoryState(h.root, ISSUE, (s) => ({
      ...s!, phase: 'implement', gate: undefined, plan: { source: 'issue-body', text: 'do it' },
      lanes: [{ id: `issue-${ISSUE}-implement-1`, kind: 'implement', jobId: 'cr-dead', startSha: 'a'.repeat(40), status: 'running', maxCredits: 30, startedAt: s!.createdAt }],
    }));
    const { lanes, done } = run([commitFile('a.ts'), review('approve')]);
    const out = await done;
    expect(out.gate?.name).toBe('prepare');
    const state = readFactoryState(h.root, ISSUE)!;
    expect(state.lanes[0].status).toBe('lost');
    expect(state.history.some((e) => /lost at resume/.test(e.note))).toBe(true);
    expect(lanes.started[0].laneId).toBe(`issue-${ISSUE}-implement-2`);
  });

  it('cancel during a lane wait cancels the lane and ends cancelled (PR comment, nothing removed)', async () => {
    const lanes = new FakeLanes(h.root, [commitFile('a.ts'), review('approve')], [0, 50]);
    let asked = false;
    lanes.onRunningPoll = () => {
      if (!asked) { asked = true; requestFactoryCancel(h.root, ISSUE, new Date().toISOString()); }
    };
    const out = await runFactoryEngine(opts(lanes));
    expect(out.exitCode).toBe(0);
    expect(out.phase).toBe('cancelled');
    expect(lanes.cancelled).toEqual(['cr-fake2']);
    const state = readFactoryState(h.root, ISSUE)!;
    expect(state.lanes[1].status).toBe('cancelled');
    expect(h.calls.some((c) => c.startsWith(`gh pr comment ${PR}`))).toBe(true);
    expect(remoteHead(h)).toBe(state.head);
    const events = parseProgressLog(readFileSync(factoryProgressFile(h.root, ISSUE), 'utf8'));
    expect(events.at(-1)).toMatchObject({ status: 'done' });
    // A later run is a no-op on a cancelled state.
    const again = await run([]).done;
    expect(again.phase).toBe('cancelled');
  });

  it('a signal interrupt cancels like the cancel command', async () => {
    let interrupted = false;
    const lanes = new FakeLanes(h.root, [commitFile('a.ts')], [3]);
    lanes.onRunningPoll = () => { interrupted = true; };
    const out = await runFactoryEngine(opts(lanes, { interrupted: () => interrupted }));
    expect(out.phase).toBe('cancelled');
    expect(lanes.cancelled).toEqual(['cr-fake1']);
  });

  it('a PR head the engine did not push parks at head-moved-externally before any review lane', async () => {
    h.gh.headOverride = 'b'.repeat(40);
    const { lanes, done } = run([commitFile('a.ts')]);
    const out = await done;
    expect(out.gate?.name).toBe('head-moved-externally');
    expect(lanes.started).toHaveLength(1);
  });

  it('publish after a crash between push and record pushes and creates nothing twice', async () => {
    const first = run([commitFile('a.ts')], { limits: limits({ maxRunCredits: 34 }) });
    await first.done; // parks at budget before review: head pushed, PR created
    const before = h.calls.length;
    // Simulate the crash: the state still says publish with the same pending head.
    updateFactoryState(h.root, ISSUE, (s) => ({ ...s!, phase: 'publish', gate: undefined, pendingHead: s!.head, pr: undefined }));
    const second = run([review('approve')]);
    const out = await second.done;
    expect(out.gate?.name).toBe('prepare');
    const later = h.calls.slice(before);
    expect(later.some((c) => c.startsWith('git push'))).toBe(false);
    expect(later.some((c) => c.startsWith('gh pr create'))).toBe(false);
    expect(readFactoryState(h.root, ISSUE)!.pr).toBe(PR);
  });

  it('ship state wins on resume: a verdict recorded before a crash is adopted, not re-reviewed', async () => {
    await run([commitFile('a.ts'), review('approve')]).done;
    updateFactoryState(h.root, ISSUE, (s) => ({ ...s!, phase: 'review', gate: undefined }));
    const { lanes, done } = run([]);
    const out = await done;
    expect(out.gate?.name).toBe('prepare');
    expect(lanes.started).toHaveLength(0);
    expect(readShipState(h.root, PR)!.verdicts).toHaveLength(1);
  });

  it('a live owner refuses a second runner; a dead pid on this host is taken over', async () => {
    mkdirSync(factoryStateDir(h.root), { recursive: true });
    writeFileSync(factoryOwnerPath(h.root, ISSUE), JSON.stringify({ pid: 99, hostname: 'test-host', startedAt: 'x' }));
    const lanes = new FakeLanes(h.root, []);
    await expect(runFactoryEngine(opts(lanes, { owner: { pid: 4242, hostname: 'test-host', isAlive: () => true } }))).rejects.toThrow(/already running \(pid 99/);
    h.gh.issue.body = 'no plan';
    const out = await runFactoryEngine(opts(lanes, { owner: { pid: 4242, hostname: 'test-host', isAlive: () => false } }));
    expect(out.gate?.name).toBe('needs-plan');
    expect(existsSync(factoryOwnerPath(h.root, ISSUE))).toBe(false);
  });

  it('a hand-edited state fails its integrity check: failed, exit 1, file untouched', async () => {
    h.gh.issue.body = 'no plan';
    await run([]).done;
    const path = factoryStatePath(h.root, ISSUE);
    const edited = readFileSync(path, 'utf8').replace('"phase": "plan"', '"phase": "review"');
    writeFileSync(path, edited);
    const out = await run([]).done;
    expect(out.exitCode).toBe(1);
    expect(out.phase).toBe('failed');
    expect(readFileSync(path, 'utf8')).toBe(edited);
  });

  it('a closed issue ends cancelled at intake', async () => {
    h.gh.issue.state = 'CLOSED';
    const out = await run([]).done;
    expect(out.phase).toBe('cancelled');
  });

  it('the run wall-time limit parks at wall-time at a step boundary', async () => {
    let t = 1_000_000;
    const out = await run([], { limits: limits({ maxRunWallTimeMs: 1 }), now: () => (t += 10) }).done;
    expect(out.gate?.name).toBe('wall-time');
  });

  it('a gh failure fails the step with exit 1 and leaves the phase for a rerun', async () => {
    h.exec = ((inner) => (cmd: string, args: string[], o?: Parameters<typeof inner>[2]) => (cmd === 'gh' && args[0] === 'issue' ? { status: 1, stdout: '', stderr: 'HTTP 502' } : inner(cmd, args, o)))(h.exec);
    const out = await run([]).done;
    expect(out.exitCode).toBe(1);
    expect(out.message).toMatch(/HTTP 502/);
    expect(readFactoryState(h.root, ISSUE)!.phase).toBe('intake');
  });

  it('--dry-run reads the issue and plan only: no state, owner, lanes or pushes', async () => {
    const lanes = new FakeLanes(h.root, []);
    const out = await runFactoryEngine(opts(lanes, { dryRun: true }));
    expect(out.plan).toMatchObject({ next: 'implement', laneMaxCredits: 30 });
    expect(existsSync(factoryStatePath(h.root, ISSUE))).toBe(false);
    expect(lanes.started).toHaveLength(0);
    expect(h.calls.every((c) => c.startsWith('gh issue view'))).toBe(true);
  });
});
