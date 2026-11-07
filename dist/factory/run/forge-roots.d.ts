/**
 * The ForgeOptions the factory hands createForge (critic amendments §A.13):
 * every root a lane or job can write, so the Azure CLI entry is never
 * resolved from one, and an engine-owned state directory outside them for
 * files a human later reads (the ADO merge body).
 *
 * - the repository checkout;
 * - its omg root (`.omg`, or OMC_STATE_DIR's project dir): the lane
 *   worktrees under `team/<team>/worktrees/` (factory-run, copilot-run) and
 *   the copilot_run job dirs under `state/copilot-run/`;
 * - the team job root (OMC_JOBS_DIR, else the global `team-jobs`).
 *
 * Also the factory's forge config load (factory forges design §3) and the
 * origin's forge kind for the GitHub-only commands.
 */
import { type LoadedForgeConfig } from '../../forge/config.js';
import type { ForgeKind, ForgeOptions } from '../../forge/types.js';
import { type Exec } from '../../ship/exec.js';
export declare function factoryForgeOptions(repoRoot: string, env?: NodeJS.ProcessEnv): ForgeOptions;
/**
 * Throws unless `options` names every root factoryForgeOptions lists for
 * `repoRoot` (critic amendments §A.14): `{ untrustedRoots: [] }` or any
 * partial list is refused, so no caller can resolve az from, or write the
 * merge body under, a root a lane writes.
 */
export declare function assertFactoryForgeOptions(repoRoot: string, options: ForgeOptions, env?: NodeJS.ProcessEnv): void;
/**
 * The forge config of a factory run: the user config at its default
 * location, `.copilot/omg.jsonc` committed on `origin/<base>` after a fetch
 * (absent: that layer is empty), the working-tree project config, and the
 * origin remote, through resolveForgeConfig's trust layering. The fetch
 * overwrites the tracking ref with the remote's, so a ref a lane moved
 * between runs is not read. Identity keys can only pin the origin's forge;
 * progress keys only narrow what the az guard lets the engine write.
 * `base` comes from the working tree, so a base outside ship.trustedBases
 * (resolveTrustedBases, as ship reads it) is neither fetched nor read: that
 * layer is empty, with a warning.
 */
export declare function loadFactoryForgeConfig(exec: Exec, root: string, base: string, trustedUser: unknown, project: unknown, opts?: {
    dryRun?: boolean;
}): LoadedForgeConfig;
/**
 * The run has no usable forge: no origin, an origin that is neither GitHub
 * nor Azure DevOps, or a configured forge the origin contradicts. Every
 * `omg factory` command exits 5 for it (F9), like check / board / setup.
 */
export declare class FactoryForgeUnavailableError extends Error {
    constructor(message: string);
}
/** Exit code of FactoryForgeUnavailableError (EXIT_CHECK_INCOMPATIBLE, setup's 5). */
export declare const EXIT_FORGE_UNAVAILABLE = 5;
/**
 * Create (once) and sync the local forge's bare mirror (offline forge plan
 * §1.1), through the engine's guarded, hardened Exec:
 * - `git init --bare` at `mirror` when it does not exist;
 * - the checkout's `omg-local` remote is added when missing; an existing one
 *   must point at `mirror` for fetch and for every push url
 *   (remoteRepoMismatch: a planted pushurl or insteadOf refuses);
 * - the local `<base>` is pushed to the mirror without `+`, so the sync is
 *   fast-forward only: a diverged mirror base refuses with a message;
 * - `git fetch omg-local <base>` updates `refs/remotes/omg-local/<base>`.
 * Returns the base sha. Throws (a plain Error) on any refusal.
 */
export declare function syncLocalMirror(exec: Exec, root: string, mirror: string, base: string): string;
/**
 * The forge kind the origin remote names; github when there is no origin or
 * it cannot be parsed (today's behaviour). For the GitHub-only commands
 * (`omg factory listen`, `omg factory heal`), which refuse Azure DevOps.
 */
export declare function originForgeKind(exec: Exec, root: string): ForgeKind;
//# sourceMappingURL=forge-roots.d.ts.map