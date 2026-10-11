import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { assertSafeCommand, guardExec, ShipSafetyError, type Exec } from '../exec.js';
import {
  DEFAULT_SHIP_CONFIG,
  isPlainBranchName,
  loadBaseKnownFlaky,
  loadTrustedShipConfig,
  resolveShipConfig,
  SHIP_SAFETY_KEYS,
} from '../config.js';
import { evaluateChecks } from '../gates.js';
import { parseJsonc } from '../../utils/jsonc.js';
import {
  canTransition,
  computeIntegrity,
  createShipState,
  readShipState,
  recordVerdict,
  shipStatePath,
  transition,
  updateShipState,
  verifyShipIntegrity,
  ShipStateError,
  type ShipState,
} from '../state.js';

const HERE = dirname(fileURLToPath(import.meta.url));
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
    // The engine never runs npm at all.
    ['npm', 'run', 'generate:inventory'],
    // Never a push to an integration branch, whatever the caller asks.
    ['git', 'push', 'origin', 'HEAD:refs/heads/dev'],
    ['git', 'push', 'origin', 'HEAD:refs/heads/main'],
    ['git', 'push', 'origin', 'HEAD:refs/heads/master'],
    // Base-branch file reads: plain repo paths only.
    ['git', 'show', 'origin/dev:../x'],
    ['git', 'show', 'origin/dev:/etc/passwd'],
    ['git', 'show', '--output=x', 'origin/dev:a.json'],
    ['git', 'show', 'origin/-x:a.json'],
    ['gh', 'pr', 'diff', '12'],
    ['gh', 'pr', 'diff', '12', '--patch'],
    // Shapes the engine never builds are refused too (allowlist, not denylist).
    ['git', 'push', '-u', 'origin', 'feat/x'],
    ['git', 'push', 'origin', 'feat/x'],
    ['git', 'worktree', 'list'],
    ['git', 'reset', 'HEAD', 'file'],
    ['git', 'merge', '--no-edit', 'origin/dev'],
    ['git', 'merge', '--no-ff', '--no-edit', '--upload-pack=evil'],
    ['git', 'fetch', 'origin', '--upload-pack=touch /tmp/pwned'],
    ['git', 'fetch', '--upload-pack=x', 'origin', 'dev'],
    ['git', 'merge-base', '--is-ancestor', '--upload-pack=x', 'HEAD'],
    ['git', 'rev-parse', '--verify', '--upload-pack=x^{commit}'],
    ['git', 'log', '--output=/tmp/x'],
    ['git', 'status'],
    ['gh', 'pr', 'merge', '12', '--admin', '--merge', '--match-head-commit', 'abc'],
    ['gh', 'pr', 'merge', '12', '--merge', '--admin', '--match-head-commit', SHA_A, '--delete-branch'],
    ['node', '-e', 'process.exit(0)'],
    ['node', 'node_modules/eslint/bin/eslint.js', '--fix', 'src/a.ts'],
    ['node', 'scripts/other.mjs'],
    ['bash', '-c', 'git push --force'],
  ];
  for (const [cmd, ...args] of refused) {
    it(`refuses ${cmd} ${args.join(' ')}`, () => {
      expect(() => assertSafeCommand(cmd, args)).toThrow(ShipSafetyError);
    });
  }

  /** The reviewer's guard probe (32 bypass attempts against the old denylist): every one is refused. */
  const probe: Array<[string, string[]]> = [
    ['git', ['push', '-fu', 'origin', 'x']],
    ['git', ['push', '-uf', 'origin', 'x']],
    ['git', ['-c', 'remote.origin.mirror=true', 'push', 'origin']],
    ['git', ['--namespace', 'x', 'push', '--force']],
    ['git', ['--config-env', 'alias.p=FOO', 'p']],
    ['git', ['-c', 'alias.p=push --force', 'p', 'origin']],
    ['git', ['push', 'origin', 'refs/heads/a:+refs/heads/b']],
    ['git', ['push', 'origin', '+HEAD:x']],
    ['git', ['push', 'origin', ':x']],
    ['git', ['push', '--force-with-lease']],
    ['git', ['push', '--mirror']],
    ['git', ['reset', '--keep', 'HEAD~3']],
    ['git', ['reset', 'HEAD~3', '--hard']],
    ['git', ['branch', '-D', 'dev']],
    ['git', ['checkout', '--', '.']],
    ['git', ['clean', '-fdx']],
    ['git', ['commit', '--amend=x']],
    ['git', ['update-ref', '-d', 'refs/heads/dev']],
    ['gh', ['pr', 'merge', '1', '--merge', '--auto']],
    ['gh', ['pr', 'merge', '1', '--merge', '-d']],
    ['gh', ['-R', 'o/r', 'pr', 'merge', '1', '--squash']],
    ['gh', ['pr', 'merge', '1', '-m', '--squash=true']],
    ['gh', ['pr', 'merge', '1', '--merge', '--squash=true']],
    ['gh', ['api', '-X', 'PUT', 'repos/o/r/pulls/1/merge', '-f', 'merge_method=squash']],
    ['gh', ['api', '-X', 'DELETE', 'repos/o/r/git/refs/heads/dev']],
    ['gh', ['repo', 'delete', 'o/r', '--yes']],
    ['GIT.EXE', ['rebase', 'dev']],
    ['C:\\Program Files\\Git\\cmd\\git.exe', ['rebase', 'dev']],
    ['git.cmd', ['rebase', 'dev']],
    ['npm', ['clean-install']],
    ['npm', ['--prefix', 'x', 'ci']],
    ['npm.cmd', ['ci']],
  ];
  it('the probe has 32 cases', () => expect(probe).toHaveLength(32));
  for (const [cmd, args] of probe) {
    it(`probe: refuses ${cmd} ${args.join(' ')}`, () => {
      expect(() => assertSafeCommand(cmd, args)).toThrow(ShipSafetyError);
    });
  }

  /** Every command shape the engine builds (exec.ts allowlist). */
  const allowed = [
    ['git', 'rev-parse', '--show-toplevel'],
    ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
    ['git', 'rev-parse', 'HEAD'],
    ['git', 'rev-parse', '-q', '--verify', 'MERGE_HEAD'],
    ['git', 'rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'],
    ['git', 'rev-parse', '-q', '--verify', 'REVERT_HEAD'],
    ['git', 'rev-parse', '--git-path', 'rebase-merge'],
    ['git', 'rev-parse', '--verify', 'abc1234^{commit}'],
    ['git', 'check-ref-format', '--branch', 'feat/x'],
    ['git', 'status', '--porcelain', '--untracked-files=no'],
    ['git', 'fetch', 'origin', 'dev'],
    ['git', 'merge-base', '--is-ancestor', 'origin/dev', 'HEAD'],
    ['git', 'merge-base', '--is-ancestor', SHA_A, 'HEAD'],
    ['git', 'merge', '--no-ff', '--no-edit', 'origin/dev'],
    ['git', 'diff', '--name-only', '--diff-filter=U'],
    ['git', 'diff', '--name-only', 'origin/dev...HEAD'],
    ['git', 'diff', '--cached', '--quiet'],
    ['git', 'checkout', '--theirs', '--', 'inventory'],
    ['git', 'add', '--', 'inventory'],
    ['git', 'commit', '--no-edit'],
    ['git', 'commit', '-m', 'chore(inventory): regenerate inventory graph baseline'],
    ['git', 'push', 'origin', 'HEAD:refs/heads/feat/x'],
    ['git', 'cat-file', '-e', `${SHA_A}^{commit}`],
    ['git', 'rev-list', '--first-parent', `${SHA_A}..${'b'.repeat(40)}`],
    ['git', 'log', '--oneline', 'origin/dev'],
    ['git.exe', 'show', SHA_A],
    ['gh', 'pr', 'view', '12', '--json', 'headRefName,baseRefName'],
    ['gh', 'pr', 'checks', '12', '--json', 'name,state,link'],
    ['gh', 'pr', 'merge', '12', '--admin', '--merge', '--match-head-commit', SHA_A],
    ['gh', 'run', 'view', '--job', '114080000001', '--log'],
    ['gh', 'run', 'list', '--commit', SHA_A, '--json', 'databaseId,status,conclusion,workflowName', '--limit', '100'],
    ['gh', 'run', 'rerun', '1', '--failed'],
    [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit'],
    ['node', 'node_modules/eslint/bin/eslint.js', 'src/ship/gates.ts'],
    ['node', 'node_modules/vitest/vitest.mjs', 'run', 'src/ship/__tests__/gates.test.ts'],
    ['node', 'scripts/generate-inventory-graph.mjs', '--write'],
    ['node', 'scripts/generate-prompt-projections.mjs', '--verify'],
    ['git', 'show', 'origin/dev:.copilot/omg.jsonc'],
    ['git', 'show', 'origin/release/v5.9.0:.github/known-flaky-tests.json'],
    ['gh', 'pr', 'diff', '12', '--name-only'],
    ['gh', 'pr', 'view', '12', '--json', 'baseRefName'],
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
    guarded('git', ['rev-parse', 'HEAD']);
    expect(spawned).toBe(1);
  });

  it('guardExec also refuses a push to the run base it is given', () => {
    const exec: Exec = () => ({ status: 0, stdout: '', stderr: '' });
    let base: string[] = [];
    const guarded = guardExec(exec, () => base);
    expect(() => guarded('git', ['push', 'origin', 'HEAD:refs/heads/release/v6'])).not.toThrow();
    base = ['release/v6'];
    expect(() => guarded('git', ['push', 'origin', 'HEAD:refs/heads/release/v6'])).toThrow(ShipSafetyError);
    expect(() => guarded('git', ['push', 'origin', 'HEAD:refs/heads/feat/x'])).not.toThrow();
  });
});

