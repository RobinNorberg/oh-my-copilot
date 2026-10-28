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
export type AdoHttpMethod = 'GET' | 'POST' | 'PATCH';
/** `--in-file` body shape of a write route. */
export type AdoBody = {
    kind: 'none';
} | {
    kind: 'object';
    keys: readonly string[];
    required: readonly string[];
}
/** RFC 6902 JSON-patch array: only these ops, only paths matching one pattern. */
 | {
    kind: 'json-patch';
    ops: readonly string[];
    paths: readonly RegExp[];
};
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
}
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
//# sourceMappingURL=routes.d.ts.map