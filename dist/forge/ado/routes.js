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
 * - A write's `body` is the `--in-file` key and value allowlist; the guard
 *   runs validateAdoBody on it before it hands az an engine-owned copy of
 *   the bytes.
 *
 * The area/resource names were taken from the REST docs, not from a live
 * `az devops invoke` listing (design §10.1): the first live run diffs them.
 */
const STABLE = '7.1';
/** A non-empty string with no control characters other than tab and newlines. */
const TEXT = { type: 'string', pattern: /^(?:[^\p{Cc}]|[\t\r\n])+$/u };
/** A branch ref; never refs/pull, refs/tags or a ref with `..`. */
const BRANCH_REF = { type: 'string', pattern: /^refs\/heads\/(?!.*\.\.)[^\s\p{Cc}~^:?*[\\]+$/u, maxLength: 400 };
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
        body: {
            kind: 'json-patch',
            ops: ['test', 'add'],
            paths: [
                { path: /^\/rev$/, value: { type: 'integer', min: 1 } },
                { path: /^\/fields\/System\.Tags$/, value: TEXT },
                { path: /^\/fields\/System\.State$/, value: TEXT },
                { path: /^\/fields\/WEF_[0-9A-F]{32}_Kanban\.Column$/, value: TEXT },
            ],
        },
    }),
    route({ id: 'wit.comments.GET', area: 'wit', resource: 'comments', method: 'GET', apiVersion: '7.1-preview.4', routeParams: ['project', 'workItemId'], queryParams: ['$top', 'continuationToken', 'order'] }),
    route({
        id: 'wit.comments.POST', area: 'wit', resource: 'comments', method: 'POST', apiVersion: '7.1-preview.4', routeParams: ['project', 'workItemId'], queryParams: ['format'],
        body: { kind: 'object', keys: ['text'], required: ['text'], values: { text: TEXT } },
    }),
    route({ id: 'wit.workItemTypes.GET', area: 'wit', resource: 'workItemTypes', method: 'GET', apiVersion: STABLE, routeParams: ['project'], queryParams: [] }),
    route({ id: 'wit.workItemTypeStates.GET', area: 'wit', resource: 'workItemTypeStates', method: 'GET', apiVersion: STABLE, routeParams: ['project', 'type'], queryParams: [] }),
    route({ id: 'wit.wiql.GET', area: 'wit', resource: 'wiql', method: 'GET', apiVersion: STABLE, routeParams: ['project', 'id'], queryParams: ['$top'] }),
    route({
        id: 'wit.wiql.POST', area: 'wit', resource: 'wiql', method: 'POST', apiVersion: STABLE, routeParams: ['project'], queryParams: ['$top'],
        body: { kind: 'object', keys: ['query'], required: ['query'], values: { query: TEXT } },
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
        // The factory only ever opens drafts.
        body: {
            kind: 'object',
            keys: ['sourceRefName', 'targetRefName', 'title', 'description', 'isDraft', 'workItemRefs'],
            required: ['sourceRefName', 'targetRefName', 'title', 'isDraft'],
            values: {
                sourceRefName: BRANCH_REF,
                targetRefName: BRANCH_REF,
                title: { type: 'string', maxLength: 400 },
                description: { type: 'string', maxLength: 4000 },
                isDraft: { const: true },
                workItemRefs: { type: 'array', minItems: 0, maxItems: 1, items: { kind: 'object', keys: ['id'], required: ['id'], values: { id: { type: 'string', pattern: /^[1-9]\d{0,9}$/ } } } },
            },
        },
    }),
    // Mark ready only: a body with status, autoCompleteSetBy or completionOptions (a merge) is refused (design §8.4).
    route({
        id: 'git.pullRequests.PATCH', area: 'git', resource: 'pullRequests', method: 'PATCH', apiVersion: STABLE, routeParams: ['project', 'repositoryId', 'pullRequestId'], queryParams: [],
        body: { kind: 'object', keys: ['isDraft'], required: ['isDraft'], values: { isDraft: { const: false } } },
    }),
    // One new top-level text comment per thread (no replies, no code-review comment types).
    route({
        id: 'git.pullRequestThreads.POST', area: 'git', resource: 'pullRequestThreads', method: 'POST', apiVersion: STABLE, routeParams: ['project', 'repositoryId', 'pullRequestId'], queryParams: [],
        body: {
            kind: 'object',
            keys: ['comments', 'status'],
            required: ['comments'],
            values: {
                comments: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 1,
                    items: {
                        kind: 'object',
                        keys: ['content', 'commentType', 'parentCommentId'],
                        required: ['content'],
                        values: { content: { type: 'string', maxLength: 150_000 }, commentType: { enum: [1, 'text'] }, parentCommentId: { const: 0 } },
                    },
                },
                status: { enum: [1, 'active', 4, 'closed'] },
            },
        },
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
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function valueProblem(v, rule, at) {
    if ('const' in rule)
        return v === rule.const ? undefined : `${at} must be ${JSON.stringify(rule.const)}`;
    if ('enum' in rule)
        return rule.enum.includes(v) ? undefined : `${at} must be one of ${rule.enum.map((e) => JSON.stringify(e)).join(', ')}`;
    switch (rule.type) {
        case 'string':
            if (typeof v !== 'string' || v === '')
                return `${at} must be a non-empty string`;
            if (rule.maxLength !== undefined && v.length > rule.maxLength)
                return `${at} is longer than ${rule.maxLength} characters`;
            return rule.pattern && !rule.pattern.test(v) ? `${at} has a refused value` : undefined;
        case 'integer':
            return typeof v === 'number' && Number.isSafeInteger(v) && v >= (rule.min ?? Number.MIN_SAFE_INTEGER) ? undefined : `${at} must be an integer${rule.min === undefined ? '' : ` >= ${rule.min}`}`;
        case 'array':
            if (!Array.isArray(v) || v.length < rule.minItems || v.length > rule.maxItems)
                return `${at} must be an array of ${rule.minItems} to ${rule.maxItems} items`;
            for (let i = 0; i < v.length; i++) {
                const problem = objectProblem(v[i], rule.items, `${at}[${i}]`);
                if (problem)
                    return problem;
            }
            return undefined;
    }
}
function objectProblem(v, shape, at) {
    if (!isPlainObject(v))
        return `${at} must be an object`;
    const extra = Object.keys(v).find((k) => !shape.keys.includes(k));
    if (extra !== undefined)
        return `${at}.${extra} is not allowed`;
    const missing = shape.required.find((k) => !Object.hasOwn(v, k));
    if (missing !== undefined)
        return `${at}.${missing} is required`;
    for (const [k, value] of Object.entries(v)) {
        const rule = Object.hasOwn(shape.values, k) ? shape.values[k] : undefined;
        if (!rule)
            return `${at}.${k} has no value rule`;
        const problem = valueProblem(value, rule, `${at}.${k}`);
        if (problem)
            return problem;
    }
    return undefined;
}
/**
 * The typed validator hook for the invoke guard (PR 5): the first reason the
 * parsed `--in-file` JSON is refused for `route`, or undefined when every key
 * and value is allowed. `kind: 'none'` takes no `--in-file` at all
 * (body === undefined).
 */
export function validateAdoBody(route, body) {
    const shape = route.body;
    if (!shape)
        return `${route.id} takes no body`;
    if (shape.kind === 'none')
        return body === undefined ? undefined : `${route.id} takes no body`;
    if (shape.kind === 'object')
        return objectProblem(body, shape, 'body');
    if (!Array.isArray(body) || body.length === 0)
        return 'body must be a non-empty JSON-patch array';
    for (let i = 0; i < body.length; i++) {
        const at = `body[${i}]`;
        const op = body[i];
        if (!isPlainObject(op))
            return `${at} must be an object`;
        const extra = Object.keys(op).find((k) => k !== 'op' && k !== 'path' && k !== 'value');
        if (extra !== undefined)
            return `${at}.${extra} is not allowed`;
        if (typeof op.op !== 'string' || !shape.ops.includes(op.op))
            return `${at}.op must be one of ${shape.ops.join(', ')}`;
        const target = typeof op.path === 'string' ? shape.paths.find((p) => p.path.test(op.path)) : undefined;
        if (!target)
            return `${at}.path is not allowed`;
        const problem = valueProblem(op.value, target.value, `${at}.value`);
        if (problem)
            return problem;
    }
    return undefined;
}
//# sourceMappingURL=routes.js.map