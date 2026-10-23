/**
 * The generated Copilot hook manifest (copilot/hooks.json) and one entry run
 * exactly as Copilot CLI spawns it: `exec` + `args` with no shell, the
 * `${CLAUDE_PLUGIN_ROOT}` token replaced by the plugin root, the entry's `env`
 * on top, and the hook payload on stdin. Shared by the tier 2 CLI scenarios
 * (the ultragoal activation seed) and `omg hooks doctor` (the dry dispatch).
 */
import type { SpawnSyncFn } from './process-utils.js';
export declare const PLUGIN_ROOT_TOKEN = "${CLAUDE_PLUGIN_ROOT}";
export declare const COPILOT_HOOKS_PATH = "copilot/hooks.json";
export interface CopilotHookEntry {
    type: string;
    matcher?: string;
    exec: string;
    args: string[];
    env?: Record<string, string>;
    timeoutSec?: number;
}
export interface CopilotHookManifest {
    version: number;
    hooks: Record<string, CopilotHookEntry[]>;
}
/** Parse `<root>/copilot/hooks.json`; throws when it is missing or not a manifest. */
export declare function readCopilotHookManifest(root: string): CopilotHookManifest;
export declare function resolveEntryArgs(entry: CopilotHookEntry, root: string): string[];
/** No matcher matches every call; a matcher is an anchored regex over the (Claude-format) tool name. */
export declare function entryMatches(entry: CopilotHookEntry, toolName?: string): boolean;
/** Seconds Copilot would allow an entry before the extra grace the runner adds. */
export declare const DEFAULT_ENTRY_TIMEOUT_SEC = 30;
export interface HookDispatchResult {
    event: string;
    matcher: string | null;
    status: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
    error?: string;
}
export declare function dispatchHookEntry(event: string, entry: CopilotHookEntry, root: string, payload: unknown, opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    spawnSync: SpawnSyncFn;
}): HookDispatchResult;
//# sourceMappingURL=copilot-hook-manifest.d.ts.map