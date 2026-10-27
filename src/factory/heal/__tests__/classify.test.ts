import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { parseKnownFlaky } from '../../../ship/config.js';
import { classifyJob, classifyRun, envDiff, historyPattern, type ClassifyJobInput, type JobSample } from '../classify.js';
import { capLog, MAX_LINE_CHARS, MAX_LOG_CHARS, parseJob, parseJobEnv, type ParsedJob } from '../logs.js';
import { jobSignature, normalizeErrorLine, runSignature } from '../signature.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(HERE, 'fixtures', name), 'utf8');
const RED_SHA = '15e3c590ca6eaadf0a0d1efe38f89092b3ae6269';
const GREEN_SHA = 'c375fe0788c0d458da14b9fd440856085ab6543e';
const KNOWN = parseKnownFlaky(readFileSync(join(HERE, '../../../../.github/known-flaky-tests.json'), 'utf8'), 'known-flaky');
const NONGIT = { file: 'src/tools/__tests__/state-tools-nongit-ownership.test.ts', title: '#3873 real non-git state ownership > rejects legacy sources beneath malformed Git metadata' };

const red = (): ParsedJob => parseJob({ jobId: '122329975951', name: 'Test', failedSteps: ['Run functional tests'] }, fixture('git256-red.log'), KNOWN);
const green = (): ParsedJob => parseJob({ jobId: '122472747061', name: 'Test', failedSteps: [] }, fixture('git256-green.log'), KNOWN);
const sample = (runId: string, sha: string, job: ParsedJob): JobSample => ({ runId, sha, job });

function synthetic(name: string, lines: string[], failedSteps = ['Install dependencies']): ParsedJob {
  return parseJob({ jobId: '1', name, failedSteps }, lines.map((l) => `${name}\t${failedSteps[0]}\t2026-10-27T10:00:00.0000000Z ${l}`).join('\n'), KNOWN);
}

describe('heal log parsing (fixtures)', () => {
  it('git256-red: the nongit-ownership test, image 20261025.353.1, git 2.56.0', () => {
    const job = red();
    expect(job.failingTests).toEqual([NONGIT]);
    expect(job.blockers).toEqual([]);
    expect(job.env).toEqual({ image: 'ubuntu-24.04', imageVersion: '20261025.353.1', runnerVersion: '20261021.618', git: '2.56.0', node: '20.20.2', npm: '10.8.2' });
  });

  it('git256-green: image 20261012.334.1, git 2.55.0, no failing test', () => {
    const job = green();
    expect(job.failingTests).toEqual([]);
    expect(job.env).toMatchObject({ imageVersion: '20261012.334.1', git: '2.55.0' });
  });

  it('fixture-fail-text: "FAIL brand new regression" printed by a test is not a failing test', () => {
    const lines = fixture('git256-red.log').split('\n').filter((l) => /FAIL (?:brand new regression|whatever)/.test(l));
    expect(lines.length).toBe(2);
    expect(parseJob({ jobId: '1', name: 'Test', failedSteps: [] }, lines.join('\n'), KNOWN).failingTests).toEqual([]);
  });

  it('policy-only: no failing test, a bare exit-code error', () => {
    const job = parseJob({ jobId: '122472797949', name: 'No Committed Build Artifacts', failedSteps: ['Hold candidate generated changes'] }, fixture('policy-only.log'), KNOWN);
    expect(job.failingTests).toEqual([]);
    expect(job.firstError).toBe('Process completed with exit code 1.');
  });

  it('caps a 10 MiB line and a huge log before parsing', () => {
    const huge = `Test\tRun\t2026-10-27T10:00:00Z ${'x'.repeat(10 * 1024 * 1024)}`;
    const capped = capLog(`${huge}\n${huge}`);
    expect(capped.length).toBeLessThanOrEqual(2 * MAX_LINE_CHARS + 1);
    const many = capLog(`${'y'.repeat(100)}\n`.repeat(200_000));
    expect(many.length).toBeLessThanOrEqual(MAX_LOG_CHARS + 1);
  });

  it('reads environment lines only inside their Set up job groups', () => {
    const env = parseJobEnv(['##[group]Runner Image', 'Image: ubuntu-24.04', 'Version: 1.2.3', '##[endgroup]', 'Version: 9.9.9', 'git version 2.56.0'].map((l) => `J\tS\t${l}`).join('\n'));
    expect(env).toEqual({ image: 'ubuntu-24.04', imageVersion: '1.2.3', git: '2.56.0' });
  });
});

