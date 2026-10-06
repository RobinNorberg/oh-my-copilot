/**
 * OMC_CHAIN_LINK reaches the SessionEnd hook script on the Copilot hook path:
 * Copilot runs `node --require copilot-hook-adapter.cjs run.cjs session-end.mjs`
 * (copilot/hooks.json) with its own env, and neither the adapter nor run.cjs
 * may drop the var on the way to the script that calls planChainEnqueue.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { CHAIN_LINK_ENV } from '../spawn-next.js';
const root = resolve(__dirname, '..', '..', '..', '..');
const ADAPTER = join(root, 'scripts', 'lib', 'copilot-hook-adapter.cjs');
const RUN_CJS = join(root, 'scripts', 'run.cjs');
const LINK = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const dirs = [];
afterEach(() => {
    for (const dir of dirs)
        rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
});
function runSessionEndHook(env) {
    const dir = mkdtempSync(join(tmpdir(), 'chain-link-env-'));
    dirs.push(dir);
    const fixture = join(dir, 'report-env.mjs');
    writeFileSync(fixture, `process.stdout.write(JSON.stringify({ continue: true, seen: process.env.${CHAIN_LINK_ENV} ?? null }));\n`);
    const childEnv = { ...process.env, ...env, OMC_HOOK_EVENT: 'SessionEnd' };
    if (!(CHAIN_LINK_ENV in env))
        delete childEnv[CHAIN_LINK_ENV];
    const result = spawnSync(process.execPath, ['--require', ADAPTER, RUN_CJS, fixture], {
        cwd: dir,
        env: childEnv,
        input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'host-session', cwd: dir, reason: 'complete' }),
        encoding: 'utf8',
        timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout.trim());
}
describe('OMC_CHAIN_LINK hook-path passthrough (Copilot SessionEnd)', () => {
    it('delivers the link id from the Copilot process env to the SessionEnd script', () => {
        expect(runSessionEndHook({ [CHAIN_LINK_ENV]: LINK }).seen).toBe(LINK);
    });
    it('delivers nothing when the session is not a chain link', () => {
        expect(runSessionEndHook({}).seen).toBeNull();
    });
});
//# sourceMappingURL=chain-link-env-passthrough.test.js.map