/**
 * The Azure DevOps Forge adapter (factory forges design §6, PR 5). Every
 * call is `az devops invoke` through the caller's guarded Exec (see
 * guard.ts for what the guard allows); the adapter never spawns.
 * Capabilities: no heal, no Projects v2, board columns, no webhook intake
 * (design §10.9).
 */
import type { Exec } from '../../ship/exec.js';
import type { Forge, ResolvedForgeConfig } from '../types.js';
import { type AzBinaryDeps, type AzEntry } from './az-binary.js';
import type { AdoGuardContext } from './guard.js';
export interface AzureDevOpsForgeOptions {
    /** The resolved az entry; default resolveAzEntry(defaultAzBinaryDeps(untrustedRoots)). */
    entry?: AzEntry;
    /** Roots a lane or job can write (repository, worktrees, lane and job roots); cwd is always one. */
    untrustedRoots?: readonly string[];
    /** Default process.env; OMG_ADO_RECORD_DIR there turns on fixture recording (record.ts). */
    env?: Readonly<Record<string, string | undefined>>;
}
/** Production az-binary deps: the real PATH, fs and realpathSync.native. */
export declare function defaultAzBinaryDeps(untrustedRoots: readonly string[], env?: Readonly<Record<string, string | undefined>>): AzBinaryDeps;
/** What the ADO guard needs for a run: the forge repo and the az entry the adapter spawns. */
export declare function adoGuardContext(config: ResolvedForgeConfig, entry: AzEntry): AdoGuardContext;
export declare function createAzureDevOpsForge(exec: Exec, cwd: string, config: ResolvedForgeConfig, options?: AzureDevOpsForgeOptions): Forge;
//# sourceMappingURL=index.d.ts.map