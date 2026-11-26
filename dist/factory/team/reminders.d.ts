/**
 * Stale-gate reminders (night-3 goal 5), one self-contained step of
 * `omg factory poll`. A run parked at a human gate (awaiting-human) for longer
 * than `factory.poll.remindAfterHours` (default 24; 0 = off) is reminded at
 * most once per window, mentioning the routing handles of the paths its plan
 * names. READ-ONLY on git and the forge: the routing file comes from the
 * base commit through the caller's read shape, nothing is fetched, and the
 * result is printed by poll. The step keeps its own record in the host
 * factory ledger, `<ledgerDir>/reminders/<repo key>.json` (the repository key
 * of the ledger's other per-repository files), never in the repository's
 * lane-writable `.omg/`; it never writes a sealed run state. The record of
 * older versions, `<state>/factory/reminders.json`, is ignored (never read,
 * never removed).
 */
import { type FactoryRunKey, type FactoryRunState } from '../run/state.js';
import { type ReadAt } from './context.js';
export interface GateReminder {
    run: FactoryRunKey;
    gate: string;
    /** Hours the run has waited at this gate. */
    hours: number;
    /** `@handle`s of the routed owners (validated by parseRouting), each once. */
    handles: string[];
    /** The gate reason as one visible line, cut. */
    reason: string;
}
/** A parked run whose state fails the trust check: the key and the read-only status command, nothing from the state. */
export interface UnverifiedReminder {
    run: FactoryRunKey;
    verified: false;
    next: string;
}
export type Reminder = GateReminder | UnverifiedReminder;
/** The record of `root` in the host factory ledger (outside the repository), keyed like the ledger's other per-repository files. */
export declare const remindersPath: (ledgerDir: string, root: string) => string;
export interface ReminderInput {
    root: string;
    /** The host factory ledger dir (ledger.ts defaultLedgerDir) that holds the record. */
    ledgerDir: string;
    runs: ReadonlyMap<FactoryRunKey, FactoryRunState>;
    nowMs: number;
    /** 0 or undefined = off. */
    afterHours: number | undefined;
    /** The base commit's files; undefined when the base sha is unknown. */
    readBase?: ReadAt;
    warn?: (message: string) => void;
    /**
     * Runs whose state fails the trust check (board readRuns with a ledger dir).
     * Such a parked run is reminded once per window, counted from when it was
     * first seen unverified, as "not verified" with the status command; no
     * field of its state is shown.
     */
    untrusted?: ReadonlySet<FactoryRunKey>;
}
/** The reminders due now; records them so the same run is reminded once per window. */
export declare function staleGateReminders(o: ReminderInput & {
    untrusted?: undefined;
}): GateReminder[];
export declare function staleGateReminders(o: ReminderInput): Reminder[];
//# sourceMappingURL=reminders.d.ts.map