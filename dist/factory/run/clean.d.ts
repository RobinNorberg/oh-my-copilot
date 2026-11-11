/**
 * `omg factory run clean <issue>`: remove the worktrees and local branches
 * the engine made for a merged or cancelled run (its lanes' copilot_run
 * worktrees and its prepare checkout), only when nothing would be lost.
 *
 * Every removal goes through removeWorkerWorktree (src/team/git-worktree.ts):
 * junctions such as a linked node_modules are unlinked before
 * `git worktree remove`, a dirty tree is kept, and a worktree or branch
 * holding a commit that neither the main checkout's HEAD nor a verified
 * remote ref (GitHub's base after a fetch, the PR branch on the run's remote, origin or the local forge's omg-local mirror) holds is
 * kept. The remote PR branch itself is never deleted. clean's own git
 * (remote check, fetch, ls-remote) runs guarded and hardened like the
 * engine's: no hooks, no fsmonitor. `discard` (a cancelled run only, dogfood
 * F59): a lane worktree's or the prepare checkout's uncommitted changes are
 * given up so the tree goes too; committed work is still kept. It refuses
 * (busy) while a lane's Copilot child may still run in its worktree (the
 * cancel was not confirmed or failed and the recorded child is not known
 * gone by pid and start identity) unless the human confirms the stop
 * (`laneStopped`, recorded in the run history; a child seen alive with its
 * identity still refuses), and a reset (`keepTamperEvidence`) keeps a
 * worktree whose lane note records tamper problems; an explicit
 * `clean --discard` removes it.
 */
import { type Exec } from '../../ship/exec.js';
import { type FactoryRunState, type OwnerDeps } from './state.js';
export interface FactoryCleanResult {
    /** Worktree paths removed (with their branches). */
    removed: string[];
    /** What was kept and why (dirty, unmerged commits, ...). */
    kept: Array<{
        worktree: string;
        reason: string;
    }>;
    /** Commits whose history counted as kept: the fetched base and the PR branch on the run's remote. */
    contained: string[];
    /** Lanes whose stop a human confirmed with --lane-stopped (recorded in the run history). */
    acknowledged?: string[];
}
export interface FactoryCleanOptions {
    root: string;
    issue: number;
    /** The plain command runner; clean wraps it like the engine does (factoryGuardExec around hardenedGitExec). */
    exec: Exec;
    /** Engine ledger directory, home of the empty hooks directory (default: defaultLedgerDir()). */
    ledgerDir?: string;
    now?: string;
    owner?: OwnerDeps;
    /** The repository the cross-clone claim is keyed on (factoryClaimRepo); clean deletes this checkout's claim on the run. */
    claimRepo?: string | null;
    /** Give up uncommitted changes in the run's worktrees (a cancelled run only; F59). */
    discard?: boolean;
    /** With discard (reset): keep a worktree whose lane note records tamper problems. */
    keepTamperEvidence?: boolean;
    /** Whether a recorded lane child still runs, by pid and start identity (default: laneProcessState). */
    processState?: (p: LaneProcessRecord) => LaneProcessState;
    /**
     * With discard: the human's word that the Copilot child of every lane whose
     * stop was not confirmed has stopped (`--lane-stopped`); recorded in the run
     * history. A child seen alive with its recorded start identity still refuses.
     */
    laneStopped?: boolean;
    /** The command a refusal tells the human to rerun (default: `omg factory run clean <issue> --discard`). */
    rerun?: string;
    /** The private layout: also remove the repository's private store seed once no other run dir is left (`--seed`). */
    seed?: boolean;
    /** The trusted user config factory.run.workDir is read from (default: userConfigLayers().trustedUser); tests pass one. */
    runUserConfig?: unknown;
    /** The private layout: recorded gate processes under a dir that still run (default: gate-procs.ts liveGateProcs); tests pass one. */
    liveGateProcs?: (dir: string) => number[];
    /** The local forge's state dir, home of the local gate's process records (default: getGlobalOmcStatePath('forge'), the engine's default). */
    localGateStateDir?: string;
}
export type LaneProcessRecord = NonNullable<FactoryRunState['lanes'][number]['process']>;
export type LaneProcessState = 'live' | 'dead' | 'mismatch' | 'unknown';
/**
 * The recorded child's state, as the engine's (defaultLaneProcessOps) but
 * synchronous: a dead pid is dead, a live pid whose start identity differs is
 * another process (mismatch, so gone), and a live pid with no identity to
 * compare is unknown.
 */
export declare function laneProcessState(p: LaneProcessRecord): LaneProcessState;
export declare function cleanFactoryRun(o: FactoryCleanOptions): FactoryCleanResult;
/**
 * The body of cleanFactoryRun for a caller that already holds this
 * checkout's engine lock and the run's owner file (reset), with the run
 * state it checked.
 */
export declare function cleanHeldFactoryRun(o: FactoryCleanOptions, state: FactoryRunState): FactoryCleanResult;
//# sourceMappingURL=clean.d.ts.map