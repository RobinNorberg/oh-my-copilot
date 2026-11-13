/**
 * test-delta.ts: the built-in vitest check judged per test against the base.
 * Hand-built reports in vitest's JSON shape (testResults[].assertionResults[]),
 * plus one real report (fixtures/vitest-report.json, from `vitest run
 * --reporter=json` on vitest 4, file names moved under C:/work/repo and
 * stack traces cut to their first line).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BASE_FAILURES_MAX, COVERAGE_THRESHOLD_ID, headRunSignals, IMPORT_DANGER_ID, parseVitestReport, readVitestReport, stripAnsi, testDeltaVerdict, testId, testIdText, TEST_ID_MAX_CHARS, UNHANDLED_ERRORS_ID,
  vitestOutputFailures, vitestReportArgs, vitestReportPath, vitestSummaryFailed, vitestSummaryShapeOk, type VitestRunSummary,
} from '../test-delta.js';
import { createFactoryState, parseFactoryState } from '../state.js';

const HERE = dirname(fileURLToPath(import.meta.url));

type T = [title: string, status: 'passed' | 'failed' | 'skipped'];

/** One file's entry; `loadError` = vitest's shape of a file that did not load (failed, no assertions). */
const file = (root: string, rel: string, tests: T[], loadError?: string, ancestors: string[] = ['group']) => ({
  name: `${root}/${rel}`,
  status: loadError !== undefined || tests.some(([, s]) => s === 'failed') ? 'failed' : 'passed',
  message: loadError ?? '',
  assertionResults: tests.map(([title, status]) => ({ ancestorTitles: ancestors, fullName: `${ancestors.join(' ')} ${title}`, title, status, failureMessages: status === 'failed' ? ['AssertionError'] : [] })),
});

const report = (...files: ReturnType<typeof file>[]) => JSON.stringify({ numTotalTests: 0, success: false, testResults: files });

/** A test's id from its parts. */
const id = (...parts: string[]) => testId(parts);
/** A broken file's id, as the verdict lists it. */
const fileFailed = (rel: string) => `${testId([rel])} (the file failed)`;

const BASE_ROOT = 'C:/Users/me/.omg/state/factory-gates/base-abc';
const HEAD_ROOT = 'C:/Users/me/.omg/state/factory-checkouts/issue-7';
const ENGINE = 'src/release/__tests__/engine.test.ts';

/** The process-tree kill test fails on the base in the sandbox; the rest passes. */
const base = parseVitestReport(report(
  file(BASE_ROOT, ENGINE, [['kills the tree', 'failed'], ['plans', 'passed'], ['tags', 'passed']]),
  file(BASE_ROOT, 'src/a.test.ts', [['adds', 'passed']]),
), BASE_ROOT)!;

/** A failed head run's signals: exit 1, nothing else in the output (its summary line counted as there; N3 has its own test). */
const failedRun = (output = '') => { const s = headRunSignals(1, output); return { ...s, summary: { ...s.summary, seen: true } }; };

