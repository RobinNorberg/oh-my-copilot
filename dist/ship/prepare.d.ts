/**
 * `omg ship prepare`: the mechanical steps between an approved verdict and
 * the CI gate, in a fixed order:
 *   preflight (on the run's PR branch, containing the reviewed sha, clean,
 *   no merge / rebase / cherry-pick / revert in progress) -> remote check
 *   (the remote is the PR's repository) -> fetch (refs/remotes/origin/<base>
 *   must equal GitHub's base sha) -> merge that sha in (--no-ff, never
 *   rebase; never a ref name a local tag could shadow) -> checks
 *   (ship.prepare.checks, else the tsc / lint / targeted tests the repository
 *   has) -> inventory regeneration as the LAST commit (when the repository
 *   has the generator) -> optional plain push.
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
    /** Run the checks (default true); false is `--no-checks`. */
    checks?: boolean;
    /**
     * ship.prepare.checks, each argv resolved by the caller (resolveLocalGateArgv:
     * no shell, never a .cmd/.bat): they run instead of the built-in tsc /
     * eslint / vitest / generator checks. Undefined = the built-ins the
     * checkout has (detectPrepareChecks). The inventory step is separate.
     */
    commands?: readonly PrepareCommand[];
    /** Runs `commands`: the caller's raw Exec (the ship and factory guards allow only the built-in shapes). Default: exec. */
    commandExec?: Exec;
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
/** A ship.prepare.checks argv, resolved to what runs or why it cannot start. */
export type PrepareCommand = {
    argv: readonly string[];
} & ({
    exe: string;
    args: string[];
} | {
    missing: string;
});
/** The step a configured check that cannot start fails: a config problem for a human, not a fix lane. */
export declare const PREPARE_CONFIG_STEP = "checks-config";
export declare const TSC_SCRIPT = "node_modules/typescript/bin/tsc";
export declare const ESLINT_SCRIPT = "node_modules/eslint/bin/eslint.js";
export declare const VITEST_SCRIPT = "node_modules/vitest/vitest.mjs";
export interface DetectedPrepareChecks {
    /** tsconfig.json and the typescript package. */
    tsc: boolean;
    /** The eslint package and an eslint config. */
    lint: boolean;
    /** The vitest package (the tests mapped from the diff). */
    tests: boolean;
    /** scripts/generate-inventory-graph.mjs. */
    inventory: boolean;
}
/**
 * The built-in checks a checkout has (ship.prepare.checks unset): each runs
 * only when the repository has its tool, so a repository without this one's
 * tooling runs none of it. `npm test`-style gates are the local gate's job.
 */
export declare function detectPrepareChecks(exists: (relPath: string) => boolean): DetectedPrepareChecks;
/** What prepare runs, one line per check (`omg factory check`); [] = none. */
export declare function describePrepareChecks(configured: readonly (readonly string[])[] | undefined, exists: (relPath: string) => boolean): string[];
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