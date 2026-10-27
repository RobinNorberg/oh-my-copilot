/**
 * Persisted `omg ship` run state: `.omg/state/ship/<pr>.json`, written
 * atomically under the repo's file lock so a run survives restarts and two
 * processes never interleave updates.
 *
 * Phases: review (awaiting the first independent verdict) -> fix (changes
 * requested; a fresh agent fixes, then the reviewer re-verifies) -> prepare
 * (approved; mechanical housekeeping) -> gates (CI watch) -> ready -> merged.
 * blocked is entered when the fix-round budget is spent or prepare hits a
 * conflict it may not resolve.
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync, ensureDirSync } from '../lib/atomic-write.js';
import { lockPathFor, withFileLockSync } from '../lib/file-lock.js';
import { getOmcRoot } from '../lib/worktree-paths.js';
const TRANSITIONS = {
    review: ['fix', 'prepare', 'blocked'],
    fix: ['fix', 'prepare', 'blocked'],
    prepare: ['prepare', 'gates', 'fix', 'blocked'],
    gates: ['gates', 'ready', 'prepare', 'fix', 'blocked'],
    ready: ['ready', 'gates', 'prepare', 'fix', 'merged', 'blocked'],
    merged: [],
    blocked: [],
};
export class ShipStateError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ShipStateError';
    }
}
export function canTransition(from, to) {
    return TRANSITIONS[from].includes(to);
}
/** Move to `to`, appending history; throws ShipStateError on an illegal transition. */
export function transition(state, to, note, now) {
    if (!canTransition(state.phase, to)) {
        throw new ShipStateError(`illegal ship transition ${state.phase} -> ${to} for PR #${state.pr}`);
    }
    return { ...state, phase: to, updatedAt: now, history: [...state.history, { at: now, from: state.phase, to, note }] };
}
export function createShipState(input, now) {
    return {
        version: 1,
        pr: input.pr,
        base: input.base,
        branch: input.branch,
        implementer: input.implementer,
        phase: 'review',
        fixRounds: 0,
        maxFixRounds: input.maxFixRounds,
        verdicts: [],
        housekeepingCommits: [],
        reruns: {},
        history: [{ at: now, from: null, to: 'review', note: `implementer ${input.implementer}` }],
        createdAt: now,
        updatedAt: now,
    };
}
function sameIdentity(a, b) {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}
/**
 * Record an independent verdict. approve -> prepare; changes-requested ->
 * fix, or blocked once fixRounds would exceed maxFixRounds.
 */
