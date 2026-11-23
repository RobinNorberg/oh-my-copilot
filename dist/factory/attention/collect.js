/**
 * `omg factory attention` data: what needs the human, from LOCAL state only.
 *
 * One pass over `.omg/state/factory/` (run states, owner files) and
 * `heal/` (heal signatures without a run state yet), plus the engine ledger
 * and the tamper hold outside the repository. No network, no forge read, no
 * subprocess per item, and NO write of any kind: no human-merge recording,
 * no lock, no file. Every read is lock-free, so it is safe while engines run.
 *
 * Trust: each run state's bytes are read once; the seal
 * (verifyFactoryIntegrity) and the engine ledger (EngineLedger.matches on
 * those same bytes) must both hold, as recordHumanMerge checks them. A state
 * that fails either, or cannot be read, goes to the Inspect group and its
 * commands are suppressed except the read-only status: a command built from
 * tampered state would be an injection vector. Every string from state goes
 * through plainText and is cut; commands come from actions.ts only.
 *
 * Untrusted state must not HIDE a row either: no field of a file decides to
 * drop it before that file's trust check, the ledger is listed as well as
 * the state dir (a deleted state the engine recorded is a row), an owner
 * file counts as a live engine only when it is the engine's recorded write,
 * and a heal record is checked against its seal before any of its fields
 * is read.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { LOCAL_REMOTE } from '../../forge/local/mirror.js';
import { withWorktreePathRenderScope } from '../../lib/worktree-paths.js';
import { plainText } from '../check/score.js';
import { healStatePath, parseHealState, SIG8 } from '../heal/state.js';
import { healSealOpen, healSealSigs, verifyHealSeal } from '../heal/run.js';
import { runCredits, RUNTIME_MIN_MAX_CREDITS } from '../run/budget.js';
import { MAX_CONCURRENT_LIMIT } from '../run/parallel.js';
import { EngineLedger, ledgerFilePath } from '../run/ledger.js';
import { factoryProgressFile } from '../run/progress.js';
import { RELEASE_TAMPER_COMMAND, tamperHoldMessage } from '../run/tamper-quarantine.js';
import { defaultOwnerDeps, factoryOwnerPath, factoryRepoOwnerPath, factoryStateDir, factorySlotsDir, factoryStatePath, isOwnerRecord, ownerHolds, parseFactoryState, runLabel, TERMINAL_FACTORY_PHASES, verifyFactoryIntegrity, } from '../run/state.js';
import { ATTENTION_GROUPS, gateAction, nextCommands, stateGateNext, suppressedCommands } from './actions.js';
export const ATTENTION_SCHEMA_VERSION = 1;
/** A live engine with no progress event for this long is "possibly hung" (a hint only: the log is unsealed). */
export const HUNG_AFTER_MS = 10 * 60_000;
export const TITLE_MAX = 60;
/** A state, heal or owner file larger than this is not read (an "unreadable" row). */
export const READ_MAX_BYTES = 8 * 1024 * 1024;
const TEXT_MAX = 300;
const REASON_MAX = 2_000;
const RUN_FILE = /^run-(\d+|heal-[0-9a-f]{8})\.json$/;
/** Sanitised, one line, cut to `max` code points (never half a surrogate pair). */
const text = (v, max = TEXT_MAX) => [...plainText(String(v ?? '')).replace(/\s+/g, ' ').trim()].slice(0, max).join('');
const errText = (e) => text(e instanceof Error ? e.message : String(e));
const HEX40 = /^[0-9a-f]{40}$/;
const forgeOf = (s) => (s.remote === LOCAL_REMOTE ? 'local' : s.forgeKind ?? 'github');
const msOf = (iso) => (typeof iso === 'string' ? Date.parse(iso) : Number.NaN);
/** The run key of a canonical `run-<key>.json` name; null for anything else (`run-01.json` is not run 1's file). */
function runKeyOfName(name) {
    const m = RUN_FILE.exec(name);
    if (!m)
        return null;
    const key = /^\d+$/.test(m[1]) ? Number(m[1]) : m[1];
    if (typeof key === 'number' && !(Number.isSafeInteger(key) && key > 0))
        return null;
    return name === `run-${String(key)}.json` ? key : null;
}
/** Same ino and dev; win32 may report dev 0 on one side (as state-lock's sameArtifactIdentity). */
const sameFile = (a, b) => a.ino === b.ino && (a.dev === b.dev || (process.platform === 'win32' && (a.dev === 0n || b.dev === 0n)));
const kindOf = (st) => (st.isSymbolicLink() ? 'a link' : st.isDirectory() ? 'a directory' : st.isFIFO() ? 'a FIFO' : 'a device or socket');
const isMissing = (e) => e?.code === 'ENOENT';
/**
 * One bounded read of a regular file: lstat first (a link, FIFO, device or
 * directory is refused without being opened), then the opened file must be
 * that same regular file and no larger than READ_MAX_BYTES.
 */
