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
/** A report above this size is not read (no report: fail closed). */
export const VITEST_REPORT_MAX_BYTES = 32 * 1024 * 1024;
/** A base with more failing tests than this keeps today's park (the sandbox cannot run the suite); also bounds the sealed state. */
export const BASE_FAILURES_MAX = 200;
/** Each test id is cut to this length, the same way on the base and the head. */
export const TEST_ID_MAX_CHARS = 300;
/** A fresh report file name in `dir` (random, so no file the PR's code left there is read by name). */
export function vitestReportPath(dir) {
    return join(dir, `.omg-vitest-report-${randomBytes(6).toString('hex')}.json`);
}
/** The vitest args that keep the console output and add the JSON report at `path`. */
export function vitestReportArgs(path) {
    return ['--reporter=default', '--reporter=json', `--outputFile=${path}`];
}
const slash = (p) => p.replace(/\\/g, '/');
/** A report file name relative to `root` (case-insensitive prefix on Windows-style paths); left as it is when outside. */
function relative(name, root) {
    const n = slash(name);
    const r = slash(root).replace(/\/+$/, '');
    return n.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? n.slice(r.length + 1) : n;
}
const cut = (id) => (id.length > TEST_ID_MAX_CHARS ? id.slice(0, TEST_ID_MAX_CHARS) : id);
/**
 * vitest's JSON report (jest-compatible: testResults[].assertionResults[])
 * as a summary, or null when it is not one.
 */
export function parseVitestReport(text, root) {
    let data;
    try {
        data = JSON.parse(text);
    }
    catch {
        return null;
    }
    const files = data?.testResults;
    if (!Array.isArray(files))
        return null;
    let passed = 0;
    const failed = new Set();
    const broken = new Set();
    for (const f of files) {
        if (typeof f !== 'object' || f === null || typeof f.name !== 'string' || !Array.isArray(f.assertionResults))
            return null;
        const file = relative(f.name, root);
        let own = 0;
        for (const a of f.assertionResults) {
            if (typeof a !== 'object' || a === null || typeof a.title !== 'string')
                return null;
            if (a.status === 'passed')
                passed += 1;
            if (a.status !== 'failed')
                continue;
            own += 1;
            const ancestors = Array.isArray(a.ancestorTitles) ? a.ancestorTitles.filter((t) => typeof t === 'string') : [];
            failed.add(cut([file, ...ancestors, a.title].join(' > ')));
        }
        if (f.status === 'failed' && own === 0)
            broken.add(cut(file));
    }
    return { passed, failed: [...failed].sort(), brokenFiles: [...broken].sort() };
}
/** The report at `path` (its file names made relative to `root`), then the file removed; null when it is missing, too large or not a report. */
export function readVitestReport(path, root) {
    try {
        const fd = openSync(path, 'r');
        try {
            const size = fstatSync(fd).size;
            if (size > VITEST_REPORT_MAX_BYTES)
                return null;
            const buf = Buffer.alloc(size);
            let off = 0;
            while (off < size) {
                const n = readSync(fd, buf, off, size - off, off);
                if (n <= 0)
                    break;
                off += n;
            }
            return parseVitestReport(buf.subarray(0, off).toString('utf8'), root);
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        return null;
    }
    finally {
        try {
            rmSync(path, { force: true });
        }
        catch { /* best effort */ }
    }
}
const fileId = (file) => `${file} (the file failed)`;
/** What an error outside every test is listed as. */
export const UNHANDLED_ERRORS_ID = 'errors outside any test (vitest "Unhandled Errors")';
/**
 * vitest's summary line for errors outside every test (`Errors  1 error`).
 * The JSON report does not hold them (it says `success: true`), but the exit
 * code is 1. Read from the output tail: a head that forges the line only
 * fails itself.
 */
export function vitestUnhandledErrors(output) {
    return /^\s*Errors\s+\d+\s+errors?\b/m.test(output);
}
/**
 * `unhandled`: whether each run printed vitest's unhandled-errors summary
 * (vitestUnhandledErrors). On the head only, it counts like a new failure;
 * on both, the run parks (it cannot be told apart).
 */
export function testDeltaVerdict(base, head, unhandled = { head: false, base: false }) {
    if (!base)
        return { kind: 'park', why: 'the base run left no test report' };
    if (base.passed === 0)
        return { kind: 'park', why: 'no selected test passes on the base' };
    if (!head)
        return { kind: 'park', why: 'the head run left no test report' };
    if (unhandled.head && unhandled.base)
        return { kind: 'park', why: 'errors outside any test on the base and the head' };
    const onHead = [...head.failed, ...head.brokenFiles.map(fileId), ...(unhandled.head ? [UNHANDLED_ERRORS_ID] : [])];
    if (onHead.length === 0)
        return { kind: 'park', why: 'the head run failed, but its report names no failing test' };
    const onBase = new Set([...base.failed, ...base.brokenFiles.map(fileId)]);
    const counted = onHead.filter((t) => !onBase.has(t));
    const excused = onHead.filter((t) => onBase.has(t));
    return counted.length > 0 ? { kind: 'fail', counted, excused } : { kind: 'pass', excused };
}
/** A summary the sealed state may hold (state.ts shape check). */
export function vitestSummaryShapeOk(v) {
    const s = v;
    const strs = (x) => Array.isArray(x) && x.length <= BASE_FAILURES_MAX && x.every((t) => typeof t === 'string' && t.length <= TEST_ID_MAX_CHARS);
    return typeof s === 'object' && s !== null && !Array.isArray(s) && Number.isSafeInteger(s.passed) && s.passed >= 0
        && strs(s.failed) && strs(s.brokenFiles) && Object.keys(s).every((k) => k === 'passed' || k === 'failed' || k === 'brokenFiles');
}
//# sourceMappingURL=test-delta.js.map