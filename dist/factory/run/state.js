/**
 * Persisted `omg factory run` state: `.omg/state/factory/run-<key>.json`,
 * where the key is the issue number, or `heal-<sig8>` for a `ci-heal` run
 * (self-healing CI design §5: the plan is the validated diagnosis),
 * written with the ship pattern (src/ship/state.ts): read-modify-write under
 * the file lock, atomic write, sha256 `integrity` seal re-checked before every
 * update. A single-runner owner file `run-<issue>.owner` keeps two engines off
 * one issue. The seal is an unkeyed sha256 that anyone can recompute, so it
 * only catches accidental edits; the engine's defence against a lane that
 * rewrites the file is its own record of the bytes it wrote (ledger.ts).
 *
 * Phases (design §3): intake -> plan -> implement -> publish -> review ->
 * (fix -> publish -> review)* -> prepare -> gates -> merge -> merged, with
 * conflict-fix (prepare's base merge conflicts) and ci-fix (a real check
 * failure) going back through publish -> review. `gate` set means
 * awaiting-human: the phase is kept, and the next `omg factory run <issue>`
 * clears the gate and re-evaluates that phase. merged, cancelled and failed
 * are terminal.
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { atomicWriteFileSync, ensureDirSync } from '../../lib/atomic-write.js';
import { lockPathFor, withFileLockSync } from '../../lib/file-lock.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { isProcessAlive } from '../../platform/process-utils.js';
export const FACTORY_PHASES = [
    'intake', 'plan', 'implement', 'publish', 'review', 'fix', 'prepare', 'conflict-fix', 'gates', 'ci-fix', 'merge', 'merged', 'cancelled', 'failed',
];
export const TERMINAL_FACTORY_PHASES = ['merged', 'cancelled', 'failed'];
export const HEAL_RUN_KEY = /^heal-[0-9a-f]{8}$/;
/** ci-heal human gates: a valid diagnosis waits for `omg factory heal approve`; an unusable one is human-only. */
export const HEAL_APPROVE_GATE = 'heal-approve';
export const HEAL_DIAGNOSIS_GATE = 'heal-diagnosis';
export function healRunKey(sig8) {
    const key = `heal-${sig8}`;
    if (!HEAL_RUN_KEY.test(key))
        throw new FactoryStateError(`signature id must be 8 hex characters, got ${JSON.stringify(sig8)}`);
    return key;
}
export class FactoryStateError extends Error {
    constructor(message) {
        super(message);
        this.name = 'FactoryStateError';
    }
}
/** The run's key: its issue number, or `heal-<sig8>` for a ci-heal run. */
export function runKeyOf(s) {
    return s.kind === 'ci-heal' ? `heal-${s.heal?.sig8 ?? ''}` : s.issue;
}
/** `issue-7` or `heal-0123abcd`: the prefix of lane ids and the prepare checkout's worker name. */
export const runSlug = (key) => (typeof key === 'number' ? `issue-${key}` : key);
/** `#7` or `heal-0123abcd`, for messages. */
export const runLabel = (key) => (typeof key === 'number' ? `#${key}` : key);
export function implementerName(key) {
    return `factory-impl-${key}`;
}
export function reviewerName(key, jobId) {
    return `factory-review-${key}-${jobId}`;
}
export function factoryBranch(key) {
    return typeof key === 'number' ? `factory/issue-${key}` : `factory/${key}`;
}
export function factoryStateDir(root) {
    return join(getOmcRoot(root), 'state', 'factory');
}
export function factoryStatePath(root, key) {
    return join(factoryStateDir(root), `run-${key}.json`);
}
export function factoryOwnerPath(root, key) {
    return join(factoryStateDir(root), `run-${key}.owner`);
}
/** `omg factory run cancel` and `omg factory heal cancel` drop this file; the engine alone writes the state file. */
export function factoryCancelPath(root, key) {
    return join(factoryStateDir(root), `run-${key}.cancel`);
}
export function factoryCancelRequested(root, key) {
    return existsSync(factoryCancelPath(root, key));
}
/** The hash a review lane record keeps of the ship verdict the engine recorded from it. */
export function shipVerdictHash(v) {
    return createHash('sha256').update(JSON.stringify([v.reviewer, v.verdict, v.sha, v.at, v.notes ?? null])).digest('hex');
}
export function createFactoryState(input, now) {
    const key = input.heal ? healRunKey(input.heal.sig8) : input.issue;
    return {
        version: 1,
        kind: input.heal ? 'ci-heal' : 'issue',
        issue: input.heal ? 0 : input.issue,
        ...(input.heal ? { heal: input.heal } : {}),
        repoUrl: input.repoUrl,
        base: input.base,
        branch: factoryBranch(key),
        phase: 'intake',
        implementer: implementerName(key),
        lanes: [],
        retries: {},
        lostStreak: {},
        elapsedMs: 0,
        ciFixRounds: 0,
        history: [{ at: now, from: null, to: 'intake', note: input.heal ? `ci-heal for CI signature ${input.heal.sig8}` : `issue #${input.issue}` }],
        createdAt: now,
        updatedAt: now,
    };
}
/** Move to `to` (clearing any gate), appending history. Terminal phases never move. */
export function moveTo(state, to, note, now) {
    if (TERMINAL_FACTORY_PHASES.includes(state.phase)) {
        throw new FactoryStateError(`factory run ${runLabel(runKeyOf(state))} is ${state.phase}; it does not move to ${to}`);
    }
    const { gate: _gate, ...rest } = state;
    return { ...rest, phase: to, updatedAt: now, history: [...state.history, { at: now, from: state.phase, to, note }] };
}
/** Park at a named human gate; the phase stays so a rerun re-evaluates it. */
export function setGate(state, name, reason, now) {
    return {
        ...state,
        gate: { name, reason, at: now },
        updatedAt: now,
        history: [...state.history, { at: now, from: state.phase, to: state.phase, note: `awaiting-human: ${name}: ${reason}` }],
    };
}
export function computeFactoryIntegrity(state) {
    return createHash('sha256').update(JSON.stringify({ ...state, integrity: undefined })).digest('hex');
}
export function verifyFactoryIntegrity(state) {
    return typeof state.integrity === 'string' && state.integrity === computeFactoryIntegrity(state);
}
/**
 * Why a resume must refuse, or null (critic amendments §A.9): a config change
 * cannot swap adapters mid-run. A state without forgeKind ran on GitHub.
 */
