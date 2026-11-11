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

import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { WORKTREE_TEAM } from '../../copilot-run/job.js';
import { isLocalBranchName, LOCAL_REMOTE, readMirrorRef } from '../../forge/local/index.js';
import type { Forge } from '../../forge/types.js';
import { TRUSTED_READ_ENV, type Exec } from '../../ship/exec.js';
import { getWorktreePath } from '../../team/git-worktree.js';
import { factoryGuardExec, hardenedGitExec } from './exec.js';
import { localRemoteMismatch } from './forge-roots.js';
import { currentBytes, defaultLedgerDir, EngineLedger, emptyHooksDir, ledgerFilePath, sha256 } from './ledger.js';
import { checkoutWorker, FACTORY_CHECKOUT_TEAM } from './prepare.js';
import { acquireFactoryOwner, acquireFactoryRepoOwnerForRun, factoryCancelPath, factoryStatePath, FactoryStateError, readFactoryState, runSlug, verifyFactoryIntegrity, FactoryBusyError, type HeldOwner, type OwnerDeps } from './state.js';
import { claimBusyMessage, factoryClaimHolder, removeFactoryClaim } from './claims.js';
import { cleanHeldFactoryRun, type LaneProcessRecord, type LaneProcessState } from './clean.js';

const HEX40 = /^[0-9a-f]{40}$/;

/**
 * True when a ledger an earlier reset moved aside (`<ledger>.reset-<stamp>`)
 * records exactly `bytes` as the run state: that reset stopped between
 * moving the ledger and moving the state.
 */
function asideRecords(ledgerFile: string, statePath: string, bytes: Buffer | null): boolean {
  if (bytes === null) return false;
  const dir = dirname(ledgerFile);
  const prefix = `${basename(ledgerFile)}.reset-`;
  if (!existsSync(dir)) return false;
  const want = sha256(bytes);
  return readdirSync(dir).filter((n) => n.startsWith(prefix)).some((n) => {
    try {
      const data = JSON.parse(readFileSync(join(dir, n), 'utf8')) as { files?: Record<string, { sha256?: unknown }> };
      return data.files?.[resolve(statePath)]?.sha256 === want;
    } catch {
      return false;
    }
  });
}

