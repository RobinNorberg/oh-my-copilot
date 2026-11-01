/**
 * `omg release <version>`: the release as ordered, individually re-runnable
 * phases with gates, so a release is a script run and an agent is needed only
 * to triage a failure.
 *
 *   preflight  clean tree (release prose may be uncommitted), on release/v<v>
 *              containing origin/dev, version above dev's and npm's latest,
 *              gh authenticated, no .git/index.lock, tag not on origin
 *   bump       refuse without the CHANGELOG / release-body prose, then
 *              npm version + every version stamp + prompt projections
 *   build      npm run build, git add -f dist bridge, orphan + untracked
 *              checks, import / --version / MCP start probes
 *   gates      tsc, projections, copilot generators, multi-repo path gate
 *   commit     release commit, then the inventory regenerated LAST
 *   suite      optional vitest suite (targeted, or full against a baseline),
 *              run on the committed tree: some tests (npm pack, committed
 *              docs/CLAUDE.md, inventory drift) read committed state and
 *              always fail on the uncommitted release tree. The level (and
 *              the baseline) is recorded in the state and a later run never
 *              lowers it; a suite that ran below the recorded level runs again.
 *              New failing full-suite titles are rerun alone (triage): real
 *              fails, mixed blocks, load-flaky passes with a warning and
 *              known-flaky candidates (never applied by the engine)
 *   smoke      live Tier 2 smoke, only with --live-smoke; after the suite so
 *              a red suite costs no AI credits. A green smoke is reused while
 *              HEAD's smoke inputs hash the same (lastSmoke; --force-smoke runs)
 *   pr         push, PR to dev, CI gate (ship merge rule), admin merge. When
 *              a run selects suite (or smoke) and pr, pr starts before them:
 *              the PR is pushed and its CI watched while the suite runs
 *              (execAsync), and the merge waits until the suite and smoke
 *              passed; a failure there ends the CI wait and leaves the PR
 *              open and unmerged. --to suite / smoke never pushes
 *   promote    PR dev -> main, same gate, merge
 *   tag        annotated v<v> on main's merge commit, verified, pushed (--yes)
 *   verify     tag run green, npm version / latest / provenance, GitHub Release
 *
 * State: `<state root>/release/<version>.json` records each phase result,
 * the release branch and commit, and the PR merge commits; a run without
 * --from resumes at the first phase not yet ok. Before skipping a phase (a
 * resume or --from) its recorded postconditions are re-checked, and a state
 * recorded on another branch or an unrelated HEAD is refused unless --from
 * preflight (tag / verify after the main merge need no release checkout).
 * Running a phase voids the records of every later phase, and skipping past
 * commit needs a clean working tree (HEAD is what pr pushes).
 * Every external command goes through one injectable runner (ReleaseExec).
 */
