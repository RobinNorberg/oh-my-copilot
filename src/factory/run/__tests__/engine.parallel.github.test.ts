/**
 * Review-487 HIGH-1 / M-2 on the GitHub forge path: in a parallel private
 * run, a change of a remote-tracking ref in your repository is excused as
 * another run's transport only at the sha `git ls-remote` reads from the
 * remote under the import lock at compare time; a planted sha parks as
 * lane-tampered with the hold, an unreadable remote stops the run busy.
 * Fake lanes, a scripted gh, a local bare origin; no network, no credits.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { Exec } from '../../../ship/exec.js';
import { readTamperHold } from '../tamper-quarantine.js';
import { FactoryBusyError, factoryImportLockPath, FactoryTamperHoldError, ImportLockBusyError, readFactoryState, requestFactoryCancel, scanWait } from '../state.js';
import { commitFile, ENFORCED_SANDBOX, gitIn, ISSUE, type LaneScript } from './fake-lanes.js';
import { h, run, useEngineHarness } from './engine-harness.js';

const T = 600_000;
useEngineHarness();

const DETECT_ONLY = { ...ENFORCED_SANDBOX, mode: 'detect-only' } as typeof ENFORCED_SANDBOX;
const privateUser = () => ({ factory: { run: { layout: 'private', workDir: join(h.dir, 'fw') } } });
const parallel = { parallel: { maxConcurrent: 2 } };
/** A detect-only lane (it ran as you) that does `act` in your repository while it runs. */
const asYou = (act: () => void): LaneScript => (ctx) => {
  act();
  const out = commitFile('src/greet.ts', 'export const greet = () => "hi";\n')(ctx);
  return { ...(out ?? {}), sandbox: DETECT_ONLY };
};
/** A commit in your repository's object store that is on no remote (what a lane could plant). */
const planted = () => gitIn(h.root, 'commit-tree', '-p', 'HEAD', '-m', 'planted', `${gitIn(h.root, 'rev-parse', 'HEAD')}^{tree}`);

