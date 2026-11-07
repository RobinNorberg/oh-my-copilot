import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_GATE_CHECK, localChecks, readCheckRecordAt, readLocalCheckRecord, writeLocalCheckRecord } from '../checks.js';
import { localCheckRecordPath, localStoreDir } from '../mirror.js';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const dirs = [];
const temp = () => {
    const d = mkdtempSync(join(tmpdir(), 'omg-local-checks-'));
    dirs.push(d);
    return d;
};
afterEach(() => {
    for (const d of dirs.splice(0))
        rmSync(d, { recursive: true, force: true });
});
const record = (o = {}) => ({
    name: LOCAL_GATE_CHECK, head: A, state: 'SUCCESS', argv: ['npm', 'test'], runId: 7, startedAt: '2026-11-07T10:00:00Z', completedAt: '2026-11-07T10:01:00Z', exitCode: 0, tail: 'ok\n', ...o,
});
describe('local-gate records', () => {
    it('writes and reads back one record per head', () => {
        const state = temp();
        const path = writeLocalCheckRecord(state, '/repo', record());
        expect(path).toBe(localCheckRecordPath(state, '/repo', A));
        expect(readLocalCheckRecord(state, '/repo', A)).toEqual(record());
        expect(readLocalCheckRecord(state, '/repo', B)).toBeUndefined();
    });
    it('refuses to write a malformed record and reads none back for a bad head', () => {
        const state = temp();
        expect(() => writeLocalCheckRecord(state, '/repo', record({ state: 'GREEN' }))).toThrow(/malformed/);
        expect(() => writeLocalCheckRecord(state, '/repo', record({ head: 'HEAD' }))).toThrow(/malformed/);
        expect(() => readCheckRecordAt(state, '../x')).toThrow(/40-hex/);
    });
    it('refuses a record filed under another head and a malformed file', () => {
        const store = localStoreDir(temp(), '/repo');
        mkdirSync(join(store, 'checks'), { recursive: true });
        writeFileSync(join(store, 'checks', `${A}.json`), JSON.stringify(record({ head: B })));
        expect(() => readCheckRecordAt(store, A)).toThrow(/names/);
        writeFileSync(join(store, 'checks', `${B}.json`), '{');
        expect(() => readCheckRecordAt(store, B)).toThrow(/not valid JSON/);
    });
});
describe('localChecks', () => {
    const setup = (...records) => {
        const state = temp();
        for (const r of records)
            writeLocalCheckRecord(state, '/repo', r);
        const store = localStoreDir(state, '/repo');
        return { store, checks: localChecks(join(store, 'checks'), (h) => readCheckRecordAt(store, h)) };
    };
    it('reports the local-gate check for exactly the head asked for', () => {
        const { checks } = setup(record());
        expect(checks.checks(1, A)).toEqual([{
                name: 'local-gate', state: 'SUCCESS', bucket: 'pass', workflow: 'local-gate', startedAt: '2026-11-07T10:00:00Z', completedAt: '2026-11-07T10:01:00Z', runId: '7', jobId: `local-gate:${A}`,
            }]);
        expect(checks.checks(1, B)).toEqual([]);
        expect(checks.checks(1, 'not-a-sha')).toEqual([]);
        expect(checks.runsForHead(1, A)).toEqual([{ databaseId: 7, status: 'completed', conclusion: 'success', workflowName: 'local-gate', headSha: A }]);
        expect(checks.runsForHead(1, B)).toEqual([]);
    });
    it('maps PENDING and FAILURE', () => {
        const { checks } = setup(record({ state: 'PENDING', completedAt: undefined }), record({ head: B, state: 'FAILURE', runId: 8 }));
        expect(checks.checks(1, A)[0]).toMatchObject({ state: 'PENDING', bucket: 'pending' });
        expect(checks.checks(1, A)[0]).not.toHaveProperty('completedAt');
        expect(checks.runsForHead(1, A)).toEqual([{ databaseId: 7, status: 'in_progress', workflowName: 'local-gate', headSha: A }]);
        expect(checks.checks(1, B)[0]).toMatchObject({ state: 'FAILURE', bucket: 'fail' });
        expect(checks.runsForHead(1, B)[0]).toMatchObject({ conclusion: 'failure' });
    });
    it('jobLog returns the captured tail', () => {
        const { checks } = setup(record());
        expect(checks.jobLog(`local-gate:${A}`)).toEqual({ ok: true, text: 'ok\n' });
        expect(checks.jobLog(`local-gate:${B}`).ok).toBe(false);
        expect(checks.jobLog('123').ok).toBe(false);
    });
    it('rerun removes a finished run so the engine runs the gate again; refuses a running or unknown one', () => {
        const { store, checks } = setup(record({ state: 'FAILURE' }), record({ head: B, state: 'PENDING', runId: 9 }));
        expect(checks.rerun(1, '9')).toEqual({ ok: false, stderr: expect.stringContaining('still running') });
        expect(checks.rerun(1, '42').ok).toBe(false);
        expect(checks.rerun(1, 'x').ok).toBe(false);
        expect(checks.rerun(1, '7')).toEqual({ ok: true, stderr: '' });
        expect(existsSync(join(store, 'checks', `${A}.json`))).toBe(false);
        expect(checks.checks(1, A)).toEqual([]);
    });
    it('has no transient errors', () => {
        expect(setup().checks.transientError.test('HTTP 502')).toBe(false);
    });
});
//# sourceMappingURL=checks.test.js.map