/**
 * A run the factory stopped (cancelled, failed, or parked at a human gate)
 * whose PR a human merged later: it is recorded as `merged`, so a rerun does
 * not resume lanes (and spend requests) on finished work.
 *
 * Who records it:
 * - `omg factory run <n>` before it resumes anything (the engine: start());
 * - `omg factory run status [<n>]`, `omg factory board` and
 *   `omg factory dashboard` through recordHumanMerge below.
 *
 * The PR state comes from the forge's own read (GitHub, Azure DevOps), for the
 * run's own forge, repository and base. On the local forge the PR store is a
 * file the PR's code could write, so your base branch counts: the run is
 * merged when refs/heads/<base> contains the head the engine pushed and the
 * store still names that head (forgePrStateReader, which also names the risk
 * left). A failed read changes nothing. A closed, unmerged PR changes nothing
 * either; the caller says so. A run with a lane the engine could not check
 * (laneTrustProblem) is never read: the caller prints why.
 *
 * recordHumanMerge writes like the engine: under the run's owner file (a live
 * engine on the run: nothing is written), only when the state bytes are the
 * engine's last write (its ledger), and it records the new bytes there.
 */
import { TRUSTED_READ_ENV } from '../../ship/exec.js';
import { LOCAL_REMOTE } from '../../forge/local/mirror.js';
import { canTransition, shipStatePath, transition, updateShipState } from '../../ship/state.js';
import { currentBytes, EngineLedger } from './ledger.js';
import { replaceObjectsProblem } from './review-guard.js';
import { tamperHoldMessage } from './tamper-quarantine.js';
import { acquireFactoryOwner, factoryStatePath, FactoryBusyError, forgeResumeProblem, parseFactoryState, runKeyOf, runLabel, updateFactoryState, verifyFactoryIntegrity, } from './state.js';
const HEX40 = /^[0-9a-f]{40}$/;
/** A run a human may have merged after the factory stopped: it has a PR, is not merged, and is cancelled, failed or parked (not at a tamper park). */
export function humanMergeCandidate(s) {
    if (s.pr === undefined || s.phase === 'merged')
        return false;
    if (s.phase === 'cancelled' || s.phase === 'failed')
        return true;
    return s.gate !== undefined && !s.gate.name.endsWith('-tampered');
}
/**
 * Why a candidate's lanes keep it from a human-merge check, or null. A lane
 * the engine cancelled without a clean tamper check (`problems`, `skipped`,
 * or no record in an older state), a lane whose stop is unconfirmed, a lane
 * still `running` or a lane-unconfirmed park: such a lane may have moved your
 * base branch, so the run is not recorded as merged on any forge. The Copilot
 * coding agent runs on GitHub, not in your checkout, and is not counted.
 */
export function laneTrustProblem(s) {
    const inspect = `inspect ${s.base}`;
    for (const l of s.lanes) {
        if (l.kind === 'coding-agent')
            continue;
        if (l.stopUnconfirmed === true || l.status === 'running')
            return `lane ${l.id} may still run (its stop was not confirmed); ${inspect}`;
        if (l.status === 'cancelled' && l.tamperCheck !== 'clean')
            return `lane ${l.id} was cancelled without a clean tamper check; ${inspect}`;
    }
    if (s.gate?.name === 'lane-unconfirmed')
        return `the run is parked at lane-unconfirmed (a lane may still run); ${inspect}`;
    return null;
}
/** The state before the merge, for the history note: `cancelled`, or `awaiting-human: fix-failed`. */
export function previousStateText(s) {
    return s.gate ? `awaiting-human: ${s.gate.name}` : s.phase;
}
/** Move a candidate run to merged (also from cancelled or failed), clearing its gate, with the history note. */
export function markMergedByHuman(s, now) {
    const { gate: _gate, cancelRequested: _cancel, ...rest } = s;
    const note = `PR #${s.pr} merged by a human after ${previousStateText(s)}`;
    return { ...rest, phase: 'merged', updatedAt: now, history: [...s.history, { at: now, from: s.phase, to: 'merged', note }] };
}
/**
 * The PR state through the forge adapter, for the run's own forge and
 * repository only (`repoUrl`: the forge config's repository; another one is a
 * read error, like the engine's resume check).
 *
 * GitHub and Azure DevOps: the adapter's state; a merged PR whose base is not
 * the run's base is a read error.
 *
 * The local forge: MERGED only when your base branch contains the head the
 * engine pushed AND the PR store still names that head for the PR (state not
 * CLOSED). The store's MERGED is not required: it turns MERGED only after the
 * next run or poll syncs your base into the mirror, so it adds nothing to the
 * base check. Replace refs or grafts make every git read a lie: a read error.
 * What remains: a lane that moved your base branch in a run cancelled without
 * a clean tamper check; laneTrustProblem refuses such a run before this read.
 */
