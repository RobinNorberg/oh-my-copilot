/**
 * `createForge`: the adapter for a resolved forge config (factory forges
 * design §2). The registry has one slot per kind, GitHub (PR 2) and Azure
 * DevOps (PR 5); each lane replaces only its own import line and slot line,
 * which are kept apart so the two edits merge cleanly. Adapters receive the
 * caller's already-guarded Exec and never spawn.
 */

// GitHub adapter import (PR 2).
import type { Exec } from '../ship/exec.js';
// Azure DevOps adapter import (PR 5).
import type { Forge, ForgeFactory, ForgeKind, ResolvedForgeConfig } from './types.js';

export type * from './types.js';
export { detectForgeRepo, ForgeConfigError, isTrustedAdoAuthor, resolveForgeConfig, type LoadedForgeConfig } from './config.js';

/** One slot per forge kind; undefined until that adapter lands. */
const ADAPTERS: Readonly<Record<ForgeKind, ForgeFactory | undefined>> = {
  github: undefined,
  // (slots kept on separate lines for the PR 2 / PR 5 edits)
  'azure-devops': undefined,
};

export function createForge(exec: Exec, cwd: string, config: ResolvedForgeConfig): Forge {
  const factory = ADAPTERS[config.kind];
  if (!factory) throw new Error(`no forge adapter for ${config.kind} in this build`);
  const forge = factory(exec, cwd, config);
  if (forge.kind !== config.kind) throw new Error(`forge adapter for ${config.kind} returned a ${forge.kind} forge`);
  return forge;
}
