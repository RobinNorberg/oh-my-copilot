import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_SHIP_CONFIG, parseKnownFlaky, resolveShipConfig, type ShipConfig } from '../config.js';
import { guardExec, type Exec, type ExecResult } from '../exec.js';
import {
  applyFlakyAnalysis,
  applyWorkflowRuns,
  analyzeFailedLog,
  classifyCheck,
  evaluateChecks,
  evaluateGates,
  fetchChecks,
  logBlockers,
  NO_WORKFLOWS_TRIGGERED,
  parseChecksJson,
  parseFailingTests,
  parseRunsJson,
  watchGates,
  type GhCheck,
  type WorkflowRun,
} from '../gates.js';

import { EXIT_PENDING, gateExit } from '../../cli/commands/ship.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const REPO_ROOT = join(HERE, '..', '..', '..');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
/** Recorded `gh pr checks 233 --json ...` (merged PR; the authorization gate is red by design). */
const PR233: GhCheck[] = JSON.parse(fixture('checks-pr233-green.json'));
const KNOWN = parseKnownFlaky(readFileSync(join(REPO_ROOT, DEFAULT_SHIP_CONFIG.knownFlakyFile), 'utf8'), DEFAULT_SHIP_CONFIG.knownFlakyFile);
const CONFIG: ShipConfig = resolveShipConfig(undefined);

const RUN = '38006018811';
const TEST_JOB = '114080000001';
const TEST_LINK = `https://github.com/RobinNorberg/oh-my-copilot/actions/runs/${RUN}/job/${TEST_JOB}`;

function withCheck(name: string, patch: Partial<GhCheck>): GhCheck[] {
  return PR233.map((c) => (c.name === name ? { ...c, ...patch } : c));
}

function ok(stdout: string): ExecResult {
  return { status: 0, stdout, stderr: '' };
}

const HEAD_SHA = 'f'.repeat(40);
const COMPLETED_RUNS: WorkflowRun[] = [
  { databaseId: 1, status: 'completed', conclusion: 'success', workflowName: 'CI' },
  { databaseId: 2, status: 'completed', conclusion: 'success', workflowName: 'PR Check' },
];

/**
 * Fake gh (through the real guard): serves successive `pr checks` payloads,
 * job logs by job id and successive `run list` payloads; records every call.
 */
function fakeGh(checkSeq: GhCheck[][], logs: Record<string, string> = {}, runSeq: WorkflowRun[][] = [COMPLETED_RUNS], headSeq: string[] = [HEAD_SHA]) {
  const calls: string[][] = [];
  let i = 0;
  let j = 0;
  let k = 0;
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'pr' && args[1] === 'checks') {
      const payload = checkSeq[Math.min(i, checkSeq.length - 1)];
      i += 1;
      return ok(JSON.stringify(payload));
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const head = headSeq[Math.min(k, headSeq.length - 1)];
      k += 1;
      return ok(JSON.stringify({ headRefOid: head }));
    }
    if (args[0] === 'run' && args[1] === 'list') {
      const payload = runSeq[Math.min(j, runSeq.length - 1)];
      j += 1;
      return ok(JSON.stringify(payload));
    }
    if (args[0] === 'run' && args[1] === 'view') {
      const job = args[args.indexOf('--job') + 1];
      return ok(logs[job] ?? '');
    }
    if (args[0] === 'run' && args[1] === 'rerun') return ok('');
    throw new Error(`unexpected command ${cmd} ${args.join(' ')}`);
  };
  return { exec: guardExec(exec), calls };
}

