/**
 * The lane plugin dir: what a factory lane (copilot_run `minimalHooks`) loads
 * in place of the plugin root, so the Copilot CLI registers only the lane
 * hook set and spawns no process for the other hook events.
 *
 * It mirrors the plugin root: every directory is a junction (a symlink off
 * Windows) to the real one, so skills, agents, commands and scripts are the
 * shipped ones and the CLI's `${CLAUDE_PLUGIN_ROOT}` paths resolve through
 * the links. Runtime-state and VCS dirs (`.git`, `.omc`, `.omg`, `.copilot`)
 * and any dir holding the mirror itself are not linked. Of the files, only the manifest (`plugin.json`) and the files it
 * names (`.mcp.json`) are copied; every other file is left out (the CLI reads
 * none of them, and a file symlink needs a privilege on Windows). The hooks
 * file the manifest names is generated: the shipped entries of
 * {@link LANE_HOOK_EVENTS}, unchanged, plus {@link LANE_PLUGIN_MIRROR_ENV} in
 * each entry's env. Under that variable scripts/copilot/dispatch.cjs points
 * CLAUDE_PLUGIN_ROOT (which the CLI sets to this dir) back at its own plugin
 * root, so run.cjs routes the kept guards exactly as in the real plugin.
 *
 * The links point at the real plugin root, which can be a user's checkout, so
 * the dir is only ever removed with {@link removeLanePluginDir}, which unlinks
 * a link and never follows one. A {@link LANE_PLUGIN_MARKER} file names the
 * engine process that built it; {@link sweepStaleLanePluginDirs} removes a
 * mirror a crashed engine left behind.
 *
 * The engine builds it in the job home before the runtime starts, outside
 * the lane-writable temp and profile dirs, and grants it read-only to the
 * sandbox (buildSandboxConfig). Any problem throws: the caller then loads the
 * full plugin (every hook registered; the dispatcher still skips the dropped
 * events), never a plugin without its guards.
 */
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
/** The events a lane registers: the PreToolUse guards and the PermissionRequest handler (as LANE_HOOK_EVENTS in scripts/copilot/dispatch.cjs). */
export const LANE_HOOK_EVENTS = ['PreToolUse', 'PermissionRequest'];
/** Set in each generated hook entry's env: dispatch.cjs then resets CLAUDE_PLUGIN_ROOT to its own plugin root. */
export const LANE_PLUGIN_MIRROR_ENV = 'OMC_LANE_PLUGIN_MIRROR';
/** The lane plugin dir's name in the job home. */
export const LANE_PLUGIN_DIR = 'lane-plugin';
/** The marker file in a lane plugin dir: what the sweep recognises, with the building engine's pid. */
export const LANE_PLUGIN_MARKER = '.omg-lane-plugin.json';
const MARKER_KIND = 'omg-lane-plugin';
const JOB_ID = /^cr-[0-9a-f]{12}$/;
/** Runtime-state and VCS dirs: never plugin content, and `.omc`/`.omg` hold the job dirs (and so the mirror) themselves. */
const SKIPPED_DIRS = new Set(['.git', '.omc', '.omg', '.copilot']);
/** Whether `path` is `dir` or inside it (path.relative compares case-insensitively on Windows). */
function within(path, dir) {
    const rel = relative(dir, path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
/** The lane hooks file from the shipped one: only {@link LANE_HOOK_EVENTS}, each entry tagged with {@link LANE_PLUGIN_MIRROR_ENV}. */
export function buildLaneHooksFile(shipped) {
    const hooks = {};
    for (const event of LANE_HOOK_EVENTS) {
        const entries = shipped.hooks?.[event];
        if (!Array.isArray(entries) || entries.length === 0)
            throw new Error(`the plugin hooks file registers no ${event} entry`);
        hooks[event] = entries.map((entry) => ({ ...entry, env: { ...(entry.env ?? {}), [LANE_PLUGIN_MIRROR_ENV]: '1' } }));
    }
    return { ...shipped, hooks };
}
/** A manifest path as segments under the root; throws on anything but a plain relative path. */
function pathSegments(raw, what) {
    if (typeof raw !== 'string' || raw.trim() === '')
        throw new Error(`plugin.json names no ${what}`);
    const segments = normalize(raw).split(sep).filter((s) => s !== '' && s !== '.');
    if (isAbsolute(raw) || segments.length === 0 || segments.includes('..'))
        throw new Error(`plugin.json ${what} path ${raw} is not inside the plugin`);
    return segments;
}
/** The top-level files the CLI reads: the manifest and the files it names at the root (`.mcp.json`). */
function manifestFiles(root, manifest, hooks) {
    const files = new Set(['plugin.json']);
    for (const [key, value] of Object.entries(manifest)) {
        if (typeof value !== 'string' || !/^\.{0,2}[/\\]/.test(value))
            continue;
        let segments;
        try {
            segments = pathSegments(value, key);
        }
        catch {
            continue;
        }
        if (segments.length !== 1 || segments[0] === hooks[0])
            continue;
        try {
            if (statSync(join(root, segments[0])).isFile())
                files.add(segments[0]);
        }
        catch { /* a missing file: nothing to copy */ }
    }
    return files;
}
/**
 * Mirror `src` into the existing empty dir `dst`: directories as junctions to
 * their real path, the files in `copy` copied, every other file left out.
 * {@link SKIPPED_DIRS} and any dir whose real path holds `destReal` (the
 * mirror itself: a link there would be a cycle) are left out too. The
 * directory named by `keep[0]` is mirrored one level deeper (a real dir); the
 * file `keep[0]` (the last segment) is left for the caller.
 */
function mirror(src, dst, keep, copy, destReal) {
    for (const ent of readdirSync(src, { withFileTypes: true })) {
        if (SKIPPED_DIRS.has(ent.name))
            continue;
        const from = join(src, ent.name);
        const to = join(dst, ent.name);
        if (ent.name === keep[0]) {
            if (keep.length > 1) {
                mkdirSync(to);
                mirror(from, to, keep.slice(1), new Set(), destReal);
            }
            continue;
        }
        if (statSync(from).isDirectory()) {
            const target = realpathSync(from);
            if (!within(destReal, target))
                symlinkSync(target, to, 'junction');
        }
        else if (copy.has(ent.name))
            copyFileSync(from, to);
    }
}
/**
 * Build the lane plugin dir at `dest` (which must not exist) from
 * `pluginRoot`, and return it. Throws when the plugin has no root
 * `plugin.json` with a hooks file, or that file lacks a kept event; a dir
 * left half-built is removed (link-safe) first. `ownerPid` (this process by
 * default) goes in the marker the sweep reads.
 */
export function prepareLanePluginDir(pluginRoot, dest, ownerPid = process.pid) {
    const root = realpathSync(pluginRoot);
    const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
    const segments = pathSegments(manifest.hooks, 'hooks file');
    const lane = buildLaneHooksFile(JSON.parse(readFileSync(join(root, ...segments), 'utf8')));
    const copy = manifestFiles(root, manifest, segments);
    mkdirSync(dest);
    try {
        // First, so a crash at any later point leaves a dir the sweep recognises.
        writeFileSync(join(dest, LANE_PLUGIN_MARKER), `${JSON.stringify({ kind: MARKER_KIND, pid: ownerPid })}\n`, { flag: 'wx' });
        mirror(root, dest, segments, copy, realpathSync(dest));
        writeFileSync(join(dest, ...segments), `${JSON.stringify(lane, null, 2)}\n`, { flag: 'wx' });
        // Read back what the runtime will read.
        const written = JSON.parse(readFileSync(join(dest, ...segments), 'utf8'));
        const events = Object.keys(written.hooks ?? {}).sort();
        if (events.join(',') !== [...LANE_HOOK_EVENTS].sort().join(','))
            throw new Error(`the lane hooks file lists ${events.join(', ')}`);
    }
    catch (err) {
        try {
            removeLanePluginDir(dest);
        }
        catch { /* the sweep retries */ }
        throw err;
    }
    return dest;
}
/** Whether `path` is a link: a symlink, or (on Windows) a junction or other reparse point lstat may report as a dir. */
function isLink(path, isSymbolicLink) {
    if (isSymbolicLink)
        return true;
    try {
        readlinkSync(path);
        return true;
    }
    catch {
        return false;
    }
}
/** Remove the link itself, never its target: a dir junction or dir symlink on Windows needs rmdir. */
function unlinkLink(path) {
    try {
        unlinkSync(path);
    }
    catch (err) {
        const code = err.code;
        if (code !== 'EPERM' && code !== 'EISDIR' && code !== 'EACCES')
            throw err;
        rmdirSync(path);
    }
}
/**
 * Remove a lane plugin dir without following a link: each entry is lstat'ed,
 * a symlink or junction is unlinked (its target untouched), and only a real
 * dir is recursed into. A missing `path` is a no-op. Use this, never a
 * recursive rm, for a dir that holds links into the plugin root.
 */
export function removeLanePluginDir(path) {
    let st;
    try {
        st = lstatSync(path);
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return;
        throw err;
    }
    if (isLink(path, st.isSymbolicLink())) {
        unlinkLink(path);
        return;
    }
    if (st.isDirectory()) {
        for (const name of readdirSync(path))
            removeLanePluginDir(join(path, name));
        rmdirSync(path);
        return;
    }
    unlinkSync(path);
}
/** A real directory (lstat: not a link). */
function isRealDir(path) {
    try {
        const st = lstatSync(path);
        return st.isDirectory() && !isLink(path, st.isSymbolicLink());
    }
    catch {
        return false;
    }
}
/** The pid in a lane plugin dir's marker; null when the dir is not recognisably ours. */
function markerPid(dir) {
    const marker = join(dir, LANE_PLUGIN_MARKER);
    try {
        if (!lstatSync(marker).isFile())
            return null;
        const data = JSON.parse(readFileSync(marker, 'utf8'));
        return data.kind === MARKER_KIND && Number.isInteger(data.pid) ? data.pid : null;
    }
    catch {
        return null;
    }
}
/**
 * Remove the lane plugin dirs a crashed engine left in `jobRoot` (the
 * copilot-run job dirs): only `<jobRoot>/cr-<id>/home/lane-plugin`, every
 * part a real dir, holding a marker whose pid `isAlive` reports gone, or
 * this process's pid on a job `ownJobLive` reports finished. A live engine's
 * mirror is kept. Returns the dirs removed and the failures; never throws.
 */
export function sweepStaleLanePluginDirs(jobRoot, isAlive, ownJobLive) {
    const removed = [];
    const failed = [];
    let ids;
    try {
        ids = readdirSync(jobRoot).filter((name) => JOB_ID.test(name));
    }
    catch {
        return { removed, failed };
    }
    for (const id of ids) {
        const home = join(jobRoot, id, 'home');
        const dir = join(home, LANE_PLUGIN_DIR);
        if (!isRealDir(join(jobRoot, id)) || !isRealDir(home) || !isRealDir(dir))
            continue;
        const pid = markerPid(dir);
        if (pid === null || (pid === process.pid ? ownJobLive(id) : isAlive(pid)))
            continue;
        try {
            removeLanePluginDir(dir);
            removed.push(dir);
        }
        catch (err) {
            failed.push(`${dir}: ${err.message}`);
        }
    }
    return { removed, failed };
}
//# sourceMappingURL=lane-plugin.js.map