describe('parseVitestReport', () => {
  it('names failed tests by relative file, describe and title; counts passes; a failed file without a failed test is broken', () => {
    const r = parseVitestReport(report(
      file(HEAD_ROOT, 'src/a.test.ts', [['adds', 'passed'], ['subtracts', 'failed'], ['later', 'skipped']]),
      file(HEAD_ROOT, 'src/b.test.ts', [], 'Cannot find module'),
    ), HEAD_ROOT);
    expect(r).toEqual({ passed: 1, failed: [id('src/a.test.ts', 'group', 'subtracts')], brokenFiles: [id('src/b.test.ts')], failedFiles: 2 });
    expect(testIdText(r!.failed[0])).toBe('src/a.test.ts > group > subtracts');
  });

  it('a real vitest JSON report (fixture): nested describes, a skipped test, a file that did not load', () => {
    const text = readFileSync(join(HERE, 'fixtures', 'vitest-report.json'), 'utf8');
    const r = parseVitestReport(text, 'C:/work/repo');
    expect(r).toEqual({ passed: 1, failed: [id('src/a.test.ts', 'outer', 'inner > part', 'fails')], brokenFiles: [id('src/b.test.ts')], failedFiles: 2 });
    // Its console summary (same run) agrees with the report: no park for a count the report lacks.
    const summary = '\n Test Files  2 failed (2)\n      Tests  1 failed | 1 passed | 1 skipped (3)\n   Start at  04:37:32\n';
    expect(vitestSummaryFailed(summary)).toEqual({ tests: 1, files: 2, seen: true });
    expect(testDeltaVerdict({ passed: 3, failed: [], brokenFiles: [] }, r, failedRun(summary))).toEqual({
      kind: 'fail', counted: [id('src/a.test.ts', 'outer', 'inner > part', 'fails'), fileFailed('src/b.test.ts')], excused: [],
    });
  });

  it('Windows paths: backslashes and the drive letter case do not matter', () => {
    const r = parseVitestReport(report(file('c:\\Users\\me\\repo', 'src\\a.test.ts', [['adds', 'failed']])), 'C:\\Users\\me\\repo');
    expect(r?.failed).toEqual([id('src/a.test.ts', 'group', 'adds')]);
  });

  it('not a report: null', () => {
    expect(parseVitestReport('not json', HEAD_ROOT)).toBeNull();
    expect(parseVitestReport('{}', HEAD_ROOT)).toBeNull();
    expect(parseVitestReport(JSON.stringify({ testResults: [{ name: 1, assertionResults: [] }] }), HEAD_ROOT)).toBeNull();
  });
});

describe('test ids (L2, review-548)', () => {
  it('" > " inside a name does not collide with the separator', () => {
    expect(id('a.test.ts', 'x > y', 'z')).not.toBe(id('a.test.ts', 'x', 'y > z'));
    expect(testIdText(id('a.test.ts', 'x > y', 'z'))).toBe(testIdText(id('a.test.ts', 'x', 'y > z')));
    const b = parseVitestReport(report(file(BASE_ROOT, 'src/a.test.ts', [['y > z', 'failed'], ['ok', 'passed']], undefined, ['x'])), BASE_ROOT)!;
    const h = parseVitestReport(report(file(HEAD_ROOT, 'src/a.test.ts', [['z', 'failed']], undefined, ['x > y'])), HEAD_ROOT)!;
    expect(testDeltaVerdict(b, h, failedRun()).kind).toBe('fail');
  });

  it('a long shared prefix: two tests that differ only past the readable cut stay apart; the same test matches', () => {
    const long = 'x'.repeat(2 * TEST_ID_MAX_CHARS);
    const b = parseVitestReport(report(file(BASE_ROOT, 'src/a.test.ts', [[`${long} one`, 'failed'], ['ok', 'passed']])), BASE_ROOT)!;
    const same = parseVitestReport(report(file(HEAD_ROOT, 'src/a.test.ts', [[`${long} one`, 'failed']])), HEAD_ROOT)!;
    const other = parseVitestReport(report(file(HEAD_ROOT, 'src/a.test.ts', [[`${long} two`, 'failed']])), HEAD_ROOT)!;
    expect(b.failed[0]).toHaveLength(TEST_ID_MAX_CHARS);
    expect(testIdText(b.failed[0])).toBe(testIdText(other.failed[0]));
    expect(testDeltaVerdict(b, same, failedRun()).kind).toBe('pass');
    expect(testDeltaVerdict(b, other, failedRun()).kind).toBe('fail');
  });
});

