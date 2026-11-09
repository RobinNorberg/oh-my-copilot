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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_FACTORY_RUN_LIMITS } from '../../factory/run/budget.js';
import { runFactoryEngine, type FactoryEngineOptions, type FactoryHealStart } from '../../factory/run/engine.js';
import { readFactoryState, requestFactoryCancel, type FactoryHealRecord } from '../../factory/run/state.js';
import {
  commitFile, failedGates, FakeLanes, FakeProcesses, gitIn, greenGates, harness, ISSUE, PR, pendingGates, review, testGateConfig,
  type Harness, type LaneScript,
} from '../../factory/run/__tests__/fake-lanes.js';
import { factoryGuardExec } from '../../factory/run/exec.js';
import { FakeAgentGithub, ghTime, installFakeAgent } from '../../factory/run/__tests__/fake-coding-agent.js';
import { CODING_AGENT_STATUS_QUERY } from '../github/coding-agent.js';
import { ghRepoArg } from '../github/gh.js';
import { githubReviews } from '../github/reviews.js';
import type { ForgeRepo } from '../types.js';
import { recordingExec } from './recording-exec.js';
import { scaleTiming } from '../../__tests__/helpers/platform.js';

// Every engine run here drives a few hundred real git processes (the lane
// tamper snapshots, prepare merges, the bare remote). No assertion measures
// time, so the timeout only bounds a hang and must leave a loaded host's
// process spawns room.
vi.setConfig({ testTimeout: scaleTiming(90_000) });

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
/** The merge park: the PR view, the merge-rule gate read on that head, the PR comment with the command (the item's gate comment and its read for a parent rollup follow). */
const MERGE_PARK = (key: string) => [MERGE_VIEW, REVIEW_READ, CHECKS, runList('<head>'), VIEW_HEAD, comment('pr', PR, key, 'merge')];

/** The review-feedback query as literal text: any change to REVIEW_FEEDBACK_QUERY must break this test (the query is part of the pinned gh argv). */
const PINNED_REVIEW_FEEDBACK_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){viewer{login} repository(owner:$owner,name:$name){viewerPermission collaborators(first:100){pageInfo{hasNextPage} edges{permission node{login}}} pullRequest(number:$number){headRefOid latestReviews(first:50){pageInfo{hasNextPage} nodes{id state submittedAt body author{__typename login} commit{oid}}} latestOpinionatedReviews(first:50){pageInfo{hasNextPage} nodes{state submittedAt body author{__typename login} commit{oid}}} reviewRequests(first:20){pageInfo{hasNextPage} nodes{requestedReviewer{__typename ... on User{login} ... on Bot{login} ... on Mannequin{login} ... on Team{slug}}}} reviewThreads(first:100){pageInfo{hasNextPage} nodes{id isResolved isOutdated comments(first:20){pageInfo{hasNextPage} nodes{body path line originalLine createdAt author{__typename login}}}}}}}}';
/** The merge step's human review read of the run's sealed repository: a GitHub run without a forge config (issue or ci-heal) reads it too (PR #471 HIGH-2). */
const REVIEW_READ = `gh ${JSON.stringify(['api', 'graphql', '--hostname', 'github.com', '-f', `query=${PINNED_REVIEW_FEEDBACK_QUERY}`, '-f', 'owner=o', '-f', 'name=r', '-F', `number=${PR}`])} cwd=<root>`;

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
      ...MERGE_PARK(KEY), comment('issue', ISSUE, KEY, 'gate'), ISSUE_VIEW,
    ]);
  });

  it('a later run after the human merge reads the PR once and finishes merged', async () => {
    await engine([commitFile('a.ts'), review('approve')]);
    h.gh.merged = true;
    const { out, calls } = await engine([]);
    expect(out.phase).toBe('merged');
    // The item read for its parent (none here), then the outcome comment.
    expect(calls).toEqual([MERGE_VIEW, ISSUE_VIEW, comment('issue', ISSUE, KEY, 'outcome-7')]);
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
      ...MERGE_PARK(KEY), comment('issue', ISSUE, KEY, 'gate'), ISSUE_VIEW,
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
      ISSUE_VIEW, comment('issue', ISSUE, KEY, 'outcome-7'),
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

describe('gh argv baseline: the Copilot coding agent as implementer (night 3 goal 6, L6b)', () => {
  it('first run: intake, the pre-assign status read, the assign POST, the confirming read; the wait park posts no comment', async () => {
    const fake = new FakeAgentGithub(() => ghTime(t));
    installFakeAgent(h, fake);
    const { out, calls } = await engine([], { codingAgentUserConfig: { factory: { run: { implementer: 'coding-agent' }, codingAgent: { repos: ['o/r'] } } } });
    expect(out.gate?.name, out.message).toBe('coding-agent-wait');
    const status = (since: string) => `gh ${JSON.stringify(['api', 'graphql', '--hostname', 'github.com', '-f', `query=${CODING_AGENT_STATUS_QUERY}`, '-f', 'owner=o', '-f', 'name=r', '-F', `number=${ISSUE}`, '-f', `since=${since}`])} cwd=<root>`;
    expect(calls).toEqual([
      ISSUE_VIEW, prList(BRANCH),
      // The pre-assign read from 2008 (PRE_ASSIGN_SINCE minus the skew margin), then the assign and its read from the local clock minus 120 s.
      status('2008-01-01T00:00:00Z'),
      `gh ${JSON.stringify(['api', '--hostname', 'github.com', '--method', 'POST', `repos/o/r/issues/${ISSUE}/assignees`, '-f', 'assignees[]=copilot-swe-agent[bot]', '-f', 'agent_assignment[base_branch]=dev'])} cwd=<root>`,
      status('2026-10-27T09:58:00Z'),
    ]);
  });
});

describe('gh argv baseline: the human review read (night 3 goal 2; the engine call lands with L2b)', () => {
  it('reviewFeedback issues one exact gh api graphql argv through the run guard with the GitHub read context', () => {
    const repo: ForgeRepo = { kind: 'github', host: 'github.com', owner: 'acme', name: 'widgets', url: 'https://github.com/acme/widgets' };
    const head = 'c'.repeat(40);
    const done = { hasNextPage: false };
    const answer = JSON.stringify({
      data: {
        viewer: { login: 't' },
        repository: {
          viewerPermission: 'ADMIN', collaborators: { pageInfo: done, edges: [] },
          pullRequest: { headRefOid: head, latestReviews: { pageInfo: done, nodes: [] }, latestOpinionatedReviews: { pageInfo: done, nodes: [] }, reviewRequests: { pageInfo: done, nodes: [] }, reviewThreads: { pageInfo: done, nodes: [] } },
        },
      },
    });
    const r = recordingExec(() => ({ status: 0, stdout: answer, stderr: '' }), { '<root>': h.root }, ['gh']);
    const guarded = factoryGuardExec(r.exec, () => ['dev'], undefined, undefined, undefined, () => ({ repo: ghRepoArg(repo) }));
    githubReviews(guarded, h.root, { repo }).reviewFeedback!(PR, head);
    expect(r.calls).toEqual([
      `gh ${JSON.stringify(['api', 'graphql', '--hostname', 'github.com', '-f', `query=${PINNED_REVIEW_FEEDBACK_QUERY}`, '-f', 'owner=acme', '-f', 'name=widgets', '-F', `number=${PR}`])} cwd=<root>`,
    ]);
  });
});