export function readRegularFile(path, max = READ_MAX_BYTES) {
    let st;
    try {
        // BigInt ids: an NTFS file id above 2^53 rounds distinct files onto one Number (tests/lint/file-identity-bigint.test.ts).
        st = lstatSync(path, { bigint: true });
    }
    catch (error) {
        return isMissing(error) ? { missing: true } : { error: errText(error) };
    }
    if (!st.isFile())
        return { error: `it is ${kindOf(st)}, not a regular file` };
    if (st.size > BigInt(max))
        return { error: `it is larger than ${max} bytes` };
    let fd;
    try {
        // No follow and no blocking where the platform has them (a FIFO swapped in after the lstat cannot hang the read).
        fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    }
    catch (error) {
        return isMissing(error) ? { missing: true } : { error: errText(error) };
    }
    try {
        const f = fstatSync(fd, { bigint: true });
        if (!f.isFile() || !sameFile(f, st))
            return { error: 'the file was replaced while it was read' };
        if (f.size > BigInt(max))
            return { error: `it is larger than ${max} bytes` };
        const size = Number(f.size);
        const buf = Buffer.alloc(size);
        let n = 0;
        while (n < size) {
            const got = readSync(fd, buf, n, size - n, n);
            if (got === 0)
                break;
            n += got;
        }
        if (readSync(fd, Buffer.alloc(1), 0, 1, n) > 0)
            return { error: 'the file grew while it was read' };
        return { bytes: buf.subarray(0, n) };
    }
    catch (error) {
        return { error: errText(error) };
    }
    finally {
        closeSync(fd);
    }
}
function ownerOf(root, key, ledgerDir, deps) {
    const path = factoryOwnerPath(root, key);
    const r = readRegularFile(path);
    if ('missing' in r)
        return null;
    if ('error' in r)
        return 'unreadable';
    try {
        if (!EngineLedger.open(ledgerDir, root, key).matches(path, r.bytes))
            return 'forged';
    }
    catch {
        return 'forged';
    }
    let owner;
    try {
        owner = JSON.parse(r.bytes.toString('utf8'));
    }
    catch {
        return 'unreadable';
    }
    if (!isOwnerRecord(owner))
        return 'unreadable';
    if (owner.hostname !== deps.hostname)
        return 'remote';
    return ownerHolds(owner, deps) ? 'live' : null;
}
/**
 * ownerHolding through the bounded read: the holder of an owner file that is
 * not run-scoped (the repository engine lock, a parallel slot), `unreadable`
 * (held, as every caller of ownerHolding treats it), or null.
 */
