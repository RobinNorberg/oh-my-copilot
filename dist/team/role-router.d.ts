/**
 * Intent-based role routing for team task assignment.
 *
 * Inspects task text to infer lane intent (what kind of work is needed),
 * then maps that intent to the most appropriate worker role.
 */
export type LaneIntent = 'implementation' | 'verification' | 'review' | 'debug' | 'design' | 'docs' | 'build-fix' | 'cleanup' | 'unknown';
export interface RoleRouterResult {
    role: string;
    confidence: 'high' | 'medium' | 'low';
    reason: string;
}
/** A committed path rule: files matching `glob` go to `role` (.copilot/team/routing.md, read by src/factory/team/routing.ts). */
export interface PathRoleRule {
    glob: string;
    role: string;
}
/**
 * Whether `path` (repo-relative, `/` or `\` separated) matches `glob`:
 * `**` spans any number of segments (also none), `*` and `?` stay inside one
 * segment, everything else is literal. Case-sensitive. A glob that is empty,
 * absolute, has a `..` segment, or has more than 8 wildcards matches nothing.
 */
export declare function matchPathGlob(glob: string, path: string): boolean;
/** The role of the first rule matching any of `paths` (rule order, then path order), or undefined. */
export declare function routePathsToRole(paths: readonly string[], rules: readonly PathRoleRule[]): string | undefined;
/** Role-to-keyword mapping for keyword-count scoring fallback */
export declare const ROLE_KEYWORDS: Record<string, RegExp[]>;
/**
 * Infer the lane intent from free-form task text.
 * Returns 'unknown' when no clear signal is found.
 */
export declare function inferLaneIntent(text: string): LaneIntent;
/**
 * Route a task to the most appropriate role based on intent and domain.
 *
 * Priority:
 * 1. build-fix → 'build-fixer' (high)
 * 2. debug → 'debugger' (high)
 * 3. docs → 'writer' (high)
 * 4. design → 'designer' (high)
 * 5. cleanup → 'code-simplifier' (high)
 * 6. review + security domain → 'security-reviewer' (high), else 'quality-reviewer' (high)
 * 7. verification → 'test-engineer' (high)
 * 8. implementation + security domain → fallbackRole (stays put)
 * 9. Keyword-count scoring for ambiguous intents
 * 10. Unknown → fallbackRole (low)
 */
export declare function routeTaskToRole(taskSubject: string, taskDescription: string, fallbackRole: string, 
/** Committed path rules (.copilot/team/routing.md): a rule matching one of `paths` wins before any keyword. */
pathRoutes?: {
    paths: readonly string[];
    rules: readonly PathRoleRule[];
}): RoleRouterResult;
//# sourceMappingURL=role-router.d.ts.map