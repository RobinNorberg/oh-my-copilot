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
import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** One vitest run, as the verdict needs it. */
export interface VitestRunSummary {
  /** How many tests passed. */
  passed: number;
  /** `<file> > <describe> > <test>` of every failed test (file relative to the run dir), sorted, unique. */
  failed: string[];
  /** Test files that failed with no failed test of their own (the file did not load, or a hook failed), relative, sorted. */
  brokenFiles: string[];
}

/** A report above this size is not read (no report: fail closed). */
export const VITEST_REPORT_MAX_BYTES = 32 * 1024 * 1024;
/** A base with more failing tests than this keeps today's park (the sandbox cannot run the suite); also bounds the sealed state. */
export const BASE_FAILURES_MAX = 200;
/** Each test id is cut to this length, the same way on the base and the head. */
export const TEST_ID_MAX_CHARS = 300;

/** A fresh report file name in `dir` (random, so no file the PR's code left there is read by name). */
export function vitestReportPath(dir: string): string {
  return join(dir, `.omg-vitest-report-${randomBytes(6).toString('hex')}.json`);
}

/** The vitest args that keep the console output and add the JSON report at `path`. */
export function vitestReportArgs(path: string): string[] {
  return ['--reporter=default', '--reporter=json', `--outputFile=${path}`];
}

const slash = (p: string): string => p.replace(/\\/g, '/');

/** A report file name relative to `root` (case-insensitive prefix on Windows-style paths); left as it is when outside. */
function relative(name: string, root: string): string {
  const n = slash(name);
  const r = slash(root).replace(/\/+$/, '');
  return n.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? n.slice(r.length + 1) : n;
}

const cut = (id: string): string => (id.length > TEST_ID_MAX_CHARS ? id.slice(0, TEST_ID_MAX_CHARS) : id);

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
      failed.add(cut([file, ...ancestors, a.title].join(' > ')));
    }
    if (f.status === 'failed' && own === 0) broken.add(cut(file));
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
 *   passes on the base, no head report, or the head failed with no failing
 *   test or file in its report (something else failed: not attributable);
 * - `fail`: a test or file fails on the head that did not fail on the base
 *   (a new test counts: it never passed on the base);
 * - `pass`: every failure on the head failed on the base too (`excused`).
 */
export type TestDeltaVerdict =
  | { kind: 'park'; why: string }
  | { kind: 'fail'; counted: string[]; excused: string[] }
  | { kind: 'pass'; excused: string[] };

const fileId = (file: string): string => `${file} (the file failed)`;

export function testDeltaVerdict(base: VitestRunSummary | undefined, head: VitestRunSummary | null): TestDeltaVerdict {
  if (!base) return { kind: 'park', why: 'the base run left no test report' };
  if (base.passed === 0) return { kind: 'park', why: 'no selected test passes on the base' };
  if (!head) return { kind: 'park', why: 'the head run left no test report' };
  const onHead = [...head.failed, ...head.brokenFiles.map(fileId)];
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
