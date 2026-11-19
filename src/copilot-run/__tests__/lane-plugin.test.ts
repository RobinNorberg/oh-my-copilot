import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LANE_HOOK_EVENTS,
  LANE_PLUGIN_DIR,
  LANE_PLUGIN_MARKER,
  LANE_PLUGIN_MIRROR_ENV,
  buildLaneHooksFile,
  prepareLanePluginDir,
  removeLanePluginDir,
  sweepStaleLanePluginDirs,
} from '../lane-plugin.js';
import { DEFAULT_SANDBOX_SETTINGS, buildSandboxConfig, relocatedProfileEnv, type SandboxPolicyContext } from '../sandbox.js';
import { isUnderRoot } from '../../team/sdk-policy.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dispatcher = createRequire(import.meta.url)(join(REPO_ROOT, 'scripts', 'copilot', 'dispatch.cjs')) as { LANE_HOOK_EVENTS: Set<string> };
type HooksFile = { hooks: Record<string, Array<{ args: string[]; env?: Record<string, string> }>> };
const shippedHooks = () => JSON.parse(readFileSync(join(REPO_ROOT, 'copilot', 'hooks.json'), 'utf8')) as HooksFile;

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'omg-lane-plugin-')); });
// Link-safe, as the engine: the fixtures hold junctions.
afterEach(() => { removeLanePluginDir(root); });

/** Every file under `dir` (following no link) with a hash of its content. */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(join(d, ent.name), r);
      else out[r] = createHash('sha256').update(readFileSync(join(d, ent.name))).digest('hex');
    }
  };
  walk(dir, '');
  return out;
}

/** A dir link: a junction on Windows, a symlink elsewhere. */
const linkDir = (target: string, path: string) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');

/** A plugin shaped like the shipped one: root manifest, copilot/hooks.json + copilot/agents, skills, scripts, .mcp.json. */
function fixturePlugin(hooks: unknown = shippedHooks()): string {
  const plugin = join(root, 'plugin');
  for (const dir of ['copilot/agents', 'skills/a', 'scripts/copilot', '.claude-plugin']) mkdirSync(join(plugin, dir), { recursive: true });
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ name: 'oh-my-copilot', hooks: './copilot/hooks.json', agents: './copilot/agents/', mcpServers: './.mcp.json' }));
  writeFileSync(join(plugin, 'copilot', 'hooks.json'), JSON.stringify(hooks));
  writeFileSync(join(plugin, 'copilot', 'agents', 'x.md'), 'agent');
  writeFileSync(join(plugin, 'skills', 'a', 'SKILL.md'), 'skill');
  writeFileSync(join(plugin, 'scripts', 'copilot', 'dispatch.cjs'), '// dispatcher');
  writeFileSync(join(plugin, '.mcp.json'), '{"mcpServers":{}}');
  writeFileSync(join(plugin, 'README.md'), 'readme');
  return plugin;
}

