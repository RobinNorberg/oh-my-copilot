/**
 * `omg progress` events for a factory run (design §9): agent `factory-<issue>`,
 * file `<state root>/progress/factory-<issue>.log`. Each phase emits `start`
 * then `ok` or `fail`; a human gate emits `blocked` with `note=<gate>:<reason>`;
 * cancel emits `done`; lane waits emit a `heartbeat` at most every 60 s.
 * Emitting never throws (emitProgress is best effort by contract).
 */
import { type ProgressStatus } from '../../lib/agent-progress.js';
export declare const HEARTBEAT_MIN_MS = 60000;
export interface FactoryProgressFields {
    pr?: number;
    sha?: string;
    lane?: string;
    job?: string;
    round?: number;
    /** Run total in AI credits. */
    credits?: number;
}
export interface FactoryProgress {
    readonly file: string;
    emit(phase: string, status: ProgressStatus, note?: string, fields?: FactoryProgressFields): void;
    /** A heartbeat, dropped when the last one is younger than HEARTBEAT_MIN_MS. */
    heartbeat(phase: string, note?: string, fields?: FactoryProgressFields): void;
}
export declare function factoryProgressFile(root: string, issue: number): string;
export declare function createFactoryProgress(input: {
    root: string;
    issue: number;
    file?: string;
    now?: () => number;
}): FactoryProgress;
//# sourceMappingURL=progress.d.ts.map