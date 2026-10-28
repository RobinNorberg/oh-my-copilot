/**
 * gh argv-parity baseline, factory engine side (factory forges design §A.6):
 * the exact ordered gh sequence of `src/factory/run/engine.ts` (its private
 * run/ghJson and the direct comment calls), `gates-driver.ts` and
 * `merge-policy.ts`, recorded where the engine hands commands to its Exec
 * (below hardening and the factory guard). Fake lanes, real git with a local
 * bare remote, the scripted gh of fake-lanes.ts. git and node calls are not
 * recorded: the forge move leaves them where they are.
 */
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_FACTORY_RUN_LIMITS } from '../../factory/run/budget.js';
import { runFactoryEngine, type FactoryEngineOptions, type FactoryHealStart } from '../../factory/run/engine.js';
import { readFactoryState, requestFactoryCancel, type FactoryHealRecord } from '../../factory/run/state.js';
import {
  commitFile, failedGates, FakeLanes, FakeProcesses, gitIn, greenGates, harness, ISSUE, PR, pendingGates, review, testGateConfig,
  type Harness, type LaneScript,
} from '../../factory/run/__tests__/fake-lanes.js';
import { recordingExec } from './recording-exec.js';

let h: Harness;
let t: number;

beforeEach(() => {
  h = harness('omg-gh-baseline-factory-');
  gitIn(h.root, 'config', 'user.name', 't');
  gitIn(h.root, 'config', 'user.email', 't@example.invalid');
  t = Date.parse('2026-10-27T10:00:00.000Z');
});

afterEach(() => {
  rmSync(h.dir, { recursive: true, force: true });
});

/** One engine run with the gh calls it issued; `lanes` overrides the fake lane backend. */
async function engine(scripts: LaneScript[], over: Partial<FactoryEngineOptions> = {}, lanes = new FakeLanes(h.root, scripts)) {
  const r = recordingExec(h.exec, { '<root>': h.root, '<dir>': h.dir }, ['gh']);
  const out = await runFactoryEngine({
    root: h.root, issue: ISSUE, exec: r.exec, lanes, limits: DEFAULT_FACTORY_RUN_LIMITS, base: 'dev', pollMs: 5,
    owner: { pid: 4242, hostname: 'test-host', isAlive: () => false }, ledgerDir: h.ledgerDir, processes: new FakeProcesses(),
    gateConfig: testGateConfig, now: () => t, sleep: async (ms) => { t += ms; },
    ...over,
  });
  return { out, calls: r.calls };
}

/** Lane commits carry wall-clock dates: name each sha. */
const named = (calls: string[], shas: Record<string, string>): string[] =>
  calls.map((c) => Object.entries(shas).reduce((line, [name, sha]) => line.split(sha).join(name), c));

const ISSUE_VIEW = `gh ["issue","view","${ISSUE}","--json","title,body,labels,state,url,author,comments"] cwd=<root>`;
const prList = (branch: string) => `gh ["pr","list","--head","${branch}","--json","number,state,headRefOid,url"] cwd=<root>`;
const prCreate = (branch: string, title: string, key: string) =>
  `gh ["pr","create","--draft","--base","dev","--head","${branch}","--title","${title}","--body-file","<root>/.omg/state/factory/run-${key}-pr-body.md"] cwd=<root>`;
const comment = (target: 'issue' | 'pr', n: number, key: string, name: string) =>
  `gh ["${target}","comment","${n}","--body-file","<root>/.omg/state/factory/run-${key}-${name}.md"] cwd=<root>`;
const MERGE_VIEW = `gh ["pr","view","${PR}","--json","number,state,isDraft,baseRefName,baseRefOid,headRefOid"] cwd=<root>`;
const HEAD_STATE = `gh ["pr","view","${PR}","--json","headRefOid,state"] cwd=<root>`;
const VIEW_HEAD = `gh ["pr","view","${PR}","--json","headRefOid"] cwd=<root>`;
const CHECKS = `gh ["pr","checks","${PR}","--json","name,state,bucket,link,workflow,event,startedAt,completedAt"] cwd=<root>`;
const READY = `gh ["pr","ready","${PR}"] cwd=<root>`;
const runList = (sha: string) => `gh ["run","list","--commit","${sha}","--json","databaseId,status,conclusion,workflowName,headSha","--limit","100"] cwd=<root>`;

