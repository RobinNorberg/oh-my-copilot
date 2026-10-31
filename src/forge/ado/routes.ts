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
 *
 * Tracker writes (`omg factory enqueue` only, shipyard-factory design §3.3,
 * PR 7b): the work item create route and the `tracker: true` paths of the
 * work item PATCH pass only when the guard holds enqueue's tracker write
 * context; the engine, `check` and `omg ship` never get them.
 */

export type AdoHttpMethod = 'GET' | 'POST' | 'PATCH';

/** The value one body key may hold (validateAdoBody enforces it). */
export type AdoValue =
  | { type: 'string'; pattern?: RegExp; maxLength?: number }
  | { type: 'integer'; min?: number }
  | { const: string | number | boolean }
  | { enum: readonly (string | number)[] }
  | { type: 'array'; minItems: number; maxItems: number; items: AdoObjectBody }
  | { type: 'object'; shape: AdoObjectBody };

/** A JSON object: only `keys`, all of `required`, and every present key's value matching `values[key]`. */
export interface AdoObjectBody {
  kind: 'object';
  keys: readonly string[];
  required: readonly string[];
  /** One rule per key in `keys` (routes.test.ts holds that). */
  values: Readonly<Record<string, AdoValue>>;
}

/** `--in-file` body shape of a write route. */
export type AdoBody =
  | { kind: 'none' }
  | AdoObjectBody
  /** RFC 6902 JSON-patch array: only these ops, only paths matching one pattern, each with its value rule. */
  | { kind: 'json-patch'; ops: readonly string[]; paths: readonly AdoPatchPath[] };

/** One allowed JSON-patch path. */
export interface AdoPatchPath {
  path: RegExp;
  value: AdoValue;
  /** A config- or context-bound rule on top of `value` (validateAdoBody). */
  configured?: 'states' | 'columns' | 'tags' | 'areaPath' | 'relation';
  /** Only with the tracker write context (`omg factory enqueue`); a tracker PATCH starts with `test /rev`. */
  tracker?: true;
}

/** What `omg factory enqueue` may write on Azure DevOps (from the factory guard's TrackerWriteContext). */
export interface AdoTrackerWrites {
  /** Tags a created work item may carry (the intake tag); `factory:*` and `harbor:*` never pass. */
  labels: readonly string[];
  /** Work item types the create route may name (factory.intake.itemTypes); none = no create. */
  itemTypes?: readonly string[];
}

/** Values only the run's config knows, for validateAdoBody. */
export interface AdoBodyContext {
  /** When set, a `configured: 'states'` path may only carry one of these (exact match). */
  allowedStates?: readonly string[];
  /** When set, a `configured: 'columns'` path may only carry one of these (exact match). */
  allowedColumns?: readonly string[];
  /** The forge org: a relation's url must name a work item of it. */
  org?: string;
  /** The forge project: an area path must be it or under it. */
  project?: string;
  /** Set only for `omg factory enqueue`: the `tracker` paths and the stricter tag rule apply. */
  trackerWrites?: AdoTrackerWrites;
}

export interface AdoRoute {
  /** Fixture and call-site key: `<area>.<resource>.<method>[.<variant>]`. */
  id: string;
  area: string;
  resource: string;
  method: AdoHttpMethod;
  apiVersion: string;
  routeParams: readonly string[];
  queryParams: readonly string[];
  /** Writes only. */
  body?: AdoBody;
  /** `--media-type` (request). */
  mediaType?: string;
  /** `--accept-media-type` (response). */
  acceptMediaType?: string;
  /** Only with the tracker write context (`omg factory enqueue`). */
  tracker?: true;
}

