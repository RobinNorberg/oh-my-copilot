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
 * given up so the tree goes too; committed work is still kept.
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
}
export declare function cleanFactoryRun(o: FactoryCleanOptions): FactoryCleanResult;
/**
 * The body of cleanFactoryRun for a caller that already holds this
 * checkout's engine lock and the run's owner file (reset), with the run
 * state it checked.
 */
export declare function cleanHeldFactoryRun(o: FactoryCleanOptions, state: FactoryRunState): FactoryCleanResult;
//# sourceMappingURL=clean.d.ts.map