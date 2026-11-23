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
 */
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { LOCAL_REMOTE } from '../../forge/local/mirror.js';
import { withWorktreePathRenderScope } from '../../lib/worktree-paths.js';
import { plainText } from '../check/score.js';
import { readHealState, SIG8 } from '../heal/state.js';
import { verifyHealSeal } from '../heal/run.js';
import { runCredits, RUNTIME_MIN_MAX_CREDITS } from '../run/budget.js';
import { currentBytes, EngineLedger } from '../run/ledger.js';
import { factoryProgressFile } from '../run/progress.js';
import { RELEASE_TAMPER_COMMAND, tamperHoldMessage } from '../run/tamper-quarantine.js';
import { factoryOwnerPath, factoryRepoOwnerPath, factoryStateDir, factoryStatePath, heldSlots, ownerHolding, parseFactoryState, runLabel, TERMINAL_FACTORY_PHASES, verifyFactoryIntegrity, } from '../run/state.js';
import { ATTENTION_GROUPS, gateAction, nextCommands, suppressedCommands } from './actions.js';
export const ATTENTION_SCHEMA_VERSION = 1;
/** A live engine with no progress event for this long is "possibly hung" (a hint only: the log is unsealed). */
export const HUNG_AFTER_MS = 10 * 60_000;
export const TITLE_MAX = 60;
const TEXT_MAX = 300;
const REASON_MAX = 2_000;
const RUN_FILE = /^run-(\d+|heal-[0-9a-f]{8})\.json$/;
const text = (v, max = TEXT_MAX) => plainText(String(v ?? '')).replace(/\s+/g, ' ').trim().slice(0, max);
const errText = (e) => text(e instanceof Error ? e.message : String(e));
const HEX40 = /^[0-9a-f]{40}$/;
const forgeOf = (s) => (s.remote === LOCAL_REMOTE ? 'local' : s.forgeKind ?? 'github');
const msOf = (iso) => (typeof iso === 'string' ? Date.parse(iso) : Number.NaN);
/** The live holder of the run's owner file: `live`, `unreadable` (held until released) or none. */
function ownerOf(root, key, deps) {
    const h = deps ? ownerHolding(factoryOwnerPath(root, key), deps) : ownerHolding(factoryOwnerPath(root, key));
    if (h === null)
        return null;
    return h === 'unreadable' ? 'unreadable' : 'live';
}
/** Milliseconds since the run's progress log last changed (null: no log). */
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
    let bytes;
    let state;
    try {
        bytes = currentBytes(path);
        if (bytes === null)
            return { key, trust: 'unreadable', error: 'the state file disappeared while it was read' };
        state = parseFactoryState(path, key, bytes.toString('utf8'));
    }
    catch (error) {
        return { key, trust: 'unreadable', error: errText(error) };
    }
    if (!verifyFactoryIntegrity(state))
        return { key, state, trust: 'seal' };
    try {
        const ledger = EngineLedger.open(ledgerDir, root, key);
        // The engine refuses to resume such a state as well (no engine record), so it is the same Inspect row.
        if (!ledger.tracks(path))
            return { key, state, trust: 'ledger', error: 'the engine ledger on this host has no record of it: the run ran with another ledger (another host or OMC_STATE_DIR), or the file was written outside the engine' };
        if (!ledger.matches(path, bytes))
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
    unreadable: 'the run state cannot be read',
};
function runItem(root, r, now, o, live) {
    const label = runLabel(r.key);
    const base = { key: label, credits: null, cap: null, pr: null, head: null, title: '', notes: [], log: relLog(r.key) };
    if (r.trust === 'unreadable' || !r.state) {
        return { ...base, group: 'inspect', gate: null, phase: null, ageMs: null, why: `${TRUST_WHY.unreadable}: ${r.error ?? 'unknown error'}`, next: suppressedCommands(r.key), trust: 'unreadable', at: 0 };
    }
    const s = r.state;
    const terminal = TERMINAL_FACTORY_PHASES.includes(s.phase);
    const credits = Number(runCredits(s).toFixed(2));
    const cap = typeof r.key === 'number' ? o.limits?.maxRunCredits ?? null : null;
    const common = {
        ...base,
        phase: text(s.phase, 40),
        gate: s.gate ? text(s.gate.name, 60) : null,
        credits,
        cap,
        pr: typeof s.pr === 'number' && Number.isSafeInteger(s.pr) && s.pr > 0 ? s.pr : null,
        head: typeof s.head === 'string' && HEX40.test(s.head) ? s.head : null,
        title: text(s.issueTitle ?? (s.kind === 'ci-heal' ? 'ci-heal' : ''), TITLE_MAX),
        ...(o.verbose && s.gate ? { reason: text(s.gate.reason, REASON_MAX) } : {}),
    };
    const gateAt = msOf(s.gate?.at);
    const updatedAt = msOf(s.updatedAt);
    const at = Number.isFinite(gateAt) ? gateAt : Number.isFinite(updatedAt) ? updatedAt : 0;
    const ageMs = at > 0 ? Math.max(0, now - at) : null;
    if (r.trust !== 'ok') {
        // A tampered state may claim any phase: it is shown whatever it says, terminal included.
        return { ...common, group: 'inspect', ageMs, why: r.error ? `${TRUST_WHY[r.trust]} (${r.error})` : TRUST_WHY[r.trust], next: suppressedCommands(r.key), trust: r.trust, at };
    }
    if (terminal)
        return null;
    const notes = [];
    if (cap !== null && cap - credits < RUNTIME_MIN_MAX_CREDITS)
        notes.push(`within one lane minimum (${RUNTIME_MIN_MAX_CREDITS}) of the credit cap`);
    if (s.cancelRequested)
        notes.push('cancel requested');
    if (live === 'live') {
        const quiet = sinceProgress(root, r.key, now);
        if (quiet === null || quiet >= HUNG_AFTER_MS)
            notes.push(`possibly hung: an engine holds the run but its progress log ${quiet === null ? 'is missing' : `has not changed for ${Math.floor(quiet / 60_000)} min`} (a hint only)`);
    }
    if (live === 'unreadable')
        notes.push('the run\'s owner file is unreadable (held until omg factory run release)');
    if (s.gate) {
        const action = gateAction(s.gate.name);
        const forge = forgeOf(s);
        const why = action.group === 'merge' && s.gate.name === 'merge' && forge === 'azure-devops'
            ? `${action.why}; complete PR !${common.pr ?? '?'} in Azure DevOps (the engine's PR comment names the exact command), then rerun`
            : action.why;
        const next = nextCommands(r.key, action.steps, { forge, root, ...(common.pr !== null ? { pr: common.pr } : {}), ...(common.head !== null ? { head: common.head } : {}) });
        if (action.steps.includes('merge') && !next.some((n) => n.argv[0] !== 'omg') && forge !== 'azure-devops')
            notes.push('no merge command: the run has no valid PR number or 40-hex head');
        return { ...common, group: action.group, ageMs, why, next, trust: 'ok', notes: [...common.notes, ...notes], at };
    }
    // No gate, not terminal: an engine should hold it.
    if (live === null) {
        return { ...common, group: 'broken', ageMs, why: 'not finished, not parked, and no engine holds it (the engine stopped or died)', next: nextCommands(r.key, ['status', 'resume', 'cancel']), trust: 'ok', notes, at };
    }
    if (live === 'unreadable') {
        return { ...common, group: 'broken', ageMs, why: 'not finished, not parked, and its owner file cannot be read', next: nextCommands(r.key, ['status']), trust: 'ok', notes, at };
    }
    if (notes.some((n) => n.startsWith('possibly hung'))) {
        // A hint only: it changes no command and hides nothing; the row shows only the read-only status.
        return { ...common, group: 'broken', ageMs, why: 'an engine holds the run; it may be hung', next: nextCommands(r.key, ['status']), trust: 'ok', notes, at };
    }
    return null;
}
/** A heal signature with an open heal run waiting for a human and no ci-heal run state yet. */
function healItem(root, s, o, now) {
    if (!SIG8.test(s.sig8) || !s.healRun?.open || (s.next !== 'heal-approve' && s.next !== 'heal-diagnosis'))
        return null;
    const key = `heal-${s.sig8}`;
    const seal = verifyHealSeal(o.ledgerDir, root, s);
    const at = msOf(s.updatedAt);
    const common = { key, gate: s.next, phase: 'heal', ageMs: Number.isFinite(at) ? Math.max(0, now - at) : null, credits: null, cap: null, pr: null, head: null, title: text(`ci-heal ${s.class}`, TITLE_MAX), notes: [], at: Number.isFinite(at) ? at : 0 };
    if (seal !== 'ok') {
        return { ...common, group: 'inspect', why: `the heal record does not match the one the heal run wrote (seal: ${seal}); do not act on it`, next: suppressedCommands(key), trust: 'seal' };
    }
    const approve = s.next === 'heal-approve';
    return {
        ...common,
        group: 'decide',
        why: approve ? 'a valid CI-heal diagnosis waits for a human approval' : 'the debugger lane\'s diagnosis was not valid; read it, then close the heal run or run the lane again',
        next: nextCommands(key, approve ? ['status', 'resume', 'heal-close'] : ['status', 'heal-close', 'heal-run']),
        trust: 'ok',
    };
}
/** One render scope: the state root is resolved once, not once per file path (dozens of git-metadata stats each on Windows). */
export function collectAttention(root, o) {
    return withWorktreePathRenderScope(() => collectIn(root, o));
}
function collectIn(root, o) {
    const now = (o.now ?? Date.now)();
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
            next: [{ label: 'release the hold after checking .git', argv: RELEASE_TAMPER_COMMAND.split(' ') }], trust: 'ok', notes: [], at: 0,
        });
    }
    let names = [];
    try {
        names = readdirSync(factoryStateDir(root)).sort();
    }
    catch {
        // No state dir: no runs.
    }
    const healRuns = new Set();
    for (const name of names) {
        const m = RUN_FILE.exec(name);
        if (!m)
            continue;
        const key = /^\d+$/.test(m[1]) ? Number(m[1]) : m[1];
        if (typeof key === 'string')
            healRuns.add(key.slice('heal-'.length));
        if (typeof key === 'number' && !(Number.isSafeInteger(key) && key > 0))
            continue;
        let r = readRun(root, key, o.ledgerDir);
        const live = ownerOf(root, key, o.owner);
        // A live engine writes the state, then the ledger: one reread rules out reading between the two.
        if (r.trust === 'ledger' && live === 'live')
            r = readRun(root, key, o.ledgerDir);
        if (r.trust === 'unreadable') {
            readFailed = true;
            warnings.push(`run state ${runLabel(key)} is unreadable: ${r.error ?? 'unknown error'}`);
        }
        if (r.state && r.trust === 'ok')
            forges.add(forgeOf(r.state));
        if (live === 'live')
            liveRuns.push(runLabel(key));
        const item = runItem(root, r, now, o, live);
        if (item)
            items.push(item);
    }
    // Heal signatures whose open heal run waits for a human before any ci-heal run state exists.
    let healNames = [];
    try {
        healNames = readdirSync(join(factoryStateDir(root), 'heal')).filter((f) => /^[0-9a-f]{8}\.json$/.test(f)).sort();
    }
    catch {
        // No heal state.
    }
    for (const f of healNames) {
        const sig8 = f.slice(0, 8);
        if (healRuns.has(sig8))
            continue;
        let s;
        try {
            s = readHealState(root, sig8);
        }
        catch (error) {
            warnings.push(`heal signature ${sig8} is unreadable: ${errText(error)}`);
            continue;
        }
        const item = s ? healItem(root, s, o, now) : null;
        if (item)
            items.push(item);
    }
    // The repository engine lock and the parallel slots, for the summary only.
    const repoOwner = o.owner ? ownerHolding(factoryRepoOwnerPath(root), o.owner) : ownerHolding(factoryRepoOwnerPath(root));
    const slots = o.owner ? heldSlots(root, o.owner) : heldSlots(root);
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
/** The `--json` shape: the items without their sort key, notes and log kept. */
export function attentionJson(d) {
    return {
        schemaVersion: d.schemaVersion,
        repo: d.repo,
        forge: d.forge,
        generatedAt: d.generatedAt,
        summary: d.summary,
        items: d.items.map(({ at: _at, ...rest }) => rest),
        warnings: d.warnings,
    };
}
//# sourceMappingURL=collect.js.map