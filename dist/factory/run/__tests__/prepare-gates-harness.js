/**
 * The shared harness of the prepare-gates*.test.ts files (`omg factory run` PR 3):
 * prepare in the engine-owned checkout, the conflict-fix and ci-fix lanes, the
 * gates loop (head-checked), the human merge gate and `clean`. Fake lanes, real
 * git with a local bare remote, scripted gh and node behind the exec seam, a fake
 * clock for the gate polls.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { parseProgressLog } from '../../../lib/agent-progress.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../budget.js';
import { runFactoryEngine } from '../engine.js';
import { factoryProgressFile } from '../progress.js';
import { FakeLanes, FakeProcesses, gitIn, harness, ISSUE, PR, testGateConfig, withTestSandbox } from './fake-lanes.js';
export let h;
export let t;
/** A fresh harness per test; call once at the top of each test file that uses it. */
export function usePrepareGatesHarness() {
    beforeEach(() => {
        h = harness('omg-factory-pr3-');
        // The engine's own base merges commit in the prepare checkout.
        gitIn(h.root, 'config', 'user.name', 't');
        gitIn(h.root, 'config', 'user.email', 't@example.invalid');
        t = Date.parse('2026-10-27T10:00:00.000Z');
    });
    afterEach(() => {
        rmSync(h.dir, { recursive: true, force: true });
    });
}
export const limits = (over = {}) => ({ ...DEFAULT_FACTORY_RUN_LIMITS, ...over });
export function run(scripts, over = {}) {
    const lanes = new FakeLanes(h.root, scripts);
    const done = runFactoryEngine(withTestSandbox({
        root: h.root, issue: ISSUE, exec: h.exec, lanes, limits: limits(), base: 'dev', pollMs: 5,
        owner: { pid: 4242, hostname: 'test-host', isAlive: () => false }, ledgerDir: h.ledgerDir, processes: new FakeProcesses(),
        gateConfig: testGateConfig, now: () => t, sleep: async (ms) => { t += ms; },
        ...over,
    }, over));
    return { lanes, done };
}
/** Move dev on the remote from a separate clone (the engine's main checkout is never touched). */
export function moveBase(path, content) {
    const other = join(h.dir, `other-${Math.random().toString(36).slice(2, 8)}`);
    gitIn(h.dir, 'clone', '-q', '-b', 'dev', h.bare, other);
    mkdirSync(join(other, path, '..'), { recursive: true });
    writeFileSync(join(other, path), content);
    gitIn(other, 'add', '--', path);
    gitIn(other, 'commit', '-q', '-m', `base: ${path}`);
    gitIn(other, 'push', '-q', 'origin', 'dev');
    return gitIn(other, 'rev-parse', 'HEAD');
}
/** The first PR view of prepare (and of every later phase): GitHub's base sha is read here. */
export const PREPARE_VIEW = `gh pr view ${PR} --json number,`;
/** Run `fn` once, right before the first command that starts with `prefix`. */
export function before(prefix, fn) {
    let fired = false;
    h.onCall = (call) => {
        if (!fired && call.startsWith(prefix)) {
            fired = true;
            fn();
        }
    };
}
export const events = () => parseProgressLog(readFileSync(factoryProgressFile(h.root, ISSUE), 'utf8'));
export const okRun = { status: 0, stdout: '', stderr: '' };
export const isTsc = (args) => args.some((a) => a.includes('typescript/bin/tsc'));
export const pushes = () => h.calls.filter((c) => c.startsWith('git push '));
//# sourceMappingURL=prepare-gates-harness.js.map