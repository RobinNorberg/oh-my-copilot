/**
 * `omg factory board` on GitHub (a scripted gh + git): the join of check
 * buckets, run states and progress labels; the drift / unsynced / seal /
 * stale flags; the `--json` schema; and the read guard, which refuses every
 * write before it reaches gh.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { factoryCommand } from '../../../cli/commands/factory.js';
import { factoryBoardCommand } from '../../../cli/commands/factory-board.js';
import { createForge } from '../../../forge/index.js';
import type { ForgeFactory } from '../../../forge/types.js';
import { createShipState, recordVerdict, shipStatePath } from '../../../ship/state.js';
import type { Exec, ExecResult } from '../../../ship/exec.js';
import { CheckIncompatibleError } from '../../check/cli.js';
import { FactorySafetyError } from '../../run/exec.js';
import {
  computeFactoryIntegrity, createFactoryState, factoryStateDir, factoryStatePath, moveTo, runKeyOf, setGate, type FactoryHealRecord, type FactoryRunState,
} from '../../run/state.js';
import { BOARD_JSON_SCHEMA_VERSION, liveStage, runFactoryBoard, type BoardJson, type BoardRow, type FactoryBoardDeps, type FactoryBoardOptions } from '../collect.js';

const SHA = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const T0 = '2026-10-30T10:00:00.000Z';
const T1 = '2026-10-31T11:00:00.000Z';
const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const AC = '## Acceptance criteria\n- `omg x` exits 0\n';
const REPO = 'https://github.com/o/r';
const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });

interface Issue { title: string; body: string; labels?: string[] }

const ISSUES: Record<number, Issue> = {
  1: { title: 'ready one \u001b[2J\u0007', body: AC, labels: ['priority:p1'] },
  2: { title: 'no plan', body: 'just do it' },
  3: { title: 'building', body: AC, labels: ['factory:building'] },
  4: { title: 'parked at merge', body: AC, labels: ['factory:verifying'] },
  5: { title: 'blocked by #1', body: `${AC}\nDepends on #1\n`, labels: ['factory:building'] },
  6: { title: 'moved by a human', body: AC, labels: ['factory:building'] },
};

/** gh + git for the issues above; `calls` keeps every command that reached it. */
function scripted(issues: Record<number, Issue>, listed = Object.keys(issues).map(Number)) {
  const calls: string[] = [];
  const exec: Exec = (cmd, args) => {
    const a = args.join(' ');
    calls.push(`${cmd} ${a}`);
    if (cmd === 'git') {
      if (a === 'rev-parse --show-toplevel') return ok(`${root}\n`);
      if (a === 'remote get-url origin') return ok('https://github.com/o/r.git\n');
      if (a === 'fetch origin dev') return ok();
      if (a === 'rev-parse --verify refs/remotes/origin/dev') return ok(`${SHA}\n`);
      if (a === `cat-file -e ${SHA}^{commit}`) return ok();
      if (args[0] === 'ls-remote') return ok('');
      if (args[0] === 'show') return { status: 128, stdout: '', stderr: `fatal: path does not exist in '${SHA}'` };
    }
    if (cmd === 'gh') {
      if (args[0] === 'issue' && args[1] === 'list') return ok(JSON.stringify(listed.map((number) => ({ number }))));
      if (args[0] === 'issue' && args[1] === 'view') {
        const n = Number(args[2]);
        const i = issues[n];
        if (!i) return { status: 1, stdout: '', stderr: 'GraphQL: Could not resolve to an issue' };
        return ok(JSON.stringify({ title: i.title, body: i.body, state: 'OPEN', url: `${REPO}/issues/${n}`, author: { login: 'o' }, comments: [], labels: (i.labels ?? []).map((name) => ({ name })) }));
      }
      if (args[0] === 'pr' && args[1] === 'list') return ok('[]');
    }
    throw new Error(`unscripted ${cmd} ${a}`);
  };
  return { exec, calls };
}

