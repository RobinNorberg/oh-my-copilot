/**
 * The Azure DevOps Forge adapter (factory forges design §6, PR 5). Every
 * call is `az devops invoke` through the caller's guarded Exec (see
 * guard.ts for what the guard allows); the adapter never spawns.
 * Capabilities: heal only with a configured `factory.heal.pipeline` (ADO
 * parity design §3.2), no Projects v2, board columns, no webhook intake
 * (design §10.9).
 */
import type { Exec } from '../../ship/exec.js';
import type { Forge, ForgeOptions, ResolvedForgeConfig } from '../types.js';
import { type AzBinaryDeps, type AzEntry } from './az-binary.js';
import type { AdoGuardContext } from './guard.js';
export interface AzureDevOpsForgeOptions extends ForgeOptions {
    /** The resolved az entry; default resolveAzEntry(defaultAzBinaryDeps([cwd, ...untrustedRoots])). */
    entry?: AzEntry;
    /** Default process.env; OMG_ADO_RECORD_DIR there turns on fixture recording (record.ts). */
    env?: Readonly<Record<string, string | undefined>>;
}
/** The states the progress mapping may write: the only System.State values the guard lets through (design §7); none while progress is disabled. */
export declare const progressStates: (config: ResolvedForgeConfig) => string[];
/** The board columns the progress mapping may write (a column move can change the state); none while progress is disabled. */
export declare const progressColumns: (config: ResolvedForgeConfig) => string[];
/** Production az-binary deps: the real PATH, fs and realpathSync.native. */
export declare function defaultAzBinaryDeps(untrustedRoots: readonly string[], env?: Readonly<Record<string, string | undefined>>): AzBinaryDeps;
/** What the ADO guard needs for a run: the forge repo and the az entry the adapter spawns. */
export declare function adoGuardContext(config: ResolvedForgeConfig, entry: AzEntry): AdoGuardContext;
/** The heal guard context (ADO parity design §3.5): the forge repo and az entry, no progress values (the `read` policy refuses every write anyway). */
export declare function adoReadGuardContext(config: ResolvedForgeConfig, entry: AzEntry): AdoGuardContext;
export declare function createAzureDevOpsForge(exec: Exec, cwd: string, config: ResolvedForgeConfig, options: AzureDevOpsForgeOptions): Forge;
//# sourceMappingURL=index.d.ts.map