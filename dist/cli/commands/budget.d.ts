/**
 * `omg budget [status|reset] [--json]`: the AI Credits usage ledger
 * (src/budget) against the warn-only `budget.softLimit` of `.copilot/omg.jsonc`.
 * Reporting only: status always exits 0.
 */
export declare function budgetCommand(action: string, options: {
    json?: boolean;
}, cwd?: string): Promise<number>;
//# sourceMappingURL=budget.d.ts.map