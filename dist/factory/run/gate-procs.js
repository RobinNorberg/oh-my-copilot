/**
 * Process bookkeeping for the local gate (hardening sweep, night 3): what the
 * gate started that can outlive the engine or the gate's root process.
 *
 * The record sits next to the gate's check record in the engine-owned forge
 * state dir, never in a lane-writable root. Its pids are untrusted: a pid
 * persisted by an engine that has since died may belong to an unrelated
 * process by now. Nothing is signalled unless the process's start identity
 * (the same identity the team runtime uses) still equals the recorded one.
 *
 * - POSIX: the gate leads a detached process group. The leader's pid, start
 *   identity and group id are recorded at spawn; before the next gate run a
 *   leftover group is killed only while its leader still runs with that
 *   identity.
 * - Windows: there is no group. When the gate's root exited but a descendant
 *   still holds the output pipes, the root's remaining children (created
 *   between the gate's start and the root's exit) are recorded with their
 *   start identity and killed with their trees; the next gate run kills
 *   recorded ones that still match.
 */
import { execFile } from 'child_process';
import { spawnSync } from 'child_process';
import { readdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { localStoreDir } from '../../forge/local/mirror.js';
import { writeAtomic } from '../../forge/local/store.js';
import { getProcessStartIdentity, getProcessStartIdentitySync, terminateOwnedProcessGroup, terminateOwnedProcessTree } from '../../platform/process-utils.js';
const execFileAsync = promisify(execFile);
/** How long one cleanup step (listing, identity, kill) may take. */
const STEP_DEADLINE_MS = 15_000;
const HEX40 = /^[0-9a-f]{40}$/;
/** liveGateProcs could not tell: a record dir or record is unreadable, so a gate process may still run (fail closed). */
export class GateProcsUnreadableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'GateProcsUnreadableError';
    }
}
export const gateProcsPath = (stateDir, root, head) => {
    if (!HEX40.test(head))
        throw new Error(`gate-procs: ${JSON.stringify(head)} is not a 40-hex commit`);
    return join(localStoreDir(stateDir, root), 'gate-procs', `${head}.json`);
};
const isProc = (p) => {
    const r = p;
    return !!r && Number.isInteger(r.pid) && r.pid > 0 && typeof r.identity === 'string' && r.identity.length > 0 && r.identity.length < 64;
};
/** The record at `path`; undefined when absent or not a well-formed record (it is then ignored, never trusted). */
export function readGateProcs(path) {
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return undefined;
    }
    if (!parsed || parsed.version !== 1 || typeof parsed.startedAt !== 'string' || !Array.isArray(parsed.orphans) || !parsed.orphans.every(isProc))
        return undefined;
    if (parsed.root !== undefined && !isProc(parsed.root))
        return undefined;
    // The gate is detached, so its group id is its own pid: a record naming any other group is forged.
    if (parsed.pgid !== undefined && !(Number.isInteger(parsed.pgid) && parsed.root !== undefined && parsed.pgid === parsed.root.pid))
        return undefined;
    return parsed;
}
const TICKS_AT_EPOCH = 621355968000000000n;
const ticksOfMs = (ms) => BigInt(Math.trunc(ms)) * 10000n + TICKS_AT_EPOCH;
/** CIM reports creation times to the microsecond, Get-Process to 100 ns: compare at the microsecond. */
const sameMicrosecond = (identity, created) => {
    const m = /^ticks:(\d+)$/.exec(identity);
    return !!m && BigInt(m[1]) / 10n === created / 10n;
};
async function listWindowsChildren(rootPid) {
    const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${rootPid}" | ForEach-Object { "$($_.ProcessId) " + ([DateTime]$_.CreationDate).ToUniversalTime().Ticks }`;
    const { stdout } = await execFileAsync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: STEP_DEADLINE_MS, windowsHide: true });
    const out = [];
    for (const line of stdout.split(/\r?\n/)) {
        const m = /^(\d+) (\d+)$/.exec(line.trim());
        if (m && Number(m[1]) > 0)
            out.push({ pid: Number(m[1]), created: BigInt(m[2]) });
    }
    return out;
}
/** The start identity of `pid` through the absolute powershell (a bare name could resolve to a planted binary, and the engine's search-path hardening runs after the pre-run reap). */
function windowsIdentitySync(pid) {
    const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = `$p = Get-Process -Id ${pid} -ErrorAction Stop; if ($p -and $p.StartTime) { $p.StartTime.ToUniversalTime().Ticks }`;
    try {
        const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 8000, windowsHide: true });
        const ticks = r.status === 0 ? r.stdout.trim().match(/^\d+$/)?.[0] : undefined;
        return ticks ? `ticks:${ticks}` : null;
    }
    catch {
        return null;
    }
}
export const defaultGateProcDeps = () => ({
    platform: process.platform,
    identitySync: process.platform === 'win32' ? windowsIdentitySync : getProcessStartIdentitySync,
    identity: (pid, deadlineAt) => getProcessStartIdentity(pid, deadlineAt),
    terminateTree: (p) => terminateOwnedProcessTree({ pid: p.pid, expectedStartIdentity: p.identity, deadlineAt: new Date(Date.now() + STEP_DEADLINE_MS).toISOString(), force: true }),
    terminateGroup: (p, pgid) => terminateOwnedProcessGroup({ pid: p.pid, expectedStartIdentity: p.identity, processGroupId: pgid, deadlineAt: new Date(Date.now() + STEP_DEADLINE_MS).toISOString(), force: true }),
    listChildren: listWindowsChildren,
});
/** Record what the gate at `path` starts. A write failure is swallowed: bookkeeping must never decide a verdict. */
export function createGateProcTracker(path, startedAtMs, deps = defaultGateProcDeps(), warn) {
    const record = { version: 1, startedAt: new Date(startedAtMs).toISOString(), orphans: [] };
    let rootPid = 0;
    const save = () => {
        try {
            writeAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
        }
        catch { /* best effort */ }
    };
    return {
        spawned(pid) {
            rootPid = pid;
            const identity = deps.identitySync(pid);
            if (identity) {
                record.root = { pid, identity };
                if (deps.platform !== 'win32')
                    record.pgid = pid;
                save();
            }
            else {
                warn?.(`the gate process ${pid} could not be identified, so it is not recorded and an engine crash would leave it unreaped`);
            }
        },
        async rootGone(exitedAtMs) {
            if (deps.platform !== 'win32' || !rootPid)
                return;
            let kids;
            try {
                kids = await deps.listChildren(rootPid);
            }
            catch {
                return;
            }
            // Created inside the gate's window: a later process that reused the root's pid is not the root's child.
            const from = ticksOfMs(startedAtMs);
            const to = ticksOfMs(exitedAtMs);
            for (const k of kids) {
                if (k.created < from || k.created > to)
                    continue;
                const identity = await deps.identity(k.pid, Date.now() + STEP_DEADLINE_MS);
                if (!identity || !sameMicrosecond(identity, k.created))
                    continue;
                record.orphans.push({ pid: k.pid, identity });
            }
            if (record.orphans.length === 0)
                return;
            save();
            const left = [];
            for (const o of record.orphans) {
                const done = await deps.terminateTree(o).catch(() => 'unknown');
                if (done !== 'terminated' && done !== 'already-dead' && done !== 'identity-mismatch')
                    left.push(o);
            }
            record.orphans = left;
            save();
        },
    };
}
/**
 * Kill what an earlier gate run for this head left behind, then forget it.
 * Only a process whose start identity still equals the recorded one is
 * signalled. A POSIX group is signalled only through its recorded leader
 * (a group whose leader is gone cannot be told from a reused id).
 */
