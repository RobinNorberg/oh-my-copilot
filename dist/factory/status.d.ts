/**
 * Factory chain audit view (D2): a read-only summary of what the chain did in
 * this project. Everything here reads the same durable artifacts the runtime
 * writes — the decisions trail, stop markers, link ledgers, the authoritative
 * route table — so the view can never disagree with the state the chain left
 * behind. Pure reads; no locking, no writes.
 */
import { type StalledLink } from './watchdog.js';
/** One link of a chain, from its ledger `chain-<chainLink>.json`. */
export interface ChainLinkSummary {
    chainLink: string;
    stage: string;
    /** Host binary that ran the link (absent on ledgers written before v5.7.1). */
    host?: string;
    parentLink?: string;
    createdAt?: string;
    /** Set once the link's SessionEnd consumed the ledger. */
    closedAt?: string;
    /** Host session that ended the link; differs from chainLink on Copilot. */
    hostSessionId?: string;
    outcome?: string;
    /** The enqueuer decision that closed the link. */
    decision?: string;
}
export interface ChainIntentSummary {
    intentId: string;
    decisionCount: number;
    /** decision name -> occurrences, e.g. { enqueued: 3, 'chain-terminal': 1 }. */
    counts: Record<string, number>;
    lastDecision?: string;
    /** ISO 8601, from the decision record. */
    lastDecisionAt?: string;
    stopped?: {
        reason: string;
        stoppedAt: string;
    };
    /** The chain's links in spawn order (ledgers still on disk). */
    links: ChainLinkSummary[];
}
export interface ChainStatus {
    directory: string;
    /** Keys of the project route table (the single authority, upstream #4176). */
    routeKeys: string[];
    /** Link ledgers on disk that no SessionEnd has closed yet (running or stalled links). */
    activeLedgers: number;
    /** Most-recently-active first. */
    intents: ChainIntentSummary[];
    stalled: StalledLink[];
}
export declare function readChainStatus(directory: string, now?: Date): ChainStatus;
//# sourceMappingURL=status.d.ts.map