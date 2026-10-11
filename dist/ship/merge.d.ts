/**
 * Merge-readiness decision for `omg ship merge`. decideMerge is pure: the CLI
 * gathers the PR view, a fresh gate report, the changed files
 * (listChangedFiles) and the first-parent commits since the reviewed sha
 * with their parents (readCommitsSinceReview);
 * this module says yes or no and why.
 */
import { type Exec } from './exec.js';
import type { GateReport } from './gates.js';
import { type ShipState } from './state.js';
/**
 * The PR's changed files, computed locally between GitHub's base and head
 * shas: `git diff --name-only --no-renames -z <base>...<head>` with replace
 * refs off. `--no-renames` lists a rename as its old and new path (a rename
 * out of `.github/workflows/` still names the workflow), `-z` prints paths
 * unquoted (non-ASCII names intact), and there is no 300-file cap as with
 * `gh pr diff`. Null on any failure (fail closed).
 */
export declare function listChangedFiles(exec: Exec, cwd: string, baseSha: string, headSha: string): string[] | null;
export interface CommitParents {
    sha: string;
    parents: string[];
}
/** `git rev-list --parents` output (`<sha> <parent>...` per line); null on a malformed line. */
export declare function parseCommitParents(stdout: string): CommitParents[] | null;
/**
 * The decideMerge inputs about the commits after the reviewed sha:
 * `git rev-list --first-parent --parents <reviewed>..<head>` (null when the
 * reviewed sha is not an ancestor of the head or the list fails), the
 * second parents of the recorded housekeeping merges that are GitHub's
 * current base sha or its ancestors, and the content check of every
 * recorded one- or two-parent housekeeping commit (housekeepingContentProblem).
 * `baseSha` must be in the object store (fetched and checked against
 * GitHub); an unknown one puts nothing in baseHistory (fail closed).
 */
export declare function readCommitsSinceReview(exec: Exec, cwd: string, reviewed: string | undefined, head: string, baseSha: string, housekeeping: readonly string[]): {
    commitsSinceReview: CommitParents[] | null;
    baseHistory: Set<string>;
    housekeepingContent: Map<string, string | null>;
};
export interface PrView {
    number: number;
    state: string;
    isDraft: boolean;
    baseRefName: string;
    headRefOid: string;
}
export interface MergeInput {
    state: ShipState;
    pr: PrView;
    gate: GateReport;
    /**
     * `git rev-list --first-parent --parents <reviewed>..<head>` (newest first,
     * parseCommitParents); null when the reviewed sha is not an ancestor of the
     * head (or the range could not be listed).
     */
    commitsSinceReview: CommitParents[] | null;
    /**
     * Second parents of the housekeeping merges in commitsSinceReview that are
     * GitHub's CURRENT base sha or its ancestors (`git merge-base --is-ancestor`).
     */
    baseHistory: ReadonlySet<string>;
    /**
     * Content check of each recorded one- or two-parent housekeeping commit in
     * commitsSinceReview: null when it changes only inventory/, else why not.
     * A housekeeping commit missing from the map is refused (fail closed).
     */
    housekeepingContent: ReadonlyMap<string, string | null>;
    /** listChangedFiles(base sha, head sha); null when it could not be read (refused unless humanOverride). */
    changedFiles: string[] | null;
    /** OMG_SHIP_HUMAN=1: the owner accepts a PR that touches PROTECTED_PATHS. */
    humanOverride?: boolean;
    /** Extra protected files (the configured known-flaky file when it differs from the default). */
    extraProtected?: readonly string[];
}
/** Files and prefixes that steer the merge rule itself; a PR touching them needs the owner. */
export declare const PROTECTED_PATHS: readonly string[];
/** The changed files that hit PROTECTED_PATHS (exact file, or under a `/`-terminated prefix; case-insensitive). */
export declare function protectedChanges(changed: readonly string[], extra?: readonly string[]): string[];
export interface MergeDecision {
    ok: boolean;
    reasons: string[];
    command: string[];
}
export declare function mergeCommand(pr: number, headSha: string): string[];
export declare function decideMerge({ state, pr, gate, commitsSinceReview, baseHistory, housekeepingContent, changedFiles, humanOverride, extraProtected }: MergeInput): MergeDecision;
//# sourceMappingURL=merge.d.ts.map