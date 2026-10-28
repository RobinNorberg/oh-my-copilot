/**
 * Where a factory run's plan comes from (design §3, forges §5): a trusted
 * `omg-plan:` line, else an `Acceptance criteria` heading in the issue body.
 * Shared by the engine and `omg factory check` so the two cannot drift;
 * engine.ts re-exports these names.
 */
/** Comment authors whose `omg-plan:` line is read (GitHub authorAssociation). */
export declare const TRUSTED_PLAN_AUTHORS: readonly string[];
export declare const PLAN_LINK: RegExp;
export declare const ACCEPTANCE: RegExp;
export interface IssueComment {
    body?: unknown;
    authorAssociation?: unknown;
    author?: unknown;
}
/**
 * Whether the issue's author is an OWNER, MEMBER or COLLABORATOR. `gh issue
 * view --json` has no authorAssociation for the issue itself, so: the author
 * owns the repository (the issue URL's owner), or a comment by the same login
 * carries a trusted association (it is per user and repository). Unknown is
 * untrusted.
 */
export declare function issueAuthorTrusted(v: {
    author?: unknown;
    url?: unknown;
    comments?: unknown;
}): boolean;
/**
 * The issue body's `omg-plan:` line when its author is trusted
 * (issueAuthorTrusted), then the newest comment carrying one by an OWNER,
 * MEMBER or COLLABORATOR (anyone else could redirect the plan).
 */
export declare function findPlanLink(body: string, comments?: ReadonlyArray<IssueComment>, bodyAuthorTrusted?: boolean): string | undefined;
export declare function hasAcceptanceCriteria(body: string): boolean;
//# sourceMappingURL=plan-rules.d.ts.map