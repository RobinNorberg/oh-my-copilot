/**
 * The shell ALLOWLIST of a `review` copilot_run session
 * (.omc/plans/2026-10-27-sandboxed-lanes-design.md §4.1).
 *
 * A review session may run only read-only commands: a source command from
 * {@link ALLOWLIST_SOURCES}, piped into at most two filters from
 * {@link ALLOWLIST_FILTERS}, every path argument inside the worktree. Anything
 * the parser does not know is refused, so a new spelling fails closed instead
 * of slipping past a denylist. The rules are the same on every platform (no
 * PowerShell/bash split) and run on the raw text and on
 * normalizeShellCommand's output; both must pass, and every command
 * identifier the runtime parsed must be one this parser saw.
 */
import { type SdkPermissionDecision, type SdkPermissionRequest } from './sdk-policy.js';
export declare const MAX_ALLOWLIST_COMMAND_CHARS = 2000;
export declare const ALLOWLIST_SOURCES: ReadonlySet<string>;
export declare const ALLOWLIST_FILTERS: ReadonlySet<string>;
export interface ShellAllowlistContext {
    /** The worktree: every path argument must resolve under it. */
    cwd: string;
    platform?: NodeJS.Platform;
}
/** Approve a review session's shell request only when every rule of §4.1 passes. */
export declare function reviewShellAllowlist(req: SdkPermissionRequest, ctx: ShellAllowlistContext): SdkPermissionDecision;
//# sourceMappingURL=shell-allowlist.d.ts.map