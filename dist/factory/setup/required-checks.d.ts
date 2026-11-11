/**
 * What the gates will require on GitHub (M1), for `omg factory setup` and
 * `omg factory check`: the configured `ship.requiredChecks`, else the base's
 * branch protection / rulesets, else every check GitHub reports for the PR
 * head; and the checks the base's latest commit reported, so a configured
 * name that matches nothing is a warning before a run waits on it. Reads
 * only (the exact GETs of src/forge/github/checks.ts).
 */
import type { Exec } from '../../ship/exec.js';
export interface GateRequirement {
    notes: string[];
    warnings: string[];
}
/** `configured`: the trusted ship.requiredChecks ([] = none); `where`: where the user changes it. */
export declare function gateRequirement(exec: Exec, repoArg: string, base: string, configured: readonly string[], where: string, cwd?: string): GateRequirement;
//# sourceMappingURL=required-checks.d.ts.map