export function recordVerdict(state, verdict) {
    if (sameIdentity(verdict.reviewer, state.implementer)) {
        throw new ShipStateError(`reviewer ${verdict.reviewer} is the implementer; self-approval is refused`);
    }
    if (!/^[0-9a-f]{40}$/.test(verdict.sha))
        throw new ShipStateError(`verdict sha must be a full 40-hex commit id, got ${verdict.sha}`);
    const withVerdict = { ...state, verdicts: [...state.verdicts, verdict] };
    if (verdict.verdict === 'approve') {
        return transition(withVerdict, 'prepare', `approved by ${verdict.reviewer} at ${verdict.sha.slice(0, 12)}`, verdict.at);
    }
    const fixRounds = state.fixRounds + 1;
    if (fixRounds > state.maxFixRounds) {
        const blocked = transition({ ...withVerdict, fixRounds }, 'blocked', `fix round ${fixRounds} exceeds max ${state.maxFixRounds}`, verdict.at);
        return { ...blocked, blockedReason: `fix-round budget spent (${state.maxFixRounds}); escalate to a human` };
    }
    return transition({ ...withVerdict, fixRounds }, 'fix', `changes requested by ${verdict.reviewer} (round ${fixRounds}/${state.maxFixRounds})`, verdict.at);
}
export function latestVerdict(state) {
    return state.verdicts[state.verdicts.length - 1];
}
export function shipStatePath(repoRoot, pr) {
    return join(getOmcRoot(repoRoot), 'state', 'ship', `${pr}.json`);
}
/** sha256 of the state without its `integrity` field (key order as stored). */
export function computeIntegrity(state) {
    return createHash('sha256').update(JSON.stringify({ ...state, integrity: undefined })).digest('hex');
}
export function sealShipState(state) {
    return { ...state, integrity: computeIntegrity(state) };
}
/** True when the stored integrity matches the content (false for a hand-edited or unsealed state). */
export function verifyShipIntegrity(state) {
    return typeof state.integrity === 'string' && state.integrity === computeIntegrity(state);
}
const PHASES = ['review', 'fix', 'prepare', 'gates', 'ready', 'merged', 'blocked'];
const isStr = (v) => typeof v === 'string';
const isCount = (v) => Number.isInteger(v) && v >= 0;
/** Structural check of a parsed state file; returns the first problem or null. */
function shapeProblem(s) {
    if (!isStr(s.base) || !s.base)
        return 'base';
    if (s.branch !== undefined && !isStr(s.branch))
        return 'branch';
    if (!isStr(s.implementer) || !s.implementer)
        return 'implementer';
    if (!PHASES.includes(s.phase))
        return 'phase';
    if (!isCount(s.fixRounds) || !isCount(s.maxFixRounds))
        return 'fixRounds/maxFixRounds';
    if (!Array.isArray(s.verdicts) || !s.verdicts.every((v) => {
        const x = v;
        return isStr(x?.reviewer) && (x.verdict === 'approve' || x.verdict === 'changes-requested') && isStr(x.sha) && /^[0-9a-f]{40}$/.test(x.sha) && isStr(x.at);
    }))
        return 'verdicts';
    if (!Array.isArray(s.housekeepingCommits) || !s.housekeepingCommits.every((c) => isStr(c) && /^[0-9a-f]{40}$/.test(c)))
        return 'housekeepingCommits';
    if (typeof s.reruns !== 'object' || s.reruns === null || Array.isArray(s.reruns) || !Object.values(s.reruns).every(isCount))
        return 'reruns';
    if (!Array.isArray(s.history) || !s.history.every((h) => {
        const x = h;
        return isStr(x?.at) && (x.from === null || PHASES.includes(x.from)) && PHASES.includes(x.to) && isStr(x.note);
    }))
        return 'history';
    if (!isStr(s.createdAt) || !isStr(s.updatedAt))
        return 'createdAt/updatedAt';
    if (s.previousRuns !== undefined && (!Array.isArray(s.previousRuns) || !s.previousRuns.every((p) => {
        const x = p;
        return typeof p === 'object' && p !== null && !Array.isArray(p) && x.version === 1 && x.pr === s.pr
            && x.previousRuns === undefined && shapeProblem(x) === null;
    })))
        return 'previousRuns';
    if (s.integrity !== undefined && !isStr(s.integrity))
        return 'integrity';
    return null;
}
/** Read and shape-check the state file; throws ShipStateError on malformed content. */
export function readShipState(repoRoot, pr) {
    const path = shipStatePath(repoRoot, pr);
    if (!existsSync(path))
        return null;
    return parseShipState(path, pr, readFileSync(path, 'utf8'));
}
/** Parse and shape-check the bytes of a ship state file (read once by the caller). */
export function parseShipState(path, pr, raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        throw new ShipStateError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const s = parsed;
    if (typeof parsed !== 'object' || parsed === null || s.version !== 1 || s.pr !== pr)
        throw new ShipStateError(`${path} is not a ship state for PR #${pr}`);
    const problem = shapeProblem(s);
    if (problem)
        throw new ShipStateError(`${path} is malformed (field ${problem})`);
    return parsed;
}
/**
 * Read-modify-write under the state file's lock. `mutate` receives the
 * current state (null when none) and returns the next one, which is sealed
 * with a fresh integrity hash. A stored state that fails its integrity check
 * (hand-edited) is refused unless `allowUnverified`. `repoRoot` must be a git
 * work tree: elsewhere the state root would resolve under the home directory.
 */
export function updateShipState(repoRoot, pr, mutate, options = {}) {
    if (!existsSync(join(repoRoot, '.git')))
        throw new ShipStateError(`${repoRoot} is not a git work tree; ship state lives in the repo`);
    const path = shipStatePath(repoRoot, pr);
    ensureDirSync(join(path, '..'));
    return withFileLockSync(lockPathFor(path), () => {
        const bytes = existsSync(path) ? readFileSync(path) : null;
        options.verify?.(bytes);
        const current = bytes === null ? null : parseShipState(path, pr, bytes.toString('utf8'));
        if (current && !options.allowUnverified && !verifyShipIntegrity(current)) {
            throw new ShipStateError(`${path} fails its integrity check (edited outside omg ship); an owner can replace it with OMG_SHIP_HUMAN=1 omg ship init ${pr} --force`);
        }
        const next = sealShipState(mutate(current));
        const content = JSON.stringify(next, null, 2);
        atomicWriteFileSync(path, content);
        options.onWrite?.(path, content);
        return next;
    }, { timeoutMs: 5_000 });
}
//# sourceMappingURL=state.js.map