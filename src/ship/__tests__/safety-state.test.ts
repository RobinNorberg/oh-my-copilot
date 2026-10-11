import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { assertSafeCommand, guardExec, ShipSafetyError, type Exec } from '../exec.js';
import { loadKnownFlaky, resolveShipConfig } from '../config.js';
import {
  canTransition,
  createShipState,
  readShipState,
  recordVerdict,
  shipStatePath,
  transition,
  updateShipState,
  ShipStateError,
  type ShipState,
} from '../state.js';

const SHA_A = 'a'.repeat(40);
const T = '2026-10-11T00:00:00.000Z';

describe('assertSafeCommand', () => {
  const refused = [
    ['git', 'push', '--force', 'origin', 'feat/x'],
    ['git', 'push', '-f', 'origin', 'feat/x'],
    ['git', 'push', '--force-with-lease', 'origin', 'feat/x'],
    ['git', 'push', '--force-if-includes', 'origin', 'feat/x'],
    ['git', 'push', 'origin', '+feat/x'],
    ['git', 'push', 'origin', 'HEAD:+refs/heads/x'],
    ['git', 'push', 'origin', ':feat/x'],
    ['git', 'push', '--delete', 'origin', 'feat/x'],
    ['git', 'push', '--mirror'],
    ['git', 'rebase', 'origin/dev'],
    ['git', '-C', 'repo', 'rebase', '-i', 'HEAD~2'],
    ['git', 'pull', 'origin', 'dev'],
    ['git', 'worktree', 'add', '../x'],
    ['git', 'worktree', 'remove', '../x'],
    ['git', 'reset', '--hard', 'origin/dev'],
    ['git', 'commit', '--amend', '--no-edit'],
    ['git.exe', 'push', '--force'],
    ['C:\\Program Files\\Git\\cmd\\git.exe', 'rebase', 'dev'],
    ['gh', 'pr', 'merge', '12', '--admin', '--squash'],
    ['gh', 'pr', 'merge', '12', '--admin', '--rebase'],
    ['gh', 'pr', 'merge', '12', '--admin'],
    ['npm', 'ci'],
  ];
  for (const [cmd, ...args] of refused) {
    it(`refuses ${cmd} ${args.join(' ')}`, () => {
      expect(() => assertSafeCommand(cmd, args)).toThrow(ShipSafetyError);
    });
  }

  const allowed = [
    ['git', 'push', 'origin', 'HEAD:refs/heads/feat/x'],
    ['git', 'push', '-u', 'origin', 'feat/x'],
    ['git', 'merge', '--no-edit', 'origin/dev'],
    ['git', 'checkout', '--theirs', '--', 'inventory'],
    ['git', 'worktree', 'list'],
    ['git', 'reset', 'HEAD', 'file'],
    ['gh', 'pr', 'merge', '12', '--admin', '--merge', '--match-head-commit', SHA_A],
    ['gh', 'run', 'rerun', '1', '--failed'],
  ];
  for (const [cmd, ...args] of allowed) {
    it(`allows ${cmd} ${args.join(' ')}`, () => {
      expect(() => assertSafeCommand(cmd, args)).not.toThrow();
    });
  }

  it('guardExec refuses before spawning', () => {
    let spawned = 0;
    const exec: Exec = () => { spawned += 1; return { status: 0, stdout: '', stderr: '' }; };
    const guarded = guardExec(exec);
    expect(() => guarded('git', ['push', '--force'])).toThrow(ShipSafetyError);
    expect(spawned).toBe(0);
    guarded('git', ['status']);
    expect(spawned).toBe(1);
  });
});