describe('lane plugin dir', () => {
  it('registers exactly the dispatcher kept events', () => {
    expect([...LANE_HOOK_EVENTS].sort()).toEqual([...dispatcher.LANE_HOOK_EVENTS].sort());
  });

  it('the lane hooks file is the shipped kept entries, unchanged but for the mirror variable', () => {
    const shipped = shippedHooks();
    const lane = buildLaneHooksFile(shipped) as HooksFile;
    expect(Object.keys(lane.hooks).sort()).toEqual(['PermissionRequest', 'PreToolUse']);
    for (const event of LANE_HOOK_EVENTS) {
      expect(lane.hooks[event]).toEqual(shipped.hooks[event]!.map((e) => ({ ...e, env: { ...e.env, [LANE_PLUGIN_MIRROR_ENV]: '1' } })));
    }
    const scripts = Object.values(lane.hooks).flat().flatMap((e) => e.args.filter((a) => a.endsWith('.mjs')).map((a) => a.split('/').pop()));
    expect(scripts.sort()).toEqual(['git-guardrails.mjs', 'permission-handler.mjs', 'pre-tool-enforcer.mjs']);
  });

  it('mirrors the plugin: the same manifest and components, a generated hooks file with only the kept events', () => {
    const plugin = fixturePlugin();
    const dest = join(root, 'job', 'home', LANE_PLUGIN_DIR);
    mkdirSync(dirname(dest), { recursive: true });
    expect(prepareLanePluginDir(plugin, dest)).toBe(dest);
    expect(readFileSync(join(dest, 'plugin.json'), 'utf8')).toBe(readFileSync(join(plugin, 'plugin.json'), 'utf8'));
    expect(readFileSync(join(dest, '.mcp.json'), 'utf8')).toBe(readFileSync(join(plugin, '.mcp.json'), 'utf8'));
    // Only the manifest files are copied; other top-level files are left out. The marker names this process.
    expect(existsSync(join(dest, 'README.md'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dest, LANE_PLUGIN_MARKER), 'utf8'))).toEqual({ kind: 'omg-lane-plugin', pid: process.pid });
    // Directories are links to the real ones; the hooks file's own dir is a real dir.
    for (const dir of ['skills', 'scripts', '.claude-plugin', join('copilot', 'agents')]) {
      expect(lstatSync(join(dest, dir)).isSymbolicLink(), dir).toBe(true);
      expect(realpathSync(join(dest, dir))).toBe(realpathSync(join(plugin, dir)));
    }
    expect(lstatSync(join(dest, 'copilot')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(dest, 'copilot', 'hooks.json')).isFile()).toBe(true);
    const lane = JSON.parse(readFileSync(join(dest, 'copilot', 'hooks.json'), 'utf8')) as HooksFile;
    expect(Object.keys(lane.hooks).sort()).toEqual(['PermissionRequest', 'PreToolUse']);
    // The shipped file is untouched.
    expect(Object.keys((JSON.parse(readFileSync(join(plugin, 'copilot', 'hooks.json'), 'utf8')) as HooksFile).hooks).length).toBeGreaterThan(2);
  });

  it('removing the lane dir leaves the plugin intact', () => {
    const plugin = fixturePlugin();
    const before = fingerprint(plugin);
    const dest = join(root, LANE_PLUGIN_DIR);
    prepareLanePluginDir(plugin, dest);
    removeLanePluginDir(dest);
    expect(existsSync(dest)).toBe(false);
    expect(fingerprint(plugin)).toEqual(before);
    expect(Object.keys(before)).toEqual(expect.arrayContaining(['skills/a/SKILL.md', 'copilot/agents/x.md', 'scripts/copilot/dispatch.cjs', 'copilot/hooks.json']));
    // A missing dir is a no-op.
    expect(() => removeLanePluginDir(dest)).not.toThrow();
  });

  it('the remover unlinks nested links and never enters them: their targets stay intact', () => {
    const target = join(root, 'target');
    mkdirSync(join(target, 'deep'), { recursive: true });
    writeFileSync(join(target, 'a.txt'), 'a');
    writeFileSync(join(target, 'deep', 'b.txt'), 'b');
    const before = fingerprint(target);
    const tree = join(root, 'tree');
    mkdirSync(join(tree, 'real', 'deeper'), { recursive: true });
    writeFileSync(join(tree, 'real', 'f.txt'), 'f');
    linkDir(target, join(tree, 'top-link'));
    linkDir(target, join(tree, 'real', 'deeper', 'nested-link'));
    if (process.platform !== 'win32') symlinkSync(join(target, 'a.txt'), join(tree, 'real', 'file-link'));
    removeLanePluginDir(tree);
    expect(existsSync(tree)).toBe(false);
    expect(fingerprint(target)).toEqual(before);
  });

  it('a build that fails after the dir is made removes the partial dir (link-safe) and leaves the plugin intact', () => {
    const plugin = fixturePlugin();
    // A dangling link in the plugin root: the mirror throws on it, after links before it are made.
    linkDir(join(root, 'nowhere'), join(plugin, 'zz-dangling'));
    const before = fingerprint(join(plugin, 'skills'));
    const dest = join(root, 'out');
    expect(() => prepareLanePluginDir(plugin, dest)).toThrow('ENOENT');
    expect(existsSync(dest)).toBe(false);
    expect(fingerprint(join(plugin, 'skills'))).toEqual(before);
  });

  it("the sweep removes a dead engine's mirror link-safe; it keeps a live one, an own live job's, and dirs that are not ours", () => {
    const plugin = fixturePlugin();
    const before = fingerprint(plugin);
    const jobRoot = join(root, 'copilot-run');
    const at = (id: string) => { mkdirSync(join(jobRoot, id, 'home'), { recursive: true }); return join(jobRoot, id, 'home', LANE_PLUGIN_DIR); };
    const stale = prepareLanePluginDir(plugin, at('cr-aaaaaaaaaaaa'), 999_001);
    const live = prepareLanePluginDir(plugin, at('cr-bbbbbbbbbbbb'), 999_002);
    const ownLive = prepareLanePluginDir(plugin, at('cr-cccccccccccc'));
    const ownDone = prepareLanePluginDir(plugin, at('cr-dddddddddddd'));
    const unmarked = prepareLanePluginDir(plugin, at('cr-eeeeeeeeeeee'), 999_001);
    rmSync(join(unmarked, LANE_PLUGIN_MARKER));
    const foreign = prepareLanePluginDir(plugin, at('not-a-job'), 999_001);
    const result = sweepStaleLanePluginDirs(jobRoot, (pid) => pid === 999_002, (id) => id === 'cr-cccccccccccc');
    expect(result.failed).toEqual([]);
    expect(result.removed.sort()).toEqual([stale, ownDone].sort());
    for (const gone of [stale, ownDone]) expect(existsSync(gone)).toBe(false);
    for (const kept of [live, ownLive, unmarked, foreign]) expect(existsSync(kept)).toBe(true);
    expect(fingerprint(plugin)).toEqual(before);
    // A missing job root is no error.
    expect(sweepStaleLanePluginDirs(join(root, 'missing'), () => false, () => false)).toEqual({ removed: [], failed: [] });
  });

  it.each([
    ['a kept event is missing', () => fixturePlugin({ hooks: { PreToolUse: shippedHooks().hooks.PreToolUse } }), 'no PermissionRequest entry'],
    ['the hooks file is not JSON', () => { const p = fixturePlugin(); writeFileSync(join(p, 'copilot', 'hooks.json'), '{'); return p; }, 'JSON'],
    ['the manifest names no hooks file', () => { const p = fixturePlugin(); writeFileSync(join(p, 'plugin.json'), '{"name":"x"}'); return p; }, 'names no hooks file'],
    ['the hooks path leaves the plugin', () => { const p = fixturePlugin(); writeFileSync(join(p, 'plugin.json'), '{"hooks":"../hooks.json"}'); return p; }, 'not inside the plugin'],
    ['there is no plugin', () => join(root, 'missing'), 'ENOENT'],
  ])('throws when %s (the caller then loads the full plugin)', (_name, make, message) => {
    const plugin = make();
    expect(() => prepareLanePluginDir(plugin, join(root, 'out'))).toThrow(message);
  });

  it('refuses a dest that already exists (never reuses a dir the engine did not make)', () => {
    const plugin = fixturePlugin();
    mkdirSync(join(root, 'out'));
    expect(() => prepareLanePluginDir(plugin, join(root, 'out'))).toThrow('EEXIST');
  });

  it.each(['review', 'write'] as const)('%s sandbox: the lane plugin dir is read-only, outside every lane-writable path', (profile) => {
    const jobHome = join(root, 'job', 'home');
    const lanePluginRoot = join(jobHome, LANE_PLUGIN_DIR);
    const ctx: SandboxPolicyContext = {
      worktree: join(root, 'wt'),
      commonGitDir: join(root, 'repo', '.git'),
      pluginRoot: join(root, 'plugin'),
      lanePluginRoot,
      jobHome,
      jobDir: join(root, 'job'),
      realHome: join(root, 'me'),
      omcStateRoot: join(root, 'me', '.omg', 'state'),
      platform: 'linux',
      settings: { ...DEFAULT_SANDBOX_SETTINGS, allowedHosts: [], extraReadonlyPaths: [], extraReadwritePaths: [] },
    };
    const { filesystem } = buildSandboxConfig(profile, ctx, { supported: true, capabilities: { shell: true } }).userPolicy;
    expect(filesystem.readonlyPaths).toEqual(expect.arrayContaining([ctx.pluginRoot, lanePluginRoot]));
    expect(filesystem.readwritePaths.some((p) => isUnderRoot(lanePluginRoot, p, 'linux'))).toBe(false);
    const relocated = relocatedProfileEnv(jobHome);
    expect(isUnderRoot(lanePluginRoot, relocated.TEMP!, 'linux')).toBe(false);
    expect(isUnderRoot(lanePluginRoot, relocated.USERPROFILE!, 'linux')).toBe(false);
  });
});
