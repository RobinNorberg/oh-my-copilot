/**
 * SessionEnd chain enqueuer (spec #9 tracker issue #17).
 *
 * The SessionEnd hook cannot see the session prompt, so chain membership
 * rides a ledger file (`.omg/state/factory/chain-<linkId>.json`) written
 * by whoever spawned the session (listener / executeSpawnNext). The link id is
 * the Claude session id (`--session-id`) or, on Copilot, OMC_CHAIN_LINK
 * (resolveChainLink); the ledger is closed once its link ends. At session
 * end we map the hook reason to a chain outcome, route through the T1 pure
 * seam, grade a declared gate if the ledger carries one, run the guardrails,
 * and enqueue the chain into the spawn-next action payload. Everything here
 * is cheap sync fs — the actual spawn stays in the detached worker.
 */
import * as fs from 'fs';
import { join } from 'path';
import { decideNextStage, gradeGate, normalizeRouteTable } from './routing.js';
import { acquireChainSlot, releaseChainSlot, INTENT_ID_PATTERN } from './guardrails.js';
import { verifyCheckEvidence } from './check-evidence.js';
import { CHAIN_LINK_ENV, stageVisitCap, validateChainFields, LABEL_PATTERN } from './spawn-next.js';
import { getOmcRoot, validateSessionId } from '../../lib/worktree-paths.js';
/**
 * Explicit success allowlist, fail-closed for anything else. Headless sessions
 * that run to completion report 'other' on Claude (no failure signal in the
 * SessionEnd payload) and 'complete' on Copilot CLI (verified on 1.0.91: a
 * finished `-p` link sends `reason: "complete"`), so both count as a normal
 * exit; 'clear' wipes the chain session's context and halts the chain;
 * unknown reasons stay failed.
 */
export function sessionEndOutcome(reason) {
    return reason === 'prompt_input_exit' || reason === 'logout' || reason === 'other' || reason === 'complete'
        ? 'success'
        : 'failed';
}
/**
 * The ending session's chain-link identity: CHAIN_LINK_ENV when it names a
 * trusted ledger, else the host session id (the Claude path, unchanged).
 *
 * The env var is only trusted when `chain-<id>.json` exists, parses, records
 * `host: "copilot"` and `chainLink: <id>`, and is bound to this host session:
 * the link's own SessionStart binds it (bindChainLink), so a nested session
 * that inherited the var (a verify command's `copilot -p`, an MCP child, a
 * team worker) cannot end the parent's link. A Claude SessionEnd never
 * claims it. A closed ledger resolves, and planChainEnqueue records the
 * replay as `already-closed`. The ledger file, written by the spawner, is the
 * trust anchor, so setting the env var alone can neither inject a chain nor
 * replay a consumed link.
 */
