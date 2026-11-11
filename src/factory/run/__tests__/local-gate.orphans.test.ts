import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGateProcTracker, gateProcsPath, liveGateProcs, readGateProcs, reapGateProcs, sweepGateProcs, type GateProcDeps } from '../gate-procs.js';
import { runLocalGate } from '../local-gate.js';
import { isProcessAlive } from '../../../platform/process-utils.js';

const HEAD = 'a'.repeat(40);
let tmp: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'omg-gate-procs-'));
});
afterEach(() => {
  // Only children this test spawned itself.
  for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  rmSync(tmp, { recursive: true, force: true });
});

const spawnSleeper = (): ChildProcess => {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
  children.push(c);
  return c;
};
const waitDead = async (pid: number, ms = 20_000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isProcessAlive(pid);
};

const fakeDeps = (over: Partial<GateProcDeps> = {}): GateProcDeps & { killed: Array<{ pid: number; identity: string }>; groups: number[] } => {
  const killed: Array<{ pid: number; identity: string }> = [];
  const groups: number[] = [];
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
const ticksAt = (sec: number): bigint => BigInt(Date.UTC(2026, 0, 1) + sec * 1000) * 10000n + 621355968000000000n;

describe('gate process bookkeeping (injected process table)', () => {
  it('Windows: kills only children created inside the gate window whose start identity matches, and records them first', async () => {
    const path = join(tmp, 'p.json');
    const startedAt = Date.UTC(2026, 0, 1);
    const exitedAt = startedAt + 10_000;
    const identityOf = (pid: number) => (pid === 11 ? `ticks:${ticksAt(2)}` : pid === 12 ? `ticks:${ticksAt(3)}` : `ticks:${ticksAt(4)}`);
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
    createGateProcTracker(path, Date.now()).spawned(child.pid!);
    expect(readGateProcs(path)?.root?.pid).toBe(child.pid);
    await reapGateProcs(path);
    expect(await waitDead(child.pid!)).toBe(true);
    expect(existsSync(path)).toBe(false);
  }, 60_000);

  it('never kills a live process whose start identity differs from the recorded one (a reused pid)', async () => {
    const child = spawnSleeper();
    const path = gateProcsPath(tmp, tmp, HEAD);
    createGateProcTracker(path, Date.now()).spawned(child.pid!);
    const rec = JSON.parse(readFileSync(path, 'utf8')) as { root: { identity: string }; orphans: Array<{ pid: number; identity: string }> };
    rec.root.identity = rec.root.identity.startsWith('ticks:') ? 'ticks:1' : '1';
    rec.orphans.push({ pid: child.pid!, identity: rec.root.identity });
    writeFileSync(path, JSON.stringify(rec));
    await reapGateProcs(path);
    expect(isProcessAlive(child.pid!)).toBe(true);
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
    const out = await runLocalGate({ mode: 'unsandboxed', stateDir: join(tmp, 'state'), root: tmp, head: HEAD, gate: ['node', script], timeoutMinutes: 2, checkout: tmp });
    expect(out.started).toBe(true);
    const pid = Number(/GRANDCHILD=(\d+)/.exec(out.started ? (out.record.tail ?? '') : '')?.[1]);
    expect(pid).toBeGreaterThan(0);
    children.push({ kill: () => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } } as unknown as ChildProcess);
    expect(await waitDead(pid, 30_000)).toBe(true);
    expect(out.started && out.record.state).toBe('SUCCESS');
  }, 120_000);
});