describe('heal signatures', () => {
  it('the same failure in two runs gives the same sig8', () => {
    const shifted = fixture('git256-red.log').replace(/2026-10-27T16:/g, '2026-10-28T09:');
    const again = parseJob({ jobId: '999', name: 'Test', failedSteps: ['Run functional tests'] }, shifted, KNOWN);
    expect(runSignature([again]).sig8).toBe(runSignature([red()]).sig8);
    expect(jobSignature(red())).toBe(`Test\n${NONGIT.file} > ${NONGIT.title}`);
  });

  it('normalizes timestamps, durations, hex ids and runner temp paths in the error fallback', () => {
    expect(normalizeErrorLine('at 2026-10-27T10:00:00.1Z took 523ms in /home/runner/work/_temp/abc-1/x.sh id deadbeef12'))
      .toBe('at <time> took <dur> in <tmp> id <hex>');
    const a = synthetic('Build', ['##[error]Timed out after 12s in /tmp/omc-1a2b3c/run (sha 0123abcd)']);
    const b = synthetic('Build', ['##[error]Timed out after 97s in /tmp/omc-zzzz/run (sha 89efcdab)']);
    expect(runSignature([a]).sig8).toBe(runSignature([b]).sig8);
    expect(runSignature([a]).sig8).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('heal classifier', () => {
  it('model case: git256-red vs git256-green, red sha adds no code the green sha lacks -> env-change on imageVersion,git', () => {
    const input: ClassifyJobInput = {
      red: sample('40542274776', RED_SHA, red()),
      green: sample('40584638028', GREEN_SHA, green()),
      range: { commits: 0, codeFiles: 0, files: [] },
    };
    const job = classifyJob(input);
    expect(job.class).toBe('env-change');
    expect(job.env.changed.map((c) => c.field)).toEqual(['imageVersion', 'git']);
    const run = classifyRun({ signature: 's', sig8: 'abcd1234', firstRed: { runId: '40542274776', sha: RED_SHA }, jobs: [input] });
    expect(run).toMatchObject({ class: 'env-change', laneEligible: true, rerun: { command: 'gh run rerun 40542274776 --failed', issued: false } });
  });

  it('same sha green on one image and red on another -> env-change', () => {
    const job = classifyJob({ red: sample('2', RED_SHA, red()), sameShaGreen: [sample('3', RED_SHA, green())] });
    expect(job).toMatchObject({ class: 'env-change', sameShaImages: { green: '20261012.334.1', red: '20261025.353.1' } });
  });

  it('decision table: regression, regression-or-env, no-code-no-env, missing range, no baseline', () => {
    const r = sample('2', RED_SHA, red());
    const sameEnv = sample('1', GREEN_SHA, { ...green(), env: red().env });
    const g = sample('1', GREEN_SHA, green());
    const code = { commits: 3, codeFiles: 2, files: ['src/a.ts', 'src/b.ts', 'docs/c.md'] };
    expect(classifyJob({ red: r, green: sameEnv, range: code }).class).toBe('regression');
    expect(classifyJob({ red: r, green: g, range: code }).class).toBe('regression-or-env');
    expect(classifyJob({ red: r, green: g, range: { commits: 2, codeFiles: 0, files: ['docs/x.md'] } }).class).toBe('env-change');
    expect(classifyJob({ red: r, green: sameEnv, range: { commits: 0, codeFiles: 0, files: [] } }).class).toBe('intermittent');
    // Spec §3 step 5: unchanged env plus a non-empty sha range is a regression even with no code file in it.
    expect(classifyJob({ red: r, green: sameEnv, range: { commits: 2, codeFiles: 0, files: ['docs/x.md'] } }).class).toBe('regression');
    expect(classifyJob({ red: r, green: g }).class).toBe('regression-or-env');
    expect(classifyJob({ red: r, green: sameEnv }).class).toBe('regression');
    expect(classifyJob({ red: r }).class).toBe('unknown');
  });

  it('infra: a synthetic ETIMEDOUT install log', () => {
    const job = synthetic('Test', ['npm error code ETIMEDOUT', '##[error]Process completed with exit code 1.']);
    expect(classifyJob({ red: sample('1', RED_SHA, job) })).toMatchObject({ class: 'infra', infra: ['network'] });
    const run = classifyRun({ signature: 's', sig8: 'abcd1234', firstRed: { runId: '1', sha: RED_SHA }, jobs: [{ red: sample('1', RED_SHA, job) }] });
    expect(run).toMatchObject({ class: 'infra', laneEligible: false, rerun: { issued: false } });
  });

  it('infra patterns count only inside the failed step', () => {
    const lines = ['npm error code ETIMEDOUT', '##[error]Process completed with exit code 1.'];
    const log = [
      `Test\tInstall dependencies\t2026-10-27T10:00:00.0000000Z ${lines[0]}`,
      `Test\tRun tests\t2026-10-27T10:00:01.0000000Z ${lines[1]}`,
    ].join('\n');
    expect(parseJob({ jobId: '1', name: 'Test', failedSteps: ['Run tests'] }, log, KNOWN).infra).toEqual([]);
    expect(parseJob({ jobId: '1', name: 'Test', failedSteps: ['Install dependencies'] }, log, KNOWN).infra).toEqual(['network']);
  });

  it('known-flaky: a listed test that failed alone -> known-flaky, rerun intent once', () => {
    const job = synthetic('Test', [' FAIL  src/__tests__/session-end-process-exit.test.ts > suite > keeps the detached worker alive through producer grace', '##[error]Process completed with exit code 1.'], ['Run functional tests']);
    const run = classifyRun({ signature: 's', sig8: 'abcd1234', firstRed: { runId: '7', sha: RED_SHA }, jobs: [{ red: sample('7', RED_SHA, job) }] });
    expect(run).toMatchObject({ class: 'known-flaky', laneEligible: false, rerun: { command: 'gh run rerun 7 --failed' } });
  });

  it('a job without a failing test and no infra pattern is unknown', () => {
    const job = synthetic('Build', ['##[error]Process completed with exit code 2.'], ['Build']);
    expect(classifyJob({ red: sample('1', RED_SHA, job) }).class).toBe('unknown');
  });

  it('history: intermittent with green runs between failures, consistent since one point', () => {
    const t = [NONGIT];
    expect(historyPattern([
      { runId: '1', sha: 'a', green: false, failedTests: t },
      { runId: '2', sha: 'b', green: true },
      { runId: '3', sha: 'c', green: false, failedTests: t },
    ], t)).toBe('intermittent');
    expect(historyPattern([
      { runId: '1', sha: 'a', green: true },
      { runId: '2', sha: 'b', green: false, failedTests: t },
      { runId: '3', sha: 'c', green: false, failedTests: t },
    ], t)).toBe('consistent');
    const intermittent = classifyJob({
      red: sample('3', RED_SHA, red()), green: sample('2', GREEN_SHA, green()),
      history: [{ runId: '1', sha: 'a', green: false, failedTests: t }, { runId: '2', sha: 'b', green: true }, { runId: '3', sha: 'c', green: false, failedTests: t }],
    });
    expect(intermittent).toMatchObject({ class: 'intermittent', history: 'intermittent' });
  });

  it('the run takes the most severe job class', () => {
    const flaky = synthetic('Infra', ['ECONNRESET while fetching', '##[error]x']);
    const run = classifyRun({
      signature: 's', sig8: 'abcd1234', firstRed: { runId: '1', sha: RED_SHA },
      jobs: [{ red: sample('1', RED_SHA, flaky) }, { red: sample('1', RED_SHA, red()), green: sample('0', GREEN_SHA, { ...green(), env: red().env }), range: { commits: 1, codeFiles: 1, files: ['src/x.ts'] } }],
    });
    expect(run.class).toBe('regression');
    expect(run.rerun).toBeUndefined();
  });

  it('envDiff ignores fields missing on either side', () => {
    expect(envDiff({ git: '2.55.0' }, { git: '2.56.0', node: '20.0.0' })).toEqual([{ field: 'git', green: '2.55.0', red: '2.56.0' }]);
    expect(envDiff(undefined, { git: '2.56.0' })).toEqual([]);
  });
});
