import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LANE_HOOK_EVENTS, LANE_PLUGIN_DIR, LANE_PLUGIN_MIRROR_ENV, buildLaneHooksFile, prepareLanePluginDir } from '../lane-plugin.js';
import { DEFAULT_SANDBOX_SETTINGS, buildSandboxConfig, relocatedProfileEnv } from '../sandbox.js';
import { isUnderRoot } from '../../team/sdk-policy.js';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dispatcher = createRequire(import.meta.url)(join(REPO_ROOT, 'scripts', 'copilot', 'dispatch.cjs'));
const shippedHooks = () => JSON.parse(readFileSync(join(REPO_ROOT, 'copilot', 'hooks.json'), 'utf8'));
let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'omg-lane-plugin-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
/** A plugin shaped like the shipped one: root manifest, copilot/hooks.json + copilot/agents, skills, scripts, .mcp.json. */
function fixturePlugin(hooks = shippedHooks()) {
    const plugin = join(root, 'plugin');
    for (const dir of ['copilot/agents', 'skills/a', 'scripts/copilot', '.claude-plugin'])
        mkdirSync(join(plugin, dir), { recursive: true });
    writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ name: 'oh-my-copilot', hooks: './copilot/hooks.json', agents: './copilot/agents/', mcpServers: './.mcp.json' }));
    writeFileSync(join(plugin, 'copilot', 'hooks.json'), JSON.stringify(hooks));
    writeFileSync(join(plugin, 'copilot', 'agents', 'x.md'), 'agent');
    writeFileSync(join(plugin, 'skills', 'a', 'SKILL.md'), 'skill');
    writeFileSync(join(plugin, 'scripts', 'copilot', 'dispatch.cjs'), '// dispatcher');
    writeFileSync(join(plugin, '.mcp.json'), '{"mcpServers":{}}');
    return plugin;
}
describe('lane plugin dir', () => {
    it('registers exactly the dispatcher kept events', () => {
        expect([...LANE_HOOK_EVENTS].sort()).toEqual([...dispatcher.LANE_HOOK_EVENTS].sort());
    });
    it('the lane hooks file is the shipped kept entries, unchanged but for the mirror variable', () => {
        const shipped = shippedHooks();
        const lane = buildLaneHooksFile(shipped);
        expect(Object.keys(lane.hooks).sort()).toEqual(['PermissionRequest', 'PreToolUse']);
        for (const event of LANE_HOOK_EVENTS) {
            expect(lane.hooks[event]).toEqual(shipped.hooks[event].map((e) => ({ ...e, env: { ...e.env, [LANE_PLUGIN_MIRROR_ENV]: '1' } })));
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
        // Directories are links to the real ones; the hooks file's own dir is a real dir.
        for (const dir of ['skills', 'scripts', '.claude-plugin', join('copilot', 'agents')]) {
            expect(lstatSync(join(dest, dir)).isSymbolicLink(), dir).toBe(true);
            expect(realpathSync(join(dest, dir))).toBe(realpathSync(join(plugin, dir)));
        }
        expect(lstatSync(join(dest, 'copilot')).isSymbolicLink()).toBe(false);
        expect(lstatSync(join(dest, 'copilot', 'hooks.json')).isFile()).toBe(true);
        const lane = JSON.parse(readFileSync(join(dest, 'copilot', 'hooks.json'), 'utf8'));
        expect(Object.keys(lane.hooks).sort()).toEqual(['PermissionRequest', 'PreToolUse']);
        // The shipped file is untouched.
        expect(Object.keys(JSON.parse(readFileSync(join(plugin, 'copilot', 'hooks.json'), 'utf8')).hooks).length).toBeGreaterThan(2);
    });
    it('removing the lane dir leaves the plugin intact', () => {
        const plugin = fixturePlugin();
        const dest = join(root, LANE_PLUGIN_DIR);
        prepareLanePluginDir(plugin, dest);
        rmSync(dest, { recursive: true, force: true });
        expect(existsSync(dest)).toBe(false);
        for (const f of [join('skills', 'a', 'SKILL.md'), join('copilot', 'agents', 'x.md'), join('scripts', 'copilot', 'dispatch.cjs'), join('copilot', 'hooks.json')]) {
            expect(existsSync(join(plugin, f)), f).toBe(true);
        }
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
    it.each(['review', 'write'])('%s sandbox: the lane plugin dir is read-only, outside every lane-writable path', (profile) => {
        const jobHome = join(root, 'job', 'home');
        const lanePluginRoot = join(jobHome, LANE_PLUGIN_DIR);
        const ctx = {
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
        expect(isUnderRoot(lanePluginRoot, relocated.TEMP, 'linux')).toBe(false);
        expect(isUnderRoot(lanePluginRoot, relocated.USERPROFILE, 'linux')).toBe(false);
    });
});
//# sourceMappingURL=lane-plugin.test.js.map