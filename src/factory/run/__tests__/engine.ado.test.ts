/**
 * `omg factory run` on Azure DevOps (factory forges design §9 PR 6): the
 * engine with real git and fake lanes, every forge call an `az devops
 * invoke` through the real factory guard and the ADO adapter, answered by a
 * small Azure DevOps model whose bodies are the PR 5 fixtures (heads and
 * ids joined to the run's real commits).
 */
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadAdoFixtures } from '../../../forge/ado/__tests__/fixtures.js';
import { adoConfig, POSIX_ENTRY, REPO } from '../../../forge/ado/__tests__/world.js';
import { BUILD_POLICY_TYPE } from '../../../forge/ado/checks.js';
import { parseAdoInvoke } from '../../../forge/ado/guard.js';
import { readShipState } from '../../../ship/state.js';
import { defaultExec, type Exec, type ExecResult } from '../../../ship/exec.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../budget.js';
import { ADO_HEAD_LAG_POLLS, runFactoryEngine, type FactoryEngineOptions, type FactoryForgeInput } from '../engine.js';
import { factoryForgeOptions } from '../forge-roots.js';
import { readFactoryState, requestFactoryCancel } from '../state.js';
import { commitFile, FakeLanes, FakeProcesses, harness, ISSUE, remoteHead, review, testGateConfig, type Harness, type LaneScript } from './fake-lanes.js';

const ADO_URL = REPO.url;
const PR_ID = 17;
const PROJECT_ID = '6ce954b1-ce1f-45d1-b94d-e6bf2464ba2c';
const MERGE_COMMIT = '3'.repeat(40);

const fixtures = loadAdoFixtures();
const fixture = (name: string): any => structuredClone(fixtures.find((f) => f.name === name)!.stdout);

interface AdoCall { route: string; routeParameters: Record<string, string>; queryParameters: Record<string, string>; body?: any }

/** The Azure DevOps side of one run: work item ISSUE, PR 17 on the harness's bare remote. */
class AdoModel {
  readonly calls: AdoCall[] = [];
  prCreated = false;
  ready = false;
  /** Reported instead of the branch head (a push the engine did not make). */
  headOverride?: string;
  /** The next `reads` PR reads report `sha` (lastMergeSourceCommit lagging a push). */
  lag?: { sha: string; reads: number };
  /** Work item PATCHes answered with a rev conflict before one succeeds. */
  revConflicts = 0;

  constructor(private readonly h: Harness) {}

  private dev(): string {
    return defaultExec('git', ['ls-remote', this.h.bare, 'refs/heads/dev']).stdout.split(/\s+/)[0];
  }

  private head(): string {
    if (this.headOverride) return this.headOverride;
    if (this.lag && this.lag.reads > 0) {
      this.lag.reads -= 1;
      return this.lag.sha;
    }
    return remoteHead(this.h) ?? '';
  }

  private pr(): Record<string, unknown> {
    const v = fixture('git.pullRequests.GET.by-id.json');
    return {
      ...v,
      title: `Add greet() (#${ISSUE})`,
      sourceRefName: `refs/heads/factory/issue-${ISSUE}`,
      targetRefName: 'refs/heads/dev',
      isDraft: !this.ready,
      lastMergeSourceCommit: { commitId: this.head() },
      lastMergeTargetCommit: { commitId: this.dev() },
      lastMergeCommit: { commitId: MERGE_COMMIT },
    };
  }

