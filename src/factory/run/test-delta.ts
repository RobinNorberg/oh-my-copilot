/**
 * The built-in vitest prepare check judged against the base, test by test.
 * Some tests cannot run in the OS sandbox on Windows (a process-tree kill, a
 * hard link or junction to a dir outside the checkout), so they fail on the
 * trusted base too. Without this, one such test parks every run that selects
 * its file (gate-sandbox-incompatible). With it, the head fails only for a
 * test (or a test file) that fails on the head and did not fail on the base;
 * tests that fail on both are listed, not counted.
 *
 * vitest writes a JSON report (`--reporter=json --outputFile=<file>`) into the
 * dir the command runs in: the only dir the sandbox lets it write that
 * outlives the command (the job home is removed with the runtime). The engine
 * reads and removes the file right after the run. The base's report comes
 * from the trusted base calibration only; the head's report decides only the
 * head's own failures.
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** One vitest run, as the verdict needs it. */
export interface VitestRunSummary {
  /** How many tests passed. */
  passed: number;
  /** The id (testId) of every failed test (file relative to the run dir), sorted, unique. */
  failed: string[];
  /** The id (testId of the file alone) of each test file that failed with no failed test of its own (the file did not load, or a hook failed), sorted. */
  brokenFiles: string[];
}

/** A report above this size is not read (no report: fail closed). */
export const VITEST_REPORT_MAX_BYTES = 32 * 1024 * 1024;
/** A base with more failing tests than this keeps today's park (the sandbox cannot run the suite); also bounds the sealed state. */
export const BASE_FAILURES_MAX = 200;
/** The longest test id (testId) the sealed state holds. */
export const TEST_ID_MAX_CHARS = 300;
/** The hash part of a test id: this many hex chars of sha256, then a space. */
const ID_HASH_CHARS = 16;

/**
 * A test's id: 16 hex chars of the sha256 of the whole tuple
 * `[file, ...describes, title]` as JSON (so " > " inside a name cannot
 * collide with the separator, and a long shared prefix is not cut away),
 * then a space and the readable `file > describe > title`, cut so the id
 * fits TEST_ID_MAX_CHARS. Two ids are equal only when their full tuples are
 * (up to the hash); the readable part is for people (testIdText).
 */
export function testId(parts: readonly string[]): string {
  const hash = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, ID_HASH_CHARS);
  return `${hash} ${parts.join(' > ')}`.slice(0, TEST_ID_MAX_CHARS);
}

/** The readable part of a test id (the hash left out); any other id as it is. */
export function testIdText(id: string): string {
  return /^[0-9a-f]{16} /.test(id) ? id.slice(ID_HASH_CHARS + 1) : id;
}

/** A fresh report file name in `dir` (random, so no file the PR's code left there is read by name). */
export function vitestReportPath(dir: string): string {
  return join(dir, `.omg-vitest-report-${randomBytes(6).toString('hex')}.json`);
}

/**
 * The vitest args that keep the console output and add the JSON report at
 * `path`. Coverage is off: a coverage threshold the project sets fails the
 * run with no failed test in the report (M1, review-548).
 */
export function vitestReportArgs(path: string): string[] {
  return ['--reporter=default', '--reporter=json', `--outputFile=${path}`, '--coverage.enabled=false'];
}

const slash = (p: string): string => p.replace(/\\/g, '/');

/** A report file name relative to `root` (case-insensitive prefix on Windows-style paths); left as it is when outside. */
function relative(name: string, root: string): string {
  const n = slash(name);
  const r = slash(root).replace(/\/+$/, '');
  return n.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? n.slice(r.length + 1) : n;
}

/**
 * vitest's JSON report (jest-compatible: testResults[].assertionResults[])
 * as a summary, or null when it is not one.
 */
export function parseVitestReport(text: string, root: string): VitestRunSummary | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const files = (data as { testResults?: unknown } | null)?.testResults;
  if (!Array.isArray(files)) return null;
  let passed = 0;
  const failed = new Set<string>();
  const broken = new Set<string>();
  for (const f of files as Array<Record<string, unknown>>) {
    if (typeof f !== 'object' || f === null || typeof f.name !== 'string' || !Array.isArray(f.assertionResults)) return null;
    const file = relative(f.name, root);
    let own = 0;
    for (const a of f.assertionResults as Array<Record<string, unknown>>) {
      if (typeof a !== 'object' || a === null || typeof a.title !== 'string') return null;
      if (a.status === 'passed') passed += 1;
      if (a.status !== 'failed') continue;
      own += 1;
      const ancestors = Array.isArray(a.ancestorTitles) ? a.ancestorTitles.filter((t): t is string => typeof t === 'string') : [];
      failed.add(testId([file, ...ancestors, a.title]));
    }
    if (f.status === 'failed' && own === 0) broken.add(testId([file]));
  }
  return { passed, failed: [...failed].sort(), brokenFiles: [...broken].sort() };
}

