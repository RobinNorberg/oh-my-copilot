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
import type { ForgeKind } from '../../forge/types.js';
import { type FactoryRunLimits } from '../run/budget.js';
import { type OwnerDeps } from '../run/state.js';
import { type AttentionGroup, type NextCommand } from './actions.js';
export declare const ATTENTION_SCHEMA_VERSION = 1;
/** A live engine with no progress event for this long is "possibly hung" (a hint only: the log is unsealed). */
export declare const HUNG_AFTER_MS: number;
export declare const TITLE_MAX = 60;
export type AttentionTrust = 'ok' | 'seal' | 'ledger' | 'unreadable';
export interface AttentionItem {
    /** `#12`, `heal-0123abcd`, or `checkout` for the tamper hold. */
    key: string;
    group: AttentionGroup;
    gate: string | null;
    phase: string | null;
    ageMs: number | null;
    credits: number | null;
    cap: number | null;
    pr: number | null;
    head: string | null;
    title: string;
    why: string;
    /** --verbose / --json: the run's reason, sanitised (never gate.detail). */
    reason?: string;
    next: NextCommand[];
    trust: AttentionTrust;
    /** Hints, never acted on: "possibly hung", "near the credit cap", "cancel requested". */
    notes: string[];
    /** Where to look: the progress log, relative to the repository root. */
    log?: string;
    /** Sort key (ms since epoch), not in the JSON. */
    at: number;
}
export interface AttentionData {
    schemaVersion: typeof ATTENTION_SCHEMA_VERSION;
    repo: string;
    forge: ForgeKind | 'mixed' | null;
    generatedAt: string;
    summary: {
        byGroup: Record<AttentionGroup, number>;
        engines: {
            live: number;
            runs: string[];
        };
    };
    items: AttentionItem[];
    warnings: string[];
    /** True when a run state could not be read at all (exit 1). */
    readFailed: boolean;
}
export interface CollectAttentionOptions {
    ledgerDir: string;
    now?: () => number;
    /** The configured run limits (cap); null when they could not be resolved. */
    limits?: FactoryRunLimits | null;
    owner?: OwnerDeps;
    verbose?: boolean;
}
/** One render scope: the state root is resolved once, not once per file path (dozens of git-metadata stats each on Windows). */
export declare function collectAttention(root: string, o: CollectAttentionOptions): AttentionData;
/** The `--json` shape: the items without their sort key, notes and log kept. */
export declare function attentionJson(d: AttentionData): Record<string, unknown>;
//# sourceMappingURL=collect.d.ts.map