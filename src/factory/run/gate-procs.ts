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
import { readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { localStoreDir } from '../../forge/local/mirror.js';
import { writeAtomic } from '../../forge/local/store.js';
import { getProcessStartIdentity, getProcessStartIdentitySync, terminateOwnedProcessGroup, terminateOwnedProcessTree } from '../../platform/process-utils.js';

const execFileAsync = promisify(execFile);

/** How long one cleanup step (listing, identity, kill) may take. */
const STEP_DEADLINE_MS = 15_000;

export interface GateProc {
  pid: number;
  /** Start identity (getProcessStartIdentity) the pid had when recorded. */
  identity: string;
}

export interface GateProcRecord {
  version: 1;
  startedAt: string;
  /** The gate's root process; absent when its identity could not be read at spawn (then nothing of it is ever signalled). */
  root?: GateProc;
  /** POSIX: the root's process group id (equal to its pid; the root is detached). */
  pgid?: number;
  /** Windows: descendants found after the root exited. */
  orphans: GateProc[];
}

export const gateProcsPath = (stateDir: string, root: string, head: string): string =>
  join(localStoreDir(stateDir, root), 'gate-procs', `${head}.json`);

const isProc = (p: unknown): p is GateProc => {
  const r = p as Partial<GateProc> | null;
  return !!r && Number.isInteger(r.pid) && (r.pid as number) > 0 && typeof r.identity === 'string' && r.identity.length > 0 && r.identity.length < 64;
};

/** The record at `path`; undefined when absent or not a well-formed record (it is then ignored, never trusted). */
export function readGateProcs(path: string): GateProcRecord | undefined {
  let parsed: Partial<GateProcRecord> | null;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<GateProcRecord> | null;
  } catch {
    return undefined;
  }
  if (!parsed || parsed.version !== 1 || typeof parsed.startedAt !== 'string' || !Array.isArray(parsed.orphans) || !parsed.orphans.every(isProc)) return undefined;
  if (parsed.root !== undefined && !isProc(parsed.root)) return undefined;
  if (parsed.pgid !== undefined && !(Number.isInteger(parsed.pgid) && (parsed.pgid as number) > 0)) return undefined;
  return parsed as GateProcRecord;
}

/** What runOwned reports while the gate runs. */
export interface GateProcTracker {
  /** Right after spawn, before the event loop turns. */
  spawned(pid: number): void;
  /** The root exited while a descendant still held the pipes (Windows): clean up what it left. */
  rootGone(exitedAtMs: number): Promise<void>;
}

export interface GateProcDeps {
  platform: NodeJS.Platform;
  identitySync: (pid: number) => string | null;
  identity: (pid: number, deadlineAt: number) => Promise<string | null>;
  terminateTree: (p: GateProc) => Promise<string>;
  terminateGroup: (p: GateProc, pgid: number) => Promise<string>;
  /** Windows: the root's children as `pid` and creation time in .NET ticks. */
  listChildren: (rootPid: number) => Promise<Array<{ pid: number; created: bigint }>>;
}

const TICKS_AT_EPOCH = 621355968000000000n;
const ticksOfMs = (ms: number): bigint => BigInt(Math.trunc(ms)) * 10000n + TICKS_AT_EPOCH;

/** CIM reports creation times to the microsecond, Get-Process to 100 ns: compare at the microsecond. */
const sameMicrosecond = (identity: string, created: bigint): boolean => {
  const m = /^ticks:(\d+)$/.exec(identity);
  return !!m && BigInt(m[1]) / 10n === created / 10n;
};

async function listWindowsChildren(rootPid: number): Promise<Array<{ pid: number; created: bigint }>> {
  const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${rootPid}" | ForEach-Object { "$($_.ProcessId) " + ([DateTime]$_.CreationDate).ToUniversalTime().Ticks }`;
  const { stdout } = await execFileAsync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: STEP_DEADLINE_MS, windowsHide: true });
  const out: Array<{ pid: number; created: bigint }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(\d+) (\d+)$/.exec(line.trim());
    if (m && Number(m[1]) > 0) out.push({ pid: Number(m[1]), created: BigInt(m[2]) });
  }
  return out;
}

export const defaultGateProcDeps = (): GateProcDeps => ({
  platform: process.platform,
  identitySync: getProcessStartIdentitySync,
  identity: (pid, deadlineAt) => getProcessStartIdentity(pid, deadlineAt),
  terminateTree: (p) => terminateOwnedProcessTree({ pid: p.pid, expectedStartIdentity: p.identity, deadlineAt: new Date(Date.now() + STEP_DEADLINE_MS).toISOString(), force: true }),
  terminateGroup: (p, pgid) => terminateOwnedProcessGroup({ pid: p.pid, expectedStartIdentity: p.identity, processGroupId: pgid, deadlineAt: new Date(Date.now() + STEP_DEADLINE_MS).toISOString(), force: true }),
  listChildren: listWindowsChildren,
});

/** Record what the gate at `path` starts. A write failure is swallowed: bookkeeping must never decide a verdict. */
export function createGateProcTracker(path: string, startedAtMs: number, deps: GateProcDeps = defaultGateProcDeps()): GateProcTracker {
  const record: GateProcRecord = { version: 1, startedAt: new Date(startedAtMs).toISOString(), orphans: [] };
  let rootPid = 0;
  const save = (): void => {
    try { writeAtomic(path, `${JSON.stringify(record, null, 2)}\n`); } catch { /* best effort */ }
  };
  return {
    spawned(pid) {
      rootPid = pid;
      const identity = deps.identitySync(pid);
      if (identity) {
        record.root = { pid, identity };
        if (deps.platform !== 'win32') record.pgid = pid;
        save();
      }
    },
    async rootGone(exitedAtMs) {
      if (deps.platform !== 'win32' || !rootPid) return;
      let kids: Array<{ pid: number; created: bigint }>;
      try {
        kids = await deps.listChildren(rootPid);
      } catch {
        return;
      }
      // Created inside the gate's window: a later process that reused the root's pid is not the root's child.
      const from = ticksOfMs(startedAtMs);
      const to = ticksOfMs(exitedAtMs);
      for (const k of kids) {
        if (k.created < from || k.created > to) continue;
        const identity = await deps.identity(k.pid, Date.now() + STEP_DEADLINE_MS);
        if (!identity || !sameMicrosecond(identity, k.created)) continue;
        record.orphans.push({ pid: k.pid, identity });
      }
      if (record.orphans.length === 0) return;
      save();
      const left: GateProc[] = [];
      for (const o of record.orphans) {
        const done = await deps.terminateTree(o).catch(() => 'unknown');
        if (done !== 'terminated' && done !== 'already-dead' && done !== 'identity-mismatch') left.push(o);
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
export async function reapGateProcs(path: string, deps: GateProcDeps = defaultGateProcDeps()): Promise<void> {
  const record = readGateProcs(path);
  if (!record) {
    rmSync(path, { force: true });
    return;
  }
  if (deps.platform === 'win32') {
    for (const p of [...record.orphans, ...(record.root ? [record.root] : [])]) await deps.terminateTree(p).catch(() => undefined);
  } else if (record.root && record.pgid) {
    await deps.terminateGroup(record.root, record.pgid).catch(() => undefined);
  }
  rmSync(path, { force: true });
}