describe('merge rule on recorded gh pr checks JSON', () => {
  it('parses the recorded fixture', () => {
    expect(PR233.length).toBe(23);
    expect(parseChecksJson(JSON.stringify(PR233))).toHaveLength(23);
  });

  it('is green when only advisory checks fail (PR #233 as merged)', () => {
    const report = evaluateChecks(233, PR233, CONFIG);
    expect(report.verdict).toBe('green');
    expect(report.failed).toEqual([]);
    expect(report.advisoryFailed).toEqual(['Authorize generated artifacts from base trust root']);
  });

  it('treats SKIPPED as passing', () => {
    const skipped = PR233.find((c) => c.name === 'Create GitHub Release')!;
    expect(classifyCheck(skipped, CONFIG.advisoryChecks).class).toBe('pass');
  });

  it('blocks on a failed required check even when Test is green (the path-gate lesson)', () => {
    const checks = withCheck('Multi-repo Path Gate (AST-grep) (ubuntu-latest)', { state: 'FAILURE', bucket: 'fail' });
    const report = evaluateChecks(233, checks, CONFIG);
    expect(report.verdict).toBe('failed');
    expect(report.failed).toEqual(['Multi-repo Path Gate (AST-grep) (ubuntu-latest)']);
  });

  it('reports pending for queued / in-progress checks', () => {
    const checks = withCheck('Test', { state: 'IN_PROGRESS', bucket: 'pending' })
      .map((c) => (c.name === 'Build' ? { ...c, state: 'QUEUED' } : c));
    const report = evaluateChecks(233, checks, CONFIG);
    expect(report.verdict).toBe('pending');
    expect(report.pending.sort()).toEqual(['Build', 'Test']);
  });

  it('fails closed on unknown, cancelled and neutral states', () => {
    for (const state of ['CANCELLED', 'NEUTRAL', 'TIMED_OUT', 'SOMETHING_NEW']) {
      expect(evaluateChecks(233, withCheck('Build', { state }), CONFIG).verdict).toBe('failed');
    }
  });

  it('a failure outranks pending checks', () => {
    const checks = withCheck('Test', { state: 'PENDING' }).map((c) => (c.name === 'Build' ? { ...c, state: 'FAILURE' } : c));
    expect(evaluateChecks(233, checks, CONFIG).verdict).toBe('failed');
  });

  it('is pending, never green, with no required checks', () => {
    expect(evaluateChecks(1, [], CONFIG).verdict).toBe('pending');
    const onlyAdvisory = PR233.filter((c) => CONFIG.advisoryChecks.includes(c.name));
    expect(evaluateChecks(1, onlyAdvisory, CONFIG).verdict).toBe('pending');
  });

  it('a required check not reported yet is pending (the needs: window before Build exists)', () => {
    const withoutLate = PR233.filter((c) => !['Build', 'npm pack + install test', 'Copilot smoke (tier 2)'].includes(c.name));
    const report = evaluateChecks(233, withoutLate, CONFIG);
    expect(report.verdict).toBe('pending');
    expect(report.pending).toEqual(['Build', 'npm pack + install test', 'Copilot smoke (tier 2)']);
    expect(report.suggestions.join('\n')).toMatch(/not reported yet/);
    expect(evaluateChecks(233, PR233.filter((c) => c.name !== 'Build'), CONFIG).pending).toEqual(['Build']);
    // A real failure still outranks the missing ones.
    const failing = withoutLate.map((c) => (c.name === 'Test' ? { ...c, state: 'FAILURE' } : c));
    expect(evaluateChecks(233, failing, CONFIG).verdict).toBe('failed');
  });

  it('the default required list is exactly what PR #233 reported outside the advisory and tag-only checks', () => {
    const reported = PR233.map((c) => c.name);
    expect(CONFIG.requiredChecks.every((n) => reported.includes(n))).toBe(true);
  });

  it('green needs every workflow run for the head sha completed', () => {
    const green = evaluateChecks(233, PR233, CONFIG);
    expect(applyWorkflowRuns(green, COMPLETED_RUNS).verdict).toBe('green');
    const open = applyWorkflowRuns(green, [...COMPLETED_RUNS, { databaseId: 3, status: 'in_progress', workflowName: 'Upgrade Test' }, { databaseId: 4, status: 'queued' }]);
    expect(open.verdict).toBe('pending');
    expect(open.pending).toEqual(['workflow run Upgrade Test (in_progress)', 'workflow run 4 (queued)']);
    const failed = evaluateChecks(233, withCheck('Build', { state: 'FAILURE' }), CONFIG);
    expect(applyWorkflowRuns(failed, [{ databaseId: 3, status: 'in_progress' }]).verdict).toBe('failed');
  });

  it('evaluateGates asks gh run list for the head sha before calling it green', () => {
    const { exec, calls } = fakeGh([PR233], {}, [[{ databaseId: 9, status: 'in_progress', workflowName: 'CI' }]]);
    expect(evaluateGates(exec, 233, CONFIG, KNOWN).verdict).toBe('pending');
    expect(calls).toContainEqual(['gh', 'pr', 'view', '233', '--json', 'headRefOid']);
    expect(calls).toContainEqual(['gh', 'run', 'list', '--commit', HEAD_SHA, '--json', 'databaseId,status,conclusion,workflowName', '--limit', '100']);
    const given = fakeGh([PR233], {}, [COMPLETED_RUNS], ['e'.repeat(40)]);
    expect(evaluateGates(given.exec, 233, CONFIG, KNOWN, undefined, 'e'.repeat(40)).verdict).toBe('green');
    // An explicit head is not looked up first, only re-read after the checks and runs.
    expect(given.calls.filter((c) => c[2] === 'view')).toHaveLength(1);
    expect(given.calls.findIndex((c) => c[2] === 'view')).toBeGreaterThan(given.calls.findIndex((c) => c[2] === 'list'));
    expect(given.calls.find((c) => c[2] === 'list')?.[4]).toBe('e'.repeat(40));
  });

  it('resolves the head first, reads checks and runs for it, and refuses green when the head moved', () => {
    const steady = fakeGh([PR233]);
    expect(evaluateGates(steady.exec, 233, CONFIG, KNOWN).verdict).toBe('green');
    expect(steady.calls.map((c) => c.slice(1, 3).join(' '))).toEqual(['pr view', 'pr checks', 'run list', 'pr view']);
    const NEW = 'd'.repeat(40);
    const moved = fakeGh([PR233], {}, [COMPLETED_RUNS], [HEAD_SHA, NEW]);
    const report = evaluateGates(moved.exec, 233, CONFIG, KNOWN);
    expect(report.verdict).toBe('pending');
    expect(report.pending).toContain(`head moved from ${HEAD_SHA.slice(0, 12)} to ${NEW.slice(0, 12)} during the gate read`);
    expect(moved.calls.find((c) => c[2] === 'list')?.[4]).toBe(HEAD_SHA);
  });

  it('a completed workflow run that failed without reporting a check (startup failure) is failed', () => {
    const green = evaluateChecks(233, PR233, CONFIG);
    const startup = applyWorkflowRuns(green, [...COMPLETED_RUNS, { databaseId: 5, status: 'completed', conclusion: 'startup_failure', workflowName: 'Upgrade Test' }]);
    expect(startup.verdict).toBe('failed');
    expect(startup.failed).toEqual(['workflow run Upgrade Test (startup_failure, no checks reported)']);
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', '']) {
      expect(applyWorkflowRuns(green, [{ databaseId: 6, status: 'completed', conclusion, workflowName: 'X' }]).verdict).toBe('failed');
    }
    for (const conclusion of ['success', 'skipped', 'neutral']) {
      expect(applyWorkflowRuns(green, [{ databaseId: 6, status: 'completed', conclusion, workflowName: 'X' }]).verdict).toBe('green');
    }
    // A failed run whose jobs reported is judged by its checks (here its failing job is advisory).
    const authRun = green.checks.find((c) => c.name === 'Authorize generated artifacts from base trust root')!.runId;
    expect(authRun).toMatch(/^\d+$/);
    expect(applyWorkflowRuns(green, [{ databaseId: Number(authRun), status: 'completed', conclusion: 'failure', workflowName: 'Generated Artifact Authorization' }]).verdict).toBe('green');
    // Superseded by a newer run of the same workflow: only the latest counts.
    expect(applyWorkflowRuns(green, [
      { databaseId: 7, status: 'completed', conclusion: 'cancelled', workflowName: 'X' },
      { databaseId: 8, status: 'completed', conclusion: 'success', workflowName: 'X' },
    ]).verdict).toBe('green');
  });

  it('no checks and no workflow runs for the head is a distinct no-workflows-triggered pending reason', () => {
    const { exec } = fakeGh([[]], {}, [[]]);
    const report = evaluateGates(exec, 9, CONFIG, KNOWN);
    expect(report.verdict).toBe('pending');
    expect(report.pending).toContain(NO_WORKFLOWS_TRIGGERED);
    expect(report.suggestions.join('\n')).toMatch(/GITHUB_TOKEN triggers no workflows: push the branch from a PAT, or close and reopen the PR/);
    // Runs exist but no checks yet: plain pending, not the bot-PR reason.
    const started = fakeGh([[]], {}, [[{ databaseId: 1, status: 'queued', workflowName: 'CI' }]]);
    expect(evaluateGates(started.exec, 9, CONFIG, KNOWN).pending).not.toContain(NO_WORKFLOWS_TRIGGERED);
  });

  it('a failing gh run list fails closed', () => {
    const exec: Exec = (_cmd, args) => (args[1] === 'checks' ? ok(JSON.stringify(PR233)) : { status: 1, stdout: '', stderr: 'HTTP 502' });
    expect(() => evaluateGates(exec, 233, CONFIG, KNOWN, undefined, HEAD_SHA)).toThrow(/HTTP 502/);
    expect(() => parseRunsJson('[{"status":"completed"}]')).toThrow(/databaseId/);
  });

  it('honours a configured advisory list', () => {
    const config = resolveShipConfig({ advisoryChecks: [] });
    expect(evaluateChecks(233, PR233, config).verdict).toBe('failed');
  });

  it('extracts run and job ids from Actions links', () => {
    const c = classifyCheck({ name: 'Test', state: 'FAILURE', link: TEST_LINK }, []);
    expect(c.runId).toBe(RUN);
    expect(c.jobId).toBe('114080000001');
    expect(classifyCheck({ name: 'Socket', state: 'SUCCESS', link: 'https://socket.dev' }, []).runId).toBeUndefined();
  });

  it('rejects malformed JSON', () => {
    expect(() => parseChecksJson('not json')).toThrow(/did not print JSON/);
    expect(() => parseChecksJson('{}')).toThrow(/not an array/);
    expect(() => parseChecksJson('[{"name":1}]')).toThrow(/lacks name/);
  });
});

