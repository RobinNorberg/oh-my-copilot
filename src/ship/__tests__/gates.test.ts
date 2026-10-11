import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_SHIP_CONFIG, loadKnownFlaky, resolveShipConfig, type ShipConfig } from '../config.js';
import type { Exec, ExecResult } from '../exec.js';
import {
  applyFlakyAnalysis,
  analyzeFailedLog,
  classifyCheck,
  evaluateChecks,
  evaluateGates,
  fetchChecks,
  parseChecksJson,
  parseFailingTests,
  watchGates,
  type GhCheck,
} from '../gates.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const REPO_ROOT = join(HERE, '..', '..', '..');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
/** Recorded `gh pr checks 233 --json ...` (merged PR; the authorization gate is red by design). */
const PR233: GhCheck[] = JSON.parse(fixture('checks-pr233-green.json'));
const KNOWN = loadKnownFlaky(REPO_ROOT, DEFAULT_SHIP_CONFIG.knownFlakyFile);
const CONFIG: ShipConfig = resolveShipConfig(undefined);

const RUN = '38006018811';
const TEST_LINK = `https://github.com/RobinNorberg/oh-my-copilot/actions/runs/${RUN}/job/114080000001`;

function withCheck(name: string, patch: Partial<GhCheck>): GhCheck[] {
  return PR233.map((c) => (c.name === name ? { ...c, ...patch } : c));
}

function ok(stdout: string): ExecResult {
  return { status: 0, stdout, stderr: '' };
}

/** Fake gh: serves successive `pr checks` payloads and job logs by job id; records every call. */
function fakeGh(checkSeq: GhCheck[][], logs: Record<string, string> = {}) {
  const calls: string[][] = [];
  let i = 0;
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'pr' && args[1] === 'checks') {
      const payload = checkSeq[Math.min(i, checkSeq.length - 1)];
      i += 1;
      return ok(JSON.stringify(payload));
    }
    if (args[0] === 'run' && args[1] === 'view') {
      const job = args[args.indexOf('--job') + 1];
      return ok(logs[job] ?? '');
    }
    if (args[0] === 'run' && args[1] === 'rerun') return ok('');
    throw new Error(`unexpected command ${cmd} ${args.join(' ')}`);
  };
  return { exec, calls };
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
  it('ships a valid known-flaky list', () => {
    expect(KNOWN.length).toBeGreaterThanOrEqual(6);
    expect(KNOWN.every((k) => !k.file.includes('\\'))).toBe(true);
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
    const flaky = applyFlakyAnalysis(base, [analyzeFailedLog('Test', RUN, fixture('job-log-flaky.txt'), KNOWN)]);
    expect(flaky.verdict).toBe('flaky');
    expect(flaky.rerunnable).toEqual([RUN]);
    expect(flaky.suggestions.join('\n')).toContain(`gh run rerun ${RUN} --failed`);

    const both = withCheck('Test', { state: 'FAILURE', link: TEST_LINK }).map((c) => (c.name === 'Build' ? { ...c, state: 'FAILURE' } : c));
    const mixed = applyFlakyAnalysis(evaluateChecks(233, both, CONFIG), [analyzeFailedLog('Test', RUN, fixture('job-log-flaky.txt'), KNOWN)]);
    expect(mixed.verdict).toBe('failed');
    expect(mixed.rerunnable).toEqual([]);
  });

  it('a flaky run with pending sibling jobs is not yet rerunnable', () => {
    const checks = withCheck('Test', { state: 'FAILURE', link: TEST_LINK })
      .map((c) => (c.name === 'Build' ? { ...c, state: 'IN_PROGRESS', link: `https://github.com/o/r/actions/runs/${RUN}/job/2` } : c));
    const report = applyFlakyAnalysis(evaluateChecks(233, checks, CONFIG), [analyzeFailedLog('Test', RUN, fixture('job-log-flaky.txt'), KNOWN)]);
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

  it('never reruns a run whose failure is not on the allowlist', async () => {
    const { exec, calls } = fakeGh([flaky], { '114080000001': fixture('job-log-real-failure.txt') });
    const r = await watchGates({ exec, pr: 233, config: CONFIG, known: KNOWN, watch: true, reruns: budget(), ...clock() });
    expect(r.report.verdict).toBe('failed');
    expect(calls.some((x) => x[2] === 'rerun')).toBe(false);
  });
});
