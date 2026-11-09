import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createForge } from '../../../forge/index.js';
import type { Exec, ExecResult } from '../../../ship/exec.js';
import { readBaseFile } from '../../../ship/config.js';
import { runFactoryEnqueue } from '../../enqueue.js';
import { acquireFactoryRepoOwner, FactoryBusyError, factoryRepoOwnerPath, type OwnerDeps } from '../../run/state.js';
import { openReadForge, runFactoryCheck, type FactoryCheckDeps } from '../cli.js';

const SHA = 'a'.repeat(40);
const NOW = '2026-11-09T12:00:00.000Z';
const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });
const live = (pid: number): OwnerDeps => ({ pid, hostname: 'h', isAlive: () => true });

let root: string;
let fetches: { lockRun: string | null }[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omg-read-fetch-'));
  // A git repository: its factory state (the engine lock read commands take) lives in it, never in a home .omg.
  execFileSync('git', ['init', '-q', root]);
  fetches = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The engine lock's run key right now (null: free). */
const lockRun = (): string | null => {
  const path = factoryRepoOwnerPath(root);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { run: string }).run : null;
};

/** A GitHub checkout whose every `git fetch` is recorded with the engine lock's holder at that moment. */
function scripted(o: { tracking?: boolean; fetchThrows?: boolean } = {}): Exec {
  return (cmd, args) => {
    const a = args.join(' ');
    if (cmd === 'git') {
      if (a === 'rev-parse --show-toplevel') return ok(`${root}\n`);
      if (a === 'remote get-url origin') return ok('https://github.com/o/r.git\n');
      if (args[0] === 'fetch') {
        fetches.push({ lockRun: lockRun() });
        if (o.fetchThrows) throw new Error('fetch blew up');
        return ok();
      }
      if (a === 'rev-parse --verify refs/remotes/origin/dev') return o.tracking === false ? { status: 128, stdout: '', stderr: 'fatal: Needed a single revision' } : ok(`${SHA}\n`);
      if (a === `cat-file -e ${SHA}^{commit}`) return ok();
      // A localized git: "absent" must come from ls-tree, never from this message.
      if (args[0] === 'show') return { status: 128, stdout: '', stderr: 'fatal: sökvägen finns inte' };
      if (args[0] === 'ls-tree') return ok('');
    }
    if (cmd === 'gh') return ok('[]');
    throw new Error(`unscripted ${cmd} ${a}`);
  };
}

function deps(exec: Exec, owner: OwnerDeps): FactoryCheckDeps {
  return {
    exec, base: () => 'dev', trustedUser: () => undefined, projectConfig: () => undefined, createForge,
    isTTY: () => false, confirm: async () => false, out: () => undefined, err: () => undefined, owner,
  };
}

