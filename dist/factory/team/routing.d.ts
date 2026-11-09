/**
 * `.copilot/team/routing.md` (night-3 goal 5): a markdown table
 * `| path glob | role | owner | handle |` that says who owns which paths.
 *
 * Trust: the file is read ONLY from the base commit (context.ts), never from
 * a working tree or a lane's PR head, because lanes are untrusted. Parsing is
 * strict: a bad row is a warning and is dropped. The owner name becomes an
 * `owner:<x>` label or an assignee argument, so it is validated against
 * OWNER_RE here and never taken from issue text.
 */
/** The file is ignored (with a warning) above this size. */
export declare const MAX_ROUTING_BYTES: number;
export declare const MAX_ROUTES = 200;
export interface TeamRoute {
    glob: string;
    /** Worker role name (`executor`, `writer`, ...); absent for `-`. */
    role?: string;
    owner: string;
    /** `@login` or `@org/team`; absent for `-`. */
    handle?: string;
}
/** An owner name: lowercase, safe as a label suffix and as an assignee argument. */
export declare const OWNER_RE: RegExp;
export declare const isOwnerName: (value: unknown) => value is string;
/** Parse the table; prose and other lines are ignored. Never throws. */
export declare function parseRouting(text: string): {
    routes: TeamRoute[];
    warnings: string[];
};
/**
 * The routes for `paths`: per path the FIRST matching row in file order,
 * de-duplicated, in path order. No paths means the catch-all rows (`**`).
 */
export declare function routeFor(routes: readonly TeamRoute[], paths: readonly string[]): TeamRoute[];
//# sourceMappingURL=routing.d.ts.map