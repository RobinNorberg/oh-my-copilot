/**
 * B2 CLI: `omg factory run` with factory.run.maxConcurrent above 1. The
 * shared layout refuses parallelism (naming factory.run.layout "private"),
 * --parallel needs the private layout, and the --parallel supervisor spawns
 * min(n, maxConcurrent) children, forwards the stop signal and reports each.
 */
import { existsSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { factoryRunCommand } from '../factory.js';
import { resolveFactoryRunLimits } from '../../../factory/run/budget.js';
import { factoryRepoOwnerPath, readFactoryState } from '../../../factory/run/state.js';
import { FakeProcesses, harness } from '../../../factory/run/__tests__/fake-lanes.js';
let h;
let out;
beforeEach(() => {
    h = harness('omg-factory-par-cli-');
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a) => { out.push(a.join(' ')); });
});
afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(h.dir, { recursive: true, force: true });
});
function deps(over = {}) {
    const exec = (cmd, args, opts) => (cmd === 'git' && args.join(' ') === 'rev-parse --show-toplevel'
        ? { status: 0, stdout: `${h.root}\n`, stderr: '' }
        : h.exec(cmd, args, opts));
    return {
        exec,
        lanes: () => { throw new Error('no lane in this suite'); },
        limits: () => resolveFactoryRunLimits(undefined, undefined),
        base: () => 'dev',
        ledgerDir: h.ledgerDir,
        processes: new FakeProcesses(),
        ...over,
    };
}
async function cli(d, ...argv) {
    process.exitCode = undefined;
    await factoryRunCommand(d).parseAsync(argv, { from: 'user' });
    const code = Number(process.exitCode ?? 0);
    process.exitCode = undefined;
    return code;
}
const parallel = (maxConcurrent, layout) => ({ parallel: () => ({ settings: { maxConcurrent, source: 'user config' }, layout }) });
describe('omg factory run with factory.run.maxConcurrent', () => {
    it('more than one concurrent run with the shared layout is refused, naming factory.run.layout "private"; nothing is locked or written', async () => {
        const code = await cli(deps(parallel(2, 'shared')), '7');
        expect(code).not.toBe(0);
        expect(out.join('\n')).toMatch(/factory\.run\.maxConcurrent 2 \(from the user config\) runs several runs at once only with factory\.run\.layout: "private"/);
        expect(existsSync(factoryRepoOwnerPath(h.root))).toBe(false);
        expect(readFactoryState(h.root, 7)).toBeNull();
    });
    it('--parallel needs --next and the private layout with maxConcurrent above 1', async () => {
        expect(await cli(deps(parallel(1, 'private')), '--next', '--parallel', '2')).not.toBe(0);
        expect(out.join('\n')).toMatch(/--parallel needs factory\.run\.maxConcurrent above 1 and factory\.run\.layout: "private"/);
        out = [];
        expect(await cli(deps(parallel(2, 'private')), '7', '--parallel', '2')).not.toBe(0);
        expect(out.join('\n')).toMatch(/--parallel applies to --next/);
    });
    it('--parallel 3 with maxConcurrent 2 runs two children, refills, forwards Ctrl+C to the running ones and waits; JSON summary per child', async () => {
        const children = [];
        const d = deps({
            ...parallel(2, 'private'),
            parallelChild: ({ args, signals }) => new Promise((resolve) => {
                const c = { args, resolve, got: [] };
                children.push(c);
                const off = signals((s) => { c.got.push(s); });
                // Unsubscribed when it ends, as poll's auto-start child does.
                const done = c.resolve;
                c.resolve = (r) => { off(); done(r); };
            }),
        });
        const before = new Set(process.listeners('SIGINT'));
        const run = cli(d, '--next', '--parallel', '3', '--parent', '42', '--json');
        const tick = () => new Promise((r) => setTimeout(r, 0));
        await tick();
        expect(children.length).toBe(2);
        expect(children[0].args).toEqual(['--parent', '42']);
        children[0].resolve({ exitCode: 0, parsed: true, next: 7, message: 'awaiting-human: merge' });
        await tick();
        expect(children.length).toBe(3); // refilled
        // Ctrl+C: the supervisor's own listener (found, not emitted, so the test runner's own handlers stay out of it).
        const mine = process.listeners('SIGINT').filter((l) => !before.has(l));
        expect(mine.length).toBe(1);
        mine[0]();
        await tick();
        expect(children[1].got).toEqual(['SIGINT']);
        expect(children[2].got).toEqual(['SIGINT']);
        expect(children.length).toBe(3); // no refill after the stop
        children[1].resolve({ exitCode: 130, parsed: false, next: null, message: 'ended by SIGINT' });
        children[2].resolve({ exitCode: 4, parsed: true, next: 9, message: 'awaiting-human: budget' });
        expect(await run).toBe(130);
        const json = JSON.parse(out.filter((l) => l.trim().startsWith('{')).join('\n'));
        expect(json).toMatchObject({ ok: false, parallel: 2, interrupted: true, exitCode: 130, children: [{ index: 0, exitCode: 0, next: 7 }, { index: 1, exitCode: 130, next: null }, { index: 2, exitCode: 4, next: 9 }] });
        expect(json.message).toMatch(/--parallel 2: 3 run\(s\) ended \(stopped by a signal\); exit 130/);
        // The supervisor's listeners are gone.
        expect(process.listeners('SIGINT').filter((l) => !before.has(l))).toEqual([]);
    });
});
//# sourceMappingURL=factory-run-parallel-cli.test.js.map