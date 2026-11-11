/**
 * `omg factory run reset <issue>` (local forge only, dogfood F38): make the
 * item of a cancelled run runnable again. Offline nothing else ever closes
 * the run's local PR or moves its branch, so without this a cancelled item
 * stays blocked for good (check: run-finished:cancelled, then pr-exists).
 *
 * Only a cancelled run whose state is still the engine's own (its integrity
 * seal and the engine ledger agree), with no live engine. Then:
 * - the run's local PR is closed in the store (reason `cancelled`) if the
 *   cancel did not already close it;
 * - the run's mirror branch is kept as `factory/cancelled/<slug>-<stamp>`
 *   and removed from `factory/<slug>` with a lease on the sha read here, so
 *   the next run publishes a fresh branch (nothing the run made is lost);
 * - the run's worktrees go first (cleanHeldFactoryRun with discard: a
 *   cancel mid-lane leaves partial edits, dogfood F59); one holding commits
 *   that no base or mirror branch holds refuses the reset, and so does a lane
 *   whose stop was not confirmed (busy, unless `--lane-stopped` gives the
 *   human's word and no child is seen alive) or whose note records tamper
 *   problems (kept for inspection; `clean --discard` removes it);
 * - the run state and its engine ledger are moved aside (`.reset-<stamp>`)
 *   and the cancel request is removed, so the next `omg factory run <issue>`
 *   starts a new run.
 * Every git command runs guarded and hardened like the engine's.
 */
import type { Forge } from '../../forge/types.js';
import { type Exec } from '../../ship/exec.js';
import { type HeldOwner, type OwnerDeps } from './state.js';
import { type LaneProcessRecord, type LaneProcessState } from './clean.js';
export interface FactoryResetResult {
    /** The local PR this reset closed (absent: none, or the cancel already closed it). */
    closedPr?: number;
    /** Where the run's mirror branch is kept (absent: the mirror had no such branch). */
    keptBranch?: string;
    /** The run's worktrees this reset removed (uncommitted lane changes given up). */
    removedWorktrees?: string[];
    /** Lanes whose stop the human confirmed with --lane-stopped (recorded in the run history). */
    acknowledgedLanes?: string[];
    /** Where the old run state was moved. */
    stateMovedTo: string;
    /** Why this checkout's claim on the item was left in place after the reset (a live engine held it then). */
    claimKept?: string;
}
export interface FactoryResetOptions {
    root: string;
    issue: number;
    /** The plain command runner; reset wraps it like the engine does. */
    exec: Exec;
    /** The local forge (its PR store) and its configured mirror path (config.repo.url), which must be the run's. */
    forge: Forge;
    mirror: string;
    ledgerDir?: string;
    now?: string;
    owner?: OwnerDeps;
    /** This checkout's engine lock, already held by the caller (the CLI, before its forge-config loader); else reset takes it. */
    repoOwner?: HeldOwner;
    /** The repository the cross-clone claim is keyed on (factoryClaimRepo): a claim another clone holds refuses; this checkout's is deleted. */
    claimRepo?: string | null;
    /** Whether a recorded lane child still runs, by pid and start identity (default: laneProcessState; see cleanHeldFactoryRun). */
    processState?: (p: LaneProcessRecord) => LaneProcessState;
    /** The human's word that a lane whose stop was not confirmed has stopped (`--lane-stopped`; see cleanHeldFactoryRun). */
    laneStopped?: boolean;
}
export declare function resetFactoryRun(o: FactoryResetOptions): FactoryResetResult;
//# sourceMappingURL=reset.d.ts.map