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
export type AdoValue = {
    type: 'string';
    pattern?: RegExp;
    maxLength?: number;
} | {
    type: 'integer';
    min?: number;
} | {
    const: string | number | boolean;
} | {
    enum: readonly (string | number)[];
} | {
    type: 'array';
    minItems: number;
    maxItems: number;
    items: AdoObjectBody;
} | {
    type: 'object';
    shape: AdoObjectBody;
};
/** A JSON object: only `keys`, all of `required`, and every present key's value matching `values[key]`. */
export interface AdoObjectBody {
    kind: 'object';
    keys: readonly string[];
    required: readonly string[];
    /** One rule per key in `keys` (routes.test.ts holds that). */
    values: Readonly<Record<string, AdoValue>>;
}
/** `--in-file` body shape of a write route. */
export type AdoBody = {
    kind: 'none';
} | AdoObjectBody
/** RFC 6902 JSON-patch array: only these ops, only paths matching one pattern, each with its value rule. */
 | {
    kind: 'json-patch';
    ops: readonly string[];
    paths: readonly AdoPatchPath[];
};
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
/** The two relations enqueue writes (shipyard-factory design §3.3, §5): parent and predecessor, as tracker.ts reads them. */
export declare const ADO_TRACKER_RELATIONS: readonly ["System.LinkTypes.Hierarchy-Reverse", "System.LinkTypes.Dependency-Reverse"];
export declare const ADO_ROUTES: readonly AdoRoute[];
/**
 * The writes the factory may make, listed by hand so a new write route needs
 * a deliberate edit here too (routes.test.ts: every non-GET route is listed,
 * every listed tuple has a route). Merges, pushes, ref updates and branch
 * policy edits are never on it.
 */
export declare const ADO_WRITE_ALLOWLIST: ReadonlyArray<readonly [area: string, resource: string, method: Exclude<AdoHttpMethod, 'GET'>]>;
/** The route for an `(area, resource, httpMethod)` tuple; undefined = refused. Names compare case-insensitively, as az does. */
export declare function findAdoRoute(area: string, resource: string, method: string): AdoRoute | undefined;
export declare function adoRouteById(id: string): AdoRoute;
/**
 * The typed validator hook for the invoke guard (PR 5): the first reason the
 * parsed `--in-file` JSON is refused for `route`, or undefined when every key
 * and value is allowed. `kind: 'none'` takes no `--in-file` at all
 * (body === undefined). `context` adds the config-bound rules (the guard
 * always passes the run's progress states and columns).
 */
export declare function validateAdoBody(route: AdoRoute, body: unknown, context?: AdoBodyContext): string | undefined;
//# sourceMappingURL=routes.d.ts.map