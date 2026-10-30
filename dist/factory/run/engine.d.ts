/**
 * `omg factory run <issue>` engine (design §3): intake -> plan -> implement ->
 * publish -> review -> fix rounds -> prepare (ship's runPrepare in an
 * engine-owned checkout, prepare.ts) -> gates (gates-driver.ts) -> merge
 * (merge-policy.ts: a human gate, always) -> merged. A base merge that
 * conflicts outside inventory/ starts a conflict-fix lane and a real check
 * failure one ci-fix lane; both go back through publish and a new review.
 *
 * The engine owns every transition; LLM work happens only inside lanes, and a
 * lane's output is data the engine validates (design §1). Lanes never push,
 * open PRs, record verdicts or merge: the engine pushes through the factory
 * guard (exec.ts) and records verdicts in the ship state (src/ship/state.ts),
 * which stays the single source of verdicts and fix rounds.
 *
 * Threat model: every lane, write or review, may be prompt-injected through
 * the issue or PR content, and its shell can change anything it can reach
 * (repo files, `.omg/`, the common git dir, possibly the user's home). The
 * engine process is the only trusted party, so:
 * - it keeps its own record of every state file it writes and re-checks it
 *   on every reload, save and lane poll (ledger.ts): any other writer parks
 *   the run at `awaiting-human: state-tampered`;
 * - it adopts a ship verdict only when a review lane it ran carries that
 *   verdict's hash (the ship seal is recomputable by anyone);
 * - it compares the shared git state before and after EVERY lane, after a
 *   lost lane and at resume (review-guard.ts), and again before its next git
 *   command (a detached child's late edit);
 * - its own git runs without hooks or fsmonitor (exec.ts hardenedGitExec);
 * - write lanes run with a read-only git dir and never commit: the engine
 *   commits their worktree changes after the tamper check (lane-commit.ts).
 *
 * Owner overrides of the design: merge is always human (nothing here merges);
 * no budget governor, per-run limits instead (budget.ts) with a mandatory
 * per-lane AI-credit cap; manual trigger only.
 *
 * The `ci-heal` kind (self-healing CI design §5-§6), keyed `heal-<sig8>` on
 * branch `factory/heal-<sig8>`, replaces intake and plan: intake reads only
 * the repository url, and the plan is an engine-rendered template of the
 * validated diagnosis fields, fenced as untrusted lane output. It parks at
 * `awaiting-human: heal-approve` until a human runs `omg factory heal
 * approve` (factory.heal.autoImplement aside, never for regression-or-env),
 * and at `heal-diagnosis` when the sealed diagnosis fails the contract.
 * From implement on it is the issue pipeline; every lane also passes the
 * heal caps (FactoryHealStart.laneCap). Nothing here writes the known-flaky
 * list: a write lane touching it parks at protected-paths.
 *
 * Forges (factory forges design §6-§8): with an Azure DevOps `forge` every
 * tracker, PR, check and merge-command call goes through the ADO adapter,
 * built on the guarded Exec whose az guard knows the run's repository, az
 * entry and progress mapping; the state records forgeKind and a resume on
 * another forge is refused. The exact-head rules hold through
 * reviews.prHead (lastMergeSourceCommit): an ancestor of the engine's push
 * is the forge lagging (pending), anything else is head-moved-externally.
 * GitHub runs keep the gh calls unchanged.
 */
