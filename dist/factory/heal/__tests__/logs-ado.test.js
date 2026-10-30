/**
 * Azure Pipelines log lines start with `2026-10-28T11:12:00.0000000Z `
 * (src/forge/ado/__tests__/fixtures/build.logs.GET.101-7.json), not GitHub's
 * `job<TAB>step<TAB>timestamp`. Cleaned, they parse like GitHub lines: the
 * FAIL lines become failing tests, so a heal signature names the tests.
 */
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { ADO_FIXTURE_DIR } from '../../../forge/ado/__tests__/fixtures.js';
import { cleanLine, parseJob } from '../logs.js';
import { sanitizeLine } from '../sanitize.js';
import { jobSignature } from '../signature.js';
const FIXTURE = JSON.parse(readFileSync(`${ADO_FIXTURE_DIR}/build.logs.GET.101-7.json`, 'utf8'));
const LOG = FIXTURE.stdout.value.join('\n');
const job = { jobId: '101:7e570002-0000-4000-8000-000000000002', name: 'Test', failedSteps: ['Run tests'] };
const at = (log, stamp) => log.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, stamp);
describe('heal log cleaning on Azure Pipelines logs', () => {
    it('cleanLine strips the ADO timestamp (and a leading byte-order mark); GitHub lines are cleaned as before', () => {
        expect(cleanLine('2026-10-28T11:12:00.0000000Z FAIL src/report.test.ts > exports CSV')).toBe('FAIL src/report.test.ts > exports CSV');
        expect(cleanLine('﻿2026-10-28T11:10:00.0000000Z ##[section]Starting: Run tests')).toBe('##[section]Starting: Run tests');
        expect(cleanLine('test\tRun npm test\t﻿2026-10-28T11:12:00.1234567Z  FAIL  a.test.ts')).toBe(' FAIL  a.test.ts');
        // Without a timestamp at the start nothing is cut.
        expect(cleanLine('FAIL at 2026-10-28T11:12:00Z x')).toBe('FAIL at 2026-10-28T11:12:00Z x');
        expect(sanitizeLine('2026-10-28T11:12:01.0000000Z ##[error]Process completed with exit code 1.')).toBe('##[error]Process completed with exit code 1.');
    });
    it('the failing test of an ADO log is parsed, so the signature names it', () => {
        const parsed = parseJob(job, LOG, []);
        expect(parsed.failingTests).toEqual([{ file: 'src/report.test.ts', title: 'exports CSV' }]);
        expect(jobSignature(parsed)).toBe('Test\nsrc/report.test.ts > exports CSV');
    });
    it('two logs differing only in timestamps have the same signature; different failing tests do not', () => {
        const a = jobSignature(parseJob(job, at(LOG, '2026-10-28T11:12:00.0000000Z'), []));
        const b = jobSignature(parseJob(job, at(LOG, '2026-10-29T08:01:59.9999999Z'), []));
        expect(a).toBe(b);
        const other = jobSignature(parseJob(job, LOG.replace('exports CSV', 'exports PDF'), []));
        expect(other).not.toBe(a);
    });
});
//# sourceMappingURL=logs-ado.test.js.map