/** The report at `path` (its file names made relative to `root`), then the file removed; null when it is missing, too large or not a report. */
export function readVitestReport(path: string, root: string): VitestRunSummary | null {
  try {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      if (size > VITEST_REPORT_MAX_BYTES) return null;
      const buf = Buffer.alloc(size);
      let off = 0;
      while (off < size) {
        const n = readSync(fd, buf, off, size - off, off);
        if (n <= 0) break;
        off += n;
      }
      return parseVitestReport(buf.subarray(0, off).toString('utf8'), root);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  } finally {
    try { rmSync(path, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * The head's failures against the base's, for a head run that failed:
 * - `park` (today's gate-sandbox-incompatible): no base report, no test
 *   passes on the base, no head report, a failure in the output that the
 *   base has too, or anything the verdict cannot account for (testDeltaVerdict);
 * - `fail`: a test or file fails on the head that did not fail on the base
 *   (a new test counts: it never passed on the base);
 * - `pass`: every failure on the head failed on the base too (`excused`).
 */
export type TestDeltaVerdict =
  | { kind: 'park'; why: string }
  | { kind: 'fail'; counted: string[]; excused: string[] }
  | { kind: 'pass'; excused: string[] };

const fileId = (id: string): string => `${id} (the file failed)`;

/** What an error outside every test is listed as. */
export const UNHANDLED_ERRORS_ID = 'errors outside any test (vitest "Unhandled Errors")';
/** What a coverage threshold the run missed is listed as. */
export const COVERAGE_THRESHOLD_ID = 'a coverage threshold is not met';

/** Terminal color codes (FORCE_COLOR), taken out before any output is read. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * The failures in vitest's console output that its JSON report does not
 * hold, as ids: errors outside every test (the summary line `Errors  1
 * error`; the report says `success: true`, the exit code is 1) and a
 * coverage threshold the run missed (`... does not meet global threshold
 * ...`; the report args turn coverage off, so only a run that turns it back
 * on prints it). A head that forges a line only fails itself.
 */
export function vitestOutputFailures(output: string): string[] {
  const text = stripAnsi(output);
  return [
    ...(/^\s*Errors\s+\d+\s+errors?\b/m.test(text) ? [UNHANDLED_ERRORS_ID] : []),
    ...(/does not meet (?:global )?threshold/i.test(text) ? [COVERAGE_THRESHOLD_ID] : []),
  ];
}

/** vitest's summary counts of failed tests and test files (`Tests  2 failed | 5 passed (7)`); a count is left out when its line is not there. */
export function vitestSummaryFailed(output: string): { tests?: number; files?: number } {
  const text = stripAnsi(output);
  const tests = /^\s*Tests\s+(\d+)\s+failed\b/m.exec(text)?.[1];
  const files = /^\s*Test Files\s+(\d+)\s+failed\b/m.exec(text)?.[1];
  return { ...(tests ? { tests: Number(tests) } : {}), ...(files ? { files: Number(files) } : {}) };
}

/** The head run besides its report: its exit status, vitestOutputFailures and vitestSummaryFailed of its output. */
export interface HeadRunSignals {
  status: number;
  output: readonly string[];
  summary: { tests?: number; files?: number };
}

/** The head run's signals from its exit status and console output. */
export function headRunSignals(status: number, output: string): HeadRunSignals {
  return { status, output: vitestOutputFailures(output), summary: vitestSummaryFailed(output) };
}

/**
 * `head`'s failures against `base`'s. `signals`: the head run's exit status
 * and output (headRunSignals); `baseOutput`: vitestOutputFailures of the
 * base's output. An output failure on the head only counts like a new
 * failure; on both, the run parks (it cannot be told apart). When in doubt
 * it parks: an exit status other than vitest's 1 for failed tests, or a
 * summary that names more failed tests or files than the report.
 */
export function testDeltaVerdict(base: VitestRunSummary | undefined, head: VitestRunSummary | null, signals: HeadRunSignals = { status: 1, output: [], summary: {} }, baseOutput: readonly string[] = []): TestDeltaVerdict {
  if (!base) return { kind: 'park', why: 'the base run left no test report' };
  if (base.passed === 0) return { kind: 'park', why: 'no selected test passes on the base' };
  if (!head) return { kind: 'park', why: 'the head run left no test report' };
  if (signals.status !== 1) return { kind: 'park', why: `the head run exited ${signals.status}, not 1 (failed tests)` };
  const both = signals.output.filter((id) => baseOutput.includes(id));
  if (both.length > 0) return { kind: 'park', why: `${both.join(' and ')} on the base and the head` };
  if (signals.summary.tests !== undefined && signals.summary.tests > head.failed.length) return { kind: 'park', why: 'the head run\'s summary names more failed tests than its report' };
  const files = new Set([...head.failed.map((id) => testIdText(id).split(' > ')[0]), ...head.brokenFiles.map(testIdText)]);
  if (signals.summary.files !== undefined && signals.summary.files > files.size) return { kind: 'park', why: 'the head run\'s summary names more failed test files than its report' };
  const onHead = [...head.failed, ...head.brokenFiles.map(fileId), ...signals.output];
  if (onHead.length === 0) return { kind: 'park', why: 'the head run failed, but its report names no failing test' };
  const onBase = new Set([...base.failed, ...base.brokenFiles.map(fileId)]);
  const counted = onHead.filter((t) => !onBase.has(t));
  const excused = onHead.filter((t) => onBase.has(t));
  return counted.length > 0 ? { kind: 'fail', counted, excused } : { kind: 'pass', excused };
}

/** A summary the sealed state may hold (state.ts shape check). */
export function vitestSummaryShapeOk(v: unknown): v is VitestRunSummary {
  const s = v as Record<string, unknown> | null;
  const strs = (x: unknown) => Array.isArray(x) && x.length <= BASE_FAILURES_MAX && x.every((t) => typeof t === 'string' && t.length <= TEST_ID_MAX_CHARS);
  return typeof s === 'object' && s !== null && !Array.isArray(s) && Number.isSafeInteger(s.passed) && (s.passed as number) >= 0
    && strs(s.failed) && strs(s.brokenFiles) && Object.keys(s).every((k) => k === 'passed' || k === 'failed' || k === 'brokenFiles');
}