export function forgePrStateReader(forge, exec, root, repoUrl) {
    return (s) => {
        const pr = s.pr;
        const label = runLabel(runKeyOf(s));
        if (pr === undefined)
            throw new Error(`run ${label} has no PR`);
        const local = s.remote === LOCAL_REMOTE;
        if (local !== (forge.kind === 'local'))
            throw new Error(`run ${label} started on ${local ? 'the local forge' : s.forgeKind ?? 'github'}, but the forge resolves to ${forge.kind}`);
        const swapped = forgeResumeProblem(s, forge.kind, repoUrl);
        if (swapped)
            throw new Error(swapped);
        if (!local) {
            const state = forge.reviews.prHead(pr).state;
            if (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED')
                throw new Error(`PR #${pr} has an unknown state ${String(state)}`);
            if (state === 'MERGED') {
                const base = forge.reviews.viewPr(pr).baseRefName;
                if (base !== s.base)
                    throw new Error(`PR #${pr} was merged into ${base}, not the run's base ${s.base}`);
            }
            return { state };
        }
        const head = s.head ?? '';
        if (!HEX40.test(head))
            throw new Error(`run ${label} has no pushed head`);
        const replaced = replaceObjectsProblem(exec, root);
        if (replaced)
            throw new Error(replaced);
        // One read of your base tip (the engine's allowed shape): the commit checked is the commit printed.
        const t = exec('git', ['rev-parse', '--verify', `refs/heads/${s.base}`], { cwd: root, env: TRUSTED_READ_ENV });
        const baseTip = t.stdout.trim();
        if (t.status !== 0 || !HEX40.test(baseTip))
            throw new Error(`your ${s.base} could not be read (git rev-parse exit ${t.status})`);
        const r = exec('git', ['merge-base', '--is-ancestor', head, baseTip], { cwd: root, env: TRUSTED_READ_ENV });
        if (r.status !== 0 && r.status !== 1)
            throw new Error(`git merge-base --is-ancestor failed (exit ${r.status}): ${r.stderr.trim()}`);
        const v = forge.reviews.viewPr(pr);
        if (v.state === 'CLOSED')
            return { state: 'CLOSED' };
        if (r.status === 1)
            return { state: 'OPEN' };
        if (v.headRefOid !== head || v.baseRefName !== s.base)
            throw new Error(`your ${s.base} contains the pushed head ${head.slice(0, 12)}, but the local PR store names ${v.headRefOid.slice(0, 12)} into ${v.baseRefName} for PR #${pr}`);
        return { state: 'MERGED', baseTip };
    };
}
/**
 * Record one run as merged when its PR is merged on the forge; see the file
 * comment. The local checks come first, so a run that is not the engine's own
 * costs no forge read. Never throws.
 */
export function recordHumanMerge(root, key, o) {
    const unchanged = (reason) => ({ kind: 'unchanged', key, reason });
    const path = factoryStatePath(root, key);
    let s;
    try {
        const bytes = currentBytes(path);
        if (bytes === null)
            return unchanged('no run state');
        s = parseFactoryState(path, key, bytes.toString('utf8'));
        if (!humanMergeCandidate(s))
            return unchanged('not a stopped run with a PR');
        if (!verifyFactoryIntegrity(s))
            return unchanged('the run state fails its integrity check');
        const untrusted = laneTrustProblem(s);
        if (untrusted)
            return { kind: 'unchanged', key, reason: untrusted, untrusted: true };
        if (tamperHoldMessage(o.ledgerDir, root))
            return unchanged('a tamper hold is set on this checkout');
        if (!EngineLedger.open(o.ledgerDir, root, key).matches(path, bytes))
            return unchanged('the run state is not the engine\'s last write');
    }
    catch (error) {
        return unchanged(text(error));
    }
    const pr = s.pr;
    let read;
    try {
        read = o.readPrState(s);
    }
    catch (error) {
        return { kind: 'unchanged', key, reason: `PR #${pr} could not be read: ${text(error)}`, readFailed: true };
    }
    if (read.state === 'CLOSED')
        return { kind: 'closed', key, pr };
    if (read.state !== 'MERGED')
        return unchanged(`PR #${pr} is open`);
    let owner;
    try {
        owner = acquireFactoryOwner(root, key, o.now(), o.owner);
    }
    catch (error) {
        return unchanged(error instanceof FactoryBusyError ? `an engine is running the run: ${text(error)}` : text(error));
    }
    try {
        // The ledger as it is now, under the owner file: the copy read before the forge read may be stale, and record() saves the whole file.
        const ledger = EngineLedger.open(o.ledgerDir, root, key);
        const previous = previousStateText(s);
        const now = o.now();
        const written = updateFactoryState(root, key, (cur) => {
            if (!cur || !humanMergeCandidate(cur) || laneTrustProblem(cur) || cur.pr !== pr)
                throw new HumanMergeSkip('the run changed while it was read');
            return markMergedByHuman(cur, now);
        }, {
            verify: (bytes) => { if (!ledger.matches(path, bytes))
                throw new HumanMergeSkip('the run state is not the engine\'s last write'); },
            onWrite: (p, content) => ledger.record(p, content),
        });
        markShipMerged(root, pr, ledger, now);
        return { kind: 'merged', key, pr, previous, state: written, ...(read.baseTip ? { baseTip: read.baseTip } : {}) };
    }
    catch (error) {
        return unchanged(text(error));
    }
    finally {
        owner.release();
    }
}
/** Every candidate in `runs`, recorded when merged; `runs` as readRuns returns them. */
export function recordHumanMerges(root, runs, o) {
    const out = [];
    for (const [key, s] of runs)
        if (humanMergeCandidate(s))
            out.push(recordHumanMerge(root, key, o));
    return out;
}
/** One line per result worth printing: merged, closed, a failed PR read. */
export function humanMergeLines(results) {
    const lines = [];
    for (const r of results) {
        if (r.kind === 'merged')
            lines.push(`run ${runLabel(r.key)}: PR #${r.pr} was merged by a human after ${r.previous}; recorded the run as merged${r.baseTip ? ` (your ${r.state.base} at ${r.baseTip})` : ''}`);
        else if (r.kind === 'closed')
            lines.push(`run ${runLabel(r.key)}: PR #${r.pr} was closed without merging; the run stays as it is`);
        else if (r.readFailed || r.untrusted)
            lines.push(`run ${runLabel(r.key)}: not checked for a human merge: ${r.reason}`);
    }
    return lines;
}
/**
 * Ship's state for the PR follows, best effort: only when it exists, is the
 * engine's last write and may move to merged. Anything else leaves it as it is.
 */
function markShipMerged(root, pr, ledger, now) {
    const path = shipStatePath(root, pr);
    if (!ledger.tracks(path) || currentBytes(path) === null)
        return;
    try {
        updateShipState(root, pr, (cur) => {
            if (!cur || !canTransition(cur.phase, 'merged'))
                throw new HumanMergeSkip('ship state stays');
            return transition(cur, 'merged', 'merged by a human after the factory run stopped', now);
        }, {
            verify: (bytes) => { if (!ledger.matches(path, bytes))
                throw new HumanMergeSkip('ship state is not the engine\'s last write'); },
            onWrite: (p, content) => ledger.record(p, content),
        });
    }
    catch {
        // The run is recorded; ship's own state is left as it is.
    }
}
class HumanMergeSkip extends Error {
}
function text(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=human-merged.js.map