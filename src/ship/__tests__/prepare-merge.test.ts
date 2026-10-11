import { describe, expect, it } from 'vitest';
import { guardExec, type Exec, type ExecResult } from '../exec.js';
import { evaluateChecks, type GateReport } from '../gates.js';
import { decideMerge, mergeCommand, type PrView } from '../merge.js';
import { INVENTORY_COMMIT_MESSAGE, INVENTORY_SCRIPT, runPrepare, selectGeneratorChecks, selectTargetedTests } from '../prepare.js';
import { createShipState, recordVerdict, transition, type ShipState } from '../state.js';
import { resolveShipConfig } from '../config.js';

const NODE = 'node-bin';
const T = '2026-10-11T00:00:00.000Z';
const res = (status: number, stdout = '', stderr = ''): ExecResult => ({ status, stdout, stderr });

type Responder = (args: string[]) => ExecResult | undefined;

/**
 * Scripted repo: answers git / node calls from a table, falling back to
 * success; HEAD advances on every commit or merge so housekeeping shas differ.
 */
function fakeRepo(overrides: Record<string, ExecResult | Responder> = {}) {
  const calls: string[] = [];
  let headN = 0;
  const head = () => `${'0'.repeat(39)}${headN}`;
  const exec: Exec = (cmd, args) => {
    const key = `${cmd === NODE ? 'node' : cmd} ${args.join(' ')}`;
    calls.push(key);
    for (const [prefix, answer] of Object.entries(overrides)) {
      if (key.startsWith(prefix)) {
        const r = typeof answer === 'function' ? answer(args) : answer;
        if (r) {
          if (r.status === 0 && (key.startsWith('git commit') || key.startsWith('git merge --no-edit'))) headN += 1;
          return r;
        }
      }
    }
    if (key === 'git rev-parse --abbrev-ref HEAD') return res(0, 'feat/x\n');
    if (key === 'git rev-parse -q --verify MERGE_HEAD') return res(1);
    if (key.startsWith('git rev-parse --git-path')) return res(0, `.git/${args[2]}\n`);
    if (key === 'git rev-parse HEAD') return res(0, `${head()}\n`);
    if (key.startsWith('git merge-base --is-ancestor')) return res(1);
    if (key.startsWith('git merge --no-edit') || key.startsWith('git commit')) { headN += 1; return res(0); }
    if (key.startsWith('git diff --name-only origin/dev...HEAD')) return res(0, 'src/ship/gates.ts\nskills/ship/SKILL.md\n');
    if (key.startsWith('git diff --cached --quiet')) return res(1);
    return res(0);
  };
  return { exec: guardExec(exec), calls };
}

const exists = (p: string) => !p.replace(/\\/g, '/').includes('.git/rebase') && !p.includes('missing');

describe('selectTargetedTests', () => {
  it('maps sources to sibling and __tests__ tests, keeps changed tests, adds the skills suite', () => {
    const present = new Set([
      'src/ship/__tests__/gates.test.ts',
      'src/lib/file-lock.test.ts',
      'src/__tests__/skills.test.ts',
      'tests/integration/x.test.ts',
    ]);
    const picked = selectTargetedTests(
      ['src/ship/gates.ts', 'src\\lib\\file-lock.ts', 'skills/ship/SKILL.md', 'tests/integration/x.test.ts', 'src/types.d.ts', 'docs/x.md', 'src/none.ts'],
      (p) => present.has(p),
    );
    expect(picked).toEqual(['src/__tests__/skills.test.ts', 'src/lib/file-lock.test.ts', 'src/ship/__tests__/gates.test.ts', 'tests/integration/x.test.ts']);
  });

  it('generator checks follow their inputs', () => {
    expect(selectGeneratorChecks(['src/a.ts'])).toEqual([]);
    expect(selectGeneratorChecks(['skills/ship/SKILL.md'])).toEqual([['scripts/generate-prompt-projections.mjs', '--verify']]);
    expect(selectGeneratorChecks(['agents/executor.md']).map((a) => a[0])).toEqual(['scripts/generate-prompt-projections.mjs', 'scripts/copilot/build-agents.mjs']);
    expect(selectGeneratorChecks(['hooks/hooks.json']).map((a) => a[0])).toEqual(['scripts/copilot/build-hooks.mjs']);
  });
});