describe('testDeltaVerdict', () => {
  const head = (...files: ReturnType<typeof file>[]) => parseVitestReport(report(...files), HEAD_ROOT);

  it('a new failure (a test the base passed) fails the head; the base failure is listed, not counted', () => {
    const v = testDeltaVerdict(base, head(
      file(HEAD_ROOT, ENGINE, [['kills the tree', 'failed'], ['plans', 'failed'], ['tags', 'passed']]),
    ), failedRun());
    expect(v).toEqual({ kind: 'fail', counted: [id(ENGINE, 'group', 'plans')], excused: [id(ENGINE, 'group', 'kills the tree')] });
  });

  it('the same failure as on the base: a pass, with the base failure listed', () => {
    const v = testDeltaVerdict(base, head(
      file(HEAD_ROOT, ENGINE, [['kills the tree', 'failed'], ['plans', 'passed'], ['tags', 'passed'], ['new test', 'passed']]),
    ), failedRun());
    expect(v).toEqual({ kind: 'pass', excused: [id(ENGINE, 'group', 'kills the tree')] });
  });

  it('a new test (head only) must pass', () => {
    const v = testDeltaVerdict(base, head(
      file(HEAD_ROOT, ENGINE, [['kills the tree', 'failed'], ['brand new', 'failed']]),
    ), failedRun());
    expect(v.kind).toBe('fail');
    expect(v.kind === 'fail' && v.counted).toEqual([id(ENGINE, 'group', 'brand new')]);
  });

  it('a file that loads on the base and fails to load on the head fails the head', () => {
    const v = testDeltaVerdict(base, head(
      file(HEAD_ROOT, ENGINE, [['kills the tree', 'failed']]),
      file(HEAD_ROOT, 'src/a.test.ts', [], 'SyntaxError'),
    ), failedRun());
    expect(v).toEqual({ kind: 'fail', counted: [fileFailed('src/a.test.ts')], excused: [id(ENGINE, 'group', 'kills the tree')] });
  });

  it('a file that fails to load on both: not counted', () => {
    const b = parseVitestReport(report(file(BASE_ROOT, 'src/link.test.ts', [], 'EPERM: operation not permitted, link'), file(BASE_ROOT, 'src/a.test.ts', [['adds', 'passed']])), BASE_ROOT)!;
    expect(testDeltaVerdict(b, head(file(HEAD_ROOT, 'src/link.test.ts', [], 'EPERM')), failedRun()).kind).toBe('pass');
  });

  it('a test that failed on the base and was renamed or removed on the head: fine', () => {
    expect(testDeltaVerdict(base, head(file(HEAD_ROOT, 'src/a.test.ts', [['adds', 'passed'], ['other', 'failed']])), failedRun()).kind).toBe('fail');
    const v = testDeltaVerdict(base, head(file(HEAD_ROOT, ENGINE, [['kills the tree', 'failed'], ['kills the tree (renamed)', 'passed']])), failedRun());
    expect(v.kind).toBe('pass');
  });

  it('errors outside any test (vitest prints "Errors  N error", the JSON report says nothing): head only fails, both park', () => {
    const summary = '\n Test Files  1 passed (1)\n      Tests  1 passed (1)\n     Errors  1 error\n   Duration  782ms\n';
    expect(vitestOutputFailures(summary)).toEqual([UNHANDLED_ERRORS_ID]);
    expect(vitestOutputFailures(' Test Files  1 failed (1)\n      Tests  1 failed (1)\n')).toEqual([]);
    const sameFailure = head(file(HEAD_ROOT, ENGINE, [['kills the tree', 'failed']]));
    expect(testDeltaVerdict(base, sameFailure, failedRun(summary))).toEqual({ kind: 'fail', counted: [UNHANDLED_ERRORS_ID], excused: [id(ENGINE, 'group', 'kills the tree')] });
    expect(testDeltaVerdict(base, head(file(HEAD_ROOT, 'src/a.test.ts', [['adds', 'passed']])), failedRun(summary)).kind).toBe('fail');
    expect(testDeltaVerdict(base, sameFailure, failedRun(summary), [UNHANDLED_ERRORS_ID]).kind).toBe('park');
    expect(testDeltaVerdict(base, sameFailure, failedRun(), [UNHANDLED_ERRORS_ID]).kind).toBe('pass');
  });

  it('M1: colored output (FORCE_COLOR) is read without its color codes', () => {
    // vitest's colored summary: a dim label, then the count in bold red.
    const colored = '\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m\x1b[2m (1)\x1b[22m\n\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[1m\x1b[32m2 passed\x1b[39m\x1b[22m\x1b[90m (3)\x1b[39m\n\x1b[2m     Errors \x1b[22m \x1b[1m\x1b[31m1 error\x1b[39m\x1b[22m\n';
    expect(stripAnsi(colored)).toContain('     Errors  1 error');
    expect(vitestOutputFailures(colored)).toEqual([UNHANDLED_ERRORS_ID]);
    expect(vitestSummaryFailed(colored)).toEqual({ tests: 1, files: 1, seen: true });
    const sameFailure = head(file(HEAD_ROOT, ENGINE, [['kills the tree', 'failed'], ['plans', 'passed'], ['tags', 'passed']]));
    expect(testDeltaVerdict(base, sameFailure, failedRun(colored))).toEqual({ kind: 'fail', counted: [UNHANDLED_ERRORS_ID], excused: [id(ENGINE, 'group', 'kills the tree')] });
  });

  it('M1: a coverage threshold the head misses counts; one on both parks', () => {
    const out = 'ERROR: Coverage for lines (41.2%) does not meet global threshold (80%)\n';
    expect(vitestOutputFailures(out)).toEqual([COVERAGE_THRESHOLD_ID]);
    expect(vitestOutputFailures('ERROR: Coverage for branches (10%) does not meet threshold (50%) for src/a.ts\n')).toEqual([COVERAGE_THRESHOLD_ID]);
    const sameFailure = head(file(HEAD_ROOT, ENGINE, [['kills the tree', 'failed']]));
    expect(testDeltaVerdict(base, sameFailure, failedRun(out))).toEqual({ kind: 'fail', counted: [COVERAGE_THRESHOLD_ID], excused: [id(ENGINE, 'group', 'kills the tree')] });
    expect(testDeltaVerdict(base, sameFailure, failedRun(out), [COVERAGE_THRESHOLD_ID]).kind).toBe('park');
  });

  it('M1, when in doubt: an exit status other than 1, or a summary with more failures than the report, parks', () => {
    const sameFailure = head(file(HEAD_ROOT, ENGINE, [['kills the tree', 'failed']]));
    expect(testDeltaVerdict(base, sameFailure, headRunSignals(2, ''))).toEqual({ kind: 'park', why: 'the head run exited 2, not 1 (failed tests)' });
    expect(testDeltaVerdict(base, sameFailure, failedRun('      Tests  2 failed | 1 passed (3)\n')).kind).toBe('park');
    expect(testDeltaVerdict(base, sameFailure, failedRun(' Test Files  2 failed (2)\n      Tests  1 failed (1)\n')).kind).toBe('park');
    expect(testDeltaVerdict(base, sameFailure, failedRun(' Test Files  1 failed (1)\n      Tests  1 failed (1)\n')).kind).toBe('pass');
  });

  it('N1: an error of the file itself (a hook) beside an excused test counts when the base file had none; on both it is excused', () => {
    const hook = { ...file(HEAD_ROOT, ENGINE, [['kills the tree', 'failed'], ['plans', 'passed'], ['tags', 'passed']]), message: 'afterAll hook failed' };
    const h = head(hook)!;
    expect(h.brokenFiles).toEqual([id(ENGINE)]);
    expect(testDeltaVerdict(base, h, failedRun())).toEqual({ kind: 'fail', counted: [fileFailed(ENGINE)], excused: [id(ENGINE, 'group', 'kills the tree')] });
    const b = parseVitestReport(report({ ...file(BASE_ROOT, ENGINE, [['kills the tree', 'failed'], ['plans', 'passed']]), message: 'afterAll hook failed' }), BASE_ROOT)!;
    expect(testDeltaVerdict(b, h, failedRun()).kind).toBe('pass');
    // A whitespace-only message is none.
    expect(head({ ...hook, message: '  ' })!.brokenFiles).toEqual([]);
  });

  it('N2: an import over vitest\'s danger threshold (failOnDanger) on the head only counts; on both it parks', () => {
    const out = '\x1b[31mERROR: 2 import(s) exceeded the danger threshold of 500ms\x1b[39m\n';
    expect(vitestOutputFailures(out)).toEqual([IMPORT_DANGER_ID]);
    const sameFailure = head(file(HEAD_ROOT, ENGINE, [['kills the tree', 'failed']]));
    expect(testDeltaVerdict(base, sameFailure, failedRun(out))).toEqual({ kind: 'fail', counted: [IMPORT_DANGER_ID], excused: [id(ENGINE, 'group', 'kills the tree')] });
    expect(testDeltaVerdict(base, sameFailure, failedRun(out), [IMPORT_DANGER_ID]).kind).toBe('park');
  });

  it('N3: a head run that exits 1 with no Tests or Test Files summary line parks', () => {
    const sameFailure = head(file(HEAD_ROOT, ENGINE, [['kills the tree', 'failed']]));
    expect(vitestSummaryFailed('nothing here\n')).toEqual({ seen: false });
    expect(vitestSummaryFailed('      Tests  1 passed (1)\n')).toEqual({ seen: true });
    expect(testDeltaVerdict(base, sameFailure, headRunSignals(1, 'killed\n'))).toEqual({ kind: 'park', why: 'the head run\'s output has no vitest summary (Tests or Test Files)' });
    expect(testDeltaVerdict(base, sameFailure, headRunSignals(1, ' Test Files  1 failed (1)\n      Tests  1 failed (1)\n')).kind).toBe('pass');
  });

  it('N4: failed files are counted by their full names, not the cut readable id', () => {
    // Two files whose names share the first TEST_ID_MAX_CHARS chars: one readable prefix, two files.
    const long = `src/${'d'.repeat(TEST_ID_MAX_CHARS)}`;
    const h = head(file(HEAD_ROOT, `${long}/one.test.ts`, [['x', 'failed']]), file(HEAD_ROOT, `${long}/two.test.ts`, [['x', 'failed']]))!;
    expect(h.failedFiles).toBe(2);
    expect(new Set(h.failed.map((t) => testIdText(t).split(' > ')[0])).size).toBe(1);
    const b = parseVitestReport(report(file(BASE_ROOT, `${long}/one.test.ts`, [['x', 'failed']]), file(BASE_ROOT, `${long}/two.test.ts`, [['x', 'failed']]), file(BASE_ROOT, 'src/a.test.ts', [['adds', 'passed']])), BASE_ROOT)!;
    expect(testDeltaVerdict(b, h, failedRun(' Test Files  2 failed (2)\n      Tests  2 failed (2)\n')).kind).toBe('pass');
    expect(testDeltaVerdict(b, h, failedRun(' Test Files  3 failed (3)\n      Tests  2 failed (2)\n')).kind).toBe('park');
  });

  it('park (today\'s gate-sandbox-incompatible): no base report, nothing passes on the base, no head report, or a head failure outside every test', () => {
    const headOk = head(file(HEAD_ROOT, ENGINE, [['kills the tree', 'failed']]));
    expect(testDeltaVerdict(undefined, headOk, failedRun())).toEqual({ kind: 'park', why: 'the base run left no test report' });
    const allFail: VitestRunSummary = { passed: 0, failed: [id('src/a.test.ts', 'group', 'adds')], brokenFiles: [] };
    expect(testDeltaVerdict(allFail, headOk, failedRun()).kind).toBe('park');
    expect(testDeltaVerdict(base, null, failedRun())).toEqual({ kind: 'park', why: 'the head run left no test report' });
    expect(testDeltaVerdict(base, head(file(HEAD_ROOT, 'src/a.test.ts', [['adds', 'passed']])), failedRun()).kind).toBe('park');
  });
});

