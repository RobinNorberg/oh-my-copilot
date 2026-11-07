import type { SdkHostSessionFile, SdkHostTimelineMark } from './sdk-host.js';
/** The session fields the poller reads; every field may be absent in an older or partial file. */
export type SdkLaunchSession = Partial<Pick<SdkHostSessionFile, 'state' | 'last_error' | 'timeline'>>;
export interface SdkLaunchProgressOptions {
    /** How often the session file is read (default 1000 ms). */
    pollMs?: number;
    /** A heartbeat line after this long without a new phase (default 15000 ms). */
    heartbeatMs?: number;
    now?: () => number;
    readSession?: (stateRoot: string, workerName: string) => SdkLaunchSession | null;
    setInterval?: (fn: () => void, ms: number) => unknown;
    clearInterval?: (handle: unknown) => void;
}
/** Launch phases in order: the mark, its label once reached, and what the launch waits on next. */
export declare const SDK_LAUNCH_PHASES: ReadonlyArray<{
    mark: SdkHostTimelineMark;
    label: string;
    next: string;
    span: string;
}>;
/** Index of the last phase reached, or -1. */
export declare function lastSdkLaunchPhase(session: SdkLaunchSession | null): number;
/** `runtime 8s, session 20s, ...`: the time from each reached phase to the previous one. */
export declare function formatSdkLaunchBreakdown(session: SdkLaunchSession | null): string;
/**
 * Start writing launch progress for `workerName`; returns an idempotent stop.
 * It stops by itself once the worker gave its first model reply or the host
 * failed. A stop before that writes the breakdown so far.
 */
export declare function startSdkLaunchProgress(stateRoot: string, workerName: string, write: (line: string) => void, options?: SdkLaunchProgressOptions): () => void;
//# sourceMappingURL=sdk-launch-progress.d.ts.map