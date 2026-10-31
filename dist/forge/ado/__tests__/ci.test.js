/**
 * ForgeCi on Azure Pipelines (ADO parity design §3.3, PR C2): heal's CI
 * history from the builds of factory.heal.pipeline, read through the heal
 * guard with the `read` policy over the fixture world. Build 101's retried
 * timeline is the variant in ./fixtures/variants.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { healGuardExec, HealSafetyError } from '../../../factory/heal/history.js';
import { checkAdoCommand } from '../guard.js';
import { adoReadGuardContext, createAzureDevOpsForge } from '../index.js';
import { adoInvokeArgs } from '../invoke.js';
import { ADO_FIXTURE_DIR, adoFixtureExec, loadAdoFixtures, parseAdoFixture } from './fixtures.js';
import { adoConfig, CHECKOUT, POSIX_ENTRY, REPO, STATE_DIR } from './world.js';
const ATTEMPTS = 'build.timeline.GET.101-attempts.json';
const attempts = parseAdoFixture(ATTEMPTS, readFileSync(join(ADO_FIXTURE_DIR, 'variants', ATTEMPTS), 'utf8'));
const TEST_JOB = '7e570002-0000-4000-8000-000000000002';
const scratch = mkdtempSync(join(tmpdir(), 'omg-ado-ci-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const healConfig = (definitionId) => ({ ...adoConfig(), ...(definitionId ? { heal: { pipeline: { definitionId } } } : {}) });
/** The ADO forge over the fixtures behind the heal guard; `calls` is what reached the fixture Exec. */
function healWorld(o = {}) {
    const inner = adoFixtureExec(o.fixtures ?? loadAdoFixtures());
    const config = healConfig('definitionId' in o ? o.definitionId : 9);
    const exec = healGuardExec(inner, () => adoReadGuardContext(config, POSIX_ENTRY));
    const forge = createAzureDevOpsForge(exec, CHECKOUT, config, { entry: POSIX_ENTRY, env: {}, untrustedRoots: [CHECKOUT], stateDir: STATE_DIR });
    return { forge, exec, calls: inner.calls };
}
/** The fixtures with build 101's timeline replaced by `timeline` (the retried one by default) plus `extra`. */
const withTimeline = (timeline = attempts, extra = []) => loadAdoFixtures().filter((f) => f.name !== 'build.timeline.GET.101.json').concat(timeline, extra);
const ci = (w) => {
    if (!w.forge.ci)
        throw new Error('no ForgeCi');
    return w.forge.ci;
};
describe('ADO capabilities.heal follows factory.heal.pipeline', () => {
    it('no pipeline: no heal and no ForgeCi', () => {
        const { forge } = healWorld({ definitionId: undefined });
        expect(forge.capabilities.heal).toBe(false);
        expect(forge.ci).toBeUndefined();
    });
    it('a pipeline: heal and a ForgeCi', () => {
        const { forge } = healWorld();
        expect(forge.capabilities.heal).toBe(true);
        expect(forge.ci).toBeDefined();
    });
});
describe('adoCi.listRuns', () => {
    it('push: the CI builds of the pipeline on the base branch, newest first, partiallySucceeded a failure', () => {
        const w = healWorld();
        const runs = ci(w).listRuns({ workflow: 'ci.yml', event: 'push', branch: 'main', limit: 30 });
        expect(runs).toEqual([
            { id: '205', headSha: 'd'.repeat(40), headBranch: 'main', event: 'push', createdAt: '2026-10-29T10:00:00.000Z', status: 'completed', conclusion: 'failure' },
            { id: '204', headSha: 'c'.repeat(40), headBranch: 'main', event: 'push', createdAt: '2026-10-29T09:00:00.000Z', status: 'completed', conclusion: 'success' },
            { id: '201', headSha: '9'.repeat(40), headBranch: 'main', event: 'push', createdAt: '2026-10-29T06:00:00.000Z', status: 'completed', conclusion: 'cancelled' },
        ]);
        // 203 (reason manual) is not CI: the reason filter is client-side; 202 has no 40-hex sourceVersion.
        expect(runs.map((r) => r.id)).not.toContain('203');
        expect(runs.map((r) => r.id)).not.toContain('202');
    });
    it('push: one GET of the pipeline\'s completed builds; `workflow` is GitHub\'s and not sent', () => {
        const w = healWorld();
        ci(w).listRuns({ workflow: 'ci.yml', event: 'push', branch: 'main', limit: 30 });
        expect(w.calls).toHaveLength(1);
        const args = w.calls[0].args;
        expect(args.slice(args.indexOf('--query-parameters') + 1, args.indexOf('--http-method'))).toEqual([
            'definitions=9', 'branchName=refs/heads/main', 'statusFilter=completed', 'queryOrder=finishTimeDescending', '$top=30',
        ]);
        expect(args[args.indexOf('--http-method') + 1]).toBe('GET');
        expect(args.join(' ')).not.toContain('ci.yml');
    });
    it('pull_request: the recorded PR head, never guessed; the source branch or pr-<number>', () => {
        const runs = ci(healWorld()).listRuns({ workflow: 'ci.yml', event: 'pull_request', limit: 30 });
        expect(runs).toEqual([
            { id: '310', headSha: '1'.repeat(40), headBranch: 'factory/issue-42', event: 'pull_request', createdAt: '2026-10-29T12:00:00.000Z', status: 'completed', conclusion: 'failure' },
            { id: '309', headSha: '2'.repeat(40), headBranch: 'pr-18', event: 'pull_request', createdAt: '2026-10-29T11:00:00.000Z', status: 'completed', conclusion: 'success' },
        ]);
        // 308 has no head field, 307 two that disagree, 306 is not a PR build, 305 names neither a branch nor a PR.
    });
    it('a failed read throws (as gh run list does)', () => {
        const fixtures = loadAdoFixtures().map((f) => (f.name === 'build.builds.GET.heal-push.json' ? { ...f, exitCode: 1, stdout: '', stderr: 'ERROR: TF400898: An internal error occurred' } : f));
        expect(() => ci(healWorld({ fixtures })).listRuns({ workflow: 'ci.yml', event: 'push', branch: 'main', limit: 30 })).toThrow(/TF400898/);
    });
});
describe('adoCi.runJobs', () => {
    it('the newest attempt per job, with its failed tasks as failed steps', () => {
        expect(ci(healWorld({ fixtures: withTimeline() })).runJobs('101')).toEqual([
            { jobId: '101:e2e00002-0000-4000-8000-000000000002', name: 'E2E', conclusion: 'success', failedSteps: [] },
            { jobId: `101:${TEST_JOB}`, name: 'Test', conclusion: 'failure', failedSteps: ['Run tests'] },
            { jobId: '101:11a70001-0000-4000-8000-000000000001', name: 'Lint', conclusion: 'success', failedSteps: [] },
        ]);
    });
    it('maps the task results and fails an unknown one closed', () => {
        const records = ['succeeded', 'succeededWithIssues', 'failed', 'canceled', 'abandoned', 'skipped', 'surprising'].map((result, i) => ({
            id: `0000000${i}-0000-4000-8000-000000000000`, type: 'Job', name: `J${i}`, identifier: `J${i}`, result,
        }));
        const timeline = { ...attempts, stdout: { records: [...records, { id: '00000009-0000-4000-8000-000000000000', type: 'Job', name: 'Running', identifier: 'R' }] } };
        expect(ci(healWorld({ fixtures: withTimeline(timeline) })).runJobs('101').map((j) => j.conclusion)).toEqual(['success', 'success', 'failure', 'cancelled', 'cancelled', 'skipped', 'failure', '']);
    });
    it('refuses a run id that is not a build id before any call', () => {
        const w = healWorld();
        expect(() => ci(w).runJobs('101; rm -rf /')).toThrow(/not a number/);
        expect(w.calls).toEqual([]);
    });
});
describe('adoCi.jobLog', () => {
    const log9 = parseAdoFixture('build.logs.GET.101-9.json', JSON.stringify({
        provenance: 'synthetic: a second failed task log of build 101',
        route: 'build.logs.GET',
        routeParameters: { project: 'Web', buildId: '101', logId: '9' },
        stdout: { count: 1, value: ['2026-10-28T11:13:00.0000000Z ##[error]Upload failed.'] },
    }));
    /** The retried timeline with the Test job's own log removed and a second failed task (log 7, order 1) before "Run tests" (log 9, order 4). */
    const noJobLog = {
        ...attempts,
        stdout: {
            records: attempts.stdout.records
                .map((r) => (r.id === TEST_JOB ? { ...r, log: undefined } : r))
                .concat({ id: '5e7e0002-0000-4000-8000-000000000002', parentId: TEST_JOB, type: 'Task', name: 'Setup', attempt: 2, order: 1, result: 'failed', log: { id: 7 } }),
        },
    };
    it('reads the job record\'s log', () => {
        const log = ci(healWorld({ fixtures: withTimeline() })).jobLog(`101:${TEST_JOB}`);
        expect(log).toContain('FAIL src/report.test.ts > exports CSV');
    });
    it('without a job log: the failed task logs, concatenated in order', () => {
        const w = healWorld({ fixtures: withTimeline(noJobLog, [log9]) });
        const log = ci(w).jobLog(`101:${TEST_JOB}`);
        expect(log.split('\n')).toEqual([
            '2026-10-28T11:10:00.0000000Z ##[section]Starting: Run tests',
            '2026-10-28T11:12:00.0000000Z FAIL src/report.test.ts > exports CSV',
            '2026-10-28T11:12:01.0000000Z ##[error]Process completed with exit code 1.',
            '2026-10-28T11:13:00.0000000Z ##[error]Upload failed.',
        ]);
    });
    it('throws on no log, an unknown record or a malformed id', () => {
        const bare = { ...attempts, stdout: { records: [{ id: TEST_JOB, type: 'Job', name: 'Test', result: 'failed' }] } };
        expect(() => ci(healWorld({ fixtures: withTimeline(bare) })).jobLog(`101:${TEST_JOB}`)).toThrow(/has no log/);
        expect(() => ci(healWorld({ fixtures: withTimeline() })).jobLog('101:00000000-0000-4000-8000-00000000dead')).toThrow(/no timeline record/);
        expect(() => ci(healWorld()).jobLog('101')).toThrow(/not <buildId>:<timeline record id>/);
    });
});
describe('adoCi.rerunIntent', () => {
    it('is the human step on the build page, never an az call', () => {
        const w = healWorld();
        expect(ci(w).rerunIntent('205')).toBe('Rerun failed jobs on https://dev.azure.com/contoso/Web/_build/results?buildId=205');
        expect(w.calls).toEqual([]);
    });
});
describe('the `read` guard policy (ADO parity design §3.5)', () => {
    const ctx = adoReadGuardContext(healConfig(9), POSIX_ENTRY);
    const body = (value) => {
        const path = join(scratch, `b${Math.random().toString(36).slice(2)}.json`);
        writeFileSync(path, JSON.stringify(value), 'utf8');
        return path;
    };
    const writes = [
        ['git.pullRequests.PATCH', { project: 'Web', repositoryId: 'web-app', pullRequestId: '17' }, { isDraft: false }],
        ['git.pullRequests.POST', { project: 'Web', repositoryId: 'web-app' }, { sourceRefName: 'refs/heads/a', targetRefName: 'refs/heads/main', title: 't', isDraft: true }],
        ['git.pullRequestThreads.POST', { project: 'Web', repositoryId: 'web-app', pullRequestId: '17' }, { comments: [{ content: 'hi' }] }],
        ['wit.workItems.PATCH', { project: 'Web', id: '42' }, [{ op: 'test', path: '/rev', value: 3 }]],
        ['wit.comments.POST', { project: 'Web', workItemId: '42' }, { text: 'hi' }],
        ['wit.wiql.POST', { project: 'Web' }, { query: 'SELECT [System.Id] FROM WorkItems' }],
    ];
    it('refuses every POST and PATCH, with a valid body, before anything runs', () => {
        const w = healWorld();
        for (const [route, rp, value] of writes) {
            const args = adoInvokeArgs({ entry: POSIX_ENTRY, repo: REPO }, route, rp, {}, body(value));
            expect(() => w.exec('az', args), route).toThrow(HealSafetyError);
            expect(() => w.exec('az', args), route).toThrow(/is not a read/);
        }
        // The bodyless requeue too.
        const requeue = adoInvokeArgs({ entry: POSIX_ENTRY, repo: REPO }, 'policy.evaluations.PATCH', { project: 'Web', evaluationId: '00000000-0000-4000-8000-000000000001' });
        expect(() => w.exec('az', requeue)).toThrow(/is not a read/);
        expect(w.calls).toEqual([]);
    });
    it('the same writes pass the factory policy (the refusal is the policy, not the shape)', () => {
        const fail = (why) => new Error(why);
        for (const [route, rp, value] of writes.filter(([id]) => !id.startsWith('wit.workItems'))) {
            const args = adoInvokeArgs({ entry: POSIX_ENTRY, repo: REPO }, route, rp, {}, body(value));
            expect(() => checkAdoCommand('az', args, undefined, ctx, 'factory', fail), route).not.toThrow();
            expect(() => checkAdoCommand('az', args, undefined, ctx, 'read', fail), route).toThrow(/is not a read/);
        }
    });
    it('allows the heal reads and the pipeline pick; refuses another project or a branch with `..`', () => {
        const fail = (why) => new Error(why);
        const read = (route, rp, qp = {}) => () => checkAdoCommand('az', adoInvokeArgs({ entry: POSIX_ENTRY, repo: REPO }, route, rp, qp), undefined, ctx, 'read', fail);
        expect(read('build.builds.GET', { project: 'Web' }, { definitions: '9', branchName: 'refs/heads/main', statusFilter: 'completed', queryOrder: 'finishTimeDescending', $top: '30' })).not.toThrow();
        expect(read('build.builds.GET', { project: 'Web' }, { definitions: '9', resultFilter: 'failed', minTime: '2026-10-01T00:00:00Z' })).not.toThrow();
        expect(read('build.timeline.GET', { project: 'Web', buildId: '101' })).not.toThrow();
        expect(read('build.logs.GET', { project: 'Web', buildId: '101', logId: '7' })).not.toThrow();
        expect(read('build.definitions.GET', { project: 'Web' }, { repositoryId: '3411ebc1-d5aa-464f-9615-0b527bc66719', repositoryType: 'TfsGit' })).not.toThrow();
        expect(read('build.definitions.GET', { project: 'Web', definitionId: '9' })).not.toThrow();
        expect(read('build.builds.GET', { project: 'Other' }, { definitions: '9' })).toThrow(/forge project/);
        expect(read('build.builds.GET', { project: 'Web' }, { branchName: 'refs/heads/a/../b' })).toThrow(/branchName has a refused value/);
        // A base branch is a heal read only: the factory and ship policies keep refs/pull/<n>/merge.
        const heads = adoInvokeArgs({ entry: POSIX_ENTRY, repo: REPO }, 'build.builds.GET', { project: 'Web' }, { branchName: 'refs/heads/main' });
        expect(() => checkAdoCommand('az', heads, undefined, ctx, 'factory', fail)).toThrow(/branchName has a refused value/);
        expect(() => checkAdoCommand('az', heads, undefined, ctx, 'ship', fail)).toThrow(/branchName has a refused value/);
        expect(read('build.builds.GET', { project: 'Web' }, { definitions: '9,10' })).toThrow(/definitions has a refused value/);
        expect(read('build.builds.GET', { project: 'Web' }, { statusFilter: 'all' })).toThrow(/statusFilter has a refused value/);
        expect(read('build.definitions.GET', { project: 'Web' }, { repositoryId: 'web-app' })).toThrow(/repositoryId has a refused value/);
    });
    it('without an ADO guard context every az call is refused', () => {
        const inner = adoFixtureExec(loadAdoFixtures());
        const exec = healGuardExec(inner);
        const args = adoInvokeArgs({ entry: POSIX_ENTRY, repo: REPO }, 'build.timeline.GET', { project: 'Web', buildId: '101' });
        expect(() => exec('az', args)).toThrow(/no Azure DevOps forge is configured/);
        expect(inner.calls).toEqual([]);
    });
});
//# sourceMappingURL=ci.test.js.map