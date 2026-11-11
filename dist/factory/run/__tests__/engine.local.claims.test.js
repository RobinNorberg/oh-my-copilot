/**
 * F60 (dogfood round 3): two clones of one repository on the local forge
 * share a claim keyed on the repository's root commit, so a clone does not
 * start an item another clone's run holds (parked included).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scaleTiming } from '../../../__tests__/helpers/platform.js';
import { factoryRunCommand } from '../../../cli/commands/factory.js';
import { resolveForgeConfig } from '../../../forge/config.js';
import { defaultExec } from '../../../ship/exec.js';
import { resolveFactoryRunLimits } from '../budget.js';
import { acquireFactoryClaim, claimRepoKey, factoryClaimPath, isShallowClaimRepo, LOCAL_CLAIM_PREFIX, LOCAL_SHALLOW_CLAIM_PREFIX, localFactoryClaimRepo, removeFactoryClaim, settleFactoryClaim } from '../claims.js';
import { EXIT_BUSY, runFactoryEngine } from '../engine.js';
import { factoryForgeOptions } from '../forge-roots.js';
import { createFactoryState, FactoryBusyError, factoryStatePath, overwriteFactoryState, readFactoryState, requestFactoryCancel } from '../state.js';
import { EngineLedger } from '../ledger.js';
import { commitFile, FakeLanes, gitIn, review } from './fake-lanes.js';
import { lanesFor, LOCAL_ISSUE, localOpts, localTestGateConfig, localWorld } from './engine-local-harness.js';
vi.setConfig({ testTimeout: scaleTiming(300_000) });
let w;
let extra;
afterEach(() => {
    if (w)
        rmSync(w.dir, { recursive: true, force: true });
    if (extra)
        rmSync(extra, { recursive: true, force: true });
    w = undefined;
    extra = undefined;
});
/** A clone of the world's repository with no remote, like a hand-made second checkout. */
function cloneOf(world, name) {
    const clone = join(world.dir, name);
    gitIn(world.dir, 'clone', '-q', world.root, clone);
    gitIn(clone, 'remote', 'remove', 'origin');
    return clone;
}
describe('F60: local-forge claims across clones', () => {
    it('the claim key is the root commit: equal for two clones, unequal for another history, never path-resolved', () => {
        w = localWorld();
        const b = cloneOf(w, 'b');
        const a = localFactoryClaimRepo(defaultExec, w.root);
        expect(a).toBe(`${LOCAL_CLAIM_PREFIX}${gitIn(w.root, 'rev-list', '--max-parents=0', 'HEAD')}`);
        expect(localFactoryClaimRepo(defaultExec, b)).toBe(a);
        expect(claimRepoKey(a, w.root)).toBe(claimRepoKey(a, b));
        expect(factoryClaimPath(w.ledgerDir, a, w.root, 7)).toBe(factoryClaimPath(w.ledgerDir, a, b, 7));
        extra = mkdtempSync(join(tmpdir(), 'omg-factory-other-'));
        gitIn(extra, 'init', '-q', '-b', 'main');
        gitIn(extra, 'commit', '-q', '--allow-empty', '-m', 'other');
        expect(localFactoryClaimRepo(defaultExec, extra)).not.toBe(a);
        // No commit yet: no key (no claim), as without an origin on GitHub.
        const empty = join(extra, 'empty');
        gitIn(extra, 'init', '-q', empty);
        expect(localFactoryClaimRepo(defaultExec, empty)).toBeNull();
    });
    it('a shallow clone gets a key of its own (local-shallow:<boundary root>), never the full clones\' key', () => {
        w = localWorld();
        gitIn(w.root, 'commit', '-q', '--allow-empty', '-m', 'second');
        const shallow = join(w.dir, 'shallow');
        gitIn(w.dir, 'clone', '-q', '--depth', '1', `file://${w.root.replace(/\\/g, '/')}`, shallow);
        const key = localFactoryClaimRepo(defaultExec, shallow);
        expect(key).toBe(`${LOCAL_SHALLOW_CLAIM_PREFIX}${gitIn(shallow, 'rev-parse', 'HEAD')}`);
        expect(isShallowClaimRepo(key)).toBe(true);
        expect(claimRepoKey(key, shallow)).not.toBe(claimRepoKey(localFactoryClaimRepo(defaultExec, w.root), w.root));
    });
    it('N4: in a depth-1 clone run (dry and real), status, release, clean and reset all work, each warning once that the clone shares no claims', async () => {
        w = localWorld();
        gitIn(w.root, 'commit', '-q', '--allow-empty', '-m', 'second');
        const origin = `file://${w.root.replace(/\\/g, '/')}`;
        let root = '';
        let lanes = new FakeLanes(w.root, []);
        const deps = {
            exec: (cmd, args, opts) => (cmd === 'git' && args.join(' ') === 'rev-parse --show-toplevel' ? { status: 0, stdout: `${root}\n`, stderr: '' } : defaultExec(cmd, args, opts)),
            lanes: () => lanes,
            limits: () => resolveFactoryRunLimits(undefined, undefined),
            base: () => 'main',
            ledgerDir: w.ledgerDir,
            gateConfig: localTestGateConfig,
            forge: (r) => resolveForgeConfig({ factory: { forge: { kind: 'local', local: { gate: ['node', '--test'] } } } }, undefined, undefined, undefined, { root: r, stateDir: join(w.dir, `forge-state-${basename(r)}`) }),
        };
        let out = [];
        vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
        vi.spyOn(console, 'error').mockImplementation((...a) => { out.push(a.join(' ')); });
        const WARNING = /is a shallow clone, so its claims are keyed local-shallow:[0-9a-f]{40} and not shared with full clones \(a full clone may run the same item; shallow clones at the same boundary do share them\)/;
        const cli = async (warnings, ...argv) => {
            out = [];
            process.exitCode = undefined;
            await factoryRunCommand(deps).parseAsync(argv, { from: 'user' });
            const code = Number(process.exitCode ?? 0);
            process.exitCode = undefined;
            const text = out.join('\n');
            // One warning line per command that reads the claim key, and never the old refusal.
            expect(text.split('\n').filter((l) => WARNING.test(l)), `${argv.join(' ')}: ${text}`).toHaveLength(warnings);
            expect(text).not.toMatch(/keys its cross-clone claims on the root commit, which a shallow history does not have/);
            return { code, text };
        };
        try {
            // A clone made shallow: status, dry run and run get past the claim.
            root = join(w.dir, 'shallow');
            gitIn(w.dir, 'clone', '-q', '--depth', '1', origin, root);
            gitIn(root, 'remote', 'remove', 'origin');
            expect((await cli(1, 'status')).code).toBe(0);
            const dry = await cli(1, String(LOCAL_ISSUE), '--dry-run', '--json');
            expect(dry.code, dry.text).toBe(0);
            // The real run is never busy and never refused for its claim; the mirror then takes no shallow history,
            // which the run says with the way out.
            const real = await cli(1, String(LOCAL_ISSUE));
            expect(real.code, real.text).not.toBe(EXIT_BUSY);
            expect(real.text).toMatch(/shallow clone and the local forge mirror takes no shallow history, so main cannot be synced to it; git fetch --unshallow/);
            expect((await cli(1, 'release', String(LOCAL_ISSUE))).code).toBe(0);
            // A run cancelled mid-lane in a full clone that is made shallow afterwards: clean, reset, release, run work.
            root = join(w.dir, 'later');
            gitIn(w.dir, 'clone', '-q', origin, root);
            lanes = new FakeLanes(root, [() => ({ finalText: 'never read' })], [2]);
            lanes.onRunningPoll = () => requestFactoryCancel(root, LOCAL_ISSUE, new Date().toISOString());
            const full = await cli(0, String(LOCAL_ISSUE));
            expect(readFactoryState(root, LOCAL_ISSUE)?.phase, full.text).toBe('cancelled');
            gitIn(root, 'fetch', '-q', '--depth', '1', 'origin', 'main');
            gitIn(root, 'remote', 'remove', 'origin');
            expect(gitIn(root, 'rev-parse', '--is-shallow-repository')).toBe('true');
            expect((await cli(1, 'status', '--json')).code).toBe(0);
            expect((await cli(1, String(LOCAL_ISSUE), '--dry-run')).code).toBe(0);
            const again = await cli(1, String(LOCAL_ISSUE));
            expect(again.code, again.text).toBe(0);
            expect(again.text).toMatch(/is cancelled/);
            const cleaned = await cli(1, 'clean', String(LOCAL_ISSUE));
            expect(cleaned.code, cleaned.text).toBe(0);
            const reset = await cli(1, 'reset', String(LOCAL_ISSUE));
            expect(reset.code, reset.text).toBe(0);
            expect(reset.text).toMatch(/starts a new run/);
            const released = await cli(1, 'release', String(LOCAL_ISSUE));
            expect(released.code, released.text).toBe(0);
        }
        finally {
            vi.restoreAllMocks();
        }
    });
    it('N4: a shallow clone\'s clean / reset / release also remove this checkout\'s claim recorded under another key', () => {
        w = localWorld();
        const other = `${LOCAL_CLAIM_PREFIX}${'a'.repeat(40)}`;
        const recorded = factoryClaimPath(w.ledgerDir, other, w.root, 7);
        const foreign = factoryClaimPath(w.ledgerDir, other, w.root, 8);
        mkdirSync(join(recorded, '..'), { recursive: true });
        writeFileSync(recorded, JSON.stringify({ hostname: 'h', startedAt: '2026-11-10T00:00:00.000Z', run: '7', root: w.root, parkedAt: '2026-11-10T01:00:00.000Z' }));
        writeFileSync(foreign, JSON.stringify({ hostname: 'h', startedAt: '2026-11-10T00:00:00.000Z', run: '8', root: join(w.dir, 'elsewhere'), parkedAt: '2026-11-10T01:00:00.000Z' }));
        const shallowKey = `${LOCAL_SHALLOW_CLAIM_PREFIX}${'b'.repeat(40)}`;
        expect(removeFactoryClaim(w.ledgerDir, shallowKey, w.root, 7, { onlyRoot: true })).toBe(recorded);
        expect(existsSync(recorded)).toBe(false);
        // Another checkout's claim under that key is never removed.
        expect(removeFactoryClaim(w.ledgerDir, shallowKey, w.root, 8)).toBeNull();
        expect(existsSync(foreign)).toBe(true);
        // F4: a full local clone's key (after git fetch --unshallow) sweeps this checkout's record under the old key too.
        writeFileSync(recorded, JSON.stringify({ hostname: 'h', startedAt: '2026-11-10T00:00:00.000Z', run: '7', root: w.root, parkedAt: '2026-11-10T01:00:00.000Z' }));
        expect(removeFactoryClaim(w.ledgerDir, `${LOCAL_CLAIM_PREFIX}${'c'.repeat(40)}`, w.root, 7, { onlyRoot: true })).toBe(recorded);
        expect(existsSync(recorded)).toBe(false);
        // A GitHub key never scans other keys.
        writeFileSync(recorded, JSON.stringify({ hostname: 'h', startedAt: '2026-11-10T00:00:00.000Z', run: '7', root: w.root, parkedAt: '2026-11-10T01:00:00.000Z' }));
        expect(removeFactoryClaim(w.ledgerDir, 'https://github.com/o/r', w.root, 7, { onlyRoot: true })).toBeNull();
        expect(existsSync(recorded)).toBe(true);
    });
    it('F1: another checkout\'s LIVE claim of the same item number under another key never makes the sweep busy', () => {
        const x = localWorld();
        w = x;
        const liveFor = (root, run) => JSON.stringify({ pid: 1, hostname: 'another-host', startedAt: '2026-11-10T00:00:00.000Z', run, root });
        // A full clone of this repository, and another repository on this machine, each running item #7 right now.
        const fullClone = factoryClaimPath(x.ledgerDir, `${LOCAL_CLAIM_PREFIX}${'a'.repeat(40)}`, join(x.dir, 'full'), 7);
        const otherRepo = factoryClaimPath(x.ledgerDir, 'https://github.com/someone/else', join(x.dir, 'else'), 7);
        for (const [path, root] of [[fullClone, join(x.dir, 'full')], [otherRepo, join(x.dir, 'else')]]) {
            mkdirSync(join(path, '..'), { recursive: true });
            writeFileSync(path, liveFor(root, '7'));
        }
        // This checkout's own parked record under a third key still goes.
        const mine = factoryClaimPath(x.ledgerDir, `${LOCAL_CLAIM_PREFIX}${'d'.repeat(40)}`, x.root, 7);
        mkdirSync(join(mine, '..'), { recursive: true });
        writeFileSync(mine, JSON.stringify({ hostname: 'h', startedAt: '2026-11-10T00:00:00.000Z', run: '7', root: x.root, parkedAt: '2026-11-10T01:00:00.000Z' }));
        const shallowKey = `${LOCAL_SHALLOW_CLAIM_PREFIX}${'b'.repeat(40)}`;
        expect(removeFactoryClaim(x.ledgerDir, shallowKey, x.root, 7, { onlyRoot: true })).toBe(mine);
        expect(existsSync(fullClone)).toBe(true);
        expect(existsSync(otherRepo)).toBe(true);
        // A live claim this checkout recorded under another key is still busy for clean / reset.
        writeFileSync(mine, liveFor(x.root, '7'));
        expect(() => removeFactoryClaim(x.ledgerDir, shallowKey, x.root, 7, { onlyRoot: true })).toThrow(FactoryBusyError);
    });
    it('F4: a terminal settle sweeps this checkout\'s claim left under the old shallow key; a park keeps it; another checkout\'s stays', () => {
        const x = localWorld();
        w = x;
        const old = factoryClaimPath(x.ledgerDir, `${LOCAL_SHALLOW_CLAIM_PREFIX}${'b'.repeat(40)}`, x.root, 9);
        const foreign = factoryClaimPath(x.ledgerDir, `${LOCAL_SHALLOW_CLAIM_PREFIX}${'b'.repeat(40)}`, x.root, 10);
        mkdirSync(join(old, '..'), { recursive: true });
        const parked = (root, run) => JSON.stringify({ hostname: 'h', startedAt: '2026-11-10T00:00:00.000Z', run, root, parkedAt: '2026-11-10T01:00:00.000Z' });
        writeFileSync(old, parked(x.root, '9'));
        writeFileSync(foreign, parked(join(x.dir, 'elsewhere'), '10'));
        const fullKey = `${LOCAL_CLAIM_PREFIX}${'c'.repeat(40)}`;
        const owner = { pid: process.pid, hostname: 'h', isAlive: () => true };
        // The run state of #9 here: in flight (review), so the settle parks and the old record stays.
        const statePath = factoryStatePath(x.root, 9);
        mkdirSync(join(statePath, '..'), { recursive: true });
        const write = (phase) => {
            const { content } = overwriteFactoryState(x.root, 9, { ...createFactoryState({ issue: 9, repoUrl: 'x', base: 'main' }, '2026-11-10T00:00:00.000Z'), phase });
            EngineLedger.open(x.ledgerDir, x.root, 9).record(statePath, content);
        };
        write('review');
        const held = acquireFactoryClaim(x.ledgerDir, fullKey, x.root, 9, '2026-11-10T02:00:00.000Z', owner);
        expect(settleFactoryClaim(held, x.root, 9, x.ledgerDir, '2026-11-10T03:00:00.000Z')).toBe('parked');
        expect(existsSync(old)).toBe(true);
        write('merged');
        const again = acquireFactoryClaim(x.ledgerDir, fullKey, x.root, 9, '2026-11-10T04:00:00.000Z', owner);
        expect(settleFactoryClaim(again, x.root, 9, x.ledgerDir, '2026-11-10T05:00:00.000Z')).toBe('released');
        expect(existsSync(factoryClaimPath(x.ledgerDir, fullKey, x.root, 9))).toBe(false);
        expect(existsSync(old)).toBe(false);
        expect(existsSync(foreign)).toBe(true);
    });
    it('a run parked in clone A makes the same item busy (exit 6) in clone B, dry run included', async () => {
        w = localWorld();
        const first = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/greet.js', 'export const greet = () => "hi";\n'), review('approve')])));
        expect(first.gate?.name, first.message).toBe('merge');
        const b = cloneOf(w, 'b');
        const stateDirB = join(w.dir, 'forge-state-b');
        const { config } = resolveForgeConfig({ factory: { forge: { kind: 'local', local: { gate: ['node', '--test'] } } } }, undefined, undefined, undefined, { root: b, stateDir: stateDirB });
        expect(config.repo.url).not.toBe(w.config.repo.url);
        const inB = { ...localOpts(w, lanesFor(w, [])), root: b, forge: { config, options: { ...factoryForgeOptions(b), stateDir: stateDirB } } };
        const dry = await runFactoryEngine({ ...inB, dryRun: true });
        expect(dry.exitCode, dry.message).toBe(EXIT_BUSY);
        expect(dry.message).toMatch(new RegExp(`factory run #${LOCAL_ISSUE} is .*one engine runs an item at a time across clones`));
        // The real run refuses busy (the CLI exits 6) before any fetch, worktree or lane.
        await expect(runFactoryEngine(inB)).rejects.toThrow(FactoryBusyError);
    });
});
//# sourceMappingURL=engine.local.claims.test.js.map