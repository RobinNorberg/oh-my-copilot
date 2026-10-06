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
import { type ChainOutcome, type GateFacts, type GateName, type RouteTable } from './routing.js';
import { type ChainLinkHost, type SpawnNextChain, type SpawnNextTracker } from './spawn-next.js';
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
    /** The chain this link enqueued; replayed to a duplicate SessionEnd of the same host session. */
    enqueuedChain?: SpawnNextChain;
    /** Copilot: the host session that claimed the link at its SessionStart (bindChainLink). */
    boundSessionId?: string;
    boundAt?: string;
}
/**
 * Explicit success allowlist, fail-closed for anything else. Headless sessions
 * that run to completion report 'other' on Claude (no failure signal in the
 * SessionEnd payload) and 'complete' on Copilot CLI (verified on 1.0.91: a
 * finished `-p` link sends `reason: "complete"`), so both count as a normal
 * exit; 'clear' wipes the chain session's context and halts the chain;
 * unknown reasons stay failed.
 */
export declare function sessionEndOutcome(reason: string): ChainOutcome;
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
export declare function resolveChainLink(directory: string, hostSessionId: string, env?: NodeJS.ProcessEnv): ChainLinkResolution;
/**
 * SessionStart side of the chain-link identity (Copilot): the first session
 * that starts with OMC_CHAIN_LINK naming an open Copilot ledger binds the link
 * to its host session id. The bind is an exclusive create, so of two sessions
 * holding the same inherited value only the first (the link itself; a nested
 * session starts during the link's turn, after its SessionStart) wins.
 * Returns what happened, for the audit trail; never throws.
 */
export declare function bindChainLink(directory: string, hostSessionId: string, env?: NodeJS.ProcessEnv): string;
/**
 * The caller could not hand an enqueued chain to the worker (no manifest, or
 * the worker did not spawn): record that against the link and correct the
 * closed ledger, which would otherwise claim `enqueued` for a chain nothing
 * will run.
 */
export declare function recordChainHandoffFailure(directory: string, chain: Pick<SpawnNextChain, 'sessionId' | 'intentId'>, decision: 'manifest-unavailable' | 'worker-spawn-failed' | 'enqueued-failed', extra?: Record<string, unknown>): void;
export declare function factoryStateDir(directory: string): string;
export declare function readChainLedger(directory: string, sessionId: string): ChainLedger | null;
/** Project-level route table: `.omg/factory-routes.json`. The single source of truth. */
export declare function readProjectRoutes(directory: string): RouteTable | null;
/** Decision audit trail; also used by the worker to correct the record when a spawn fails. */
export declare function recordChainDecision(directory: string, record: Record<string, unknown>): void;
/**
 * Decide whether the ending session continues its chain. Returns the chain
 * payload to merge into the durable SessionEnd payload, or null (no ledger,
 * no route, human gate, guardrail, or invalid ledger — each recorded).
 */
export declare function planChainEnqueue(directory: string, hostSessionId: string, reason: string, env?: NodeJS.ProcessEnv): SpawnNextChain | null;
//# sourceMappingURL=chain-enqueuer.d.ts.map