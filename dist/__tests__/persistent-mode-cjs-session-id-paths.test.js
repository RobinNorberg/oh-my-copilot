/**
 * Socket.dev finding: persistent-mode.cjs built filesystem paths from the raw
 * stdin session id. A traversal id such as "../../outside" must never reach a
 * path outside .omg/state/sessions, neither in the hook nor in the inline
 * fallback of scripts/lib/state-root.{cjs,mjs}.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const REPO_ROOT = resolve(join(__dirname, '..', '..'));
const STOP_HOOK = join(REPO_ROOT, 'scripts', 'persistent-mode.cjs');
const requireCjs = createRequire(__filename);
const dirs = [];
function tempProject() {
    const dir = mkdtempSync(join(tmpdir(), 'pm-cjs-sid-'));
    dirs.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    return dir;
}
afterEach(() => {
    for (const dir of dirs.splice(0))
        rmSync(dir, { recursive: true, force: true });
});
function runStopHook(input) {
    const env = {};
    for (const [k, v] of Object.entries(process.env))
        if (v !== undefined)
            env[k] = v;
    delete env.OMC_STATE_DIR;
    delete env.CLAUDE_PLUGIN_ROOT;
    execFileSync(process.execPath, [STOP_HOOK], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
        timeout: 15000,
        env: { ...env, NODE_ENV: 'test' },
    });
}
describe('persistent-mode.cjs session id path containment', () => {
    it('does not delete an expired cancel signal outside the sessions directory', () => {
        const dir = tempProject();
        // .omg/state/sessions/../../outside resolves to .omg/outside
        const outside = join(dir, '.omg', 'outside');
        mkdirSync(outside, { recursive: true });
        const victim = join(outside, 'cancel-signal-state.json');
        writeFileSync(victim, JSON.stringify({ requested_at: '2000-01-01T00:00:00.000Z' }));
        runStopHook({ cwd: dir, session_id: '../../outside' });
        expect(existsSync(victim)).toBe(true);
    });
    it('inline state-root fallbacks reject a traversal session id', async () => {
        const dir = tempProject();
        const saved = process.env.CLAUDE_PLUGIN_ROOT;
        delete process.env.CLAUDE_PLUGIN_ROOT;
        try {
            const cjs = requireCjs(join(REPO_ROOT, 'scripts', 'lib', 'state-root.cjs'));
            const mjs = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'lib', 'state-root.mjs')).href);
            const tpl = await import(pathToFileURL(join(REPO_ROOT, 'templates', 'hooks', 'lib', 'state-root.mjs')).href);
            for (const mod of [cjs, mjs, tpl]) {
                await expect(mod.resolveSessionStatePathsForHook(dir, 'ralph', '../../escape')).rejects.toThrow(/session id/i);
                const ok = await mod.resolveSessionStatePathsForHook(dir, 'ralph', 'abc-123');
                expect(ok.sessionScopedPath).toContain(join('sessions', 'abc-123'));
            }
        }
        finally {
            if (saved !== undefined)
                process.env.CLAUDE_PLUGIN_ROOT = saved;
        }
    });
});
//# sourceMappingURL=persistent-mode-cjs-session-id-paths.test.js.map