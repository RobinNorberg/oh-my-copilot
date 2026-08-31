import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
/**
 * The shipped hooks manifest uses `node`, the one launcher both cmd.exe and
 * POSIX sh resolve identically, so a fresh plugin cache is runnable on Windows
 * with no rewrite. POSIX installs are rewritten to the find-node bootstrap
 * unconditionally: find-node.sh resolves `node` from PATH when it is there and
 * from the nvm/fnm/volta locations when it is not, so it is correct in both
 * cases, while the bare-node form is correct only in the first. These tests pin
 * that the choice is made from the platform alone — an earlier version probed
 * the setup process's PATH, which is not the PATH hooks are later spawned with.
 */
const REPO_ROOT = join(__dirname, '..', '..');
const MODULE_PATH = join(REPO_ROOT, 'scripts', 'lib', 'hook-command-normalizer.mjs');
const normalizer = (await import(pathToFileURL(MODULE_PATH).href));
const SESSION_END = '"$CLAUDE_PLUGIN_ROOT"/scripts/session-end.mjs';
describe('hook prefix selection', () => {
    it('uses the portable form on Windows, which has no sh', () => {
        expect(normalizer.hookPrefixForPlatform('win32')).toBe(normalizer.PORTABLE_HOOK_PREFIX);
    });
    it('uses the find-node bootstrap on every POSIX platform', () => {
        for (const platform of ['linux', 'darwin', 'freebsd']) {
            expect(normalizer.hookPrefixForPlatform(platform), platform).toBe(normalizer.UNIX_HOOK_PREFIX);
        }
        expect(normalizer.UNIX_HOOK_PREFIX).toContain('find-node.sh');
    });
    it('does not consult PATH when choosing the POSIX prefix', () => {
        // The regression this guards: probing whether `node` resolves samples the
        // setup process's environment, not the one the host CLI spawns hooks with.
        // An nvm user setting up from a terminal and launching the CLI from a
        // desktop launcher would get the bare-node form and lose every hook.
        const source = readFileSync(MODULE_PATH, 'utf-8');
        expect(source).not.toContain('spawnSync');
        expect(source).not.toContain('nodeResolvesOnHookPath');
        expect(source).not.toMatch(/\benv\.PATH\b/);
    });
    it('exposes the legacy Windows prefix name as the portable form', () => {
        expect(normalizer.WINDOWS_HOOK_PREFIX).toBe(normalizer.PORTABLE_HOOK_PREFIX);
        expect(normalizer.PORTABLE_HOOK_PREFIX).toBe('node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs ');
    });
});
describe('command rewriting', () => {
    it('rewrites every historical form to the requested prefix', () => {
        const portable = `${normalizer.PORTABLE_HOOK_PREFIX}${SESSION_END}`;
        const bootstrap = `${normalizer.UNIX_HOOK_PREFIX}${SESSION_END}`;
        expect(normalizer.normalizeHookCommand(bootstrap, normalizer.PORTABLE_HOOK_PREFIX)).toBe(portable);
        expect(normalizer.normalizeHookCommand(portable, normalizer.UNIX_HOOK_PREFIX)).toBe(bootstrap);
        expect(normalizer.normalizeHookCommand('"/opt/node/bin/node" "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/session-end.mjs', normalizer.PORTABLE_HOOK_PREFIX)).toBe(portable);
    });
    it('reports no change when the manifest already matches the prefix', () => {
        const data = {
            hooks: {
                SessionEnd: [{
                        matcher: '*',
                        hooks: [{ type: 'command', command: `${normalizer.PORTABLE_HOOK_PREFIX}${SESSION_END}` }],
                    }],
            },
        };
        expect(normalizer.normalizeHooksDataForPlatform(data, 'linux', normalizer.PORTABLE_HOOK_PREFIX)).toBe(false);
    });
});
describe('shipped hooks manifest', () => {
    const hooksJson = JSON.parse(readFileSync(join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf-8'));
    const commands = Object.entries(hooksJson.hooks).flatMap(([event, groups]) => groups.flatMap(group => group.hooks
        .map(hook => hook.command)
        .filter((command) => typeof command === 'string')
        .map(command => ({ event, command }))));
    it('ships the Windows-runnable form, with no sh anywhere', () => {
        expect(commands.length).toBeGreaterThan(0);
        for (const { event, command } of commands) {
            expect(command, event).toMatch(/^node "\$CLAUDE_PLUGIN_ROOT"\/scripts\/run\.cjs /);
            expect(command, event).not.toContain('find-node.sh');
            expect(command, event).not.toContain('/bin/sh');
        }
    });
    it('needs no patch on Windows and is rewritten to the bootstrap on POSIX', () => {
        const freshManifest = () => JSON.parse(readFileSync(join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf-8'));
        expect(normalizer.normalizeHooksDataForPlatform(freshManifest(), 'win32')).toBe(false);
        for (const platform of ['linux', 'darwin']) {
            const data = freshManifest();
            expect(normalizer.normalizeHooksDataForPlatform(data, platform), platform).toBe(true);
            for (const groups of Object.values(data.hooks)) {
                for (const group of groups) {
                    for (const hook of group.hooks) {
                        expect(hook.command, platform).toMatch(/^sh "\$CLAUDE_PLUGIN_ROOT"\/scripts\/find-node\.sh "\$CLAUDE_PLUGIN_ROOT"\/scripts\/run\.cjs /);
                    }
                }
            }
        }
    });
});
//# sourceMappingURL=hook-command-normalizer.test.js.map