const STABLE = '7.1';
/** A non-empty string with no control characters other than tab and newlines. */
const TEXT_CHARS = /^(?:[^\p{Cc}]|[\t\r\n])+$/u;
const TEXT: AdoValue = { type: 'string', pattern: TEXT_CHARS };
/** TEXT with a length cap (the PR title and description, critic amendments §A.13). */
const text = (maxLength: number): AdoValue => ({ type: 'string', pattern: TEXT_CHARS, maxLength });
/** A branch ref; never refs/pull, refs/tags or a ref with `..`. */
const BRANCH_REF: AdoValue = { type: 'string', pattern: /^refs\/heads\/(?!.*\.\.)[^\s\p{Cc}~^:?*[\\]+$/u, maxLength: 400 };

/** One line of visible text for a work item title: no control or format characters (bidi overrides), no leading `-`; ADO caps titles at 255. */
const TITLE: AdoValue = { type: 'string', pattern: /^(?!-)[^\p{Cc}\p{Cf}]+$/u, maxLength: 255 };
/**
 * The HTML the adapter builds for System.Description and the AC field
 * (tracker.ts adoTextHtml/adoListHtml): escaped text, `<div>`, `<br>`,
 * `<ul>`, `<li>` and five entities only. No attribute, link or image can
 * pass, and no control character other than tab, and no bidi control.
 */
const ADAPTER_HTML: AdoValue = {
  type: 'string',
  pattern: /^(?:[^<>&\p{Cc}\p{Bidi_Control}]|\t|<\/?(?:div|ul|li)>|<br>|&(?:amp|lt|gt|quot|#39);)+$/u,
  maxLength: 262_144,
};
/** An area path: `\`-separated names (the first must be the project, validateAdoBody's `areaPath` rule). */
const AREA_PATH: AdoValue = { type: 'string', pattern: /^(?!@)[^\p{Cc}\p{Cf}/$?*:"&<>#%|+]+$/u, maxLength: 4000 };
/** The two relations enqueue writes (shipyard-factory design §3.3, §5): parent and predecessor, as tracker.ts reads them. */
export const ADO_TRACKER_RELATIONS = ['System.LinkTypes.Hierarchy-Reverse', 'System.LinkTypes.Dependency-Reverse'] as const;
/** `{ rel, url }`, no attributes; the url's org is the forge org (validateAdoBody's `relation` rule). */
const RELATION: AdoValue = {
  type: 'object',
  shape: {
    kind: 'object',
    keys: ['rel', 'url'],
    required: ['rel', 'url'],
    values: { rel: { enum: ADO_TRACKER_RELATIONS }, url: { type: 'string', pattern: /^https:\/\/dev\.azure\.com\/[^/\s]+\/_apis\/wit\/workItems\/[1-9]\d{0,9}$/, maxLength: 400 } },
  },
};
/** Microsoft.VSTS.Common.Priority: 1 (highest) to 4. */
const PRIORITY: AdoValue = { enum: [1, 2, 3, 4] };

const route = (r: AdoRoute): AdoRoute => Object.freeze(r);

export const ADO_ROUTES: readonly AdoRoute[] = Object.freeze([
  // Setup probes.
  route({ id: 'core.projects.GET', area: 'core', resource: 'projects', method: 'GET', apiVersion: STABLE, routeParams: ['projectId'], queryParams: [] }),
  route({ id: 'core.teams.GET', area: 'core', resource: 'teams', method: 'GET', apiVersion: STABLE, routeParams: ['projectId'], queryParams: ['$top', '$skip'] }),
  route({ id: 'git.repositories.GET', area: 'git', resource: 'repositories', method: 'GET', apiVersion: STABLE, routeParams: ['project', 'repositoryId'], queryParams: [] }),

  // Work items (intake, check, progress).
  route({ id: 'wit.workItems.GET', area: 'wit', resource: 'workItems', method: 'GET', apiVersion: STABLE, routeParams: ['project', 'id'], queryParams: ['$expand'] }),
  route({
    id: 'wit.workItems.PATCH', area: 'wit', resource: 'workItems', method: 'PATCH', apiVersion: STABLE, routeParams: ['project', 'id'], queryParams: [],
    mediaType: 'application/json-patch+json',
    // test /rev guards a concurrent edit; tags, state and the board's Kanban column field are the only engine writes.
    // `add` on a field sets it; `add` on /relations/- appends a link; no op removes or replaces anything.
    // https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/update?view=azure-devops-rest-7.1 ("Add a link", "Add a tag")
    body: {
      kind: 'json-patch',
      ops: ['test', 'add'],
      paths: [
        { path: /^\/rev$/, value: { type: 'integer', min: 1 } },
        // With the tracker write context, a tag write is a test of the current list, then an add editing allowlisted tags only.
        { path: /^\/fields\/System\.Tags$/, value: TEXT, configured: 'tags' },
        // Also one of the configured progress-mapping states (validateAdoBody's allowedStates, design §7).
        { path: /^\/fields\/System\.State$/, value: TEXT, configured: 'states' },
        // A column move can change System.State too, so it is held to the configured progress columns (critic amendments §A.14).
        { path: /^\/fields\/WEF_[0-9A-F]{32}_Kanban\.Column$/, value: TEXT, configured: 'columns' },
        // Tracker writes (enqueue's update and link): title, description, AC, priority, and a parent or predecessor link.
        { path: /^\/fields\/System\.Title$/, value: TITLE, tracker: true },
        { path: /^\/fields\/System\.Description$/, value: ADAPTER_HTML, tracker: true },
        { path: /^\/fields\/Microsoft\.VSTS\.Common\.AcceptanceCriteria$/, value: ADAPTER_HTML, tracker: true },
        { path: /^\/fields\/Microsoft\.VSTS\.Common\.Priority$/, value: PRIORITY, tracker: true },
        { path: /^\/relations\/-$/, value: RELATION, configured: 'relation', tracker: true },
      ],
    },
  }),
  // Create one work item (POST {project}/_apis/wit/workitems/${type}: the `$` is in the route template, the parameter is the type name).
  // Fields only: links go through the PATCH above once every id is known. Enqueue only (tracker: true).
  // https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/create?view=azure-devops-rest-7.1
  route({
    id: 'wit.workItems.POST', area: 'wit', resource: 'workItems', method: 'POST', apiVersion: STABLE, routeParams: ['project', 'type'], queryParams: [],
    mediaType: 'application/json-patch+json',
    tracker: true,
    body: {
      kind: 'json-patch',
      ops: ['add'],
      paths: [
        { path: /^\/fields\/System\.Title$/, value: TITLE },
        { path: /^\/fields\/System\.Description$/, value: ADAPTER_HTML },
        { path: /^\/fields\/Microsoft\.VSTS\.Common\.AcceptanceCriteria$/, value: ADAPTER_HTML },
        { path: /^\/fields\/Microsoft\.VSTS\.Common\.Priority$/, value: PRIORITY },
        // Every tag on the tracker write allowlist.
        { path: /^\/fields\/System\.Tags$/, value: TEXT, configured: 'tags' },
        { path: /^\/fields\/System\.AreaPath$/, value: AREA_PATH, configured: 'areaPath' },
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
    queryParams: ['searchCriteria.sourceRefName', 'searchCriteria.status', 'searchCriteria.targetRefName', '$top'],
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
        title: text(400),
        description: text(4000),
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
  // By id, the builds of refs/pull/{id}/merge (runsForHead, critic amendments §A.2), or heal's pipeline history (ci.ts, ADO parity design §3.3).
  // https://learn.microsoft.com/en-us/rest/api/azure/devops/build/builds/list?view=azure-devops-rest-7.1
  route({
    id: 'build.builds.GET', area: 'build', resource: 'builds', method: 'GET', apiVersion: STABLE, routeParams: ['project', 'buildId'],
    queryParams: ['branchName', 'reasonFilter', 'queryOrder', '$top', 'definitions', 'statusFilter', 'resultFilter', 'minTime'],
  }),
  // The heal pipeline pick (ADO parity design §3.2).
  // https://learn.microsoft.com/en-us/rest/api/azure/devops/build/definitions/list?view=azure-devops-rest-7.1
  route({
    id: 'build.definitions.GET', area: 'build', resource: 'definitions', method: 'GET', apiVersion: STABLE, routeParams: ['project', 'definitionId'],
    queryParams: ['name', 'repositoryId', 'repositoryType', 'includeAllProperties', '$top'],
  }),
  route({ id: 'build.timeline.GET', area: 'build', resource: 'timeline', method: 'GET', apiVersion: STABLE, routeParams: ['project', 'buildId'], queryParams: [] }),
  // Read as JSON ({ count, value: [lines] }): az devops invoke refuses a non-JSON response without --out-file, which the guard never allows.
  route({ id: 'build.logs.GET', area: 'build', resource: 'logs', method: 'GET', apiVersion: STABLE, routeParams: ['project', 'buildId', 'logId'], queryParams: [] }),
]);

/**
 * The writes the factory may make, listed by hand so a new write route needs
 * a deliberate edit here too (routes.test.ts: every non-GET route is listed,
 * every listed tuple has a route). Merges, pushes, ref updates and branch
 * policy edits are never on it.
 */
export const ADO_WRITE_ALLOWLIST: ReadonlyArray<readonly [area: string, resource: string, method: Exclude<AdoHttpMethod, 'GET'>]> = Object.freeze([
  ['wit', 'workItems', 'PATCH'],
  // Enqueue only (the route's `tracker` flag).
  ['wit', 'workItems', 'POST'],
  ['wit', 'comments', 'POST'],
  ['wit', 'wiql', 'POST'],
  ['git', 'pullRequests', 'POST'],
  ['git', 'pullRequests', 'PATCH'],
  ['git', 'pullRequestThreads', 'POST'],
  ['policy', 'evaluations', 'PATCH'],
] as const);

/** The route for an `(area, resource, httpMethod)` tuple; undefined = refused. Names compare case-insensitively, as az does. */
export function findAdoRoute(area: string, resource: string, method: string): AdoRoute | undefined {
  const a = area.toLowerCase(), r = resource.toLowerCase(), m = method.toUpperCase();
  return ADO_ROUTES.find((x) => x.area.toLowerCase() === a && x.resource.toLowerCase() === r && x.method === m);
}

export function adoRouteById(id: string): AdoRoute {
  const found = ADO_ROUTES.find((r) => r.id === id);
  if (!found) throw new Error(`no Azure DevOps route ${id}`);
  return found;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function valueProblem(v: unknown, rule: AdoValue, at: string): string | undefined {
  if ('const' in rule) return v === rule.const ? undefined : `${at} must be ${JSON.stringify(rule.const)}`;
  if ('enum' in rule) return rule.enum.includes(v as string | number) ? undefined : `${at} must be one of ${rule.enum.map((e) => JSON.stringify(e)).join(', ')}`;
  switch (rule.type) {
    case 'string':
      if (typeof v !== 'string' || v === '') return `${at} must be a non-empty string`;
      if (rule.maxLength !== undefined && v.length > rule.maxLength) return `${at} is longer than ${rule.maxLength} characters`;
      return rule.pattern && !rule.pattern.test(v) ? `${at} has a refused value` : undefined;
    case 'integer':
      return typeof v === 'number' && Number.isSafeInteger(v) && v >= (rule.min ?? Number.MIN_SAFE_INTEGER) ? undefined : `${at} must be an integer${rule.min === undefined ? '' : ` >= ${rule.min}`}`;
    case 'object':
      return objectProblem(v, rule.shape, at);
    case 'array':
      if (!Array.isArray(v) || v.length < rule.minItems || v.length > rule.maxItems) return `${at} must be an array of ${rule.minItems} to ${rule.maxItems} items`;
      for (let i = 0; i < v.length; i++) {
        const problem = objectProblem(v[i], rule.items, `${at}[${i}]`);
        if (problem) return problem;
      }
      return undefined;
  }
}

function objectProblem(v: unknown, shape: AdoObjectBody, at: string): string | undefined {
  if (!isPlainObject(v)) return `${at} must be an object`;
  const extra = Object.keys(v).find((k) => !shape.keys.includes(k));
  if (extra !== undefined) return `${at}.${extra} is not allowed`;
  const missing = shape.required.find((k) => !Object.hasOwn(v, k));
  if (missing !== undefined) return `${at}.${missing} is required`;
  for (const [k, value] of Object.entries(v)) {
    const rule = Object.hasOwn(shape.values, k) ? shape.values[k] : undefined;
    if (!rule) return `${at}.${k} has no value rule`;
    const problem = valueProblem(value, rule, `${at}.${k}`);
    if (problem) return problem;
  }
  return undefined;
}

/**
 * A `factory:` or `harbor:` tag, look-alikes included: NFKC folds fullwidth
 * letters and `：`, and space around the `:` does not hide it.
 */
const isFactoryTag = (tag: string): boolean => /^(?:factory|harbor)\s*:/i.test(tag.normalize('NFKC').trim());
/** A tag enqueue may write: visible text without `;` or `,`, no leading `-`, never a `factory:` or `harbor:` tag. */
const isTrackerTag = (tag: string): boolean => /^(?!-)[^;,\p{Cc}\p{Cf}]{1,100}$/u.test(tag) && !isFactoryTag(tag);
const TAGS_PATH = '/fields/System.Tags';

/**
 * A tracker PATCH's tag write (`add` replaces the whole list): one
 * `test /fields/System.Tags <current>` before one `add`, and the edit adds and
 * removes allowlisted tags only, so every factory:/harbor: tag stays (the
 * gh --add-label/--remove-label parity of PR 7a).
 */
function trackerTagEditProblem(body: readonly Record<string, unknown>[], labels: readonly string[]): string | undefined {
  const adds = body.flatMap((op, i) => (op.op === 'add' && op.path === TAGS_PATH ? [i] : []));
  if (adds.length === 0) return undefined;
  const tests = body.flatMap((op, i) => (op.op === 'test' && op.path === TAGS_PATH ? [i] : []));
  const at = `body[${adds[0]}].value`;
  if (adds.length > 1 || tests.length !== 1 || tests[0] > adds[0]) return `body[${adds[0]}]: a tracker tag write is one add after one test ${TAGS_PATH} of the current tags`;
  const split = (v: unknown) => (v as string).split(';').map((t) => t.trim());
  const current = body[tests[0]].value === '' ? [] : split(body[tests[0]].value).filter(Boolean);
  const next = split(body[adds[0]].value);
  // ASCII-only fold: toLowerCase maps U+212A (Kelvin sign) to "k", which ADO's ordinal-ignore-case compare does not, so a look-alike would count as already current.
  // A pure case change of an existing tag (`Factory:Run` for `factory:run`) is the same tag to ADO and stays allowed.
  const fold = (t: string) => t.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const has = (list: readonly string[], tag: string) => list.some((t) => fold(t) === fold(tag));
  for (const tag of next) {
    if (has(current, tag)) continue;
    if (!isTrackerTag(tag)) return `${at} has a refused tag ${JSON.stringify(tag)}`;
    if (!labels.includes(tag)) return `${at} tag ${JSON.stringify(tag)} is not on the tracker write allowlist`;
  }
  for (const tag of current) {
    if (has(next, tag)) continue;
    if (isFactoryTag(tag)) return `${at} removes the factory tag ${JSON.stringify(tag)}`;
    if (!isTrackerTag(tag) || !has(labels, tag)) return `${at} removes tag ${JSON.stringify(tag)}, which is not on the tracker write allowlist`;
  }
  return undefined;
}

/** The context-bound rules of the tags, area path and relation paths; the value already passed its AdoValue rule. */
function trackerProblem(route: AdoRoute, target: AdoPatchPath, value: unknown, context: AdoBodyContext, at: string): string | undefined {
  switch (target.configured) {
    case 'tags': {
      const writes = context.trackerWrites;
      // The engine's marker and progress tag writes keep the TEXT rule alone; a tracker PATCH's tag edit is trackerTagEditProblem's.
      if (!writes || route.method !== 'POST') return undefined;
      // A new item carries allowlisted tags only.
      for (const tag of (value as string).split(';').map((t) => t.trim())) {
        if (!isTrackerTag(tag)) return `${at} has a refused tag ${JSON.stringify(tag)}`;
        if (!writes.labels.includes(tag)) return `${at} tag ${JSON.stringify(tag)} is not on the tracker write allowlist`;
      }
      return undefined;
    }
    case 'areaPath': {
      const parts = (value as string).split('\\');
      if (!context.project || parts[0].toLowerCase() !== context.project.toLowerCase()) return `${at} is not the forge project's area path`;
      return parts.some((p) => p.trim() === '') ? `${at} has an empty area name` : undefined;
    }
    case 'relation': {
      const prefix = `https://dev.azure.com/${encodeURIComponent(context.org ?? '')}/_apis/wit/workItems/`.toLowerCase();
      return context.org && (value as { url: string }).url.toLowerCase().startsWith(prefix) ? undefined : `${at}.url is not a work item of the forge org`;
    }
    default:
      return undefined;
  }
}

/**
 * The typed validator hook for the invoke guard (PR 5): the first reason the
 * parsed `--in-file` JSON is refused for `route`, or undefined when every key
 * and value is allowed. `kind: 'none'` takes no `--in-file` at all
 * (body === undefined). `context` adds the config-bound rules (the guard
 * always passes the run's progress states and columns).
 */
export function validateAdoBody(route: AdoRoute, body: unknown, context: AdoBodyContext = {}): string | undefined {
  const shape = route.body;
  if (!shape) return `${route.id} takes no body`;
  if (route.tracker && !context.trackerWrites) return `${route.id} is a tracker write (omg factory enqueue only)`;
  if (shape.kind === 'none') return body === undefined ? undefined : `${route.id} takes no body`;
  if (shape.kind === 'object') return objectProblem(body, shape, 'body');
  if (!Array.isArray(body) || body.length === 0) return 'body must be a non-empty JSON-patch array';
  const writes = context.trackerWrites;
  for (let i = 0; i < body.length; i++) {
    const at = `body[${i}]`;
    const op = body[i];
    if (!isPlainObject(op)) return `${at} must be an object`;
    const extra = Object.keys(op).find((k) => k !== 'op' && k !== 'path' && k !== 'value');
    if (extra !== undefined) return `${at}.${extra} is not allowed`;
    if (typeof op.op !== 'string' || !shape.ops.includes(op.op)) return `${at}.op must be one of ${shape.ops.join(', ')}`;
    const target = typeof op.path === 'string' ? shape.paths.find((p) => p.path.test(op.path as string)) : undefined;
    if (!target || (target.tracker && !writes)) return `${at}.path is not allowed`;
    if (target.tracker && !(isPlainObject(body[0]) && body[0].op === 'test' && body[0].path === '/rev')) return `${at}: a tracker write starts with test /rev`;
    // Enqueue never moves an item: its state and board column are the engine's progress writes.
    if (writes && (target.configured === 'states' || target.configured === 'columns')) return `${at}.path is not a tracker write`;
    // An untagged item's current tags, for trackerTagEditProblem's test op.
    const untaggedTest = writes && op.op === 'test' && target.configured === 'tags' && op.value === '';
    const problem = untaggedTest ? undefined : valueProblem(op.value, target.value, `${at}.value`);
    if (problem) return problem;
    const contextProblem = trackerProblem(route, target, op.value, context, `${at}.value`);
    if (contextProblem) return contextProblem;
    if (target.configured === 'states' && context.allowedStates && !context.allowedStates.includes(op.value as string)) {
      return `${at}.value is not a configured progress state (${context.allowedStates.join(', ') || 'none configured'})`;
    }
    if (target.configured === 'columns' && context.allowedColumns && !context.allowedColumns.includes(op.value as string)) {
      return `${at}.value is not a configured progress column (${context.allowedColumns.join(', ') || 'none configured'})`;
    }
  }
  return writes && route.method === 'PATCH' ? trackerTagEditProblem(body as Record<string, unknown>[], writes.labels) : undefined;
}
