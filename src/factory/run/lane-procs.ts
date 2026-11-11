/**
 * Proof that a write lane's process tree is gone before the engine commits
 * its worktree (audit H3, layer 1; design i23 3/8).
 *
 * A lane's end is confirmed when its Copilot runtime stopped (job.ts:
 * disconnect, then a kill of the runtime's tree). A child whose parent died
 * first (`start /b`, a double fork, setsid) is no longer in that tree, and
 * Windows' tree kill misses it. Such a survivor could swap a junction into
 * the worktree while the engine stages it. So after the lane ends and before
 * commitLaneWork, the engine lists every process once, builds the closure of
 * descendants of the lane's recorded runtime by parent link, kills the ones
 * it finds by their start identity, and lists again.
 *
 * Parent links outlive the parent: Windows never re-parents, so an orphan of
 * the dead runtime still names its pid; a pid is a descendant only when it
 * was created at or after the parent it names (an older process naming a
 * reused pid is not), and before that pid's current holder when the pid was
 * reused. Linux re-parents orphans to init, so it also counts any process,
 * started after the runtime, whose cwd is under the lane worktree. macOS:
 * the ps closure only (a re-parented orphan is not found there).
 *
 * Availability first (owner rule): a listing that fails or times out does
 * not park the run. The caller warns once and notes "process tree not
 * proven"; the job's own tree kill still ran. Only a process positively seen
 * alive in the closure after the kill parks (lane-unconfirmed, with its pids).
 */

import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { getProcessStartIdentity, isProcessIdentityLive, terminateOwnedProcessTree } from '../../platform/process-utils.js';
import type { LaneProcess } from './lane.js';

const execFileAsync = promisify(execFile);

/** The process listing gives up after this long (it then counts as failed, not as a park). */
export const LANE_PROCS_QUERY_TIMEOUT_MS = 10_000;
/** Each kill by identity gives up after this long. */
const KILL_DEADLINE_MS = 10_000;

/** One process: its pid, the pid it names as parent, its start in the platform's unit (null: unknown), its cwd (Linux). */
export interface ProcRow {
  pid: number;
  ppid: number;
  start: bigint | null;
  cwd?: string | null;
}

export interface LaneProcsDeps {
  platform: NodeJS.Platform;
  /** Every process; throws when the listing fails or times out. */
  list(): Promise<ProcRow[]>;
  /** The exact start identity (process-utils format) of a live pid, null when unreadable. */
  identity(pid: number): Promise<string | null>;
  /** Kill a process tree only while its start identity still matches. */
  kill(pid: number, identity: string): Promise<void>;
  /** Whether a pid with that identity still runs (used when the second listing fails). */
  state(pid: number, identity: string): Promise<'live' | 'dead' | 'mismatch' | 'unknown'>;
  /** This engine's own pid (never counted). */
  self: number;
}

export type LaneTreeProof =
  | { kind: 'gone'; killed: number[] }
  | { kind: 'unproven'; why: string }
  | { kind: 'survivors'; pids: number[] };

/**
 * A start identity (process-utils) in the unit the listing reports: Windows
 * `ticks:<100 ns>` as microseconds (CIM CreationDate carries microseconds),
 * Linux the /proc start time, macOS ps lstart milliseconds. Null when it has
 * no such form.
 */
export function identityStart(identity: string | null | undefined, platform: NodeJS.Platform): bigint | null {
  if (!identity) return null;
  if (platform === 'win32') {
    const ticks = /^ticks:(\d+)$/.exec(identity)?.[1];
    return ticks ? BigInt(ticks) / 10n : null;
  }
  return /^\d+$/.test(identity) ? BigInt(identity) : null;
}

