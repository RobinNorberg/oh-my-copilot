/**
 * AI Credits budget reporting: `budget` settings from `.copilot/omg.jsonc`
 * and the hook side (record usage, SessionStart summary, the warn-only
 * `softLimit` notice). It never blocks, clamps or refuses anything: cost
 * control is Copilot's per-session `maxAiCredits` cap and admin budgets
 * (docs/MIGRATION.md). Everything here is fail-open: a bug or an unreadable
 * ledger yields no message, never a blocked session.
 *
 * Kill switch: `OMC_BUDGET_GOVERNOR=0` turns every part off.
 */
import { type BudgetLedger, type LedgerLockOptions } from './ledger.js';
/** `credits` (AI Credits, the billed unit) or legacy `premiumRequests`, for display. */
export type BudgetUnit = 'premiumRequests' | 'credits';
export interface BudgetSettings {
    enabled: boolean;
    /** Warn-only threshold in AI Credits: one notice per period, never a block. */
    softLimit?: number;
    /** Retired keys found in the config (`budget.mode`, ...); each one is a no-op. */
    deprecated: string[];
}
/** Validate a raw `budget` block; invalid values are dropped and reported, never thrown. */
export declare function resolveBudgetSettings(raw: unknown, env?: NodeJS.ProcessEnv): {
    settings: BudgetSettings;
    issues: string[];
};
/** The one deprecation warning for every retired key present. */
export declare function deprecationNotice(keys: readonly string[]): string;
/** User config, then `.copilot/omg.jsonc` of `cwd` (per-key override). */
export declare function loadBudgetSettings(cwd: string, env?: NodeJS.ProcessEnv): {
    settings: BudgetSettings;
    issues: string[];
};
export declare function hasLimits(s: BudgetSettings): boolean;
export declare function formatAmount(value: number, unit: BudgetUnit): string;
export declare function summaryLine(ledger: BudgetLedger, settings: BudgetSettings): string;
/** Mark a newly crossed soft limit in `ledger` and return the notice, or null. */
export declare function checkThresholds(ledger: BudgetLedger, settings: BudgetSettings, now?: Date): string | null;
/** CLI argv phases; not the hook type names (the registry shadow matches those in args). */
export type BudgetHookPhase = 'start' | 'submit' | 'turn';
export interface BudgetHookInput {
    phase: BudgetHookPhase;
    payload: Record<string, unknown> | null;
    env?: NodeJS.ProcessEnv;
    now?: Date;
    /** SessionStart refresh time budget (tests). */
    refreshDeadlineMs?: number;
}
/**
 * One hook invocation. Returns the hook stdout object, or null for no output.
 * Team worker sessions record under their team and never get notices; sdk
 * workers (`OMC_BUDGET_HOST_LEDGER=1`) are recorded by their host instead.
 */
export declare function runBudgetHook(input: BudgetHookInput): Record<string, unknown> | null;
/**
 * Upgrade estimated records (sessions and pane team workers) whose session
 * has since written its totals. Bounded: at most REFRESH_MAX records per call,
 * rotating through the candidates, a tail read each, skipped when the events
 * file is unchanged since the last check, and a REFRESH_DEADLINE_MS budget.
 * A record whose events file is gone is marked final. Records without scan
 * state (sdk host records) are their host's business.
 */
export declare function refreshEstimates(path: string, now: Date, lock?: LedgerLockOptions, deadlineMs?: number): void;
//# sourceMappingURL=governor.d.ts.map