import { type Exec } from '../../ship/exec.js';
import { type AzEntry } from '../../forge/ado/az-binary.js';
import type { ForgeOptions, ResolvedForgeConfig } from '../../forge/types.js';
import { type GateConfigLoader } from './prepare.js';
import { type FactoryRunLimits } from './budget.js';
import { type LaneBackend, type LaneProcess } from './lane.js';
import { type FactoryGate, type FactoryHealRecord, type FactoryPhase, type FactoryRunKey, type FactoryRunState, type OwnerDeps } from './state.js';
/** Exit code of a run parked at a human gate other than the expected `merge` park. */
export declare const EXIT_AWAITING_HUMAN = 4;
/** Conflict-fix lanes (distinct start heads) before base conflicts park at awaiting-human: merge-conflicts. */
export declare const MAX_CONFLICT_FIX_ROUNDS = 2;
/** merge's gate read may send the run back to gates this often per invocation before awaiting-human: gates-disagree. */
export declare const MAX_MERGE_BOUNCES = 2; /** Lane waits are sliced so the cancel flag is seen within this long. */
export declare const DEFAULT_POLL_MS = 5000;
/** The review prompt's diff is cut at this many characters (copilot_run prompts are capped at 100k). */
export declare const MAX_REVIEW_DIFF_CHARS = 60000;
/** A ci-heal run's inputs (src/factory/heal/implement.ts builds them from a sealed heal signature state). */
export interface FactoryHealStart {
    sig8: string;
    /** What a new run is created from (same sig8); an existing run keeps its own sealed copy. */
    record?: FactoryHealRecord;
    /** factory.heal.autoImplement (user config only): implement without a human approval, never for regression-or-env. */
    autoImplement: boolean;
    /** This invocation is `omg factory heal approve`: a human approved the diagnosis. */
    approved?: boolean;
    /** Mandatory: the heal caps (factory.heal.dailyCredits) checked before every lane start, after the run's own. */
    laneCap: (cap: number) => HealLaneCapDecision;
}
/**
 * A heal lane cap; `settle` replaces the reservation with the lane's measured
 * credits after its confirmed end, or with 0 when it never started.
 */
export type HealLaneCapDecision = {
    ok: true;
    cap: number;
    settle?: (credits: number) => void;
} | {
    ok: false;
    reason: string;
};
export interface FactoryEngineOptions {
    /** Repository root (main checkout): state, lanes' repository, pushes. */
    root: string;
    /** The issue of an `issue` run; omitted for a ci-heal run (`heal`). */
    issue?: number;
    /** A ci-heal run, keyed `heal-<sig8>`. */
    heal?: FactoryHealStart;
    /** Raw command runner; the engine hardens its git and wraps it in the factory guard. */
    exec: Exec;
    lanes: LaneBackend;
    limits: FactoryRunLimits;
    /** Integration branch (ship.base). */
    base: string;
    dryRun?: boolean;
    now?: () => number;
    pollMs?: number;
    progressFile?: string;
    owner?: OwnerDeps;
    /** Directory of the engine ledger and its empty hooks dir, outside the repo (default: defaultLedgerDir()). */
    ledgerDir?: string;
    /** True once SIGINT / SIGTERM arrived. */
    interrupted?: () => boolean;
    warn?: (message: string) => void;
    /** Liveness and kill of a lost lane's Copilot child (default: defaultLaneProcessOps). */
    processes?: LaneProcessOps;
    /** Wait between gate polls (default: a timer). */
    sleep?: (ms: number) => Promise<void>;
    /** Ship's gate config at GitHub's base sha (default: ship's strict safety-key loader). */
    gateConfig?: GateConfigLoader;
    /**
     * The run's forge (factory forges design §3, §6), recorded in the state as
     * forgeKind. Omitted = GitHub through the gh calls, as before forges; the
     * CLI always passes it. `options` must list every untrusted root
     * (factoryForgeOptions); `entry` is the resolved az entry (default:
     * resolveAzEntry outside those roots).
     */
    forge?: FactoryForgeInput;
}
export interface FactoryForgeInput {
    config: ResolvedForgeConfig;
    options: ForgeOptions;
    entry?: AzEntry;
}
/** Re-reads of a lagging Azure DevOps PR head (an ancestor of the engine's push) before the step stops as pending. */
export declare const ADO_HEAD_LAG_POLLS = 12;
/** How the engine checks and stops a lost lane's recorded child process. */
export interface LaneProcessOps {
    /** dead or mismatch (pid reused): the child is gone; live: it still runs; unknown: cannot tell. */
    state(p: LaneProcess): Promise<'live' | 'dead' | 'mismatch' | 'unknown'>;
    /** Kill the child's process tree, only while its start identity still matches. */
    terminate(p: LaneProcess): Promise<void>;
}
/**
 * Start-identity checks from platform/process-utils.ts (PowerShell ticks on
 * Windows, /proc start time on Linux, ps on macOS). Without an identity a
 * dead pid is gone and a live one is unknown: it may be another process now,
 * so the engine never kills by bare pid.
 */