/** A `factory/cancelled/<slug>-*` branch of the mirror already at `sha` (loose or packed), if any. */
function keptBranchAt(mirror: string, slug: string, sha: string): string | undefined {
  const prefix = `factory/cancelled/${slug}-`;
  const names = new Set<string>();
  const loose = join(mirror, 'refs', 'heads', 'factory', 'cancelled');
  if (existsSync(loose)) for (const n of readdirSync(loose)) names.add(`factory/cancelled/${n}`);
  const packed = join(mirror, 'packed-refs');
  if (existsSync(packed)) {
    for (const line of readFileSync(packed, 'utf8').split(/\r?\n/)) {
      const m = /^[0-9a-f]{40} refs\/heads\/(\S+)$/.exec(line);
      if (m) names.add(m[1]);
    }
  }
  return [...names].filter((n) => n.startsWith(prefix) && isLocalBranchName(n)).sort().find((n) => {
    try { return readMirrorRef(mirror, n) === sha; } catch { return false; }
  });
}

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
  const ledgerFile = ledgerFilePath(ledgerDir, o.root, o.issue);
  const bytes = currentBytes(statePath);
  const own = ledger.tracks(statePath) ? ledger.matches(statePath, bytes) : asideRecords(ledgerFile, statePath, bytes);
  if (!own) {
    throw new FactoryStateError(`the factory run state for issue #${o.issue} is not the engine's last write (${ledger.file}); nothing is reset`);
  }
  const now = o.now ?? new Date().toISOString();
  // Busy (exit 6) before any git or forge operation: a live engine in this checkout (reset closes the PR and renames
  // the mirror branch), a claim on the item that another clone holds, then a live engine on this issue.
  const repoOwner = o.repoOwner ?? acquireFactoryRepoOwnerForRun(o.root, o.issue, () => now, o.owner);
  const releaseRepoOwner = () => { if (!o.repoOwner) repoOwner.release(); };
  let owner: ReturnType<typeof acquireFactoryOwner>;
  try {
    const claim = o.claimRepo ? factoryClaimHolder(ledgerDir, o.claimRepo, o.root, o.issue, o.owner) : null;
    if (claim) throw new FactoryBusyError(claimBusyMessage(o.issue, claim));
    owner = acquireFactoryOwner(o.root, o.issue, now, o.owner);
  } catch (error) {
    releaseRepoOwner();
    throw error;
  }
  try {
    const worktrees = () => [
      ...[...new Set(state.lanes.map((l) => l.jobId).filter((id): id is string => Boolean(id)))].map((id) => getWorktreePath(o.root, WORKTREE_TEAM, id)),
      getWorktreePath(o.root, FACTORY_CHECKOUT_TEAM, checkoutWorker(o.issue)),
    ].filter((p) => existsSync(p));
    // F59: a cancel mid-lane leaves the lane's partial edits. The run is cancelled and this reset holds it, so they
    // go with the engine's own worktrees (never the main checkout); a worktree holding commits is still kept.
    const result: Partial<FactoryResetResult> = {};
    if (worktrees().length > 0) {
      // Busy while a lane may still run; a lane worktree with tamper evidence is kept (clean --discard removes it).
      const cleaned = cleanHeldFactoryRun({
        root: o.root, issue: o.issue, exec: o.exec, ledgerDir, now, discard: true, keepTamperEvidence: true, rerun: `omg factory run reset ${o.issue}`,
        ...(o.owner ? { owner: o.owner } : {}), ...(o.processState ? { processState: o.processState } : {}), ...(o.laneStopped ? { laneStopped: true } : {}),
      }, state);
      if (cleaned.removed.length > 0) result.removedWorktrees = cleaned.removed;
      if (cleaned.acknowledged) result.acknowledgedLanes = cleaned.acknowledged;
      if (cleaned.kept.length > 0) {
        const tamper = cleaned.kept.filter((k) => k.reason.startsWith('tamper_evidence'));
        const work = cleaned.kept.filter((k) => !k.reason.startsWith('tamper_evidence'));
        const parts = [
          ...(work.length > 0 ? [`worktrees that hold unpushed commits or other work: ${work.map((k) => `${k.worktree} (${k.reason})`).join('; ')} (reset gives up uncommitted lane changes, never commits that no base or mirror branch holds)`] : []),
          ...(tamper.length > 0 ? [`worktrees kept as tamper evidence: ${tamper.map((k) => `${k.worktree} (${k.reason})`).join('; ')}`] : []),
        ];
        throw new FactoryStateError(`the cancelled run for issue #${o.issue} still has ${parts.join('; and ')}; nothing was reset`);
      }
    }
    const left = worktrees();
    if (left.length > 0) throw new FactoryStateError(`the cancelled run for issue #${o.issue} still has worktrees (${left.join(', ')}); nothing was reset`);

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
      // A reset that stopped after its keep push left that branch: reuse it rather than keep the sha twice.
      const kept = keptBranchAt(mirror, runSlug(o.issue), sha) ?? `factory/cancelled/${runSlug(o.issue)}-${stamp.toLowerCase()}`;
      if (readMirrorRef(mirror, kept) !== sha) git(['push', LOCAL_REMOTE, `${sha}:refs/heads/${kept}`]);
      git(['push', LOCAL_REMOTE, `--force-with-lease=refs/heads/${state.branch}:${sha}`, `:refs/heads/${state.branch}`]);
      result.keptBranch = kept;
    }

    // The ledger first: a stop after it leaves the state, which a rerun of reset recognizes by the aside (asideRecords);
    // the state first would leave a ledger record of a missing state, which the engine reads as tampering.
    if (existsSync(ledgerFile)) renameSync(ledgerFile, `${ledgerFile}.reset-${stamp}`);
    rmSync(factoryCancelPath(o.root, o.issue), { force: true });
    const movedTo = `${statePath}.reset-${stamp}`;
    renameSync(statePath, movedTo);
    // The PR is closed and the state moved aside: the reset is done, so a claim that cannot go now is a warning, never a throw.
    if (o.claimRepo) {
      try {
        removeFactoryClaim(ledgerDir, o.claimRepo, o.root, o.issue, { onlyRoot: true, ...(o.owner ? { deps: o.owner } : {}) });
      } catch (error) {
        if (!(error instanceof FactoryBusyError)) throw error;
        result.claimKept = error.message;
      }
    }
    return { ...result, stateMovedTo: movedTo };
  } finally {
    owner.release();
    releaseRepoOwner();
  }
}