  answer(args: string[]): ExecResult {
    const inv = parseAdoInvoke(args);
    if (typeof inv === 'string') throw new Error(inv);
    const at = args.indexOf('--in-file');
    const body = at >= 0 ? JSON.parse(readFileSync(args[at + 1], 'utf8')) : undefined;
    const { routeParameters: rp, queryParameters: qp } = inv;
    this.calls.push({ route: inv.route.id, routeParameters: rp, queryParameters: qp, ...(body !== undefined ? { body } : {}) });
    const ok = (v: unknown): ExecResult => ({ status: 0, stdout: JSON.stringify(v), stderr: '' });
    switch (inv.route.id) {
      case 'wit.workItems.GET': {
        if (rp.id !== String(ISSUE)) break;
        const item = fixture('wit.workItems.GET.42.json');
        item.id = ISSUE;
        item.fields['System.Title'] = 'Add greet()';
        item.fields['System.Description'] = '<div>A greeting helper.</div>';
        item.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] = '<ul><li>greet() returns hi</li></ul>';
        item._links.html.href = `https://dev.azure.com/contoso/Web/_workitems/edit/${ISSUE}`;
        return ok(item);
      }
      case 'wit.workItems.PATCH':
        if (rp.id !== String(ISSUE)) break;
        if (this.revConflicts > 0) {
          this.revConflicts -= 1;
          return { status: 1, stdout: '', stderr: 'ERROR: TF26071: This work item has been changed by someone else since you opened it.' };
        }
        return ok({ ...fixture('wit.workItems.PATCH.42.json'), id: ISSUE });
      case 'wit.workItemTypeStates.GET':
        return ok(fixture('wit.workItemTypeStates.GET.user-story.json'));
      case 'wit.comments.GET': {
        // The trusted owner's omg-plan line, and a newer one by a lookalike display name (untrusted: uniqueName differs).
        const c = fixture('wit.comments.GET.42.json');
        c.comments[0].text = '<div>omg-plan: docs/plan.md</div>';
        return ok(c);
      }
      case 'wit.comments.POST':
        return ok({ id: 60 + this.calls.length, text: body.text });
      case 'git.pullRequests.GET':
        if (qp['searchCriteria.sourceRefName']) return ok({ value: this.prCreated ? [{ pullRequestId: PR_ID, status: 'active' }] : [], count: this.prCreated ? 1 : 0 });
        if (rp.pullRequestId === String(PR_ID) && this.prCreated) return ok(this.pr());
        break;
      case 'git.pullRequests.POST':
        this.prCreated = true;
        return ok({ ...fixture('git.pullRequests.POST.create.json'), pullRequestId: PR_ID });
      case 'git.pullRequests.PATCH':
        this.ready = true;
        return ok(this.pr());
      case 'git.pullRequestThreads.POST':
        return ok({ id: this.calls.length, status: 'active' });
      case 'policy.evaluations.GET':
        if (qp.artifactId !== `vstfs:///CodeReview/CodeReviewId/${PROJECT_ID}/${PR_ID}`) break;
        return ok({
          value: [{
            evaluationId: 'e1a2b3c4-0000-4000-8000-000000000001',
            status: 'approved',
            configuration: { id: 4, isBlocking: true, settings: { displayName: 'Test' }, type: { id: BUILD_POLICY_TYPE, displayName: 'Build' } },
            context: { buildId: 101, isExpired: false, buildIsNotCurrent: false },
          }],
        });
      case 'build.builds.GET':
        if (qp.branchName !== `refs/pull/${PR_ID}/merge`) break;
        return ok({
          value: [{
            id: 101, status: 'completed', result: 'succeeded', definition: { name: 'CI' }, sourceVersion: MERGE_COMMIT,
            triggerInfo: { 'pr.sourceSha': remoteHead(this.h) },
          }],
        });
      default:
        break;
    }
    return { status: 1, stdout: '', stderr: `unscripted az call ${inv.route.id} ${JSON.stringify(rp)} ${JSON.stringify(qp)}` };
  }

  /** The PR thread bodies the engine posted. */
  threads(): string[] {
    return this.calls.filter((c) => c.route === 'git.pullRequestThreads.POST').map((c) => c.body.comments[0].content as string);
  }
}

let h: Harness;
let ado: AdoModel;
let sleeps: number[];

beforeEach(() => {
  h = harness('omg-factory-ado-');
  ado = new AdoModel(h);
  sleeps = [];
});

afterEach(() => {
  rmSync(h.dir, { recursive: true, force: true });
});

/** The harness's git (origin is the ADO repository), az to the model, and no gh at all. */
function adoExec(): Exec {
  return (cmd, args, opts) => {
    if (cmd === 'az') return ado.answer(args);
    if (cmd === 'gh') throw new Error(`gh ran on an Azure DevOps run: gh ${args.join(' ')}`);
    let plain = args;
    while (cmd === 'git' && plain[0] === '-c') plain = plain.slice(2);
    if (cmd === 'git' && plain[0] === 'remote' && plain[1] === 'get-url') return { status: 0, stdout: `${ADO_URL}\n`, stderr: '' };
    return h.exec(cmd, args, opts);
  };
}

const forgeInput = (over: Partial<FactoryForgeInput> = {}): FactoryForgeInput => ({
  config: adoConfig(),
  options: { ...factoryForgeOptions(h.root), stateDir: join(h.dir, 'forge-state') },
  entry: POSIX_ENTRY,
  ...over,
});

function opts(lanes: FakeLanes, over: Partial<FactoryEngineOptions> = {}): FactoryEngineOptions {
  return {
    root: h.root,
    issue: ISSUE,
    exec: adoExec(),
    lanes,
    limits: { ...DEFAULT_FACTORY_RUN_LIMITS },
    base: 'dev',
    pollMs: 5,
    owner: { pid: 4242, hostname: 'test-host', isAlive: () => false },
    ledgerDir: h.ledgerDir,
    processes: new FakeProcesses(),
    gateConfig: testGateConfig,
    sleep: async (ms) => { sleeps.push(ms); },
    forge: forgeInput(),
    ...over,
  };
}

