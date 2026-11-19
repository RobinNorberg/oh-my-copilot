/**
 * The lane plugin dir: what a factory lane (copilot_run `minimalHooks`) loads
 * in place of the plugin root, so the Copilot CLI registers only the lane
 * hook set and spawns no process for the other hook events.
 *
 * It mirrors the plugin root: every directory is a junction (a symlink off
 * Windows) to the real one and every file a copy, so the manifest, skills,
 * agents, commands and MCP config are the shipped ones, and the CLI's
 * `${CLAUDE_PLUGIN_ROOT}` paths resolve through the links. Only the hooks
 * file the manifest names is a generated file: the shipped entries of
 * {@link LANE_HOOK_EVENTS}, unchanged, plus {@link LANE_PLUGIN_MIRROR_ENV} in
 * each entry's env. Under that variable scripts/copilot/dispatch.cjs points
 * CLAUDE_PLUGIN_ROOT (which the CLI sets to this dir) back at its own plugin
 * root, so run.cjs routes the kept guards exactly as in the real plugin.
 *
 * The engine builds it in the job home before the runtime starts, outside
 * the lane-writable temp and profile dirs, and grants it read-only to the
 * sandbox (buildSandboxConfig). Any problem throws: the caller then loads the
 * full plugin (every hook registered; the dispatcher still skips the dropped
 * events), never a plugin without its guards.
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';

/** The events a lane registers: the PreToolUse guards and the PermissionRequest handler (as LANE_HOOK_EVENTS in scripts/copilot/dispatch.cjs). */
export const LANE_HOOK_EVENTS: readonly string[] = ['PreToolUse', 'PermissionRequest'];

/** Set in each generated hook entry's env: dispatch.cjs then resets CLAUDE_PLUGIN_ROOT to its own plugin root. */
export const LANE_PLUGIN_MIRROR_ENV = 'OMC_LANE_PLUGIN_MIRROR';

/** The lane plugin dir's name in the job home. */
export const LANE_PLUGIN_DIR = 'lane-plugin';

interface HookEntry { env?: Record<string, string>; [key: string]: unknown }
interface HooksFile { hooks?: Record<string, HookEntry[]>; [key: string]: unknown }

/** The lane hooks file from the shipped one: only {@link LANE_HOOK_EVENTS}, each entry tagged with {@link LANE_PLUGIN_MIRROR_ENV}. */
export function buildLaneHooksFile(shipped: HooksFile): HooksFile {
  const hooks: Record<string, HookEntry[]> = {};
  for (const event of LANE_HOOK_EVENTS) {
    const entries = shipped.hooks?.[event];
    if (!Array.isArray(entries) || entries.length === 0) throw new Error(`the plugin hooks file registers no ${event} entry`);
    hooks[event] = entries.map((entry) => ({ ...entry, env: { ...(entry.env ?? {}), [LANE_PLUGIN_MIRROR_ENV]: '1' } }));
  }
  return { ...shipped, hooks };
}

/** The manifest's hooks path as segments under the root; throws on anything but a plain relative path. */
function hooksPathSegments(manifest: Record<string, unknown>): string[] {
  const raw = manifest.hooks;
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error('plugin.json names no hooks file');
  const rel = normalize(raw);
  const segments = rel.split(sep).filter((s) => s !== '' && s !== '.');
  if (isAbsolute(raw) || segments.length === 0 || segments.includes('..')) throw new Error(`plugin.json hooks path ${raw} is not inside the plugin`);
  return segments;
}

/**
 * Mirror `src` into the new dir `dst`: directories as junctions to their real
 * path, files copied. The directory named by `keep[0]` is mirrored one level
 * deeper; the file `keep[0]` (the last segment) is left for the caller.
 */
function mirror(src: string, dst: string, keep: readonly string[]): void {
  mkdirSync(dst);
  for (const ent of readdirSync(src, { withFileTypes: true })) {
    if (ent.name === '.git') continue;
    const from = join(src, ent.name);
    const to = join(dst, ent.name);
    if (ent.name === keep[0]) {
      if (keep.length > 1) mirror(from, to, keep.slice(1));
      continue;
    }
    if (statSync(from).isDirectory()) symlinkSync(realpathSync(from), to, 'junction');
    else copyFileSync(from, to);
  }
}

/**
 * Build the lane plugin dir at `dest` (which must not exist) from
 * `pluginRoot`, and return it. Throws when the plugin has no root
 * `plugin.json` with a hooks file, or that file lacks a kept event.
 */
export function prepareLanePluginDir(pluginRoot: string, dest: string): string {
  const root = realpathSync(pluginRoot);
  const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')) as Record<string, unknown>;
  const segments = hooksPathSegments(manifest);
  const lane = buildLaneHooksFile(JSON.parse(readFileSync(join(root, ...segments), 'utf8')) as HooksFile);
  mirror(root, dest, segments);
  writeFileSync(join(dest, ...segments), `${JSON.stringify(lane, null, 2)}\n`, { flag: 'wx' });
  // Read back what the runtime will read.
  const written = JSON.parse(readFileSync(join(dest, ...segments), 'utf8')) as HooksFile;
  const events = Object.keys(written.hooks ?? {}).sort();
  if (events.join(',') !== [...LANE_HOOK_EVENTS].sort().join(',')) throw new Error(`the lane hooks file lists ${events.join(', ')}`);
  return dest;
}
