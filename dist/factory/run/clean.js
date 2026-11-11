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
import { existsSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { WORKTREE_TEAM } from '../../copilot-run/job.js';
import { LOCAL_REMOTE } from '../../forge/local/index.js';
import { remoteRepoMismatch, userConfigLayers } from '../../ship/config.js';
import { TRUSTED_READ_ENV } from '../../ship/exec.js';
import { getWorktreePath, recordedWorktreeGitLinks, removeWorkerWorktree } from '../../team/git-worktree.js';
import { factoryGuardExec, hardenedGitExec } from './exec.js';
import { localRemoteMismatch } from './forge-roots.js';
import { defaultLedgerDir, emptyHooksDir, EngineLedger } from './ledger.js';
import { checkoutWorker, FACTORY_CHECKOUT_TEAM, unlinkNodeModules } from './prepare.js';
import { dmtfCreationDateToTicks, getProcessStartIdentitySync, isProcessAlive } from '../../platform/process-utils.js';
import { acquireFactoryOwner, acquireFactoryRepoOwnerForRun, describeOwner, FactoryBusyError, factoryStatePath, FactoryStateError, ownerHolding, readFactoryState, runRemote, SCAN_WAIT_MS, tryScanLock, unreadableOwnerMessage, updateFactoryState, runSlug, verifyFactoryIntegrity, } from './state.js';
import { removeFactoryClaim } from './claims.js';
import { gateProcsPath, liveGateProcs } from './gate-procs.js';
import { getGlobalOmcStatePath } from '../../utils/paths.js';
import { removeRunDir } from './private-store.js';
import { expectedPrivateLayout, withImportLock } from './private-run.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
const HEX40 = /^[0-9a-f]{40}$/;
const UNCONFIRMED_NOTE = /not confirmed|cancel failed|may still run/;
const TAMPER_NOTE = /\btampered: |tamper check: /;
/**
 * The recorded child's state, as the engine's (defaultLaneProcessOps) but
 * synchronous: a dead pid is dead, a live pid whose start identity differs is
 * another process (mismatch, so gone), and a live pid with no identity to
 * compare is unknown.
 */
export function laneProcessState(p) {
    if (!isProcessAlive(p.pid))
        return 'dead';
    if (!p.identity)
        return 'unknown';
    const expected = p.identity.startsWith('dmtf:') ? dmtfCreationDateToTicks(p.identity.slice('dmtf:'.length)) : p.identity;
    if (!expected)
        return 'unknown';
    // The engine's async reader falls back to CIM and wmic: a busy machine must not turn a live child into "unknown".
    const current = getProcessStartIdentitySync(p.pid, { fallbacks: true });
    if (current === null)
        return isProcessAlive(p.pid) ? 'unknown' : 'dead';
    return current === expected ? 'live' : 'mismatch';
}
/** Whether the lane's stop is unconfirmed: the structured field when the engine wrote it, else its note (older states). */
function stopUnconfirmed(lane) {
    if (lane.status === 'running')
        return true;
    return lane.stopUnconfirmed ?? UNCONFIRMED_NOTE.test(lane.note ?? '');
}
/** Why a lane's Copilot child may still run in its worktree (its stop was never confirmed), or null; `live`: seen alive with its identity. */
function laneMayRun(lane, state) {
    if (!stopUnconfirmed(lane))
        return null;
    const what = lane.status === 'running' ? 'it is still recorded as running' : `its stop was not confirmed (${lane.note ?? 'no note'})`;
    if (!lane.process)
        return { why: `${what} and no pid of its Copilot child was recorded`, live: false };
    const st = state(lane.process);
    if (st === 'dead' || st === 'mismatch')
        return null;
    if (st === 'live')
        return { why: `${what} and its Copilot child pid ${lane.process.pid} still runs (its start identity matches)`, live: true };
    return { why: `${what} and whether its Copilot child pid ${lane.process.pid} still runs cannot be told (no start identity to compare)`, live: false };
}
/**
 * A private-layout run's dir (private-run.ts): removed with removeRunDir
 * (links such as the prepare checkout's node_modules junction unlinked first,
 * never followed; the dir moved aside first, so a process still in it makes
 * the removal refuse), only when no lane's Copilot child may still run there
 * and, for a reset, no lane note records tamper evidence. With `seed`, the
 * repository's seed goes too once no other run dir is left next to it.
 */
/** The local gate's process record dir for the run's checkout head (the local forge only): it lives under the forge state dir, outside the run dir. */
function localGateProcDirs(o, state) {
    const head = state.checkoutHead ?? state.head;
    if (state.remote !== LOCAL_REMOTE || !head || !HEX40.test(head))
        return [];
    return [dirname(gateProcsPath(o.localGateStateDir ?? getGlobalOmcStatePath('forge'), o.root, head))];
}
function cleanPrivateRun(o, state, result) {
    // The dir is recomputed from the trusted config and must equal the record before anything is removed (review-483 M5).
    let layout;
    try {
        let userConfig = o.runUserConfig;
        if (userConfig === undefined) {
            try {
                userConfig = userConfigLayers().trustedUser;
            }
            catch {
                userConfig = null;
            }
        }
        layout = expectedPrivateLayout(state, { root: o.root, omcRoot: getOmcRoot(o.root), slug: runSlug(o.issue), userConfig });
    }
    catch (error) {
        result.kept.push({ worktree: resolve(state.privateDir), reason: error instanceof Error ? error.message : String(error) });
        return;
    }
    const { runDir, repoDir, work } = layout;
    if (existsSync(runDir)) {
        const may = state.lanes.map((l) => ({ l, may: laneMayRun(l, o.processState ?? laneProcessState) })).find((x) => x.may !== null);
        if (may && (may.may.live || !o.laneStopped)) {
            result.kept.push({ worktree: runDir, reason: `lane_may_run: lane ${may.l.id}: ${may.may.why}; stop it, then rerun ${o.rerun ?? `omg factory run clean ${o.issue}`}${may.may.live ? '' : ' --discard --lane-stopped'}` });
            return;
        }
        // B2: a live engine of this run holds <run>/run.lock; its dir is never removed under it (an unreadable lock counts as held).
        const lockHolder = ownerHolding(layout.lock, o.owner);
        if (lockHolder !== null) {
            result.kept.push({ worktree: runDir, reason: `run_live: ${lockHolder === 'unreadable' ? unreadableOwnerMessage(layout.lock) : `the run's engine holds ${layout.lock} (${describeOwner(lockHolder)}); omg factory run cancel ${o.issue} stops it, then rerun ${o.rerun ?? `omg factory run clean ${o.issue}`}`}` });
            return;
        }
        // A prepare check's or the local gate's leftover process must be gone before its dir is removed (review-483 I.4, 483b L-a):
        // the prepare checks record under <run>/gates, the local gate under the forge state dir for the checkout's head.
        const gateDirs = [join(runDir, 'gates', 'prepare-procs'), ...localGateProcDirs(o, state)];
        let gateLive;
        try {
            gateLive = [...new Set(gateDirs.flatMap((d) => (o.liveGateProcs ?? liveGateProcs)(d)))];
        }
        catch (error) {
            result.kept.push({ worktree: runDir, reason: `gate_may_run: ${error instanceof Error ? error.message : String(error)}; then rerun ${o.rerun ?? `omg factory run clean ${o.issue}`}` });
            return;
        }
        if (gateLive.length > 0) {
            result.kept.push({ worktree: runDir, reason: `gate_may_run: process(es) a prepare check or the local gate started in the run dir still run (pid ${gateLive.join(', ')}); stop them (Task Manager, or kill -9 ${gateLive.join(' ')}), then rerun ${o.rerun ?? `omg factory run clean ${o.issue}`}` });
            return;
        }
        if (o.keepTamperEvidence && state.lanes.some((l) => TAMPER_NOTE.test(l.note ?? ''))) {
            result.kept.push({ worktree: runDir, reason: `tamper_evidence: a lane note records tamper problems; inspect ${runDir}, then omg factory run clean ${o.issue} --discard removes it` });
            return;
        }
        try {
            removeRunDir(runDir, work);
            result.removed.push(runDir);
        }
        catch (error) {
            result.kept.push({ worktree: runDir, reason: error instanceof Error ? error.message : String(error) });
            return;
        }
    }
    if (!o.seed || !existsSync(repoDir))
        return;
    const seed = join(repoDir, 'seed.git');
    try {
        // Under the import lock: another checkout's run start (seed fetch, clone) on this repository waits (review-483 L5).
        withImportLock(o.root, layout, `clean:${o.issue}`, () => {
            let others = [];
            try {
                others = readdirSync(repoDir).filter((n) => n !== 'seed.git' && n !== 'import.lock' && !n.startsWith('.trash-'));
            }
            catch { /* no repository dir */ }
            if (others.length > 0) {
                result.kept.push({ worktree: seed, reason: `seed_in_use: other runs of this repository still have their dirs (${others.join(', ')}) next to it` });
                return;
            }
            if (existsSync(seed)) {
                removeRunDir(seed, work);
                result.removed.push(seed);
            }
        });
    }
    catch (error) {
        result.kept.push({ worktree: seed, reason: error instanceof Error ? error.message : String(error) });
    }
}
export function cleanFactoryRun(o) {
    const state = readFactoryState(o.root, o.issue);
    if (!state)
        throw new FactoryStateError(`no factory run for issue #${o.issue}`);
    if (!verifyFactoryIntegrity(state))
        throw new FactoryStateError(`the factory run state for issue #${o.issue} fails its integrity check; nothing is cleaned`);
    if (state.phase !== 'merged' && state.phase !== 'cancelled') {
        throw new FactoryStateError(`the factory run for issue #${o.issue} is ${state.phase}${state.gate ? ` (awaiting-human: ${state.gate.name})` : ''}; clean removes the worktrees of a merged or cancelled run only (omg factory run cancel ${o.issue} first)`);
    }
    if (o.discard && state.phase !== 'cancelled')
        throw new FactoryStateError(`the factory run for issue #${o.issue} is ${state.phase}; --discard gives up uncommitted lane changes of a cancelled run only`);
    // A live engine in this checkout refuses (busy, exit 6) before any git operation: clean removes worktrees and
    // branches in the shared git dir, which that engine's tamper check would see. Then the issue's own owner file.
    const now = o.now ?? new Date().toISOString();
    // B2: a private-layout run's worktrees are outside this checkout, so its clean takes the engine lock as `scan` (a
    // shared engine still refuses it; private parallel runs keep running, and the fetch below is serialised with their
    // imports through the import lock tryScanLock adds while a slot is held). A shared run's clean is as before.
    let repoOwner;
    if (state.layout === 2 && state.privateDir) {
        const scan = tryScanLock(o.root, now, o.owner, SCAN_WAIT_MS);
        if (scan instanceof FactoryBusyError)
            throw scan;
        repoOwner = scan;
    }
    else
        repoOwner = acquireFactoryRepoOwnerForRun(o.root, o.issue, () => now, o.owner);
    let owner;
    try {
        owner = acquireFactoryOwner(o.root, o.issue, now, o.owner);
    }
    catch (error) {
        repoOwner.release();
        throw error;
    }
    try {
        return cleanHeldFactoryRun(o, state);
    }
    finally {
        owner.release();
        repoOwner.release();
    }
}
/**
 * The body of cleanFactoryRun for a caller that already holds this
 * checkout's engine lock and the run's owner file (reset), with the run
 * state it checked.
 */
export function cleanHeldFactoryRun(o, state) {
    const acknowledged = [];
    if (o.discard) {
        // A lane that may still run keeps writing into the tree being thrown away (it could plant a link after the
        // links went): refuse before any git operation or removal, busy like a live engine.
        const processState = o.processState ?? laneProcessState;
        const rerun = o.rerun ?? `omg factory run clean ${o.issue} --discard`;
        const busy = state.lanes.flatMap((l) => {
            const worktree = l.jobId ? getWorktreePath(o.root, WORKTREE_TEAM, l.jobId) : '';
            if (!l.jobId || !existsSync(worktree))
                return [];
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
                    // Appended, never replaced: tamper text in the note keeps the worktree as evidence for reset (keepTamperEvidence).
                    lanes: s.lanes.map((l) => (ids.has(l.id) ? { ...l, stopUnconfirmed: false, note: `${l.note ? `${l.note}; ` : ''}the stop was confirmed by a human (--lane-stopped, ${at})` } : l)),
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
    if (o.claimRepo)
        removeFactoryClaim(o.ledgerDir ?? defaultLedgerDir(), o.claimRepo, o.root, o.issue, { onlyRoot: true, ...(o.owner ? { deps: o.owner } : {}) });
    // No hook or fsmonitor a lane planted runs in clean's fetch and ls-remote.
    // The local forge's fetch and ls-remote check the mirror first (its redirects, config and alternates), as the engine's do.
    const mirror = () => (state.remote === LOCAL_REMOTE ? state.repoUrl : undefined);
    const exec = factoryGuardExec(hardenedGitExec(o.exec, emptyHooksDir(o.ledgerDir ?? defaultLedgerDir()), mirror), () => [state.base]);
    const git = (args) => exec('git', args, { cwd: o.root, env: TRUSTED_READ_ENV });
    const remote = runRemote(state);
    const mismatch = state.remote === LOCAL_REMOTE ? localRemoteMismatch(exec, o.root, state.repoUrl) : remoteRepoMismatch(exec, o.root, remote, state.repoUrl);
    if (mismatch)
        throw new FactoryStateError(`refusing to fetch: ${mismatch}`);
    const fetched = git(['fetch', remote, state.base]);
    if (fetched.status !== 0)
        throw new FactoryStateError(`git fetch ${remote} ${state.base} failed: ${fetched.stderr.trim().split('\n')[0]}`);
    const contained = [];
    const base = git(['rev-parse', '--verify', `refs/remotes/${remote}/${state.base}`]).stdout.trim();
    if (HEX40.test(base))
        contained.push(base);
    const listed = exec('git', ['ls-remote', remote, `refs/heads/${state.branch}`], { cwd: o.root });
    const pushed = listed.status === 0 ? listed.stdout.trim().split(/\s+/)[0] : '';
    if (HEX40.test(pushed) && git(['cat-file', '-e', `${pushed}^{commit}`]).status === 0)
        contained.push(pushed);
    const targets = [
        ...[...new Set(state.lanes.map((l) => l.jobId).filter((id) => Boolean(id)))].map((id) => [WORKTREE_TEAM, id]),
        [FACTORY_CHECKOUT_TEAM, checkoutWorker(o.issue)],
    ];
    const result = { removed: [], kept: [], contained, ...(acknowledged.length > 0 ? { acknowledged } : {}) };
    const tamperedJobs = new Set(o.keepTamperEvidence ? state.lanes.filter((l) => l.jobId && TAMPER_NOTE.test(l.note ?? '')).map((l) => l.jobId) : []);
    // The private layout: the run's whole dir (private repository, lane worktrees, prepare checkout, job dirs) under the work root.
    if (state.layout === 2 && state.privateDir)
        cleanPrivateRun(o, state, result);
    for (const [team, worker] of targets) {
        const path = getWorktreePath(o.root, team, worker);
        const existed = existsSync(path);
        if (!existed && state.layout === 2)
            continue;
        if (existed && team === WORKTREE_TEAM && tamperedJobs.has(worker)) {
            result.kept.push({ worktree: path, reason: `tamper_evidence: its lane note records tamper problems; inspect it, then omg factory run clean ${o.issue} --discard removes it` });
            continue;
        }
        // The engine's node_modules link in its prepare checkout (untracked on POSIX for a `node_modules/` ignore line).
        if (team === FACTORY_CHECKOUT_TEAM)
            unlinkNodeModules(o.root, path);
        try {
            // Through the git links recorded at its creation when this process has them: removal never discovers a rewritten `.git`.
            const gitLinks = recordedWorktreeGitLinks(path);
            removeWorkerWorktree(team, worker, o.root, { contained, ...(gitLinks ? { gitLinks } : {}), ...(o.discard ? { discardChanges: true } : {}) });
            if (existed)
                result.removed.push(path);
        }
        catch (error) {
            result.kept.push({ worktree: path, reason: error instanceof Error ? error.message : String(error) });
        }
    }
    return result;
}
//# sourceMappingURL=clean.js.map