/**
 * The local forge's gate (offline forge plan §1.1): the engine runs
 * `factory.forge.local.gate` (an argv from the trusted config layers only,
 * src/forge/config.ts) once per pushed head in its own prepare checkout, with
 * a timeout, and records the result as the `local-gate` check of that head
 * (writeLocalCheckRecord, under the engine-owned forge state dir). The local
 * forge's checks() read that record back, so gates-driver and ship's
 * watchGates keep their head discipline unchanged. A head with no record
 * (never run, or `checks.rerun` removed it) is run again.
 *
 * The gate runs the PR's own code, like prepare's tsc and tests: only in the
 * engine-owned checkout (assertLocalGateCommand), never in the user's
 * checkout or a lane worktree, with the scrubbed environment ship gives every
 * command, and without a shell.
 */
import { type LocalCheckRecord } from '../../forge/local/index.js';
/** The record keeps this many characters of the gate's output (jobLog, the ci-fix prompt). */
export declare const LOCAL_GATE_TAIL_CHARS = 8000;
export interface LocalGateRunResult {
    status: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}
/** How the gate's process runs (tests substitute it; the default spawns without a shell). */
export type LocalGateRunner = (argv: readonly string[], cwd: string, timeoutMs: number) => LocalGateRunResult;
export declare const defaultLocalGateRunner: LocalGateRunner;
/**
 * The exec guard's allowance for the gate: exactly the configured argv, in
 * exactly the engine's prepare checkout. Throws FactorySafetyError otherwise.
 */
export declare function assertLocalGateCommand(argv: readonly string[], cwd: string, configured: readonly string[] | undefined, checkout: string): void;
export interface LocalGateInput {
    /** The forge state dir (ForgeOptions.stateDir) and the user's checkout: they locate the record. */
    stateDir: string;
    root: string;
    /** The pushed head the gate judges; the checkout must be at it. */
    head: string;
    /** factory.forge.local.gate and its timeout. */
    gate: readonly string[];
    timeoutMinutes: number;
    /** The engine's prepare checkout. */
    checkout: string;
    runner?: LocalGateRunner;
    now?: () => Date;
}
/** The record of `head`, or undefined when the gate has not run for it (or a rerun removed it). */
export declare function localGateRecord(stateDir: string, root: string, head: string): LocalCheckRecord | undefined;
/**
 * Run the gate for `head` and record SUCCESS or FAILURE (a PENDING record is
 * written first, so a crash mid-gate leaves the head visibly unfinished and
 * the next run sees a pending check, not a pass).
 */
export declare function runLocalGate(i: LocalGateInput): LocalCheckRecord;
//# sourceMappingURL=local-gate.d.ts.map