function holderOf(path, deps) {
    const r = readRegularFile(path);
    if ('missing' in r)
        return null;
    if ('error' in r)
        return 'unreadable';
    try {
        const owner = JSON.parse(r.bytes.toString('utf8'));
        if (!isOwnerRecord(owner))
            return 'unreadable';
        return ownerHolds(owner, deps) ? 'held' : null;
    }
    catch {
        return 'unreadable';
    }
}
/** Milliseconds since the run's progress log last changed (null: no log; negative: a modification time in the future). */
function sinceProgress(root, key, now) {
    try {
        return now - statSync(factoryProgressFile(root, key)).mtimeMs;
    }
    catch {
        return null;
    }
}
const relLog = (key) => `.omg/progress/factory-${key}.log`;
/** One read of the state bytes; seal, then the ledger on those same bytes. */
function readRun(root, key, ledgerDir) {
    const path = factoryStatePath(root, key);
    const r = readRegularFile(path);
    if ('missing' in r)
        return { key, trust: 'unreadable', missing: true, error: 'the state file disappeared while it was read' };
    if ('error' in r)
        return { key, trust: 'unreadable', error: r.error };
    let state;
    try {
        state = parseFactoryState(path, key, r.bytes.toString('utf8'));
    }
    catch (error) {
        return { key, trust: 'unreadable', error: errText(error) };
    }
    if (!verifyFactoryIntegrity(state))
        return { key, state, trust: 'seal' };
    try {
        const ledger = EngineLedger.open(ledgerDir, root, key);
        // The engine refuses to resume such a state as well (no engine record): Inspect, but worded apart from tampering.
        if (!ledger.tracks(path))
            return { key, state, trust: 'unverified' };
        if (!ledger.matches(path, r.bytes))
            return { key, state, trust: 'ledger' };
    }
    catch (error) {
        return { key, state, trust: 'ledger', error: errText(error) };
    }
    return { key, state, trust: 'ok' };
}
const TRUST_WHY = {
    seal: 'state is not the engine\'s last write (its integrity seal fails); inspect it, the commands are withheld',
    ledger: 'state is not the engine\'s last write (the engine ledger does not hold these bytes); inspect it, the commands are withheld',
    unverified: 'cannot be verified on this host: no engine ledger record (moved repository, another host or OMC_STATE_DIR, or written outside the engine); the commands are withheld',
    owner: 'an owner file the engine did not write holds the run (the engine ledger does not record it); inspect it, the commands are withheld',
    missing: 'the engine\'s state file is missing; the ledger holds its last write. Inspect it, the commands are withheld',
    unreadable: 'the run state cannot be read',
};
const FORGED_OWNER_NOTE = 'an owner file the engine did not write is present (the engine ledger does not record it); it is not counted as a live engine';
const REMOTE_OWNER_NOTE = 'the run\'s owner file names another host: this host cannot tell whether that engine is alive';
function runItem(root, r, now, o, live, hold = false) {
    const label = runLabel(r.key);
    const base = { key: label, credits: null, cap: null, pr: null, head: null, title: '', notes: [], log: relLog(r.key) };
    if (r.trust === 'unreadable' || !r.state) {
        return { ...base, group: 'inspect', gate: null, phase: null, ageMs: null, why: `${TRUST_WHY.unreadable}: ${r.error ?? 'unknown error'}`, next: suppressedCommands(r.key), trust: 'unreadable', at: 0 };
    }
    const s = r.state;
    const common = {
        ...base,
        phase: text(s.phase, 40),
        gate: s.gate ? text(s.gate.name, 60) : null,
        pr: typeof s.pr === 'number' && Number.isSafeInteger(s.pr) && s.pr > 0 ? s.pr : null,
        head: typeof s.head === 'string' && HEX40.test(s.head) ? s.head : null,
        title: text(s.issueTitle ?? (s.kind === 'ci-heal' ? 'ci-heal' : ''), TITLE_MAX),
    };
    const gateAt = msOf(s.gate?.at);
    const updatedAt = msOf(s.updatedAt);
    const at = Number.isFinite(gateAt) ? gateAt : Number.isFinite(updatedAt) ? updatedAt : 0;
    const ageMs = at > 0 ? Math.max(0, now - at) : null;
    if (r.trust !== 'ok') {
        // A tampered state may claim any phase: it is shown whatever it says, terminal included, and its reason never is.
        return { ...common, group: 'inspect', ageMs, why: r.error ? `${TRUST_WHY[r.trust]} (${r.error})` : TRUST_WHY[r.trust], next: suppressedCommands(r.key), trust: r.trust, at };
    }
    if (TERMINAL_FACTORY_PHASES.includes(s.phase))
        return null;
    // Credits are read from the engine's own state only: an untrusted one could hold anything there.
    const credits = Number(runCredits(s).toFixed(2));
    const cap = typeof r.key === 'number' ? o.limits?.maxRunCredits ?? null : null;
    const trusted = { ...common, credits, cap, ...(o.verbose && s.gate ? { reason: text(s.gate.reason, REASON_MAX) } : {}) };
    const notes = [];
    if (cap !== null && cap - credits < RUNTIME_MIN_MAX_CREDITS)
        notes.push(`within one lane minimum (${RUNTIME_MIN_MAX_CREDITS}) of the credit cap`);
    if (s.cancelRequested)
        notes.push('cancel requested');
    if (live === 'live') {
        const quiet = sinceProgress(root, r.key, now);
        if (quiet === null || quiet < 0 || quiet >= HUNG_AFTER_MS) {
            const log = quiet === null ? 'is missing' : quiet < 0 ? 'has a modification time in the future' : `has not changed for ${Math.floor(quiet / 60_000)} min`;
            notes.push(`possibly hung: an engine holds the run but its progress log ${log} (a hint only)`);
        }
    }
    if (live === 'unreadable')
        notes.push('the run\'s owner file is unreadable (held until omg factory run release)');
    if (live === 'forged')
        notes.push(FORGED_OWNER_NOTE);
    if (live === 'remote')
        notes.push(REMOTE_OWNER_NOTE);
    if (s.gate) {
        const action = gateAction(s.gate.name);
        const forge = forgeOf(s);
        const why = action.group === 'merge' && s.gate.name === 'merge' && forge === 'azure-devops'
            ? `${action.why}; complete PR !${common.pr ?? '?'} in Azure DevOps (the engine's PR comment names the exact command), then rerun`
            : action.why;
        // The engine's sealed next commands (FactoryGate.next) of this trusted state; a state sealed before they existed gets the same table here.
        const next = stateGateNext(s, root, hold);
        if (action.steps.includes('merge') && !next.some((n) => n.argv[0] !== 'omg') && forge !== 'azure-devops')
            notes.push('no merge command: the run has no valid PR number or 40-hex head, or the repository root cannot be put in a command (run status shows the merge step)');
        return { ...trusted, group: action.group, ageMs, why, next, trust: 'ok', notes, at };
    }
    // No gate, not terminal: an engine should hold it.
    if (live === null) {
        return { ...trusted, group: 'broken', ageMs, why: 'not finished, not parked, and no engine holds it (the engine stopped or died)', next: nextCommands(r.key, ['status', 'resume', 'cancel']), trust: 'ok', notes, at };
    }
    if (live === 'forged') {
        return { ...common, group: 'inspect', ageMs, why: TRUST_WHY.owner, next: suppressedCommands(r.key), trust: 'owner', notes, at };
    }
    if (live === 'remote') {
        return { ...trusted, group: 'broken', ageMs, why: 'not finished, not parked, and held by an engine on another host; check that host', next: nextCommands(r.key, ['status']), trust: 'ok', notes, at };
    }
    if (live === 'unreadable') {
        return { ...trusted, group: 'broken', ageMs, why: 'not finished, not parked, and its owner file cannot be read', next: nextCommands(r.key, ['status']), trust: 'ok', notes, at };
    }
    if (notes.some((n) => n.startsWith('possibly hung'))) {
        // A hint only: it changes no command and hides nothing; the row shows only the read-only status.
        return { ...trusted, group: 'broken', ageMs, why: 'an engine holds the run; it may be hung', next: nextCommands(r.key, ['status']), trust: 'ok', notes, at };
    }
    return null;
}
/**
 * A run the engine ledger records a state for while the state file is gone.
 * The ledger's content is the engine's own last write: a run it recorded as
 * finished (terminal, sealed) needs nobody; anything else is a row.
 */
