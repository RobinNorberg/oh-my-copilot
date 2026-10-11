/**
 * OMC HUD - Copilot premium-request budget (src/budget).
 *
 * `prq:12/300` (or `cr:4.2/50` with budget.unit "credits") against the hard
 * limit, else the soft limit. A leading `~` means part of the total is an
 * estimate. Yellow from the soft limit, red from the hard limit. Hidden when
 * no budget limit is configured or the governor is off.
 */
export declare function renderPremiumBudget(cwd: string): string | null;
//# sourceMappingURL=premium-budget.d.ts.map