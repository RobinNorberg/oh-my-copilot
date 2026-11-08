/**
 * `omg factory run reset <issue>` (local forge only, dogfood F38): make the
 * item of a cancelled run runnable again. Offline nothing else ever closes
 * the run's local PR or moves its branch, so without this a cancelled item
 * stays blocked for good (check: run-finished:cancelled, then pr-exists).
 *
 * Only a cancelled run whose state is still the engine's own (its integrity
 * seal and the engine ledger agree), with no live engine, and after
 * `omg factory run clean` removed its worktrees. Then:
 * - the run's local PR is closed in the store (reason `cancelled`) if the
 *   cancel did not already close it;
 * - the run's mirror branch is kept as `factory/cancelled/<slug>-<stamp>`
 *   and removed from `factory/<slug>` with a lease on the sha read here, so
 *   the next run publishes a fresh branch (nothing the run made is lost);
 * - the run state and its engine ledger are moved aside (`.reset-<stamp>`)
 *   and the cancel request is removed, so the next `omg factory run <issue>`
 *   starts a new run.
 * Every git command runs guarded and hardened like the engine's.
 */

import { existsSync, renameSync, rmSync } from 'fs';
import { WORKTREE_TEAM } from '../../copilot-run/job.js';
import { LOCAL_REMOTE, readMirrorRef } from '../../forge/local/index.js';
import type { Forge } from '../../forge/types.js';
import { TRUSTED_READ_ENV, type Exec } from '../../ship/exec.js';
import { getWorktreePath } from '../../team/git-worktree.js';
import { factoryGuardExec, hardenedGitExec } from './exec.js';
import { localRemoteMismatch } from './forge-roots.js';
import { currentBytes, defaultLedgerDir, EngineLedger, emptyHooksDir, ledgerFilePath } from './ledger.js';
import { checkoutWorker, FACTORY_CHECKOUT_TEAM } from './prepare.js';
import { acquireFactoryOwner, factoryCancelPath, factoryStatePath, FactoryStateError, readFactoryState, runSlug, verifyFactoryIntegrity, type OwnerDeps } from './state.js';

const HEX40 = /^[0-9a-f]{40}$/;

export interface FactoryResetResult {
  /** The local PR this reset closed (absent: none, or the cancel already closed it). */
  closedPr?: number;
  /** Where the run's mirror branch is kept (absent: the mirror had no such branch). */
  keptBranch?: string;
  /** Where the old run state was moved. */
  stateMovedTo: string;
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
}

export function resetFactoryRun(o: FactoryResetOptions): FactoryResetResult {
  const statePath = factoryStatePath(o.root, o.issue);
  const state = readFactoryState(o.root, o.issue);
  if (!state) throw new FactoryStateError(`no factory run for issue #${o.issue}`);
  if (!verifyFactoryIntegrity(state)) throw new FactoryStateError(`the factory run state for issue #${o.issue} fails its integrity check; nothing is reset`);
  if (state.remote !== LOCAL_REMOTE || o.forge.kind !== 'local') {
    throw new FactoryStateError(`omg factory run reset is for the local forge only; the run for issue #${o.issue} is on ${state.forgeKind ?? 'github'}`);
  }
  if (state.phase !== 'cancelled') {
    throw new FactoryStateError(`the factory run for issue #${o.issue} is ${state.phase}${state.gate ? ` (awaiting-human: ${state.gate.name})` : ''}; reset starts over a cancelled run only (omg factory run cancel ${o.issue} first)`);
  }
  if (o.mirror !== state.repoUrl) throw new FactoryStateError(`the run's mirror ${state.repoUrl} is not the configured local forge mirror ${o.mirror}; nothing is reset`);
  const ledgerDir = o.ledgerDir ?? defaultLedgerDir();
  const ledger = EngineLedger.open(ledgerDir, o.root, o.issue);
  if (!ledger.tracks(statePath) || !ledger.matches(statePath, currentBytes(statePath))) {
    throw new FactoryStateError(`the factory run state for issue #${o.issue} is not the engine's last write (${ledger.file}); nothing is reset`);
  }
  const now = o.now ?? new Date().toISOString();
  // A live engine on this issue refuses here; the owner file is gone again afterwards.
  const owner = acquireFactoryOwner(o.root, o.issue, now, o.owner);
  try {
    const left = [
      ...[...new Set(state.lanes.map((l) => l.jobId).filter((id): id is string => Boolean(id)))].map((id) => getWorktreePath(o.root, WORKTREE_TEAM, id)),
      getWorktreePath(o.root, FACTORY_CHECKOUT_TEAM, checkoutWorker(o.issue)),
    ].filter((p) => existsSync(p));
    if (left.length > 0) throw new FactoryStateError(`the cancelled run for issue #${o.issue} still has worktrees (${left.join(', ')}); run omg factory run clean ${o.issue} first`);

    const result: Partial<FactoryResetResult> = {};
    if (state.pr) {
      const pr = o.forge.reviews.viewPr(state.pr);
      if (pr.state === 'OPEN') {
        o.forge.reviews.closePr!(state.pr, 'cancelled');
        result.closedPr = state.pr;
      }
    }

    const stamp = now.replace(/[:.]/g, '-');
    const mirror = state.repoUrl;
    const sha = readMirrorRef(mirror, state.branch);
    if (sha !== undefined) {
      if (!HEX40.test(sha)) throw new FactoryStateError(`the mirror branch ${state.branch} does not hold a commit sha`);
      const exec = factoryGuardExec(hardenedGitExec(o.exec, emptyHooksDir(ledgerDir), () => mirror), () => [state.base]);
      const git = (args: string[]) => {
        const r = exec('git', args, { cwd: o.root, env: TRUSTED_READ_ENV });
        if (r.status !== 0) throw new FactoryStateError(`git ${args.join(' ')} failed: ${r.stderr.trim().split('\n')[0]}`);
      };
      const mismatch = localRemoteMismatch(exec, o.root, mirror);
      if (mismatch) throw new FactoryStateError(`refusing to push: ${mismatch}`);
      const kept = `factory/cancelled/${runSlug(o.issue)}-${stamp.toLowerCase()}`;
      git(['push', LOCAL_REMOTE, `${sha}:refs/heads/${kept}`]);
      git(['push', LOCAL_REMOTE, `--force-with-lease=refs/heads/${state.branch}:${sha}`, `:refs/heads/${state.branch}`]);
      result.keptBranch = kept;
    }

    const movedTo = `${statePath}.reset-${stamp}`;
    renameSync(statePath, movedTo);
    rmSync(factoryCancelPath(o.root, o.issue), { force: true });
    const ledgerFile = ledgerFilePath(ledgerDir, o.root, o.issue);
    if (existsSync(ledgerFile)) renameSync(ledgerFile, `${ledgerFile}.reset-${stamp}`);
    return { ...result, stateMovedTo: movedTo };
  } finally {
    owner.release();
  }
}