export function forgeResumeProblem(state, resolved) {
    const recorded = state.forgeKind ?? 'github';
    if (recorded === resolved)
        return null;
    return `factory run ${runLabel(runKeyOf(state))} started on ${recorded}, but the forge now resolves to ${resolved}; finish or cancel the run before changing factory.forge`;
}
const isStr = (v) => typeof v === 'string';
const isCount = (v) => Number.isInteger(v) && v >= 0;
function shapeProblem(s) {
    if (!isStr(s.repoUrl) || !isStr(s.base) || !s.base || !isStr(s.branch) || !s.branch)
        return 'repoUrl/base/branch';
    if (!FACTORY_PHASES.includes(s.phase))
        return 'phase';
    if (!isStr(s.implementer) || !s.implementer)
        return 'implementer';
    if (s.kind !== undefined && s.kind !== 'issue' && s.kind !== 'ci-heal')
        return 'kind';
    if (s.forgeKind !== undefined && s.forgeKind !== 'github' && s.forgeKind !== 'azure-devops')
        return 'forgeKind';
    if (s.kind === 'ci-heal') {
        const h = s.heal;
        const d = h?.diagnosis;
        if (!isStr(h?.sig8) || !Array.isArray(h.failingTests) || !Array.isArray(h.env) || typeof d !== 'object' || d === null || !isStr(d.rootCause))
            return 'heal';
    }
    if (!Array.isArray(s.lanes) || !s.lanes.every((l) => {
        const x = l;
        const sbx = x?.sandbox;
        return isStr(x?.id) && isStr(x.kind) && isStr(x.status) && isStr(x.startSha) && typeof x.maxCredits === 'number'
            && (sbx === undefined || (typeof sbx === 'object' && sbx !== null && isStr(sbx.mode) && isCount(sbx.unsandboxedCalls)));
    }))
        return 'lanes';
    if (typeof s.retries !== 'object' || s.retries === null || !Object.values(s.retries).every(isCount))
        return 'retries';
    if (typeof s.lostStreak !== 'object' || s.lostStreak === null)
        return 'lostStreak';
    if (typeof s.elapsedMs !== 'number' || !isCount(s.ciFixRounds))
        return 'elapsedMs/ciFixRounds';
    if (!Array.isArray(s.history))
        return 'history';
    if (!isStr(s.createdAt) || !isStr(s.updatedAt))
        return 'createdAt/updatedAt';
    return null;
}
/** Read and shape-check the state file; throws FactoryStateError on malformed content. */
export function readFactoryState(root, key) {
    const path = factoryStatePath(root, key);
    if (!existsSync(path))
        return null;
    return parseFactoryState(path, key, readFileSync(path, 'utf8'));
}
/** Parse and shape-check the bytes of a state file (read once by the caller). */
export function parseFactoryState(path, key, raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        throw new FactoryStateError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const s = parsed;
    if (typeof parsed !== 'object' || parsed === null || s.version !== 1 || typeof s.issue !== 'number')
        throw new FactoryStateError(`${path} is not a factory run state for ${runLabel(key)}`);
    const problem = shapeProblem(s);
    if (problem)
        throw new FactoryStateError(`${path} is malformed (field ${problem})`);
    if (runKeyOf(parsed) !== key)
        throw new FactoryStateError(`${path} is not a factory run state for ${runLabel(key)}`);
    return parsed;
}
/**
 * Read-modify-write under the state file's lock; the result is sealed. A
 * stored state failing its integrity check is refused (the run is `failed`
 * for the engine; a human replaces the file).
 */