const under = (dir: string, path: string) => {
  const r = relative(resolve(dir), resolve(path));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

/**
 * The pids in `rows` that belong to the lane's tree: the root itself while it
 * still runs with its start, every descendant by parent link (created at or
 * after the parent it names, and before that pid's current holder when the
 * pid was reused), and, with `worktree` (Linux), every process started at or
 * after the root whose cwd is under the worktree, with its descendants.
 */
export function laneTree(rows: readonly ProcRow[], root: { pid: number; start: bigint }, worktree: string | null, self: number, seeds: ReadonlyMap<number, bigint> = new Map()): number[] {
  const current = new Map(rows.map((r) => [r.pid, r]));
  const owned = new Map<number, bigint>([[root.pid, root.start], ...seeds]);
  if (worktree) {
    for (const r of rows) {
      if (r.pid !== self && r.start !== null && r.start >= root.start && r.cwd && under(worktree, r.cwd)) owned.set(r.pid, r.start);
    }
  }
  for (let added = true; added;) {
    added = false;
    for (const r of rows) {
      if (owned.has(r.pid) || r.pid === self || r.start === null) continue;
      const parentStart = owned.get(r.ppid);
      if (parentStart === undefined || r.start < parentStart) continue;
      // The parent pid now names another process: only a child created before that holder was the owned parent's.
      const holder = current.get(r.ppid);
      if (holder && holder.start !== null && holder.start !== parentStart && r.start >= holder.start) continue;
      owned.set(r.pid, r.start);
      added = true;
    }
  }
  return [...owned].filter(([pid, start]) => current.get(pid)?.start === start && pid !== self).map(([pid]) => pid);
}

/**
 * Whether the lane's process tree is gone (see the module comment). Never
 * throws: a failure is `unproven` with the reason.
 */
export async function proveLaneTreeGone(input: { process: LaneProcess | null | undefined; worktree?: string | null }, deps: LaneProcsDeps = defaultLaneProcsDeps): Promise<LaneTreeProof> {
  const p = input.process;
  if (!p) return { kind: 'unproven', why: 'no pid of the lane\'s Copilot runtime was recorded' };
  const start = identityStart(p.identity, deps.platform);
  if (start === null) return { kind: 'unproven', why: `the start identity of the lane's Copilot runtime pid ${p.pid} was not recorded in a usable form` };
  const root = { pid: p.pid, start };
  const worktree = deps.platform === 'linux' ? input.worktree ?? null : null;
  let rows: ProcRow[];
  try {
    rows = await deps.list();
  } catch (error) {
    return { kind: 'unproven', why: `the process listing failed (${error instanceof Error ? error.message : String(error)})` };
  }
  const found = laneTree(rows, root, worktree, deps.self);
  if (found.length === 0) return { kind: 'gone', killed: [] };
  const identities = new Map<number, string>();
  for (const pid of found) {
    const row = rows.find((r) => r.pid === pid)!;
    try {
      const id = await deps.identity(pid);
      // The identity read now must be the process the listing saw (no reuse in between).
      if (id && identityStart(id, deps.platform) === row.start) {
        identities.set(pid, id);
        await deps.kill(pid, id);
      }
    } catch { /* the second listing decides */ }
  }
  let after: ProcRow[] | null = null;
  try {
    after = await deps.list();
  } catch { /* checked one by one below */ }
  if (after) {
    // Anything in the closure now, seeded with what was found (a parent killed first must not hide its child), is positively alive.
    const left = laneTree(after, root, worktree, deps.self, new Map(found.map((pid) => [pid, rows.find((r) => r.pid === pid)!.start!])));
    return left.length > 0 ? { kind: 'survivors', pids: left } : { kind: 'gone', killed: found };
  }
  const live: number[] = [];
  for (const pid of found) {
    const id = identities.get(pid);
    const st = id ? await deps.state(pid, id).catch(() => 'unknown' as const) : 'unknown';
    if (st === 'live') live.push(pid);
    else if (st === 'unknown') return { kind: 'unproven', why: `the process listing failed after the engine killed pid(s) ${found.join(', ')}, and whether pid ${pid} still runs cannot be told` };
  }
  return live.length > 0 ? { kind: 'survivors', pids: live } : { kind: 'gone', killed: found };
}

// --- The platform listings ------------------------------------------------------------------

const WIN_QUERY = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -ErrorAction Stop | ForEach-Object { $c = if ($_.CreationDate) { ([DateTime]$_.CreationDate).ToUniversalTime().Ticks } else { \'-\' }; "$($_.ProcessId) $($_.ParentProcessId) $c" }';

/** `pid ppid ticks` lines (Windows), ticks as microseconds; `-` = unknown. */
export function parseWindowsRows(stdout: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(\d+) (\d+) (\d+|-)$/.exec(line.trim());
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), start: m[3] === '-' ? null : BigInt(m[3]) / 10n });
  }
  if (rows.length === 0) throw new Error('the CIM process listing printed no process');
  return rows;
}

/** `pid ppid lstart` lines (macOS `ps -A -o pid=,ppid=,lstart=`, LC_ALL=C), start in milliseconds. */
export function parsePsRows(stdout: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const ms = new Date(m[3]).getTime();
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), start: Number.isNaN(ms) ? null : BigInt(ms) });
  }
  if (rows.length === 0) throw new Error('ps printed no process');
  return rows;
}

/** /proc/<pid>/stat: the parent pid (field 4) and the start time (field 22), after the parenthesised name. */
export function parseProcStat(stat: string): { ppid: number; start: bigint } | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const f = stat.slice(close + 2).split(' ');
  const ppid = Number(f[1]);
  const start = /^\d+$/.test(f[19] ?? '') ? BigInt(f[19]) : null;
  return Number.isInteger(ppid) && start !== null ? { ppid, start } : null;
}

function listLinux(): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let stat: { ppid: number; start: bigint } | null = null;
    try { stat = parseProcStat(readFileSync(`/proc/${name}/stat`, 'utf8')); } catch { continue; /* exited */ }
    if (!stat) continue;
    let cwd: string | null = null;
    try { cwd = readlinkSync(`/proc/${name}/cwd`); } catch { /* another user's process, or exited */ }
    rows.push({ pid: Number(name), ...stat, cwd });
  }
  return rows;
}

export const defaultLaneProcsDeps: LaneProcsDeps = {
  platform: process.platform,
  self: process.pid,
  list: async () => {
    if (process.platform === 'linux') return listLinux();
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', WIN_QUERY], { timeout: LANE_PROCS_QUERY_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      return parseWindowsRows(stdout);
    }
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,lstart='], { timeout: LANE_PROCS_QUERY_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 16 * 1024 * 1024 });
    return parsePsRows(stdout);
  },
  identity: (pid) => getProcessStartIdentity(pid, Date.now() + KILL_DEADLINE_MS),
  kill: async (pid, identity) => {
    await terminateOwnedProcessTree({ pid, expectedStartIdentity: identity, deadlineAt: new Date(Date.now() + KILL_DEADLINE_MS).toISOString(), force: true });
  },
  state: (pid, identity) => isProcessIdentityLive(pid, identity, Date.now() + KILL_DEADLINE_MS),
};
