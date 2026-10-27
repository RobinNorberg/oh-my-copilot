/**
 * `omg factory run <issue>` engine, PR 2 scope (design §14 row 2): intake ->
 * plan -> implement -> publish -> review -> fix rounds, then a park at
 * `prepare` with a human gate (prepare, the gates driver and the human merge
 * follow in PR 3).
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
 * - its own git runs without hooks or fsmonitor (exec.ts hardenedGitExec).
 *
 * Owner overrides of the design: merge is always human (nothing here merges);
 * no budget governor, per-run limits instead (budget.ts) with a mandatory
 * per-lane AI-credit cap; manual trigger only.
 */
import { type Exec } from '../../ship/exec.js';
import { type FactoryRunLimits } from './budget.js';
import { type LaneBackend, type LaneProcess } from './lane.js';
import { type FactoryGate, type FactoryPhase, type FactoryRunState, type OwnerDeps } from './state.js';
/** Exit code of a run parked at a human gate other than the expected `prepare` park. */
export declare const EXIT_AWAITING_HUMAN = 4;
/** Lane waits are sliced so the cancel flag is seen within this long. */
export declare const DEFAULT_POLL_MS = 5000;
/** The review prompt's diff is cut at this many characters (copilot_run prompts are capped at 100k). */
export declare const MAX_REVIEW_DIFF_CHARS = 60000;
/** Comment authors whose `omg-plan:` line is read (GitHub authorAssociation). */
export declare const TRUSTED_PLAN_AUTHORS: readonly string[];
export interface FactoryEngineOptions {
    /** Repository root (main checkout): state, lanes' repository, pushes. */
    root: string;
    issue: number;
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
}
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
/** Untrusted text on one line: control and line-separator characters become spaces, then it is cut. */
export declare function oneLine(text: string | undefined, max?: number): string;
/** A backtick fence longer than any backtick run in `content`, so the content cannot close it. */
export declare function fenceFor(content: string): string;
export declare function implementPrompt(s: FactoryRunState): string;
export declare function fixPrompt(s: FactoryRunState, round: number): string;
export declare function reviewPrompt(s: FactoryRunState, head: string, diff: string): string;
/**
 * Run (or resume) the factory run for one issue. Refuses without a resolved
 * per-lane credit cap, and while another live engine owns the issue.
 */
export declare function runFactoryEngine(o: FactoryEngineOptions): Promise<FactoryRunOutcome>;
//# sourceMappingURL=engine.d.ts.map