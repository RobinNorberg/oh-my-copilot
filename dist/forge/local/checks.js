/**
 * The local forge's one check (offline forge plan §1.1): the engine runs
 * factory.forge.local.gate once per pushed head in its prepare checkout and
 * records `local-gate` here (writeLocalCheckRecord, under the engine-owned
 * store). checks()/runsForHead() read that record back for exactly the head
 * asked for and nothing else, so gates-driver and ship watchGates keep their
 * head discipline unchanged.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { localCheckRecordPath, localStoreDir } from './mirror.js';
import { writeAtomic } from './store.js';
/** The one check name the local forge reports. */
export const LOCAL_GATE_CHECK = 'local-gate';
const HEX40 = /^[0-9a-f]{40}$/;
function validRecord(r) {
    const x = r;
    return !!x && x.name === LOCAL_GATE_CHECK && typeof x.head === 'string' && HEX40.test(x.head)
        && (x.state === 'PENDING' || x.state === 'SUCCESS' || x.state === 'FAILURE')
        && Array.isArray(x.argv) && x.argv.every((a) => typeof a === 'string')
        && Number.isSafeInteger(x.runId) && x.runId > 0 && typeof x.startedAt === 'string'
        && (x.completedAt === undefined || typeof x.completedAt === 'string')
        && (x.exitCode === undefined || Number.isInteger(x.exitCode))
        && (x.tail === undefined || typeof x.tail === 'string');
}
function readRecordFile(path) {
    if (!existsSync(path))
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch (err) {
        throw new Error(`local forge: the check record ${path} is not valid JSON (${err.message})`);
    }
    if (!validRecord(parsed))
        throw new Error(`local forge: the check record ${path} is malformed`);
    return parsed;
}
/** Write `record` atomically to localCheckRecordPath(stateDir, root, record.head); returns the path. */
export function writeLocalCheckRecord(stateDir, root, record) {
    if (!validRecord(record))
        throw new Error('local forge: refusing to write a malformed local-gate record');
    const path = localCheckRecordPath(stateDir, root, record.head);
    writeAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
    return path;
}
/** The record for `head` under a store directory (localStoreDir), or undefined; throws on a malformed file or one recorded for another head. */
export function readCheckRecordAt(storeDir, head) {
    if (!HEX40.test(head))
        throw new Error(`local forge: expected a 40-hex head sha, got ${JSON.stringify(head)}`);
    const record = readRecordFile(join(storeDir, 'checks', `${head}.json`));
    if (record && record.head !== head)
        throw new Error(`local forge: the check record for ${head} names ${record.head}`);
    return record;
}
/** The record for `head`, or undefined; throws on a malformed file or one recorded for another head. */
export function readLocalCheckRecord(stateDir, root, head) {
    return readCheckRecordAt(localStoreDir(stateDir, root), head);
}
const BUCKET = { PENDING: 'pending', SUCCESS: 'pass', FAILURE: 'fail' };
const CONCLUSION = { SUCCESS: 'success', FAILURE: 'failure' };
const jobIdOf = (head) => `${LOCAL_GATE_CHECK}:${head}`;
/**
 * ForgeChecks over the records in `<storeDir>/checks`. `recordFor(head)`
 * reads one head's record. rerun() removes the record of that run, so the
 * engine sees no check for the head and runs the gate again (the adapter
 * never runs anything itself).
 */
export function localChecks(checksDir, recordFor) {
    const forHead = (headSha) => (HEX40.test(headSha) ? recordFor(headSha) : undefined);
    return {
        checks(_pr, headSha) {
            const r = forHead(headSha);
            if (!r)
                return [];
            return [{
                    name: LOCAL_GATE_CHECK,
                    state: r.state,
                    bucket: BUCKET[r.state],
                    workflow: LOCAL_GATE_CHECK,
                    startedAt: r.startedAt,
                    ...(r.completedAt ? { completedAt: r.completedAt } : {}),
                    runId: String(r.runId),
                    jobId: jobIdOf(r.head),
                }];
        },
        runsForHead(_pr, headSha) {
            const r = forHead(headSha);
            if (!r)
                return [];
            return [{
                    databaseId: r.runId,
                    status: r.state === 'PENDING' ? 'in_progress' : 'completed',
                    ...(r.state === 'PENDING' ? {} : { conclusion: CONCLUSION[r.state] }),
                    workflowName: LOCAL_GATE_CHECK,
                    headSha: r.head,
                }];
        },
        jobLog(jobId) {
            const m = new RegExp(`^${LOCAL_GATE_CHECK}:([0-9a-f]{40})$`).exec(jobId);
            if (!m)
                return { ok: false, text: `not a local-gate job id: ${jobId}` };
            try {
                const r = recordFor(m[1]);
                return r ? { ok: true, text: r.tail ?? '' } : { ok: false, text: `no local-gate record for ${m[1]}` };
            }
            catch (err) {
                return { ok: false, text: err.message };
            }
        },
        rerun(_pr, runId) {
            try {
                if (!/^[1-9]\d*$/.test(runId) || !existsSync(checksDir))
                    return { ok: false, stderr: `no local-gate run ${runId}` };
                for (const name of readdirSync(checksDir)) {
                    const m = /^([0-9a-f]{40})\.json$/.exec(name);
                    if (!m)
                        continue;
                    const r = recordFor(m[1]);
                    if (r && String(r.runId) === runId) {
                        if (r.state === 'PENDING')
                            return { ok: false, stderr: `local-gate run ${runId} is still running` };
                        rmSync(join(checksDir, name), { force: true });
                        return { ok: true, stderr: '' };
                    }
                }
                return { ok: false, stderr: `no local-gate run ${runId}` };
            }
            catch (err) {
                return { ok: false, stderr: err.message };
            }
        },
        // Nothing remote to be transient: never matches.
        transientError: /(?!)/,
    };
}
//# sourceMappingURL=checks.js.map