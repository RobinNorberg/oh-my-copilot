import { describe, expect, it } from 'vitest';
import { adoFixtureExec, adoArgvKey, loadAdoFixtures, parseAdoFixture } from './fixtures.js';
const prArgv = ['devops', 'invoke', '--area', 'git', '--resource', 'pullRequests', '--route-parameters', 'repositoryId=web-app', 'project=Web', 'pullRequestId=17', '--api-version', '7.1', '--org', 'https://dev.azure.com/contoso', '--detect', 'false'];
describe('ADO fixture loader', () => {
    it('loads every fixture file and validates it against the route table', () => {
        const fixtures = loadAdoFixtures();
        expect(fixtures.length).toBeGreaterThan(0);
        for (const f of fixtures)
            expect(f.provenance).toMatch(/^(?:docs-sample https:\/\/learn\.microsoft\.com\/|recorded |synthetic: )/);
    });
    it('answers the argv the adapter builds, in any parameter order, with or without the Windows prefix', () => {
        const exec = adoFixtureExec(loadAdoFixtures());
        const res = exec('az', prArgv);
        expect(res.status).toBe(0);
        expect(JSON.parse(res.stdout)).toMatchObject({ pullRequestId: 17, isDraft: true });
        expect(exec('C:\\CLI2\\python.exe', ['-IBm', 'azure.cli', ...prArgv]).status).toBe(0);
        expect(exec.calls).toHaveLength(2);
    });
    it('returns a failed call as recorded', () => {
        const exec = adoFixtureExec(loadAdoFixtures());
        const res = exec('az', ['devops', 'invoke', '--area', 'wit', '--resource', 'workItems', '--route-parameters', 'project=Web', 'id=404', '--query-parameters', '$expand=relations']);
        expect(res).toEqual({ status: 1, stdout: '', stderr: expect.stringContaining('TF401232') });
    });
    it('throws on a call no fixture describes', () => {
        const exec = adoFixtureExec(loadAdoFixtures());
        expect(() => exec('az', prArgv.map((a) => (a === 'pullRequestId=17' ? 'pullRequestId=18' : a)))).toThrow(/no fixture/);
        expect(() => exec('az', ['devops', 'invoke', '--area', 'git', '--resource', 'pushes', '--http-method', 'POST'])).toThrow(/no route/);
        expect(() => exec('az', ['repos', 'pr', 'list'])).toThrow(/not an az devops invoke call/);
    });
    it('refuses a fixture with no provenance, an unknown route or a parameter the route does not allow', () => {
        const base = { provenance: 'synthetic: test', route: 'git.pullRequests.GET', stdout: {} };
        expect(() => parseAdoFixture('a', JSON.stringify({ ...base, provenance: 'trust me' }))).toThrow(/provenance/);
        expect(() => parseAdoFixture('b', JSON.stringify({ ...base, route: 'git.pushes.POST' }))).toThrow(/no Azure DevOps route/);
        expect(() => parseAdoFixture('c', JSON.stringify({ ...base, queryParameters: { 'searchCriteria.creatorId': 'x' } }))).toThrow(/not allowed/);
    });
    it('refuses two fixtures for the same call', () => {
        const raw = JSON.stringify({ provenance: 'synthetic: dup', route: 'git.pullRequests.GET', routeParameters: { pullRequestId: '1' }, stdout: {} });
        expect(() => adoFixtureExec([parseAdoFixture('x', raw), parseAdoFixture('y', raw)])).toThrow(/same call/);
    });
    it('keys the argv by route and sorted parameters', () => {
        expect(adoArgvKey(prArgv)).toBe('git.pullRequests.GET?route:project=Web&pullRequestId=17&repositoryId=web-app|query:');
    });
});
//# sourceMappingURL=fixtures.test.js.map