/**
 * Progress events for `omg release`, in the agent-progress line contract:
 *
 *   <ISO-8601 UTC> phase=<id> status=<start|ok|fail|blocked|heartbeat|done> [note=<v>] [agent=<v>]
 *
 * Written to `$OMG_PROGRESS_FILE` when set, else `<state root>/progress/release.log`.
 * Values that are not bare-safe are double-quoted with `\\`, `\"`, `\n`, `\r`,
 * `\t` escaped. The signature mirrors `emitProgress` of the shared progress
 * library so this module can be replaced by it. Emitting never throws: a
 * broken progress log must not break the release it reports on.
 */
export type ReleaseProgressStatus = 'start' | 'ok' | 'fail' | 'blocked' | 'heartbeat' | 'done';
export interface ReleaseProgressInput {
    phase: string;
    status: ReleaseProgressStatus;
    note?: string;
    agent?: string;
    /** Explicit log path; wins over OMG_PROGRESS_FILE and the default location. */
    file?: string;
}
export declare function formatReleaseProgress(input: Omit<ReleaseProgressInput, 'file'>, at?: Date): string;
/** `$OMG_PROGRESS_FILE`, else `<stateRoot>/progress/release.log`. */
export declare function releaseProgressFile(stateRoot: string): string;
/** Append one event; true when written. */
export declare function emitReleaseProgress(input: ReleaseProgressInput, stateRoot: string): boolean;
//# sourceMappingURL=progress.d.ts.map