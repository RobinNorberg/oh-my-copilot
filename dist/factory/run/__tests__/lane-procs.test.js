import { describe, expect, it } from 'vitest';
import { identityStart, laneTree, parseProcStat, parsePsRows, parseWindowsRows, proveLaneTreeGone } from '../lane-procs.js';
/** A scripted process table: `kill` removes the pid unless it is in `unkillable`; `failList` makes the n-th listing throw. */
function fakeDeps(rows, o = {}) {
    let table = [...rows];
    let lists = 0;
    const killed = [];
    const platform = o.platform ?? 'linux';
    const deps = {
        platform,
        self: 1,
        list: async () => {
            lists++;
            if (o.failList?.includes(lists))
                throw new Error('CIM unavailable');
            return table.map((r) => ({ ...r }));
        },
        identity: async (pid) => {
            const r = table.find((x) => x.pid === pid);
            if (!r || r.start === null)
                return null;
            return platform === 'win32' ? `ticks:${r.start * 10n}` : String(r.start);
        },
        kill: async (pid) => {
            killed.push(pid);
            if (!o.unkillable?.includes(pid))
                table = table.filter((r) => r.pid !== pid);
            if (o.spawnOnKill) {
                table.push(o.spawnOnKill);
                o.spawnOnKill = undefined;
            }
        },
        state: async (pid) => (table.some((r) => r.pid === pid) ? 'live' : 'dead'),
    };
    return { deps, killed, lists: () => lists };
}
const runtime = { pid: 100, identity: '5000' };
describe('laneTree', () => {
    it('finds an orphan whose parent (the runtime) is dead, through its parent link', () => {
        // 100 (the runtime) is gone; 200 was its child; 300 is 200's child.
        const rows = [{ pid: 200, ppid: 100, start: 5100n }, { pid: 300, ppid: 200, start: 5200n }, { pid: 400, ppid: 1, start: 10n }];
        expect(laneTree(rows, { pid: 100, start: 5000n }, null, 1).sort()).toEqual([200, 300]);
    });
    it('ignores a process that names the runtime pid but is older than it (pid reuse of an earlier holder)', () => {
        const rows = [{ pid: 200, ppid: 100, start: 4000n }];
        expect(laneTree(rows, { pid: 100, start: 5000n }, null, 1)).toEqual([]);
    });
    it('ignores the children of a new process that reused the runtime pid', () => {
        // 100 now names another process started at 7000; its child 500 (7100) is not the lane's, the lane's 200 (5100) is.
        const rows = [{ pid: 100, ppid: 1, start: 7000n }, { pid: 500, ppid: 100, start: 7100n }, { pid: 200, ppid: 100, start: 5100n }];
        expect(laneTree(rows, { pid: 100, start: 5000n }, null, 1)).toEqual([200]);
    });
    it('counts the runtime itself only while it runs with its own start', () => {
        expect(laneTree([{ pid: 100, ppid: 1, start: 5000n }], { pid: 100, start: 5000n }, null, 1)).toEqual([100]);
    });
    it('Linux: a re-parented process whose cwd is under the worktree, started after the runtime', () => {
        const rows = [
            { pid: 600, ppid: 1, start: 6000n, cwd: '/w/lane-1/src' },
            { pid: 601, ppid: 600, start: 6001n },
            { pid: 700, ppid: 1, start: 100n, cwd: '/w/lane-1' }, // older than the runtime: not the lane's
            { pid: 800, ppid: 1, start: 6000n, cwd: '/w/lane-10' },
        ];
        expect(laneTree(rows, { pid: 100, start: 5000n }, '/w/lane-1', 1).sort()).toEqual([600, 601]);
    });
});
describe('proveLaneTreeGone', () => {
    it('nothing left: gone, no kill', async () => {
        const { deps, killed } = fakeDeps([{ pid: 400, ppid: 1, start: 10n }]);
        expect(await proveLaneTreeGone({ process: runtime }, deps)).toEqual({ kind: 'gone', killed: [] });
        expect(killed).toEqual([]);
    });
    it('an orphan is killed by identity, then the second listing proves it gone', async () => {
        const { deps, killed } = fakeDeps([{ pid: 200, ppid: 100, start: 5100n }]);
        expect(await proveLaneTreeGone({ process: runtime }, deps)).toEqual({ kind: 'gone', killed: [200] });
        expect(killed).toEqual([200]);
    });
    it('an unkillable survivor parks with its pid', async () => {
        const { deps } = fakeDeps([{ pid: 200, ppid: 100, start: 5100n }, { pid: 300, ppid: 200, start: 5200n }], { unkillable: [300] });
        expect(await proveLaneTreeGone({ process: runtime }, deps)).toEqual({ kind: 'survivors', pids: [300] });
    });
    it('a child spawned while the engine killed counts as a survivor', async () => {
        const { deps } = fakeDeps([{ pid: 200, ppid: 100, start: 5100n }], { spawnOnKill: { pid: 900, ppid: 100, start: 5300n } });
        expect(await proveLaneTreeGone({ process: runtime }, deps)).toEqual({ kind: 'survivors', pids: [900] });
    });
    it('a failed listing is unproven (warn, no park), never survivors', async () => {
        const { deps, killed } = fakeDeps([{ pid: 200, ppid: 100, start: 5100n }], { failList: [1] });
        const proof = await proveLaneTreeGone({ process: runtime }, deps);
        expect(proof.kind).toBe('unproven');
        expect(proof.why).toMatch(/CIM unavailable/);
        expect(killed).toEqual([]);
    });
    it('a second listing that fails falls back to the identity check of each killed pid', async () => {
        const gone = fakeDeps([{ pid: 200, ppid: 100, start: 5100n }], { failList: [2] });
        expect(await proveLaneTreeGone({ process: runtime }, gone.deps)).toEqual({ kind: 'gone', killed: [200] });
        const alive = fakeDeps([{ pid: 200, ppid: 100, start: 5100n }], { failList: [2], unkillable: [200] });
        expect(await proveLaneTreeGone({ process: runtime }, alive.deps)).toEqual({ kind: 'survivors', pids: [200] });
    });
    it('no recorded runtime or no usable identity: unproven, nothing listed', async () => {
        const { deps, lists } = fakeDeps([]);
        expect((await proveLaneTreeGone({ process: null }, deps)).kind).toBe('unproven');
        expect((await proveLaneTreeGone({ process: { pid: 100, identity: null } }, deps)).kind).toBe('unproven');
        expect((await proveLaneTreeGone({ process: { pid: 100, identity: 'ticks:job-1' } }, deps)).kind).toBe('unproven');
        expect(lists()).toBe(0);
    });
    it('Windows: the runtime identity (StartTime ticks) matches CIM microseconds', async () => {
        const { deps, killed } = fakeDeps([{ pid: 200, ppid: 100, start: 638000000000000123n }], { platform: 'win32' });
        // StartTime ticks 6_380_000_000_000_001_229 = 638_000_000_000_000_122.9 us: the child is 0.1 us later, so it counts.
        expect(await proveLaneTreeGone({ process: { pid: 100, identity: 'ticks:6380000000000001229' } }, deps)).toEqual({ kind: 'gone', killed: [200] });
        expect(killed).toEqual([200]);
    });
});
describe('listing parsers', () => {
    it('identityStart per platform', () => {
        expect(identityStart('ticks:12345', 'win32')).toBe(1234n);
        expect(identityStart('12345', 'linux')).toBe(12345n);
        expect(identityStart('ticks:12345', 'linux')).toBeNull();
        expect(identityStart(null, 'darwin')).toBeNull();
    });
    it('Windows CIM lines, a process without a creation date, and an empty listing', () => {
        expect(parseWindowsRows('4 0 -\r\n200 100 6380000000000001230\r\n')).toEqual([{ pid: 4, ppid: 0, start: null }, { pid: 200, ppid: 100, start: 638000000000000123n }]);
        expect(() => parseWindowsRows('')).toThrow(/no process/);
    });
    it('/proc stat with a name holding spaces and parentheses', () => {
        const fields = ['S', '77', ...Array(17).fill('0'), '987654'];
        expect(parseProcStat(`123 (a (b) c) ${fields.join(' ')} 0 0`)).toEqual({ ppid: 77, start: 987654n });
    });
    it('macOS ps lstart lines', () => {
        const rows = parsePsRows('  200   100 Mon Nov 10 12:00:00 2026\n');
        expect(rows).toEqual([{ pid: 200, ppid: 100, start: BigInt(new Date('Mon Nov 10 12:00:00 2026').getTime()) }]);
    });
});
//# sourceMappingURL=lane-procs.test.js.map