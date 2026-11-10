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

import { existsSync } from 'fs';
import { WORKTREE_TEAM } from '../../copilot-run/job.js';
import { LOCAL_REMOTE } from '../../forge/local/index.js';
import { remoteRepoMismatch } from '../../ship/config.js';
import { TRUSTED_READ_ENV, type Exec } from '../../ship/exec.js';
import { getWorktreePath, removeWorkerWorktree } from '../../team/git-worktree.js';
import { factoryGuardExec, hardenedGitExec } from './exec.js';
import { localRemoteMismatch } from './forge-roots.js';
import { defaultLedgerDir, emptyHooksDir, EngineLedger } from './ledger.js';
import { checkoutWorker, FACTORY_CHECKOUT_TEAM, unlinkNodeModules } from './prepare.js';
import { dmtfCreationDateToTicks, getProcessStartIdentitySync, isProcessAlive } from '../../platform/process-utils.js';
import { acquireFactoryOwner, acquireFactoryRepoOwnerForRun, FactoryBusyError, factoryStatePath, FactoryStateError, readFactoryState, runRemote, updateFactoryState, verifyFactoryIntegrity, type FactoryRunState, type OwnerDeps } from './state.js';
import { removeFactoryClaim } from './claims.js';

const HEX40 = /^[0-9a-f]{40}$/;

export interface FactoryCleanResult {
  /** Worktree paths removed (with their branches). */
  removed: string[];
  /** What was kept and why (dirty, unmerged commits, ...). */
  kept: Array<{ worktree: string; reason: string }>;
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
}

export type LaneProcessRecord = NonNullable<FactoryRunState['lanes'][number]['process']>;
export type LaneProcessState = 'live' | 'dead' | 'mismatch' | 'unknown';

const UNCONFIRMED_NOTE = /not confirmed|cancel failed|may still run/;
const TAMPER_NOTE = /\btampered: |tamper check: /;

/**
 * The recorded child's state, as the engine's (defaultLaneProcessOps) but
 * synchronous: a dead pid is dead, a live pid whose start identity differs is
 * another process (mismatch, so gone), and a live pid with no identity to
 * compare is unknown.
 */
export function laneProcessState(p: LaneProcessRecord): LaneProcessState {
  if (!isProcessAlive(p.pid)) return 'dead';
  if (!p.identity) return 'unknown';
  const expected = p.identity.startsWith('dmtf:') ? dmtfCreationDateToTicks(p.identity.slice('dmtf:'.length)) : p.identity;
  if (!expected) return 'unknown';
  const current = getProcessStartIdentitySync(p.pid);
  if (current === null) return isProcessAlive(p.pid) ? 'unknown' : 'dead';
  return current === expected ? 'live' : 'mismatch';
}

/** Whether the lane's stop is unconfirmed: the structured field when the engine wrote it, else its note (older states). */
function stopUnconfirmed(lane: FactoryRunState['lanes'][number]): boolean {
  if (lane.status === 'running') return true;
  return lane.stopUnconfirmed ?? UNCONFIRMED_NOTE.test(lane.note ?? '');
}

/** Why a lane's Copilot child may still run in its worktree (its stop was never confirmed), or null; `live`: seen alive with its identity. */
function laneMayRun(lane: FactoryRunState['lanes'][number], state: (p: LaneProcessRecord) => LaneProcessState): { why: string; live: boolean } | null {
  if (!stopUnconfirmed(lane)) return null;
  const what = lane.status === 'running' ? 'it is still recorded as running' : `its stop was not confirmed (${lane.note ?? 'no note'})`;
  if (!lane.process) return { why: `${what} and no pid of its Copilot child was recorded`, live: false };
  const st = state(lane.process);
  if (st === 'dead' || st === 'mismatch') return null;
  if (st === 'live') return { why: `${what} and its Copilot child pid ${lane.process.pid} still runs (its start identity matches)`, live: true };
  return { why: `${what} and whether its Copilot child pid ${lane.process.pid} still runs cannot be told (no start identity to compare)`, live: false };
}

export function cleanFactoryRun(o: FactoryCleanOptions): FactoryCleanResult {
  const state = readFactoryState(o.root, o.issue);
  if (!state) throw new FactoryStateError(`no factory run for issue #${o.issue}`);
  if (!verifyFactoryIntegrity(state)) throw new FactoryStateError(`the factory run state for issue #${o.issue} fails its integrity check; nothing is cleaned`);
  if (state.phase !== 'merged' && state.phase !== 'cancelled') {
    throw new FactoryStateError(`the factory run for issue #${o.issue} is ${state.phase}${state.gate ? ` (awaiting-human: ${state.gate.name})` : ''}; clean removes the worktrees of a merged or cancelled run only (omg factory run cancel ${o.issue} first)`);
  }
  if (o.discard && state.phase !== 'cancelled') throw new FactoryStateError(`the factory run for issue #${o.issue} is ${state.phase}; --discard gives up uncommitted lane changes of a cancelled run only`);
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
    return cleanHeldFactoryRun(o, state);
  } finally {
    owner.release();
    repoOwner.release();
  }
}

/**
 * The body of cleanFactoryRun for a caller that already holds this
 * checkout's engine lock and the run's owner file (reset), with the run
 * state it checked.
 */
