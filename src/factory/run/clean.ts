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

import { existsSync } from 'fs';
import { WORKTREE_TEAM } from '../../copilot-run/job.js';
import { remoteRepoMismatch } from '../../ship/config.js';
import { TRUSTED_READ_ENV, type Exec } from '../../ship/exec.js';
import { getWorktreePath, removeWorkerWorktree } from '../../team/git-worktree.js';
import { factoryGuardExec, hardenedGitExec } from './exec.js';
import { defaultLedgerDir, emptyHooksDir } from './ledger.js';
import { checkoutWorker, FACTORY_CHECKOUT_TEAM } from './prepare.js';
import { acquireFactoryOwner, FactoryStateError, readFactoryState, verifyFactoryIntegrity, type OwnerDeps } from './state.js';

const HEX40 = /^[0-9a-f]{40}$/;

export interface FactoryCleanResult {
  /** Worktree paths removed (with their branches). */
  removed: string[];
  /** What was kept and why (dirty, unmerged commits, ...). */
  kept: Array<{ worktree: string; reason: string }>;
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

export function cleanFactoryRun(o: FactoryCleanOptions): FactoryCleanResult {
  const state = readFactoryState(o.root, o.issue);
  if (!state) throw new FactoryStateError(`no factory run for issue #${o.issue}`);
  if (!verifyFactoryIntegrity(state)) throw new FactoryStateError(`the factory run state for issue #${o.issue} fails its integrity check; nothing is cleaned`);
  if (state.phase !== 'merged' && state.phase !== 'cancelled') {
    throw new FactoryStateError(`the factory run for issue #${o.issue} is ${state.phase}${state.gate ? ` (awaiting-human: ${state.gate.name})` : ''}; clean removes the worktrees of a merged or cancelled run only (omg factory run cancel ${o.issue} first)`);
  }
  // A live engine on this issue refuses here; the owner file is gone again afterwards.
  const owner = acquireFactoryOwner(o.root, o.issue, o.now ?? new Date().toISOString(), o.owner);
  try {
    // No hook or fsmonitor a lane planted runs in clean's fetch and ls-remote.
    const exec = factoryGuardExec(hardenedGitExec(o.exec, emptyHooksDir(o.ledgerDir ?? defaultLedgerDir())), () => [state.base]);
    const git = (args: string[]) => exec('git', args, { cwd: o.root, env: TRUSTED_READ_ENV });
    const mismatch = remoteRepoMismatch(exec, o.root, 'origin', state.repoUrl);
    if (mismatch) throw new FactoryStateError(`refusing to fetch: ${mismatch}`);
    const fetched = git(['fetch', 'origin', state.base]);
    if (fetched.status !== 0) throw new FactoryStateError(`git fetch origin ${state.base} failed: ${fetched.stderr.trim().split('\n')[0]}`);
    const contained: string[] = [];
    const base = git(['rev-parse', '--verify', `refs/remotes/origin/${state.base}`]).stdout.trim();
    if (HEX40.test(base)) contained.push(base);
    const remote = exec('git', ['ls-remote', 'origin', `refs/heads/${state.branch}`], { cwd: o.root });
    const pushed = remote.status === 0 ? remote.stdout.trim().split(/\s+/)[0] : '';
    if (HEX40.test(pushed) && git(['cat-file', '-e', `${pushed}^{commit}`]).status === 0) contained.push(pushed);

    const targets: Array<[string, string]> = [
      ...[...new Set(state.lanes.map((l) => l.jobId).filter((id): id is string => Boolean(id)))].map((id): [string, string] => [WORKTREE_TEAM, id]),
      [FACTORY_CHECKOUT_TEAM, checkoutWorker(o.issue)],
    ];
    const result: FactoryCleanResult = { removed: [], kept: [], contained };
    for (const [team, worker] of targets) {
      const path = getWorktreePath(o.root, team, worker);
      const existed = existsSync(path);
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
  }
}
