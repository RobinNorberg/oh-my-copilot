/**
 * The shared harness of the engine.ado*.test.ts files: the factory engine on Azure
 * DevOps against a fake ADO model behind `az`, with real git.
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect } from 'vitest';
import { loadAdoFixtures } from '../../../forge/ado/__tests__/fixtures.js';
import { adoConfig, POSIX_ENTRY, REPO } from '../../../forge/ado/__tests__/world.js';
import { BUILD_POLICY_TYPE } from '../../../forge/ado/checks.js';
import { parseAdoInvoke } from '../../../forge/ado/guard.js';
import { defaultExec } from '../../../ship/exec.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../budget.js';
import { runFactoryEngine } from '../engine.js';
import { factoryForgeOptions } from '../forge-roots.js';
import { commitFile, FakeLanes, FakeProcesses, harness, ISSUE, remoteHead, review, testGateConfig } from './fake-lanes.js';
export const ADO_URL = REPO.url;
export const PR_ID = 17;
export const PROJECT_ID = '6ce954b1-ce1f-45d1-b94d-e6bf2464ba2c';
export const MERGE_COMMIT = '3'.repeat(40);
export const fixtures = loadAdoFixtures();
export const fixture = (name) => structuredClone(fixtures.find((f) => f.name === name).stdout);
/** The Azure DevOps side of one run: work item ISSUE, PR 17 on the harness's bare remote. */
export class AdoModel {
    h;
    calls = [];
    prCreated = false;
    ready = false;
    /** Reported instead of the branch head (a push the engine did not make). */
    headOverride;
    /** The next `reads` PR reads report `sha` (lastMergeSourceCommit lagging a push). */
    lag;
    /** Work item PATCHes answered with a rev conflict before one succeeds. */
    revConflicts = 0;
    /** The recorded item's predecessor #40 (Dependency-Reverse): dropped (none), open, or open with its factory PR completed into dev. */
    predecessor = 'none';
    /** The run's branch (a ci-heal run pushes factory/heal-<sig8>). */
    branch = `factory/issue-${ISSUE}`;
    constructor(h) {
        this.h = h;
    }
    dev() {
        return defaultExec('git', ['ls-remote', this.h.bare, 'refs/heads/dev']).stdout.split(/\s+/)[0];
    }
    head() {
        if (this.headOverride)
            return this.headOverride;
        if (this.lag && this.lag.reads > 0) {
            this.lag.reads -= 1;
            return this.lag.sha;
        }
        return remoteHead(this.h) ?? '';
    }
    pr() {
        const v = fixture('git.pullRequests.GET.by-id.json');
        return {
            ...v,
            title: `Add greet() (#${ISSUE})`,
            sourceRefName: `refs/heads/${this.branch}`,
            targetRefName: 'refs/heads/dev',
            isDraft: !this.ready,
            lastMergeSourceCommit: { commitId: this.head() },
            lastMergeTargetCommit: { commitId: this.dev() },
            lastMergeCommit: { commitId: MERGE_COMMIT },
        };
    }
    answer(args) {
        const inv = parseAdoInvoke(args);
        if (typeof inv === 'string')
            throw new Error(inv);
        const at = args.indexOf('--in-file');
        const body = at >= 0 ? JSON.parse(readFileSync(args[at + 1], 'utf8')) : undefined;
        const { routeParameters: rp, queryParameters: qp } = inv;
        this.calls.push({ route: inv.route.id, routeParameters: rp, queryParameters: qp, ...(body !== undefined ? { body } : {}) });
        const ok = (v) => ({ status: 0, stdout: JSON.stringify(v), stderr: '' });
        switch (inv.route.id) {
            case 'wit.workItems.GET': {
                if (rp.id === '40' && this.predecessor !== 'none')
                    return ok({ ...fixture('wit.workItems.GET.42.json'), id: 40, relations: [] });
                if (rp.id !== String(ISSUE))
                    break;
                const item = fixture('wit.workItems.GET.42.json');
                item.id = ISSUE;
                item.fields['System.Title'] = 'Add greet()';
                item.fields['System.Description'] = '<div>A greeting helper.</div>';
                item.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] = '<ul><li>greet() returns hi</li></ul>';
                item._links.html.href = `https://dev.azure.com/contoso/Web/_workitems/edit/${ISSUE}`;
                if (this.predecessor === 'none')
                    item.relations = item.relations.filter((r) => r.rel !== 'System.LinkTypes.Dependency-Reverse');
                return ok(item);
            }
            case 'wit.workItems.PATCH':
                if (rp.id !== String(ISSUE))
                    break;
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
                if (qp['searchCriteria.status'] === 'completed') {
                    const done = this.predecessor === 'merged' && qp['searchCriteria.sourceRefName'] === 'refs/heads/factory/issue-40' && qp['searchCriteria.targetRefName'] === 'refs/heads/dev';
                    return ok({ value: done ? [{ pullRequestId: 90, status: 'completed' }] : [], count: done ? 1 : 0 });
                }
                if (qp['searchCriteria.sourceRefName'])
                    return ok({ value: this.prCreated ? [{ pullRequestId: PR_ID, status: 'active' }] : [], count: this.prCreated ? 1 : 0 });
                if (rp.pullRequestId === String(PR_ID) && this.prCreated)
                    return ok(this.pr());
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
                if (qp.artifactId !== `vstfs:///CodeReview/CodeReviewId/${PROJECT_ID}/${PR_ID}`)
                    break;
                return ok({
                    value: [{
                            evaluationId: 'e1a2b3c4-0000-4000-8000-000000000001',
                            status: 'approved',
                            configuration: { id: 4, isBlocking: true, settings: { displayName: 'Test' }, type: { id: BUILD_POLICY_TYPE, displayName: 'Build' } },
                            context: { buildId: 101, isExpired: false, buildIsNotCurrent: false },
                        }],
                });
            case 'build.builds.GET':
                if (qp.branchName !== `refs/pull/${PR_ID}/merge`)
                    break;
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
    threads() {
        return this.calls.filter((c) => c.route === 'git.pullRequestThreads.POST').map((c) => c.body.comments[0].content);
    }
}
export let h;
export let ado;
export let sleeps;
/** A fresh harness per test; call once at the top of each test file that uses it. */
export function useAdoHarness() {
    beforeEach(() => {
        h = harness('omg-factory-ado-');
        ado = new AdoModel(h);
        sleeps = [];
    });
    afterEach(() => {
        rmSync(h.dir, { recursive: true, force: true });
    });
}
/** The harness's git (origin is the ADO repository), az to the model, and no gh at all. */
export function adoExec() {
    return (cmd, args, opts) => {
        if (cmd === 'az')
            return ado.answer(args);
        if (cmd === 'gh')
            throw new Error(`gh ran on an Azure DevOps run: gh ${args.join(' ')}`);
        let plain = args;
        while (cmd === 'git' && plain[0] === '-c')
            plain = plain.slice(2);
        if (cmd === 'git' && plain[0] === 'remote' && plain[1] === 'get-url')
            return { status: 0, stdout: `${ADO_URL}\n`, stderr: '' };
        return h.exec(cmd, args, opts);
    };
}
export const forgeInput = (over = {}) => ({
    config: adoConfig(),
    options: { ...factoryForgeOptions(h.root), stateDir: join(h.dir, 'forge-state') },
    entry: POSIX_ENTRY,
    ...over,
});
export function opts(lanes, over = {}) {
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
export const happy = () => [commitFile('src/greet.ts', 'export const greet = () => "hi";\n'), review('approve')];
export const run = (scripts, over = {}) => runFactoryEngine(opts(new FakeLanes(h.root, scripts), over));
/** Nothing merges: every PR PATCH is exactly the ready flip, and no az call completes a PR. */
export function expectNoMerge() {
    for (const c of ado.calls) {
        if (c.route === 'git.pullRequests.PATCH')
            expect(c.body).toEqual({ isDraft: false });
        expect(JSON.stringify(c.body ?? {})).not.toMatch(/"status":"completed"|completionOptions|autoCompleteSetBy/);
    }
    expect(h.calls.some((c) => c.startsWith('gh '))).toBe(false);
}
//# sourceMappingURL=engine-ado-harness.js.map