describe('the report file', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a fresh random name in the run dir; vitest keeps its console output, adds the JSON report, runs without coverage', () => {
    dir = mkdtempSync(join(tmpdir(), 'omg-test-delta-'));
    const p = vitestReportPath(dir);
    expect(p.startsWith(dir)).toBe(true);
    expect(p).toMatch(/\.omg-vitest-report-[0-9a-f]{12}\.json$/);
    expect(vitestReportPath(dir)).not.toBe(p);
    expect(vitestReportArgs(p)).toEqual(['--reporter=default', '--reporter=json', `--outputFile=${p}`, '--coverage.enabled=false']);
  });

  it('readVitestReport reads, then removes the file; a missing or broken file is null (and removed)', () => {
    dir = mkdtempSync(join(tmpdir(), 'omg-test-delta-'));
    const p = vitestReportPath(dir);
    writeFileSync(p, report(file(dir.replace(/\\/g, '/'), 'src/a.test.ts', [['adds', 'failed']])));
    expect(readVitestReport(p, dir)?.failed).toEqual([id('src/a.test.ts', 'group', 'adds')]);
    expect(existsSync(p)).toBe(false);
    expect(readVitestReport(p, dir)).toBeNull();
    writeFileSync(p, '{"testResults":');
    expect(readVitestReport(p, dir)).toBeNull();
    expect(existsSync(p)).toBe(false);
  });
});