const BRANCH = `factory/issue-${ISSUE}`;
const KEY = String(ISSUE);
/** The review phase: head read before the lane and on its verdict, then the review comment. */
const REVIEW = (key: string) => [HEAD_STATE, HEAD_STATE, comment('pr', PR, key, 'review')];
/** One gates-loop read on a fixed head (checks, runs, the head re-read), then the driver's own head and runs read. */
const GATES_GREEN = [HEAD_STATE, CHECKS, runList('<head>'), VIEW_HEAD, HEAD_STATE, runList('<head>')];
/** The merge park: the PR view, the merge-rule gate read on that head, the PR comment with the command. */
const MERGE_PARK = (key: string) => [MERGE_VIEW, CHECKS, runList('<head>'), VIEW_HEAD, comment('pr', PR, key, 'merge')];

describe('gh argv baseline: factory engine (issue run)', () => {
  it('happy path to the merge park: intake, publish, review, prepare, gates, merge gate', async () => {
    const { out, calls } = await engine([commitFile('src/greet.ts', 'export const greet = () => "hi";\n'), review('approve')]);
    expect(out.gate?.name, out.message).toBe('merge');
    const head = readFactoryState(h.root, ISSUE)!.head!;
    expect(named(calls, { '<head>': head })).toEqual([
      ISSUE_VIEW, prList(BRANCH),
      prList(BRANCH), prCreate(BRANCH, `Add greet() (#${ISSUE})`, KEY),
      ...REVIEW(KEY),
      MERGE_VIEW, READY, MERGE_VIEW,
      ...GATES_GREEN,
      ...MERGE_PARK(KEY), comment('issue', ISSUE, KEY, 'gate'),
    ]);
  });

  it('a later run after the human merge reads the PR once and finishes merged', async () => {
    await engine([commitFile('a.ts'), review('approve')]);
    h.gh.merged = true;
    const { out, calls } = await engine([]);
    expect(out.phase).toBe('merged');
    expect(calls).toEqual([MERGE_VIEW]);
  });

  it('pending -> red -> ci-fix -> green: the failed job log is read for its test titles', async () => {
    h.gh.gates = [pendingGates(100), failedGates(100), greenGates(101)];
    h.gh.logs['200'] = 'Test\tRun tests\t2026-10-27T10:00:00.0000000Z  FAIL  src/greet.test.ts > greet > returns hi\n';
    const { out, calls } = await engine([commitFile('src/greet.ts', 'x\n'), review('approve'), commitFile('src/greet.ts', 'hi\n'), review('approve')]);
    expect(out.gate?.name, out.message).toBe('merge');
    const state = readFactoryState(h.root, ISSUE)!;
    expect(named(calls, { '<red>': state.lanes[0].endSha!, '<head>': state.head! })).toEqual([
      ISSUE_VIEW, prList(BRANCH),
      prList(BRANCH), prCreate(BRANCH, `Add greet() (#${ISSUE})`, KEY),
      ...REVIEW(KEY),
      MERGE_VIEW, READY, MERGE_VIEW,
      // Pending, then failed: one watch per window, then the driver reads the runs and the failed job's log.
      HEAD_STATE, CHECKS, runList('<red>'), VIEW_HEAD, CHECKS, runList('<red>'), VIEW_HEAD,
      HEAD_STATE, runList('<red>'), 'gh ["run","view","--job","200","--log"] cwd=<root>',
      // The ci-fix push, a new review on the new head; prepare without a second `pr ready`.
      ...REVIEW(KEY),
      MERGE_VIEW, MERGE_VIEW,
      ...GATES_GREEN,
      ...MERGE_PARK(KEY), comment('issue', ISSUE, KEY, 'gate'),
    ]);
  });

  it('cancel during the review lane: one PR comment with the cancel body', async () => {
    const lanes = new FakeLanes(h.root, [commitFile('a.ts'), review('approve')], [0, 50]);
    let asked = false;
    lanes.onRunningPoll = () => {
      if (!asked) { asked = true; requestFactoryCancel(h.root, ISSUE, new Date(t).toISOString()); }
    };
    const { out, calls } = await engine([], {}, lanes);
    expect(out.phase).toBe('cancelled');
    expect(calls).toEqual([
      ISSUE_VIEW, prList(BRANCH),
      prList(BRANCH), prCreate(BRANCH, `Add greet() (#${ISSUE})`, KEY),
      HEAD_STATE,
      comment('pr', PR, KEY, 'cancel'),
    ]);
  });

  it('no plan: the needs-plan gate posts one issue comment', async () => {
    h.gh.issue.body = 'no plan here';
    const { out, calls } = await engine([]);
    expect(out.gate?.name).toBe('needs-plan');
    expect(calls).toEqual([ISSUE_VIEW, prList(BRANCH), comment('issue', ISSUE, KEY, 'gate')]);
  });

  it('--dry-run reads the issue only', async () => {
    const { calls } = await engine([], { dryRun: true });
    expect(calls).toEqual([ISSUE_VIEW]);
  });
});