describe('runPrepare', () => {
  const base = { cwd: '/repo', base: 'dev', node: NODE, exists };

  it('merges the base, runs checks, and regenerates the inventory as the last commit', () => {
    const { exec, calls } = fakeRepo({ [`node ${INVENTORY_SCRIPT} --verify`]: (() => { let n = 0; return () => res(n++ === 0 ? 1 : 0); })() });
    const r = runPrepare({ ...base, exec });
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => `${s.name}:${s.status}`)).toEqual([
      'preflight:ok', 'fetch:ok', 'merge-base:ok', 'tsc:ok', 'lint:ok', 'tests:ok', 'generate-prompt-projections.mjs:ok', 'inventory:ok',
    ]);
    expect(r.housekeepingCommits).toHaveLength(2);
    expect(calls).toContain('git merge --no-edit origin/dev');
    expect(calls).toContain(`git commit -m ${INVENTORY_COMMIT_MESSAGE}`);
    // inventory commit is the last write; nothing commits after it
    const lastCommit = calls.map((c, i) => [c, i] as const).filter(([c]) => c.startsWith('git commit') || c.startsWith('git merge --no-edit')).pop()!;
    expect(lastCommit[0]).toContain(INVENTORY_COMMIT_MESSAGE);
    expect(calls.some((c) => c.startsWith('git rebase') || c.includes('--force'))).toBe(false);
    expect(calls).toContain('node node_modules/eslint/bin/eslint.js src/ship/gates.ts');
    const vitest = calls.find((c) => c.startsWith('node node_modules/vitest/vitest.mjs run '))!;
    expect(vitest).toContain(' src/__tests__/skills.test.ts');
    expect(vitest).toContain(' src/ship/__tests__/gates.test.ts');
  });

  it('skips the merge when the base is already contained and the inventory when current', () => {
    const { exec, calls } = fakeRepo({ 'git merge-base --is-ancestor': res(0) });
    const r = runPrepare({ ...base, exec, checks: false });
    expect(r.ok).toBe(true);
    expect(r.housekeepingCommits).toEqual([]);
    expect(r.steps.find((s) => s.name === 'merge-base')?.status).toBe('skipped');
    expect(r.steps.find((s) => s.name === 'inventory')?.status).toBe('skipped');
    expect(calls.some((c) => c.startsWith('git commit'))).toBe(false);
  });

  it('resolves a sibling-PR inventory-only conflict with --theirs, then regenerates', () => {
    const { exec, calls } = fakeRepo({
      'git merge --no-edit': res(1, '', 'CONFLICT (content): Merge conflict in inventory/inventory-graph.json'),
      'git diff --name-only --diff-filter=U': res(0, 'inventory/inventory-graph.json\n'),
      [`node ${INVENTORY_SCRIPT} --verify`]: (() => { let n = 0; return () => res(n++ === 0 ? 1 : 0); })(),
    });
    const r = runPrepare({ ...base, exec, checks: false });
    expect(r.ok).toBe(true);
    const order = ['git checkout --theirs -- inventory', 'git add -- inventory', 'git commit --no-edit', `node ${INVENTORY_SCRIPT} --write`];
    const idx = order.map((c) => calls.indexOf(c));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it('stops on conflicts outside inventory/ and leaves them for a fix lane', () => {
    const { exec, calls } = fakeRepo({
      'git merge --no-edit': res(1, '', 'CONFLICT'),
      'git diff --name-only --diff-filter=U': res(0, 'inventory/inventory-graph.json\nsrc/cli/index.ts\n'),
    });
    const r = runPrepare({ ...base, exec });
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual(['inventory/inventory-graph.json', 'src/cli/index.ts']);
    expect(r.blockedReason).toMatch(/merge-base/);
    expect(calls.some((c) => c.startsWith('git checkout --theirs'))).toBe(false);
    expect(calls.some((c) => c.includes('tsc'))).toBe(false);
  });

  it('a failing check stops before the inventory commit', () => {
    const { exec, calls } = fakeRepo({ 'node node_modules/typescript/bin/tsc': res(2, 'error TS2304') });
    const r = runPrepare({ ...base, exec });
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)).toMatchObject({ name: 'tsc', status: 'failed' });
    expect(calls.some((c) => c.includes(INVENTORY_SCRIPT))).toBe(false);
  });

  it.each([
    ['detached HEAD', { 'git rev-parse --abbrev-ref HEAD': res(0, 'HEAD\n') }, /detached/],
    ['the base branch itself', { 'git rev-parse --abbrev-ref HEAD': res(0, 'dev\n') }, /refusing to prepare on dev/],
    ['a merge in progress', { 'git rev-parse -q --verify MERGE_HEAD': res(0, 'abc\n') }, /merge is in progress/],
    ['a dirty tree', { 'git status --porcelain': res(0, ' M src/a.ts\n') }, /uncommitted/],
  ])('preflight refuses %s', (_label, overrides, pattern) => {
    const { exec, calls } = fakeRepo(overrides as Record<string, ExecResult>);
    const r = runPrepare({ ...base, exec });
    expect(r.ok).toBe(false);
    expect(r.blockedReason).toMatch(pattern);
    expect(calls.some((c) => c.startsWith('git fetch'))).toBe(false);
  });

  it('preflight refuses a rebase in progress', () => {
    const { exec } = fakeRepo();
    const r = runPrepare({ ...base, exec, exists: () => true });
    expect(r.blockedReason).toMatch(/rebase is in progress/);
  });

  it('push is plain', () => {
    const { exec, calls } = fakeRepo({ 'git merge-base --is-ancestor': res(0) });
    expect(runPrepare({ ...base, exec, checks: false, push: true }).ok).toBe(true);
    expect(calls).toContain('git push origin HEAD:refs/heads/feat/x');
  });
});

