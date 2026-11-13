/**
 * test-delta.ts: the built-in vitest check judged per test against the base.
 * Hand-built reports in vitest's JSON shape (testResults[].assertionResults[]).
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BASE_FAILURES_MAX, parseVitestReport, readVitestReport, testDeltaVerdict, TEST_ID_MAX_CHARS, UNHANDLED_ERRORS_ID, vitestReportArgs, vitestReportPath, vitestSummaryShapeOk, vitestUnhandledErrors, type VitestRunSummary,
} from '../test-delta.js';

type T = [title: string, status: 'passed' | 'failed' | 'skipped'];

/** One file's entry; `loadError` = vitest's shape of a file that did not load (failed, no assertions). */
const file = (root: string, rel: string, tests: T[], loadError?: string) => ({
  name: `${root}/${rel}`,
  status: loadError !== undefined || tests.some(([, s]) => s === 'failed') ? 'failed' : 'passed',
  message: loadError ?? '',
  assertionResults: tests.map(([title, status]) => ({ ancestorTitles: ['group'], fullName: `group ${title}`, title, status, failureMessages: status === 'failed' ? ['AssertionError'] : [] })),
});

const report = (...files: ReturnType<typeof file>[]) => JSON.stringify({ numTotalTests: 0, success: false, testResults: files });

const BASE_ROOT = 'C:/Users/me/.omg/state/factory-gates/base-abc';
const HEAD_ROOT = 'C:/Users/me/.omg/state/factory-checkouts/issue-7';

/** The process-tree kill test fails on the base in the sandbox; the rest passes. */
const base = parseVitestReport(report(
  file(BASE_ROOT, 'src/release/__tests__/engine.test.ts', [['kills the tree', 'failed'], ['plans', 'passed'], ['tags', 'passed']]),
  file(BASE_ROOT, 'src/a.test.ts', [['adds', 'passed']]),
), BASE_ROOT)!;

describe('parseVitestReport', () => {
  it('names failed tests by relative file, describe and title; counts passes; a failed file without a failed test is broken', () => {
    const r = parseVitestReport(report(
      file(HEAD_ROOT, 'src/a.test.ts', [['adds', 'passed'], ['subtracts', 'failed'], ['later', 'skipped']]),
      file(HEAD_ROOT, 'src/b.test.ts', [], 'Cannot find module'),
    ), HEAD_ROOT);
    expect(r).toEqual({ passed: 1, failed: ['src/a.test.ts > group > subtracts'], brokenFiles: ['src/b.test.ts'] });
  });

  it('Windows paths: backslashes and the drive letter case do not matter', () => {
    const r = parseVitestReport(report(file('c:\\Users\\me\\repo', 'src\\a.test.ts', [['adds', 'failed']])), 'C:\\Users\\me\\repo');
    expect(r?.failed).toEqual(['src/a.test.ts > group > adds']);
  });

  it('not a report: null', () => {
    expect(parseVitestReport('not json', HEAD_ROOT)).toBeNull();
    expect(parseVitestReport('{}', HEAD_ROOT)).toBeNull();
    expect(parseVitestReport(JSON.stringify({ testResults: [{ name: 1, assertionResults: [] }] }), HEAD_ROOT)).toBeNull();
  });

  it('a test id is cut to TEST_ID_MAX_CHARS, the same on both sides', () => {
    const long = 'x'.repeat(2 * TEST_ID_MAX_CHARS);
    const b = parseVitestReport(report(file(BASE_ROOT, 'src/a.test.ts', [[long, 'failed'], ['ok', 'passed']])), BASE_ROOT)!;
    const h = parseVitestReport(report(file(HEAD_ROOT, 'src/a.test.ts', [[long, 'failed']])), HEAD_ROOT)!;
    expect(b.failed[0]).toHaveLength(TEST_ID_MAX_CHARS);
    expect(testDeltaVerdict(b, h).kind).toBe('pass');
  });
});

