import { describe, expect, it } from 'vitest';
import { ADO_ROUTES, ADO_WRITE_ALLOWLIST, adoRouteById, findAdoRoute } from '../routes.js';

const tuple = (r: { area: string; resource: string; method: string }) => `${r.area}/${r.resource} ${r.method}`;

describe('ADO route table invariants', () => {
  it('every route pins an api-version (7.1 or a 7.1 preview)', () => {
    for (const r of ADO_ROUTES) expect(r.apiVersion, r.id).toMatch(/^7\.1(?:-preview\.\d+)?$/);
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
    for (const r of ADO_ROUTES) expect(r.id).toBe(`${r.area}.${r.resource}.${r.method}`);
  });

  it('no write route sits outside the write allowlist, and every allowlisted write has a route', () => {
    const allowed = new Set(ADO_WRITE_ALLOWLIST.map(([area, resource, method]) => tuple({ area, resource, method })));
    const writes = ADO_ROUTES.filter((r) => r.method !== 'GET').map(tuple);
    expect(writes.filter((w) => !allowed.has(w))).toEqual([]);
    expect([...allowed].filter((a) => !writes.includes(a))).toEqual([]);
  });

  it('every write declares its body allowlist; reads have none', () => {
    for (const r of ADO_ROUTES) {
      if (r.method === 'GET') expect(r.body, r.id).toBeUndefined();
      else expect(r.body, r.id).toBeDefined();
    }
  });

  it('never allows pushes, ref updates, policy configuration writes or a merge-shaped PR body', () => {
    for (const [area, resource] of [['git', 'pushes'], ['git', 'refs'], ['policy', 'configurations']]) {
      for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) expect(findAdoRoute(area, resource, method), `${area}/${resource} ${method}`).toBeUndefined();
    }
    const patch = adoRouteById('git.pullRequests.PATCH').body;
    expect(patch).toEqual({ kind: 'object', keys: ['isDraft'], required: ['isDraft'] });
    const post = adoRouteById('git.pullRequests.POST').body;
    expect(post?.kind === 'object' && post.keys).not.toContain('autoCompleteSetBy');
    expect(post?.kind === 'object' && post.keys).not.toContain('completionOptions');
  });

  it('the work-item JSON-patch reaches only rev, tags, state and the Kanban column', () => {
    const body = adoRouteById('wit.workItems.PATCH').body;
    if (body?.kind !== 'json-patch') throw new Error('expected a json-patch body');
    const ok = (path: string) => body.paths.some((re) => re.test(path));
    expect(['/rev', '/fields/System.Tags', '/fields/System.State', '/fields/WEF_6CB513B6E70E43499D9FC94E5BBFB784_Kanban.Column'].every(ok)).toBe(true);
    expect(['/fields/System.AssignedTo', '/fields/System.Description', '/relations/-', '/fields/System.Tags/x'].some(ok)).toBe(false);
    expect(body.ops).toEqual(['test', 'add']);
  });

  it('findAdoRoute compares names case-insensitively', () => {
    expect(findAdoRoute('Git', 'PULLREQUESTS', 'patch')?.id).toBe('git.pullRequests.PATCH');
    expect(findAdoRoute('git', 'pullRequests', 'DELETE')).toBeUndefined();
  });
});
