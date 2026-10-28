/**
 * `omg port drive`: the automated upstream port (design
 * .omc/plans/2026-10-27-self-driving-gates-ports-design.md §6). Phases, in order:
 *
 *   preflight  clean tree, `port/upstream-<short>` branch (created or resumed)
 *   apply      scripts/port/upstream-drift.mjs --apply --head <sha>, then --report
 *   junk       unstage known upstream junk (`.gjc/` session dirs) if any slipped in
 *   delta      --package-delta: `version` ignored, every other key needs a human
 *   reconcile  conflicts: write the brief; run a credit-capped write lane only
 *              with `reconcileLane`, else stop `blocked` naming the brief
 *   gates      tsc, eslint src (0 errors), path gate, generator --verify, touched tests
 *   commit     the port commit, then inventory regeneration as the LAST commit
 *   pr         plain push to `port/upstream-<short>`, draft PR to the base; a human merges
 *
 * A human decision stops the run `blocked` with the next command
 * (`--continue` after the human staged their fix). The engine never force
 * pushes, never resets, never merges and never commits unresolved conflicts.
 *
 * Upstream text reaches the reconcile lane and the lane shares the common git
 * dir, so every host git command runs through the port guard (guard.ts:
 * allowlisted shapes, no hooks, fsmonitor, pager, external diff or filter),
 * the shared git state, the main index and its flags, the content of every
 * tracked file of the main checkout and the gates' node_modules entry files
 * are snapshotted before the lane and compared after its confirmed end
 * (factory review-guard.ts, hostBaseline),
 * and the lane's tree may differ from the pre-lane index only on the
 * conflicted, non-protected paths, as regular files.
 */
import { type LaneBackend } from '../factory/run/lane.js';
import type { Exec } from '../ship/exec.js';
export declare const DRIFT_SCRIPT = "scripts/port/upstream-drift.mjs";
export declare const PORT_PHASES: readonly ["preflight", "apply", "junk", "delta", "reconcile", "gates", "commit", "pr"];
export type PortPhase = (typeof PORT_PHASES)[number];
export type PortProgressStatus = 'start' | 'ok' | 'fail' | 'blocked' | 'heartbeat' | 'done';
/** Upstream junk the port never keeps (the drift script also drops it from the range). */
export declare const JUNK_PATHS: string[];
/** Conflicts here need a human review before any PR, even with a reconcile lane (§6 human-gate table). */
export declare const HUMAN_REVIEW_PREFIXES: string[];
/**
 * Paths a reconcile lane may never change, even when conflicted, on top of
 * ship's PROTECTED_PATHS: the drift script's EXCLUDED_PATHS and SKIPPED_PATHS,
 * the gate scripts and generators the engine runs on the host, lint and test
 * config, git attributes, and the port engine and its runbook. A rule ending
 * in `*` is a prefix; any other rule names a file or a directory.
 */
export declare const LANE_FORBIDDEN_PATHS: string[];
/** The paths a reconcile lane may not change (LANE_FORBIDDEN_PATHS, protectedChanges, any `.gitattributes`). */
export declare function laneForbidden(paths: readonly string[]): string[];
export interface PackageChange {
    key: string;
    before: unknown;
    after: unknown;
    action: 'ignored' | 'human';
}
export interface ReconcileLaneOptions {
    /** Mandatory AI-credit cap of the paid lane. */
    maxCredits: number;
    timeoutMs: number;
    model?: string;
}
export interface PortDriveOptions {
    cwd: string;
    /** Upstream commit (sha or ref) to port up to. */
    head: string;
    exec: Exec;
    /** Node binary for repo scripts (default process.execPath). */
    node?: string;
    /** PR base branch (default dev). */
    base?: string;
    remote?: string;
    /** Push and open the draft PR (default true). */
    push?: boolean;
    /**
     * Resume on the port branch after a human resolved a blocked run: skips
     * apply, and the delta once it ran. After the port commit it resumes at the
     * inventory, push or PR step.
     */
    resume?: boolean;
    date?: string;
    /** The upstream head whose leak-sweep lines the human accepted (recorded in the commit, the PR and accepted-leaks.json). */
    acceptLeaks?: string;
    /** Runs the reconcile brief as a write lane; null = never start a lane. */
    reconcileLane?: ReconcileLaneOptions | null;
    lanes?: () => LaneBackend;
    /** The progress log the brief tells the lane to write to. */
    progressFile?: string;
    progress: (phase: PortPhase | 'report', status: PortProgressStatus, note: string) => void;
    log: (line: string) => void;
}
export interface PortDriveResult {
    status: 'done' | 'blocked' | 'fail';
    /** 0 done, 1 fail, 3 blocked. */
    exitCode: 0 | 1 | 3;
    message: string;
    branch: string | null;
    upstreamHead: string | null;
    blockers: string[];
    brief: string | null;
    packageDelta: PackageChange[];
    gates: string[];
    commits: string[];
    pr: string | null;
    laneCredits: number | null;
    /** Leak-sweep lines accepted with --accept-leaks (`path:line`). */
    acceptedLeaks: string[];
    next: string | null;
}
/** The runbook section the reconcile lane must honour, read from the repo so it never drifts from the runbook. */
export declare function forkFeaturesSection(cwd: string): string;
export declare function renderReconcileBrief(input: {
    cwd: string;
    base: string;
    head: string;
    conflicts: ReadonlyArray<{
        status: string;
        path: string;
    }>;
    progressFile: string;
    date: string;
}): string;
export declare function runPortDrive(opts: PortDriveOptions): Promise<PortDriveResult>;
/**
 * The node_modules files the gates run (the lane's worktree may reach them
 * through a node_modules junction): each package.json and gate entry file.
 */
export declare const GATE_ENTRY_FILES: string[];
//# sourceMappingURL=engine.d.ts.map