describe('parallel private runs on GitHub: other runs\' transports in your repository (review-487 HIGH-1)', () => {
  it('a lane that points refs/remotes/origin/<base> at a planted commit parks as lane-tampered with the quarantine, nothing pushed', async () => {
    const { done } = run([asYou(() => gitIn(h.root, 'update-ref', 'refs/remotes/origin/dev', planted()))], { runUserConfig: privateUser(), ...parallel });
    const out = await done;
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    expect(out.gate?.reason).toMatch(/your repository: ref refs\/remotes\/origin\/dev moved/);
    // As on dev for a ref-only change: the quarantine records it with the undo command; a ref runs nothing, so no hold.
    expect(out.gate?.reason).toMatch(/Tamper quarantine \(.*\): refs: refs\/remotes\/origin\/dev moved .*git update-ref refs\/remotes\/origin\/dev [0-9a-f]{40} [0-9a-f]{40}.*so no hold was set/);
    expect(readTamperHold(h.ledgerDir, h.root)).toBeNull();
    expect(readFactoryState(h.root, ISSUE)!.head).toBeUndefined();
  }, T);

  it('another run\'s fetch (the tracking ref at the sha the remote holds now) is excused: no park, no hold', async () => {
    // The base moved on the remote and a fetch (as another run's) brought refs/remotes/origin/dev to exactly that sha.
    const moved = () => {
      const next = planted();
      gitIn(h.root, 'push', '-q', 'origin', `${next}:refs/heads/dev`);
      expect(gitIn(h.root, 'rev-parse', 'refs/remotes/origin/dev')).toBe(next);
    };
    const { done } = run([asYou(moved)], { runUserConfig: privateUser(), ...parallel });
    const out = await done;
    expect(out.gate?.name, out.message).not.toBe('lane-tampered');
    expect(readTamperHold(h.ledgerDir, h.root)).toBeNull();
    expect(readFactoryState(h.root, ISSUE)!.lanes[0].status).toBe('completed');
  }, T);

  it('review-487 M-2: another run\'s factory branch is excused at the sha the remote holds (its push)', async () => {
    const pushedOther = () => gitIn(h.root, 'push', '-q', 'origin', `${planted()}:refs/heads/factory/issue-99`);
    const { done } = run([asYou(pushedOther)], { runUserConfig: privateUser(), ...parallel });
    expect((await done).gate?.name).not.toBe('lane-tampered');
    expect(readTamperHold(h.ledgerDir, h.root)).toBeNull();
  }, T);

  it('review-487 M-2: another run\'s factory branch at any other sha parks as lane-tampered, whatever its state file says', async () => {
    const plantOther = () => {
      const pushed = planted();
      gitIn(h.root, 'push', '-q', 'origin', `${pushed}:refs/heads/factory/issue-98`);
      gitIn(h.root, 'update-ref', 'refs/remotes/origin/factory/issue-98', gitIn(h.root, 'commit-tree', '-p', pushed, '-m', 'planted 2', `${pushed}^{tree}`));
    };
    const { done } = run([asYou(plantOther)], { runUserConfig: privateUser(), ...parallel });
    const out = await done;
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    expect(out.gate?.reason).toMatch(/your repository: ref refs\/remotes\/origin\/factory\/issue-98 was created/);
  }, T);

  it('review-487 M-1: another engine holding import.lock past the wait at the lane\'s compare stops the run busy naming it: no quarantine, no hold, the lane kept', async () => {
    let t = 0;
    const holdIt = () => {
      // Another engine (on another host, so it counts as live) holds the import lock; time runs past the 15 min wait.
      writeFileSync(factoryImportLockPath(h.root), `${JSON.stringify({ pid: 4321, hostname: 'other-host', startedAt: '2026-11-11T00:00:00.000Z', run: 'import:issue-99' })}\n`);
      vi.spyOn(scanWait, 'clock').mockImplementation(() => (t += 20 * 60_000));
    };
    const { done } = run([asYou(holdIt)], { runUserConfig: privateUser(), ...parallel });
    const error = await done.then(() => null, (e: unknown) => e);
    vi.restoreAllMocks();
    expect(error).toBeInstanceOf(ImportLockBusyError);
    expect(String((error as Error).message)).toMatch(/the repository import lock .* is held by .*import:issue-99.*waited \d+ s: rerun when it is done/);
    expect(readTamperHold(h.ledgerDir, h.root)).toBeNull();
    expect(existsSync(join(h.ledgerDir, 'quarantine'))).toBe(false);
    const s = readFactoryState(h.root, ISSUE)!;
    expect(s.gate).toBeUndefined();
    expect(s.lanes[0].status).toBe('running');
    expect(existsSync(s.lanes[0].worktree!)).toBe(true);
  }, T);

  it('a remote that cannot be read stops the run busy (no tamper park, no hold); the lane stays to be compared again by the rerun', async () => {
    let offline = false;
    const exec: Exec = (cmd, args, o) => (offline && cmd === 'git' && args.includes('ls-remote')
      ? { status: 128, stdout: '', stderr: 'fatal: unable to access the remote' }
      : h.exec(cmd, args, o));
    const goOffline = () => { gitIn(h.root, 'update-ref', 'refs/remotes/origin/dev', planted()); offline = true; };
    const { done } = run([asYou(goOffline)], { runUserConfig: privateUser(), exec, ...parallel });
    const error = await done.then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(FactoryBusyError);
    expect(String((error as Error).message)).toMatch(/the remote origin could not be read .*cannot be told from a change by a lane; nothing was judged: rerun omg factory run 7 to compare again/);
    expect(readTamperHold(h.ledgerDir, h.root)).toBeNull();
    const lane = readFactoryState(h.root, ISSUE)!.lanes[0];
    expect(lane.status).toBe('running');
    expect(lane.note).toMatch(/its tamper check did not run/);
  }, T);

  it('review-487b BLOCK-1: a planted http.proxy plus a moved refs/remotes/origin/<base> parks with the hold, no ls-remote or fetch runs on that config, and a rerun is refused by the hold (not busy)', async () => {
    const calls: string[] = [];
    let laneDone = false;
    const exec: Exec = (cmd, args, o) => {
      if (laneDone && cmd === 'git') calls.push(args.join(' '));
      return h.exec(cmd, args, o);
    };
    const plant = () => {
      gitIn(h.root, 'config', 'http.proxy', 'http://127.0.0.1:1');
      gitIn(h.root, 'update-ref', 'refs/remotes/origin/dev', planted());
      laneDone = true;
    };
    const { done } = run([asYou(plant)], { runUserConfig: privateUser(), exec, ...parallel });
    const out = await done;
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    expect(out.gate?.reason).toMatch(/your repository: ref refs\/remotes\/origin\/dev moved/);
    expect(out.gate?.reason).toMatch(/your repository: the common git config changed/);
    expect(readTamperHold(h.ledgerDir, h.root)).not.toBeNull();
    expect(calls.filter((c) => / ?(ls-remote|fetch) /.test(` ${c} `))).toEqual([]);
    const again = await run([], { runUserConfig: privateUser(), exec, ...parallel }).done.then(() => null, (e: unknown) => e);
    expect(again).toBeInstanceOf(FactoryTamperHoldError);
    expect(calls.filter((c) => / ?(ls-remote|fetch) /.test(` ${c} `))).toEqual([]);
  }, T);

  it('review-487b F-2: the base moved twice (the tracking ref at an older sha the remote published, the remote further on) is excused: no park, no hold', async () => {
    const movedTwice = () => {
      const older = planted();
      gitIn(h.root, 'push', '-q', 'origin', `${older}:refs/heads/dev`);
      const newer = gitIn(h.root, 'commit-tree', '-p', older, '-m', 'newer', `${older}^{tree}`);
      gitIn(h.root, 'push', '-q', 'origin', `${newer}:refs/heads/dev`);
      // Another run fetched `older`; the remote moved on to `newer` since.
      gitIn(h.root, 'update-ref', 'refs/remotes/origin/dev', older);
    };
    const { done } = run([asYou(movedTwice)], { runUserConfig: privateUser(), ...parallel });
    const out = await done;
    expect(out.gate?.name, out.message).not.toBe('lane-tampered');
    expect(readTamperHold(h.ledgerDir, h.root)).toBeNull();
    expect(readFactoryState(h.root, ISSUE)!.lanes[0].status).toBe('completed');
  }, T);

  it('review-487b F-2: a planted commit is no ancestor of the remote\'s head, so it parks even with the remote moved on', async () => {
    const plantAfterMove = () => {
      const next = planted();
      gitIn(h.root, 'push', '-q', 'origin', `${next}:refs/heads/dev`);
      gitIn(h.root, 'update-ref', 'refs/remotes/origin/dev', gitIn(h.root, 'commit-tree', '-p', next, '-m', 'planted on top', `${next}^{tree}`));
    };
    const { done } = run([asYou(plantAfterMove)], { runUserConfig: privateUser(), ...parallel });
    const out = await done;
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    expect(out.gate?.reason).toMatch(/your repository: ref refs\/remotes\/origin\/dev moved/);
  }, T);

  it('review-487b F-3: with a cancel requested, an unreadable remote leaves the ref unexcused: the run is not busy, no hold', async () => {
    let offline = false;
    const exec: Exec = (cmd, args, o) => (offline && cmd === 'git' && args.includes('ls-remote')
      ? { status: 128, stdout: '', stderr: 'fatal: unable to access the remote' }
      : h.exec(cmd, args, o));
    const goOffline = () => {
      gitIn(h.root, 'update-ref', 'refs/remotes/origin/dev', planted());
      offline = true;
      requestFactoryCancel(h.root, ISSUE, new Date().toISOString());
    };
    const { done } = run([asYou(goOffline)], { runUserConfig: privateUser(), exec, ...parallel });
    const out = await done;
    expect(out.message).not.toMatch(/could not be read/);
    expect(readTamperHold(h.ledgerDir, h.root)).toBeNull();
    const s = readFactoryState(h.root, ISSUE)!;
    expect(s.lanes[0].status).not.toBe('running');
    expect(s.phase === 'cancelled' || s.gate?.name === 'lane-tampered', `${s.phase} ${s.gate?.name}`).toBe(true);
  }, T);
});
