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
 */
import type { ForgeOptions } from '../../forge/types.js';
export declare function factoryForgeOptions(repoRoot: string, env?: NodeJS.ProcessEnv): ForgeOptions;
//# sourceMappingURL=forge-roots.d.ts.map