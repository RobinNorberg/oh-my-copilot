import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { releaseCommand } from '../release.js';
import type { ReleaseExec } from '../../../release/engine.js';
import type { DriveProcess, DriverLiveness } from '../../../release/drive.js';
import type { ReleaseProgressInput } from '../../../release/progress.js';

describe('omg release CLI', () => {
  let root: string;
  let calls: string[];
  let out: string[];
  let err: string[];

  const exec: ReleaseExec = (cmd, args) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    return { status: 0, stdout: '', stderr: '' };
  };

  async function run(...argv: string[]): Promise<number> {
    process.exitCode = undefined;
    await releaseCommand({ exec, root, stateRoot: join(root, '.omg'), progress: () => {} }).parseAsync(argv, { from: 'user' });
    const code = Number(process.exitCode ?? 0);
    process.exitCode = undefined;
    return code;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omg-release-cli-'));
    calls = [];
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('--dry-run prints the numbered plan of all eleven phases and runs nothing', async () => {
    expect(await run('5.12.2', '--dry-run')).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('omg release 5.12.2 --dry-run: plan only, nothing runs');
    for (const [i, id] of ['preflight', 'bump', 'build', 'gates', 'commit', 'suite', 'smoke', 'pr', 'promote', 'tag', 'verify'].entries()) {
      expect(text).toMatch(new RegExp(`${String(i + 1).padStart(2)}\\S* \\S*${id}`));
    }
    expect(calls).toEqual([]);
    expect(existsSync(join(root, '.omg'))).toBe(false);
  });

  it('--dry-run --json emits the plan as JSON', async () => {
    expect(await run('v5.12.2', '--dry-run', '--json', '--from', 'pr', '--to', 'promote')).toBe(0);
    const parsed = JSON.parse(out.join('\n')) as { dryRun: boolean; version: string; phases: Array<{ id: string; steps: string[] }> };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.version).toBe('5.12.2');
    expect(parsed.phases.map((p) => p.id)).toEqual(['pr', 'promote']);
  });

  it.each([
    [['5.12'], /version must be X\.Y\.Z/],
    [['5.12.2', '--from', 'publish'], /--from must be one of/],
    [['5.12.2', '--from', 'verify', '--to', 'tag'], /--from verify comes after --to tag/],
    [['5.12.2', '--suite', 'all'], /--suite must be none, targeted or full/],
    [['5.12.2', '--suite', 'targeted', '--baseline', 'x.json'], /--baseline needs --suite full/],
    [['5.12.2', '--timeout', '0'], /--timeout must be a positive number/],
    [['5.12.2', '--triage-runs', '0'], /--triage-runs must be a positive whole number/],
    [['5.12.2', '--triage-runs', '2.5'], /--triage-runs must be a positive whole number/],
    [['5.12.2', '--triage-timeout', '0'], /--triage-timeout must be a positive number/],
    [['5.12.2', '--flaky-candidates', '--status'], /pass one of --status \/ --stop \/ --flaky-candidates/],
  ])('usage error %j exits 2', async (argv, message) => {
    expect(await run(...argv, '--dry-run')).toBe(2);
    expect(err.join('\n')).toMatch(message);
    expect(calls).toEqual([]);
  });

  it('--baseline without --suite needs a full suite recorded for the release: a usage error (exit 2)', async () => {
    expect(await run('5.12.2', '--baseline', 'x.json', '--dry-run')).toBe(2);
    expect(err.join('\n')).toMatch(/--baseline needs --suite full \(this release's suite is none\)/);
  });

  it('warns when --suite is passed with a --to that ends before the suite phase', async () => {
    expect(await run('5.12.2', '--to', 'gates', '--suite', 'full', '--dry-run')).toBe(0);
    expect(err.join('\n')).toMatch(/--to gates stops before the suite phase, so --suite full does not run in this invocation/);
    err = [];
    expect(await run('5.12.2', '--to', 'suite', '--suite', 'full', '--dry-run')).toBe(0);
    expect(err.join('\n')).not.toMatch(/stops before the suite phase/);
  });

  it('--flaky-candidates prints the triage candidates as a paste-ready block and runs nothing', async () => {
    expect(await run('5.12.2', '--flaky-candidates')).toBe(0);
    expect(out.join('\n')).toMatch(/no known-flaky candidates for 5\.12\.2/);
    out = [];
    const tests = [{ file: 'src/a.test.ts', title: 'x > y', note: 'load-sensitive', evidence: { class: 'load-flaky', runs: 3, passes: 3, release: '5.12.2' } }];
    mkdirSync(join(root, '.omg', 'release'), { recursive: true });
    writeFileSync(join(root, '.omg', 'release', '5.12.2-flaky-candidates.json'), JSON.stringify({ release: '5.12.2', tests }));
    expect(await run('5.12.2', '--flaky-candidates')).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/1 known-flaky candidate\(s\) of the 5\.12\.2 full-suite triage/);
    expect(text).toMatch(/Owner approval needed/);
    expect(JSON.parse(text.slice(text.indexOf('[')))).toEqual(tests);
    expect(calls).toEqual([]);
  });

  it('--flaky-candidates on a corrupt candidates file is a clear usage error, not a raw JSON throw', async () => {
    mkdirSync(join(root, '.omg', 'release'), { recursive: true });
    writeFileSync(join(root, '.omg', 'release', '5.12.2-flaky-candidates.json'), '{"tests": [');
    expect(await run('5.12.2', '--flaky-candidates')).toBe(2);
    expect(err.join('\n')).toMatch(/5\.12\.2-flaky-candidates\.json is not valid JSON .*delete it and re-run/);
    expect(calls).toEqual([]);
  });

  describe('drive mode: --detach, --status, --stop', () => {
    let liveness: DriverLiveness;
    let killed: number[];
    let spawned: Array<{ args: string[]; options: Record<string, unknown> }>;
    let events: ReleaseProgressInput[];
    const proc: DriveProcess = { identity: async () => 'ticks:1', liveness: async () => liveness, kill: async (pid) => { killed.push(pid); return true; } };
    const lockPath = () => join(root, '.omg', 'release', '5.12.2.drive.json');
    const lock = (pid: number) => JSON.stringify({ pid, startedAt: '2026-10-28T00:00:00.000Z', argv: [], host: 'h', identity: 'ticks:9' });

    async function drive(...argv: string[]): Promise<number> {
      process.exitCode = undefined;
      await releaseCommand({
        exec, root, stateRoot: join(root, '.omg'), progress: (e) => { events.push(e); }, driveProcess: proc, entry: '/x/cli.cjs', sleep: async () => {},
        spawnDriver: (_command, args, options) => {
          spawned.push({ args, options: options as Record<string, unknown> });
          writeFileSync(lockPath(), lock(777));
          return { pid: 777, unref: () => {} };
        },
      }).parseAsync(argv, { from: 'user' });
      const code = Number(process.exitCode ?? 0);
      process.exitCode = undefined;
      return code;
    }

    beforeEach(() => {
      liveness = 'live';
      killed = [];
      spawned = [];
      events = [];
    });

    it('--detach re-spawns the same release with --drive (no --detach, absolute --baseline) and prints the Monitor command', async () => {
      expect(await drive('5.12.2', '--detach', '--yes', '--suite', 'full', '--baseline', 'base.json', '--from', 'pr', '--drive-max', '3', '--force-smoke', '--triage-runs', '5')).toBe(0);
      expect(spawned).toHaveLength(1);
      const args = spawned[0].args;
      expect(args.slice(0, 7)).toEqual(['/x/cli.cjs', 'release', '5.12.2', '--drive', '--drive-max', '3', '--timeout']);
      expect(args).toEqual(expect.arrayContaining(['--yes', '--from', 'pr', '--suite', 'full', '--baseline', resolve('base.json'), '--force-smoke']));
      expect(args.slice(args.indexOf('--triage-runs'), args.indexOf('--triage-runs') + 2)).toEqual(['--triage-runs', '5']);
      expect(args).not.toContain('--detach');
      expect(spawned[0].options).toMatchObject({ cwd: root, detached: true, windowsHide: true });
      expect(out.join('\n')).toMatch(/driving detached as pid 777/);
      expect(out.join('\n')).toMatch(/omg progress watch --file .* --until settled/);
      expect(calls).toEqual([]);

      // A second --detach (or a foreground --drive) refuses while the driver lives.
      expect(await drive('5.12.2', '--detach')).toBe(1);
      expect(err.join('\n')).toMatch(/a driver already runs \(pid 777/);
      expect(await drive('5.12.2', '--drive')).toBe(1);
      expect(err.join('\n')).toMatch(/another driver holds .*5\.12\.2\.drive\.json/);
      expect(spawned).toHaveLength(1);
      expect(calls).toEqual([]);
    });

    it('--status prints the driver, the last events and the phase table; --stop kills it and emits blocked', async () => {
      mkdirSync(join(root, '.omg', 'release'), { recursive: true });
      expect(await drive('5.12.2', '--status')).toBe(0);
      expect(out.join('\n')).toMatch(/driver: none/);
      expect(out.join('\n')).toMatch(/resume: omg release 5\.12\.2 --drive --detach/);

      writeFileSync(lockPath(), lock(4242));
      out = [];
      expect(await drive('5.12.2', '--status')).toBe(0);
      expect(out.join('\n')).toMatch(/driver: pid 4242 on h since .* \(live\)/);
      expect(out.join('\n')).toMatch(/preflight +-/);

      expect(await drive('5.12.2', '--stop')).toBe(0);
      expect(killed).toEqual([4242]);
      expect(existsSync(lockPath())).toBe(false);
      expect(events).toEqual([expect.objectContaining({ phase: 'release', status: 'blocked', note: expect.stringMatching(/stopped by --stop/) })]);

      // An unprobeable holder is left alone (exit 1).
      writeFileSync(lockPath(), lock(4243));
      liveness = 'unknown';
      expect(await drive('5.12.2', '--stop')).toBe(1);
      expect(killed).toEqual([4242]);
      expect(existsSync(lockPath())).toBe(true);
    });

    it.each([
      [['--drive-max', '0'], /--drive-max must be a positive number of hours/],
      [['--status', '--stop'], /pass one of --status \/ --stop/],
      [['--detach', '--dry-run'], /--detach runs the release; drop --dry-run/],
    ])('usage error %j exits 2', async (argv, message) => {
      expect(await drive('5.12.2', ...argv)).toBe(2);
      expect(err.join('\n')).toMatch(message);
    });
  });
});