describe('fetchChecks', () => {
  it('parses stdout even when gh exits non-zero', () => {
    const exec: Exec = () => ({ status: 8, stdout: JSON.stringify(PR233), stderr: '' });
    expect(fetchChecks(exec, 233)).toHaveLength(23);
  });

  it('maps "no checks reported" to an empty list', () => {
    const exec: Exec = () => ({ status: 1, stdout: '', stderr: "no checks reported on the 'feat/x' branch" });
    expect(fetchChecks(exec, 5)).toEqual([]);
  });

  it('throws on other gh errors', () => {
    const exec: Exec = () => ({ status: 1, stdout: '', stderr: 'HTTP 401' });
    expect(() => fetchChecks(exec, 5)).toThrow(/HTTP 401/);
  });
});

describe('known-flaky attribution from job logs', () => {
  it('ships a valid known-flaky list, every entry title-scoped', () => {
    expect(KNOWN.length).toBeGreaterThanOrEqual(5);
    expect(KNOWN.every((k) => !k.file.includes('\\') && k.title.length > 0)).toBe(true);
  });

  it('a file-level failure (collection error) of a listed file is never flaky', () => {
    const log = ' FAIL  src/team/__tests__/runtime-v2.dispatch.test.ts [ src/team/__tests__/runtime-v2.dispatch.test.ts ]';
    expect(analyzeFailedLog('Test', RUN, log, KNOWN).knownFlaky).toBe(false);
  });

  it('unhandled errors, failed suites or a failing non-test step make a known-flaky log real', () => {
    const flakyLog = fixture('job-log-flaky.txt');
    expect(logBlockers(flakyLog)).toEqual([]);
    const cases: Array<[string, RegExp]> = [
      [`${flakyLog}\nTest\tRun functional tests\t2026-10-09T23:56:53.3Z ⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯`, /unhandled errors/],
      [`${flakyLog}\nTest\tRun functional tests\t2026-10-09T23:56:53.3Z ⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯`, /failed suites/],
      [`${flakyLog}\nTest\tBuild dist\t2026-10-09T23:40:00.0Z ##[error]Process completed with exit code 2.`, /step "Build dist" failed without a failing test/],
    ];
    for (const [log, pattern] of cases) {
      const a = analyzeFailedLog('Test', RUN, log, KNOWN);
      expect(a.knownFlaky).toBe(false);
      expect(a.blockers.join('\n')).toMatch(pattern);
    }
  });

  it('matches analyses to checks by job id, not by name', () => {
    const OTHER_JOB = `https://github.com/RobinNorberg/oh-my-copilot/actions/runs/${RUN}/job/114080000002`;
    const checks: GhCheck[] = [
      ...PR233.filter((c) => c.name !== 'Test'),
      { name: 'Test', state: 'FAILURE', link: TEST_LINK },
      { name: 'Test', state: 'FAILURE', link: OTHER_JOB, workflow: 'Other' },
    ];
    const report = evaluateChecks(233, checks, CONFIG);
    const flakyOnly = applyFlakyAnalysis(report, [analyzeFailedLog('Test', RUN, fixture('job-log-flaky.txt'), KNOWN, '114080000001')]);
    expect(flakyOnly.verdict).toBe('failed');
    const both = applyFlakyAnalysis(report, [
      analyzeFailedLog('Test', RUN, fixture('job-log-flaky.txt'), KNOWN, '114080000001'),
      analyzeFailedLog('Test', RUN, fixture('job-log-real-failure.txt'), KNOWN, '114080000002'),
    ]);
    expect(both.verdict).toBe('failed');
    const allFlaky = applyFlakyAnalysis(report, [
      analyzeFailedLog('Test', RUN, fixture('job-log-flaky.txt'), KNOWN, '114080000001'),
      analyzeFailedLog('Test', RUN, fixture('job-log-flaky.txt'), KNOWN, '114080000002'),
    ]);
    expect(allFlaky.verdict).toBe('flaky');
  });

  it('parses the vitest FAIL line from a recorded Actions log (ANSI + step prefix)', () => {
    expect(parseFailingTests(fixture('job-log-real-failure.txt'))).toEqual([{
      file: 'src/cli/commands/__tests__/team-status-json.test.ts',
      title: 'omg team status --json > lists the worktrees a shut-down team kept for unmerged commits',
    }]);
  });

  it('ignores FAIL text that is not a vitest summary line', () => {
    const log = 'Test\tRun functional tests\t2026-10-09T23:54:33.7548584Z   new: npm run test: FAIL brand new regression\n';
    expect(parseFailingTests(log)).toEqual([]);
  });

  it('parses file-level failures without a title', () => {
    expect(parseFailingTests(' FAIL  tests/perf/subagent-lock.bench.ts [ tests/perf/subagent-lock.bench.ts ]')).toEqual([
      { file: 'tests/perf/subagent-lock.bench.ts' },
    ]);
  });

  it('classifies a known-flaky failure and a real one', () => {
    expect(analyzeFailedLog('Test', RUN, fixture('job-log-flaky.txt'), KNOWN).knownFlaky).toBe(true);
    const real = analyzeFailedLog('Test', RUN, fixture('job-log-real-failure.txt'), KNOWN);
    expect(real.knownFlaky).toBe(false);
    expect(real.unknown).toHaveLength(1);
  });

  it('a log with no parsable test failure is not flaky', () => {
    expect(analyzeFailedLog('Lint & Type Check', RUN, 'error TS2304: Cannot find name', KNOWN).knownFlaky).toBe(false);
  });

  it('a title-scoped entry does not cover other tests in the same file', () => {
    const log = ' FAIL  src/team/__tests__/runtime-v2.dispatch.test.ts > dispatch > something else entirely';
    expect(analyzeFailedLog('Test', RUN, log, KNOWN).knownFlaky).toBe(false);
  });

  it('verdict is flaky only when every failed required check is known-flaky', () => {
    const checks = withCheck('Test', { state: 'FAILURE', link: TEST_LINK });
    const base = evaluateChecks(233, checks, CONFIG);
    const flaky = applyFlakyAnalysis(base, [analyzeFailedLog('Test', RUN, fixture('job-log-flaky.txt'), KNOWN, TEST_JOB)]);
    expect(flaky.verdict).toBe('flaky');
    expect(flaky.rerunnable).toEqual([RUN]);
    expect(flaky.suggestions.join('\n')).toContain(`gh run rerun ${RUN} --failed`);

    const both = withCheck('Test', { state: 'FAILURE', link: TEST_LINK }).map((c) => (c.name === 'Build' ? { ...c, state: 'FAILURE' } : c));
    const mixed = applyFlakyAnalysis(evaluateChecks(233, both, CONFIG), [analyzeFailedLog('Test', RUN, fixture('job-log-flaky.txt'), KNOWN, TEST_JOB)]);
    expect(mixed.verdict).toBe('failed');
    expect(mixed.rerunnable).toEqual([]);
  });

  it('a flaky run with pending sibling jobs is not yet rerunnable', () => {
    const checks = withCheck('Test', { state: 'FAILURE', link: TEST_LINK })
      .map((c) => (c.name === 'Build' ? { ...c, state: 'IN_PROGRESS', link: `https://github.com/o/r/actions/runs/${RUN}/job/2` } : c));
    const report = applyFlakyAnalysis(evaluateChecks(233, checks, CONFIG), [analyzeFailedLog('Test', RUN, fixture('job-log-flaky.txt'), KNOWN, TEST_JOB)]);
    expect(report.verdict).toBe('flaky');
    expect(report.rerunnable).toEqual([]);
  });

  it('evaluateGates reads the failed job log through gh run view --job', () => {
    const { exec, calls } = fakeGh([withCheck('Test', { state: 'FAILURE', link: TEST_LINK })], { '114080000001': fixture('job-log-flaky.txt') });
    expect(evaluateGates(exec, 233, CONFIG, KNOWN).verdict).toBe('flaky');
    expect(calls).toContainEqual(['gh', 'run', 'view', '--job', '114080000001', '--log']);
  });
});

