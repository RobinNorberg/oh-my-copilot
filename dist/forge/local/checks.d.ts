/**
 * The local forge's one check (offline forge plan §1.1): the engine runs
 * factory.forge.local.gate once per pushed head in its prepare checkout and
 * records `local-gate` here (writeLocalCheckRecord, under the engine-owned
 * store). checks()/runsForHead() read that record back for exactly the head
 * asked for and nothing else, so gates-driver and ship watchGates keep their
 * head discipline unchanged.
 */
import type { ForgeChecks } from '../types.js';
/** The one check name the local forge reports. */
export declare const LOCAL_GATE_CHECK = "local-gate";
/** What the engine's local gate (src/factory/run/local-gate.ts) records per pushed head. */
export interface LocalCheckRecord {
    name: typeof LOCAL_GATE_CHECK;
    /** The exact head (40 hex) the gate ran on. */
    head: string;
    state: 'PENDING' | 'SUCCESS' | 'FAILURE';
    /** The gate argv (factory.forge.local.gate). */
    argv: string[];
    /** A positive integer the writer picks (ForgeRun.databaseId, ForgeCheck.runId). */
    runId: number;
    startedAt: string;
    completedAt?: string;
    exitCode?: number;
    /** The captured output tail (jobLog). */
    tail?: string;
    /**
     * How the gate ran (factory.run.sandbox.gates): in the attested OS sandbox
     * (`enforced`), or unsandboxed after `--allow-unsandboxed-gates` (`ack`) or
     * by the user's config (`unsandboxed`). Absent in records written before.
     */
    sandbox?: 'enforced' | 'ack' | 'unsandboxed';
}
/** Write `record` atomically to localCheckRecordPath(stateDir, root, record.head); returns the path. */
export declare function writeLocalCheckRecord(stateDir: string, root: string, record: LocalCheckRecord): string;
/** The record for `head` under a store directory (localStoreDir), or undefined; throws on a malformed file or one recorded for another head. */
export declare function readCheckRecordAt(storeDir: string, head: string): LocalCheckRecord | undefined;
/** The record for `head`, or undefined; throws on a malformed file or one recorded for another head. */
export declare function readLocalCheckRecord(stateDir: string, root: string, head: string): LocalCheckRecord | undefined;
/**
 * ForgeChecks over the records in `<storeDir>/checks`. `recordFor(head)`
 * reads one head's record. rerun() removes the record of that run, so the
 * engine sees no check for the head and runs the gate again (the adapter
 * never runs anything itself).
 */
export declare function localChecks(checksDir: string, recordFor: (head: string) => LocalCheckRecord | undefined): ForgeChecks;
//# sourceMappingURL=checks.d.ts.map