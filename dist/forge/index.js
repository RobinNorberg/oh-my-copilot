/**
 * `createForge`: the adapter for a resolved forge config (factory forges
 * design §2). The registry has one slot per kind, GitHub (PR 2) and Azure
 * DevOps (PR 5); each lane replaces only its own import line and slot line,
 * which are kept apart so the two edits merge cleanly. Adapters receive the
 * caller's already-guarded Exec and never spawn.
 */
// Azure DevOps adapter import (PR 5).
import { createAzureDevOpsForge } from './ado/index.js';
export { detectForgeRepo, ForgeConfigError, isTrustedAdoAuthor, resolveForgeConfig } from './config.js';
/** One slot per forge kind; undefined until that adapter lands. */
const ADAPTERS = {
    github: undefined,
    // (slots kept on separate lines for the PR 2 / PR 5 edits)
    'azure-devops': (exec, cwd, config) => createAzureDevOpsForge(exec, cwd, config),
};
export function createForge(exec, cwd, config) {
    const factory = ADAPTERS[config.kind];
    if (!factory)
        throw new Error(`no forge adapter for ${config.kind} in this build`);
    const forge = factory(exec, cwd, config);
    if (forge.kind !== config.kind)
        throw new Error(`forge adapter for ${config.kind} returned a ${forge.kind} forge`);
    return forge;
}
//# sourceMappingURL=index.js.map