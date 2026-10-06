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
import { decideNextStage, gradeGate, normalizeRouteTable, type ChainOutcome, type GateFacts, type GateName, type RouteTable } from './routing.js';
import { acquireChainSlot, releaseChainSlot, INTENT_ID_PATTERN } from './guardrails.js';
import { verifyCheckEvidence } from './check-evidence.js';
import { CHAIN_LINK_ENV, isStageVisitCap, validateChainFields, LABEL_PATTERN, type ChainLinkHost, type SpawnNextChain, type SpawnNextTracker } from './spawn-next.js';
import { getOmcRoot, validateSessionId } from '../../lib/worktree-paths.js';

export interface ChainLedger {
  intentId?: string;
  stage?: string;
  routeTable?: RouteTable;
  tracker?: SpawnNextTracker;
  gate?: GateName;
  gateFacts?: GateFacts;
  /** Per-stage link counts carried forward; guards against route-table self-loops. */
  visits?: Record<string, number>;
  /** Cap on visits to any one stage before the chain halts. Default 2. */
  maxStageVisits?: number;
  /** Link identity: the id this ledger is named after (`chain-<chainLink>.json`). */
  chainLink?: string;
  /** Host binary that runs the link. A Copilot link resolves its ledger via CHAIN_LINK_ENV. */
  host?: ChainLinkHost;
  createdAt?: string;
  /** Link id of the link whose SessionEnd spawned this one. */
  parentLink?: string;
  /** Closeout, written by this link's SessionEnd: the ledger is consumed once. */
  closedAt?: string;
  /** Host session id that ended the link (differs from chainLink on Copilot). */
  hostSessionId?: string;
  endReason?: string;
  outcome?: ChainOutcome;
  /** The enqueuer decision that closed the link (enqueued, chain-terminal, no-route, ...). */
  decision?: string;
}

/**
 * Explicit success allowlist, fail-closed for anything else. Headless sessions
 * that run to completion report 'other' on Claude (no failure signal in the
 * SessionEnd payload) and 'complete' on Copilot CLI (verified on 1.0.91: a
 * finished `-p` link sends `reason: "complete"`), so both count as a normal
 * exit; 'clear' wipes the chain session's context and halts the chain;
 * unknown reasons stay failed.
 */
export function sessionEndOutcome(reason: string): ChainOutcome {
  return reason === 'prompt_input_exit' || reason === 'logout' || reason === 'other' || reason === 'complete'
    ? 'success'
    : 'failed';
}

export interface ChainLinkResolution {
  /** Id the ledger, decisions, and check evidence are keyed by. */
  linkId: string;
  /** `env`: CHAIN_LINK_ENV named a trusted Copilot ledger; `session`: the host session id. */
  source: 'env' | 'session';
  /** Why a present CHAIN_LINK_ENV was not trusted. */
  rejected?: string;
}

/**
 * The ending session's chain-link identity: CHAIN_LINK_ENV when it names a
 * trusted ledger, else the host session id (the Claude path, unchanged).
 *
 * The env var is only trusted when `chain-<id>.json` exists, parses, and
 * records `host: "copilot"` and `chainLink: <id>`, and the ending session is
 * not a Claude one. A closed ledger resolves, and planChainEnqueue records the
 * replay as `already-closed`. The ledger file, written by the spawner, is the
 * trust anchor, so setting the env var alone can neither inject a chain nor
 * replay a consumed link.
 */
export function resolveChainLink(directory: string, hostSessionId: string, env: NodeJS.ProcessEnv = process.env): ChainLinkResolution {
  const claimed = env[CHAIN_LINK_ENV]?.trim();
  if (!claimed) return { linkId: hostSessionId, source: 'session' };
  const reject = (rejected: string): ChainLinkResolution => ({ linkId: hostSessionId, source: 'session', rejected });
  try {
    validateSessionId(claimed);
  } catch {
    return reject('invalid id');
  }
  // A Claude session nested inside a Copilot link inherits the var; only a
  // Copilot SessionEnd may claim a Copilot link (Claude hooks carry this marker).
  if (env.CLAUDE_CODE_ENTRYPOINT) return reject('not a copilot session');
  const ledger = readChainLedger(directory, claimed);
  if (!ledger) return reject('no ledger');
  if (ledger.host !== 'copilot') return reject(`ledger host ${String(ledger.host ?? 'unset')}`);
  if (ledger.chainLink !== claimed) return reject('ledger chainLink mismatch');
  // A closed ledger still resolves: planChainEnqueue then records the replay
  // as `already-closed` and enqueues nothing.
  return { linkId: claimed, source: 'env' };
}

type ChainLedgerCloseout = Pick<ChainLedger, 'hostSessionId' | 'endReason' | 'outcome' | 'decision'>;

/** Atomic JSON write (temp file + rename): status and the watchdog never read a torn ledger. */
function writeLedgerAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, path);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw error;
  }
}

/**
 * Consume a link ledger: record who ended it and how. A closed ledger is never
 * enqueued again (a duplicate SessionEnd is a no-op) and is not a stalled link.
 */
function closeChainLedger(directory: string, linkId: string, ledger: ChainLedger, closeout: ChainLedgerCloseout): void {
  try {
    writeLedgerAtomic(
      join(factoryStateDir(directory), `chain-${linkId}.json`),
      { ...ledger, ...closeout, closedAt: new Date().toISOString() },
    );
  } catch {
    // best-effort closeout; the decision trail still names the outcome
  }
}

/**
 * The caller could not hand an enqueued chain to the worker (no manifest, or
 * the worker did not spawn): record that against the link and correct the
 * closed ledger, which would otherwise claim `enqueued` for a chain nothing
 * will run.
 */