export function resolveChainLink(directory, hostSessionId, env = process.env) {
    const claimed = env[CHAIN_LINK_ENV]?.trim();
    if (!claimed)
        return { linkId: hostSessionId, source: 'session' };
    const reject = (rejected) => ({ linkId: hostSessionId, source: 'session', rejected });
    const check = checkCopilotLink(directory, claimed, env);
    if (typeof check === 'string')
        return reject(check);
    const bound = check.ledger.boundSessionId ?? readBindFile(directory, claimed);
    if (!bound)
        return reject('ledger not bound (no SessionStart claimed it)');
    if (bound !== hostSessionId)
        return reject('ledger bound to another session');
    // A closed ledger still resolves: planChainEnqueue then records the replay
    // as `already-closed`.
    return { linkId: claimed, source: 'env' };
}
/** Shared trust checks for an OMC_CHAIN_LINK claim: the ledger or a rejection reason. */
function checkCopilotLink(directory, claimed, env) {
    try {
        validateSessionId(claimed);
    }
    catch {
        return 'invalid id';
    }
    // A Claude session nested inside a Copilot link inherits the var; only a
    // Copilot session may claim a Copilot link (Claude hooks carry this marker).
    if (env.CLAUDE_CODE_ENTRYPOINT)
        return 'not a copilot session';
    const ledger = readChainLedger(directory, claimed);
    if (!ledger)
        return 'no ledger';
    if (ledger.host !== 'copilot')
        return `ledger host ${String(ledger.host ?? 'unset')}`;
    if (ledger.chainLink !== claimed)
        return 'ledger chainLink mismatch';
    return { ledger };
}
function bindFilePath(directory, linkId) {
    return join(factoryStateDir(directory), `chain-${linkId}.json.bind`);
}
function readBindFile(directory, linkId) {
    try {
        const value = fs.readFileSync(bindFilePath(directory, linkId), 'utf8').trim();
        return value || undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * SessionStart side of the chain-link identity (Copilot): the first session
 * that starts with OMC_CHAIN_LINK naming an open Copilot ledger binds the link
 * to its host session id. The bind is an exclusive create, so of two sessions
 * holding the same inherited value only the first (the link itself; a nested
 * session starts during the link's turn, after its SessionStart) wins.
 * Returns what happened, for the audit trail; never throws.
 */
export function bindChainLink(directory, hostSessionId, env = process.env) {
    try {
        const claimed = env[CHAIN_LINK_ENV]?.trim();
        if (!claimed)
            return 'no-link';
        try {
            validateSessionId(hostSessionId);
        }
        catch {
            return 'invalid session id';
        }
        const check = checkCopilotLink(directory, claimed, env);
        if (typeof check === 'string')
            return check;
        if (check.ledger.closedAt)
            return 'ledger already closed';
        const existing = check.ledger.boundSessionId ?? readBindFile(directory, claimed);
        if (existing)
            return existing === hostSessionId ? 'bound' : 'bound to another session';
        try {
            fs.writeFileSync(bindFilePath(directory, claimed), hostSessionId, { encoding: 'utf8', flag: 'wx' });
        }
        catch {
            return readBindFile(directory, claimed) === hostSessionId ? 'bound' : 'bound to another session';
        }
        const ledgerPath = join(factoryStateDir(directory), `chain-${claimed}.json`);
        writeLedgerAtomic(ledgerPath, { ...check.ledger, boundSessionId: hostSessionId, boundAt: new Date().toISOString() });
        recordChainDecision(directory, { decision: 'link-bound', sessionId: claimed, hostSessionId, intentId: check.ledger.intentId });
        return 'bound';
    }
    catch {
        return 'bind failed';
    }
}
/** Exclusive per-link decision claim: one SessionEnd decides, a concurrent duplicate waits for its closeout. */
function claimLinkDecision(path) {
    try {
        fs.closeSync(fs.openSync(path, 'wx'));
        return true;
    }
    catch {
        return false;
    }
}
let sleepCell = null;
function sleepSync(ms) {
    sleepCell ??= new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sleepCell, 0, 0, ms);
}
/** Poll the ledger for a concurrent SessionEnd's closeout (bounded: the foreground budget is short). */
function waitForCloseout(directory, linkId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const ledger = readChainLedger(directory, linkId);
        if (ledger?.closedAt || Date.now() >= deadline)
            return ledger;
        sleepSync(10);
    }
}
/** Atomic JSON write (temp file + rename): status and the watchdog never read a torn ledger. */
function writeLedgerAtomic(path, value) {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    try {
        fs.renameSync(tmp, path);
    }
    catch (error) {
        try {
            fs.unlinkSync(tmp);
        }
        catch { /* already gone */ }
        throw error;
    }
}
/**
 * Consume a link ledger: record who ended it and how. A closed ledger is never
 * enqueued again (a duplicate SessionEnd is a no-op) and is not a stalled link.
 */
function closeChainLedger(directory, linkId, ledger, closeout) {
    try {
        writeLedgerAtomic(join(factoryStateDir(directory), `chain-${linkId}.json`), { ...ledger, ...closeout, closedAt: new Date().toISOString() });
    }
    catch {
        // best-effort closeout; the decision trail still names the outcome
    }
}
/**
 * The caller could not hand an enqueued chain to the worker (no manifest, or
 * the worker did not spawn): record that against the link and correct the
 * closed ledger, which would otherwise claim `enqueued` for a chain nothing
 * will run.
 */
export function recordChainHandoffFailure(directory, chain, decision, extra = {}) {
    recordChainDecision(directory, { decision, sessionId: chain.sessionId, intentId: chain.intentId, ...extra });
    const ledger = readChainLedger(directory, chain.sessionId);
    if (!ledger?.closedAt)
        return;
    try {
        // Drop the replayable chain too: a duplicate SessionEnd must not resurrect a failed hand-off.
        const { enqueuedChain: _dropped, ...rest } = ledger;
        writeLedgerAtomic(join(factoryStateDir(directory), `chain-${chain.sessionId}.json`), { ...rest, decision });
    }
    catch {
        // best-effort; the decision trail names the failure
    }
}
export function factoryStateDir(directory) {
    return join(getOmcRoot(directory), 'state', 'factory');
}
export function readChainLedger(directory, sessionId) {
    try {
        validateSessionId(sessionId);
    }
    catch {
        return null;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(join(factoryStateDir(directory), `chain-${sessionId}.json`), 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
/** Project-level route table: `.omg/factory-routes.json`. The single source of truth. */
export function readProjectRoutes(directory) {
    try {
        const parsed = JSON.parse(fs.readFileSync(join(getOmcRoot(directory), 'factory-routes.json'), 'utf8'));
        return normalizeRouteTable(parsed);
    }
    catch {
        return null;
    }
}
function recordDecision(directory, record) {
    recordChainDecision(directory, record);
}
/** Decision audit trail; also used by the worker to correct the record when a spawn fails. */
export function recordChainDecision(directory, record) {
    try {
        fs.mkdirSync(factoryStateDir(directory), { recursive: true });
        fs.appendFileSync(join(factoryStateDir(directory), 'chain-decisions.jsonl'), `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`, 'utf8');
    }
    catch {
        // best-effort audit trail
    }
}
function writeHaltMarker(directory, intentId, reason) {
    try {
        fs.mkdirSync(factoryStateDir(directory), { recursive: true });
        fs.writeFileSync(join(factoryStateDir(directory), `chain-${intentId}.stopped.json`), JSON.stringify({ intentId, reason, stoppedAt: new Date().toISOString() }, null, 2), 'utf8');
    }
    catch {
        // best-effort halt marker
    }
}
const DEFAULT_GATE_FACTS = {
    irreversibleOrExternal: false,
    precedentSetting: false,
    valueJudgment: false,
    // Missing facts fail conservative: an undeclared gate grades human.
    mechanicalChecksPassed: false,
};
/**
 * Decide whether the ending session continues its chain. Returns the chain
 * payload to merge into the durable SessionEnd payload, or null (no ledger,
 * no route, human gate, guardrail, or invalid ledger — each recorded).
 */
export function planChainEnqueue(directory, hostSessionId, reason, env = process.env) {
    try {
        const link = resolveChainLink(directory, hostSessionId, env);
        if (link.rejected) {
            const claimed = env[CHAIN_LINK_ENV]?.trim() ?? '';
            recordDecision(directory, {
                decision: 'chain-link-rejected',
                sessionId: hostSessionId,
                chainLink: /^[\w-]{1,64}$/.test(claimed) ? claimed : '(invalid)',
                error: link.rejected,
            });
        }
        // Every record below keys the link by its chain-link id (`sessionId`), so
        // the watchdog and status match it to `chain-<id>.json` on both hosts.
        const sessionId = link.linkId;
        const ledger = readChainLedger(directory, sessionId);
        if (!ledger)
            return null;
        const outcome = sessionEndOutcome(reason);
        const intentId = typeof ledger.intentId === 'string' && ledger.intentId ? ledger.intentId : `chain-${sessionId}`;
        const identity = {
            sessionId,
            ...(sessionId !== hostSessionId ? { hostSessionId } : {}),
            ...(ledger.host ? { host: ledger.host } : {}),
        };
        let lastDecision;
        const record = (decision, extra = {}) => {
            lastDecision = decision;
            recordDecision(directory, { decision, ...identity, outcome, reason, intentId, ...extra });
        };
        // A link is decided once. A duplicate SessionEnd (plugin hook and
        // settings.json forwarder both registered, or the plugin loaded twice)
        // either waits for the deciding one's closeout or finds it, and gets the
        // same chain back: whichever hook's manifest wins still carries the chain.
        const claimPath = join(factoryStateDir(directory), `chain-${sessionId}.json.claim`);
        let current = ledger;
        if (!ledger.closedAt && !claimLinkDecision(claimPath)) {
            current = waitForCloseout(directory, sessionId, 200) ?? ledger;
            if (!current.closedAt) {
                record('duplicate-session-end');
                return null;
            }
        }
        if (current.closedAt)
            return replayCloseout(current, hostSessionId, record);
        let enqueued = null;
        try {
            enqueued = decideChainLink(directory, current, { sessionId, intentId, outcome, reason, record });
            return enqueued;
        }
        catch (error) {
            record('enqueue-error', { error: error instanceof Error ? error.message : String(error) });
            return null;
        }
        finally {
            closeChainLedger(directory, sessionId, current, {
                hostSessionId,
                endReason: reason,
                outcome,
                decision: lastDecision ?? 'enqueue-error',
                ...(enqueued ? { enqueuedChain: enqueued } : {}),
            });
            try {
                fs.unlinkSync(claimPath);
            }
            catch { /* never claimed */ }
        }
    }
    catch {
        // Session end must never fail because of chain bookkeeping.
        return null;
    }
}
/**
 * A SessionEnd for an already-closed link: the same host session gets the
 * chain it enqueued back (idempotent closeout, so a duplicate hook cannot
 * drop the chain from the manifest); anything else is a no-op.
 */
function replayCloseout(ledger, hostSessionId, record) {
    const chain = ledger.enqueuedChain;
    if (ledger.decision === 'enqueued' && ledger.hostSessionId === hostSessionId && chain && typeof chain === 'object') {
        try {
            validateChainFields(chain);
            record('already-closed', { closedAt: ledger.closedAt, replayed: 'enqueued' });
            return chain;
        }
        catch {
            // fall through: a malformed stored chain is never replayed
        }
    }
    record('already-closed', { closedAt: ledger.closedAt });
    return null;
}
function decideChainLink(directory, ledger, ctx) {
    const { sessionId, intentId, outcome, reason, record } = ctx;
    // Ledger fields land in file names and spawned argv — validate before any
    // halt marker, lock, or handoff path is built from them.
    if (!INTENT_ID_PATTERN.test(intentId)) {
        record('invalid-ledger', { error: `invalid intentId: ${intentId}` });
        return null;
    }
    // Project file is authoritative. A ledger copy is a spawn-time snapshot kept
    // for the watchdog's stalled-link detection (watchdog.ts skips ledgers that
    // carry one), so it survives as a fallback — but never as an override, and
    // never unvalidated: a nested or stale copy used to halt the chain silently.
    const ledgerRoutes = ledger.routeTable === undefined ? null : normalizeRouteTable(ledger.routeTable);
    if (ledger.routeTable !== undefined && !ledgerRoutes) {
        record('malformed-route-table', { source: 'ledger', keys: Object.keys(ledger.routeTable).slice(0, 10) });
    }
    const routeTable = readProjectRoutes(directory) ?? ledgerRoutes ?? {};
    const directive = decideNextStage(outcome, reason, routeTable);
    if (!directive) {
        record('no-route');
        if (outcome === 'failed')
            writeHaltMarker(directory, intentId, `session-end:${reason}`);
        return null;
    }
    if (!LABEL_PATTERN.test(directive.stage) || !LABEL_PATTERN.test(directive.skill)) {
        record('invalid-ledger', { error: `invalid stage/skill: ${directive.stage}/${directive.skill}` });
        if (outcome === 'failed')
            writeHaltMarker(directory, intentId, `invalid-ledger:${reason}`);
        return null;
    }
    // Terminal route: the route table declares this stage as the end of the
    // chain (skill "stop" is reserved). Record and halt — no next link.
    if (directive.skill === 'stop') {
        record('chain-terminal', { stage: directive.stage });
        writeHaltMarker(directory, intentId, `terminal:${directive.stage}`);
        return null;
    }
    // Loop cap: this route already visited the next stage too many times
    // (e.g. failed:clear routing back to spec). Halt instead of burning slots.
    const visits = ledger.visits ?? {};
    const cap = stageVisitCap(ledger.maxStageVisits) ?? 2;
    if ((visits[directive.stage] ?? 0) >= cap) {
        record('chain-loop-capped', { stage: directive.stage, visits: visits[directive.stage], cap });
        writeHaltMarker(directory, intentId, `loop-capped:${directive.stage}`);
        return null;
    }
    if (ledger.gate) {
        const declared = ledger.gateFacts ?? DEFAULT_GATE_FACTS;
        // A declared mechanical pass must be backed by check evidence on disk;
        // missing or failing evidence overrides the flag to false (conservative:
        // an unverified gate grades human, same as an undeclared one).
        const facts = declared.mechanicalChecksPassed === true && !verifyCheckEvidence(getOmcRoot(directory), sessionId)
            ? { ...declared, mechanicalChecksPassed: false }
            : declared;
        const verdict = gradeGate(ledger.gate, facts);
        if (verdict.kind === 'human') {
            record('human-gate', { gate: ledger.gate, criterion: verdict.criterion });
            writeHaltMarker(directory, intentId, `human-gate:${ledger.gate}`);
            return null;
        }
        record('auto-pass', { gate: ledger.gate, signerFact: verdict.signerFact });
    }
    const slot = acquireChainSlot(intentId, factoryStateDir(directory));
    if (!slot.allowed) {
        // daily-cap already left its own stop marker inside acquireChainSlot.
        record('guardrail', { guardrail: slot.reason, detail: slot.detail });
        return null;
    }
    try {
        const chain = {
            outcome,
            reason,
            routeTable,
            sessionId,
            intentId,
            tracker: ledger.tracker,
            visits,
            // The cap is per chain, not per link: carry it so a later link keeps it.
            ...(stageVisitCap(ledger.maxStageVisits) !== undefined ? { maxStageVisits: stageVisitCap(ledger.maxStageVisits) } : {}),
        };
        validateChainFields(chain);
        // ponytail: the serial window closes here, before the worker actually
        // spawns the next link; v1 accepts the small race, same as the listener.
        record('enqueued', { stage: directive.stage, skill: directive.skill });
        return chain;
    }
    catch (error) {
        record('invalid-ledger', { error: error instanceof Error ? error.message : String(error) });
        return null;
    }
    finally {
        releaseChainSlot(slot);
    }
}
//# sourceMappingURL=chain-enqueuer.js.map