export function updateFactoryState(root, key, mutate, options = {}) {
    if (!existsSync(join(root, '.git')))
        throw new FactoryStateError(`${root} is not a git work tree; factory run state lives in the repo`);
    const path = factoryStatePath(root, key);
    ensureDirSync(factoryStateDir(root));
    return withFileLockSync(lockPathFor(path), () => {
        const bytes = existsSync(path) ? readFileSync(path) : null;
        options.verify?.(bytes);
        const current = bytes === null ? null : parseFactoryState(path, key, bytes.toString('utf8'));
        if (current && !verifyFactoryIntegrity(current)) {
            throw new FactoryStateError(`${path} fails its integrity check (edited outside omg factory run); the run is failed until a human replaces the file`);
        }
        const { sealed, content } = writeSealed(path, mutate(current));
        options.onWrite?.(path, content);
        return sealed;
    }, { timeoutMs: 5_000 });
}
function writeSealed(path, next) {
    const sealed = { ...next, integrity: computeFactoryIntegrity(next) };
    // The exact bytes written, so the engine ledger can record them (ledger.ts).
    const content = JSON.stringify(sealed, null, 2);
    atomicWriteFileSync(path, content);
    return { sealed, content };
}
/**
 * Seal and write `state` without the lock and without reading the file: the
 * engine's park at state-tampered, which must not depend on the current
 * bytes (or a lock file) that an unconfirmed lane may still be rewriting.
 */
export function overwriteFactoryState(root, key, state) {
    ensureDirSync(factoryStateDir(root));
    return writeSealed(factoryStatePath(root, key), state);
}
/**
 * `omg factory run cancel`: drop the cancel request file next to the state.
 * The state file stays engine-only (the engine ledger flags any other
 * writer); the returned state shows the request.
 */
export function requestFactoryCancel(root, key, now) {
    const current = readFactoryState(root, key);
    if (!current)
        throw new FactoryStateError(typeof key === 'number' ? `no factory run for issue #${key}` : `no factory run ${key}`);
    writeFileSync(factoryCancelPath(root, key), `${JSON.stringify({ at: now })}\n`, 'utf8');
    return { ...current, cancelRequested: true };
}
export const defaultOwnerDeps = () => ({ pid: process.pid, hostname: hostname(), isAlive: isProcessAlive });
/**
 * Claim the single-runner owner file. A live owner (or one on another host,
 * whose pid cannot be checked) refuses; a dead pid on this host is taken
 * over, and `tookOver` names it for the history.
 */
export function acquireFactoryOwner(root, key, now, deps = defaultOwnerDeps()) {
    const path = factoryOwnerPath(root, key);
    ensureDirSync(factoryStateDir(root));
    const tookOver = withFileLockSync(lockPathFor(path), () => {
        let prior;
        if (existsSync(path)) {
            try {
                prior = JSON.parse(readFileSync(path, 'utf8'));
            }
            catch {
                prior = undefined;
            }
            if (prior && (prior.hostname !== deps.hostname || (prior.pid !== deps.pid && deps.isAlive(prior.pid)))) {
                throw new FactoryStateError(`omg factory run ${key} is already running (pid ${prior.pid} on ${prior.hostname} since ${prior.startedAt})`);
            }
        }
        writeFileSync(path, `${JSON.stringify({ pid: deps.pid, hostname: deps.hostname, startedAt: now })}\n`, 'utf8');
        return prior;
    }, { timeoutMs: 5_000 });
    const release = () => {
        try {
            withFileLockSync(lockPathFor(path), () => {
                const owner = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
                if (owner && owner.pid === deps.pid && owner.hostname === deps.hostname)
                    unlinkSync(path);
            }, { timeoutMs: 5_000 });
        }
        catch { /* a stale owner file is taken over by the next run */ }
    };
    return { release, ...(tookOver ? { tookOver } : {}) };
}
//# sourceMappingURL=state.js.map