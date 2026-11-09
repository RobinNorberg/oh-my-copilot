/**
 * The team context of a factory run (night-3 goal 5): the routing owners of
 * the paths a run touches and the recent decisions, both read from the BASE
 * commit only. `readAt` is the caller's allowed read shape
 * (`git show <sha>:<path>`); it returns undefined for an absent file and
 * throws for a failed read. Nothing here touches a working tree or a PR head
 * except the one head read of the append-only check.
 */
import { type TeamRoute } from './routing.js';
export declare const TEAM_ROUTING_PATH = ".copilot/team/routing.md";
export declare const TEAM_DECISIONS_PATH = ".copilot/team/decisions.md";
/** Read `path` at one commit; undefined when the file does not exist there. */
export type ReadAt = (path: string) => string | undefined;
export interface TeamContext {
    routes: TeamRoute[];
    decisions: {
        lines: string[];
        truncated: boolean;
    };
    warnings: string[];
}
/** Repo-relative file paths mentioned in free text (a plan): a conservative `dir/file.ext` scan, capped. */
export declare function pathsInText(text: string): string[];
/** The changed paths of a unified diff (`diff --git` headers), capped. */
export declare function pathsInDiff(diff: string): string[];
/**
 * Routes for `paths` and the newest decisions, from the base commit. Returns
 * undefined when the base has neither file (or both are empty).
 */
export declare function loadTeamContext(readBase: ReadAt, paths: readonly string[], maxBytes?: number): TeamContext | undefined;
/**
 * The append-only check: the run's base commit text of decisions.md against
 * the PR head's. Returns the reason, or undefined when the head only appends.
 */
export declare function decisionsViolation(readBase: ReadAt, readHead: ReadAt): string | undefined;
export interface TeamConfig {
    /** Poll re-comments (prints) a gate parked this long; 0 = off. */
    remindAfterHours: number;
}
export declare const DEFAULT_TEAM_CONFIG: TeamConfig;
export declare class TeamConfigError extends Error {
}
/** `factory.poll.remindAfterHours` from the trusted layers (user config, then the base branch's); later layers win. */
export declare function resolveTeamConfig(layers: readonly unknown[]): TeamConfig;
//# sourceMappingURL=context.d.ts.map