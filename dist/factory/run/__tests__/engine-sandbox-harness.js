/**
 * The shared harness of the engine.sandbox*.test.ts files: the engine-side
 * commit of a write lane, with fake lanes and real git.
 */
import { mkdirSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../budget.js';
import { runFactoryEngine } from '../engine.js';
import { FakeLanes, FakeProcesses, harness, ISSUE, testGateConfig } from './fake-lanes.js';
export let h;
/** A fresh harness per test; call once at the top of each test file that uses it. */
export function useSandboxHarness() {
    beforeEach(() => {
        h = harness('omg-factory-sbx-');
    });
    afterEach(() => {
        rmSync(h.dir, { recursive: true, force: true });
    });
}
export function run(scripts, over = {}) {
    const lanes = new FakeLanes(h.root, scripts);
    const done = runFactoryEngine({
        root: h.root, issue: ISSUE, exec: h.exec, lanes, limits: { ...DEFAULT_FACTORY_RUN_LIMITS }, base: 'dev', pollMs: 5,
        owner: { pid: 4242, hostname: 'test-host', isAlive: () => false }, ledgerDir: h.ledgerDir, processes: new FakeProcesses(), gateConfig: testGateConfig,
        ...over,
    });
    return { lanes, done };
}
export const sandboxOf = (mode) => ({
    mode, host: { supported: mode === 'enforced', capabilities: { shell: mode === 'enforced' } }, applied: mode === 'enforced' ? 'options.update' : 'none',
    canary: 'skipped', unsandboxedCalls: 0, cliVersion: '1.0.104', sdkVersion: '1.0.16', ...(mode === 'read-only-no-shell' ? {} : { writeNetwork: 'none' }), ...(mode === 'enforced' ? {} : { reason: 'MXC is not available' }),
});
/** A write lane that leaves `path` changed in its worktree, uncommitted. */
export const edit = (path, content, sandbox) => ({ worktree }) => {
    mkdirSync(join(worktree, path, '..'), { recursive: true });
    writeFileSync(join(worktree, path), content);
    return { finalText: `Added ${path}.\nTests pass.`, credits: 4, ...(sandbox ? { sandbox } : {}) };
};
export const DIR_LINK = process.platform === 'win32' ? 'junction' : 'dir';
/** A directory link at `path` to `target`; the returned function removes the link itself, never its target. */
export function dirLink(target, path, type = DIR_LINK) {
    mkdirSync(join(path, '..'), { recursive: true });
    symlinkSync(target, path, type);
    return () => (process.platform === 'win32' ? rmdirSync(path) : unlinkSync(path));
}
/** A directory outside every worktree holding a secret file. */
export function outsideDir() {
    const dir = join(h.dir, 'outside');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'id_rsa'), 'SECRET\n');
    return dir;
}
//# sourceMappingURL=engine-sandbox-harness.js.map