function missingItem(root, key, ledgerDir) {
    const path = factoryStatePath(root, key);
    const base = { key: runLabel(key), group: 'inspect', gate: null, phase: null, ageMs: null, credits: null, cap: null, pr: null, head: null, title: '', notes: [], log: relLog(key), next: suppressedCommands(key), at: 0 };
    let recorded;
    try {
        recorded = EngineLedger.open(ledgerDir, root, key).recorded(path);
    }
    catch (error) {
        return { ...base, why: `the state file is missing and the engine ledger record of the run cannot be read (${errText(error)}); inspect it, the commands are withheld`, trust: 'ledger' };
    }
    // Untracked, or recorded as "must not exist": nothing is missing.
    if (typeof recorded !== 'string')
        return null;
    try {
        const last = parseFactoryState(path, key, recorded);
        if (verifyFactoryIntegrity(last) && TERMINAL_FACTORY_PHASES.includes(last.phase))
            return null;
    }
    catch {
        // Not a state the engine could have written: shown below.
    }
    return { ...base, why: TRUST_WHY.missing, trust: 'missing' };
}
/**
 * A heal signature with an open heal run and no ci-heal run state. The seal
 * is checked first, then only sealed fields decide (the heal run, its lanes
 * and its diagnosis; never `next`, which the seal does not cover).
 */