describe('gh argv baseline: factory engine (ci-heal run)', () => {
  const SIG8 = '0a1b2c3d';
  const HEAL_KEY = `heal-${SIG8}`;
  const HEAL_BRANCH = `factory/${HEAL_KEY}`;

  function record(): FactoryHealRecord {
    const red = gitIn(h.root, 'rev-parse', 'origin/dev');
    return {
      sig8: SIG8,
      class: 'env-change',
      firstRed: { runId: '40542274776', sha: red },
      lastGreen: { runId: '40584638028', sha: red },
      failingTests: ['src/a.test.ts > a > works'],
      env: [{ field: 'git', green: '2.55.0', red: '2.56.0' }],
      diagnosis: { class: 'env-change', rootCause: 'git 2.56 changed a message.', evidence: ['failures/1.log:2'], reproduced: false, fix: { summary: 'Accept both messages.', files: ['src/a.test.ts'], acceptance: ['passes'] } },
    };
  }
  const heal = (over: Partial<FactoryHealStart> = {}): Partial<FactoryEngineOptions> => ({
    issue: undefined,
    heal: { sig8: SIG8, record: record(), autoImplement: false, laneCap: (cap) => ({ ok: true, cap }), ...over },
  });

  beforeEach(() => {
    h.gh.branch = HEAL_BRANCH;
  });

  it('intake reads the repository url (engine.ts healIntake), then the open PRs on the heal branch, and parks at heal-approve', async () => {
    const { calls } = await engine([], heal());
    expect(calls).toEqual(['gh ["repo","view","--json","url"] cwd=<root>', prList(HEAL_BRANCH)]);
  });

  it('approved: through implement, review, prepare and gates to the merge park; no issue comment', async () => {
    await engine([], heal());
    const { out, calls } = await engine([commitFile('src/a.test.ts', 'export {};\n'), review('approve')], heal({ approved: true, record: undefined }));
    expect(out.gate?.name, out.message).toBe('merge');
    const head = readFactoryState(h.root, HEAL_KEY)!.head!;
    expect(named(calls, { '<head>': head })).toEqual([
      prList(HEAL_BRANCH), prCreate(HEAL_BRANCH, `fix(ci): self-heal for CI signature ${SIG8}`, HEAL_KEY),
      ...REVIEW(HEAL_KEY),
      MERGE_VIEW, READY, MERGE_VIEW,
      ...GATES_GREEN,
      ...MERGE_PARK(HEAL_KEY),
    ]);
  });
});