const happy = (): LaneScript[] => [commitFile('src/greet.ts', 'export const greet = () => "hi";\n'), review('approve')];
const run = (scripts: LaneScript[], over: Partial<FactoryEngineOptions> = {}) => runFactoryEngine(opts(new FakeLanes(h.root, scripts), over));

/** Nothing merges: every PR PATCH is exactly the ready flip, and no az call completes a PR. */
function expectNoMerge(): void {
  for (const c of ado.calls) {
    if (c.route === 'git.pullRequests.PATCH') expect(c.body).toEqual({ isDraft: false });
    expect(JSON.stringify(c.body ?? {})).not.toMatch(/"status":"completed"|completionOptions|autoCompleteSetBy/);
  }
  expect(h.calls.some((c) => c.startsWith('gh '))).toBe(false);
}

describe('omg factory run on Azure DevOps (fake ADO, real git)', () => {
  it('intake -> plan -> implement -> draft PR -> review -> prepare -> gates -> awaiting-human: merge with the head-pinned body path and SHA', async () => {
    const out = await run(happy());

    expect(out.exitCode, out.message).toBe(0);
    expect(out.gate?.name).toBe('merge');
    const state = readFactoryState(h.root, ISSUE)!;
    expect(state.forgeKind).toBe('azure-devops');
    expect(state.repoUrl).toBe(ADO_URL);
    expect(state.pr).toBe(PR_ID);
    expect(state.head).toBe(remoteHead(h));
    // The trusted owner's omg-plan line wins over the newer lookalike's (uniqueName, not display name).
    expect(state.plan).toMatchObject({ source: 'link', path: 'docs/plan.md' });
    expect(state.issueBody).toContain('## Acceptance criteria');
    expect(state.issueBody).toContain('greet() returns hi');

    // The draft PR: the run's branch onto the base, linked to the work item.
    const created = ado.calls.find((c) => c.route === 'git.pullRequests.POST')!;
    expect(created.body).toMatchObject({ sourceRefName: `refs/heads/factory/issue-${ISSUE}`, targetRefName: 'refs/heads/dev', isDraft: true, workItemRefs: [{ id: String(ISSUE) }] });
    expect(created.body.description).toContain(`Work item #${ISSUE}`);
    expect(ado.calls.some((c) => c.route === 'git.pullRequests.PATCH')).toBe(true);
    expect(readShipState(h.root, PR_ID)!.phase).toBe('ready');
    // The gates read the branch policies and the exact-head builds of refs/pull/17/merge.
    const routes = new Set(ado.calls.map((c) => c.route));
    for (const r of ['policy.evaluations.GET', 'build.builds.GET', 'git.pullRequestThreads.POST', 'wit.comments.POST']) expect(routes.has(r), r).toBe(true);
    expect(readShipState(h.root, PR_ID)!.lastGates).toMatchObject({ verdict: 'green', failed: [], pending: [] });

    // The merge comment: the command a human runs, the body file it reads and that file's SHA-256.
    const merge = ado.threads().find((t) => t.includes('Merge is a human step'))!;
    expect(merge).toBeDefined();
    const bodyFile = /reads its body from `([^`]+)`/.exec(merge)![1];
    const sha = /SHA-256 `([0-9a-f]{64})`/.exec(merge)![1];
    expect(bodyFile.startsWith(join(h.dir, 'forge-state'))).toBe(true);
    expect(merge).toContain(`--in-file ${bodyFile}`);
    const content = readFileSync(bodyFile, 'utf8');
    expect(createHash('sha256').update(content, 'utf8').digest('hex')).toBe(sha);
    expect(JSON.parse(content)).toEqual({ status: 'completed', lastMergeSourceCommit: { commitId: state.head }, completionOptions: { mergeStrategy: 'noFastForward' } });
    expect(out.mergeCommand).toBe(`az devops invoke --area git --resource pullRequests --route-parameters project=Web repositoryId=web-app pullRequestId=${PR_ID} --http-method PATCH --api-version 7.1 --in-file ${bodyFile} --org https://dev.azure.com/contoso --detect false --output json`);
    // The gate comment went to the work item.
    expect(ado.calls.some((c) => c.route === 'wit.comments.POST' && /awaiting a human: \*\*merge\*\*/.test(c.body.text))).toBe(true);
    expectNoMerge();
  });

  it('a PR head the engine did not push stops the run at head-moved-externally', async () => {
    ado.headOverride = 'e'.repeat(40);
    const out = await run(happy());

    expect(out.gate?.name, out.message).toBe('head-moved-externally');
    expect(out.gate?.reason).toMatch(/PR #17 head is eeeeeeeeeeee/);
    expect(readFactoryState(h.root, ISSUE)!.phase).toBe('review');
    expectNoMerge();
  });

  it('a lagging lastMergeSourceCommit that is an ancestor of the engine push is pending: re-read, then the run goes on', async () => {
    ado.lag = { sha: defaultExec('git', ['ls-remote', h.bare, 'refs/heads/dev']).stdout.split(/\s+/)[0], reads: 3 };
    const out = await run(happy());

    expect(out.exitCode, out.message).toBe(0);
    expect(out.gate?.name).toBe('merge');
    expect(sleeps.filter((ms) => ms === 5).length).toBeGreaterThanOrEqual(3);
    expect(readFactoryState(h.root, ISSUE)!.history.some((e) => /head-moved/.test(e.note))).toBe(false);
  });

  it('a lag that outlasts the re-reads stops the step pending (no gate); a rerun once the forge caught up continues', async () => {
    const dev = defaultExec('git', ['ls-remote', h.bare, 'refs/heads/dev']).stdout.split(/\s+/)[0];
    ado.lag = { sha: dev, reads: 10_000 };
    const lanes = new FakeLanes(h.root, happy());
    const first = await runFactoryEngine(opts(lanes));

    expect(first.exitCode).toBe(1);
    expect(first.message).toMatch(/pending: Azure DevOps still reports PR #17 at .{12}, an ancestor of the engine's push/);
    const parked = readFactoryState(h.root, ISSUE)!;
    expect(parked.gate).toBeUndefined();
    expect(parked.phase).toBe('review');
    expect(sleeps.length).toBe(ADO_HEAD_LAG_POLLS);

    ado.lag = undefined;
    const again = await runFactoryEngine(opts(lanes));
    expect(again.exitCode, again.message).toBe(0);
    expect(again.gate?.name).toBe('merge');
  });

  it('refuses forge options without the full untrusted roots', async () => {
    await expect(run(happy(), { forge: forgeInput({ options: { untrustedRoots: [] } }) })).rejects.toThrow(/must list every untrusted root/);
    await expect(run(happy(), { forge: forgeInput({ options: { untrustedRoots: [h.root] } }) })).rejects.toThrow(/missing: /);
    await expect(run(happy(), { dryRun: true, forge: forgeInput({ options: { untrustedRoots: [] } }) })).rejects.toThrow(/must list every untrusted root/);
    expect(readFactoryState(h.root, ISSUE)).toBeNull();
  });

  it('a resume on another forge than the run started on is refused (forgeKind)', async () => {
    const out = await run(happy());
    expect(out.gate?.name).toBe('merge');

    const github = await run([], { forge: undefined, exec: h.exec });
    expect(github.exitCode).toBe(1);
    expect(github.message).toMatch(/started on azure-devops, but the forge now resolves to github/);
    const dry = await run([], { forge: undefined, exec: h.exec, dryRun: true });
    expect(dry.exitCode).toBe(1);
  });

  it('--dry-run reads the work item through the tracker and names the plan', async () => {
    const out = await run([], { dryRun: true });
    expect(out.exitCode).toBe(0);
    expect(out.plan).toMatchObject({ next: 'implement', planSource: 'omg-plan docs/plan.md' });
    expect(ado.calls.map((c) => c.route)).toEqual(['wit.workItems.GET', 'wit.workItemTypeStates.GET', 'wit.comments.GET']);
    expect(readFactoryState(h.root, ISSUE)).toBeNull();
  });

  it('ci-heal runs are refused on Azure DevOps', async () => {
    const heal = { sig8: '0123abcd', autoImplement: false, laneCap: () => ({ ok: false as const, reason: 'unused' }) };
    await expect(run([], { issue: undefined, heal })).rejects.toThrow(/ci-heal runs are GitHub-only/);
  });
});

