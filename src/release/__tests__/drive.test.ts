import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { hostname, tmpdir } from 'os';
import { join } from 'path';
import { isProcessAlive } from '../../platform/process-utils.js';
import {
  acquireDriveLock,
  awaitDriverLock,
  defaultDriveProcess,
  detachDriver,
  driveLockPath,
  readDriveLock,
  releaseDriveLock,
  spawnDetachedDriver,
  stopDriver,
  throttleHeartbeats,
  withDriveLock,
  type DriveLock,
  type DriveProcess,
  type DriverLiveness,
} from '../drive.js';
import type { ReleaseProgressInput } from '../progress.js';

describe('release drive helpers', () => {
  let dir: string;
  let lockPath: string;
  let liveness: DriverLiveness;
  let killed: number[];
  let logs: string[];

  const proc: DriveProcess = {
    identity: async () => 'ticks:1',
    liveness: async () => liveness,
    kill: async (pid) => { killed.push(pid); return true; },
  };
  const holder = (pid = 424242): DriveLock => ({ pid, startedAt: '2026-10-28T00:00:00.000Z', argv: ['release', '5.12.2', '--drive'], host: hostname(), identity: 'ticks:9' });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omg-drive-'));
    mkdirSync(join(dir, 'release'));
    lockPath = driveLockPath(join(dir, 'release'), '5.12.2');
    liveness = 'live';
    killed = [];
    logs = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('single-driver lock', () => {
    it('is created exclusively with pid, start time, argv, host and identity', async () => {
      const r = await acquireDriveLock(lockPath, ['release', '5.12.2', '--drive'], proc, (l) => logs.push(l), () => Date.parse('2026-10-28T01:00:00Z'));
      expect(r.ok).toBe(true);
      expect(readDriveLock(lockPath)).toEqual({ pid: process.pid, startedAt: '2026-10-28T01:00:00.000Z', argv: ['release', '5.12.2', '--drive'], host: hostname(), identity: 'ticks:1' });
    });

    it('refuses while the holder is alive or cannot be probed, and leaves its lock alone', async () => {
      for (const state of ['live', 'unknown'] as const) {
        liveness = state;
        writeFileSync(lockPath, JSON.stringify(holder()));
        const r = await acquireDriveLock(lockPath, [], proc, (l) => logs.push(l));
        expect(r).toMatchObject({ ok: false, holder: { pid: 424242 }, liveness: state });
        expect(readDriveLock(lockPath)?.pid).toBe(424242);
      }
    });

    it('takes over a dead or pid-reused holder, and an unreadable lock, after logging it', async () => {
      for (const state of ['dead', 'mismatch'] as const) {
        liveness = state;
        writeFileSync(lockPath, JSON.stringify(holder()));
        expect((await acquireDriveLock(lockPath, [], proc, (l) => logs.push(l))).ok).toBe(true);
        expect(readDriveLock(lockPath)?.pid).toBe(process.pid);
        rmSync(lockPath);
      }
      writeFileSync(lockPath, '{ not json');
      expect((await acquireDriveLock(lockPath, [], proc, (l) => logs.push(l))).ok).toBe(true);
      expect(logs.join('\n')).toMatch(/stale drive lock .* of pid 424242 \(dead/);
      expect(logs.join('\n')).toMatch(/stale drive lock .* of pid 424242 \(mismatch/);
      expect(logs.join('\n')).toMatch(/unreadable drive lock/);
    });

    it('is released only by its holder, and withDriveLock releases it after the work (also on a throw)', async () => {
      writeFileSync(lockPath, JSON.stringify(holder()));
      releaseDriveLock(lockPath);
      expect(existsSync(lockPath)).toBe(true);
      rmSync(lockPath);

      expect(await withDriveLock(lockPath, [], proc, () => {}, async () => existsSync(lockPath))).toEqual({ held: true, value: true });
      expect(existsSync(lockPath)).toBe(false);
      await expect(withDriveLock(lockPath, [], proc, () => {}, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
      expect(existsSync(lockPath)).toBe(false);

      writeFileSync(lockPath, JSON.stringify(holder()));
      let ran = false;
      expect(await withDriveLock(lockPath, [], proc, () => {}, async () => { ran = true; })).toMatchObject({ held: false, holder: { pid: 424242 } });
      expect(ran).toBe(false);
    });
  });

  describe('stop', () => {
    it('kills a live holder and removes its lock', async () => {
      writeFileSync(lockPath, JSON.stringify(holder()));
      expect(await stopDriver(lockPath, proc)).toEqual({ stopped: true, pid: 424242 });
      expect(killed).toEqual([424242]);
      expect(existsSync(lockPath)).toBe(false);
    });

    it('never signals a dead or reused pid (removes the stale lock) nor an unprobeable one (keeps it)', async () => {
      for (const state of ['dead', 'mismatch'] as const) {
        liveness = state;
        writeFileSync(lockPath, JSON.stringify(holder()));
        expect(await stopDriver(lockPath, proc)).toMatchObject({ stopped: false, refused: false });
        expect(existsSync(lockPath)).toBe(false);
      }
      liveness = 'unknown';
      writeFileSync(lockPath, JSON.stringify(holder()));
      expect(await stopDriver(lockPath, proc)).toMatchObject({ stopped: false, refused: true });
      expect(existsSync(lockPath)).toBe(true);
      expect(killed).toEqual([]);
      rmSync(lockPath);
      expect(await stopDriver(lockPath, proc)).toMatchObject({ stopped: false, refused: false, reason: expect.stringMatching(/no driver is running/) });
    });
  });

  it('throttles heartbeats to one per window and passes every other event', () => {
    let t = 0;
    const seen: ReleaseProgressInput[] = [];
    const progress = throttleHeartbeats((e) => seen.push(e), () => t, 300_000);
    progress({ phase: 'pr', status: 'start' });
    progress({ phase: 'pr', status: 'heartbeat', note: 'a' });
    t = 60_000;
    progress({ phase: 'pr', status: 'heartbeat', note: 'b' });
    t = 300_000;
    progress({ phase: 'pr', status: 'heartbeat', note: 'c' });
    progress({ phase: 'pr', status: 'blocked', note: 'd' });
    expect(seen.map((e) => e.note ?? e.status)).toEqual(['start', 'a', 'c', 'd']);
  });

  it('detach spawns node detached with stdio to the log, windowsHide, and refuses while a driver runs', async () => {
    const spawned: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const spawnImpl = (command: string, args: string[], options: unknown) => {
      spawned.push({ command, args, options: options as Record<string, unknown> });
      writeFileSync(lockPath, JSON.stringify(holder(5150)));
      return { pid: 5150, unref: () => {} };
    };
    const logPath = join(dir, 'release', '5.12.2.drive.log');
    const o = { lockPath, logPath, entry: '/x/cli.cjs', argv: ['release', '5.12.2', '--drive'], cwd: dir, proc, sleep: async () => {}, spawnImpl, statusCommand: 'omg release 5.12.2 --status' };
    expect(await detachDriver(o)).toEqual({ ok: true, pid: 5150, locked: true });
    expect(spawned[0]).toMatchObject({ command: process.execPath, args: ['/x/cli.cjs', 'release', '5.12.2', '--drive'], options: { cwd: dir, detached: true, windowsHide: true } });
    expect((spawned[0].options.stdio as unknown[])[0]).toBe('ignore');
    expect(existsSync(logPath)).toBe(true);

    expect(await detachDriver(o)).toMatchObject({ ok: false, reason: expect.stringMatching(/a driver already runs \(pid 5150/) });
    expect(spawned).toHaveLength(1);
  });

  it('real detached child: writes its lock and log, keeps running, and --stop ends it (Windows: taskkill /F /T)', async () => {
    const script = join(dir, 'fake-driver.mjs');
    writeFileSync(script, [
      "import { writeFileSync } from 'fs';",
      "import { hostname } from 'os';",
      'const lock = process.argv[2];',
      "writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), argv: [], host: hostname(), identity: null }));",
      "console.log('driver up');",
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const logPath = join(dir, 'release', '5.12.2.drive.log');
    const pid = spawnDetachedDriver(script, [lockPath], logPath, dir);
    expect(pid).toBeGreaterThan(0);
    try {
      expect(await awaitDriverLock(lockPath, pid!, (ms) => new Promise((r) => setTimeout(r, ms)), 15_000, 100)).toBe(true);
      expect(isProcessAlive(pid!)).toBe(true);
      for (let i = 0; i < 50 && !readFileSync(logPath, 'utf8').includes('driver up'); i++) await new Promise((r) => setTimeout(r, 100));
      expect(readFileSync(logPath, 'utf8')).toContain('driver up');
      expect(await defaultDriveProcess.liveness(readDriveLock(lockPath)!)).toBe('live');
      expect(await stopDriver(lockPath, defaultDriveProcess)).toEqual({ stopped: true, pid });
      for (let i = 0; i < 50 && isProcessAlive(pid!); i++) await new Promise((r) => setTimeout(r, 100));
      expect(isProcessAlive(pid!)).toBe(false);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      if (isProcessAlive(pid!)) process.kill(pid!);
    }
  }, 30_000);
});