function healItem(root, sig8, s, o, now, deps) {
    const key = `heal-${sig8}`;
    const seal = s.sig8 === sig8 ? verifyHealSeal(o.ledgerDir, root, s) : 'mismatch';
    // No heal run, no lane, no diagnosis and no seal: nothing was started, nothing waits.
    if (seal === 'none')
        return null;
    const at = msOf(s.updatedAt);
    const common = { key, phase: 'heal', ageMs: Number.isFinite(at) ? Math.max(0, now - at) : null, credits: null, cap: null, pr: null, head: null, title: text(`ci-heal ${s.class}`, TITLE_MAX), notes: [], at: Number.isFinite(at) ? at : 0 };
    if (seal !== 'ok') {
        return { ...common, gate: null, group: 'inspect', why: `the heal record does not match the one the heal run wrote (seal: ${seal}); do not act on it`, next: suppressedCommands(key), trust: 'seal' };
    }
    if (!s.healRun?.open)
        return null;
    const last = s.lanes?.at(-1);
    // A debugger lane at work: nothing waits for a human yet.
    if (last?.status === 'running' && Number.isInteger(last.pid) && deps.isAlive(last.pid))
        return null;
    const approve = last?.status !== 'running' && s.diagnosis?.outcome === 'valid' && s.diagnosis.laneId === last?.id;
    // `heal close` takes only a heal run parked at heal-approve or heal-diagnosis (closeHeal), a stage the heal run
    // writes when one of ITS lanes ends. `next` is not sealed, so the sealed lanes decide: a lane of this heal run
    // (started at or after it) that ended. A first lane whose process died never ended: only `heal run` (which
    // records it as lost) moves it on.
    const ended = (s.lanes ?? []).some((l) => l.status !== 'running' && typeof l.startedAt === 'string' && typeof s.healRun?.startedAt === 'string' && l.startedAt >= s.healRun.startedAt);
    return {
        ...common,
        gate: approve ? 'heal-approve' : 'heal-diagnosis',
        group: 'decide',
        why: approve ? 'a valid CI-heal diagnosis waits for a human approval'
            : ended ? 'the heal run has no valid diagnosis from its debugger lane; read it, then close the heal run or run the lane again'
                : 'the heal run\'s debugger lane ended without a record (its process is gone); run the lane again',
        next: nextCommands(key, approve ? ['status', 'resume', 'heal-close'] : ended ? ['status', 'heal-close', 'heal-run'] : ['status', 'heal-run']),
        trust: 'ok',
    };
}
/**
 * L-2: the engine's own ci-heal run of `sig8` is finished (merged, cancelled
 * or failed) while its heal record still holds an open heal run: the run
 * ended without `heal close` (a human merge recorded elsewhere, a failed
 * close), and an open heal run blocks every other debugger lane
 * (MAX_OPEN_HEAL_RUNS). Sealed fields only, as healItem.
 */
