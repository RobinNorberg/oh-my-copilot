/**
 * Premium-request ledger: what Copilot billed (or what we estimate it billed)
 * per session and per team, stored at `<omgRoot>/state/budget-ledger.json`.
 *
 * Data sources, verified on Copilot CLI 1.0.91 and @github/copilot-sdk 1.0.16:
 * - CLI sessions persist `$COPILOT_HOME/session-state/<id>/events.jsonl`. Its
 *   `session.usage_checkpoint` and `session.shutdown` events carry cumulative
 *   `totalPremiumRequests` (multiplier applied) and `totalNanoAiu`
 *   (1e-9 AI credits). They are written at the end of a session, so a running
 *   session has no total yet: until then the ledger keeps an ESTIMATE of one
 *   premium request per top-level user prompt (`user.message` without an
 *   agent `source`) since the period start, multiplier and credits unknown.
 *   The events file is scanned incrementally (byte offset + count kept in the
 *   record), at most MAX_SCAN_BYTES per call.
 * - SDK team workers (`omg team` sdk transport) see live `assistant.usage`
 *   events; `sdk-host.ts` records those (estimated until the shutdown totals).
 *
 * Records are cumulative per session, so an update replaces the previous one,
 * except: measured never downgrades to estimated, an estimate never goes down,
 * and a measured total that drops (a resumed session restarting its counter)
 * keeps the larger value and says so. `omg budget reset` keeps per-record
 * baselines so a session running across the reset counts only what follows.
 * Writes hold a file lock and are atomic; every caller treats a ledger failure
 * as "no data" (fail-open).
 */
export type UsageSource = 'measured' | 'estimated';
/** Incremental read state of a session's events.jsonl. */
export interface EventsScan {
    /** Period start the prompt count belongs to (`scanSince(ledger)`). */
    since: string;
    /** Bytes consumed (always at a line boundary). */
    offset: number;
    /** Top-level prompts at or after `since` within the consumed bytes. */
    prompts: number;
    /** Last cumulative totals event seen. */
    totals?: {
        premium: number;
        nano: number;
        type: string;
    };
    model?: string;
    /** Size and mtime at the last SessionStart refresh (skip when unchanged). */
    checkedSize?: number;
    checkedMtimeMs?: number;
    /** The events file disappeared; the record is final. */
    gone?: true;
}
export interface UsageRecord {
    premiumRequests: number;
    /** AI credits (nano-AIU / 1e9); 0 when unknown. */
    credits: number;
    source: UsageSource;
    /** Where the numbers came from, e.g. `session.shutdown` or the estimate rule. */
    detail: string;
    model?: string;
    updatedAt: string;
    /** Present on records read from a Copilot CLI events file. */
    scan?: EventsScan;
}
/** Usage a record had accumulated before `omg budget reset` (cumulative sources subtract it). */
export interface UsageBaseline {
    premiumRequests: number;
    credits: number;
    source: UsageSource;
}
export interface BudgetLedger {
    version: 1;
    /** Start of the accounting period (ledger creation or the last `omg budget reset`). */
    since: string;
    sessions: Record<string, UsageRecord>;
    /** team name -> session or worker key -> usage */
    teams: Record<string, Record<string, UsageRecord>>;
    /** When each threshold was first crossed this period, and the limit it was crossed at. */
    notified: {
        soft?: string;
        hard?: string;
        softLimit?: number;
        hardLimit?: number;
    };
    /** Threshold message not yet shown to the user (delivered on the next prompt). */
    pendingNotice?: string;
    /** Set by `omg budget reset` (equals `since` then); prompts before it are not counted. */
    resetAt?: string;
    /** `s:<session>` / `t:<team>/<key>` -> usage before the last reset. */
    baselines?: Record<string, UsageBaseline>;
    /** Rotation point of the SessionStart refresh. */
    refreshCursor?: number;
}
export interface LedgerTotals {
    premiumRequests: number;
    credits: number;
    sessions: number;
    estimatedRecords: number;
    teams: Record<string, {
        premiumRequests: number;
        credits: number;
        records: number;
    }>;
}
export interface LedgerLockOptions {
    /** Lock wait; 0 tries once (skip on contention). Default 1000 ms. */
    timeoutMs?: number;
}
/** Bytes of events.jsonl parsed per call; the rest is picked up by the next call. */
export declare const MAX_SCAN_BYTES: number;
/** Tail read for the end-of-session totals. */
export declare const TAIL_BYTES: number;
/** Lock wait of hook processes: a hook must stay well inside its timeout. */
export declare const HOOK_LOCK_TIMEOUT_MS = 250;
export declare function ledgerPath(cwd: string): string;
export declare function emptyLedger(now?: Date): BudgetLedger;
export declare function readLedger(path: string): BudgetLedger;
/**
 * Start of the prompt count: the last `omg budget reset`. Before any reset
 * every prompt counts, like the cumulative totals the session writes.
 */
export declare function scanSince(ledger: BudgetLedger): string;
/**
 * Read-modify-write under the ledger lock. Throws when the lock is not
 * acquired. A corrupt or foreign-version ledger is copied to `<path>.corrupt`
 * before it is overwritten.
 */
export declare function updateLedger<T>(path: string, fn: (ledger: BudgetLedger) => T, opts?: LedgerLockOptions): T;
/**
 * Merge an update into the stored record: measured replaces an estimate, an
 * estimate never replaces a measured record or lowers an estimate, and a
 * measured total that drops keeps the larger value and flags it.
 */
export declare function mergeRecord(existing: UsageRecord | undefined, next: UsageRecord): UsageRecord;
/** Store one record in an already locked ledger. False when the key is unsafe or the update is stale. */
export declare function putRecord(ledger: BudgetLedger, key: string, usage: UsageRecord, team?: string): boolean;
export declare function recordUsage(path: string, key: string, usage: UsageRecord, team?: string, opts?: LedgerLockOptions): void;
/**
 * Start a new period: totals so far become per-record baselines (subtracted
 * from later cumulative totals), records and notices are cleared. Returns the
 * previous period's totals.
 */
export declare function resetLedger(ledger: BudgetLedger, now?: Date): {
    since: string;
} & LedgerTotals;
export declare function ledgerTotals(ledger: BudgetLedger): LedgerTotals;
/** `$COPILOT_HOME/session-state/<id>/events.jsonl`, or null for an unsafe id. */
export declare function copilotEventsPath(sessionId: string): string | null;
/** The last totals event in the final TAIL_BYTES of the file. */
export declare function readTailTotals(path: string, size: number): Totals | null;
type Totals = {
    premium: number;
    nano: number;
    type: string;
    model?: string;
};
export interface SessionUsageOptions {
    /** Period start; prompts before it are not counted. Default: count all. */
    since?: string;
    /** Scan state of the stored record: continue from its offset. */
    prev?: EventsScan;
    /** Per-call parse budget (tests). */
    maxScanBytes?: number;
}
/**
 * Usage of one Copilot CLI session from its persisted events: the last
 * `session.shutdown` or `session.usage_checkpoint` totals (measured), else
 * one premium request per top-level user prompt (estimated). Reads only the
 * bytes after `prev.offset`, at most `maxScanBytes`; when the file is larger
 * the count is partial (it only grows) and the tail is checked for totals.
 * Null when the file is missing, nothing was appended since `prev`, or it
 * holds no prompt.
 */
export declare function readCopilotSessionUsage(eventsPath: string, now?: Date, opts?: SessionUsageOptions): UsageRecord | null;
export {};
//# sourceMappingURL=ledger.d.ts.map