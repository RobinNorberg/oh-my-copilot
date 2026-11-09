/**
 * Stale-gate reminders (night-3 goal 5), one self-contained step of
 * `omg factory poll`. A run parked at a human gate (awaiting-human) for longer
 * than `factory.poll.remindAfterHours` (default 24; 0 = off) is reminded at
 * most once per window, mentioning the routing handles of the paths its plan
 * names. READ-ONLY on git and the forge: the routing file comes from the
 * base commit through the caller's read shape, nothing is fetched, and the
 * result is printed by poll. The step keeps its own record,
 * `<state>/factory/reminders.json`; it never writes a sealed run state.
 */
import { type FactoryRunKey, type FactoryRunState } from '../run/state.js';
import { type ReadAt } from './context.js';
export interface Reminder {
    run: FactoryRunKey;
    gate: string;
    /** Hours the run has waited at this gate. */
    hours: number;
    /** `@handle`s of the routed owners (validated by parseRouting), each once. */
    handles: string[];
    /** The gate reason as one visible line, cut. */
    reason: string;
}
export declare const remindersPath: (root: string) => string;
export interface ReminderInput {
    root: string;
    runs: ReadonlyMap<FactoryRunKey, FactoryRunState>;
    nowMs: number;
    /** 0 or undefined = off. */
    afterHours: number | undefined;
    /** The base commit's files; undefined when the base sha is unknown. */
    readBase?: ReadAt;
    warn?: (message: string) => void;
}
/** The reminders due now; records them so the same run is reminded once per window. */
export declare function staleGateReminders(o: ReminderInput): Reminder[];
//# sourceMappingURL=reminders.d.ts.map