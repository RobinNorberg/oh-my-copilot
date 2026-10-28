import { describe, expect, it } from 'vitest';
import { guardExec, type Exec, type ExecResult } from '../exec.js';
import { evaluateChecks, type GateReport } from '../gates.js';
import { decideMerge, mergeCommand, protectedChanges, type PrView } from '../merge.js';
import { INVENTORY_COMMIT_MESSAGE, INVENTORY_SCRIPT, runPrepare, selectGeneratorChecks, selectTargetedTests } from '../prepare.js';
import { createShipState, recordVerdict, sealShipState, transition, type ShipState } from '../state.js';
import { resolveShipConfig } from '../config.js';

const NODE = process.execPath;
const T = '2026-10-11T00:00:00.000Z';
/** The sha the reviewer approved; the fake repo's HEAD contains it unless overridden. */
const REVIEWED_SHA = 'a'.repeat(40);
/** GitHub's base sha; the fake repo's refs/remotes/origin/dev resolves to it. */
const BASE_SHA = 'd'.repeat(40);
const REPO_URL = 'https://github.com/o/r';
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
          if (r.status === 0 && (key.startsWith('git commit') || key.startsWith('git merge --no-ff'))) headN += 1;
          return r;
        }
      }
    }
    if (key === 'git rev-parse --abbrev-ref HEAD') return res(0, 'feat/x\n');
    if (key.startsWith('git rev-parse -q --verify')) return res(1);
    if (key.startsWith('git rev-parse --git-path')) return res(0, `.git/${args[2]}\n`);
    if (key === 'git rev-parse HEAD') return res(0, `${head()}\n`);
    if (key === 'git remote get-url origin') return res(0, 'git@github.com:o/r.git\n');
    if (key === 'git rev-parse --verify refs/remotes/origin/dev') return res(0, `${BASE_SHA}\n`);
    if (key === `git merge-base --is-ancestor ${REVIEWED_SHA} HEAD`) return res(0);
    if (key.startsWith('git merge-base --is-ancestor')) return res(1);
    if (key.startsWith('git merge --no-ff') || key.startsWith('git commit')) { headN += 1; return res(0); }
    if (key.startsWith(`git diff --name-only ${BASE_SHA}...HEAD`)) return res(0, 'src/ship/gates.ts\nskills/ship/SKILL.md\n');
    if (key === 'git diff --cached --quiet -- inventory') return res(1);
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
  const base = { cwd: '/repo', base: 'dev', branch: 'feat/x', reviewedSha: REVIEWED_SHA, baseSha: BASE_SHA, repoUrl: REPO_URL, node: NODE, exists };

  it('merges the base, runs checks, and regenerates the inventory as the last commit', () => {
    const { exec, calls } = fakeRepo({ [`node ${INVENTORY_SCRIPT} --verify`]: (() => { let n = 0; return () => res(n++ === 0 ? 1 : 0); })() });
    const r = runPrepare({ ...base, exec });
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => `${s.name}:${s.status}`)).toEqual([
      'preflight:ok', 'fetch:ok', 'merge-base:ok', 'tsc:ok', 'lint:ok', 'tests:ok', 'generate-prompt-projections.mjs:ok', 'inventory:ok',
    ]);
    expect(r.housekeepingCommits).toHaveLength(2);
    expect(calls).toContain(`git merge --no-ff --no-edit --no-verify ${BASE_SHA}`);
    expect(calls.indexOf('git remote get-url origin')).toBeLessThan(calls.indexOf('git fetch origin dev'));
    expect(calls).toContain(`git merge-base --is-ancestor ${REVIEWED_SHA} HEAD`);
    expect(calls).toContain(`git commit --no-verify -m ${INVENTORY_COMMIT_MESSAGE} -- inventory`);
    // inventory commit is the last write; nothing commits after it
    const lastCommit = calls.map((c, i) => [c, i] as const).filter(([c]) => c.startsWith('git commit') || c.startsWith('git merge --no-ff')).pop()!;
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
      'git merge --no-ff --no-edit': res(1, '', 'CONFLICT (content): Merge conflict in inventory/inventory-graph.json'),
      'git diff --name-only --diff-filter=U': res(0, 'inventory/inventory-graph.json\n'),
      [`node ${INVENTORY_SCRIPT} --verify`]: (() => { let n = 0; return () => res(n++ === 0 ? 1 : 0); })(),
    });
    const r = runPrepare({ ...base, exec, checks: false });
    expect(r.ok).toBe(true);
    const order = ['git checkout --theirs -- inventory', 'git add -- inventory', 'git commit --no-edit --no-verify', `node ${INVENTORY_SCRIPT} --write`];
    const idx = order.map((c) => calls.indexOf(c));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it('stops on conflicts outside inventory/ and leaves them for a fix lane', () => {
    const { exec, calls } = fakeRepo({
      'git merge --no-ff --no-edit': res(1, '', 'CONFLICT'),
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
    ['a cherry-pick in progress', { 'git rev-parse -q --verify CHERRY_PICK_HEAD': res(0, 'abc\n') }, /cherry-pick is in progress/],
    ['a revert in progress', { 'git rev-parse -q --verify REVERT_HEAD': res(0, 'abc\n') }, /revert is in progress/],
    ['a dirty tree', { 'git status --porcelain': res(0, ' M src/a.ts\n') }, /uncommitted/],
    ['staged changes in the index', { 'git diff --cached --quiet': res(1) }, /index has staged changes/],
    ['a branch other than the run\'s PR branch', { 'git rev-parse --abbrev-ref HEAD': res(0, 'feat/other\n') }, /ship run is for feat\/x/],
    ['a HEAD without the reviewed commit', { [`git merge-base --is-ancestor ${REVIEWED_SHA} HEAD`]: res(1) }, /does not contain the reviewed commit/],
    ['a base git rejects', { 'git check-ref-format --branch dev': res(1) }, /base "dev" is not a valid branch name/],
  ])('preflight refuses %s', (_label, overrides, pattern) => {
    const { exec, calls } = fakeRepo(overrides as Record<string, ExecResult>);
    const r = runPrepare({ ...base, exec });
    expect(r.ok).toBe(false);
    expect(r.blockedReason).toMatch(pattern);
    expect(calls.some((c) => c.startsWith('git fetch'))).toBe(false);
  });

  it.each([
    ['base', { base: '--upload-pack=touch /tmp/pwned' }],
    ['base', { base: '-dev' }],
    ['branch', { branch: '--upload-pack=x' }],
    ['reviewed sha', { reviewedSha: '--upload-pack=x' }],
    ['remote', { remote: '--upload-pack=x' }],
  ])('preflight refuses an option-shaped %s before spawning git with it', (label, patch) => {
    const { exec, calls } = fakeRepo();
    const r = runPrepare({ ...base, exec, ...patch });
    expect(r.ok).toBe(false);
    expect(r.blockedReason).toContain(label);
    expect(calls.some((c) => c.includes('--upload-pack') || c.startsWith('git fetch'))).toBe(false);
  });

  it('preflight refuses a rebase in progress', () => {
    const { exec } = fakeRepo();
    const r = runPrepare({ ...base, exec, exists: () => true });
    expect(r.blockedReason).toMatch(/rebase is in progress/);
  });

  it('a failing git add of the inventory stops before committing', () => {
    const { exec, calls } = fakeRepo({
      'git merge-base --is-ancestor': res(0),
      [`node ${INVENTORY_SCRIPT} --verify`]: res(1),
      'git add -- inventory': res(128, '', 'fatal: index.lock exists'),
    });
    const r = runPrepare({ ...base, exec, checks: false });
    expect(r.ok).toBe(false);
    expect(r.blockedReason).toMatch(/inventory: git add -- inventory/);
    expect(calls.some((c) => c.startsWith('git commit'))).toBe(false);
  });

  it.each<[string, Record<string, ExecResult>, RegExp, Partial<typeof base>?]>([
    ['a remote pointing at another repository', { 'git remote get-url origin': res(0, 'https://github.com/evil/r.git\n') }, /remote: remote origin points at https:\/\/github.com\/evil\/r.git, but the PR is in https:\/\/github.com\/o\/r/],
    ['a local-path remote', { 'git remote get-url origin': res(0, 'C:\\tmp\\o\\r\n') }, /remote: remote origin points at/],
    ['no repository url from GitHub', {}, /remote: GitHub reported no repository url/, { repoUrl: undefined }],
    ['a fetched base that is not GitHub\'s base sha', { 'git rev-parse --verify refs/remotes/origin/dev': res(0, `${'e'.repeat(40)}\n`) }, /fetch: refs\/remotes\/origin\/dev is e{40}, but GitHub reports dev at d{40}/],
    ['a missing remote-tracking ref', { 'git rev-parse --verify refs/remotes/origin/dev': res(128, '', 'fatal: Needed a single revision') }, /fetch: refs\/remotes\/origin\/dev is missing/],
    ['a base sha that is not a full sha', {}, /preflight: GitHub's base sha "origin\/dev"/, { baseSha: 'origin/dev' }],
  ])('refuses %s before merging anything', (_label, overrides, pattern, patch = {}) => {
    const { exec, calls } = fakeRepo(overrides);
    const r = runPrepare({ ...base, exec, checks: false, ...patch });
    expect(r.ok).toBe(false);
    expect(r.blockedReason).toMatch(pattern);
    expect(calls.some((c) => c.startsWith('git merge ') || c.startsWith('git commit'))).toBe(false);
  });

  it('push is plain and targets the run\'s PR branch', () => {
    const { exec, calls } = fakeRepo({ 'git merge-base --is-ancestor': res(0) });
    expect(runPrepare({ ...base, exec, checks: false, push: true }).ok).toBe(true);
    expect(calls).toContain('git push origin HEAD:refs/heads/feat/x');
  });
});

describe('decideMerge', () => {
  const HEAD = 'b'.repeat(40);
  const REVIEWED = 'a'.repeat(40);
  const INV = 'c'.repeat(40);
  const config = resolveShipConfig({ requiredChecks: ['Test'] });
  const green: GateReport = evaluateChecks(9, [{ name: 'Test', state: 'SUCCESS' }, { name: 'No Committed Build Artifacts', state: 'FAILURE' }], config);
  const pr: PrView = { number: 9, state: 'OPEN', isDraft: false, baseRefName: 'dev', headRefOid: HEAD };

  /** The head is the engine's inventory commit right after the reviewed sha. */
  const HK = [{ sha: HEAD, parents: [REVIEWED] }];
  const NONE: ReadonlySet<string> = new Set();
  /** Every housekeeping sha these tests use changes only inventory/. */
  const CLEAN: ReadonlyMap<string, string | null> = new Map([[HEAD, null], [INV, null]]);

  function approved(sha = REVIEWED, housekeeping: string[] = [HEAD]): ShipState {
    let s = createShipState({ pr: 9, base: 'dev', implementer: 'executor-1', maxFixRounds: 2 }, T);
    s = recordVerdict(s, { reviewer: 'verifier-1', verdict: 'approve', sha, at: T });
    s = transition({ ...s, housekeepingCommits: housekeeping }, 'gates', 'prepared', T);
    return sealShipState(transition(s, 'ready', 'green', T));
  }

  it('refuses a state that fails its integrity check (hand-edited or unsealed)', () => {
    const edited = { ...approved(), housekeepingCommits: [HEAD, INV] };
    expect(decideMerge({ state: edited, pr, gate: green, changedFiles: [], commitsSinceReview: HK, baseHistory: NONE, housekeepingContent: CLEAN }).reasons.join()).toMatch(/integrity check/);
    const { integrity: _drop, ...unsealed } = approved();
    expect(decideMerge({ state: unsealed, pr, gate: green, changedFiles: [], commitsSinceReview: HK, baseHistory: NONE, housekeepingContent: CLEAN }).reasons.join()).toMatch(/integrity check/);
  });

  it('is ready when gates are green and only housekeeping follows the reviewed sha', () => {
    const d = decideMerge({ state: approved(), pr, gate: green, changedFiles: [], commitsSinceReview: HK, baseHistory: NONE, housekeepingContent: CLEAN });
    expect(d).toEqual({ ok: true, reasons: [], command: mergeCommand(9, HEAD) });
    expect(d.command).toEqual(['gh', 'pr', 'merge', '9', '--admin', '--merge', '--match-head-commit', HEAD]);
  });

  it('accepts a verdict on the exact head', () => {
    expect(decideMerge({ state: approved(HEAD, []), pr, gate: green, changedFiles: [], commitsSinceReview: [], baseHistory: NONE, housekeepingContent: CLEAN }).ok).toBe(true);
  });

  it('refuses unreviewed commits after the verdict', () => {
    const since = [{ sha: HEAD, parents: [INV] }, { sha: INV, parents: [REVIEWED] }];
    const d = decideMerge({ state: approved(REVIEWED, [INV]), pr, gate: green, changedFiles: [], commitsSinceReview: since, baseHistory: NONE, housekeepingContent: CLEAN });
    expect(d.ok).toBe(false);
    expect(d.reasons.join()).toMatch(/re-review needed\): bbbbbbbbbbbb$/);
  });

  it('accepts a housekeeping merge only when its second parent is in GitHub\'s current base history', () => {
    const BASE_TIP = 'e'.repeat(40);
    const since = [{ sha: HEAD, parents: [INV] }, { sha: INV, parents: [REVIEWED, BASE_TIP] }];
    const state = approved(REVIEWED, [INV, HEAD]);
    expect(decideMerge({ state, pr, gate: green, changedFiles: [], commitsSinceReview: since, baseHistory: new Set([BASE_TIP]), housekeepingContent: CLEAN }).ok).toBe(true);
    const forged = decideMerge({ state, pr, gate: green, changedFiles: [], commitsSinceReview: since, baseHistory: NONE, housekeepingContent: CLEAN });
    expect(forged.ok).toBe(false);
    expect(forged.reasons.join()).toMatch(/housekeeping merge cccccccccccc brings in eeeeeeeeeeee, which is not in GitHub's base history \(re-review needed\)/);
    // An octopus merge is never a ship merge, even with every parent in the base.
    const octopus = [{ sha: HEAD, parents: [REVIEWED, BASE_TIP, INV] }];
    expect(decideMerge({ state: approved(), pr, gate: green, changedFiles: [], commitsSinceReview: octopus, baseHistory: new Set([BASE_TIP, INV]), housekeepingContent: CLEAN }).reasons.join())
      .toMatch(/has 3 parents; not a ship merge/);
  });

  it('refuses a housekeeping commit whose content is not inventory-only, or was not checked', () => {
    const bad = decideMerge({
      state: approved(), pr, gate: green, changedFiles: [], commitsSinceReview: HK, baseHistory: NONE,
      housekeepingContent: new Map([[HEAD, 'it changes files outside inventory/: src/evil.ts']]),
    });
    expect(bad.ok).toBe(false);
    expect(bad.reasons.join()).toMatch(/housekeeping commit bbbbbbbbbbbb is not inventory-only: it changes files outside inventory\/: src\/evil.ts \(re-review needed\)/);
    const unchecked = decideMerge({ state: approved(), pr, gate: green, changedFiles: [], commitsSinceReview: HK, baseHistory: NONE, housekeepingContent: new Map() });
    expect(unchecked.reasons.join()).toMatch(/bbbbbbbbbbbb is not inventory-only: its content was not checked/);
  });

  it('refuses when the first-parent chain does not lead from the head back to the reviewed sha', () => {
    for (const since of [[{ sha: HEAD, parents: [INV] }], [{ sha: INV, parents: [REVIEWED] }], []]) {
      const d = decideMerge({ state: approved(REVIEWED, [HEAD, INV]), pr, gate: green, changedFiles: [], commitsSinceReview: since, baseHistory: NONE, housekeepingContent: CLEAN });
      expect(d.reasons.join()).toMatch(/first-parent chain does not lead back to the reviewed sha/);
    }
  });

  it('refuses when the reviewed sha is not an ancestor', () => {
    expect(decideMerge({ state: approved(), pr, gate: green, changedFiles: [], commitsSinceReview: null, baseHistory: NONE, housekeepingContent: CLEAN }).reasons.join()).toMatch(/not an ancestor/);
  });

  it('refuses without any verdict, or with changes requested last', () => {
    const fresh = createShipState({ pr: 9, base: 'dev', implementer: 'executor-1', maxFixRounds: 2 }, T);
    expect(decideMerge({ state: fresh, pr, gate: green, changedFiles: [], commitsSinceReview: [], baseHistory: NONE, housekeepingContent: CLEAN }).reasons.join()).toMatch(/no independent verifier verdict/);
    const changes = recordVerdict(approved(), { reviewer: 'verifier-1', verdict: 'changes-requested', sha: REVIEWED, at: T });
    expect(decideMerge({ state: changes, pr, gate: green, changedFiles: [], commitsSinceReview: [], baseHistory: NONE, housekeepingContent: CLEAN }).reasons.join()).toMatch(/changes-requested/);
  });

  it('refuses a self-approval even if one was written into the state by hand', () => {
    const s = approved();
    const forged = { ...s, verdicts: [{ ...s.verdicts[0], reviewer: 'EXECUTOR-1' }] };
    expect(decideMerge({ state: forged, pr, gate: green, changedFiles: [], commitsSinceReview: HK, baseHistory: NONE, housekeepingContent: CLEAN }).reasons.join()).toMatch(/self-approval/);
  });

  it('refuses on pending / failed gates, drafts, closed PRs and a base mismatch', () => {
    const pending = evaluateChecks(9, [{ name: 'Test', state: 'IN_PROGRESS' }], config);
    expect(decideMerge({ state: approved(), pr, gate: pending, changedFiles: [], commitsSinceReview: HK, baseHistory: NONE, housekeepingContent: CLEAN }).reasons.join()).toMatch(/gates are pending \(pending: Test\)/);
    const reasons = decideMerge({ state: approved(), pr: { ...pr, isDraft: true, state: 'CLOSED', baseRefName: 'main' }, gate: green, changedFiles: [], commitsSinceReview: HK, baseHistory: NONE, housekeepingContent: CLEAN }).reasons;
    expect(reasons).toEqual(expect.arrayContaining([expect.stringMatching(/draft/), expect.stringMatching(/CLOSED/), expect.stringMatching(/base is main/)]));
  });

  it('refuses a PR touching the merge-rule files unless the owner overrides (OMG_SHIP_HUMAN=1)', () => {
    for (const file of ['.copilot/omg.jsonc', '.copilot/omc.jsonc', '.github/known-flaky-tests.json', '.github/workflows/ci.yml', '.GitHub/Workflows/new.yml']) {
      const d = decideMerge({ state: approved(), pr, gate: green, changedFiles: ['src/a.ts', file], commitsSinceReview: HK, baseHistory: NONE, housekeepingContent: CLEAN });
      expect(d.ok).toBe(false);
      expect(d.reasons.join()).toMatch(/touches merge-rule files .*only the owner may merge it \(OMG_SHIP_HUMAN=1\)/);
      expect(decideMerge({ state: approved(), pr, gate: green, changedFiles: [file], commitsSinceReview: HK, baseHistory: NONE, housekeepingContent: CLEAN, humanOverride: true }).ok).toBe(true);
    }
    expect(protectedChanges(['.github/workflowsX.yml', '.copilot/omg.jsonc.bak', 'docs/.github/workflows/x.yml'])).toEqual([]);
    expect(protectedChanges(['ci/flaky.json'], ['ci/flaky.json'])).toEqual(['ci/flaky.json']);
    // Win32 resolves trailing dots and spaces away; a bare directory, 8.3 short names, streams and `..` fail closed.
    const bypasses = ['.github/workflows./ci.yml', '.copilot/omg.jsonc.', '.copilot/omg.jsonc ', '.github./known-flaky-tests.json', '.github/workflows', '.GITHUB/Workflows',
      './.github/workflows/ci.yml', '.github\\workflows\\ci.yml', '.github/WORKFL~1/ci.yml', '.copilot/omg.jsonc::$DATA', 'src/../.github/workflows/ci.yml'];
    expect(protectedChanges(bypasses)).toEqual(bypasses);
    // An unreadable diff fails closed.
    expect(decideMerge({ state: approved(), pr, gate: green, changedFiles: null, commitsSinceReview: HK, baseHistory: NONE, housekeepingContent: CLEAN }).reasons.join()).toMatch(/could not list the PR's changed files/);
  });

  it('refuses before prepare ran', () => {
    let s = createShipState({ pr: 9, base: 'dev', implementer: 'executor-1', maxFixRounds: 2 }, T);
    s = recordVerdict(s, { reviewer: 'verifier-1', verdict: 'approve', sha: HEAD, at: T });
    expect(decideMerge({ state: s, pr, gate: green, changedFiles: [], commitsSinceReview: [], baseHistory: NONE, housekeepingContent: CLEAN }).reasons.join()).toMatch(/phase is prepare/);
  });
});
