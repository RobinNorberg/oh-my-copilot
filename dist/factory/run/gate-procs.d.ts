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
export declare const gateProcsPath: (stateDir: string, root: string, head: string) => string;
/** The record at `path`; undefined when absent or not a well-formed record (it is then ignored, never trusted). */
export declare function readGateProcs(path: string): GateProcRecord | undefined;
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
    listChildren: (rootPid: number) => Promise<Array<{
        pid: number;
        created: bigint;
    }>>;
}
export declare const defaultGateProcDeps: () => GateProcDeps;
/** Record what the gate at `path` starts. A write failure is swallowed: bookkeeping must never decide a verdict. */
export declare function createGateProcTracker(path: string, startedAtMs: number, deps?: GateProcDeps): GateProcTracker;
/**
 * Kill what an earlier gate run for this head left behind, then forget it.
 * Only a process whose start identity still equals the recorded one is
 * signalled. A POSIX group is signalled only through its recorded leader
 * (a group whose leader is gone cannot be told from a reused id).
 */
export declare function reapGateProcs(path: string, deps?: GateProcDeps): Promise<void>;
//# sourceMappingURL=gate-procs.d.ts.map