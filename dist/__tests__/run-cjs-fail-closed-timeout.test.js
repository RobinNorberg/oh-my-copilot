import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
/**
 * The fork's fail-closed contract in scripts/run.cjs: with OMC_HOOK_FAIL_CLOSED=1
 * a hook timeout exits 124 (generic child, trusted Worker, and the SessionEnd
 * foreground budget); without it the runner stays fail-open (exit 0).
 */
const RUN_CJS_PATH = join(__dirname, '..', '..', 'scripts', 'run.cjs');
const NODE = process.execPath;
const HANG = 'setTimeout(() => process.exit(0), 20000);';
describe('run.cjs — OMC_HOOK_FAIL_CLOSED hook timeouts', () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'omc-run-cjs-fail-closed-'));
    });
    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });
    function plugin(name, script, event, timeoutSec) {
        const root = join(tmpDir, `${name}-root`);
        mkdirSync(join(root, 'scripts'), { recursive: true });
        mkdirSync(join(root, 'hooks'), { recursive: true });
        writeFileSync(join(root, 'scripts', 'run.cjs'), '// plugin-root marker');
        writeFileSync(join(root, 'scripts', name), script);
        writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({
            hooks: {
                [event]: [{ matcher: '', hooks: [{
                                type: 'command',
                                command: `node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/${name}`,
                                timeout: timeoutSec,
                            }] }],
            },
        }));
        return join(root, 'scripts', name);
    }
    function run(target, failClosed, extraEnv = {}) {
        const env = { ...process.env, CLAUDE_PLUGIN_ROOT: join(target, '..', '..'), ...extraEnv };
        delete env.OMC_HOOK_FAIL_CLOSED;
        if (failClosed)
            env.OMC_HOOK_FAIL_CLOSED = '1';
        const result = spawnSync(NODE, [RUN_CJS_PATH, target], { encoding: 'utf-8', env, input: '{}', timeout: 30_000 });
        return { status: result.status, stderr: result.stderr || '' };
    }
    it.each([
        ['generic child', 'slow-stop.cjs', HANG, 'Stop'],
        ['trusted Worker', 'pre-tool-enforcer.mjs', HANG, 'PreToolUse'],
    ])('%s: timeout exits 124 when fail-closed, 0 otherwise', (_label, name, script, event) => {
        const target = plugin(name, script, event, 2);
        const closed = run(target, true);
        expect(closed.status, closed.stderr).toBe(124);
        expect(closed.stderr).toContain('exiting fail-closed (124).');
        const open = run(target, false);
        expect(open.status, open.stderr).toBe(0);
        expect(open.stderr).toContain('exiting fail-open.');
    });
    it('SessionEnd foreground budget: timeout exits 124 when fail-closed, 0 otherwise', () => {
        const target = plugin('session-end.mjs', 'await new Promise((r) => setTimeout(r, 20000));', 'SessionEnd', 5);
        const env = { NODE_ENV: 'test', OMC_SESSION_END_TEST_FOREGROUND_TIMEOUT_MS: '500' };
        const closed = run(target, true, env);
        expect(closed.status, closed.stderr).toBe(124);
        const open = run(target, false, env);
        expect(open.status, open.stderr).toBe(0);
    });
});
//# sourceMappingURL=run-cjs-fail-closed-timeout.test.js.map