describe('ship config', () => {
  it('defaults: dev base, two advisory gates, admin merge off', () => {
    const c = resolveShipConfig(undefined);
    expect(c.base).toBe('dev');
    expect(c.advisoryChecks).toEqual(['No Committed Build Artifacts', 'Authorize generated artifacts from base trust root']);
    expect(c.allowAdminMerge).toBe(false);
    expect(c.maxFixRounds).toBe(2);
    expect(c.watchTimeoutMinutes).toBeLessThan(10);
  });

  it('merges valid overrides and rejects ill-typed ones', () => {
    expect(resolveShipConfig({ allowAdminMerge: true, maxFixRounds: 4 })).toMatchObject({ allowAdminMerge: true, maxFixRounds: 4 });
    expect(() => resolveShipConfig({ allowAdminMerge: 'yes' })).toThrow(/allowAdminMerge/);
    expect(() => resolveShipConfig({ advisoryChecks: 'x' })).toThrow(/advisoryChecks/);
    expect(() => resolveShipConfig({ maxFixRounds: 1.5 })).toThrow(/maxFixRounds/);
    expect(() => resolveShipConfig([])).toThrow(/object/);
  });

  it('loadKnownFlaky: missing file is empty, malformed throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omg-ship-flaky-'));
    try {
      expect(loadKnownFlaky(dir, 'nope.json')).toEqual([]);
      writeFileSync(join(dir, 'bad.json'), '{"tests":[{"title":"x"}]}');
      expect(() => loadKnownFlaky(dir, 'bad.json')).toThrow(/file must be a string/);
      writeFileSync(join(dir, 'ok.json'), '{"tests":[{"file":"src\\\\a.test.ts"}]}');
      expect(loadKnownFlaky(dir, 'ok.json')).toEqual([{ file: 'src/a.test.ts', title: undefined, note: undefined }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ship state machine', () => {
  const fresh = (max = 2): ShipState => createShipState({ pr: 7, base: 'dev', implementer: 'executor-1', maxFixRounds: max }, T);
  const verdict = (reviewer: string, kind: 'approve' | 'changes-requested', sha = SHA_A) => ({ reviewer, verdict: kind, sha, at: T });

  it('starts in review', () => {
    expect(fresh().phase).toBe('review');
    expect(fresh().history).toHaveLength(1);
  });

  it('refuses self-approval, case-insensitively', () => {
    expect(() => recordVerdict(fresh(), verdict('Executor-1', 'approve'))).toThrow(/self-approval/);
  });

  it('requires a full sha', () => {
    expect(() => recordVerdict(fresh(), verdict('verifier', 'approve', 'abc123'))).toThrow(ShipStateError);
  });

  it('approve -> prepare; changes -> fix with round counting; budget spent -> blocked', () => {
    expect(recordVerdict(fresh(), verdict('verifier', 'approve')).phase).toBe('prepare');
    let s = recordVerdict(fresh(2), verdict('verifier', 'changes-requested'));
    expect(s).toMatchObject({ phase: 'fix', fixRounds: 1 });
    s = recordVerdict(s, verdict('verifier', 'changes-requested'));
    expect(s).toMatchObject({ phase: 'fix', fixRounds: 2 });
    s = recordVerdict(s, verdict('verifier', 'changes-requested'));
    expect(s.phase).toBe('blocked');
    expect(s.blockedReason).toMatch(/budget/);
    expect(() => recordVerdict(s, verdict('verifier', 'approve'))).toThrow(/illegal ship transition blocked -> prepare/);
  });

  it('a later changes-requested verdict reopens a prepared run', () => {
    let s = recordVerdict(fresh(), verdict('verifier', 'approve'));
    s = transition(s, 'gates', 'prepared', T);
    s = recordVerdict(s, verdict('verifier', 'changes-requested'));
    expect(s.phase).toBe('fix');
  });

  it('transition table: merged and blocked are terminal; merge only from ready', () => {
    expect(canTransition('merged', 'gates')).toBe(false);
    expect(canTransition('blocked', 'review')).toBe(false);
    expect(canTransition('gates', 'merged')).toBe(false);
    expect(canTransition('ready', 'merged')).toBe(true);
    expect(canTransition('review', 'gates')).toBe(false);
  });

  describe('persistence', () => {
    let root: string;
    beforeEach(() => {
      // A real repo: a non-git dir would anchor state under the home directory.
      root = mkdtempSync(join(tmpdir(), 'omg-ship-state-'));
      execFileSync('git', ['init', '-q'], { cwd: root });
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('writes .omg/state/ship/<pr>.json and reads it back (survives a restart)', () => {
      updateShipState(root, 7, () => fresh());
      const path = shipStatePath(root, 7);
      expect(path.replace(/\\/g, '/')).toMatch(/\.omg\/state\/ship\/7\.json$/);
      expect(JSON.parse(readFileSync(path, 'utf8')).phase).toBe('review');
      const next = updateShipState(root, 7, (s) => recordVerdict(s!, verdict('verifier', 'approve')));
      expect(readShipState(root, 7)).toEqual(next);
    });

    it('returns null for an unknown PR and rejects a mismatched file', () => {
      expect(readShipState(root, 99)).toBeNull();
      updateShipState(root, 8, () => ({ ...fresh(), pr: 8 }));
      writeFileSync(shipStatePath(root, 9), readFileSync(shipStatePath(root, 8)));
      expect(() => readShipState(root, 9)).toThrow(/not a ship state for PR #9/);
    });

    it('a throwing mutator leaves the stored state untouched', () => {
      updateShipState(root, 7, () => fresh());
      expect(() => updateShipState(root, 7, () => { throw new Error('boom'); })).toThrow('boom');
      expect(readShipState(root, 7)?.phase).toBe('review');
    });
  });
});
