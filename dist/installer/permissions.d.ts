/**
 * Permission auto-approval configuration for oh-my-copilot.
 * Three-tier system: Tier 1 (read-only auto-approve), Tier 2 (write auto-approve), Tier 3 (always prompt).
 */
/** Tools that should NEVER be auto-approved (Tier 3) */
export declare const DANGEROUS_TOOLS: string[];
/** Generate the full Tier 1 + Tier 2 permission allowlist */
export declare function generatePermissionAllowList(): string[];
//# sourceMappingURL=permissions.d.ts.map