export function cleanHeldFactoryRun(o: FactoryCleanOptions, state: FactoryRunState): FactoryCleanResult {
  const acknowledged: string[] = [];
  if (o.discard) {
    // A lane that may still run keeps writing into the tree being thrown away (it could plant a link after the
    // links went): refuse before any git operation or removal, busy like a live engine.
    const processState = o.processState ?? laneProcessState;
    const rerun = o.rerun ?? `omg factory run clean ${o.issue} --discard`;
    const busy = state.lanes.flatMap((l) => {
      const worktree = l.jobId ? getWorktreePath(o.root, WORKTREE_TEAM, l.jobId) : '';
      if (!l.jobId || !existsSync(worktree)) return [];
      const may = laneMayRun(l, processState);
      return may ? [{ lane: l, worktree, ...may }] : [];
    });
    const live = busy.filter((b) => b.live);
    if (busy.length > 0 && (live.length > 0 || !o.laneStopped)) {
      const lines = busy.map((b) => {
        const look = b.lane.process
          ? `stop its Copilot process pid ${b.lane.process.pid}${b.live ? '' : ' if it still runs'}`
          : `look for Copilot CLI processes whose command line names its worktree ${b.worktree} and stop them`;
        return `lane ${b.lane.id} (${b.lane.jobId}): ${b.why}; ${look}`;
      });
      const next = live.length > 0
        ? `once it is stopped, rerun ${rerun}${live.length < busy.length ? ' --lane-stopped' : ''} (a child seen alive with its start identity always refuses)`
        : `once it is stopped, rerun ${rerun} --lane-stopped (your word that it stopped; recorded in the run history)`;
      throw new FactoryBusyError(`the cancelled run for issue #${o.issue} has a lane whose stop was not confirmed, so no worktree is discarded: ${lines.join('; ')}; ${next}`);
    }
    if (busy.length > 0) {
      // --lane-stopped: the human's word, recorded before any removal through the engine ledger (the state stays the engine's last write).
      const at = o.now ?? new Date().toISOString();
      const ledger = EngineLedger.open(o.ledgerDir ?? defaultLedgerDir(), o.root, o.issue);
      const ids = new Map(busy.map((b) => [b.lane.id, b.why]));
      updateFactoryState(o.root, o.issue, (cur) => {
        const s = cur ?? state;
        return {
          ...s,
          updatedAt: at,
          lanes: s.lanes.map((l) => (ids.has(l.id) ? { ...l, stopUnconfirmed: false, note: `the stop was confirmed by a human (--lane-stopped, ${at})` } : l)),
          history: [...s.history, ...busy.map((b) => ({ at, from: s.phase, to: s.phase, note: `lane ${b.lane.id} (${b.lane.jobId}): --lane-stopped: a human confirmed that its Copilot child stopped (${ids.get(b.lane.id)})` }))],
        };
      }, {
        verify: (bytes) => {
          if (!ledger.matches(factoryStatePath(o.root, o.issue), bytes)) {
            throw new FactoryStateError(`the factory run state for issue #${o.issue} is not the engine's last write (${ledger.file}); --lane-stopped is not recorded and nothing is discarded`);
          }
        },
        onWrite: (path, content) => ledger.record(path, content),
      });
      acknowledged.push(...busy.map((b) => b.lane.id));
    }
  }
  // A merged or cancelled run frees its claim; one this checkout left behind (a crash) goes now.
  if (o.claimRepo) removeFactoryClaim(o.ledgerDir ?? defaultLedgerDir(), o.claimRepo, o.root, o.issue, { onlyRoot: true, ...(o.owner ? { deps: o.owner } : {}) });
  // No hook or fsmonitor a lane planted runs in clean's fetch and ls-remote.
  // The local forge's fetch and ls-remote check the mirror first (its redirects, config and alternates), as the engine's do.
  const mirror = () => (state.remote === LOCAL_REMOTE ? state.repoUrl : undefined);
  const exec = factoryGuardExec(hardenedGitExec(o.exec, emptyHooksDir(o.ledgerDir ?? defaultLedgerDir()), mirror), () => [state.base]);
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
  const result: FactoryCleanResult = { removed: [], kept: [], contained, ...(acknowledged.length > 0 ? { acknowledged } : {}) };
  const tamperedJobs = new Set(o.keepTamperEvidence ? state.lanes.filter((l) => l.jobId && TAMPER_NOTE.test(l.note ?? '')).map((l) => l.jobId!) : []);
  for (const [team, worker] of targets) {
    const path = getWorktreePath(o.root, team, worker);
    const existed = existsSync(path);
    if (existed && team === WORKTREE_TEAM && tamperedJobs.has(worker)) {
      result.kept.push({ worktree: path, reason: `tamper_evidence: its lane note records tamper problems; inspect it, then omg factory run clean ${o.issue} --discard removes it` });
      continue;
    }
    // The engine's node_modules link in its prepare checkout (untracked on POSIX for a `node_modules/` ignore line).
    if (team === FACTORY_CHECKOUT_TEAM) unlinkNodeModules(o.root, path);
    try {
      removeWorkerWorktree(team, worker, o.root, { contained, ...(o.discard ? { discardChanges: true } : {}) });
      if (existed) result.removed.push(path);
    } catch (error) {
      result.kept.push({ worktree: path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