export declare const defaultLaneProcessOps: LaneProcessOps;
export interface FactoryRunOutcome {
    exitCode: number;
    phase: FactoryPhase | null;
    gate?: FactoryGate;
    state: FactoryRunState | null;
    message: string;
    /** Parked at awaiting-human: merge: the exact command a human runs (the engine never merges). */
    mergeCommand?: string;
    /** --dry-run: what the run would do next. */
    plan?: {
        next: FactoryPhase | 'awaiting-human';
        laneMaxCredits: number;
        maxRunCredits?: number;
        planSource?: string;
        reason?: string;
    };
}
/** A gh / git failure in an engine step: phase `fail`, state unchanged, exit 1; a rerun resumes at the phase. */
export declare class FactoryStepError extends Error {
    constructor(message: string);
}
/** An engine-owned state file differs from the engine's last write of it. */
export declare class StateTamperedError extends Error {
    readonly paths: string[];
    constructor(paths: string[]);
}
export { findPlanLink, hasAcceptanceCriteria, issueAuthorTrusted, TRUSTED_PLAN_AUTHORS, type IssueComment } from './plan-rules.js';
/** Untrusted text on one line: control and line-separator characters become spaces, then it is cut. */
export declare function oneLine(text: string | undefined, max?: number): string;
/** A backtick fence longer than any backtick run in `content`, so the content cannot close it. */
export declare function fenceFor(content: string): string;
/** The run's key: `heal-<sig8>` for a ci-heal run, else the issue number. */
export declare function engineRunKey(o: Pick<FactoryEngineOptions, 'issue' | 'heal'>): FactoryRunKey;
/** The command that resumes a parked run (for a ci-heal run, approve also resumes after any later gate). */
export declare const resumeCommand: (key: FactoryRunKey) => string;
/** The fixed acceptance line of every ci-heal plan (design §5). */
export declare const HEAL_ACCEPTANCE = "the failing test(s) listed in classification.json pass, and `npm test` passes";
/**
 * Why the engine's sealed copy of a ci-heal diagnosis may not become a plan,
 * or null: the same contract the lane output passed (class flaky, no fix and
 * protected paths are refused), without the bundle's citation check.
 */
export declare function healRecordProblem(h: FactoryHealRecord): string | null;
/**
 * The ci-heal plan (design §5): an engine-rendered template of the validated
 * diagnosis fields, with every lane-derived text fenced and labelled.
 */
export declare function healPlanText(h: FactoryHealRecord, base: string): string;
/** The draft PR body of a ci-heal run: the failing runs, the env diff, the signature and the diagnosis. */
export declare function healPrBody(s: FactoryRunState): string;
export declare function implementPrompt(s: FactoryRunState): string;
export declare function fixPrompt(s: FactoryRunState, round: number): string;
/** `conflicted`: the files the engine's merge left conflict markers in (conflictFixStart), else the ones prepare reported. */
export declare function conflictFixPrompt(s: FactoryRunState, conflicted?: readonly string[]): string;
export declare function ciFixPrompt(s: FactoryRunState): string;
/**
 * The review lane's prompt. `standards` (the files under docs/standards/ on
 * the base commit) switches on the two-axis review: spec and standards, each
 * finding naming its axis. Without them the prompt is the single-axis one.
 */
export declare function reviewPrompt(s: FactoryRunState, head: string, diff: string, standards?: readonly string[]): string;
/**
 * Run (or resume) the factory run for one issue. Refuses without a resolved
 * per-lane credit cap, and while another live engine owns the issue.
 */
export declare function runFactoryEngine(o: FactoryEngineOptions): Promise<FactoryRunOutcome>;
//# sourceMappingURL=engine.d.ts.map