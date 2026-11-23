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
import type { ForgeKind } from '../../forge/types.js';
import { type FactoryRunLimits } from '../run/budget.js';
import { type FactoryRunKey, type FactoryRunState, type OwnerDeps } from '../run/state.js';
import { type AttentionGroup, type NextCommand } from './actions.js';
export declare const ATTENTION_SCHEMA_VERSION = 1;
/** A live engine with no progress event for this long is "possibly hung" (a hint only: the log is unsealed). */
export declare const HUNG_AFTER_MS: number;
export declare const TITLE_MAX = 60;
/** A state, heal or owner file larger than this is not read (an "unreadable" row). */
export declare const READ_MAX_BYTES: number;
/**
 * `ok` the engine's own state; `seal` its integrity seal fails; `ledger` the
 * engine ledger holds other bytes (or cannot be read); `unverified` this
 * host's ledger has no record of it; `owner` an owner file the engine did
 * not write; `missing` the ledger records a state file that is gone;
 * `unreadable` the file cannot be read.
 */
export type AttentionTrust = 'ok' | 'seal' | 'ledger' | 'unverified' | 'owner' | 'missing' | 'unreadable';
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
    /** --verbose / --json: the run's reason, sanitised (never gate.detail); trusted rows only. */
    reason?: string;
    /**
     * An untrusted row only: the read or parse error, sanitised. It can quote the file's own bytes and a local path, so it
     * is never in `why`; the CLI prints it with --verbose only, and no other surface (HUD, poll, notification) uses it.
     */
    error?: string;
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
    /** Each run's final read (after the live-engine reread), so the dashboard reuses it instead of reading the state again. */
    onRead?: (r: ReadRun) => void;
}
/**
 * At most this many state files the engine has no record of (run states and,
 * apart, heal records) are read per repository: a lane can write any number
 * of files into `.omg/state/factory`, and each one costs about 0.7 ms to
 * check on Windows (open dominates). Every run (and heal seal) the engine
 * ledger records is read on top of these: that set lives outside the
 * repository and grows only with the engine's own runs.
 */
export declare const MAX_UNRECORDED_STATES = 200;
/**
 * The run keys to read in a repository, chosen so that flooding the state dir
 * cannot push an engine run out: every run the engine ledger records (the
 * ledger lives outside the repository and holds the engine's own runs only),
 * then up to `max` other canonical state files in ascending key order, however
 * many runs are recorded. `omitted` counts the unrecorded state files left unread.
 */
export declare function runKeysToRead(root: string, ledgerDir: string, max?: number): {
    keys: FactoryRunKey[];
    omitted: number;
};
/** The one Inspect row (and warning) that stands for the state files left unread. */
export declare function omittedStatesNote(omitted: number): string;
/** The run key of a canonical `run-<key>.json` name; null for anything else (`run-01.json` is not run 1's file). */
export declare function runKeyOfName(name: string): FactoryRunKey | null;
type FileRead = {
    bytes: Buffer;
} | {
    missing: true;
} | {
    error: string;
};
/**
 * One bounded read of a regular file: lstat first (a link, FIFO, device or
 * directory is refused without being opened), then the opened file must be
 * that same regular file and no larger than READ_MAX_BYTES.
 */
export declare function readRegularFile(path: string, max?: number): FileRead;
export interface ReadRun {
    key: FactoryRunKey;
    /**
     * The parsed state, also when it failed a check. Callers must not use its
     * free text (title, reasons, notes, lane ids) or its numbers (credits,
     * requests, times) unless `trust` is `ok`: only enum-shaped values that are
     * validated against the known set may be shown for any other trust.
     */
    state?: FactoryRunState;
    trust: AttentionTrust;
    error?: string;
    /** The state file does not exist. */
    missing?: true;
}
/** One read of the state bytes; seal, then the ledger on those same bytes. */
export declare function readRun(root: string, key: FactoryRunKey, ledgerDir: string): ReadRun;
/** Every `why` a row whose trust is not `ok` can have: fixed engine sentences, no text from a file. */
export declare const UNTRUSTED_WHY: ReadonlySet<string>;
/** The runs whose state file is gone while the engine ledger records an unfinished last write (an Inspect `missing` row each). */
export declare function missingRunKeys(root: string, ledgerDir: string): FactoryRunKey[];
/** One render scope: the state root is resolved once, not once per file path (dozens of git-metadata stats each on Windows). */
export declare function collectAttention(root: string, o: CollectAttentionOptions): AttentionData;
/** The `--json` shape: the items without their sort key, notes and log kept; a reason only on a trusted row. */
export declare function attentionJson(d: AttentionData): Record<string, unknown>;
export {};
//# sourceMappingURL=collect.d.ts.map