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
 * engine's: no hooks, no fsmonitor.
 */

import { existsSync } from 'fs';
import { WORKTREE_TEAM } from '../../copilot-run/job.js';
import { LOCAL_REMOTE } from '../../forge/local/index.js';
import { remoteRepoMismatch } from '../../ship/config.js';
import { TRUSTED_READ_ENV, type Exec } from '../../ship/exec.js';
import { getWorktreePath, removeWorkerWorktree } from '../../team/git-worktree.js';
import { factoryGuardExec, hardenedGitExec } from './exec.js';
import { localRemoteMismatch } from './forge-roots.js';
import { defaultLedgerDir, emptyHooksDir } from './ledger.js';
import { checkoutWorker, FACTORY_CHECKOUT_TEAM, unlinkNodeModules } from './prepare.js';
import { acquireFactoryOwner, acquireFactoryRepoOwnerForRun, FactoryStateError, readFactoryState, runRemote, verifyFactoryIntegrity, type OwnerDeps } from './state.js';
import { removeFactoryClaim } from './claims.js';

const HEX40 = /^[0-9a-f]{40}$/;

export interface FactoryCleanResult {
  /** Worktree paths removed (with their branches). */
  removed: string[];
  /** What was kept and why (dirty, unmerged commits, ...). */
  kept: Array<{ worktree: string; reason: string }>;
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
}

export function cleanFactoryRun(o: FactoryCleanOptions): FactoryCleanResult {
  const state = readFactoryState(o.root, o.issue);
  if (!state) throw new FactoryStateError(`no factory run for issue #${o.issue}`);
  if (!verifyFactoryIntegrity(state)) throw new FactoryStateError(`the factory run state for issue #${o.issue} fails its integrity check; nothing is cleaned`);
  if (state.phase !== 'merged' && state.phase !== 'cancelled') {
    throw new FactoryStateError(`the factory run for issue #${o.issue} is ${state.phase}${state.gate ? ` (awaiting-human: ${state.gate.name})` : ''}; clean removes the worktrees of a merged or cancelled run only (omg factory run cancel ${o.issue} first)`);
  }
  // A live engine in this checkout refuses (busy, exit 6) before any git operation: clean removes worktrees and
  // branches in the shared git dir, which that engine's tamper check would see. Then the issue's own owner file.
  const now = o.now ?? new Date().toISOString();
  const repoOwner = acquireFactoryRepoOwnerForRun(o.root, o.issue, () => now, o.owner);
  let owner: ReturnType<typeof acquireFactoryOwner>;
  try {
    owner = acquireFactoryOwner(o.root, o.issue, now, o.owner);
  } catch (error) {
    repoOwner.release();
    throw error;
  }
  try {
    // A merged or cancelled run frees its claim; one this checkout left behind (a crash) goes now.
    if (o.claimRepo) removeFactoryClaim(o.ledgerDir ?? defaultLedgerDir(), o.claimRepo, o.root, o.issue, { onlyRoot: true, ...(o.owner ? { deps: o.owner } : {}) });
    // No hook or fsmonitor a lane planted runs in clean's fetch and ls-remote.
    const exec = factoryGuardExec(hardenedGitExec(o.exec, emptyHooksDir(o.ledgerDir ?? defaultLedgerDir())), () => [state.base]);
    const git = (args: string[]) => exec('git', args, { cwd: o.root, env: TRUSTED_READ_ENV });
    const remote = runRemote(state);
    const mismatch = state.remote === LOCAL_REMOTE ? localRemoteMismatch(exec, o.root, state.repoUrl) : remoteRepoMismatch(exec, o.root, remote, state.repoUrl);
    if (mismatch) throw new FactoryStateError(`refusing to fetch: ${mismatch}`);
    const fetched = git(['fetch', remote, state.base]);
    if (fetched.status !== 0) throw new FactoryStateError(`git fetch ${remote} ${state.base} failed: ${fetched.stderr.trim().split('\n')[0]}`);
    const contained: string[] = [];
    const base = git(['rev-parse', '--verify', `refs/remotes/${remote}/${state.base}`]).stdout.trim();
    if (HEX40.test(base)) contained.push(base);
    const listed = exec('git', ['ls-remote', remote, `refs/heads/${state.branch}`], { cwd: o.root });
    const pushed = listed.status === 0 ? listed.stdout.trim().split(/\s+/)[0] : '';
    if (HEX40.test(pushed) && git(['cat-file', '-e', `${pushed}^{commit}`]).status === 0) contained.push(pushed);

    const targets: Array<[string, string]> = [
      ...[...new Set(state.lanes.map((l) => l.jobId).filter((id): id is string => Boolean(id)))].map((id): [string, string] => [WORKTREE_TEAM, id]),
      [FACTORY_CHECKOUT_TEAM, checkoutWorker(o.issue)],
    ];
    const result: FactoryCleanResult = { removed: [], kept: [], contained };
    for (const [team, worker] of targets) {
      const path = getWorktreePath(o.root, team, worker);
      const existed = existsSync(path);
      // The engine's node_modules link in its prepare checkout (untracked on POSIX for a `node_modules/` ignore line).
      if (team === FACTORY_CHECKOUT_TEAM) unlinkNodeModules(o.root, path);
      try {
        removeWorkerWorktree(team, worker, o.root, { contained });
        if (existed) result.removed.push(path);
      } catch (error) {
        result.kept.push({ worktree: path, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  } finally {
    owner.release();
    repoOwner.release();
  }
}