export async function reapGateProcs(path, deps = defaultGateProcDeps()) {
    const record = readGateProcs(path);
    if (!record) {
        rmSync(path, { force: true });
        return;
    }
    // Never the engine itself or its parent, whatever a record says.
    const foreign = (p) => p.pid !== process.pid && p.pid !== process.ppid;
    if (deps.platform === 'win32') {
        for (const p of [...record.orphans, ...(record.root ? [record.root] : [])].filter(foreign))
            await deps.terminateTree(p).catch(() => undefined);
    }
    else if (record.root && record.pgid && foreign(record.root)) {
        await deps.terminateGroup(record.root, record.pgid).catch(() => undefined);
    }
    rmSync(path, { force: true });
}
/**
 * The recorded gate processes under `dir` (every `<sha>.json` record) that
 * still run with their recorded start identity: the proof, before a dir a
 * gate or prepare check ran in is removed, that none of its processes is
 * still there (a private run's prepare checkout or run dir, review-483 I.4).
 * Never signals anything. Fails closed (review-483b L-e): a record dir that
 * exists but cannot be listed, or a record that cannot be read or parsed,
 * throws GateProcsUnreadableError ("may be live"); only a missing dir is empty.
 */
export function liveGateProcs(dir, deps = defaultGateProcDeps()) {
    let names;
    try {
        names = readdirSync(dir);
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT')
            return [];
        throw new GateProcsUnreadableError(`the gate process records in ${dir} cannot be listed (${code ?? String(error)}), so a gate process may still run there`);
    }
    const live = [];
    for (const name of names.filter((n) => /^[0-9a-f]{40}\.json$/.test(n))) {
        const record = readGateProcs(join(dir, name));
        if (!record)
            throw new GateProcsUnreadableError(`the gate process record ${join(dir, name)} cannot be read, so a gate process may still run; check that none does (Task Manager, ps), then remove that file`);
        for (const p of record ? [...(record.root ? [record.root] : []), ...record.orphans] : []) {
            if (p.pid !== process.pid && deps.identitySync(p.pid) === p.identity && !live.includes(p.pid))
                live.push(p.pid);
        }
    }
    return live;
}
const swept = new Set();
/**
 * Once per process and record directory: reap every record there, not only the
 * one of the head about to be gated (a head that is never gated again would
 * otherwise keep its leftovers alive).
 */
export async function sweepGateProcs(dir, deps = defaultGateProcDeps()) {
    if (swept.has(dir))
        return;
    swept.add(dir);
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return;
    }
    for (const name of names) {
        if (/^[0-9a-f]{40}\.json$/.test(name))
            await reapGateProcs(join(dir, name), deps).catch(() => undefined);
    }
}
//# sourceMappingURL=gate-procs.js.map