let root: string;
let out: string[];
let err: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omg-board-'));
  // A git checkout, so the run and ship state live under it (outside a repository the state root climbs to the home directory).
  execFileSync('git', ['init', '-q', root]);
  if (!factoryStateDir(root).startsWith(root)) throw new Error(`state dir ${factoryStateDir(root)} is outside the test root`);
  out = [];
  err = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Progress sync on (a trusted user layer), so the factory:<stage> labels are the live stage. */
const PROGRESS_USER = { factory: { progress: { enabled: true } } };

function deps(exec: Exec, over: Partial<FactoryBoardDeps> = {}): FactoryBoardDeps {
  return {
    exec,
    base: () => 'dev',
    trustedUser: () => PROGRESS_USER,
    projectConfig: () => undefined,
    createForge,
    now: () => NOW,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  };
}

const board = (exec: Exec, o: FactoryBoardOptions = {}, over: Partial<FactoryBoardDeps> = {}) => runFactoryBoard(o, deps(exec, over));
const json = (): BoardJson => JSON.parse(out.join('\n')) as BoardJson;
const ids = (rows: readonly BoardRow[]) => rows.map((r) => r.id);
const column = (b: BoardJson, stage: string) => b.columns.find((c) => c.stage === stage)!;

function save(s: FactoryRunState, o: { seal?: boolean; tamper?: (s: FactoryRunState) => FactoryRunState } = {}): void {
  const sealed = o.seal === false ? s : { ...s, integrity: computeFactoryIntegrity(s) };
  const path = factoryStatePath(root, runKeyOf(s));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(o.tamper ? o.tamper(sealed) : sealed));
}

const issueRun = (issue: number, title: string) => ({ ...createFactoryState({ issue, repoUrl: REPO, base: 'dev' }, T0), forgeKind: 'github' as const, issueTitle: title });

const HEAL: FactoryHealRecord = {
  sig8: '0123abcd',
  class: 'test-failure',
  firstRed: { runId: '77', sha: SHA },
  failingTests: ['src/a.test.ts > b'],
  env: [],
  diagnosis: { class: 'test-failure', rootCause: 'a flaky clock', evidence: [], reproduced: false, fix: null },
};

/** The join matrix: one run per interesting state, plus runs outside the source. */
function seedRuns(): void {
  // #3: implementing with a running lane; untouched for 26 h (stale).
  save({
    ...moveTo(issueRun(3, 'building'), 'implement', 'plan ok', T0),
    trackerStage: 'building',
    lanes: [{ id: 'impl-3', kind: 'implement', startSha: SHA, status: 'running', maxCredits: 20, usage: { credits: 3.14159, premiumRequests: 1, source: 'measured' }, startedAt: T0 }],
  });
  // #4: parked at the merge gate; the last tracker write recorded verifying (unsynced).
  save({ ...setGate(moveTo(issueRun(4, 'parked at merge'), 'gates', 'gates', T1), 'merge', 'gates green; a human merges', T1), pr: 9, head: HEAD, trackerStage: 'verifying' });
  const ship = recordVerdict(createShipState({ pr: 9, base: 'dev', implementer: 'factory-4', maxFixRounds: 2 }, T0), { reviewer: 'reviewer-4', verdict: 'approve', sha: HEAD, at: T1 });
  mkdirSync(dirname(shipStatePath(root, 9)), { recursive: true });
  writeFileSync(shipStatePath(root, 9), JSON.stringify(ship));
  // #5: the engine's blocked-by intake gate; the state file was edited after its seal.
  save(setGate(issueRun(5, 'blocked by #1'), 'blocked-by', 'depends on unfinished item #1 (open, no factory PR merged into dev)', T1), {
    tamper: (s) => ({ ...s, gate: { ...s.gate!, reason: 'edited by hand' } }),
  });
  // #6: reviewing, but a human moved the card back (label factory:building): drift.
  save({ ...moveTo(issueRun(6, 'moved by a human'), 'review', 'pr open', T1), pr: 11, trackerStage: 'reviewing' });
  // Outside the source: an explicit-id run, a ci-heal run and a merged run (hidden).
  save(moveTo(issueRun(99, 'explicit id \u001b[31mred'), 'review', 'pr open', T1));
  save(moveTo({ ...createFactoryState({ issue: 0, repoUrl: REPO, base: 'dev', heal: HEAL }, T1), forgeKind: 'github' }, 'gates', 'gates', T1));
  save(moveTo(issueRun(98, 'merged long ago'), 'merged', 'human merged', T0));
}

