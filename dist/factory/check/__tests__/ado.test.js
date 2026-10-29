/**
 * The Azure DevOps path of `omg factory check`, on recorded-format fixtures
 * (src/forge/ado/__tests__/fixtures.ts). The rule coverage uses ./fixtures/ado
 * with a minimal tracker over the same `az devops invoke` calls (more work
 * item shapes than the adapter's fixture world has); the last block runs the
 * real adapter (createAzureDevOpsForge) on the adapter's own fixtures behind
 * checkGuardExec with an ADO guard context.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adoFixtureExec, loadAdoFixtures } from '../../../forge/ado/__tests__/fixtures.js';
import { adoConfig, CHECKOUT, POSIX_ENTRY, STATE_DIR, variant } from '../../../forge/ado/__tests__/world.js';
import { adoHtmlToText } from '../../../forge/ado/html.js';
import { adoGuardContext, createAzureDevOpsForge } from '../../../forge/ado/index.js';
import { DEFAULT_ADO_ITEM_TYPES, DEFAULT_CHECK_CONFIG } from '../../../forge/config.js';
import { checkGuardExec } from '../cli.js';
import { checkItems } from '../score.js';
const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ado');
const ORG = ['--org', 'https://dev.azure.com/contoso', '--detect', 'false'];
const CLOSED = new Set(['closed', 'removed', 'done']);
const linked = (relations, rel) => (Array.isArray(relations) ? relations : [])
    .filter((r) => r?.rel === rel)
    .map((r) => Number(/\/workItems\/(\d+)$/.exec(String(r.url))?.[1]))
    .filter((n) => n > 0);
function invoke(exec, area, resource, route, query) {
    const res = exec('az', ['devops', 'invoke', '--area', area, '--resource', resource, '--route-parameters', ...route, '--query-parameters', ...query, ...ORG]);
    if (res.status !== 0)
        throw new Error(res.stderr);
    return JSON.parse(res.stdout);
}
function adoForge(exec) {
    const viewItem = (id) => {
        const w = invoke(exec, 'wit', 'workItems', ['project=Web', `id=${id}`], ['$expand=relations']);
        const f = w.fields;
        const state = String(f['System.State']);
        return {
            id: w.id,
            url: `https://dev.azure.com/contoso/Web/_workitems/edit/${w.id}`,
            title: String(f['System.Title']),
            body: adoHtmlToText(f['System.Description']),
            acceptance: adoHtmlToText(f['Microsoft.VSTS.Common.AcceptanceCriteria']) || undefined,
            open: !CLOSED.has(state.toLowerCase()),
            rawState: state,
            authorTrusted: false,
            comments: [],
            labels: typeof f['System.Tags'] === 'string' ? f['System.Tags'].split(';').map((t) => t.trim()) : [],
            type: String(f['System.WorkItemType']),
            ...(typeof f['Microsoft.VSTS.Common.Priority'] === 'number' ? { priority: f['Microsoft.VSTS.Common.Priority'] } : {}),
            dependsOn: linked(w.relations, 'System.LinkTypes.Dependency-Reverse'),
            children: linked(w.relations, 'System.LinkTypes.Hierarchy-Forward'),
            repoUrl: 'https://dev.azure.com/contoso/Web/_git/web-app',
        };
    };
    const findOpenPrForBranch = (branch) => {
        const r = invoke(exec, 'git', 'pullRequests', ['project=Web', 'repositoryId=web-app'], [`searchCriteria.sourceRefName=refs/heads/${branch}`, 'searchCriteria.status=active']);
        return r.value[0]?.pullRequestId;
    };
    return {
        kind: 'azure-devops',
        tracker: { viewItem, queryItems: () => [], comment: () => ({ ok: false, stderr: '' }), setProgress: () => ({ ok: false, detail: '' }), addMarker: () => ({ ok: false, stderr: '' }) },
        reviews: { findOpenPrForBranch },
    };
}
const env = {
    config: { intake: { itemTypes: [...DEFAULT_ADO_ITEM_TYPES], limit: 50, marker: 'factory-ready' }, check: { ...DEFAULT_CHECK_CONFIG } },
    runState: () => null,
    remoteBranch: () => false,
    readPlan: () => null,
    planBase: 'origin/main (not available)',
};
describe('omg factory check on Azure DevOps fixtures', () => {
    it('buckets work items by the §5 rules and orders by Priority', () => {
        const exec = adoFixtureExec(loadAdoFixtures(DIR));
        const results = checkItems(adoForge(exec), [49, 48, 47, 44, 43, 42, 50], env);
        expect(results.map((r) => [r.id, r.bucket, r.reasons, r.priority, r.planSource])).toEqual([
            [42, 'runnable', [], 2, 'ado-acceptance'],
            [49, 'needs-plan', ['no-plan'], 3, null],
            [48, 'needs-plan', ['ac-vague'], null, null],
            [44, 'blocked', ['depends-on:#45'], 1, null],
            [43, 'blocked', ['wrong-type'], null, null],
            [47, 'blocked', ['closed'], null, null],
            [50, 'blocked', ['pr-exists'], null, null],
        ]);
        expect(results[0]).toMatchObject({ title: 'Add <b>export</b>', detail: 'plan: 2 acceptance items (ado-acceptance)' });
        expect(results.find((r) => r.id === 50).detail).toBe('open PR #17 already uses factory/issue-50');
        // Every call is a GET.
        expect(exec.calls.every((c) => c.cmd === 'az' && !c.args.includes('--http-method'))).toBe(true);
    });
    it('checkGuardExec refuses an az write without a confirmed mark before it reaches the exec', () => {
        const inner = adoFixtureExec(loadAdoFixtures(DIR));
        const seen = [];
        // Refused by check's own read-only rule, before the factory guard; count what reaches the exec.
        const guarded = checkGuardExec(((cmd, args) => { seen.push(args); return inner(cmd, args); }));
        expect(() => guarded('az', ['devops', 'invoke', '--area', 'wit', '--resource', 'workItems', '--http-method', 'PATCH'])).toThrow(/only reads run without a confirmed --mark/);
        expect(seen).toEqual([]);
    });
});
describe('omg factory check through the real Azure DevOps adapter', () => {
    function world(fixtures = loadAdoFixtures()) {
        const inner = adoFixtureExec(fixtures);
        const config = adoConfig();
        const guard = adoGuardContext(config, POSIX_ENTRY);
        const mark = {};
        const exec = checkGuardExec(inner, () => mark.marker, () => guard);
        const forge = createAzureDevOpsForge(exec, CHECKOUT, config, { entry: POSIX_ENTRY, env: {}, untrustedRoots: [CHECKOUT], stateDir: STATE_DIR });
        return { forge, mark, calls: inner.calls, env: { ...env, config } };
    }
    const methodOf = (args) => (args.includes('--http-method') ? args[args.indexOf('--http-method') + 1] : 'GET');
    it('work item 42 with an active PR on factory/issue-42 is pr-exists, read with GETs only', () => {
        const w = world();
        expect(checkItems(w.forge, [42], w.env)).toEqual([
            { id: 42, title: 'Add CSV export to the report page', url: expect.stringContaining('42'), bucket: 'blocked', reasons: ['pr-exists'], detail: 'open PR #17 already uses factory/issue-42', priority: expect.anything(), planSource: null },
        ]);
        expect(w.calls.length).toBeGreaterThan(0);
        expect(w.calls.every((c) => methodOf(c.args) === 'GET')).toBe(true);
    });
    it('without the PR and links, 42 runs from the trusted author\'s omg-plan; addMarker passes the guard only while marking', () => {
        const noPr = variant(loadAdoFixtures(), 'git.pullRequests.GET.by-branch.json', (s) => ({ ...s, value: [], count: 0 }));
        // Its predecessor #40 and child #43 have no fixture: unreadable counts as open.
        expect(checkItems(world(noPr).forge, [42], env)[0]).toMatchObject({ bucket: 'blocked', reasons: ['depends-on:#40'] });
        const w = world(variant(noPr, 'wit.workItems.GET.42.json', (s) => ({ ...s, relations: [] })));
        // Only the trustedAuthors comment's plan exists; the display-name spoof's docs/plans/evil.md would be plan-missing.
        const plans = { 'docs/plans/csv-export.md': '# CSV export' };
        expect(checkItems(w.forge, [42], { ...w.env, readPlan: (p) => plans[p] ?? null })[0]).toMatchObject({ id: 42, bucket: 'runnable', reasons: [], detail: 'plan: omg-plan docs/plans/csv-export.md', planSource: 'omg-plan' });
        expect(checkItems(w.forge, [42], w.env)[0]).toMatchObject({ bucket: 'needs-plan', reasons: ['plan-missing'] });
        expect(w.forge.tracker.addMarker(42, 'factory-ready')).toMatchObject({ ok: false });
        expect(w.calls.some((c) => methodOf(c.args) === 'PATCH')).toBe(false);
        w.mark.marker = 'factory-ready';
        expect(w.forge.tracker.addMarker(42, 'factory-ready')).toEqual({ ok: true, stderr: '' });
        expect(w.calls.filter((c) => methodOf(c.args) === 'PATCH')).toHaveLength(1);
    });
});
//# sourceMappingURL=ado.test.js.map