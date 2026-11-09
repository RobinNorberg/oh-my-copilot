import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireFactoryClaim, claimRepoKey, claimRoot, factoryClaimHolder, factoryClaimPath, factoryClaimRepo, listFactoryClaims, removeFactoryClaim, settleFactoryClaim, SHARED_STATE_WARNING,
  trustedFactoryClaimRepo, type HeldClaim,
} from '../claims.js';
import { EXIT_BUSY as ENGINE_EXIT_BUSY } from '../engine.js';
import { FactorySafetyError } from '../exec.js';
import { EngineLedger, emptyHooksDir } from '../ledger.js';
import {
  acquireFactoryOwner, acquireFactoryRepoOwner, computeFactoryIntegrity, createFactoryState, describeOwner, EXIT_BUSY, FactoryBusyError, FactoryStateError, factoryOwnerPath, factoryRepoOwnerPath,
  factoryStateDir, factoryStatePath, overwriteFactoryState, ownerHolding, refuseWhileEngineRuns, type FactoryPhase, type FactoryRunKey, type OwnerDeps,
} from '../state.js';
import { lockPathFor } from '../../../lib/file-lock.js';
import type { Exec } from '../../../ship/exec.js';

const NOW = '2026-11-09T04:00:00.000Z';
const URL = 'https://github.com/o/r.git';
const live = (pid: number, host = 'h'): OwnerDeps => ({ pid, hostname: host, isAlive: () => true });
const dead = (pid: number, host = 'h'): OwnerDeps => ({ pid, hostname: host, isAlive: () => false });

let dir: string;
let ledger: string;
let cloneA: string;
let cloneB: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omg-factory-claims-'));
  ledger = join(dir, 'ledger');
  cloneA = join(dir, 'a');
  cloneB = join(dir, 'b');
  // Each clone is its own git repository: its factory state lives in it (getOmcRoot), never in a shared or home .omg.
  for (const clone of [cloneA, cloneB]) {
    mkdirSync(clone);
    execFileSync('git', ['init', '--quiet', clone], { stdio: 'ignore' });
    expect(factoryStatePath(clone, 1).startsWith(clone)).toBe(true);
  }
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * The run state of `key` in `root` at `phase` as its engine writes it: sealed, and recorded in that
 * checkout's engine ledger entry (the claim check trusts nothing else); or raw bytes nobody recorded.
 */
function runState(root: string, key: FactoryRunKey, phase: FactoryPhase | { raw: string }): void {
  const path = factoryStatePath(root, key);
  mkdirSync(dirname(path), { recursive: true });
  if (typeof phase !== 'string') {
    writeFileSync(path, phase.raw);
    return;
  }
  const { content } = overwriteFactoryState(root, key, { ...createFactoryState({ issue: key as number, repoUrl: URL, base: 'dev' }, NOW), phase });
  EngineLedger.open(ledger, root, key).record(path, content);
}

const busyOf = (fn: () => unknown): FactoryBusyError => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(FactoryBusyError);
    return error as FactoryBusyError;
  }
  throw new Error('expected a FactoryBusyError');
};

