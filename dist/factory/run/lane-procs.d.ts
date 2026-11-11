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
import type { LaneProcess } from './lane.js';
/** The process listing gives up after this long (it then counts as failed, not as a park). */
export declare const LANE_PROCS_QUERY_TIMEOUT_MS = 10000;
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
export type LaneTreeProof = {
    kind: 'gone';
    killed: number[];
} | {
    kind: 'unproven';
    why: string;
} | {
    kind: 'survivors';
    pids: number[];
};
/**
 * A start identity (process-utils) in the unit the listing reports: Windows
 * `ticks:<100 ns>` as microseconds (CIM CreationDate carries microseconds),
 * Linux the /proc start time, macOS ps lstart milliseconds. Null when it has
 * no such form.
 */
export declare function identityStart(identity: string | null | undefined, platform: NodeJS.Platform): bigint | null;
/**
 * The pids in `rows` that belong to the lane's tree: the root itself while it
 * still runs with its start, every descendant by parent link (created at or
 * after the parent it names, and before that pid's current holder when the
 * pid was reused), and, with `worktree` (Linux), every process started at or
 * after the root whose cwd is under the worktree, with its descendants.
 */
export declare function laneTree(rows: readonly ProcRow[], root: {
    pid: number;
    start: bigint;
}, worktree: string | null, self: number, seeds?: ReadonlyMap<number, bigint>): number[];
/**
 * Whether the lane's process tree is gone (see the module comment). Never
 * throws: a failure is `unproven` with the reason.
 */
export declare function proveLaneTreeGone(input: {
    process: LaneProcess | null | undefined;
    worktree?: string | null;
}, deps?: LaneProcsDeps): Promise<LaneTreeProof>;
/** `pid ppid ticks` lines (Windows), ticks as microseconds; `-` = unknown. */
export declare function parseWindowsRows(stdout: string): ProcRow[];
/** `pid ppid lstart` lines (macOS `ps -A -o pid=,ppid=,lstart=`, LC_ALL=C), start in milliseconds. */
export declare function parsePsRows(stdout: string): ProcRow[];
/** /proc/<pid>/stat: the parent pid (field 4) and the start time (field 22), after the parenthesised name. */
export declare function parseProcStat(stat: string): {
    ppid: number;
    start: bigint;
} | null;
export declare const defaultLaneProcsDeps: LaneProcsDeps;
//# sourceMappingURL=lane-procs.d.ts.map