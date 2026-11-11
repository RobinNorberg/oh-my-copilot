/**
 * B2: several private-layout engines in ONE checkout (factory.run.maxConcurrent),
 * in-process with fake lanes on the local forge (real git in temp dirs; no
 * gh, az or copilot). Lanes of both runs progress at the same time; every
 * fetch into and push out of the user's repository happens under the
 * repository import lock; both branches end pushed, nothing is left behind.
 * Also: slot exhaustion, the credit reservation in the engine, and a
 * parallel engine whose layout resolves to shared.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readMirrorRef } from '../../../forge/local/index.js';
import type { Exec } from '../../../ship/exec.js';
import { claimRepoKey } from '../claims.js';
import { runFactoryEngine, type FactoryEngineOptions } from '../engine.js';
import { creditReservationPath, PARALLEL_LAYOUT_GATE } from '../parallel.js';
import { acquireRunSlot, FactoryBusyError, factoryImportLockPath, factorySlotPath, heldSlots, readFactoryState, type OwnerDeps } from '../state.js';
import { commitFile, FakeLanes, gitIn, review, type LaneScript } from './fake-lanes.js';
import { LOCAL_ISSUE, localOpts, localWorld, type LocalWorld } from './engine-local-harness.js';

const T = 900_000;
const SECOND = 8;
let w: LocalWorld;
afterEach(() => rmSync(w.dir, { recursive: true, force: true }));

/** The local world with a second backlog item, a lockfile (unchanged by the lanes: node_modules is linked) and your node_modules. */
function world(): { w: LocalWorld; user: unknown } {
  const world = localWorld();
  writeFileSync(join(world.root, '.copilot', 'backlog', `${SECOND}-add-bye.md`), '---\ntitle: Add bye()\nlabels: [factory]\n---\nAdd a bye function.\n\n## Acceptance\n- [ ] bye() returns bye\n');
  writeFileSync(join(world.root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  appendFileSync(join(world.root, '.gitignore'), 'node_modules/\n');
  gitIn(world.root, 'add', '.');
  gitIn(world.root, 'commit', '-q', '-m', 'second item, lockfile');
  mkdirSync(join(world.root, 'node_modules'), { recursive: true });
  writeFileSync(join(world.root, 'node_modules', 'marker.txt'), 'yours\n');
  return { w: world, user: { factory: { run: { layout: 'private', workDir: join(world.dir, 'fw'), maxConcurrent: 2 } } } };
}

const HOST = 'test-host';
/** Two engine processes of this test: each sees itself and the other alive (distinct fake pids). */
const ALIVE = new Set([1001, 1002]);
const ownerOf = (pid: number): OwnerDeps => ({ pid, hostname: HOST, isAlive: (p) => ALIVE.has(p) });

describe('parallel private-layout runs in one checkout (B2)', () => {
  it('two engines progress through their lanes at the same time; every fetch into and push out of your repository holds the import lock; both branches end pushed, no import ref, slot, lock or reservation is left', async () => {
    const env = world();
    w = env.w;
    const events: string[] = [];
    /** Every git fetch/push in your repository, with the import lock's holder at that moment. */
    const transports: Array<{ cmd: string; holder: string | null }> = [];
    const exec: Exec = (cmd, args, opts) => {
      const plain = args.filter((a, i) => !(a === '-c' || args[i - 1] === '-c'));
      const verb = plain.find((a) => a === 'fetch' || a === 'push');
      const inUserRepo = opts?.cwd === w.root || args.some((a) => a === `--git-dir=${join(w.root, '.git')}`) || (args.includes('--git-dir') && args[args.indexOf('--git-dir') + 1] === join(w.root, '.git'));
      if (cmd === 'git' && verb && inUserRepo) {
        const lock = factoryImportLockPath(w.root);
        transports.push({ cmd: `${verb} ${plain.slice(plain.indexOf(verb) + 1).join(' ')}`, holder: existsSync(lock) ? String((JSON.parse(readFileSync(lock, 'utf8')) as { run?: string }).run) : null });
      }
      return w.exec(cmd, args, opts);
    };
    const lanesFor = (tag: string, scripts: LaneScript[]) => {
      // Each lane reports `running` for a few polls, so the engines interleave at their awaits.
      const lanes = new FakeLanes(w.root, scripts, [4, 4]);
      const start = lanes.start.bind(lanes);
      lanes.start = async (input) => { events.push(`${tag}-start-${input.laneId}`); return start(input); };
      lanes.onRunningPoll = () => { events.push(`${tag}-poll`); };
      return lanes;
    };
    const opts = (issue: number, pid: number, lanes: FakeLanes): FactoryEngineOptions => localOpts(w, lanes, {
      issue, owner: ownerOf(pid), exec, runUserConfig: env.user, secretScanUserConfig: null,
      parallel: { maxConcurrent: 2 }, creditLimit: 1_000,
    });
    const a = lanesFor('A', [commitFile('src/greet.js', 'export const greet = () => "hi";\n'), review('approve')]);
    const b = lanesFor('B', [commitFile('src/bye.js', 'export const bye = () => "bye";\n'), review('approve')]);
    const [ra, rb] = await Promise.all([runFactoryEngine(opts(LOCAL_ISSUE, 1001, a)), runFactoryEngine(opts(SECOND, 1002, b))]);

    expect(ra.gate?.name, ra.message).toBe('merge');
    expect(rb.gate?.name, rb.message).toBe('merge');
    // Both ran their lanes at the same time: B's lane started while A's was still polled as running, and the other way round.
    const firstA = events.findIndex((e) => e.startsWith('A-start'));
    const firstB = events.findIndex((e) => e.startsWith('B-start'));
    const lastPollA = events.lastIndexOf('A-poll');
    const lastPollB = events.lastIndexOf('B-poll');
    expect(Math.max(firstA, firstB)).toBeLessThan(Math.min(lastPollA, lastPollB));
    // Every fetch into and push out of your repository held the import lock (the run's own label, or the CLI's).
    expect(transports.length).toBeGreaterThan(0);
    for (const t of transports) expect(t.holder, t.cmd).toMatch(/^(import|snapshot):/);
    expect(transports.filter((t) => t.cmd.startsWith('push')).some((t) => t.holder === 'import:issue-7')).toBe(true);
    expect(transports.filter((t) => t.cmd.startsWith('push')).some((t) => t.holder === `import:issue-${SECOND}`)).toBe(true);
    // Both branches pushed at the runs' heads; no import ref left in your repository.
    const sa = readFactoryState(w.root, LOCAL_ISSUE)!;
    const sb = readFactoryState(w.root, SECOND)!;
    expect(sa.layout).toBe(2);
    expect(sb.layout).toBe(2);
    expect(sa.privateDir).not.toBe(sb.privateDir);
    expect(readMirrorRef(w.config.repo.url, `factory/issue-${LOCAL_ISSUE}`)).toBe(sa.head);
    expect(readMirrorRef(w.config.repo.url, `factory/issue-${SECOND}`)).toBe(sb.head);
    expect(gitIn(w.root, 'for-each-ref', 'refs/omg-import')).toBe('');
    // Nothing held is left: no slot, no import lock, no run.lock, no credit reservation.
    expect(heldSlots(w.root, ownerOf(1003))).toEqual([]);
    expect(existsSync(factoryImportLockPath(w.root))).toBe(false);
    expect(existsSync(join(sa.privateDir!, 'run.lock'))).toBe(false);
    expect(existsSync(join(sb.privateDir!, 'run.lock'))).toBe(false);
    expect(existsSync(creditReservationPath(w.ledgerDir, claimRepoKey(sa.repoUrl, w.root).slice(0, 8)))).toBe(false);
    expect(existsSync(join(w.ledgerDir, 'credits')) ? readdirSync(join(w.ledgerDir, 'credits')).filter((n) => n.endsWith('.json')) : []).toEqual([]);
  }, T);

  it('with every slot held by a live engine a start is busy (exit 6) naming the holders, before anything is written; a dead holder is taken over', async () => {
    const env = world();
    w = env.w;
    const other = acquireRunSlot(w.root, 99, 1, () => '2026-11-11T00:00:00.000Z', ownerOf(1002));
    const o = localOpts(w, new FakeLanes(w.root, []), { owner: ownerOf(1001), runUserConfig: env.user, secretScanUserConfig: null, parallel: { maxConcurrent: 1 } });
    await expect(runFactoryEngine(o)).rejects.toThrow(/^1 runs active \(factory\.run\.maxConcurrent 1\): slot 0: 99, pid 1002 /);
    await expect(runFactoryEngine(o)).rejects.toBeInstanceOf(FactoryBusyError);
    expect(readFactoryState(w.root, LOCAL_ISSUE)).toBeNull();
    void other;
    // The holder dies: the next start takes its slot over (and stops at the first lane, which has no script here).
    ALIVE.delete(1002);
    try {
      const out = await runFactoryEngine(o);
      expect(out.message).not.toMatch(/runs active/);
      expect(readFactoryState(w.root, LOCAL_ISSUE)?.history.length).toBeGreaterThan(0);
    } finally {
      ALIVE.add(1002);
    }
    expect(heldSlots(w.root, ownerOf(1003))).toEqual([]);
    expect(existsSync(factorySlotPath(w.root, 0))).toBe(false);
  }, T);
});

describe('credits in flight and the layout check (B2)', () => {
  it('a lane whose cap would pass factory.run.maxInFlightCredits next to a live reservation parks at budget, never started; a dead holder\'s reservation is dropped and the lane runs', async () => {
    w = localWorld();
    const lanes = new FakeLanes(w.root, [commitFile('src/greet.js'), review('approve')]);
    const o = localOpts(w, lanes, { owner: ownerOf(1001), secretScanUserConfig: null, creditWait: { maxMs: 0 } });
    // factory.run.maxInFlightCredits = one lane cap (the engine-mode default for maxConcurrent 1 is no reservation at all).
    o.creditLimit = o.limits.laneMaxCredits;
    // Another engine (pid 1002, alive) has a lane in flight on this repository (the local forge's run repository is its mirror).
    const path = creditReservationPath(w.ledgerDir, claimRepoKey(w.config.repo.url, w.root).slice(0, 8));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, reservations: [{ pid: 1002, hostname: HOST, startedAt: 'x', run: '8', id: 'issue-8-implement-1', cap: 1 }] }));
    const first = await runFactoryEngine(o);
    expect(first.gate?.name, first.message).toBe('budget');
    expect(first.gate?.reason).toMatch(/1 AI credits are reserved by lanes in flight \(issue-8-implement-1 1\); this lane's cap of \d+ would pass factory\.run\.maxInFlightCredits \d+/);
    expect(lanes.started.length).toBe(0);
    // That engine died: its reservation goes, the lane runs, and its own reservation is settled after it.
    ALIVE.delete(1002);
    try {
      const second = await runFactoryEngine(o);
      expect(lanes.started.length).toBeGreaterThan(0);
      expect(second.message).not.toMatch(/reserved by lanes in flight/);
    } finally {
      ALIVE.add(1002);
    }
    expect(existsSync(path)).toBe(false);
  }, T);

  it('a parallel engine whose layout resolves to shared parks before any lane, naming factory.run.layout "private"', async () => {
    w = localWorld();
    const lanes = new FakeLanes(w.root, []);
    const out = await runFactoryEngine(localOpts(w, lanes, { owner: ownerOf(1001), runUserConfig: null, secretScanUserConfig: null, parallel: { maxConcurrent: 2 } }));
    expect(out.gate?.name, out.message).toBe(PARALLEL_LAYOUT_GATE);
    expect(out.gate?.reason).toMatch(/factory\.run\.layout resolved to "shared" .* parallel runs need factory\.run\.layout: "private"\. No lane has started/);
    expect(lanes.started.length).toBe(0);
    expect(heldSlots(w.root, ownerOf(1003))).toEqual([]);
  }, T);
});