describe('cross-clone run claims', () => {
  it('busy is exit 6, the same constant from state.ts and engine.ts', () => {
    expect(EXIT_BUSY).toBe(6);
    expect(ENGINE_EXIT_BUSY).toBe(EXIT_BUSY);
  });

  it('every spelling of one GitHub repository shares the claim directory, github.com aliases included; other repositories do not', () => {
    const key = claimRepoKey(URL, cloneA);
    for (const url of ['https://github.com/O/R', 'git@github.com:o/r.git', 'ssh://git@ssh.github.com:443/o/r.git', 'https://www.github.com/o/r']) expect(claimRepoKey(url, cloneB), url).toBe(key);
    expect(claimRepoKey('https://github.com/o/other', cloneA)).not.toBe(key);
    expect(claimRepoKey('https://ghe.example.com/o/r', cloneA)).not.toBe(key);
    expect(factoryClaimPath(ledger, URL, cloneA, 7)).toBe(factoryClaimPath(ledger, URL, cloneB, 7));
    expect(factoryClaimPath(ledger, URL, cloneA, 7)).not.toBe(factoryClaimPath(ledger, URL, cloneA, 8));
  });

  it('a local origin path is one key however it is spelled: relative to the checkout, "..", file://, a link; case folds only on win32 and darwin', () => {
    const repo = join(dir, 'src-repo');
    mkdirSync(repo);
    const key = claimRepoKey(repo, cloneA, 'linux');
    expect(claimRepoKey('../src-repo', cloneA, 'linux')).toBe(key);
    expect(claimRepoKey(join(dir, 'a', '..', 'src-repo'), cloneB, 'linux')).toBe(key);
    expect(claimRepoKey(`file://${repo}`, cloneB, 'linux')).toBe(key);
    expect(claimRepoKey(`${repo}.git`, cloneB, 'linux')).not.toBe(claimRepoKey(join(dir, 'other'), cloneB, 'linux'));
    const link = join(dir, 'link');
    symlinkSync(repo, link, 'junction');
    expect(claimRepoKey(link, cloneB, 'linux')).toBe(key);
    // Case: two directories on a case-sensitive filesystem, one on a case-folding one.
    expect(claimRepoKey('/X/Repo', cloneA, 'linux')).not.toBe(claimRepoKey('/x/repo', cloneA, 'linux'));
    expect(claimRepoKey('/X/Repo', cloneA, 'darwin')).toBe(claimRepoKey('/x/repo', cloneA, 'darwin'));
  });

  it('the claim repository is the origin URL, read-only; no origin, a failing or throwing exec: none', () => {
    const calls: string[][] = [];
    const exec = (out: { status: number; stdout: string }): Exec => (cmd, args) => { calls.push([cmd, ...args]); return { ...out, stderr: '' }; };
    expect(factoryClaimRepo(exec({ status: 0, stdout: `${URL}\n` }), cloneA)).toBe(URL);
    expect(calls).toEqual([['git', 'remote', 'get-url', 'origin']]);
    expect(factoryClaimRepo(exec({ status: 2, stdout: '' }), cloneA)).toBeNull();
    expect(factoryClaimRepo(() => { throw new Error('unscripted'); }, cloneA)).toBeNull();
  });

  it('the CLI and the engine read the claim origin through one hardened helper: no hooks, and a refused hardening is thrown, never "no origin"', () => {
    const calls: string[][] = [];
    const exec: Exec = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: `${URL}\n`, stderr: '' }; };
    expect(trustedFactoryClaimRepo(exec, cloneA, ledger)).toBe(URL);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`core.hooksPath=${emptyHooksDir(ledger)}`);
    expect(calls[0].slice(-3)).toEqual(['remote', 'get-url', 'origin']);
    writeFileSync(join(emptyHooksDir(ledger), 'post-checkout'), 'planted');
    expect(() => trustedFactoryClaimRepo(exec, cloneA, ledger)).toThrow(FactorySafetyError);
  });

  it('a live claim from another clone refuses with a FactoryBusyError naming that clone and the claim file; release frees it', () => {
    const a = acquireFactoryClaim(ledger, URL, cloneA, 7, NOW, live(1));
    const caught = busyOf(() => acquireFactoryClaim(ledger, URL, cloneB, 7, NOW, live(2)));
    expect(caught).toBeInstanceOf(FactoryStateError);
    expect(caught.message).toBe(`factory run #7 is claimed by a live engine (7, pid 1 on h since ${NOW} in ${cloneA}); one engine runs an item at a time across clones (claim file ${factoryClaimPath(ledger, URL, cloneA, 7)})`);
    // Another item and another repository are independent.
    acquireFactoryClaim(ledger, URL, cloneB, 8, NOW, live(2)).release();
    acquireFactoryClaim(ledger, 'https://github.com/o/other', cloneB, 7, NOW, live(2)).release();
    // Only the owner's release removes the claim.
    expect(factoryClaimHolder(ledger, URL, cloneB, 7, live(2))).toMatchObject({ state: 'live', claim: { pid: 1, run: '7', root: cloneA } });
    a.release();
    expect(factoryClaimHolder(ledger, URL, cloneB, 7, live(2))).toBeNull();
    acquireFactoryClaim(ledger, URL, cloneB, 7, NOW, live(2)).release();
  });

  it('a parked claim (the run stopped before a terminal phase) holds while that checkout\'s run is not terminal; its own checkout takes it back', () => {
    runState(cloneA, 7, 'plan');
    acquireFactoryClaim(ledger, URL, cloneA, 7, NOW, live(1)).park('2026-11-09T05:00:00.000Z');
    expect(JSON.parse(readFileSync(factoryClaimPath(ledger, URL, cloneA, 7), 'utf8'))).toEqual({ hostname: 'h', startedAt: NOW, run: '7', root: cloneA, parkedAt: '2026-11-09T05:00:00.000Z' });
    const caught = busyOf(() => acquireFactoryClaim(ledger, URL, cloneB, 7, NOW, live(2)));
    expect(caught.message).toMatch(/^factory run #7 is claimed by a run parked at plan \(7, no live process on h since .* in .*\).*; if no engine will resume it, omg factory run release 7 removes the claim$/);
    expect(factoryClaimHolder(ledger, URL, cloneB, 7, live(2))).toMatchObject({ state: 'parked' });
    // The claiming checkout resumes its own run.
    const back = acquireFactoryClaim(ledger, URL, cloneA, 7, NOW, live(3));
    expect(back.tookOver).toMatchObject({ root: cloneA, parkedAt: '2026-11-09T05:00:00.000Z' });
    back.park(NOW);
    // Terminal there: free.
    runState(cloneA, 7, 'merged');
    expect(factoryClaimHolder(ledger, URL, cloneB, 7, live(2))).toBeNull();
    acquireFactoryClaim(ledger, URL, cloneB, 7, NOW, live(2)).release();
  });

  it('a crashed engine\'s claim (dead pid) holds the same way; without run state there it is free', () => {
    acquireFactoryClaim(ledger, URL, cloneA, 7, NOW, live(1));
    expect(acquireFactoryClaim(ledger, URL, cloneB, 7, NOW, dead(2)).tookOver).toMatchObject({ pid: 1, root: cloneA });
    acquireFactoryClaim(ledger, URL, cloneA, 8, NOW, live(1));
    runState(cloneA, 8, 'implement');
    expect(busyOf(() => acquireFactoryClaim(ledger, URL, cloneB, 8, NOW, dead(2))).message).toMatch(/claimed by a run parked at implement \(8, pid 1 on h/);
    // Another host's claim always holds: its pid cannot be checked here.
    expect(() => acquireFactoryClaim(ledger, URL, cloneB, 8, NOW, dead(3, 'other-host'))).toThrow(FactoryBusyError);
  });

  it('a claim whose checkout, run state or own file cannot be read is held and reported, never taken over', () => {
    const write = (key: number, v: unknown) => {
      const path = factoryClaimPath(ledger, URL, cloneA, key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, typeof v === 'string' ? v : JSON.stringify(v));
      return path;
    };
    const parked = (root: string) => ({ hostname: 'h', startedAt: NOW, run: '7', root, parkedAt: NOW });
    write(7, parked(join(dir, 'gone')));
    expect(factoryClaimHolder(ledger, URL, cloneB, 7, live(2))).toMatchObject({ state: 'unreadable', why: expect.stringMatching(/its checkout .*gone is missing/) });
    write(7, parked('relative/path'));
    expect(factoryClaimHolder(ledger, URL, cloneB, 7, live(2))).toMatchObject({ state: 'unreadable', why: expect.stringMatching(/names no usable checkout/) });
    runState(cloneA, 7, { raw: '{oops' });
    write(7, parked(cloneA));
    expect(factoryClaimHolder(ledger, URL, cloneB, 7, live(2))).toMatchObject({ state: 'unreadable', why: expect.stringMatching(/run state in .* is unreadable \(it is not the one its engine wrote\)/) });
    const path = write(9, '{not json');
    expect(busyOf(() => acquireFactoryClaim(ledger, URL, cloneB, 9, NOW, live(2))).message).toContain(`the claim file ${path} is unreadable`);
    expect(readFileSync(path, 'utf8')).toBe('{not json');
    expect(listFactoryClaims(ledger, URL, cloneB, live(2)).map((c) => [c.key, c.state])).toEqual([[7, 'unreadable'], [9, 'unreadable']]);
  });

  it('another clone\'s run state counts only as its engine sealed it: a forged "merged" phase, an unsealed or a deleted state keeps the claim held', () => {
    runState(cloneA, 7, 'implement');
    acquireFactoryClaim(ledger, URL, cloneA, 7, NOW, live(1)).park(NOW);
    expect(factoryClaimHolder(ledger, URL, cloneB, 7, live(2))).toMatchObject({ state: 'parked' });
    const path = factoryStatePath(cloneA, 7);
    const sealed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    // A lane in clone A rewrites its state: a bare phase, then a phase with a correct integrity seal (the seal is
    // a plain hash anyone can compute); neither is the engine's last write in its ledger.
    writeFileSync(path, JSON.stringify({ ...sealed, phase: 'merged' }));
    const forged = busyOf(() => acquireFactoryClaim(ledger, URL, cloneB, 7, NOW, live(2)));
    expect(forged.message).toMatch(/run state in .* is unreadable \(it is not the one its engine wrote\)/);
    const resealed = { ...sealed, phase: 'merged', integrity: undefined };
    writeFileSync(path, JSON.stringify({ ...resealed, integrity: computeFactoryIntegrity(resealed as never) }));
    expect(factoryClaimHolder(ledger, URL, cloneB, 7, live(2))).toMatchObject({ state: 'unreadable' });
    rmSync(path);
    expect(factoryClaimHolder(ledger, URL, cloneB, 7, live(2))).toMatchObject({ state: 'unreadable', why: expect.stringMatching(/it is gone, though its engine wrote it/) });
    // Its engine's own terminal write frees it.
    runState(cloneA, 7, 'merged');
    expect(factoryClaimHolder(ledger, URL, cloneB, 7, live(2))).toBeNull();
  });

  it('a claim root must be a local absolute path: UNC, device, relative and control-character roots are refused before any stat, and never printed', () => {
    for (const bad of ['\\\\server\\share\\repo', '//server/share/repo', '\\\\?\\C:\\repo', '\\\\.\\C:\\repo', 'relative/repo', `${cloneA}\u001b[2J`, `${cloneA}\u202e`, '']) {
      expect(claimRoot(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(claimRoot(cloneA)).toBe(cloneA);
    const path = factoryClaimPath(ledger, URL, cloneA, 7);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ hostname: 'h', startedAt: NOW, run: '7', root: '\\\\evil-host\\share\u001b]0;x\u0007', parkedAt: NOW }));
    const hold = factoryClaimHolder(ledger, URL, cloneB, 7, live(2));
    expect(hold).toMatchObject({ state: 'unreadable', why: expect.stringMatching(/names no usable checkout/) });
    expect(busyOf(() => acquireFactoryClaim(ledger, URL, cloneB, 7, NOW, live(2))).message).not.toMatch(/\u001b|\u0007|evil-host/);
  });

  it('the engine\'s end: a terminal or never-started run releases its claim; any other phase, and a state read that throws, parks it', () => {
    const calls: string[] = [];
    const claim: HeldClaim = { release: () => calls.push('release'), park: (at) => calls.push(`park ${at}`) };
    expect(settleFactoryClaim(claim, () => 'merged', NOW)).toBe('released');
    expect(settleFactoryClaim(claim, () => null, NOW)).toBe('released');
    expect(settleFactoryClaim(claim, () => 'review', NOW)).toBe('parked');
    expect(settleFactoryClaim(claim, () => { throw new FactoryStateError('malformed'); }, NOW)).toBe('parked');
    expect(calls).toEqual(['release', 'release', `park ${NOW}`, `park ${NOW}`]);
  });

  it('a contender that cannot take an owner or claim file\'s lock in time is busy (exit 6), not an error; this process\'s identity is read before the lock', () => {
    const claim = factoryClaimPath(ledger, URL, cloneA, 7);
    mkdirSync(dirname(claim), { recursive: true });
    // Another process holds the file lock (a fresh lock file of a live pid is not stale).
    writeFileSync(lockPathFor(claim), JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
    expect(busyOf(() => acquireFactoryClaim(ledger, URL, cloneB, 7, NOW, live(2))).message).toBe(`another omg factory process holds the lock file ${lockPathFor(claim)}; retry in a moment`);
    rmSync(lockPathFor(claim));
    const lock = factoryRepoOwnerPath(cloneA);
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lockPathFor(lock), JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
    expect(() => acquireFactoryRepoOwner(cloneA, 7, NOW, live(2))).toThrow(FactoryBusyError);
    rmSync(lockPathFor(lock));
    // The own identity: read while no file lock is held.
    const seen: boolean[] = [];
    const deps: OwnerDeps = { ...live(2), identityOf: (pid) => { if (pid === 2) seen.push(existsSync(lockPathFor(lock)) || existsSync(lockPathFor(claim))); return 'ticks:2'; } };
    acquireFactoryRepoOwner(cloneA, 7, NOW, deps).release();
    acquireFactoryClaim(ledger, URL, cloneB, 7, NOW, deps).release();
    expect(seen).toEqual([false, false]);
  }, 30_000);

  it('a claim or engine lock from another folder that shares this checkout\'s state root warns (with OMC_STATE_DIR, clones need distinct folder names)', () => {
    const prior = process.env.OMC_STATE_DIR;
    process.env.OMC_STATE_DIR = join(dir, 'state-dir');
    try {
      const x = join(dir, 'x', 'repo');
      const y = join(dir, 'y', 'repo');
      for (const clone of [x, y]) {
        mkdirSync(clone, { recursive: true });
        execFileSync('git', ['init', '--quiet', clone], { stdio: 'ignore' });
        execFileSync('git', ['-C', clone, 'remote', 'add', 'origin', URL], { stdio: 'ignore' });
      }
      expect(factoryStateDir(x)).toBe(factoryStateDir(y));
      expect(factoryStateDir(x).startsWith(join(dir, 'state-dir'))).toBe(true);
      // A live engine in x: y's engine lock is the same file; the busy message warns.
      const held = acquireFactoryRepoOwner(x, 7, NOW, live(1));
      expect(busyOf(() => acquireFactoryRepoOwner(y, 8, NOW, live(2))).message).toMatch(/shares this checkout's state root .*parallel clones need distinct folder names/);
      held.release();
      // A parked claim of x: y sees it held, with the warning, and run status lists it as shared.
      runState(x, 7, 'plan');
      acquireFactoryClaim(ledger, URL, x, 7, NOW, live(1)).park(NOW);
      expect(busyOf(() => acquireFactoryClaim(ledger, URL, y, 7, NOW, live(2))).message).toContain(SHARED_STATE_WARNING);
      expect(listFactoryClaims(ledger, URL, y, live(2))).toMatchObject([{ key: 7, state: 'parked', sharedState: true }]);
      // Distinct folder names: no warning.
      expect(factoryClaimHolder(ledger, URL, cloneB, 7, live(2))?.sharedState).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.OMC_STATE_DIR;
      else process.env.OMC_STATE_DIR = prior;
    }
  });

  it('removeFactoryClaim: a live holder is busy; a parked claim goes; onlyRoot keeps another checkout\'s claim', () => {
    const a = acquireFactoryClaim(ledger, URL, cloneA, 7, NOW, live(1));
    expect(() => removeFactoryClaim(ledger, URL, cloneB, 7, { deps: live(2) })).toThrow(FactoryBusyError);
    runState(cloneA, 7, 'review');
    a.park(NOW);
    expect(removeFactoryClaim(ledger, URL, cloneB, 7, { onlyRoot: true, deps: live(2) })).toBeNull();
    expect(existsSync(factoryClaimPath(ledger, URL, cloneA, 7))).toBe(true);
    expect(removeFactoryClaim(ledger, URL, cloneA, 7, { onlyRoot: true, deps: live(2) })).toBe(factoryClaimPath(ledger, URL, cloneA, 7));
    acquireFactoryClaim(ledger, URL, cloneA, 7, NOW, live(1)).park(NOW);
    expect(removeFactoryClaim(ledger, URL, cloneB, 7, { deps: live(2) })).toBe(factoryClaimPath(ledger, URL, cloneB, 7));
    expect(removeFactoryClaim(ledger, URL, cloneB, 7, { deps: live(2) })).toBeNull();
  });

  it('the checkout and item owner files refuse with a FactoryBusyError too; the repo owner names separate clones', () => {
    acquireFactoryRepoOwner(cloneA, 7, NOW, live(1));
    expect(() => acquireFactoryRepoOwner(cloneA, 8, NOW, live(2))).toThrow(FactoryBusyError);
    expect(() => acquireFactoryRepoOwner(cloneA, 8, NOW, live(2))).toThrow(/one engine runs per checkout at a time, so start 8 after it ends \(parallel runs need separate clones\)/);
    expect(() => refuseWhileEngineRuns(cloneA, live(2))).toThrow(/another omg factory engine runs in this repository \(7, pid 1 on h/);
    expect(() => refuseWhileEngineRuns(cloneA, dead(2))).not.toThrow();
    acquireFactoryOwner(cloneA, 7, NOW, live(1));
    expect(() => acquireFactoryOwner(cloneA, 7, NOW, live(2))).toThrow(FactoryBusyError);
  });

  it('relabel rewrites the held engine lock\'s run (run --next after its pick); release removes only its own file', () => {
    const held = acquireFactoryRepoOwner(cloneA, 'next', NOW, live(1));
    expect(JSON.parse(readFileSync(factoryRepoOwnerPath(cloneA), 'utf8'))).toMatchObject({ pid: 1, run: 'next' });
    held.relabel('12');
    expect(JSON.parse(readFileSync(factoryRepoOwnerPath(cloneA), 'utf8'))).toMatchObject({ pid: 1, run: '12' });
    acquireFactoryRepoOwner(cloneA, 9, NOW, dead(2));
    held.relabel('13');
    held.release();
    expect(JSON.parse(readFileSync(factoryRepoOwnerPath(cloneA), 'utf8'))).toMatchObject({ pid: 2, run: '9' });
  });
});

describe('owner files: one rule for unreadable files, start identity, plain text', () => {
  const path = () => join(dir, 'x.owner');
  const write = (v: unknown) => { mkdirSync(dirname(path()), { recursive: true }); writeFileSync(path(), typeof v === 'string' ? v : JSON.stringify(v)); };

  it('ownerHolding: null without a file, for a dead pid on this host and for the caller itself', () => {
    expect(ownerHolding(path(), live(2))).toBeNull();
    write({ pid: 1, hostname: 'h', startedAt: NOW });
    expect(ownerHolding(path(), dead(2))).toBeNull();
    expect(ownerHolding(path(), live(1))).toBeNull();
  });

  it('ownerHolding: the owner for a live pid here or any pid on another host; unreadable for a malformed file', () => {
    write({ pid: 1, hostname: 'h', startedAt: NOW });
    expect(ownerHolding(path(), live(2))).toMatchObject({ pid: 1 });
    expect(ownerHolding(path(), dead(2, 'other'))).toMatchObject({ pid: 1 });
    write('{not json');
    expect(ownerHolding(path(), live(2))).toBe('unreadable');
    write({ pid: 'x', hostname: 'h' });
    expect(ownerHolding(path(), live(2))).toBe('unreadable');
  });

  it('an unreadable engine lock or item owner file is held: never taken over, never "not busy"', () => {
    const lock = factoryRepoOwnerPath(cloneA);
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, '{truncated');
    expect(busyOf(() => acquireFactoryRepoOwner(cloneA, 7, NOW, dead(2))).message).toBe(`the owner file ${lock} is unreadable, so it counts as held; check that no engine uses it, then remove it (omg factory run release)`);
    expect(readFileSync(lock, 'utf8')).toBe('{truncated');
    expect(() => refuseWhileEngineRuns(cloneA, dead(2))).toThrow(/is unreadable, so it counts as held/);
  });

  it('a live pid whose start identity changed (a reused pid) does not hold; an unknown identity still holds', () => {
    const withIdentity = (pid: number, ids: Record<number, string | null>): OwnerDeps => ({ ...live(pid), identityOf: (p) => ids[p] ?? null });
    const first = acquireFactoryRepoOwner(cloneA, 7, NOW, withIdentity(1, { 1: 'ticks:100' }));
    expect(JSON.parse(readFileSync(factoryRepoOwnerPath(cloneA), 'utf8'))).toMatchObject({ pid: 1, identity: 'ticks:100' });
    expect(ownerHolding(factoryRepoOwnerPath(cloneA), withIdentity(2, { 1: 'ticks:100' }))).toMatchObject({ pid: 1 });
    expect(ownerHolding(factoryRepoOwnerPath(cloneA), withIdentity(2, {}))).toMatchObject({ pid: 1 });
    expect(ownerHolding(factoryRepoOwnerPath(cloneA), withIdentity(2, { 1: 'ticks:999' }))).toBeNull();
    expect(acquireFactoryRepoOwner(cloneA, 8, NOW, withIdentity(2, { 1: 'ticks:999' })).tookOver).toMatchObject({ pid: 1 });
    first.release();
    // The same rule for claims.
    acquireFactoryClaim(ledger, URL, cloneA, 7, NOW, withIdentity(1, { 1: 'ticks:100' }));
    expect(factoryClaimHolder(ledger, URL, cloneB, 7, withIdentity(2, { 1: 'ticks:100' }))).toMatchObject({ state: 'live' });
    expect(factoryClaimHolder(ledger, URL, cloneB, 7, withIdentity(2, { 1: 'ticks:5' }))).toBeNull();
  });

  it('owner text is printed as plain text: no escape sequence or control character from the file', () => {
    expect(describeOwner({ pid: 1, hostname: 'h\u001b[2Jx', startedAt: 'now\nFAKE: ok', run: '7\u0007', root: `/r${String.fromCharCode(0x202e)}` })).toBe('7 , pid 1 on hx since now FAKE: ok in /r ');
    mkdirSync(dirname(factoryOwnerPath(cloneA, 1)), { recursive: true });
    writeFileSync(factoryOwnerPath(cloneA, 1), JSON.stringify({ pid: 1, hostname: 'h', startedAt: '\u001b]0;pwned\u0007' }));
    expect(busyOf(() => acquireFactoryOwner(cloneA, 1, NOW, live(2))).message).not.toMatch(/\u001b|\u0007/);
  });
});
