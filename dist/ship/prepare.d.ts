/**
 * `omg ship prepare`: the mechanical steps between an approved verdict and
 * the CI gate, in a fixed order:
 *   preflight (on the run's PR branch, containing the reviewed sha, clean,
 *   no merge / rebase / cherry-pick / revert in progress) -> remote check
 *   (the remote is the PR's repository) -> fetch (refs/remotes/origin/<base>
 *   must equal GitHub's base sha) -> merge that sha in (--no-ff, never
 *   rebase; never a ref name a local tag could shadow) -> tsc / lint /
 *   targeted tests -> inventory regeneration as the LAST commit -> optional
 *   plain push.
 * Every command goes through the guarded Exec, so force pushes and rebases
 * are refused before they spawn. Engine merges and commits run with
 * `--no-verify` (pre-commit / pre-merge-commit / commit-msg hooks never shape
 * them), the index must hold no staged changes at the start, and the
 * inventory commit names `-- inventory` so a file a concurrent lane stages
 * during the checks stays out of it. `omg ship merge` re-checks the content
 * of every engine commit anyway (readCommitsSinceReview).
 */
import type { Exec } from './exec.js';
export type StepStatus = 'ok' | 'skipped' | 'failed';
export interface PrepareStep {
    name: string;
    status: StepStatus;
    detail?: string;
}
export interface PrepareOptions {
    exec: Exec;
    cwd: string;
    base: string;
    /** The ship run's PR branch: HEAD must be on it, and `push` updates exactly it. */
    branch: string;
    /** Latest verdict sha; HEAD must contain it. */
    reviewedSha: string;
    /** GitHub's base sha (baseRefOid): the fetched base must equal it, and it is what gets merged. */
    baseSha: string;
    /** The PR's repository URL on GitHub (prRepoUrl); the remote must point at it. */
    repoUrl: string | undefined;
    remote?: string;
    /** Run tsc / eslint / targeted vitest (default true). */
    checks?: boolean;
    push?: boolean;
    /** Node binary for repo scripts (default process.execPath). */
    node?: string;
    exists?: (path: string) => boolean;
}
export interface PrepareResult {
    ok: boolean;
    steps: PrepareStep[];
    /** Commits this run created (merge commit, inventory commit). */
    housekeepingCommits: string[];
    conflicts?: string[];
    blockedReason?: string;
}
export declare const INVENTORY_DIR = "inventory";
export declare const INVENTORY_SCRIPT = "scripts/generate-inventory-graph.mjs";
export declare const INVENTORY_COMMIT_MESSAGE = "chore(inventory): regenerate inventory graph baseline";
/**
 * Tests to run for a diff: changed test files, plus `X.test.ts` beside or in
 * `__tests__/` next to each changed `src/**\/X.ts`, plus the skills suite when
 * skills/ changed. Only files that exist are returned (sorted, unique).
 */
export declare function selectTargetedTests(changed: readonly string[], exists: (relPath: string) => boolean): string[];
/** Generator verifications to run when their inputs changed. */
export declare function selectGeneratorChecks(changed: readonly string[]): string[][];
export declare function runPrepare(opts: PrepareOptions): PrepareResult;
//# sourceMappingURL=prepare.d.ts.map