describe('progress sync on Azure DevOps (factory forges design §7)', () => {
  const progressConfig = (progress: FactoryForgeInput['config']['progress']) => forgeInput({ config: { ...adoConfig(), progress } });
  const STAGES = {
    queued: { column: 'Ready' },
    building: { column: 'Active' },
    reviewing: { column: 'Code Review' },
    verifying: { column: 'Verify' },
    'ready-to-merge': { column: 'Ready to merge' },
    blocked: { column: 'Blocked', state: 'Resolved' },
    cancelled: { column: 'Removed' },
    done: { state: 'Closed' },
  };
  const patches = () => ado.calls.filter((c) => c.route === 'wit.workItems.PATCH').map((c) => c.body);
  const COLUMN = '/fields/WEF_6CB513B6E70E43499D9FC94E5BBFB784_Kanban.Column';

  it('one guarded JSON-patch per mapped stage: test /rev, then the column; the item already in the column is skipped', async () => {
    const out = await run(happy(), { forge: progressConfig({ enabled: true, stages: STAGES }) });
    expect(out.gate?.name, out.message).toBe('merge');
    // queued maps to Ready, where the item already is: read, nothing patched, recorded.
    expect(patches()).toEqual(['Active', 'Code Review', 'Verify', 'Ready to merge'].map((value) => [{ op: 'test', path: '/rev', value: 7 }, { op: 'add', path: COLUMN, value }]));
    expect(readFactoryState(h.root, ISSUE)!.trackerStage).toBe('ready-to-merge');
    expectNoMerge();
  });

  it('a rev conflict is retried once with a fresh rev, and the run goes on', async () => {
    ado.revConflicts = 1;
    const out = await run(happy(), { forge: progressConfig({ enabled: true, stages: { reviewing: { column: 'Code Review' } } }) });
    expect(out.gate?.name, out.message).toBe('merge');
    expect(patches()).toHaveLength(2);
    const reads = ado.calls.filter((c) => c.route === 'wit.workItems.GET' || c.route === 'wit.workItems.PATCH').map((c) => c.route);
    // intake's read, then read + PATCH (conflict) + re-read + PATCH (the merge park's outcome read follows).
    const first = reads.indexOf('wit.workItems.PATCH');
    expect(reads.slice(first - 1, first + 3)).toEqual(['wit.workItems.GET', 'wit.workItems.PATCH', 'wit.workItems.GET', 'wit.workItems.PATCH']);
    expect(readFactoryState(h.root, ISSUE)!.trackerStage).toBe('reviewing');
  });

  it('a conflict that persists after the one retry is a warning, never a blocked transition', async () => {
    ado.revConflicts = 10;
    const warnings: string[] = [];
    const out = await run(happy(), { warn: (m) => warnings.push(m), forge: progressConfig({ enabled: true, stages: { reviewing: { column: 'Code Review' } } }) });
    expect(out.exitCode, out.message).toBe(0);
    expect(out.gate?.name).toBe('merge');
    expect(patches()).toHaveLength(2);
    const state = readFactoryState(h.root, ISSUE)!;
    expect(state.trackerStage).toBeUndefined();
    expect(state.history.some((e) => /^tracker-sync fail: reviewing: .*TF26071/.test(e.note))).toBe(true);
    expect(warnings.some((w) => /tracker stage reviewing/.test(w))).toBe(true);
  });

  it('blocked moves the column only, never the state', async () => {
    ado.headOverride = 'e'.repeat(40);
    const out = await run(happy(), { forge: progressConfig({ enabled: true, stages: STAGES }) });
    expect(out.gate?.name, out.message).toBe('head-moved-externally');
    const last = patches().at(-1);
    expect(last).toEqual([{ op: 'test', path: '/rev', value: 7 }, { op: 'add', path: COLUMN, value: 'Blocked' }]);
    expect(JSON.stringify(patches())).not.toContain('System.State');
    expect(readFactoryState(h.root, ISSUE)!.trackerStage).toBe('blocked');
  });

  it('cancelled changes nothing on Azure DevOps', async () => {
    ado.headOverride = 'e'.repeat(40);
    await run(happy(), { forge: progressConfig({ enabled: true, stages: STAGES }) });
    const before = patches().length;
    requestFactoryCancel(h.root, ISSUE, new Date().toISOString());
    const out = await run([], { forge: progressConfig({ enabled: true, stages: STAGES }) });
    expect(out.phase).toBe('cancelled');
    // The rerun re-evaluated the gate at review (one column write), then cancelled wrote nothing.
    expect(patches().slice(before)).toEqual([[{ op: 'test', path: '/rev', value: 7 }, { op: 'add', path: COLUMN, value: 'Code Review' }]]);
    expect(readFactoryState(h.root, ISSUE)!.trackerStage).toBe('cancelled');
  });

  it('progress.enabled false writes nothing', async () => {
    const out = await run(happy(), { forge: progressConfig({ enabled: false, stages: STAGES }) });
    expect(out.gate?.name, out.message).toBe('merge');
    expect(patches()).toEqual([]);
    expect(readFactoryState(h.root, ISSUE)!.trackerStage).toBeUndefined();
  });
});
