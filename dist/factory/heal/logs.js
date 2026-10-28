/**
 * Job-log parsing for `omg factory heal` (design §3 step 1). CI logs are
 * untrusted input: they are only ever matched against fixed regexes here,
 * never evaluated or interpolated into a command, and every read is capped.
 * Failing tests, blockers and the known-flaky verdict come from
 * src/ship/gates.ts unchanged.
 */
import { analyzeFailedLog } from '../../ship/gates.js';
/** A log longer than this keeps its head (setup lines) and its tail (the failures). */
export const MAX_LOG_CHARS = 8 * 1024 * 1024;
const HEAD_CHARS = 512 * 1024;
/** Lines longer than this are cut before any regex runs on them. */
export const MAX_LINE_CHARS = 4000;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
// \p{Cf}: the byte-order mark GitHub puts before the first timestamp of each step.
const GH_LOG_PREFIX = /^[^\t]*\t[^\t]*\t\p{Cf}?(?:\d{4}-\d\d-\d\dT[\d:.]+Z ?)?/u;
/** Cap the log's size and its line lengths; the result is what every parser sees. */
export function capLog(log) {
    const sized = log.length > MAX_LOG_CHARS
        ? `${log.slice(0, HEAD_CHARS)}\n${log.slice(log.length - (MAX_LOG_CHARS - HEAD_CHARS))}`
        : log;
    return sized.split(/\r?\n/).map((l) => (l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) : l)).join('\n');
}
/** One log line without ANSI codes, the `job<TAB>step<TAB>` prefix and the timestamp. */
export function cleanLine(rawLine) {
    return rawLine.replace(ANSI, '').replace(GH_LOG_PREFIX, '').replace(/^\p{Cf}/u, '');
}
export const ENV_FIELDS = ['image', 'imageVersion', 'runnerVersion', 'git', 'node', 'npm'];
const VERSION = /^[\w.+-]{1,64}$/;
/**
 * Runner metadata from the "Set up job" group lines (`Image:`, the image
 * `Version:` after it, the provisioner `Version:`), `git version` from
 * checkout and `node:` / `npm:` from setup-node's environment details.
 * The first value of each field wins.
 */
export function parseJobEnv(log) {
    const env = {};
    let group = '';
    const set = (key, value) => {
        const v = value?.trim();
        if (env[key] === undefined && v && VERSION.test(v))
            env[key] = v;
    };
    for (const raw of log.split(/\r?\n/)) {
        const line = cleanLine(raw).trim();
        const g = /^##\[group\](.*)$/.exec(line);
        if (g) {
            group = g[1].trim();
            continue;
        }
        if (line === '##[endgroup]') {
            group = '';
            continue;
        }
        let m;
        if ((m = /^Image: (\S+)$/.exec(line)))
            set('image', m[1]);
        else if ((m = /^Version: (\S+)$/.exec(line))) {
            if (group === 'Runner Image')
                set('imageVersion', m[1]);
            else if (group === 'Runner Image Provisioner')
                set('runnerVersion', m[1]);
        }
        else if ((m = /^git version (\d+\.\d+\.\d+\S*)$/.exec(line)))
            set('git', m[1]);
        else if ((m = /^node: v?(\d+\.\d+\.\d+)$/.exec(line)))
            set('node', m[1]);
        else if ((m = /^npm: (\d+\.\d+\.\d+)$/.exec(line)))
            set('npm', m[1]);
    }
    return env;
}
/** Fixed infra patterns (design §3 step 2); a job with a FAIL line is never infra. */
const INFRA_PATTERNS = [
    { name: 'runner-lost', re: /lost communication with the server|The runner has received a shutdown signal/i },
    { name: 'cancelled', re: /The operation was canceled\./ },
    { name: 'network', re: /\b(?:ETIMEDOUT|ECONNRESET|EAI_AGAIN)\b/ },
    { name: 'registry-5xx', re: /\b(?:npm (?:ERR!|error) code E5\d\d|5\d\d (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)\b.*(?:registry\.npmjs\.org|github\.com|githubusercontent\.com))/i },
    { name: 'disk-full', re: /\bENOSPC\b|No space left on device/ },
];
/** With `failedSteps`, only lines of those steps count: a test that prints `ETIMEDOUT` is not an infra failure. */
export function infraMatches(log, failedSteps = []) {
    const hits = new Set();
    for (const raw of log.split(/\r?\n/)) {
        const cols = raw.split('\t');
        if (failedSteps.length > 0 && cols.length >= 3 && !failedSteps.includes(cols[1]))
            continue;
        const line = cleanLine(raw);
        for (const p of INFRA_PATTERNS)
            if (p.re.test(line))
                hits.add(p.name);
    }
    return [...hits];
}
/** The first `##[error]` line, cleaned (the signature's fallback when no test failed). */
export function firstErrorLine(log) {
    for (const raw of log.split(/\r?\n/)) {
        const line = cleanLine(raw);
        const i = line.indexOf('##[error]');
        if (i >= 0)
            return line.slice(i + '##[error]'.length).trim();
    }
    return undefined;
}
export function parseJob(job, rawLog, known) {
    const log = capLog(rawLog);
    const analysis = analyzeFailedLog(job.name, undefined, log, known, job.jobId);
    const firstError = firstErrorLine(log);
    return {
        jobId: job.jobId,
        name: job.name,
        failedSteps: job.failedSteps,
        failingTests: analysis.failingTests,
        blockers: analysis.blockers,
        knownFlaky: analysis.knownFlaky,
        infra: analysis.failingTests.length === 0 ? infraMatches(log, job.failedSteps) : [],
        ...(firstError ? { firstError } : {}),
        env: parseJobEnv(log),
    };
}
//# sourceMappingURL=logs.js.map