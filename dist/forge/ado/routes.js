/**
 * Every Azure DevOps REST call the factory makes, as `az devops invoke`
 * shapes (factory forges design §6; critic amendments §A.1, §A.4). The guard
 * (PR 5) allowlists exactly these `(area, resource, httpMethod)` tuples and
 * refuses everything else; the fixtures are keyed by `id`.
 *
 * - `apiVersion` is pinned per route, preview versions included (there is no
 *   global "7.1 only"). Checked against learn.microsoft.com REST 7.1, Oct 2026.
 * - `routeParams` are the only `--route-parameters` names allowed
 *   (`project` and `repositoryId`, when passed, must equal the resolved forge repo).
 * - `queryParams` are the only `--query-parameters` names allowed.
 * - A write's `body` is the `--in-file` key allowlist the guard validates
 *   before it hands az an engine-owned copy of the bytes.
 *
 * The area/resource names were taken from the REST docs, not from a live
 * `az devops invoke` listing (design §10.1): the first live run diffs them.
 */
const STABLE = '7.1';
const route = (r) => Object.freeze(r);
export const ADO_ROUTES = Object.freeze([
    // Setup probes.
    route({ id: 'core.projects.GET', area: 'core', resource: 'projects', method: 'GET', apiVersion: STABLE, routeParams: ['projectId'], queryParams: [] }),
    route({ id: 'core.teams.GET', area: 'core', resource: 'teams', method: 'GET', apiVersion: STABLE, routeParams: ['projectId'], queryParams: ['$top', '$skip'] }),
    route({ id: 'git.repositories.GET', area: 'git', resource: 'repositories', method: 'GET', apiVersion: STABLE, routeParams: ['project', 'repositoryId'], queryParams: [] }),
    // Work items (intake, check, progress).
    route({ id: 'wit.workItems.GET', area: 'wit', resource: 'workItems', method: 'GET', apiVersion: STABLE, routeParams: ['project', 'id'], queryParams: ['$expand'] }),
    route({
        id: 'wit.workItems.PATCH', area: 'wit', resource: 'workItems', method: 'PATCH', apiVersion: STABLE, routeParams: ['project', 'id'], queryParams: [],
        mediaType: 'application/json-patch+json',
        // test /rev guards a concurrent edit; tags, state and the board's Kanban column field are the only writes.
        body: { kind: 'json-patch', ops: ['test', 'add'], paths: [/^\/rev$/, /^\/fields\/System\.Tags$/, /^\/fields\/System\.State$/, /^\/fields\/WEF_[0-9A-F]{32}_Kanban\.Column$/] },
    }),
    route({ id: 'wit.comments.GET', area: 'wit', resource: 'comments', method: 'GET', apiVersion: '7.1-preview.4', routeParams: ['project', 'workItemId'], queryParams: ['$top', 'continuationToken', 'order'] }),
    route({
        id: 'wit.comments.POST', area: 'wit', resource: 'comments', method: 'POST', apiVersion: '7.1-preview.4', routeParams: ['project', 'workItemId'], queryParams: ['format'],
        body: { kind: 'object', keys: ['text'], required: ['text'] },
    }),
    route({ id: 'wit.workItemTypes.GET', area: 'wit', resource: 'workItemTypes', method: 'GET', apiVersion: STABLE, routeParams: ['project'], queryParams: [] }),
    route({ id: 'wit.workItemTypeStates.GET', area: 'wit', resource: 'workItemTypeStates', method: 'GET', apiVersion: STABLE, routeParams: ['project', 'type'], queryParams: [] }),
    route({ id: 'wit.wiql.GET', area: 'wit', resource: 'wiql', method: 'GET', apiVersion: STABLE, routeParams: ['project', 'id'], queryParams: ['$top'] }),
    route({
        id: 'wit.wiql.POST', area: 'wit', resource: 'wiql', method: 'POST', apiVersion: STABLE, routeParams: ['project'], queryParams: ['$top'],
        body: { kind: 'object', keys: ['query'], required: ['query'] },
    }),
    route({ id: 'wit.queries.GET', area: 'wit', resource: 'queries', method: 'GET', apiVersion: STABLE, routeParams: ['project'], queryParams: ['$depth', '$expand'] }),
    route({ id: 'wit.classificationNodes.GET', area: 'wit', resource: 'classificationNodes', method: 'GET', apiVersion: STABLE, routeParams: ['project', 'structureGroup'], queryParams: ['$depth'] }),
    // Boards (board-column intake, progress columns).
    route({ id: 'work.boards.GET', area: 'work', resource: 'boards', method: 'GET', apiVersion: STABLE, routeParams: ['project', 'team', 'id'], queryParams: [] }),
    route({ id: 'work.columns.GET', area: 'work', resource: 'columns', method: 'GET', apiVersion: STABLE, routeParams: ['project', 'team', 'board'], queryParams: [] }),
    // Pull requests.
    route({
        id: 'git.pullRequests.GET', area: 'git', resource: 'pullRequests', method: 'GET', apiVersion: STABLE, routeParams: ['project', 'repositoryId', 'pullRequestId'],
        queryParams: ['searchCriteria.sourceRefName', 'searchCriteria.status', '$top'],
    }),
    route({
        id: 'git.pullRequests.POST', area: 'git', resource: 'pullRequests', method: 'POST', apiVersion: STABLE, routeParams: ['project', 'repositoryId'], queryParams: [],
        body: { kind: 'object', keys: ['sourceRefName', 'targetRefName', 'title', 'description', 'isDraft', 'workItemRefs'], required: ['sourceRefName', 'targetRefName', 'title', 'isDraft'] },
    }),
    // Mark ready only: a body with status, autoCompleteSetBy or completionOptions (a merge) is refused (design §8.4).
    route({
        id: 'git.pullRequests.PATCH', area: 'git', resource: 'pullRequests', method: 'PATCH', apiVersion: STABLE, routeParams: ['project', 'repositoryId', 'pullRequestId'], queryParams: [],
        body: { kind: 'object', keys: ['isDraft'], required: ['isDraft'] },
    }),
    route({
        id: 'git.pullRequestThreads.POST', area: 'git', resource: 'pullRequestThreads', method: 'POST', apiVersion: STABLE, routeParams: ['project', 'repositoryId', 'pullRequestId'], queryParams: [],
        body: { kind: 'object', keys: ['comments', 'status'], required: ['comments'] },
    }),
    route({ id: 'git.pullRequestIterations.GET', area: 'git', resource: 'pullRequestIterations', method: 'GET', apiVersion: STABLE, routeParams: ['project', 'repositoryId', 'pullRequestId'], queryParams: [] }),
    route({ id: 'git.pullRequestStatuses.GET', area: 'git', resource: 'pullRequestStatuses', method: 'GET', apiVersion: STABLE, routeParams: ['project', 'repositoryId', 'pullRequestId'], queryParams: [] }),
    // Policy (gates) and builds.
    route({ id: 'policy.evaluations.GET', area: 'policy', resource: 'evaluations', method: 'GET', apiVersion: '7.1-preview.1', routeParams: ['project'], queryParams: ['artifactId', 'includeNotApplicable', '$top', '$skip'] }),
    // Requeue one evaluation (rerun a flaky or expired build); the REST call has no body.
    route({ id: 'policy.evaluations.PATCH', area: 'policy', resource: 'evaluations', method: 'PATCH', apiVersion: '7.1-preview.1', routeParams: ['project', 'evaluationId'], queryParams: [], body: { kind: 'none' } }),
    // By id, or the builds of refs/pull/{id}/merge (runsForHead, critic amendments §A.2).
    route({ id: 'build.builds.GET', area: 'build', resource: 'builds', method: 'GET', apiVersion: STABLE, routeParams: ['project', 'buildId'], queryParams: ['branchName', 'reasonFilter', 'queryOrder', '$top'] }),
    route({ id: 'build.timeline.GET', area: 'build', resource: 'timeline', method: 'GET', apiVersion: STABLE, routeParams: ['project', 'buildId'], queryParams: [] }),
    route({ id: 'build.logs.GET', area: 'build', resource: 'logs', method: 'GET', apiVersion: STABLE, routeParams: ['project', 'buildId', 'logId'], queryParams: [], acceptMediaType: 'text/plain' }),
]);
/**
 * The writes the factory may make, listed by hand so a new write route needs
 * a deliberate edit here too (routes.test.ts: every non-GET route is listed,
 * every listed tuple has a route). Merges, pushes, ref updates and branch
 * policy edits are never on it.
 */
export const ADO_WRITE_ALLOWLIST = Object.freeze([
    ['wit', 'workItems', 'PATCH'],
    ['wit', 'comments', 'POST'],
    ['wit', 'wiql', 'POST'],
    ['git', 'pullRequests', 'POST'],
    ['git', 'pullRequests', 'PATCH'],
    ['git', 'pullRequestThreads', 'POST'],
    ['policy', 'evaluations', 'PATCH'],
]);
/** The route for an `(area, resource, httpMethod)` tuple; undefined = refused. Names compare case-insensitively, as az does. */
export function findAdoRoute(area, resource, method) {
    const a = area.toLowerCase(), r = resource.toLowerCase(), m = method.toUpperCase();
    return ADO_ROUTES.find((x) => x.area.toLowerCase() === a && x.resource.toLowerCase() === r && x.method === m);
}
export function adoRouteById(id) {
    const found = ADO_ROUTES.find((r) => r.id === id);
    if (!found)
        throw new Error(`no Azure DevOps route ${id}`);
    return found;
}
//# sourceMappingURL=routes.js.map