describe('ship config', () => {
  it('defaults: dev base, advisory gates incl. the Socket Security app checks, admin merge off', () => {
    const c = resolveShipConfig(undefined);
    expect(c.base).toBe('dev');
    expect(c.advisoryChecks).toEqual([
      'No Committed Build Artifacts',
      'Authorize generated artifacts from base trust root',
      'Socket Security: Pull Request Alerts',
      'Socket Security: Project Report',
    ]);
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
    expect(() => resolveShipConfig({ requiredChecks: [1] })).toThrow(/requiredChecks/);
    expect(resolveShipConfig({ requiredChecks: [] }).requiredChecks).toEqual([]);
  });

  it('requires the late needs: jobs by default', () => {
    expect(resolveShipConfig(undefined).requiredChecks).toEqual(expect.arrayContaining([
      'Test', 'Test (Windows path suite)', 'Build', 'npm pack + install test', 'Lint & Type Check', 'Version Consistency Check', 'Copilot smoke (tier 2)',
    ]));
  });

  it('refuses an option-shaped or malformed base', () => {
    for (const base of ['--upload-pack=evil', '-x', 'a b', 'a..b', '']) {
      expect(() => resolveShipConfig({ base })).toThrow(/ship.base/);
    }
    expect(isPlainBranchName('release/v5.9.0')).toBe(true);
  });

  it('loadBaseKnownFlaky reads the base branch (never the working tree): missing is empty, malformed throws', () => {
    const files: Record<string, string> = {
      'origin/dev:bad.json': '{"tests":[{"title":"x"}]}',
      'origin/dev:untitled.json': '{"tests":[{"file":"src/a.test.ts"}]}',
      'origin/dev:ok.json': '{"tests":[{"file":"src\\\\a.test.ts","title":"t"}]}',
    };
    const shown: string[] = [];
    const exec: Exec = (_cmd, args) => {
      shown.push(args.join(' '));
      const text = args[0] === 'show' ? files[args[1]] : undefined;
      return text === undefined ? { status: 128, stdout: '', stderr: 'fatal: path does not exist' } : { status: 0, stdout: text, stderr: '' };
    };
    const guarded = guardExec(exec);
    expect(loadBaseKnownFlaky(guarded, '.', 'dev', 'nope.json')).toEqual([]);
    expect(() => loadBaseKnownFlaky(guarded, '.', 'dev', 'bad.json')).toThrow(/file must be a string/);
    expect(() => loadBaseKnownFlaky(guarded, '.', 'dev', 'untitled.json')).toThrow(/title must be a non-empty string/);
    expect(loadBaseKnownFlaky(guarded, '.', 'dev', 'ok.json')).toEqual([{ file: 'src/a.test.ts', title: 't', note: undefined }]);
    expect(shown).toContain('show origin/dev:ok.json');
    expect(() => loadBaseKnownFlaky(guarded, '.', 'dev', '../outside.json')).toThrow(/repo-relative/);
    expect(() => resolveShipConfig({ knownFlakyFile: '/etc/x.json' })).toThrow(/knownFlakyFile/);
  });
});