import { type LoadedShipConfig } from '../ship/config.js';
import { type Exec, type ExecOptions, type ExecResult } from '../ship/exec.js';
import { type SuiteShell, type TriageResult } from './checks.js';
import type { ReleaseProgressInput } from './progress.js';
export declare const PHASES: readonly ["preflight", "bump", "build", "gates", "commit", "suite", "smoke", "pr", "promote", "tag", "verify"];
export type PhaseId = (typeof PHASES)[number];
export declare function isPhaseId(value: string): value is PhaseId;
export type PhaseStatus = 'ok' | 'skipped' | 'fail' | 'blocked';
export interface PhaseOutcome {
    status: PhaseStatus;
    note: string;
    details?: string[];
}
export interface PhaseRecord extends PhaseOutcome {
    at: string;
}
export interface ReleaseState {
    version: 1;
    release: string;
    createdAt: string;
    updatedAt: string;
    phases: Partial<Record<PhaseId, PhaseRecord>>;
    /** Branch preflight passed on. */
    branch?: string;
    /** HEAD after the commit phase; a resume needs HEAD to descend from it. */
    headSha?: string;
    /** HEAD the suite phase ran on; a suite recorded for another HEAD does not hold. */
    suiteSha?: string;
    /** Highest --suite requested for this release (a later run without --suite keeps it, a lower one is refused). */
    suite?: SuiteLevel;
    /** Level the suite phase actually ran at on suiteSha; below `suite` the suite must run again. */
    suiteRan?: SuiteLevel;
    /** Absolute --baseline of the full suite, reused by a later run that does not pass it. */
    baseline?: string;
    devPr?: number;
    devMergeSha?: string;
    mainPr?: number;
    mainMergeSha?: string;
    tagRunId?: number;
    /** Run id -> automatic reruns spent (one per run). */
    reruns: Record<string, number>;
    /**
     * The last green live smoke, outside `phases` so voiding the smoke record
     * keeps it: a later smoke phase whose input hash (SMOKE_INPUTS at HEAD) is
     * equal reuses it instead of spending requests.
     */
    lastSmoke?: {
        inputHash: string;
        headSha: string;
        at: string;
    };
    /** Isolated reruns of the full suite's new failing titles on `sha`; a re-run suite on the same HEAD reuses them. */
    suiteTriage?: {
        sha: string;
        results: TriageResult[];
    };
}
export type SuiteLevel = 'none' | 'targeted' | 'full';
/** `suiteEnv`: the ship scrub without GIT_NO_REPLACE_OBJECTS, as in CI (the vitest suite only). */
export type ReleaseExecOptions = ExecOptions & {
    timeoutMs?: number;
    suiteEnv?: boolean;
};
/** A usage error (bad flag combination); the CLI exits 2 on it. */
export declare class UsageError extends Error {
}
export type ReleaseExec = (cmd: string, args: string[], opts?: ReleaseExecOptions) => ExecResult;
/** Files the release prose lives in; uncommitted edits to them are folded into the release commit. */
export declare const PROSE_FILES: string[];
/** An async ReleaseExec: the suite runs through it so the release PR's CI can be watched meanwhile. */
export type ReleaseExecAsync = (cmd: string, args: string[], opts?: ReleaseExecOptions) => Promise<ExecResult>;
export declare const defaultReleaseExecAsync: ReleaseExecAsync;
export declare const defaultReleaseExec: ReleaseExec;
/** The ship config for a PR's base (omg ship's loader: user config + the base's committed config). */
export type ReleaseShipConfigLoader = (ctx: {
    exec: Exec;
    root: string;
    base: string;
    baseSha?: string;
    repoUrl?: string;
}) => LoadedShipConfig;
export interface ReleaseOptions {
    version: string;
    from?: PhaseId;
    to?: PhaseId;
    dryRun?: boolean;
    /** Tag without the interactive confirmation. */
    yes?: boolean;
    /** Omitted: the level recorded for this release (none when nothing was recorded). */
    suite?: SuiteLevel;
    /** Full-suite baseline: a vitest JSON report or one `<file> > <title>` per line. */
    baseline?: string;
    liveSmoke?: boolean;
    /** Run the live smoke even when its inputs hash to the last green smoke's (implies --live-smoke). */
    forceSmoke?: boolean;
    /** Isolated reruns of each new failing full-suite title (default 3). */
    triageRuns?: number;
    /** Minutes each isolated rerun may take (default 5); a timeout is a failed run. */
    triageTimeoutMinutes?: number;
    /** Let pr run although the live smoke did not pass (it was skipped). */
    allowSkippedSmoke?: boolean;
    fixOrphans?: boolean;
    /** Total minutes the pr / promote / verify phases wait on CI per invocation. */
    timeoutMinutes?: number;
    /**
     * Drive mode (src/release/drive.ts): a CI wait that outlives --timeout, or a
     * transient GitHub error, ends the run as pending (resumed by the drive loop)
     * instead of blocked / failed; the tag phase never prompts (blocked without --yes).
     */
    drive?: boolean;
}
export interface ReleaseDeps {
    exec: ReleaseExec;
    /** The suite's vitest runs; omitted: `exec` (the suite then holds the event loop, so CI is watched only between its runs). */
    execAsync?: ReleaseExecAsync;
    /** Env for the suite's children (Windows: Git for Windows bash first on PATH), or why the suite must not start. */
    suiteShell?: () => SuiteShell;
    /** Repo root (the release checkout). */
    root: string;
    /** `<state root>` (getOmcRoot): holds release/<version>.json. */
    stateRoot: string;
    /** Node binary for repo scripts and probes. */
    node: string;
    loadShipConfig: ReleaseShipConfigLoader;
    progress: (event: ReleaseProgressInput) => void;
    log: (line: string) => void;
    confirm: (question: string) => Promise<boolean>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
}
export interface ReleaseResult {
    ok: boolean;
    version: string;
    dryRun: boolean;
    statePath: string;
    phases: Array<{
        id: PhaseId;
        status: PhaseStatus | 'planned';
        note: string;
        details?: string[];
        steps?: string[];
    }>;
    /** Drive mode only: the run stopped on a wait or a transient error, and a resume continues at `phase`. */
    pending?: {
        phase: PhaseId;
        note: string;
    };
}
/**
 * Not a result yet: a CI wait ran out of the --timeout window, or GitHub
 * answered with a transient error. `outcome` is what a run without --drive
 * records (blocked / fail, unchanged); under --drive the run ends pending.
 */
export declare class PendingError extends Error {
    readonly outcome: PhaseOutcome;
    constructor(outcome: PhaseOutcome);
}
export declare function releaseStatePath(stateRoot: string, version: string): string;
/** Known-flaky candidates of the full-suite triage; the owner approves them into .github/known-flaky-tests.json by hand. */
export declare function flakyCandidatesPath(stateRoot: string, version: string): string;
export declare function readReleaseState(stateRoot: string, version: string): ReleaseState | null;
/** Steps each phase runs, as printed by --dry-run. */
export declare function phasePlan(id: PhaseId, v: string, opts: ReleaseOptions): string[];
/** First phase to run: --from, else the first phase not yet ok / skipped in the state (runRelease re-checks the skipped ones). */
export declare function resumePoint(state: ReleaseState | null, from?: PhaseId): PhaseId | null;
export declare function runRelease(deps: ReleaseDeps, requested: ReleaseOptions): Promise<ReleaseResult>;
//# sourceMappingURL=engine.d.ts.map