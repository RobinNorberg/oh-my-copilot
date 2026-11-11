/**
 * B2 CLI: `omg factory run` with factory.run.maxConcurrent above 1. The
 * shared layout refuses parallelism (naming factory.run.layout "private"),
 * --parallel needs the private layout, and the --parallel supervisor spawns
 * min(n, maxConcurrent) children, forwards the stop signal and reports each.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { factoryRunCommand, parallelLayers } from '../factory.js';
import { factoryGuardExec } from '../../../factory/run/exec.js';
import { resolveFactoryRunLimits } from '../../../factory/run/budget.js';
import { factoryRepoOwnerPath, readFactoryState } from '../../../factory/run/state.js';
import { writeTamperHold } from '../../../factory/run/tamper-quarantine.js';
import { FakeProcesses, gitIn, harness } from '../../../factory/run/__tests__/fake-lanes.js';
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
    it('review-487 L-1: with no opt-in in the user config nothing is read (no git, no forge kind); the base layer is read at the sha the remote holds, never at a planted tracking ref', () => {
        const calls = [];
        // origin as the forge config's repository (review-487b BLOCK-2: the remote check before the base read); the local bare repo serves it.
        const remoteUrl = (args) => args[0] === 'remote' && args[1] === 'get-url';
        const spy = (cmd, args, o) => {
            calls.push(`${cmd} ${args.join(' ')}`);
            if (cmd === 'git' && remoteUrl(args))
                return { status: 0, stdout: 'https://github.com/o/r\n', stderr: '' };
            return factoryGuardExec(h.exec, () => ['dev'])(cmd, args, o);
        };
        let kindRead = 0;
        const kind = () => { kindRead += 1; return { kind: 'github', repoUrl: 'https://github.com/o/r' }; };
        expect(parallelLayers(h.root, 'dev', kind, null, spy)).toBeUndefined();
        expect(parallelLayers(h.root, 'dev', kind, { factory: { run: { workDir: '/x' } } }, spy)).toBeUndefined();
        expect(calls).toEqual([]);
        expect(kindRead).toBe(0);
        // The base commits maxConcurrent 3 (pushed); a lane then points refs/remotes/origin/dev at a commit saying 16.
        mkdirSync(join(h.root, '.copilot'), { recursive: true });
        writeFileSync(join(h.root, '.copilot', 'omg.jsonc'), '{ "factory": { "run": { "maxConcurrent": 3 } } }\n');
        gitIn(h.root, 'add', '.copilot/omg.jsonc');
        gitIn(h.root, 'commit', '-q', '-m', 'three');
        gitIn(h.root, 'push', '-q', 'origin', 'dev');
        const real = gitIn(h.root, 'rev-parse', 'HEAD');
        writeFileSync(join(h.root, '.copilot', 'omg.jsonc'), '{ "factory": { "run": { "maxConcurrent": 16, "maxInFlightCredits": 100000 } } }\n');
        gitIn(h.root, 'commit', '-q', '-am', 'sixteen');
        const plantedSha = gitIn(h.root, 'rev-parse', 'HEAD');
        gitIn(h.root, 'reset', '-q', '--hard', real);
        gitIn(h.root, 'update-ref', 'refs/remotes/origin/dev', plantedSha);
        const user = { ship: { trustedBases: ['dev'] }, factory: { run: { layout: 'private' } } };
        const got = parallelLayers(h.root, 'dev', kind, user, spy);
        expect(got?.settings).toMatchObject({ maxConcurrent: 3, source: 'the base .copilot/omg.jsonc' });
        expect(got?.settings.maxInFlightCredits).toBeUndefined();
        expect(got?.layout).toBe('private');
        expect(calls.some((c) => c.startsWith('git ls-remote origin refs/heads/dev'))).toBe(true);
        // The scan lock it read under is released.
        expect(existsSync(factoryRepoOwnerPath(h.root))).toBe(false);
        // Review-487b BLOCK-2: origin naming another repository (or no forge config naming one): no ls-remote, no fetch; the base keys count as unset.
        calls.length = 0;
        out = [];
        const other = parallelLayers(h.root, 'dev', () => ({ kind: 'github', repoUrl: 'https://github.com/someone/else' }), user, spy);
        expect(other?.settings).toMatchObject({ maxConcurrent: 1, source: 'default' });
        expect(calls.filter((c) => / (ls-remote|fetch) /.test(` ${c} `))).toEqual([]);
        expect(out.join('\n')).toMatch(/origin\/dev is not read \(remote origin points at https:\/\/github\.com\/o\/r, but the PR is in https:\/\/github\.com\/someone\/else\)/);
        expect(parallelLayers(h.root, 'dev', () => undefined, user, spy)?.settings.maxConcurrent).toBe(1);
        expect(calls.filter((c) => / (ls-remote|fetch) /.test(` ${c} `))).toEqual([]);
    });
    it('review-487b BLOCK-2: a tamper hold refuses the run before the parallel settings are read (no ls-remote, no fetch)', async () => {
        writeTamperHold(h.ledgerDir, h.root, { root: h.root, at: '2026-11-11T00:00:00.000Z', run: '7', gate: 'lane-tampered', quarantine: join(h.ledgerDir, 'q'), moved: ['hooks/pre-commit'], restored: [], notRestored: [], refs: [] });
        let read = 0;
        const calls = [];
        const plain = deps();
        const d = deps({
            parallel: () => { read += 1; return { settings: { maxConcurrent: 2, source: 'user config' }, layout: 'private' }; },
            exec: (cmd, args, o) => { calls.push(`${cmd} ${args.join(' ')}`); return plain.exec(cmd, args, o); },
        });
        const code = await cli(d, '7');
        expect(code, out.join('\n')).not.toBe(0);
        expect(out.join('\n')).toMatch(/tamper hold/);
        expect(read).toBe(0);
        expect(calls.filter((c) => / (ls-remote|fetch) /.test(` ${c} `))).toEqual([]);
    });
    it('review-487b BLOCK-3: the stop listeners go in before the loader only in a parallel (slot) run; any other run keeps dev\'s order', async () => {
        const seen = [];
        let mode = '';
        const before = new Set(process.listeners('SIGINT'));
        const forge = (_root, _base, opts) => {
            if (opts?.dryRun)
                throw new Error('no forge config');
            seen.push({ mode, listening: process.listeners('SIGINT').filter((l) => !before.has(l)).length });
            throw new Error('loader stops here');
        };
        mode = 'single';
        expect(await cli(deps({ forge }), '7')).not.toBe(0);
        mode = 'slot';
        expect(await cli(deps({ ...parallel(2, 'private'), forge }), '7')).not.toBe(0);
        expect(seen).toEqual([{ mode: 'single', listening: 0 }, { mode: 'slot', listening: 1 }]);
        expect(process.listeners('SIGINT').filter((l) => !before.has(l))).toEqual([]);
    });
    it('review-487 M-3: a second Ctrl+C kills every running child\'s tree (SIGKILL forward) before the supervisor exits 130', async () => {
        const got = [];
        const exits = [];
        const ends = [];
        const d = deps({
            ...parallel(2, 'private'),
            parallelChild: ({ signals }) => new Promise((resolve) => {
                const mine = [];
                got.push(mine);
                const off = signals((s) => { mine.push(s); });
                ends.push(() => { off(); resolve({ exitCode: 130, parsed: false, next: null, message: 'ended' }); });
            }),
        });
        vi.spyOn(process, 'exit').mockImplementation(((code) => { exits.push(`exit ${code} after ${got.map((g) => g.join('+')).join(', ')}`); }));
        const before = new Set(process.listeners('SIGINT'));
        const run = cli(d, '--next', '--parallel', '2', '--json');
        await new Promise((r) => setTimeout(r, 0));
        expect(got.length).toBe(2);
        const [listener] = process.listeners('SIGINT').filter((l) => !before.has(l));
        listener();
        listener();
        // Both children got the stop, then SIGKILL (their trees), and only then the exit.
        expect(exits).toEqual(['exit 130 after SIGINT+SIGKILL, SIGINT+SIGKILL']);
        for (const end of ends)
            end();
        expect(await run).toBe(130);
    });
});
//# sourceMappingURL=factory-run-parallel-cli.test.js.map