import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { createAzureDevOpsForge } from '../index.js';
import { ADO_RECORD_ENV, adoFixtureShapeReport, jsonKeyPaths, recordingAdoExec } from '../record.js';
import { adoArgvKey, adoFixtureExec, adoFixtureKey, loadAdoFixtures, parseAdoFixture } from './fixtures.js';
import { adoConfig, HEAD, POSIX_ENTRY } from './world.js';
const scratch = mkdtempSync(join(tmpdir(), 'omg-ado-record-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
describe('fixture recording (OMG_ADO_RECORD_DIR)', () => {
    it('records every invoke call as a fixture the loader reads back under the same key', () => {
        const dir = join(scratch, 'rec1');
        const forge = createAzureDevOpsForge(adoFixtureExec(loadAdoFixtures()), scratch, adoConfig(), { entry: POSIX_ENTRY, env: { [ADO_RECORD_ENV]: dir } });
        forge.reviews.viewPr(17);
        forge.checks.checks(17, HEAD);
        forge.reviews.markReady(17);
        const recorded = readdirSync(dir).sort().map((n) => parseAdoFixture(n, readFileSync(join(dir, n), 'utf8')));
        expect(recorded.map((f) => f.route.id)).toEqual([
            'build.builds.GET', 'git.pullRequestIterations.GET', 'git.pullRequestStatuses.GET', 'git.pullRequests.GET', 'git.pullRequests.PATCH', 'policy.evaluations.GET',
        ]);
        for (const f of recorded)
            expect(f.provenance).toMatch(/^recorded \d{4}-\d\d-\d\dT/);
        // Same keys as the docs samples, so a recording can replace a sample file as is.
        const sampleKeys = new Set(loadAdoFixtures().map(adoFixtureKey));
        for (const f of recorded)
            expect(sampleKeys.has(adoFixtureKey(f)), f.name).toBe(true);
        const patch = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((n) => n.startsWith('git.pullRequests.PATCH'))), 'utf8'));
        expect(patch.requestBody).toEqual({ isDraft: false });
        expect(patch.argv).toContain('<in-file>');
        expect(() => adoArgvKey(patch.argv)).not.toThrow();
    });
    it('redacts PATs and Authorization headers in what it writes', () => {
        const dir = join(scratch, 'rec2');
        const pat = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';
        const exec = recordingAdoExec(() => ({ status: 1, stdout: `{"token":"${pat}"}`, stderr: `Authorization: Basic ${pat}` }), dir);
        exec('az', ['devops', 'invoke', '--area', 'git', '--resource', 'pullRequests', '--route-parameters', 'project=Web', 'repositoryId=web-app', 'pullRequestId=17', '--http-method', 'GET', '--api-version', '7.1', '--org', 'https://dev.azure.com/contoso', '--detect', 'false', '--output', 'json']);
        const [name] = readdirSync(dir);
        const text = readFileSync(join(dir, name), 'utf8');
        expect(text).not.toContain(pat);
        expect(JSON.parse(text)).toMatchObject({ exitCode: 1, stdout: { token: '***' }, stderr: 'Authorization: ***' });
    });
    it('passes non-invoke calls through without recording', () => {
        const dir = join(scratch, 'rec3');
        const exec = recordingAdoExec(() => ({ status: 0, stdout: 'ok', stderr: '' }), dir);
        expect(exec('git', ['status']).stdout).toBe('ok');
        expect(() => readdirSync(dir)).toThrow();
    });
});
describe('adoFixtureShapeReport', () => {
    it('lists key paths the docs samples have and the live answers lack, and unsampled routes', () => {
        expect([...jsonKeyPaths({ a: { b: 1 }, list: [{ c: 1 }, { d: 2 }] })].sort()).toEqual(['a', 'a.b', 'list', 'list[].c', 'list[].d']);
        const samples = [{ name: 's', route: 'git.pullRequests.GET', stdout: { pullRequestId: 1, lastMergeCommit: { commitId: 'x' } } }];
        const live = [
            { name: 'l1', route: 'git.pullRequests.GET', stdout: { pullRequestId: 1 } },
            { name: 'l2', route: 'build.timeline.GET', stdout: {} },
        ];
        expect(adoFixtureShapeReport(samples, live)).toEqual(['build.timeline.GET: recorded, but no docs sample', 'git.pullRequests.GET: missing in the live answer: lastMergeCommit, lastMergeCommit.commitId']);
        expect(adoFixtureShapeReport(samples, [{ name: 'l', route: 'git.pullRequests.GET', stdout: samples[0].stdout }])).toEqual([]);
    });
});
//# sourceMappingURL=record.test.js.map