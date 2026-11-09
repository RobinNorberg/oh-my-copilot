import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGateProcTracker, gateProcsPath, readGateProcs, reapGateProcs } from '../gate-procs.js';
import { runLocalGate } from '../local-gate.js';
import { isProcessAlive } from '../../../platform/process-utils.js';
const HEAD = 'a'.repeat(40);
let tmp;
const children = [];
beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'omg-gate-procs-'));
});
afterEach(() => {
    // Only children this test spawned itself.
    for (const c of children.splice(0)) {
        try {
            c.kill('SIGKILL');
        }
        catch { /* gone */ }
    }
    rmSync(tmp, { recursive: true, force: true });
});
const spawnSleeper = () => {
    const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
    children.push(c);
    return c;
};
const waitDead = async (pid, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (!isProcessAlive(pid))
            return true;
        await new Promise((r) => setTimeout(r, 100));
    }
    return !isProcessAlive(pid);
};
const fakeDeps = (over = {}) => {
    const killed = [];
    const groups = [];
    return {
        platform: 'win32',
        identitySync: (pid) => `ticks:${pid}0`,
        identity: async (pid) => `ticks:${pid}0`,
        terminateTree: async (p) => { killed.push(p); return 'terminated'; },
        terminateGroup: async (p, g) => { killed.push(p); groups.push(g); return 'terminated'; },
        listChildren: async () => [],
        killed,
        groups,
        ...over,
    };
};
// .NET ticks of 2026-01-01T00:00:00Z plus n seconds
const ticksAt = (sec) => BigInt(Date.UTC(2026, 0, 1) + sec * 1000) * 10000n + 621355968000000000n;
describe('gate process bookkeeping (injected process table)', () => {
    it('Windows: kills only children created inside the gate window whose start identity matches, and records them first', async () => {
        const path = join(tmp, 'p.json');
        const startedAt = Date.UTC(2026, 0, 1);
        const exitedAt = startedAt + 10_000;
        const identityOf = (pid) => (pid === 11 ? `ticks:${ticksAt(2)}` : pid === 12 ? `ticks:${ticksAt(3)}` : `ticks:${ticksAt(4)}`);
        const deps = fakeDeps({
            identitySync: () => 'ticks:1',
            identity: async (pid) => identityOf(pid),
            listChildren: async () => [
                { pid: 11, created: ticksAt(2) }, // inside the window, identity matches
                { pid: 12, created: ticksAt(-5) }, // created before the gate started
                { pid: 13, created: ticksAt(30) }, // created after the root exited (a reused root pid's child)
                { pid: 14, created: ticksAt(9) }, // inside the window but the pid now has another start time (reused)
            ],
        });
        const t = createGateProcTracker(path, startedAt, deps);
        t.spawned(7);
        await t.rootGone(exitedAt);
        expect(deps.killed.map((k) => k.pid)).toEqual([11]);
        expect(readGateProcs(path)?.orphans).toEqual([]);
    });
    it('Windows: an orphan that could not be killed stays recorded for the next run', async () => {
        const path = join(tmp, 'p.json');
        const startedAt = Date.UTC(2026, 0, 1);
        const deps = fakeDeps({
            identity: async () => `ticks:${ticksAt(2)}`,
            listChildren: async () => [{ pid: 11, created: ticksAt(2) }],
            terminateTree: async () => 'deadline-exceeded',
        });
        const t = createGateProcTracker(path, startedAt, deps);
        t.spawned(7);
        await t.rootGone(startedAt + 10_000);
        expect(readGateProcs(path)?.orphans).toEqual([{ pid: 11, identity: `ticks:${ticksAt(2)}` }]);
        const next = fakeDeps();
        await reapGateProcs(path, next);
        expect(next.killed.map((k) => k.pid)).toEqual([11, 7]);
        expect(existsSync(path)).toBe(false);
    });
    it('records nothing when the root identity cannot be read, and signals nothing on reap', async () => {
        const path = join(tmp, 'p.json');
        const deps = fakeDeps({ identitySync: () => null, platform: 'linux' });
        createGateProcTracker(path, Date.now(), deps).spawned(7);
        expect(existsSync(path)).toBe(false);
        await reapGateProcs(path, deps);
        expect(deps.killed).toEqual([]);
    });
    it('POSIX: the group is signalled through the recorded leader and group id only', async () => {
        const path = join(tmp, 'p.json');
        const deps = fakeDeps({ platform: 'linux' });
        createGateProcTracker(path, Date.now(), deps).spawned(4242);
        expect(readGateProcs(path)).toMatchObject({ root: { pid: 4242 }, pgid: 4242, orphans: [] });
        await reapGateProcs(path, deps);
        expect(deps.killed.map((k) => k.pid)).toEqual([4242]);
        expect(deps.groups).toEqual([4242]);
        expect(existsSync(path)).toBe(false);
    });
    it('a malformed or tampered record is never trusted', async () => {
        const path = join(tmp, 'p.json');
        for (const text of ['{ nope', JSON.stringify({ version: 1, startedAt: 'x', orphans: [{ pid: -1, identity: 'i' }] }), JSON.stringify({ version: 2, startedAt: 'x', orphans: [] }), JSON.stringify({ version: 1, startedAt: 'x', orphans: [], root: { pid: 5 } })]) {
            writeFileSync(path, text);
            const deps = fakeDeps();
            await reapGateProcs(path, deps);
            expect(deps.killed, text).toEqual([]);
            expect(existsSync(path)).toBe(false);
        }
    });
});
describe('gate process cleanup against real processes', () => {
    it('kills a leftover gate root whose start identity still matches, from a record a dead engine left', async () => {
        const child = spawnSleeper();
        const path = gateProcsPath(tmp, tmp, HEAD);
        createGateProcTracker(path, Date.now()).spawned(child.pid);
        expect(readGateProcs(path)?.root?.pid).toBe(child.pid);
        await reapGateProcs(path);
        expect(await waitDead(child.pid)).toBe(true);
        expect(existsSync(path)).toBe(false);
    }, 60_000);
    it('never kills a live process whose start identity differs from the recorded one (a reused pid)', async () => {
        const child = spawnSleeper();
        const path = gateProcsPath(tmp, tmp, HEAD);
        createGateProcTracker(path, Date.now()).spawned(child.pid);
        const rec = JSON.parse(readFileSync(path, 'utf8'));
        rec.root.identity = rec.root.identity.startsWith('ticks:') ? 'ticks:1' : '1';
        rec.orphans.push({ pid: child.pid, identity: rec.root.identity });
        writeFileSync(path, JSON.stringify(rec));
        await reapGateProcs(path);
        expect(isProcessAlive(child.pid)).toBe(true);
        expect(existsSync(path)).toBe(false);
    }, 60_000);
    it.runIf(process.platform === 'win32')('Windows: a descendant that outlives the gate root and holds its pipes is killed before the verdict', async () => {
        const script = join(tmp, 'gate.cjs');
        writeFileSync(script, [
            "const { spawn } = require('child_process');",
            "const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });",
            'console.log("GRANDCHILD=" + c.pid);',
            'setTimeout(() => process.exit(0), 300);',
        ].join('\n'));
        const out = await runLocalGate({ stateDir: join(tmp, 'state'), root: tmp, head: HEAD, gate: ['node', script], timeoutMinutes: 2, checkout: tmp });
        expect(out.started).toBe(true);
        const pid = Number(/GRANDCHILD=(\d+)/.exec(out.started ? (out.record.tail ?? '') : '')?.[1]);
        expect(pid).toBeGreaterThan(0);
        children.push({ kill: () => { try {
                process.kill(pid, 'SIGKILL');
            }
            catch { /* gone */ } } });
        expect(await waitDead(pid, 30_000)).toBe(true);
        expect(out.started && out.record.state).toBe('SUCCESS');
    }, 120_000);
});
//# sourceMappingURL=local-gate.orphans.test.js.map