describe('omg factory board on GitHub', () => {
  it('is registered under omg factory', () => {
    expect(factoryCommand().commands.map((c) => c.name())).toContain('board');
  });

  it('joins buckets, runs and live stages into columns and pins the --json schema', async () => {
    seedRuns();
    const w = scripted(ISSUES);
    expect(await board(w.exec, { source: 'label:factory', json: true })).toBe(0);
    const b = json();
    expect(Object.keys(b)).toEqual(['schemaVersion', 'ok', 'forge', 'repo', 'source', 'parent', 'columns', 'outside', 'warnings']);
    expect(b.schemaVersion).toBe(BOARD_JSON_SCHEMA_VERSION);
    expect(BOARD_JSON_SCHEMA_VERSION).toBe(1);
    expect(b).toMatchObject({ ok: true, forge: 'github', repo: REPO, source: { type: 'label', label: 'factory' }, parent: null, warnings: [] });
    expect(b.columns.map((c) => [c.stage, c.title])).toEqual([
      ['backlog', 'backlog'], ['queued', 'factory:queued'], ['building', 'factory:building'], ['reviewing', 'factory:reviewing'], ['verifying', 'factory:verifying'],
      ['ready-to-merge', 'factory:ready-to-merge'], ['done', 'factory:done'], ['blocked', 'factory:blocked'], ['cancelled', 'cancelled'],
    ]);
    expect(b.columns.map((c) => [c.stage, ids(c.items)])).toEqual([
      ['backlog', [1, 2]], ['queued', []], ['building', [3]], ['reviewing', [6]], ['verifying', []], ['ready-to-merge', [4]], ['done', []], ['blocked', [5]], ['cancelled', []],
    ]);
    // Backlog rows carry the check bucket; tracker text is plain.
    const [one, two] = column(b, 'backlog').items;
    expect(Object.keys(one)).toEqual(['id', 'title', 'url', 'check', 'stage', 'flags']);
    expect(one).toEqual({ id: 1, title: 'ready one  ', url: `${REPO}/issues/1`, check: { bucket: 'runnable', priority: 2, reasons: [], detail: 'plan: 1 acceptance item (issue-body)' }, stage: {}, flags: [] });
    expect(two.check).toMatchObject({ bucket: 'needs-plan', reasons: ['no-plan'] });

    const three = column(b, 'building').items[0];
    expect(three.check).toMatchObject({ bucket: 'blocked', reasons: ['run-active:implement'] });
    expect(three.run).toEqual({ phase: 'implement', lanes: 1, runningLane: 'impl-3', credits: 3.14, integrity: 'ok', updatedAt: T0 });
    expect(three.stage).toEqual({ expected: 'building', recorded: 'building', live: 'building' });
    expect(three.flags).toEqual(['stale']);

    const four = column(b, 'ready-to-merge').items[0];
    expect(four.run).toMatchObject({ phase: 'gates', gate: { name: 'merge' }, pr: 9, head: HEAD, integrity: 'ok' });
    expect(four.gates).toEqual({ verdict: 'approve', sha: HEAD, at: T1 });
    expect(four.stage).toEqual({ expected: 'ready-to-merge', recorded: 'verifying', live: 'verifying' });
    expect(four.flags).toEqual(['unsynced']);

    const five = column(b, 'blocked').items[0];
    expect(five.run).toMatchObject({ phase: 'intake', gate: { name: 'blocked-by', reason: 'edited by hand' }, integrity: 'bad' });
    expect(five.flags).toEqual(['seal']);

    const six = column(b, 'reviewing').items[0];
    expect(six.stage).toEqual({ expected: 'reviewing', recorded: 'reviewing', live: 'building' });
    expect(six.liveText).toBe('factory:building');
    expect(six.flags).toEqual(['drift']);

    // In-flight runs outside the source; the merged one is not shown.
    expect(ids(b.outside)).toEqual([99, 'heal-0123abcd']);
    expect(b.outside[0]).toMatchObject({ title: 'explicit id red', url: '', run: { phase: 'review' } });
    expect(b.outside[1]).toMatchObject({ id: 'heal-0123abcd', title: 'ci-heal', stage: { expected: 'verifying' }, run: { phase: 'gates' } });

    // Only reads reached gh.
    expect(w.calls.filter((c) => c.startsWith('gh ')).every((c) => /^gh (?:issue (?:list|view)|pr list) /.test(c))).toBe(true);
  });

  it('prints sections with titles, gates, verdicts and flags', async () => {
    seedRuns();
    expect(await board(scripted(ISSUES).exec, { source: 'label:factory' })).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/^factory board {2}github https:\/\/github\.com\/o\/r {2}source label factory {2}\(6 items, 6 runs\)/);
    expect(text).toMatch(/BACKLOG\n {2}runnable +#1 +P2 +ready one/);
    expect(text).toMatch(/BUILDING \(factory:building\)\n {2}#3 +implement {2}lane impl-3 running {2}3\.14 cr {2}building {2}stale/);
    expect(text).toMatch(/READY-TO-MERGE \(factory:ready-to-merge\)\n {2}#4 +awaiting-human: merge {2}0\.00 cr {2}PR #9 {2}head bbbbbbbbbbbb {2}verdict approve @ bbbbbbbbbbbb/);
    expect(text).toContain('unsynced: recorded verifying != expected ready-to-merge');
    expect(text).toContain('drift: live "factory:building" != recorded reviewing');
    expect(text).toMatch(/#5 +awaiting-human: blocked-by .*seal!\n +edited by hand/);
    expect(text).toMatch(/RUNS NOT IN THE INTAKE SOURCE\n {2}#99 .*\n {2}heal-0123abcd {2}gates/);
    expect(text).not.toMatch(/\u001b\[2J|\u0007/);
  });

  it('--parent shows the spec\'s children (as check --parent) and names the spec', async () => {
    const issues = { ...ISSUES, 20: { title: 'the spec', body: '- [ ] #1\n- [ ] #2\n' } };
    expect(await board(scripted(issues).exec, { parent: '20', json: true })).toBe(0);
    const b = json();
    expect(b.parent).toEqual({ id: 20, title: 'the spec', url: `${REPO}/issues/20` });
    expect(b.source).toBeNull();
    expect(ids(column(b, 'backlog').items)).toEqual([1, 2]);
    await expect(board(scripted(issues).exec, { parent: '20', source: 'label:factory' })).rejects.toThrow(/exclusive/);
  });

  it('--no-check reads the items only (no rules, no PR lookups) and still flags drift', async () => {
    seedRuns();
    const w = scripted(ISSUES);
    expect(await board(w.exec, { source: 'label:factory', check: false, json: true })).toBe(0);
    const b = json();
    expect(b.columns.flatMap((c) => c.items).every((r) => r.check === undefined)).toBe(true);
    expect(ids(column(b, 'backlog').items)).toEqual([1, 2]);
    expect(column(b, 'reviewing').items[0].flags).toEqual(['drift']);
    expect(w.calls.filter((c) => c.startsWith('gh '))).toEqual(['gh issue list --label factory --state open --json number --limit 50', ...[1, 2, 3, 4, 5, 6].map((n) => `gh issue view ${n} --json title,body,labels,state,url,author,comments`)]);
  });

  it('a failed item read shows read-failed and exits 1', async () => {
    expect(await board(scripted(ISSUES, [1, 7]).exec, { source: 'label:factory', json: true })).toBe(1);
    const b = json();
    expect(b.ok).toBe(false);
    expect(column(b, 'backlog').items.find((r) => r.id === 7)).toMatchObject({ check: { reasons: ['read-failed'] } });
    expect(await board(scripted(ISSUES, [1, 7]).exec, { source: 'label:factory', check: false, json: true })).toBe(1);
  });

  it('without a source shows the runs in flight, and with no runs either is incompatible (exit 5)', async () => {
    await expect(board(scripted(ISSUES).exec)).rejects.toBeInstanceOf(CheckIncompatibleError);
    process.exitCode = undefined;
    await factoryBoardCommand(deps(scripted(ISSUES).exec)).parseAsync([], { from: 'user' });
    expect(Number(process.exitCode)).toBe(5);
    process.exitCode = undefined;
    seedRuns();
    expect(await board(scripted(ISSUES).exec, { json: true })).toBe(0);
    expect(ids(json().outside)).toEqual([3, 4, 5, 6, 99, 'heal-0123abcd']);
  });

  it('the read guard refuses every write before it reaches gh', async () => {
    let guarded: Exec | undefined;
    const spy: ForgeFactory = (exec, cwd, config, options) => {
      guarded = exec;
      return createForge(exec, cwd, config, options);
    };
    const w = scripted(ISSUES);
    expect(await board(w.exec, { source: 'label:factory', json: true }, { createForge: spy })).toBe(0);
    const before = w.calls.length;
    const writes = [
      ['issue', 'edit', '1', '--add-label', 'factory-ready'],
      ['issue', 'edit', '1', '--add-label', 'factory:building'],
      ['issue', 'comment', '1', '--body-file', join(root, 'b.md')],
      ['issue', 'create', '--title', 'x', '--body-file', join(root, 'b.md')],
      ['issue', 'close', '1'],
      ['label', 'create', 'factory:queued'],
      ['pr', 'create', '--draft', '--base', 'dev', '--head', 'factory/issue-1', '--title', 'x', '--body-file', join(root, 'b.md')],
      ['pr', 'ready', '9'],
      ['pr', 'merge', '9', '--squash'],
      ['pr', 'comment', '9', '--body-file', join(root, 'b.md')],
      ['run', 'rerun', '77', '--failed'],
      ['api', '-X', 'POST', 'repos/o/r/issues/1/labels'],
    ];
    for (const args of writes) expect(() => guarded!('gh', args, { cwd: root }), args.join(' ')).toThrow(FactorySafetyError);
    expect(() => guarded!('git', ['push', 'origin', 'HEAD'], { cwd: root })).toThrow(FactorySafetyError);
    expect(w.calls.length).toBe(before);
  });
});

describe('liveStage', () => {
  const ado = { building: { column: 'Doing', state: 'Active' }, reviewing: { column: 'Code Review', state: 'Active' }, done: { state: 'Closed' } };
  it('maps an ADO column first, then the state; the recorded stage wins a tie', () => {
    expect(liveStage('azure-devops', ado, { labels: [], column: 'code review', state: 'Active' })).toEqual({ stage: 'reviewing', text: 'code review' });
    expect(liveStage('azure-devops', ado, { labels: [], column: 'Elsewhere', state: 'Active' }, 'reviewing')).toEqual({ stage: 'reviewing', text: 'Active' });
    expect(liveStage('azure-devops', ado, { labels: [], column: 'Elsewhere', state: 'Active' })).toEqual({ stage: 'building', text: 'Active' });
    expect(liveStage('azure-devops', ado, { labels: [], column: 'New', state: 'New' })).toEqual({ stage: 'unmapped', text: 'New' });
  });
  it('maps a GitHub progress label case-insensitively', () => {
    expect(liveStage('github', { done: { label: 'factory:done' } }, { labels: ['Factory:Done'], state: 'CLOSED' })).toEqual({ stage: 'done', text: 'factory:done' });
    expect(liveStage('github', { done: { label: 'factory:done' } }, { labels: ['bug'], state: 'OPEN' })).toEqual({ stage: 'unmapped' });
  });
});
