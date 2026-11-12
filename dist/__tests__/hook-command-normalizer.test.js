import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
/**
 * The shipped hooks manifest uses the exec form (`command: "node"` plus
 * `args`): the host spawns node with no shell, so a plugin root that contains
 * spaces stays one argument on Windows. POSIX keeps that exec form when the
 * caller reports that `node` resolves on the hook PATH, so a config dir shared
 * with native Windows keeps working; otherwise it is rewritten to the
 * find-node bootstrap, which also resolves nvm/fnm/volta installs. The probe
 * refuses to trust an npm lifecycle PATH and the default is the bootstrap.
 */
const REPO_ROOT = join(__dirname, '..', '..');
const MODULE_PATH = join(REPO_ROOT, 'scripts', 'lib', 'hook-command-normalizer.mjs');
const normalizer = (await import(pathToFileURL(MODULE_PATH).href));
const RUN_CJS = '${CLAUDE_PLUGIN_ROOT}/scripts/run.cjs';
const SESSION_END = '${CLAUDE_PLUGIN_ROOT}/scripts/session-end.mjs';
const freshManifest = () => JSON.parse(readFileSync(join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf-8'));
const allHooks = (data) => Object.values(data.hooks).flatMap(groups => groups.flatMap(group => group.hooks));
describe('hook prefix selection', () => {
    it('uses direct node exec on Windows, which has no sh', () => {
        expect(normalizer.hookPrefixForPlatform('win32')).toBe('node');
    });
    it('uses the find-node bootstrap on every POSIX platform', () => {
        for (const platform of ['linux', 'darwin', 'freebsd']) {
            expect(normalizer.hookPrefixForPlatform(platform), platform).toBe(normalizer.UNIX_HOOK_PREFIX);
        }
        expect(normalizer.UNIX_HOOK_PREFIX).toContain('find-node.sh');
    });
    it('keeps the exec form on POSIX only when the caller says node resolves', () => {
        for (const platform of ['linux', 'darwin']) {
            expect(normalizer.hookPrefixForPlatform(platform, { nodeOnPath: true }), platform).toBe('node');
            expect(normalizer.hookPrefixForPlatform(platform, { nodeOnPath: false }), platform).toBe(normalizer.UNIX_HOOK_PREFIX);
        }
        expect(normalizer.hookPrefixForPlatform('win32', { nodeOnPath: false })).toBe('node');
    });
});
describe('nodeResolvesOnHookPath', () => {
    it('reports false under an npm lifecycle script, whose PATH is not the hook PATH', () => {
        expect(normalizer.nodeResolvesOnHookPath({ ...process.env, npm_lifecycle_event: 'postinstall' })).toBe(false);
        expect(normalizer.nodeResolvesOnHookPath({ ...process.env, npm_execpath: '/usr/lib/npm-cli.js' })).toBe(false);
    });
    it('reports false when the system dirs have no node', () => {
        expect(normalizer.nodeResolvesOnHookPath({}, [join(REPO_ROOT, 'no-such-dir')])).toBe(false);
    });
    it('reports true when a system dir holds the running node', () => {
        expect(normalizer.nodeResolvesOnHookPath({}, [dirname(process.execPath)])).toBe(true);
    });
    it('ignores the setup PATH: a node reachable only there (nvm/fnm/volta) yields find-node', () => {
        const env = { PATH: dirname(process.execPath), NVM_DIR: '/home/u/.nvm' };
        const nodeOnPath = normalizer.nodeResolvesOnHookPath(env, [join(REPO_ROOT, 'no-such-dir')]);
        expect(nodeOnPath).toBe(false);
        const data = freshManifest();
        normalizer.normalizeHooksDataForPlatform(data, 'linux', { nodeOnPath });
        for (const hook of allHooks(data).filter(h => normalizer.parseHookInvocation(h))) {
            expect(hook.command).toContain(normalizer.UNIX_HOOK_PREFIX);
            expect(hook.args).toBeUndefined();
        }
    });
    it('probes with PATH limited to the given dirs and only HOME kept', () => {
        const env = { PATH: '/home/u/.nvm/versions/node/v22/bin', HOME: '/home/u', NVM_DIR: '/home/u/.nvm', NODE_OPTIONS: '--require x' };
        expect(normalizer.minimalHookEnv(env, ['/usr/bin', '/bin'])).toEqual({ PATH: ['/usr/bin', '/bin'].join(delimiter), HOME: '/home/u' });
        expect(normalizer.minimalHookEnv({}, ['/bin'])).toEqual({ PATH: '/bin' });
    });
    it('uses the standard system dirs, plus Homebrew and MacPorts only when they exist', () => {
        expect(normalizer.systemPathDirs(() => false)).toEqual(['/usr/local/bin', '/usr/bin', '/bin']);
        expect(normalizer.systemPathDirs((dir) => dir === '/opt/homebrew/bin')).toEqual(['/usr/local/bin', '/usr/bin', '/bin', '/opt/homebrew/bin']);
        expect(normalizer.systemPathDirs(() => true)).toEqual(['/usr/local/bin', '/usr/bin', '/bin', '/opt/homebrew/bin', '/opt/local/bin']);
    });
});
describe('command rewriting', () => {
    it('rewrites the legacy shell forms to the bootstrap', () => {
        const bootstrap = `${normalizer.UNIX_HOOK_PREFIX}"\${CLAUDE_PLUGIN_ROOT}"/scripts/session-end.mjs`;
        expect(normalizer.normalizeHookCommand('node "${CLAUDE_PLUGIN_ROOT}"/scripts/run.cjs "${CLAUDE_PLUGIN_ROOT}"/scripts/session-end.mjs')).toBe(bootstrap);
        expect(normalizer.normalizeHookCommand('"/opt/node/bin/node" "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/session-end.mjs')).toBe(bootstrap);
    });
    it('reports no change when the manifest already uses the exec form on Windows', () => {
        const data = {
            hooks: { SessionEnd: [{ matcher: '*', hooks: [{ type: 'command', command: 'node', args: [RUN_CJS, SESSION_END] }] }] },
        };
        expect(normalizer.normalizeHooksDataForPlatform(data, 'win32')).toBe(false);
    });
});
describe('shipped hooks manifest', () => {
    it('ships the exec form, with no sh anywhere', () => {
        const hooks = allHooks(freshManifest());
        expect(hooks.length).toBeGreaterThan(0);
        for (const hook of hooks) {
            expect(hook.command).toBe('node');
            expect(hook.args?.[0]).toBe(RUN_CJS);
            expect(JSON.stringify(hook)).not.toContain('find-node.sh');
        }
    });
    it('on Windows only restores the shipped form, e.g. after a WSL setup rewrote a shared cache', () => {
        // A config dir shared between WSL and native Windows: the POSIX rewrite left
        // `sh find-node.sh`, which Windows cannot run. win32 never invents a
        // host-specific form; it puts back exactly the shipped manifest.
        const shared = freshManifest();
        expect(normalizer.normalizeHooksDataForPlatform(shared, 'linux')).toBe(true);
        expect(normalizer.normalizeHooksDataForPlatform(shared, 'win32')).toBe(true);
        expect(shared).toEqual(freshManifest());
        expect(normalizer.normalizeHooksDataForPlatform(shared, 'win32')).toBe(false);
    });
    it('stays unchanged on POSIX when node resolves, so a shared config dir keeps working on Windows', () => {
        for (const platform of ['linux', 'darwin']) {
            const data = freshManifest();
            expect(normalizer.normalizeHooksDataForPlatform(data, platform, { nodeOnPath: true }), platform).toBe(false);
            expect(data, platform).toEqual(freshManifest());
            // And Windows has nothing to repair afterwards.
            expect(normalizer.normalizeHooksDataForPlatform(data, 'win32'), platform).toBe(false);
        }
    });
    it('restores the exec form on POSIX with node on PATH after an earlier find-node rewrite', () => {
        const data = freshManifest();
        expect(normalizer.normalizeHooksDataForPlatform(data, 'linux')).toBe(true);
        expect(normalizer.normalizeHooksDataForPlatform(data, 'linux', { nodeOnPath: true })).toBe(true);
        expect(data).toEqual(freshManifest());
    });
    it('needs no patch on Windows and is rewritten to the bootstrap on POSIX without node', () => {
        expect(normalizer.normalizeHooksDataForPlatform(freshManifest(), 'win32')).toBe(false);
        for (const platform of ['linux', 'darwin']) {
            const data = freshManifest();
            expect(normalizer.normalizeHooksDataForPlatform(data, platform), platform).toBe(true);
            for (const hook of allHooks(data)) {
                expect(hook.args, platform).toBeUndefined();
                expect(hook.command, platform).toMatch(/^sh "\$\{CLAUDE_PLUGIN_ROOT\}"\/scripts\/find-node\.sh "\$\{CLAUDE_PLUGIN_ROOT\}"\/scripts\/run\.cjs /);
            }
        }
    });
});
//# sourceMappingURL=hook-command-normalizer.test.js.map