/**
 * `omg factory run clean <issue>`: remove the worktrees and local branches
 * the engine made for a merged or cancelled run (its lanes' copilot_run
 * worktrees and its prepare checkout), only when nothing would be lost.
 *
 * Every removal goes through removeWorkerWorktree (src/team/git-worktree.ts):
 * junctions such as a linked node_modules are unlinked before
 * `git worktree remove`, a dirty tree is kept, and a worktree or branch
 * holding a commit that neither the main checkout's HEAD nor a verified
 * remote ref (GitHub's base after a fetch, the PR branch on origin) holds is
 * kept. The remote PR branch itself is never deleted. clean's own git
 * (remote check, fetch, ls-remote) runs guarded and hardened like the
 * engine's: no hooks, no fsmonitor.
 */
import { type Exec } from '../../ship/exec.js';
import { type OwnerDeps } from './state.js';
export interface FactoryCleanResult {
    /** Worktree paths removed (with their branches). */
    removed: string[];
    /** What was kept and why (dirty, unmerged commits, ...). */
    kept: Array<{
        worktree: string;
        reason: string;
    }>;
    /** Commits whose history counted as kept: the fetched base and the PR branch on origin. */
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
}
export declare function cleanFactoryRun(o: FactoryCleanOptions): FactoryCleanResult;
//# sourceMappingURL=clean.d.ts.map