describe('trusted ship config (safety keys never from the working tree or the PR head)', () => {
  // Verifier probe v238-cfg: an untracked project file turns admin merge on and makes Test advisory.
  const PROBE_PROJECT = parseJsonc(readFileSync(join(HERE, 'fixtures/project-config-admin-merge.jsonc'), 'utf8'));
  const CHECKS = JSON.parse(readFileSync(join(HERE, 'fixtures/checks-pr233-green.json'), 'utf8')) as Array<{ name: string; state: string }>;
  const failedTest = CHECKS.map((c) => (c.name === 'Test' ? { ...c, state: 'FAILURE' } : c));

  function execWithBase(baseFile: string | null): { exec: Exec; calls: string[] } {
    const calls: string[] = [];
    const exec: Exec = (_cmd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'show' && args[1] === 'origin/dev:.copilot/omg.jsonc' && baseFile !== null) return { status: 0, stdout: baseFile, stderr: '' };
      if (args[0] === 'show') return { status: 128, stdout: '', stderr: 'fatal: path does not exist in origin/dev' };
      return { status: 0, stdout: '', stderr: '' };
    };
    return { exec: guardExec(exec), calls };
  }

  it('the probe: a working-tree allowAdminMerge + advisory Test is ignored with a warning, and a FAILED Test stays failed', () => {
    const { exec, calls } = execWithBase(null);
    const warnings: string[] = [];
    const config = loadTrustedShipConfig({ exec, root: '.', base: 'dev', user: null, project: PROBE_PROJECT, warn: (m) => warnings.push(m) });
    expect(config.allowAdminMerge).toBe(false);
    expect(config.advisoryChecks).not.toContain('Test');
    expect(evaluateChecks(233, failedTest, config).verdict).toBe('failed');
    expect(warnings.join('\n')).toMatch(/ignoring ship\.allowAdminMerge/);
    expect(warnings.join('\n')).toMatch(/ignoring ship\.advisoryChecks/);
    expect(calls).toEqual(['fetch origin dev', 'show origin/dev:.copilot/omg.jsonc']);
  });

  it('reads the project file from the repo root by default (the untracked-file attack)', () => {
    const root = mkdtempSync(join(tmpdir(), 'omg-ship-cfg-'));
    try {
      mkdirSync(join(root, '.copilot'));
      writeFileSync(join(root, '.copilot', 'omg.jsonc'), readFileSync(join(HERE, 'fixtures/project-config-admin-merge.jsonc'), 'utf8'));
      const config = loadTrustedShipConfig({ exec: execWithBase(null).exec, root, base: 'dev', user: undefined, warn: () => {} });
      expect(config.allowAdminMerge).toBe(false);
      expect(config.advisoryChecks).toEqual(DEFAULT_SHIP_CONFIG.advisoryChecks);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('honors the file committed on the base branch, and the user config wins over it', () => {
    const base = '// committed on dev\n{ "ship": { "allowAdminMerge": true, "advisoryChecks": ["Size Check"], "maxFixRounds": 3, } }';
    const { exec } = execWithBase(base);
    const fromBase = loadTrustedShipConfig({ exec, root: '.', base: 'dev', user: null, project: {}, warn: () => {} });
    expect(fromBase).toMatchObject({ allowAdminMerge: true, advisoryChecks: ['Size Check'], maxFixRounds: 3 });
    const userWins = loadTrustedShipConfig({ exec, root: '.', base: 'dev', user: { ship: { allowAdminMerge: false } }, project: {}, warn: () => {} });
    expect(userWins.allowAdminMerge).toBe(false);
    expect(userWins.advisoryChecks).toEqual(['Size Check']);
    // The working tree still sets non-safety keys, and an unchanged safety key does not warn.
    const warnings: string[] = [];
    const project = { ship: { maxFixRounds: 5, allowAdminMerge: true, requiredChecks: [] } };
    const mixed = loadTrustedShipConfig({ exec, root: '.', base: 'dev', user: null, project, warn: (m) => warnings.push(m) });
    expect(mixed).toMatchObject({ maxFixRounds: 5, allowAdminMerge: true, requiredChecks: DEFAULT_SHIP_CONFIG.requiredChecks });
    expect(warnings).toEqual([expect.stringMatching(/ignoring ship\.requiredChecks/)]);
  });

  it('every safety key is covered', () => {
    expect([...SHIP_SAFETY_KEYS].sort()).toEqual(['advisoryChecks', 'allowAdminMerge', 'knownFlakyFile', 'requiredChecks']);
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

    it('seals every write; a hand edit fails the integrity check and blocks further updates', () => {
      const written = updateShipState(root, 7, () => fresh());
      expect(written.integrity).toBe(computeIntegrity(written));
      expect(verifyShipIntegrity(readShipState(root, 7)!)).toBe(true);
      const path = shipStatePath(root, 7);
      const edited = { ...JSON.parse(readFileSync(path, 'utf8')), implementer: 'someone-else' };
      writeFileSync(path, JSON.stringify(edited, null, 2));
      expect(verifyShipIntegrity(readShipState(root, 7)!)).toBe(false);
      expect(() => updateShipState(root, 7, (s) => s!)).toThrow(/integrity check/);
      // Owner-only path (init --force with OMG_SHIP_HUMAN=1) may replace it.
      expect(verifyShipIntegrity(updateShipState(root, 7, () => fresh(), { allowUnverified: true }))).toBe(true);
    });

    it('rejects malformed state files with ShipStateError', () => {
      updateShipState(root, 7, () => fresh());
      const path = shipStatePath(root, 7);
      const good = JSON.parse(readFileSync(path, 'utf8'));
      const cases: Array<[unknown, RegExp]> = [
        ['not json', /not valid JSON/],
        [JSON.stringify({ ...good, phase: 'shipped' }), /field phase/],
        [JSON.stringify({ ...good, verdicts: [{ reviewer: 'v', verdict: 'approve', sha: 'abc', at: T }] }), /field verdicts/],
        [JSON.stringify({ ...good, housekeepingCommits: 'x' }), /field housekeepingCommits/],
        [JSON.stringify({ ...good, reruns: { 1: 'many' } }), /field reruns/],
        [JSON.stringify({ ...good, implementer: 7 }), /field implementer/],
        [JSON.stringify({ ...good, history: [{ at: T, from: null, to: 'shipped', note: 'x' }] }), /field history/],
        [JSON.stringify({ ...good, history: ['x'] }), /field history/],
        [JSON.stringify({ ...good, previousRuns: ['x'] }), /field previousRuns/],
        [JSON.stringify({ ...good, previousRuns: [{ ...good, fixRounds: -1 }] }), /field previousRuns/],
        [JSON.stringify({ ...good, previousRuns: [{ ...good, pr: 8 }] }), /field previousRuns/],
      ];
      for (const [content, pattern] of cases) {
        writeFileSync(path, content as string);
        expect(() => readShipState(root, 7)).toThrow(ShipStateError);
        expect(() => readShipState(root, 7)).toThrow(pattern);
      }
    });

    it('refuses a repoRoot that is not a git work tree', () => {
      const plain = mkdtempSync(join(tmpdir(), 'omg-ship-nogit-'));
      try {
        expect(() => updateShipState(plain, 7, () => fresh())).toThrow(/not a git work tree/);
      } finally {
        rmSync(plain, { recursive: true, force: true });
      }
    });
  });
});