function healOpenAfterRun(root, sig8, s, o, now) {
    if (s.sig8 !== sig8 || verifyHealSeal(o.ledgerDir, root, s) !== 'ok' || !s.healRun?.open)
        return null;
    const key = `heal-${sig8}`;
    const at = msOf(s.updatedAt);
    return {
        key, group: 'decide', gate: 'heal-open', phase: 'heal', ageMs: Number.isFinite(at) ? Math.max(0, now - at) : null, credits: null, cap: null, pr: null, head: null,
        title: text(`ci-heal ${s.class}`, TITLE_MAX),
        why: 'the ci-heal run is finished but its heal run is still open, which blocks every other debugger lane; close it',
        next: nextCommands(key, ['status', 'heal-close']), trust: 'ok', notes: [], at: Number.isFinite(at) ? at : 0,
    };
}
/** One render scope: the state root is resolved once, not once per file path (dozens of git-metadata stats each on Windows). */
export function collectAttention(root, o) {
    return withWorktreePathRenderScope(() => collectIn(root, o));
}
function collectIn(root, o) {
    const now = (o.now ?? Date.now)();
    const deps = o.owner ?? defaultOwnerDeps();
    const warnings = [];
    const items = [];
    const liveRuns = [];
    const forges = new Set();
    let readFailed = false;
    const hold = tamperHoldMessage(o.ledgerDir, root);
    if (hold) {
        items.push({
            key: 'checkout', group: 'inspect', gate: 'tamper-hold', phase: null, ageMs: null, credits: null, cap: null, pr: null, head: null, title: '',
            why: 'a tamper hold is set on this checkout: no factory run starts here until you check the repository\'s .git and release it',
            next: [{ label: 'release the hold after checking .git', argv: RELEASE_TAMPER_COMMAND.split(' '), billed: false }], trust: 'ok', notes: [], at: 0,
        });
    }
    // The run keys: every canonical state file, and every run the engine ledger of this repository records.
    const keys = new Map();
    const listed = (dir) => {
        try {
            return readdirSync(dir);
        }
        catch {
            return []; // No such dir: no runs there.
        }
    };
    for (const name of [...listed(factoryStateDir(root)), ...listed(dirname(ledgerFilePath(o.ledgerDir, root, 1)))]) {
        const key = runKeyOfName(name);
        if (key !== null)
            keys.set(String(key), key);
    }
    // sig8 -> whether the engine's own ci-heal run state of it is finished.
    const healRuns = new Map();
    for (const key of [...keys.values()].sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true }))) {
        let r = readRun(root, key, o.ledgerDir);
        if (r.missing) {
            const item = missingItem(root, key, o.ledgerDir);
            if (item)
                items.push(item);
            continue;
        }
        const live = ownerOf(root, key, o.ledgerDir, deps);
        // A live engine writes the state, then the ledger: one reread rules out reading between the two.
        if ((r.trust === 'ledger' || r.trust === 'unverified') && live === 'live')
            r = readRun(root, key, o.ledgerDir);
        if (r.trust === 'unreadable') {
            readFailed = true;
            warnings.push(`run state ${runLabel(key)} is unreadable: ${r.error ?? 'unknown error'}`);
        }
        if (r.state && r.trust === 'ok') {
            forges.add(forgeOf(r.state));
            // Only the engine's own ci-heal run state stands in for its heal signature.
            if (typeof key === 'string')
                healRuns.set(key.slice('heal-'.length), TERMINAL_FACTORY_PHASES.includes(r.state.phase));
        }
        if (live === 'live' || live === 'remote')
            liveRuns.push(runLabel(key));
        let item;
        try {
            item = runItem(root, r, now, o, live, hold !== null);
        }
        catch (error) {
            // A state this version cannot lay out is still a row, never a missing one.
            readFailed = true;
            item = runItem(root, { key, trust: 'unreadable', error: errText(error) }, now, o, live);
        }
        if (item)
            items.push(item);
    }
    // Heal signatures whose open heal run waits for a human before any ci-heal run state exists, and seals whose record is gone.
    const healDir = join(factoryStateDir(root), 'heal');
    const sigs = new Set([...listed(healDir).filter((f) => /^[0-9a-f]{8}\.json$/.test(f)).map((f) => f.slice(0, 8)), ...healSealSigs(o.ledgerDir, root)]);
    for (const sig8 of [...sigs].sort()) {
        if (!SIG8.test(sig8))
            continue;
        // A ci-heal run in flight stands in for its heal signature; a finished one only for a record that is gone or unreadable.
        const finishedRun = healRuns.get(sig8);
        if (finishedRun === false)
            continue;
        const key = `heal-${sig8}`;
        const row = { key, group: 'inspect', gate: null, phase: 'heal', ageMs: null, credits: null, cap: null, pr: null, head: null, title: '', notes: [], next: suppressedCommands(key), at: 0 };
        const r = readRegularFile(healStatePath(root, sig8));
        if ('missing' in r) {
            // L-3: a heal run the seal records as closed needs nobody once its record is gone (git clean); seals older than
            // the `open` field stay a row until the seal file is removed by hand (docs: `factory attention`).
            if (finishedRun === undefined && healSealOpen(o.ledgerDir, root, sig8) !== false) {
                // Listed by its seal only: the heal run recorded a record that is gone.
                items.push({ ...row, why: 'the heal record is missing; the heal seal outside the repository records an open heal run (or predates the open flag). Inspect it, the commands are withheld', trust: 'missing' });
            }
            continue;
        }
        let s = null;
        let problem = 'error' in r ? r.error : '';
        if ('bytes' in r) {
            try {
                s = parseHealState(r.bytes.toString('utf8'), healStatePath(root, sig8));
            }
            catch (error) {
                problem = errText(error);
            }
        }
        if (!s) {
            if (finishedRun)
                continue;
            warnings.push(`heal signature ${sig8} is unreadable: ${problem}`);
            items.push({ ...row, why: `the heal record cannot be read: ${text(problem)}`, trust: 'unreadable' });
            continue;
        }
        let item;
        try {
            item = finishedRun ? healOpenAfterRun(root, sig8, s, o, now) : healItem(root, sig8, s, o, now, deps);
        }
        catch (error) {
            item = { ...row, why: `the heal record cannot be laid out: ${errText(error)}`, trust: 'unreadable' };
        }
        if (item)
            items.push(item);
    }
    // The repository engine lock and the parallel slots, for the summary only: bounded reads (L-4), and at most
    // MAX_CONCURRENT_LIMIT slot files, so planted files cannot make each read check a process start identity.
    const repoOwner = holderOf(factoryRepoOwnerPath(root), deps);
    const slotFiles = listed(factorySlotsDir(root)).filter((n) => /^slot-\d+\.owner$/.test(n)).sort().slice(0, MAX_CONCURRENT_LIMIT);
    const slots = slotFiles.filter((n) => holderOf(join(factorySlotsDir(root), n), deps) !== null);
    const engines = Math.max(liveRuns.length, (repoOwner && repoOwner !== 'unreadable' ? 1 : 0) + slots.length);
    const order = new Map(ATTENTION_GROUPS.map((g, i) => [g, i]));
    items.sort((a, b) => order.get(a.group) - order.get(b.group) || a.at - b.at || a.key.localeCompare(b.key));
    const byGroup = Object.fromEntries(ATTENTION_GROUPS.map((g) => [g, items.filter((i) => i.group === g).length]));
    return {
        schemaVersion: ATTENTION_SCHEMA_VERSION,
        repo: root,
        forge: forges.size === 0 ? null : forges.size === 1 ? [...forges][0] : 'mixed',
        generatedAt: new Date(now).toISOString(),
        summary: { byGroup, engines: { live: engines, runs: liveRuns } },
        items,
        warnings: warnings.map((w) => text(w, 500)),
        readFailed,
    };
}
/** The `--json` shape: the items without their sort key, notes and log kept; a reason only on a trusted row. */
export function attentionJson(d) {
    return {
        schemaVersion: d.schemaVersion,
        repo: d.repo,
        forge: d.forge,
        generatedAt: d.generatedAt,
        summary: d.summary,
        items: d.items.map(({ at: _at, reason, ...rest }) => (rest.trust === 'ok' && reason !== undefined ? { ...rest, reason } : rest)),
        warnings: d.warnings,
    };
}
//# sourceMappingURL=collect.js.map