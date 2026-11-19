/** The events a lane registers: the PreToolUse guards and the PermissionRequest handler (as LANE_HOOK_EVENTS in scripts/copilot/dispatch.cjs). */
export declare const LANE_HOOK_EVENTS: readonly string[];
/** Set in each generated hook entry's env: dispatch.cjs then resets CLAUDE_PLUGIN_ROOT to its own plugin root. */
export declare const LANE_PLUGIN_MIRROR_ENV = "OMC_LANE_PLUGIN_MIRROR";
/** The lane plugin dir's name in the job home. */
export declare const LANE_PLUGIN_DIR = "lane-plugin";
/** The marker file in a lane plugin dir: what the sweep recognises, with the building engine's pid. */
export declare const LANE_PLUGIN_MARKER = ".omg-lane-plugin.json";
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
 * `plugin.json` with a hooks file, or that file lacks a kept event; a dir
 * left half-built is removed (link-safe) first. `ownerPid` (this process by
 * default) goes in the marker the sweep reads.
 */
export declare function prepareLanePluginDir(pluginRoot: string, dest: string, ownerPid?: number): string;
/**
 * Remove a lane plugin dir without following a link: each entry is lstat'ed,
 * a symlink or junction is unlinked (its target untouched), and only a real
 * dir is recursed into. A missing `path` is a no-op. Use this, never a
 * recursive rm, for a dir that holds links into the plugin root.
 */
export declare function removeLanePluginDir(path: string): void;
/**
 * Remove the lane plugin dirs a crashed engine left in `jobRoot` (the
 * copilot-run job dirs): only `<jobRoot>/cr-<id>/home/lane-plugin`, every
 * part a real dir, holding a marker whose pid `isAlive` reports gone, or
 * this process's pid on a job `ownJobLive` reports finished. A live engine's
 * mirror is kept. Returns the dirs removed and the failures; never throws.
 */
export declare function sweepStaleLanePluginDirs(jobRoot: string, isAlive: (pid: number) => boolean, ownJobLive: (id: string) => boolean): {
    removed: string[];
    failed: string[];
};
export {};
//# sourceMappingURL=lane-plugin.d.ts.map