describe('testDeltaVerdict', () => {
  const head = (...files: ReturnType<typeof file>[]) => parseVitestReport(report(...files), HEAD_ROOT);

  it('a new failure (a test the base passed) fails the head; the base failure is listed, not counted', () => {
    const v = testDeltaVerdict(base, head(
      file(HEAD_ROOT, 'src/release/__tests__/engine.test.ts', [['kills the tree', 'failed'], ['plans', 'failed'], ['tags', 'passed']]),
    ));
    expect(v).toEqual({ kind: 'fail', counted: ['src/release/__tests__/engine.test.ts > group > plans'], excused: ['src/release/__tests__/engine.test.ts > group > kills the tree'] });
  });

  it('the same failure as on the base: a pass, with the base failure listed', () => {
    const v = testDeltaVerdict(base, head(
      file(HEAD_ROOT, 'src/release/__tests__/engine.test.ts', [['kills the tree', 'failed'], ['plans', 'passed'], ['tags', 'passed'], ['new test', 'passed']]),
    ));
    expect(v).toEqual({ kind: 'pass', excused: ['src/release/__tests__/engine.test.ts > group > kills the tree'] });
  });

  it('a new test (head only) must pass', () => {
    const v = testDeltaVerdict(base, head(
      file(HEAD_ROOT, 'src/release/__tests__/engine.test.ts', [['kills the tree', 'failed'], ['brand new', 'failed']]),
    ));
    expect(v.kind).toBe('fail');
    expect(v.kind === 'fail' && v.counted).toEqual(['src/release/__tests__/engine.test.ts > group > brand new']);
  });

  it('a file that loads on the base and fails to load on the head fails the head', () => {
    const v = testDeltaVerdict(base, head(
      file(HEAD_ROOT, 'src/release/__tests__/engine.test.ts', [['kills the tree', 'failed']]),
      file(HEAD_ROOT, 'src/a.test.ts', [], 'SyntaxError'),
    ));
    expect(v).toEqual({ kind: 'fail', counted: ['src/a.test.ts (the file failed)'], excused: ['src/release/__tests__/engine.test.ts > group > kills the tree'] });
  });

  it('a file that fails to load on both: not counted', () => {
    const b = parseVitestReport(report(file(BASE_ROOT, 'src/link.test.ts', [], 'EPERM: operation not permitted, link'), file(BASE_ROOT, 'src/a.test.ts', [['adds', 'passed']])), BASE_ROOT)!;
    expect(testDeltaVerdict(b, head(file(HEAD_ROOT, 'src/link.test.ts', [], 'EPERM'))).kind).toBe('pass');
  });

  it('a test that failed on the base and was renamed or removed on the head: fine', () => {
    expect(testDeltaVerdict(base, head(file(HEAD_ROOT, 'src/a.test.ts', [['adds', 'passed'], ['other', 'failed']]))).kind).toBe('fail');
    const v = testDeltaVerdict(base, head(file(HEAD_ROOT, 'src/release/__tests__/engine.test.ts', [['kills the tree', 'failed'], ['kills the tree (renamed)', 'passed']])));
    expect(v.kind).toBe('pass');
  });

  it('errors outside any test (vitest prints "Errors  N error", the JSON report says nothing): head only fails, both park', () => {
    const summary = '\n Test Files  1 passed (1)\n      Tests  1 passed (1)\n     Errors  1 error\n   Duration  782ms\n';
    expect(vitestUnhandledErrors(summary)).toBe(true);
    expect(vitestUnhandledErrors(' Test Files  1 failed (1)\n      Tests  1 failed (1)\n')).toBe(false);
    const sameFailure = head(file(HEAD_ROOT, 'src/release/__tests__/engine.test.ts', [['kills the tree', 'failed']]));
    expect(testDeltaVerdict(base, sameFailure, { head: true, base: false })).toEqual({ kind: 'fail', counted: [UNHANDLED_ERRORS_ID], excused: ['src/release/__tests__/engine.test.ts > group > kills the tree'] });
    expect(testDeltaVerdict(base, head(file(HEAD_ROOT, 'src/a.test.ts', [['adds', 'passed']])), { head: true, base: false }).kind).toBe('fail');
    expect(testDeltaVerdict(base, sameFailure, { head: true, base: true }).kind).toBe('park');
    expect(testDeltaVerdict(base, sameFailure, { head: false, base: true }).kind).toBe('pass');
  });

  it('park (today\'s gate-sandbox-incompatible): no base report, nothing passes on the base, no head report, or a head failure outside every test', () => {
    const headOk = head(file(HEAD_ROOT, 'src/release/__tests__/engine.test.ts', [['kills the tree', 'failed']]));
    expect(testDeltaVerdict(undefined, headOk)).toEqual({ kind: 'park', why: 'the base run left no test report' });
    const allFail: VitestRunSummary = { passed: 0, failed: ['src/a.test.ts > group > adds'], brokenFiles: [] };
    expect(testDeltaVerdict(allFail, headOk).kind).toBe('park');
    expect(testDeltaVerdict(base, null)).toEqual({ kind: 'park', why: 'the head run left no test report' });
    expect(testDeltaVerdict(base, head(file(HEAD_ROOT, 'src/a.test.ts', [['adds', 'passed']]))).kind).toBe('park');
  });
});

describe('the report file', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a fresh random name in the run dir; vitest keeps its console output and adds the JSON report', () => {
    dir = mkdtempSync(join(tmpdir(), 'omg-test-delta-'));
    const p = vitestReportPath(dir);
    expect(p.startsWith(dir)).toBe(true);
    expect(p).toMatch(/\.omg-vitest-report-[0-9a-f]{12}\.json$/);
    expect(vitestReportPath(dir)).not.toBe(p);
    expect(vitestReportArgs(p)).toEqual(['--reporter=default', '--reporter=json', `--outputFile=${p}`]);
  });

  it('readVitestReport reads, then removes the file; a missing or broken file is null (and removed)', () => {
    dir = mkdtempSync(join(tmpdir(), 'omg-test-delta-'));
    const p = vitestReportPath(dir);
    writeFileSync(p, report(file(dir.replace(/\\/g, '/'), 'src/a.test.ts', [['adds', 'failed']])));
    expect(readVitestReport(p, dir)?.failed).toEqual(['src/a.test.ts > group > adds']);
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
    expect(vitestSummaryShapeOk({ ...base, failed: [1] })).toBe(false);
    expect(vitestSummaryShapeOk({ ...base, passed: -1 })).toBe(false);
    expect(vitestSummaryShapeOk({ ...base, failed: Array.from({ length: BASE_FAILURES_MAX + 1 }, (_, i) => `t${i}`) })).toBe(false);
    expect(vitestSummaryShapeOk({ ...base, brokenFiles: ['x'.repeat(TEST_ID_MAX_CHARS + 1)] })).toBe(false);
    expect(vitestSummaryShapeOk(null)).toBe(false);
  });
});