export function recordChainHandoffFailure(directory: string, chain: Pick<SpawnNextChain, 'sessionId' | 'intentId'>, decision: 'manifest-unavailable' | 'worker-spawn-failed'): void {
  recordChainDecision(directory, { decision, sessionId: chain.sessionId, intentId: chain.intentId });
  const ledger = readChainLedger(directory, chain.sessionId);
  if (!ledger?.closedAt) return;
  try {
    writeLedgerAtomic(join(factoryStateDir(directory), `chain-${chain.sessionId}.json`), { ...ledger, decision });
  } catch {
    // best-effort; the decision trail names the failure
  }
}

export function factoryStateDir(directory: string): string {
  return join(getOmcRoot(directory), 'state', 'factory');
}

export function readChainLedger(directory: string, sessionId: string): ChainLedger | null {
  try {
    validateSessionId(sessionId);
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(join(factoryStateDir(directory), `chain-${sessionId}.json`), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as ChainLedger;
  } catch {
    return null;
  }
}

/** Project-level route table: `.omg/factory-routes.json`. The single source of truth. */
export function readProjectRoutes(directory: string): RouteTable | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(join(getOmcRoot(directory), 'factory-routes.json'), 'utf8'));
    return normalizeRouteTable(parsed);
  } catch {
    return null;
  }
}

function recordDecision(directory: string, record: Record<string, unknown>): void {
  recordChainDecision(directory, record);
}

/** Decision audit trail; also used by the worker to correct the record when a spawn fails. */
export function recordChainDecision(directory: string, record: Record<string, unknown>): void {
  try {
    fs.mkdirSync(factoryStateDir(directory), { recursive: true });
    fs.appendFileSync(
      join(factoryStateDir(directory), 'chain-decisions.jsonl'),
      `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`,
      'utf8',
    );
  } catch {
    // best-effort audit trail
  }
}

function writeHaltMarker(directory: string, intentId: string, reason: string): void {
  try {
    fs.mkdirSync(factoryStateDir(directory), { recursive: true });
    fs.writeFileSync(
      join(factoryStateDir(directory), `chain-${intentId}.stopped.json`),
      JSON.stringify({ intentId, reason, stoppedAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
  } catch {
    // best-effort halt marker
  }
}

const DEFAULT_GATE_FACTS: GateFacts = {
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
export function planChainEnqueue(directory: string, hostSessionId: string, reason: string, env: NodeJS.ProcessEnv = process.env): SpawnNextChain | null {
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
    if (!ledger) return null;

    const outcome = sessionEndOutcome(reason);
    const intentId = typeof ledger.intentId === 'string' && ledger.intentId ? ledger.intentId : `chain-${sessionId}`;
    const identity = {
      sessionId,
      ...(sessionId !== hostSessionId ? { hostSessionId } : {}),
      ...(ledger.host ? { host: ledger.host } : {}),
    };
    let lastDecision: string | undefined;
    const record = (decision: string, extra: Record<string, unknown> = {}) => {
      lastDecision = decision;
      recordDecision(directory, { decision, ...identity, outcome, reason, intentId, ...extra });
    };
    // A link is consumed once: a second SessionEnd for the same ledger (e.g.
    // both the plugin and the settings.json forwarder registered) is a no-op.
    if (ledger.closedAt) {
      record('already-closed', { closedAt: ledger.closedAt });
      return null;
    }
    try {
      return decideChainLink(directory, ledger, { sessionId, intentId, outcome, reason, record });
    } catch (error) {
      record('enqueue-error', { error: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      closeChainLedger(directory, sessionId, ledger, { hostSessionId, endReason: reason, outcome, decision: lastDecision });
    }
  } catch {
    // Session end must never fail because of chain bookkeeping.
    return null;
  }
}

interface ChainLinkContext {
  sessionId: string;
  intentId: string;
  outcome: ChainOutcome;
  reason: string;
  record: (decision: string, extra?: Record<string, unknown>) => void;
}

function decideChainLink(directory: string, ledger: ChainLedger, ctx: ChainLinkContext): SpawnNextChain | null {
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
    record('malformed-route-table', { source: 'ledger', keys: Object.keys(ledger.routeTable as object).slice(0, 10) });
  }
  const routeTable = readProjectRoutes(directory) ?? ledgerRoutes ?? {};

  const directive = decideNextStage(outcome, reason, routeTable);
  if (!directive) {
    record('no-route');
    if (outcome === 'failed') writeHaltMarker(directory, intentId, `session-end:${reason}`);
    return null;
  }
  if (!LABEL_PATTERN.test(directive.stage) || !LABEL_PATTERN.test(directive.skill)) {
    record('invalid-ledger', { error: `invalid stage/skill: ${directive.stage}/${directive.skill}` });
    if (outcome === 'failed') writeHaltMarker(directory, intentId, `invalid-ledger:${reason}`);
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
  const cap = isStageVisitCap(ledger.maxStageVisits) ? ledger.maxStageVisits : 2;
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
    const chain: SpawnNextChain = {
      outcome,
      reason,
      routeTable,
      sessionId,
      intentId,
      tracker: ledger.tracker,
      visits,
      // The cap is per chain, not per link: carry it so a later link keeps it.
      ...(isStageVisitCap(ledger.maxStageVisits) ? { maxStageVisits: ledger.maxStageVisits } : {}),
    };
    validateChainFields(chain);
    // ponytail: the serial window closes here, before the worker actually
    // spawns the next link; v1 accepts the small race, same as the listener.
    record('enqueued', { stage: directive.stage, skill: directive.skill });
    return chain;
  } catch (error) {
    record('invalid-ledger', { error: error instanceof Error ? error.message : String(error) });
    return null;
  } finally {
    releaseChainSlot(slot);
  }
}