describe('decideMerge', () => {
  const HEAD = 'b'.repeat(40);
  const REVIEWED = 'a'.repeat(40);
  const INV = 'c'.repeat(40);
  const config = resolveShipConfig(undefined);
  const green: GateReport = evaluateChecks(9, [{ name: 'Test', state: 'SUCCESS' }, { name: 'No Committed Build Artifacts', state: 'FAILURE' }], config);
  const pr: PrView = { number: 9, state: 'OPEN', isDraft: false, baseRefName: 'dev', headRefOid: HEAD };

  function approved(sha = REVIEWED, housekeeping: string[] = [INV]): ShipState {
    let s = createShipState({ pr: 9, base: 'dev', implementer: 'executor-1', maxFixRounds: 2 }, T);
    s = recordVerdict(s, { reviewer: 'verifier-1', verdict: 'approve', sha, at: T });
    s = transition({ ...s, housekeepingCommits: housekeeping }, 'gates', 'prepared', T);
    return transition(s, 'ready', 'green', T);
  }

  it('is ready when gates are green and only housekeeping follows the reviewed sha', () => {
    const d = decideMerge({ state: approved(), pr, gate: green, commitsSinceReview: [INV] });
    expect(d).toEqual({ ok: true, reasons: [], command: mergeCommand(9, HEAD) });
    expect(d.command).toEqual(['gh', 'pr', 'merge', '9', '--admin', '--merge', '--match-head-commit', HEAD]);
  });

  it('accepts a verdict on the exact head', () => {
    expect(decideMerge({ state: approved(HEAD, []), pr, gate: green, commitsSinceReview: [] }).ok).toBe(true);
  });

  it('refuses unreviewed commits after the verdict', () => {
    const d = decideMerge({ state: approved(), pr, gate: green, commitsSinceReview: [HEAD, INV] });
    expect(d.ok).toBe(false);
    expect(d.reasons.join()).toMatch(/re-review needed\): bbbbbbbbbbbb$/);
  });

  it('refuses when the reviewed sha is not an ancestor', () => {
    expect(decideMerge({ state: approved(), pr, gate: green, commitsSinceReview: null }).reasons.join()).toMatch(/not an ancestor/);
  });

  it('refuses without any verdict, or with changes requested last', () => {
    const fresh = createShipState({ pr: 9, base: 'dev', implementer: 'executor-1', maxFixRounds: 2 }, T);
    expect(decideMerge({ state: fresh, pr, gate: green, commitsSinceReview: [] }).reasons.join()).toMatch(/no independent verifier verdict/);
    const changes = recordVerdict(approved(), { reviewer: 'verifier-1', verdict: 'changes-requested', sha: REVIEWED, at: T });
    expect(decideMerge({ state: changes, pr, gate: green, commitsSinceReview: [] }).reasons.join()).toMatch(/changes-requested/);
  });

  it('refuses a self-approval even if one was written into the state by hand', () => {
    const s = approved();
    const forged = { ...s, verdicts: [{ ...s.verdicts[0], reviewer: 'EXECUTOR-1' }] };
    expect(decideMerge({ state: forged, pr, gate: green, commitsSinceReview: [INV] }).reasons.join()).toMatch(/self-approval/);
  });

  it('refuses on pending / failed gates, drafts, closed PRs and a base mismatch', () => {
    const pending = evaluateChecks(9, [{ name: 'Test', state: 'IN_PROGRESS' }], config);
    expect(decideMerge({ state: approved(), pr, gate: pending, commitsSinceReview: [INV] }).reasons.join()).toMatch(/gates are pending \(pending: Test\)/);
    const reasons = decideMerge({ state: approved(), pr: { ...pr, isDraft: true, state: 'CLOSED', baseRefName: 'main' }, gate: green, commitsSinceReview: [INV] }).reasons;
    expect(reasons).toEqual(expect.arrayContaining([expect.stringMatching(/draft/), expect.stringMatching(/CLOSED/), expect.stringMatching(/base is main/)]));
  });

  it('refuses before prepare ran', () => {
    let s = createShipState({ pr: 9, base: 'dev', implementer: 'executor-1', maxFixRounds: 2 }, T);
    s = recordVerdict(s, { reviewer: 'verifier-1', verdict: 'approve', sha: HEAD, at: T });
    expect(decideMerge({ state: s, pr, gate: green, commitsSinceReview: [] }).reasons.join()).toMatch(/phase is prepare/);
  });
});