describe('gate process bookkeeping hardening', () => {
  const write = (path: string, rec: object): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(rec)); };
  const rec = (over: object = {}) => ({ version: 1, startedAt: new Date().toISOString(), orphans: [], ...over });

  it('rejects a head that is not 40-hex lowercase', () => {
    for (const head of ['abc', '../x', 'A'.repeat(40), `${'a'.repeat(39)}/`]) expect(() => gateProcsPath(tmp, tmp, head), head).toThrow(/not a 40-hex commit/);
  });

  it('ignores a record whose pgid is not its root pid (forged)', () => {
    const path = join(tmp, 'p.json');
    write(path, rec({ root: { pid: 4242, identity: '1' }, pgid: 1 }));
    expect(readGateProcs(path)).toBeUndefined();
    write(path, rec({ pgid: 4242 }));
    expect(readGateProcs(path)).toBeUndefined();
    write(path, rec({ root: { pid: 4242, identity: '1' }, pgid: 4242 }));
    expect(readGateProcs(path)?.pgid).toBe(4242);
  });

  it('never signals the engine itself or its parent, whatever a record says', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      for (const pid of [process.pid, process.ppid]) {
        const path = join(tmp, `${platform}-${pid}.json`);
        write(path, rec({ root: { pid, identity: '1' }, pgid: pid, orphans: [{ pid, identity: '1' }] }));
        const deps = fakeDeps({ platform });
        await reapGateProcs(path, deps);
        expect(deps.killed, `${platform} ${pid}`).toEqual([]);
        expect(existsSync(path)).toBe(false);
      }
    }
  });

  it('sweeps the records of other heads once per process', async () => {
    const dir = join(tmp, 'sweep');
    const other = join(dir, `${'b'.repeat(40)}.json`);
    write(other, rec({ root: { pid: 4242, identity: '7' }, pgid: 4242 }));
    write(join(dir, 'not-a-record.txt'), {});
    const deps = fakeDeps({ platform: 'linux' });
    await sweepGateProcs(dir, deps);
    expect(deps.killed).toEqual([{ pid: 4242, identity: '7' }]);
    expect(existsSync(other)).toBe(false);
    expect(existsSync(join(dir, 'not-a-record.txt'))).toBe(true);
    write(other, rec({ root: { pid: 4242, identity: '7' }, pgid: 4242 }));
    await sweepGateProcs(dir, deps);
    expect(deps.killed).toHaveLength(1);
  });

  it('says so when the root cannot be identified, instead of silently recording nothing', () => {
    const messages: string[] = [];
    createGateProcTracker(join(tmp, 'p.json'), Date.now(), fakeDeps({ identitySync: () => null }), (m) => messages.push(m)).spawned(4242);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/4242/);
    expect(existsSync(join(tmp, 'p.json'))).toBe(false);
  });

  it('takes the orphan window start from the wall clock even when the engine clock is injected', async () => {
    const sleeper = spawnSleeper();
    let startedAt = '';
    const path = gateProcsPath(join(tmp, 'state'), tmp, HEAD);
    await runLocalGate({ mode: 'unsandboxed',
      stateDir: join(tmp, 'state'), root: tmp, head: HEAD, gate: ['node', 'x.js'], timeoutMinutes: 1, checkout: tmp, now: () => new Date(Date.UTC(2000, 0, 1)),
      runner: async (_argv, _cwd, _t, track) => {
        track?.spawned(sleeper.pid!);
        startedAt = readGateProcs(path)?.startedAt ?? '';
        return { status: 0, stdout: '', stderr: '', timedOut: false };
      },
    });
    expect(Date.now() - new Date(startedAt).getTime()).toBeLessThan(60_000);
  }, 60_000);
});

describe('liveGateProcs (review-483 I.4: the proof before a private run dir is removed)', () => {
  it('names only recorded pids whose start identity still matches; signals nothing; a missing dir or a malformed record names none', () => {
    const dir = join(tmp, 'prepare-procs');
    expect(liveGateProcs(dir)).toEqual([]);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${'b'.repeat(40)}.json`), JSON.stringify({ version: 1, startedAt: new Date().toISOString(), root: { pid: 1001, identity: 'ticks:1' }, orphans: [{ pid: 1002, identity: 'ticks:2' }, { pid: 1003, identity: 'ticks:3' }] }));
    writeFileSync(join(dir, `${'c'.repeat(40)}.json`), '{ not json');
    writeFileSync(join(dir, 'notes.json'), JSON.stringify({ version: 1, startedAt: 'x', root: { pid: 1004, identity: 'ticks:4' }, orphans: [] }));
    const now: Record<number, string> = { 1001: 'ticks:1', 1002: 'ticks:99', 1004: 'ticks:4' };
    expect(liveGateProcs(dir, { identitySync: (pid) => now[pid] ?? null })).toEqual([1001]);
  });
});
