/**
 * OMC HUD - Copilot AI Credits budget (src/budget).
 *
 * `cr:4.2/50`: AI credits used against the warn-only `budget.softLimit`. A
 * leading `~` means part of the total is an estimate. Yellow from the soft
 * limit. Hidden when no soft limit is configured or the governor is off,
 * except on the Copilot host, which then shows the session's credits (`cr:0.4`).
 */
/** Session AI Credits from the Copilot statusline payload (`ai_used`). */
export interface SessionAiUsed {
    nanoAiu: number | null;
    formatted: string | null;
}
/**
 * @param sessionAiUsed Copilot host only: the session's `ai_used`, shown when
 *   no budget limit is configured. Claude passes nothing and keeps the old rule.
 */
export declare function renderPremiumBudget(cwd: string, sessionAiUsed?: SessionAiUsed | null): string | null;
//# sourceMappingURL=premium-budget.d.ts.map