describe('vitestSummaryShapeOk (the sealed state)', () => {
  it('accepts a summary, refuses extra keys, non-strings, over-long lists and ids', () => {
    expect(vitestSummaryShapeOk(base)).toBe(true);
    expect(vitestSummaryShapeOk({ ...base, extra: 1 })).toBe(false);
    expect(vitestSummaryShapeOk({ ...base, failedFiles: 2 })).toBe(true);
    expect(vitestSummaryShapeOk({ ...base, failedFiles: -1 })).toBe(false);
    expect(vitestSummaryShapeOk({ ...base, failedFiles: '2' })).toBe(false);
    expect(vitestSummaryShapeOk({ ...base, failed: [1] })).toBe(false);
    expect(vitestSummaryShapeOk({ ...base, passed: -1 })).toBe(false);
    expect(vitestSummaryShapeOk({ ...base, failed: Array.from({ length: BASE_FAILURES_MAX + 1 }, (_, i) => `t${i}`) })).toBe(false);
    expect(vitestSummaryShapeOk({ ...base, brokenFiles: ['x'.repeat(TEST_ID_MAX_CHARS + 1)] })).toBe(false);
    expect(vitestSummaryShapeOk(null)).toBe(false);
  });

  it('the run state: testDeltaExcusedHead is a full sha, gateCalibration tests a summary', () => {
    const s = createFactoryState({ issue: 7, repoUrl: 'https://github.com/o/r', base: 'dev' }, '2026-11-13T00:00:00.000Z');
    const sha = 'a'.repeat(40);
    expect(parseFactoryState('run-7.json', 7, JSON.stringify({ ...s, testDeltaExcusedHead: sha })).testDeltaExcusedHead).toBe(sha);
    expect(() => parseFactoryState('run-7.json', 7, JSON.stringify({ ...s, testDeltaExcusedHead: 'abc' }))).toThrow(/field testDeltaExcusedHead/);
    expect(() => parseFactoryState('run-7.json', 7, JSON.stringify({ ...s, testDeltaExcusedHead: true }))).toThrow(/field testDeltaExcusedHead/);
    const cal = (tests: unknown) => JSON.stringify({ ...s, gateCalibration: { ['b'.repeat(64)]: { ok: false, tests } } });
    expect(parseFactoryState('run-7.json', 7, cal(base)).gateCalibration?.['b'.repeat(64)].tests).toEqual(base);
    expect(() => parseFactoryState('run-7.json', 7, cal({ ...base, extra: 1 }))).toThrow(/field gateCalibration/);
    // M1 (review-550): the plain-before-head marker and the run's plain-code flag are `true` only.
    const plainCal = (v: unknown) => JSON.stringify({ ...s, gateCalibration: { ['b'.repeat(64)]: { ok: false, beforePlainHead: v } } });
    expect(parseFactoryState('run-7.json', 7, plainCal(true)).gateCalibration?.['b'.repeat(64)].beforePlainHead).toBe(true);
    expect(() => parseFactoryState('run-7.json', 7, plainCal(false))).toThrow(/field gateCalibration/);
    expect(parseFactoryState('run-7.json', 7, JSON.stringify({ ...s, plainHeadRan: true })).plainHeadRan).toBe(true);
    expect(() => parseFactoryState('run-7.json', 7, JSON.stringify({ ...s, plainHeadRan: 1 }))).toThrow(/field plainHeadRan/);
  });
});