describe('watchGates', () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  };
  const budget = () => {
    const spent: Record<string, number> = {};
    return { spent, count: (id: string) => spent[id] ?? 0, record: (id: string) => { spent[id] = (spent[id] ?? 0) + 1; } };
  };
  const pending = withCheck('Test', { state: 'IN_PROGRESS' });
  const flaky = withCheck('Test', { state: 'FAILURE', link: TEST_LINK });
  const logs = { '114080000001': fixture('job-log-flaky.txt') };

  it('single shot returns the current verdict without sleeping', async () => {
    const { exec, calls } = fakeGh([pending]);
    const c = clock();
    const r = await watchGates({ exec, pr: 233, config: CONFIG, known: KNOWN, watch: false, ...c });
    expect(r.report.verdict).toBe('pending');
    expect(calls.filter((x) => x[2] === 'checks')).toHaveLength(1);
  });

  it('polls pending -> green', async () => {
    const { exec } = fakeGh([pending, pending, PR233]);
    const c = clock();
    const r = await watchGates({ exec, pr: 233, config: CONFIG, known: KNOWN, watch: true, ...c });
    expect(r.report.verdict).toBe('green');
    expect(c.now()).toBe(2 * CONFIG.pollIntervalSeconds * 1000);
  });

  it('stops at the per-invocation timeout (below the 10-minute watcher cap) with timedOut', async () => {
    const { exec } = fakeGh([pending]);
    const c = clock();
    const r = await watchGates({ exec, pr: 233, config: CONFIG, known: KNOWN, watch: true, ...c });
    expect(r.timedOut).toBe(true);
    expect(r.report.verdict).toBe('pending');
    expect(c.now()).toBe(9 * 60_000);
  });

  it('returns immediately on a real failure', async () => {
    const { exec } = fakeGh([withCheck('Build', { state: 'FAILURE' })]);
    const r = await watchGates({ exec, pr: 233, config: CONFIG, known: KNOWN, watch: true, ...clock() });
    expect(r.report.verdict).toBe('failed');
    expect(r.rerun).toEqual([]);
  });

  it('reruns a known-flaky run once, then reaches green', async () => {
    const { exec, calls } = fakeGh([flaky, pending, PR233], logs);
    const b = budget();
    const r = await watchGates({ exec, pr: 233, config: CONFIG, known: KNOWN, watch: true, reruns: b, ...clock() });
    expect(r.report.verdict).toBe('green');
    expect(r.rerun).toEqual([RUN]);
    expect(calls.filter((x) => x[1] === 'run' && x[2] === 'rerun')).toEqual([['gh', 'run', 'rerun', RUN, '--failed']]);
    expect(b.spent[RUN]).toBe(1);
  });

  it('never reruns the same run twice (same test failing twice is real)', async () => {
    const { exec, calls } = fakeGh([flaky, pending, flaky], logs);
    const r = await watchGates({ exec, pr: 233, config: CONFIG, known: KNOWN, watch: true, reruns: budget(), ...clock() });
    expect(r.report.verdict).toBe('flaky');
    expect(calls.filter((x) => x[2] === 'rerun')).toHaveLength(1);
  });

  it('honours a budget already spent in an earlier invocation', async () => {
    const { exec, calls } = fakeGh([flaky], logs);
    const b = budget();
    b.record(RUN);
    const r = await watchGates({ exec, pr: 233, config: CONFIG, known: KNOWN, watch: true, reruns: b, ...clock() });
    expect(r.report.verdict).toBe('flaky');
    expect(calls.some((x) => x[2] === 'rerun')).toBe(false);
  });

  it('does not rerun without a budget store or with autoRerunFlaky off', async () => {
    for (const opts of [{ reruns: undefined, config: CONFIG }, { reruns: budget(), config: { ...CONFIG, autoRerunFlaky: false } }]) {
      const { exec, calls } = fakeGh([flaky], logs);
      const r = await watchGates({ exec, pr: 233, known: KNOWN, watch: true, ...opts, ...clock() });
      expect(r.report.verdict).toBe('flaky');
      expect(calls.some((x) => x[2] === 'rerun')).toBe(false);
    }
  });

  it('spends the rerun budget before running gh run rerun', async () => {
    const b = budget();
    let spentAtRerun = -1;
    const inner = fakeGh([flaky, PR233], logs);
    const exec: Exec = (cmd, args, o) => {
      if (args[1] === 'rerun') spentAtRerun = b.count(RUN);
      return inner.exec(cmd, args, o);
    };
    await watchGates({ exec, pr: 233, config: CONFIG, known: KNOWN, watch: true, reruns: b, ...clock() });
    expect(spentAtRerun).toBe(1);
  });

  it('times out (timedOut, not a final flaky) while a flaky run still has pending sibling jobs', async () => {
    const siblings = withCheck('Test', { state: 'FAILURE', link: TEST_LINK })
      .map((c) => (c.name === 'Build' ? { ...c, state: 'IN_PROGRESS', link: `https://github.com/o/r/actions/runs/${RUN}/job/2` } : c));
    const { exec, calls } = fakeGh([siblings], logs);
    const c = clock();
    const r = await watchGates({ exec, pr: 233, config: CONFIG, known: KNOWN, watch: true, reruns: budget(), ...c });
    expect(r.report.verdict).toBe('flaky');
    expect(r.timedOut).toBe(true);
    expect(c.now()).toBe(9 * 60_000);
    expect(calls.some((x) => x[2] === 'rerun')).toBe(false);
    expect(gateExit(r.report, r.timedOut)).toBe(EXIT_PENDING);
    expect(gateExit(r.report, false)).toBe(1);
  });

  it('never reruns a run whose failure is not on the allowlist', async () => {
    const { exec, calls } = fakeGh([flaky], { '114080000001': fixture('job-log-real-failure.txt') });
    const r = await watchGates({ exec, pr: 233, config: CONFIG, known: KNOWN, watch: true, reruns: budget(), ...clock() });
    expect(r.report.verdict).toBe('failed');
    expect(calls.some((x) => x[2] === 'rerun')).toBe(false);
  });
});