describe('read commands fetch the base under the engine lock, and never fail because an engine runs (review-459c M1)', () => {
  it('a live engine: check, board/poll start-up (openReadForge) and enqueue fetch nothing and read the last fetched base, with one warning', async () => {
    acquireFactoryRepoOwner(root, 7, NOW, live(1));
    const warnings: string[] = [];
    const read = openReadForge({}, deps(scripted(), live(2)), warnings, 'omg factory poll');
    expect(read.baseSha).toBe(SHA);
    expect(warnings).toContain(`engine busy: using the last fetched origin/dev (${SHA.slice(0, 12)})`);
    await runFactoryCheck({ ids: ['1'] }, deps(scripted(), live(2))).catch(() => undefined);
    const ticket = join(root, 'tickets.json');
    writeFileSync(ticket, '[]');
    await runFactoryEnqueue({ spec: '10', file: ticket, dryRun: true }, deps(scripted(), live(2))).catch(() => undefined);
    expect(fetches).toEqual([]);
    expect(lockRun()).toBe('7');
  });

  it('a live engine and no fetched base at all: busy (exit 6), nothing fetched', () => {
    acquireFactoryRepoOwner(root, 7, NOW, live(1));
    expect(() => openReadForge({}, deps(scripted({ tracking: false }), live(2)), [], 'omg factory check')).toThrow(FactoryBusyError);
    expect(() => openReadForge({}, deps(scripted({ tracking: false }), live(2)), [], 'omg factory check')).toThrow(/origin\/dev was never fetched in this checkout/);
    expect(fetches).toEqual([]);
  });

  it('free: the fetch runs under the `scan` lock, released after, also when the fetch throws', async () => {
    openReadForge({}, deps(scripted(), live(2)), [], 'omg factory board');
    const ticket = join(root, 'tickets.json');
    writeFileSync(ticket, '[]');
    await runFactoryEnqueue({ spec: '10', file: ticket, dryRun: true }, deps(scripted(), live(2))).catch(() => undefined);
    expect(fetches).toEqual([{ lockRun: 'scan' }, { lockRun: 'scan' }]);
    expect(lockRun()).toBeNull();
    expect(() => openReadForge({}, deps(scripted({ fetchThrows: true }), live(2)), [], 'omg factory check')).toThrow('fetch blew up');
    expect(fetches).toHaveLength(3);
    expect(lockRun()).toBeNull();
  });

  it('a read command\'s own lock is busy for an engine only briefly: it names the scan holder', () => {
    acquireFactoryRepoOwner(root, 'scan', NOW, live(2));
    expect(() => acquireFactoryRepoOwner(root, 7, NOW, live(1))).toThrow(/heal scan or base sync, or a factory read command's fetch, holds this checkout for a moment/);
  });
});

describe('readBaseFile decides "absent" from ls-tree, whatever the locale (review-465b LOW 5)', () => {
  const at = (show: ExecResult, entry: ExecResult): Exec => (_cmd, args) =>
    (args[0] === 'cat-file' ? ok() : args[0] === 'show' ? show : args[0] === 'ls-tree' ? entry : ok());
  const missing: ExecResult = { status: 128, stdout: '', stderr: 'fatal: Pfad ".copilot/omg.jsonc" existiert nicht' };

  it('no entry is absent (null); an entry that cannot be shown (a tree, a gitlink) or a failed probe throws', () => {
    expect(readBaseFile(at(missing, ok('')), root, SHA, '.copilot/omg.jsonc')).toBeNull();
    expect(() => readBaseFile(at(missing, ok(`040000 tree ${SHA}\t.copilot/omg.jsonc\0`)), root, SHA, '.copilot/omg.jsonc')).toThrow(/git show .* failed \(exit 128\)/);
    expect(() => readBaseFile(at(missing, { status: 128, stdout: '', stderr: 'fatal' }), root, SHA, '.copilot/omg.jsonc')).toThrow(/failed/);
    // The English message alone no longer decides anything.
    expect(() => readBaseFile(at({ status: 128, stdout: '', stderr: "fatal: path 'x' does not exist in 'y'" }, { status: 1, stdout: '', stderr: '' }), root, SHA, 'x')).toThrow(/failed/);
    expect(readBaseFile(at(ok('{}'), ok('')), root, SHA, '.copilot/omg.jsonc')).toBe('{}');
  });

  it('the ship, check and factory guards allow exactly `ls-tree -z <sha> -- <plain path>`', async () => {
    const { assertSafeCommand } = await import('../../../ship/exec.js');
    const { checkGuardExec } = await import('../cli.js');
    const { TRUSTED_READ_ENV } = await import('../../../ship/exec.js');
    expect(() => assertSafeCommand('git', ['ls-tree', '-z', SHA, '--', '.copilot/omg.jsonc'], [], TRUSTED_READ_ENV)).not.toThrow();
    for (const bad of [['ls-tree', '-z', SHA, '--', '../x'], ['ls-tree', '-z', 'HEAD', '--', 'x'], ['ls-tree', '-r', SHA, '--', 'x'], ['ls-tree', '-z', SHA, 'x']]) {
      expect(() => assertSafeCommand('git', bad, [], TRUSTED_READ_ENV), bad.join(' ')).toThrow();
    }
    const guarded = checkGuardExec(() => ok(''));
    expect(guarded('git', ['ls-tree', '-z', SHA, '--', '.copilot/omg.jsonc'], { env: TRUSTED_READ_ENV }).status).toBe(0);
    expect(() => guarded('git', ['ls-tree', '-z', SHA, '--', '../etc/passwd'], { env: TRUSTED_READ_ENV })).toThrow();
    mkdirSync(dirname(factoryRepoOwnerPath(root)), { recursive: true });
  });
});
