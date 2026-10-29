/**
 * The Azure DevOps path of `omg factory check`, on recorded-format fixtures
 * (src/forge/ado/__tests__/fixtures.ts) in ./fixtures/ado. The ADO adapter
 * (PR 5) is not on this base, so a minimal tracker over the same
 * `az devops invoke` calls stands in for it; the check reads only through
 * the Forge interface, so the adapter drops in unchanged.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adoFixtureExec, loadAdoFixtures } from '../../../forge/ado/__tests__/fixtures.js';
import { adoHtmlToText } from '../../../forge/ado/html.js';
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
        // The factory guard has no ADO shapes on this base (fail closed); count what reaches it.
        const guarded = checkGuardExec(((cmd, args) => { seen.push(args); return inner(cmd, args); }));
        expect(() => guarded('az', ['devops', 'invoke', '--area', 'wit', '--resource', 'workItems', '--http-method', 'PATCH'])).toThrow(/only reads run without a confirmed --mark/);
        expect(seen).toEqual([]);
    });
});
//# sourceMappingURL=ado.test.js.map