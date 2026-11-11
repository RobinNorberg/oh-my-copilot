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
import type { Exec, ExecResult } from './exec.js';
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
    /**
     * The caller already fetched `baseSha` into this checkout's object store
     * and checked it is GitHub's base (omg factory run's private layout: the
     * checkout's repository has no remote): the remote check and the fetch are
     * skipped, and `baseSha` must be a commit there.
     */
    prefetchedBase?: boolean;
    /** Run the checks (default true); false is `--no-checks`. */
    checks?: boolean;
    /**
     * ship.prepare.checks, each argv resolved by the caller (resolveLocalGateArgv:
     * no shell, never a .cmd/.bat): they run instead of the built-in tsc /
     * eslint / vitest / generator checks. Undefined = the built-ins the
     * base has (detectPrepareChecks). The inventory step is separate.
     */
    commands?: readonly PrepareCommand[];
    /** Runs `commands`: the caller's raw Exec (the ship and factory guards allow only the built-in shapes). Default: exec. */
    commandExec?: Exec;
    push?: boolean;
    /** Node binary for repo scripts (default process.execPath). */
    node?: string;
    exists?: (path: string) => boolean;
    /** Whether a repository file is committed at baseSha (default: baseFileExists through exec). */
    baseExists?: (relPath: string) => boolean;
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
/** The step a base that cannot be read fails: an engine problem, not a fix lane. */
export declare const PREPARE_DETECT_STEP = "detect";
export declare const TSC_SCRIPT = "node_modules/typescript/bin/tsc";
export declare const ESLINT_SCRIPT = "node_modules/eslint/bin/eslint.js";
export declare const VITEST_SCRIPT = "node_modules/vitest/vitest.mjs";
export interface DetectedPrepareChecks {
    /** tsconfig.json on the base and the typescript package. */
    tsc: boolean;
    /** The eslint package and an eslint config on the base. */
    lint: boolean;
    /** The vitest package (the tests mapped from the diff). */
    tests: boolean;
    /** scripts/generate-inventory-graph.mjs on the base. */
    inventory: boolean;
    /** A check the base enables whose marker file the checkout lost: why it fails (never skipped). */
    lost: Partial<Record<'tsc' | 'lint' | 'inventory', string>>;
}
/**
 * The built-in checks prepare runs (ship.prepare.checks unset). The
 * repository markers (tsconfig.json, an eslint config, the inventory
 * generator) are read from the trusted base (`baseHas`), never the PR's
 * checkout, so a PR that deletes one cannot turn its check into a skip: a
 * marker the base has and the checkout (`exists`) lost is a failure
 * (`lost`). The tool packages under node_modules come from `exists` (the
 * checkout links the root's node_modules). A repository without this one's
 * tooling runs none of it. `npm test`-style gates are the local gate's job.
 */
export declare function detectPrepareChecks(baseHas: (relPath: string) => boolean, exists?: (relPath: string) => boolean): DetectedPrepareChecks;
/**
 * Whether a repository file is committed at `commit` (readBaseFile: replace
 * refs off, any failure but "missing" throws), memoized per path.
 */
export declare function baseFileExists(exec: Exec, cwd: string, commit: string): (relPath: string) => boolean;
/** What prepare runs, one line per check (`omg factory check`, from the same base detection); [] = none. */
export declare function describePrepareChecks(configured: readonly (readonly string[])[] | undefined, baseHas: (relPath: string) => boolean, exists?: (relPath: string) => boolean): string[];
/**
 * L3: the built-in checks the base asks for that prepare would skip, and
 * what to run (`omg factory check`); [] with configured checks. The tool
 * packages come from your node_modules, so a checkout without one runs no
 * tsc, eslint or vitest.
 */
export declare function skippedPrepareChecks(configured: readonly (readonly string[])[] | undefined, baseHas: (relPath: string) => boolean, exists?: (relPath: string) => boolean): string[];
/**
 * Tests to run for a diff: changed test files, plus `X.test.ts` beside or in
 * `__tests__/` next to each changed `src/**\/X.ts`, plus the skills suite when
 * skills/ changed. Only files that exist are returned (sorted, unique).
 */
export declare function selectTargetedTests(changed: readonly string[], exists: (relPath: string) => boolean): string[];
/** Generator verifications to run when their inputs changed. */
export declare function selectGeneratorChecks(changed: readonly string[]): string[][];
/**
 * One command prepare runs from the checkout's content (the PR's own code):
 * a configured check, a built-in check, or the inventory generator. Git
 * (preflight, fetch, merge, the inventory commit) is never one of these.
 */
export interface PrepareCheckRun {
    /** The step it belongs to (a check's name, or `inventory`). */
    step: string;
    /** configured: ship.prepare.checks (the caller's commandExec); built-in / inventory: `node <script>` (exec). */
    kind: 'configured' | 'built-in' | 'inventory';
    /** The configured argv, or the built-in's `node <script> ...` argv. */
    argv: readonly string[];
    exe: string;
    args: string[];
}
/** A check's result; `notStarted` (only from runPrepareAsync's runCheck) = no verdict, prepare stops at PREPARE_SANDBOX_STEP. */
export type PrepareCheckResult = ExecResult & {
    notStarted?: string;
};
/** The step prepare fails when a check gave no verdict (the OS sandbox could not run it): an engine problem, never a fix lane. */
export declare const PREPARE_SANDBOX_STEP = "checks-sandbox";
/** ship's prepare: every check through `exec` / `commandExec`, synchronously. */
export declare function runPrepare(opts: PrepareOptions): PrepareResult;
/**
 * prepare with every check through `runCheck` (omg factory run: the OS
 * sandbox), awaited; git still runs through `exec`. A check whose result
 * carries `notStarted` stops prepare at PREPARE_SANDBOX_STEP.
 */
export declare function runPrepareAsync(opts: PrepareOptions, runCheck: (check: PrepareCheckRun) => Promise<PrepareCheckResult>): Promise<PrepareResult>;
//# sourceMappingURL=prepare.d.ts.map