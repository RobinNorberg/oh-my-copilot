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
 * gone), and a reset (`keepTamperEvidence`) keeps a worktree whose lane note
 * records tamper problems; an explicit `clean --discard` removes it.
 */
import { existsSync } from 'fs';
import { WORKTREE_TEAM } from '../../copilot-run/job.js';
import { LOCAL_REMOTE } from '../../forge/local/index.js';
import { remoteRepoMismatch } from '../../ship/config.js';
import { TRUSTED_READ_ENV } from '../../ship/exec.js';
import { getWorktreePath, removeWorkerWorktree } from '../../team/git-worktree.js';
import { factoryGuardExec, hardenedGitExec } from './exec.js';
import { localRemoteMismatch } from './forge-roots.js';
import { defaultLedgerDir, emptyHooksDir } from './ledger.js';
import { checkoutWorker, FACTORY_CHECKOUT_TEAM, unlinkNodeModules } from './prepare.js';
import { isProcessAlive } from '../../platform/process-utils.js';
import { acquireFactoryOwner, acquireFactoryRepoOwnerForRun, FactoryBusyError, FactoryStateError, readFactoryState, runRemote, verifyFactoryIntegrity } from './state.js';
import { removeFactoryClaim } from './claims.js';
const HEX40 = /^[0-9a-f]{40}$/;
const UNCONFIRMED_NOTE = /not confirmed|cancel failed|may still run/;
const TAMPER_NOTE = /\btampered: |tamper check: /;
/** Why a lane's Copilot child may still run in its worktree (its stop was never confirmed), or null. */
function laneMayRun(lane, alive) {
    if (lane.status === 'running')
        return 'it is still recorded as running';
    if (!UNCONFIRMED_NOTE.test(lane.note ?? ''))
        return null;
    if (!lane.process)
        return `its stop was not confirmed (${lane.note}) and no pid of its Copilot child was recorded`;
    return alive(lane.process.pid) ? `its stop was not confirmed (${lane.note}) and its Copilot child pid ${lane.process.pid} still runs` : null;
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
    const repoOwner = acquireFactoryRepoOwnerForRun(o.root, o.issue, () => now, o.owner);
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
    if (o.discard) {
        // A lane that may still run keeps writing into the tree being thrown away (it could plant a link after the
        // links went): refuse before any git operation or removal, busy like a live engine.
        const alive = o.processAlive ?? isProcessAlive;
        const busy = state.lanes.flatMap((l) => {
            if (!l.jobId || !existsSync(getWorktreePath(o.root, WORKTREE_TEAM, l.jobId)))
                return [];
            const why = laneMayRun(l, alive);
            return why ? [`lane ${l.id} (${l.jobId}): ${why}`] : [];
        });
        if (busy.length > 0) {
            throw new FactoryBusyError(`the cancelled run for issue #${o.issue} has a lane that may still run, so no worktree is discarded: ${busy.join('; ')}; stop that Copilot process, then rerun`);
        }
    }
    // A merged or cancelled run frees its claim; one this checkout left behind (a crash) goes now.
    if (o.claimRepo)
        removeFactoryClaim(o.ledgerDir ?? defaultLedgerDir(), o.claimRepo, o.root, o.issue, { onlyRoot: true, ...(o.owner ? { deps: o.owner } : {}) });
    // No hook or fsmonitor a lane planted runs in clean's fetch and ls-remote.
    const exec = factoryGuardExec(hardenedGitExec(o.exec, emptyHooksDir(o.ledgerDir ?? defaultLedgerDir())), () => [state.base]);
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
    const result = { removed: [], kept: [], contained };
    const tamperedJobs = new Set(o.keepTamperEvidence ? state.lanes.filter((l) => l.jobId && TAMPER_NOTE.test(l.note ?? '')).map((l) => l.jobId) : []);
    for (const [team, worker] of targets) {
        const path = getWorktreePath(o.root, team, worker);
        const existed = existsSync(path);
        if (existed && team === WORKTREE_TEAM && tamperedJobs.has(worker)) {
            result.kept.push({ worktree: path, reason: `tamper_evidence: its lane note records tamper problems; inspect it, then omg factory run clean ${o.issue} --discard removes it` });
            continue;
        }
        // The engine's node_modules link in its prepare checkout (untracked on POSIX for a `node_modules/` ignore line).
        if (team === FACTORY_CHECKOUT_TEAM)
            unlinkNodeModules(o.root, path);
        try {
            removeWorkerWorktree(team, worker, o.root, { contained, ...(o.discard ? { discardChanges: true } : {}) });
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