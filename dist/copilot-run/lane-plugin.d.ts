/** The events a lane registers: the PreToolUse guards and the PermissionRequest handler (as LANE_HOOK_EVENTS in scripts/copilot/dispatch.cjs). */
export declare const LANE_HOOK_EVENTS: readonly string[];
/** Set in each generated hook entry's env: dispatch.cjs then resets CLAUDE_PLUGIN_ROOT to its own plugin root. */
export declare const LANE_PLUGIN_MIRROR_ENV = "OMC_LANE_PLUGIN_MIRROR";
/** The lane plugin dir's name in the job home. */
export declare const LANE_PLUGIN_DIR = "lane-plugin";
interface HookEntry {
    env?: Record<string, string>;
    [key: string]: unknown;
}
interface HooksFile {
    hooks?: Record<string, HookEntry[]>;
    [key: string]: unknown;
}
/** The lane hooks file from the shipped one: only {@link LANE_HOOK_EVENTS}, each entry tagged with {@link LANE_PLUGIN_MIRROR_ENV}. */
export declare function buildLaneHooksFile(shipped: HooksFile): HooksFile;
/**
 * Build the lane plugin dir at `dest` (which must not exist) from
 * `pluginRoot`, and return it. Throws when the plugin has no root
 * `plugin.json` with a hooks file, or that file lacks a kept event.
 */
export declare function prepareLanePluginDir(pluginRoot: string, dest: string): string;
export {};
//# sourceMappingURL=lane-plugin.d.ts.map