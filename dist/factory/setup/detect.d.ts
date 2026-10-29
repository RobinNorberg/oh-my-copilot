/**
 * Step 1 of `omg factory setup` (factory forges design §4): the forge comes
 * from the origin remote (detectForgeRepo). Flags may pin it, never redirect
 * it: a `--forge`, `--org`, `--project` or `--repo` that disagrees with the
 * remote is a forge mismatch (exit 5), like resolveForgeConfig's rule.
 * `.omg/config.json` `ado` (the ADO skills' config) and an existing
 * `factory.forge` only prefill answers.
 */
import type { ForgeRepo } from '../../forge/types.js';
import type { Exec } from '../../ship/exec.js';
export interface ForgePins {
    forge?: string;
    org?: string;
    project?: string;
    /** GitHub `owner/name`; ADO repository name. */
    repo?: string;
}
export interface SetupPrefill {
    team?: string;
    areaPath?: string;
    workItemType?: string;
}
export interface DetectedForge {
    repo: ForgeRepo;
    originUrl: string;
    prefill: SetupPrefill;
}
export declare function readOrigin(exec: Exec, cwd: string): string | undefined;
/**
 * @param configs parsed config layers (user, project) read for prefill only
 */
export declare function detectSetupForge(exec: Exec, cwd: string, pins: ForgePins, configs?: unknown[]): DetectedForge;
/**
 * `omg factory listen` is GitHub-only (critic amendments §A.12): it receives
 * GitHub webhooks. The refusal text when the repository's forge, or the
 * trusted user config's `factory.forge.kind`, is Azure DevOps; undefined otherwise.
 */
export declare function listenForgeRefusal(exec: Exec, cwd: string, trustedUser: unknown): string | undefined;
//# sourceMappingURL=detect.d.ts.map