/**
 * `createForge`: the adapter for a resolved forge config (factory forges
 * design §2). The registry has one slot per kind, GitHub (PR 2) and Azure
 * DevOps (PR 5); each lane replaces only its own import line and slot line,
 * which are kept apart so the two edits merge cleanly. Adapters receive the
 * caller's already-guarded Exec and never spawn.
 */
import type { Exec } from '../ship/exec.js';
import type { Forge, ResolvedForgeConfig } from './types.js';
export type * from './types.js';
export { detectForgeRepo, ForgeConfigError, isTrustedAdoAuthor, resolveForgeConfig, type LoadedForgeConfig } from './config.js';
export declare function createForge(exec: Exec, cwd: string, config: ResolvedForgeConfig): Forge;
//# sourceMappingURL=index.d.ts.map