import { describe, expect, it } from 'vitest';
import { buildHeadVerdict } from '../checks.js';
import { loadAdoFixtures } from './fixtures.js';
import { adoWorld, HEAD, MERGE_COMMIT, OLD_HEAD, variant } from './world.js';
const OTHER = 'cccccccccccccccccccccccccccccccccccccccc';
const params = (sha) => JSON.stringify({ 'system.pullRequest.sourceCommitId': sha });
// Critic amendments §A.3 and design §8.3: a build or status counts only for the exact head.
describe('buildHeadVerdict', () => {
    it('counts when a head field is H and the build ran the current merge commit', () => {
        expect(buildHeadVerdict({ triggerInfo: { 'pr.sourceSha': HEAD }, sourceVersion: MERGE_COMMIT }, HEAD, MERGE_COMMIT)).toBe('counts');
        expect(buildHeadVerdict({ parameters: params(HEAD), sourceVersion: MERGE_COMMIT }, HEAD, MERGE_COMMIT)).toBe('counts');
        expect(buildHeadVerdict({ triggerInfo: { 'pr.sourceSha': HEAD }, parameters: params(HEAD), sourceVersion: MERGE_COMMIT }, HEAD, MERGE_COMMIT)).toBe('counts');
    });
    it('is pending, never green, when neither head field is present', () => {
        expect(buildHeadVerdict({ sourceVersion: MERGE_COMMIT }, HEAD, MERGE_COMMIT)).toBe('pending');
        expect(buildHeadVerdict({ triggerInfo: {}, parameters: '{}', sourceVersion: MERGE_COMMIT }, HEAD, MERGE_COMMIT)).toBe('pending');
        expect(buildHeadVerdict({ triggerInfo: { 'pr.sourceSha': '' }, parameters: 'not json', sourceVersion: MERGE_COMMIT }, HEAD, MERGE_COMMIT)).toBe('pending');
    });
    it('ignores a build for the merge commit alone: sourceVersion is never the head', () => {
        expect(buildHeadVerdict({ sourceVersion: HEAD }, HEAD, HEAD)).toBe('pending');
    });
    it('is pending when the build ran an older merge commit, or the PR has none yet', () => {
        expect(buildHeadVerdict({ triggerInfo: { 'pr.sourceSha': HEAD }, sourceVersion: OTHER }, HEAD, MERGE_COMMIT)).toBe('pending');
        expect(buildHeadVerdict({ triggerInfo: { 'pr.sourceSha': HEAD }, sourceVersion: MERGE_COMMIT }, HEAD, undefined)).toBe('pending');
    });
    it('is foreign when a head field names another sha, even if the other field matches', () => {
        expect(buildHeadVerdict({ triggerInfo: { 'pr.sourceSha': OLD_HEAD }, sourceVersion: MERGE_COMMIT }, HEAD, MERGE_COMMIT)).toBe('foreign');
        expect(buildHeadVerdict({ triggerInfo: { 'pr.sourceSha': HEAD }, parameters: params(OLD_HEAD), sourceVersion: MERGE_COMMIT }, HEAD, MERGE_COMMIT)).toBe('foreign');
    });
});
describe('exact head through the adapter', () => {
    const evaluations = 'policy.evaluations.GET.pr-17.json';
    const checkOf = (fixtures = loadAdoFixtures(), head = HEAD) => {
        const list = adoWorld({ fixtures }).forge.checks.checks(17, head);
        return Object.fromEntries(list.map((c) => [c.name, c.state]));
    };
    it('a lagging lastMergeSourceCommit (an ancestor of the push) leaves every check pending and no run counted', () => {
        const lagging = variant(loadAdoFixtures(), 'git.pullRequests.GET.by-id.json', (s) => ({
            ...s,
            lastMergeSourceCommit: { commitId: OLD_HEAD },
            lastMergeCommit: { commitId: '4444444444444444444444444444444444444444' },
        }));
        expect(checkOf(lagging)).toEqual({ CI: 'PENDING', Lint: 'PENDING', 'Docs build': 'PENDING' });
        expect(adoWorld({ fixtures: lagging }).forge.checks.runsForHead(17, HEAD)).toEqual([]);
    });
    it('the previous head\'s green does not count for a new head', () => {
        expect(checkOf(loadAdoFixtures(), OTHER)).toEqual({ CI: 'PENDING', Lint: 'PENDING', 'Docs build': 'PENDING' });
        expect(adoWorld().forge.checks.runsForHead(17, OLD_HEAD)).toEqual([]);
    });
    it('buildIsNotCurrent and isExpired evaluations are pending whatever their status', () => {
        for (const key of ['buildIsNotCurrent', 'isExpired']) {
            const fixtures = variant(loadAdoFixtures(), evaluations, (s) => {
                s.value[0].context[key] = true;
                return s;
            });
            expect(checkOf(fixtures).CI, key).toBe('PENDING');
        }
    });
    it('an approved evaluation whose build is for the merge commit only (no head field) is pending', () => {
        const fixtures = variant(loadAdoFixtures(), evaluations, (s) => {
            s.value[0].context.buildId = 99;
            return s;
        });
        expect(checkOf(fixtures).CI).toBe('PENDING');
    });
    it('a rejected evaluation of a foreign build is pending, not failed, for the head', () => {
        const fixtures = variant(loadAdoFixtures(), evaluations, (s) => {
            s.value[0].status = 'rejected';
            s.value[0].context.buildId = 100;
            return s;
        });
        expect(checkOf(fixtures).CI).toBe('PENDING');
    });
    it('a status from another iteration is ignored: the head\'s iteration has none, so the policy is pending', () => {
        const fixtures = variant(loadAdoFixtures(), 'git.pullRequestStatuses.GET.17.json', (s) => ({ ...s, value: s.value.filter((x) => x.iterationId === 1).map((x) => ({ ...x, state: 'succeeded' })) }));
        expect(checkOf(fixtures).Lint).toBe('PENDING');
    });
    it('a failed status on the head\'s iteration fails the policy; a green status with a lagging evaluation is pending', () => {
        const failed = variant(loadAdoFixtures(), 'git.pullRequestStatuses.GET.17.json', (s) => {
            s.value[1].state = 'failed';
            return s;
        });
        expect(checkOf(failed).Lint).toBe('FAILURE');
        const lagging = variant(loadAdoFixtures(), evaluations, (s) => {
            s.value[1].status = 'rejected';
            return s;
        });
        expect(checkOf(lagging).Lint).toBe('PENDING');
    });
    it('a parameters-only head field counts', () => {
        const fixtures = variant(loadAdoFixtures(), 'build.builds.GET.pr-17.json', (s) => {
            delete s.value[0].triggerInfo['pr.sourceSha'];
            return s;
        });
        expect(adoWorld({ fixtures }).forge.checks.runsForHead(17, HEAD).map((r) => r.databaseId)).toEqual([101]);
    });
    it('maps the evaluation states (approved, notApplicable, queued, running, rejected, broken, unknown)', () => {
        const expected = { approved: 'SUCCESS', notApplicable: 'SKIPPED', queued: 'QUEUED', running: 'IN_PROGRESS', rejected: 'FAILURE', broken: 'FAILURE', surprise: 'FAILURE' };
        for (const [status, state] of Object.entries(expected)) {
            const fixtures = variant(loadAdoFixtures(), evaluations, (s) => {
                s.value[0].status = status;
                return s;
            });
            expect(checkOf(fixtures).CI, status).toBe(state);
        }
    });
    it('no build or status policy means no checks (gates then report no checks)', () => {
        const fixtures = variant(loadAdoFixtures(), evaluations, (s) => ({ ...s, value: [s.value[3]] }));
        expect(adoWorld({ fixtures }).forge.checks.checks(17, HEAD)).toEqual([]);
    });
});
//# sourceMappingURL=exact-head.test.js.map