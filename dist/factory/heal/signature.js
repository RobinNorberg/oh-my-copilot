/**
 * Failure signatures (design §2): the dedupe key of a red CI run. Per failed
 * job: the job name plus the sorted `file > title` set from parseFailingTests,
 * or, with no FAIL line, the failing step plus the first `##[error]` line with
 * timestamps, durations, hex ids and runner temp paths normalized away. The
 * run signature is the sha256 of the sorted job signatures; sig8 is its first
 * 8 hex characters.
 */
import { createHash } from 'crypto';
const MAX_ERROR_CHARS = 300;
/** Strip the parts of an error line that differ between two runs of the same failure. */
export function normalizeErrorLine(line) {
    return line
        .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<time>')
        .replace(/(?:\/home\/runner\/work\/_temp|\/tmp|[A-Za-z]:\\(?:a\\_temp|Users\\runneradmin\\AppData\\Local\\Temp))[\\/][^\s'"]*/g, '<tmp>')
        .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|m)\b/g, '<dur>')
        .replace(/\b[0-9a-f]{7,64}\b/gi, '<hex>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_ERROR_CHARS);
}
export function jobSignature(job) {
    if (job.failingTests.length > 0) {
        const tests = job.failingTests.map((t) => (t.title ? `${t.file} > ${t.title}` : t.file)).sort();
        return [job.name, ...tests].join('\n');
    }
    const step = [...job.failedSteps].sort()[0] ?? '(unknown step)';
    return [job.name, `step: ${step}`, `error: ${normalizeErrorLine(job.firstError ?? '')}`].join('\n');
}
export function runSignature(jobs) {
    const sigs = jobs.map(jobSignature).sort();
    const signature = createHash('sha256').update(sigs.join('\u0000')).digest('hex');
    return { signature, sig8: signature.slice(0, 8), jobs: sigs };
}
//# sourceMappingURL=signature.js.map