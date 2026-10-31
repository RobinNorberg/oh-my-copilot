import { describe, expect, it } from 'vitest';
import { ADO_ROUTES, ADO_TRACKER_RELATIONS, ADO_WRITE_ALLOWLIST, adoRouteById, findAdoRoute, validateAdoBody } from '../routes.js';
const tuple = (r) => `${r.area}/${r.resource} ${r.method}`;
describe('ADO route table invariants', () => {
    it('every route pins an api-version (7.1 or a 7.1 preview)', () => {
        for (const r of ADO_ROUTES)
            expect(r.apiVersion, r.id).toMatch(/^7\.1(?:-preview\.\d+)?$/);
    });
    it('pins the preview versions the docs require', () => {
        expect(adoRouteById('wit.comments.GET').apiVersion).toBe('7.1-preview.4');
        expect(adoRouteById('wit.comments.POST').apiVersion).toBe('7.1-preview.4');
        expect(adoRouteById('policy.evaluations.GET').apiVersion).toBe('7.1-preview.1');
    });
    it('ids and (area, resource, method) tuples are unique', () => {
        expect(new Set(ADO_ROUTES.map((r) => r.id)).size).toBe(ADO_ROUTES.length);
        expect(new Set(ADO_ROUTES.map((r) => tuple(r).toLowerCase())).size).toBe(ADO_ROUTES.length);
    });
    it('every id is <area>.<resource>.<method>', () => {
        for (const r of ADO_ROUTES)
            expect(r.id).toBe(`${r.area}.${r.resource}.${r.method}`);
    });
    it('no write route sits outside the write allowlist, and every allowlisted write has a route', () => {
        const allowed = new Set(ADO_WRITE_ALLOWLIST.map(([area, resource, method]) => tuple({ area, resource, method })));
        const writes = ADO_ROUTES.filter((r) => r.method !== 'GET').map(tuple);
        expect(writes.filter((w) => !allowed.has(w))).toEqual([]);
        expect([...allowed].filter((a) => !writes.includes(a))).toEqual([]);
    });
    it('every write declares its body allowlist; reads have none', () => {
        for (const r of ADO_ROUTES) {
            if (r.method === 'GET')
                expect(r.body, r.id).toBeUndefined();
            else
                expect(r.body, r.id).toBeDefined();
        }
    });
    it('never allows pushes, ref updates, policy configuration writes or a merge-shaped PR body', () => {
        for (const [area, resource] of [['git', 'pushes'], ['git', 'refs'], ['policy', 'configurations']]) {
            for (const method of ['POST', 'PATCH', 'PUT', 'DELETE'])
                expect(findAdoRoute(area, resource, method), `${area}/${resource} ${method}`).toBeUndefined();
        }
        const patch = adoRouteById('git.pullRequests.PATCH').body;
        expect(patch).toEqual({ kind: 'object', keys: ['isDraft'], required: ['isDraft'], values: { isDraft: { const: false } } });
        const post = adoRouteById('git.pullRequests.POST').body;
        expect(post?.kind === 'object' && post.keys).not.toContain('autoCompleteSetBy');
        expect(post?.kind === 'object' && post.keys).not.toContain('completionOptions');
    });
    it('the work-item JSON-patch reaches only rev, tags, state and the Kanban column without the tracker write context', () => {
        const body = adoRouteById('wit.workItems.PATCH').body;
        if (body?.kind !== 'json-patch')
            throw new Error('expected a json-patch body');
        const engine = (path) => body.paths.some((p) => !p.tracker && p.path.test(path));
        expect(['/rev', '/fields/System.Tags', '/fields/System.State', '/fields/WEF_6CB513B6E70E43499D9FC94E5BBFB784_Kanban.Column'].every(engine)).toBe(true);
        expect(['/fields/System.AssignedTo', '/fields/System.Description', '/relations/-', '/fields/System.Tags/x'].some(engine)).toBe(false);
        expect(body.ops).toEqual(['test', 'add']);
    });
    it('tracker writes: the create route and the PATCH tracker paths are exactly the design §3.3 fields and one link path', () => {
        const create = adoRouteById('wit.workItems.POST');
        expect(create).toMatchObject({ area: 'wit', resource: 'workItems', method: 'POST', apiVersion: '7.1', routeParams: ['project', 'type'], queryParams: [], mediaType: 'application/json-patch+json', tracker: true });
        if (create.body?.kind !== 'json-patch')
            throw new Error('expected a json-patch body');
        expect(create.body.ops).toEqual(['add']);
        const fields = ['/fields/System.Title', '/fields/System.Description', '/fields/Microsoft.VSTS.Common.AcceptanceCriteria', '/fields/Microsoft.VSTS.Common.Priority'];
        const creates = (path) => create.body?.kind === 'json-patch' && create.body.paths.some((p) => p.path.test(path));
        expect([...fields, '/fields/System.Tags', '/fields/System.AreaPath'].every(creates)).toBe(true);
        expect(['/relations/-', '/fields/System.State', '/fields/System.AssignedTo', '/fields/System.IterationPath', '/id', '/rev'].some(creates)).toBe(false);
        const patch = adoRouteById('wit.workItems.PATCH').body;
        if (patch?.kind !== 'json-patch')
            throw new Error('expected a json-patch body');
        const tracker = patch.paths.filter((p) => p.tracker);
        expect(tracker.map((p) => p.path.source)).toEqual([...fields, '/relations/-'].map((f) => `^${f.replace(/[./]/g, (c) => `\\${c}`)}$`));
        // No route removes or replaces anything; only these two relation types.
        expect(ADO_TRACKER_RELATIONS).toEqual(['System.LinkTypes.Hierarchy-Reverse', 'System.LinkTypes.Dependency-Reverse']);
        expect(ADO_ROUTES.filter((r) => r.tracker).map((r) => r.id)).toEqual(['wit.workItems.POST']);
    });
    it('findAdoRoute compares names case-insensitively', () => {
        expect(findAdoRoute('Git', 'PULLREQUESTS', 'patch')?.id).toBe('git.pullRequests.PATCH');
        expect(findAdoRoute('git', 'pullRequests', 'DELETE')).toBeUndefined();
    });
    it('every object body key has a value rule, nested ones included', () => {
        const check = (shape, at) => {
            expect(Object.keys(shape.values).sort(), at).toEqual([...shape.keys].sort());
            for (const r of shape.required)
                expect(shape.keys, at).toContain(r);
            for (const [k, v] of Object.entries(shape.values))
                if ('type' in v && v.type === 'array')
                    check(v.items, `${at}.${k}`);
        };
        for (const r of ADO_ROUTES)
            if (r.body?.kind === 'object')
                check(r.body, r.id);
    });
});
describe('validateAdoBody (the guard hook for PR 5)', () => {
    const v = (id, body) => validateAdoBody(adoRouteById(id), body);
    const pr = { sourceRefName: 'refs/heads/factory/42-fix', targetRefName: 'refs/heads/main', title: 'Fix it', isDraft: true };
    it('POST pullRequests: a draft only, branch refs only', () => {
        expect(v('git.pullRequests.POST', pr)).toBeUndefined();
        expect(v('git.pullRequests.POST', { ...pr, description: 'body', workItemRefs: [{ id: '42' }] })).toBeUndefined();
        expect(v('git.pullRequests.POST', { ...pr, isDraft: false })).toMatch(/isDraft must be true/);
        expect(v('git.pullRequests.POST', { ...pr, isDraft: 'true' })).toMatch(/isDraft/);
        expect(v('git.pullRequests.POST', { ...pr, targetRefName: 'refs/pull/1/merge' })).toMatch(/targetRefName/);
        expect(v('git.pullRequests.POST', { ...pr, sourceRefName: 'refs/heads/a/../b' })).toMatch(/sourceRefName/);
        expect(v('git.pullRequests.POST', { ...pr, workItemRefs: [{ id: '42', url: 'x' }] })).toMatch(/workItemRefs\[0\]\.url is not allowed/);
        expect(v('git.pullRequests.POST', { ...pr, completionOptions: {} })).toMatch(/completionOptions is not allowed/);
        const { isDraft: _drop, ...noDraft } = pr;
        expect(v('git.pullRequests.POST', noDraft)).toMatch(/isDraft is required/);
    });
    it('PATCH pullRequests: isDraft false only (mark ready)', () => {
        expect(v('git.pullRequests.PATCH', { isDraft: false })).toBeUndefined();
        expect(v('git.pullRequests.PATCH', { isDraft: true })).toMatch(/isDraft must be false/);
        expect(v('git.pullRequests.PATCH', { isDraft: false, status: 'completed' })).toMatch(/status is not allowed/);
    });
    it('POST pullRequestThreads: exactly one top-level text comment', () => {
        expect(v('git.pullRequestThreads.POST', { comments: [{ content: 'hi', commentType: 1, parentCommentId: 0 }], status: 'active' })).toBeUndefined();
        expect(v('git.pullRequestThreads.POST', { comments: [] })).toMatch(/comments must be an array of 1 to 1/);
        expect(v('git.pullRequestThreads.POST', { comments: [{ content: 'hi' }, { content: 'again' }] })).toMatch(/comments/);
        expect(v('git.pullRequestThreads.POST', { comments: [{ content: 'hi', commentType: 2 }] })).toMatch(/commentType/);
        expect(v('git.pullRequestThreads.POST', { comments: [{ content: 'hi', parentCommentId: 7 }] })).toMatch(/parentCommentId/);
        expect(v('git.pullRequestThreads.POST', { comments: [{ content: 'hi', author: { id: 'x' } }] })).toMatch(/comments\[0\]\.author is not allowed/);
        expect(v('git.pullRequestThreads.POST', { comments: [{ content: 'hi' }], status: 'fixed' })).toMatch(/status/);
    });
    it('PATCH workItems: allowlisted ops and paths with typed values', () => {
        const ok = [
            { op: 'test', path: '/rev', value: 3 },
            { op: 'add', path: '/fields/System.Tags', value: 'factory; factory:building' },
        ];
        expect(v('wit.workItems.PATCH', ok)).toBeUndefined();
        expect(v('wit.workItems.PATCH', [])).toMatch(/non-empty/);
        expect(v('wit.workItems.PATCH', [{ op: 'remove', path: '/fields/System.Tags' }])).toMatch(/op must be/);
        expect(v('wit.workItems.PATCH', [{ op: 'add', path: '/fields/System.AssignedTo', value: 'x' }])).toMatch(/path is not allowed/);
        expect(v('wit.workItems.PATCH', [{ op: 'test', path: '/rev', value: '3' }])).toMatch(/integer/);
        expect(v('wit.workItems.PATCH', [{ op: 'add', path: '/fields/System.State', value: { name: 'Done' } }])).toMatch(/string/);
        expect(v('wit.workItems.PATCH', [{ op: 'add', path: '/fields/System.State', value: 'Done', from: '/x' }])).toMatch(/from is not allowed/);
    });
    it('none-bodied writes, reads and other object bodies', () => {
        expect(v('policy.evaluations.PATCH', undefined)).toBeUndefined();
        expect(v('policy.evaluations.PATCH', {})).toMatch(/takes no body/);
        expect(v('git.pullRequests.GET', {})).toMatch(/takes no body/);
        expect(v('wit.comments.POST', { text: 'done' })).toBeUndefined();
        expect(v('wit.comments.POST', { text: '' })).toMatch(/non-empty/);
        expect(v('wit.comments.POST', JSON.parse('{"text":"x","__proto__":{"a":1}}'))).toMatch(/__proto__ is not allowed/);
        expect(v('wit.wiql.POST', { query: 'SELECT [System.Id] FROM WorkItems' })).toBeUndefined();
        expect(v('wit.wiql.POST', ['x'])).toMatch(/must be an object/);
    });
});
//# sourceMappingURL=routes.test.js.map