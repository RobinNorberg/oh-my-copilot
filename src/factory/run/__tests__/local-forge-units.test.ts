/**
 * Units of the engine's local forge support (offline forge plan §1.1, lane B):
 * the exec guard's local shapes, the pack programs pinned on `omg-local`,
 * the local gate and its record, and the sealed `remote` of the run state.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readLocalCheckRecord, writeLocalCheckRecord } from '../../../forge/local/index.js';
import type { Exec } from '../../../ship/exec.js';
import { assertFactoryCommand, FactorySafetyError, hardenedGitExec, LOCAL_REMOTE_PACK_ARGS } from '../exec.js';
import { assertLocalGateCommand, LOCAL_GATE_TAIL_CHARS, localGateRecord, runLocalGate, type LocalGateRunner } from '../local-gate.js';
import { createFactoryState, parseFactoryState, runRemote } from '../state.js';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const MIRROR = resolve(tmpdir(), 'forge', 'local', 'repo-0123456789ab.git');
const ok = (cmd: string, args: string[], extra: string[] = []) => () => assertFactoryCommand(cmd, args, extra);

describe('the factory guard on the local forge shapes', () => {
  it.each([
    ['a factory branch to the mirror', ['push', 'omg-local', `${SHA}:refs/heads/factory/issue-7`], []],
    ['the run base to the mirror (fast-forward base sync)', ['push', 'omg-local', `${SHA}:refs/heads/main`], ['main']],
    ['ls-remote of a factory branch on the mirror', ['ls-remote', 'omg-local', 'refs/heads/factory/issue-7'], []],
    ['the bare mirror init', ['init', '--bare', '--quiet', MIRROR], []],
    ['the omg-local remote add', ['remote', 'add', 'omg-local', MIRROR], []],
    ['the backlog list at a commit', ['ls-tree', '-z', '--name-only', SHA, '--', '.copilot/backlog/'], []],
    ['one backlog file at a commit', ['show', `${SHA}:.copilot/backlog/1-add-remove.md`], []],
    ['the merged check', ['merge-base', '--is-ancestor', SHA, SHA2], []],
    ['the local base branch', ['rev-parse', '--verify', 'refs/heads/main'], []],
    ['the mirror fetch', ['fetch', 'omg-local', 'main'], []],
  ])('allows %s', (_what, args, extra) => {
    expect(ok('git', args, extra)).not.toThrow();
  });

  it.each([
    ['a protected branch that is not the run base', ['push', 'omg-local', `${SHA}:refs/heads/dev`], ['main']],
    ['the base to origin', ['push', 'origin', `${SHA}:refs/heads/main`], ['main']],
    ['a forced push to the mirror', ['push', 'omg-local', `+${SHA}:refs/heads/main`], ['main']],
    ['another remote name', ['push', 'evil', `${SHA}:refs/heads/factory/issue-7`], []],
    ['an init outside the forge state layout', ['init', '--bare', '--quiet', resolve(tmpdir(), 'elsewhere.git')], []],
    ['a relative mirror path', ['init', '--bare', '--quiet', 'local/repo-0123456789ab.git'], []],
    ['a non-bare init', ['init', MIRROR], []],
    ['a remote add of another name', ['remote', 'add', 'origin', MIRROR], []],
    ['a remote add of another url', ['remote', 'add', 'omg-local', 'https://github.com/o/r.git'], []],
    ['a remote set-url', ['remote', 'set-url', 'omg-local', MIRROR], []],
    ['a backlog list that climbs out', ['ls-tree', '-z', '--name-only', SHA, '--', '../x/'], []],
    ['a backlog list without the trailing slash', ['ls-tree', '-z', '--name-only', SHA, '--', '.copilot/backlog'], []],
  ])('refuses %s', (_what, args, extra) => {
    expect(ok('git', args, extra)).toThrow(FactorySafetyError);
  });
});

describe('hardenedGitExec on omg-local', () => {
  const seen: string[][] = [];
  const inner: Exec = (_cmd, args) => { seen.push(args); return { status: 0, stdout: '', stderr: '' }; };
  let dir: string;
  afterEach(() => { seen.length = 0; rmSync(dir, { recursive: true, force: true }); });

  it('pins the stock pack programs for push, fetch and ls-remote on omg-local, and only there', () => {
    dir = mkdtempSync(join(tmpdir(), 'omg-hooks-'));
    const exec = hardenedGitExec(inner, dir);
    exec('git', ['push', 'omg-local', `${SHA}:refs/heads/factory/issue-7`]);
    exec('git', ['fetch', 'omg-local', 'main']);
    exec('git', ['ls-remote', 'omg-local', 'refs/heads/factory/issue-7']);
    exec('git', ['push', 'origin', `${SHA}:refs/heads/factory/issue-7`]);
    exec('git', ['remote', 'get-url', 'omg-local']);
    const pinned = (args: string[]) => args.join(' ').includes(LOCAL_REMOTE_PACK_ARGS.join(' '));
    expect(seen.map(pinned)).toEqual([true, true, true, false, false]);
    expect(LOCAL_REMOTE_PACK_ARGS).toEqual(['-c', 'remote.omg-local.receivepack=git-receive-pack', '-c', 'remote.omg-local.uploadpack=git-upload-pack']);
    // The pins come after the hardening and before the command, so they win over the repository config.
    const at = seen[0].indexOf('push');
    expect(seen[0].slice(at - LOCAL_REMOTE_PACK_ARGS.length, at)).toEqual(LOCAL_REMOTE_PACK_ARGS);
  });
});

describe('the local gate', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const world = () => {
    dir = mkdtempSync(join(tmpdir(), 'omg-local-gate-'));
    return { stateDir: join(dir, 'forge'), root: join(dir, 'repo'), checkout: join(dir, 'checkout') };
  };

  it('runs the configured argv once in the checkout and records SUCCESS for exactly that head', () => {
    const w = world();
    const runs: Array<{ argv: readonly string[]; cwd: string; timeoutMs: number }> = [];
    const runner: LocalGateRunner = (argv, cwd, timeoutMs) => {
      runs.push({ argv, cwd, timeoutMs });
      // While the gate runs, the head reads PENDING (a crash leaves no pass behind).
      expect(localGateRecord(w.stateDir, w.root, SHA)?.state).toBe('PENDING');
      return { status: 0, stdout: 'ok 1\n', stderr: '', timedOut: false };
    };
    const record = runLocalGate({ ...w, head: SHA, gate: ['npm', 'test'], timeoutMinutes: 3, runner });
    expect(runs).toEqual([{ argv: ['npm', 'test'], cwd: w.checkout, timeoutMs: 180_000 }]);
    expect(record).toMatchObject({ name: 'local-gate', head: SHA, state: 'SUCCESS', exitCode: 0, argv: ['npm', 'test'] });
    expect(readLocalCheckRecord(w.stateDir, w.root, SHA)).toEqual(record);
    expect(localGateRecord(w.stateDir, w.root, SHA2)).toBeUndefined();
  });

  it('a failing or timed-out gate records FAILURE with the output tail', () => {
    const w = world();
    const failed = runLocalGate({ ...w, head: SHA, gate: ['node', '--test'], timeoutMinutes: 1, runner: () => ({ status: 1, stdout: 'x'.repeat(LOCAL_GATE_TAIL_CHARS + 50), stderr: 'not ok 1', timedOut: false }) });
    expect(failed.state).toBe('FAILURE');
    expect(failed.exitCode).toBe(1);
    expect(failed.tail!.length).toBe(LOCAL_GATE_TAIL_CHARS);
    expect(failed.tail!.endsWith('not ok 1')).toBe(true);
    const timedOut = runLocalGate({ ...w, head: SHA2, gate: ['node', '--test'], timeoutMinutes: 1, runner: () => ({ status: 1, stdout: '', stderr: '', timedOut: true }) });
    expect(timedOut).toMatchObject({ state: 'FAILURE', exitCode: 124 });
    expect(timedOut.tail).toContain('timed out after 1 min');
  });

  it('a removed record (checks.rerun) reads as never run, so the engine runs the gate again', () => {
    const w = world();
    writeLocalCheckRecord(w.stateDir, w.root, { name: 'local-gate', head: SHA, state: 'FAILURE', argv: ['x'], runId: 5, startedAt: 'now' });
    expect(localGateRecord(w.stateDir, w.root, SHA)?.state).toBe('FAILURE');
    rmSync(join(w.stateDir), { recursive: true, force: true });
    expect(localGateRecord(w.stateDir, w.root, SHA)).toBeUndefined();
  });

  it('assertLocalGateCommand allows only the configured argv in the engine checkout', () => {
    const checkout = resolve(tmpdir(), 'checkout');
    expect(() => assertLocalGateCommand(['npm', 'test'], checkout, ['npm', 'test'], checkout)).not.toThrow();
    expect(() => assertLocalGateCommand(['npm', 'test', '--', 'x'], checkout, ['npm', 'test'], checkout)).toThrow(/not factory\.forge\.local\.gate/);
    expect(() => assertLocalGateCommand(['npm', 'test'], resolve(tmpdir(), 'repo'), ['npm', 'test'], checkout)).toThrow(/only in the engine's prepare checkout/);
    expect(() => assertLocalGateCommand(['npm', 'test'], checkout, undefined, checkout)).toThrow(/not set in a trusted config layer/);
  });
});

describe('the sealed run remote', () => {
  const at = '2026-11-07T00:00:00.000Z';
  const parse = (s: object) => () => parseFactoryState('state.json', 7, JSON.stringify(s));

  it('is absent (origin) on GitHub and ADO runs, so older states parse unchanged', () => {
    const s = createFactoryState({ issue: 7, repoUrl: '', base: 'dev' }, at);
    expect('remote' in s).toBe(false);
    expect(runRemote(s)).toBe('origin');
    expect(parse({ ...s, forgeKind: 'azure-devops' })).not.toThrow();
  });

  it('is omg-local exactly on a local run; any other pairing is malformed', () => {
    const s = { ...createFactoryState({ issue: 7, repoUrl: '', base: 'main', remote: 'omg-local' }, at), forgeKind: 'local' as const };
    expect(runRemote(s)).toBe('omg-local');
    expect(parse(s)).not.toThrow();
    expect(parse({ ...s, remote: undefined })).toThrow(/field remote/);
    expect(parse({ ...s, forgeKind: 'github' })).toThrow(/field remote/);
    expect(parse({ ...s, remote: 'origin' })).toThrow(/field remote/);
  });
});
