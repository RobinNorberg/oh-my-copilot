/**
 * ADO failed build checks carry a jobId (`<buildId>:<timeline record id>`),
 * so the ci-fix lane's failing test titles (failingTestTitles) and the
 * known-flaky analysis read their logs, as they do for GitHub Actions jobs.
 * Build 101 failed in the variant world below; its timeline is the retried
 * one in ./fixtures/variants.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { failingTestTitles } from '../../../factory/run/gates-driver.js';
import { DEFAULT_SHIP_CONFIG } from '../../../ship/config.js';
import type { Exec } from '../../../ship/exec.js';
import { evaluateGates, logBlockers } from '../../../ship/gates.js';
import { ADO_FIXTURE_DIR, loadAdoFixtures, parseAdoFixture } from './fixtures.js';
import { adoWorld, HEAD, variant } from './world.js';

const ATTEMPTS = 'build.timeline.GET.101-attempts.json';
const attempts = parseAdoFixture(ATTEMPTS, readFileSync(join(ADO_FIXTURE_DIR, 'variants', ATTEMPTS), 'utf8'));

/** PR 17's blocking build policy rejected on build 101, which failed; `timeline` answers build 101's timeline. */
function redWorld(timeline = attempts) {
  let fixtures = loadAdoFixtures().filter((f) => f.name !== 'build.timeline.GET.101.json').concat(timeline);
  fixtures = variant(fixtures, 'build.builds.GET.pr-17.json', (s) => ({ ...s, value: s.value.map((b: { id: number }) => (b.id === 101 ? { ...b, result: 'failed' } : b)) }));
  fixtures = variant(fixtures, 'policy.evaluations.GET.pr-17.json', (s) => ({
    ...s,
    value: s.value.map((e: { configuration: { id: number }; status: string }) => (e.configuration.id === 4 ? { ...e, status: 'rejected' } : e)),
  }));
  return adoWorld({ fixtures });
}

const noExec: Exec = (cmd, args) => { throw new Error(`no exec on ADO: ${cmd} ${args.join(' ')}`); };

describe('ADO failed build checks carry the failed job', () => {
  it('the blocking FAILURE check names the newest attempt of the failed job; advisory and green checks read no timeline', () => {
    const { forge, routes } = redWorld();
    const checks = forge.checks.checks(17, HEAD);
    expect(checks.find((c) => c.name === 'CI')).toMatchObject({ state: 'FAILURE', runId: '101', jobId: '101:7e570002-0000-4000-8000-000000000002' });
    // The non-blocking "Docs build" policy also failed on 101, but no gate reads an advisory log.
    expect(checks.find((c) => c.name === 'Docs build')).not.toHaveProperty('jobId');
    expect(routes().filter((r) => r === 'build.timeline.GET')).toHaveLength(1);
  });

  it('failingTestTitles on the ADO world yields the failing test of the job log', () => {
    const { forge } = redWorld();
    const report = evaluateGates(noExec, 17, DEFAULT_SHIP_CONFIG, [], '/repo', HEAD, forge);
    expect(report.verdict).toBe('failed');
    expect(failingTestTitles(noExec, report, '/repo', forge)).toEqual(['src/report.test.ts > exports CSV']);
  });

  it('a known-flaky entry applies to an ADO failure', () => {
    const { forge } = redWorld();
    const report = evaluateGates(noExec, 17, DEFAULT_SHIP_CONFIG, [{ file: 'src/report.test.ts', title: 'exports CSV' }], '/repo', HEAD, forge);
    expect(report.verdict).toBe('flaky');
  });

  it('a failed build whose timeline has no failed job, or cannot be read, has no jobId (and is still a failure)', () => {
    const green = { ...attempts, stdout: { records: [{ id: '7e570002-0000-4000-8000-000000000002', type: 'Job', name: 'Test', result: 'succeeded' }] } };
    expect(redWorld(green).forge.checks.checks(17, HEAD).find((c) => c.name === 'CI')).toEqual(expect.not.objectContaining({ jobId: expect.anything() }));
    const unreadable = { ...attempts, exitCode: 1, stdout: '', stderr: 'ERROR: TF400898: An internal error occurred' };
    expect(redWorld(unreadable).forge.checks.checks(17, HEAD).find((c) => c.name === 'CI')).toMatchObject({ state: 'FAILURE' });
    expect(redWorld(unreadable).forge.checks.checks(17, HEAD).find((c) => c.name === 'CI')).not.toHaveProperty('jobId');
  });
});

describe('ADO known-flaky attribution reads one job and its steps', () => {
  it('a build with more than one failed job has no jobId, so one known-flaky log cannot excuse the other job', () => {
    const twoFailed = {
      ...attempts,
      stdout: {
        records: [
          { id: '7e570002-0000-4000-8000-000000000002', type: 'Job', name: 'Test', identifier: 'Build.Test', result: 'failed', log: { id: 7 } },
          { id: 'e2e00002-0000-4000-8000-000000000002', type: 'Job', name: 'E2E', identifier: 'Build.E2E', result: 'failed', log: { id: 8 } },
        ],
      },
    };
    const { forge } = redWorld(twoFailed);
    expect(forge.checks.checks(17, HEAD).find((c) => c.name === 'CI')).not.toHaveProperty('jobId');
    const report = evaluateGates(noExec, 17, DEFAULT_SHIP_CONFIG, [{ file: 'src/report.test.ts', title: 'exports CSV' }], '/repo', HEAD, forge);
    expect(report.verdict).toBe('failed');
  });

  it('an ##[error] in another step of an Azure Pipelines log is a blocker; one beside the FAIL line is not', () => {
    const testStep = [
      '\uFEFF2026-10-28T11:10:00.0000000Z ##[section]Starting: Run tests',
      '2026-10-28T11:12:00.0000000Z FAIL src/report.test.ts > exports CSV',
      '2026-10-28T11:12:01.0000000Z ##[error]Process completed with exit code 1.',
      '2026-10-28T11:12:02.0000000Z ##[section]Finishing: Run tests',
    ];
    expect(logBlockers(testStep.join('\n'))).toEqual([]);
    const otherStep = [
      ...testStep,
      '2026-10-28T11:12:03.0000000Z ##[section]Starting: Publish coverage',
      '2026-10-28T11:12:04.0000000Z ##[error]No coverage files found.',
    ];
    expect(logBlockers(otherStep.join('\n'))).toEqual(['step "Publish coverage" failed without a failing test']);
  });

  it('the known-flaky suggestion on ADO points at the build, not at gh run rerun', () => {
    const { forge } = redWorld();
    const report = evaluateGates(noExec, 17, DEFAULT_SHIP_CONFIG, [{ file: 'src/report.test.ts', title: 'exports CSV' }], '/repo', HEAD, forge);
    const hint = report.suggestions.find((s) => s.includes('known-flaky'));
    expect(hint).toMatch(/-> re-queue build 101 from the pull request's checks \(https:\/\/dev\.azure\.com\/.+buildId=101\)$/);
    expect(report.suggestions.join('\n')).not.toContain('gh run rerun');
  });
});
