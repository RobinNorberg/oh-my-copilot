/**
 * The local forge's gate (offline forge plan §1.1): the engine runs
 * `factory.forge.local.gate` (an argv from the trusted config layers only,
 * src/forge/config.ts) once per pushed head in its own prepare checkout, with
 * a timeout, and records the result as the `local-gate` check of that head
 * (writeLocalCheckRecord, under the engine-owned forge state dir). The local
 * forge's checks() read that record back, so gates-driver and ship's
 * watchGates keep their head discipline unchanged. A head with no record
 * (never run, or `checks.rerun` removed it) or with a stale PENDING record
 * (localGateDue) is run again.
 *
 * The gate runs the PR's own code, like prepare's tsc and tests: the argv is
 * trusted, but what it executes is the pushed head. `["npm","test"]` runs the
 * PR's package.json `test` script, so a lane that edits package.json scripts
 * (or the test files) changes what the gate does. It runs only in the
 * engine-owned checkout (assertLocalGateCommand), never in the user's
 * checkout or a lane worktree, with the scrubbed environment ship gives every
 * command, and without a shell.
 *
 * No shell on Windows means no `.cmd`/`.bat` (cmd.exe would parse the
 * arguments; the 5.12.1 cmd-injection fix). `npm`/`npx` run as
 * `<node> <node dir>/node_modules/npm/bin/npm-cli.js` (npx-cli.js), `pnpm`/
 * `yarn` as a real .exe on PATH or corepack's script beside node
 * (resolveLocalGateArgv). A gate whose executable cannot start is never a
 * FAILURE: the run parks at awaiting-human with the reason.
 */
import { type LocalCheckRecord } from '../../forge/local/index.js';
/** The record keeps this many characters of the gate's output (jobLog, the ci-fix prompt). */
export declare const LOCAL_GATE_TAIL_CHARS = 8000;
/** How long after the gate's timeout a PENDING record is taken as left by a crashed engine (localGateDue). */
export declare const LOCAL_GATE_STALE_GRACE_MS = 60000;
export interface LocalGateRunResult {
    status: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    /** The process never started (no such executable, spawn refused): not a verdict on the head. */
    startError?: string;
}
/** How the gate's process runs (tests substitute it; the default spawns without a shell and kills the whole tree at the timeout). */
export type LocalGateRunner = (argv: readonly string[], cwd: string, timeoutMs: number) => Promise<LocalGateRunResult>;
export interface ResolveGateOptions {
    cwd: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    /** The running node (process.execPath): `npm`/`npx`/corepack scripts run under it. */
    execPath?: string;
    exists?: (p: string) => boolean;
}
/**
 * The executable and arguments the gate argv runs as, or why it cannot start.
 * Never a `.cmd`/`.bat` on Windows and never a name found in the checkout.
 */
export declare function resolveLocalGateArgv(argv: readonly string[], o: ResolveGateOptions): {
    exe: string;
    args: string[];
} | {
    missing: string;
};
export declare const defaultLocalGateRunner: LocalGateRunner;
/**
 * The exec guard's allowance for the gate. `recorded` is the gate argv the
 * run sealed when it first ran the gate (FactoryRunState.localGate); the
 * current trusted config must still name exactly that argv, so a gate
 * changed mid-run is refused rather than run against a head the old gate
 * judged. `checkout` must really be the engine's prepare checkout
 * (`expectedCheckout`): its real path, so a junction or symlink pointing it
 * at the user's checkout or a lane worktree is refused. Throws
 * FactorySafetyError otherwise.
 */
export declare function assertLocalGateCommand(recorded: readonly string[], configured: readonly string[] | undefined, checkout: string, expectedCheckout: string): void;
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
 * True when the gate must run for `head`: no record, or a PENDING record
 * left behind by an engine that died mid-gate. A PENDING record is stale
 * once its `startedAt` is older than the gate's timeout plus
 * LOCAL_GATE_STALE_GRACE_MS: a live engine always replaces PENDING with
 * SUCCESS or FAILURE by then (it kills the gate at the timeout). The record
 * shape carries no pid on purpose: a pid can be reused, the clock cannot.
 */
export declare function localGateDue(stateDir: string, root: string, head: string, timeoutMinutes: number, now: Date): boolean;
/** The gate ran and recorded a verdict, or its process never started (the PENDING record is removed again). */
export type LocalGateOutcome = {
    started: true;
    record: LocalCheckRecord;
} | {
    started: false;
    reason: string;
};
/**
 * Run the gate for `head` and record SUCCESS or FAILURE (a PENDING record is
 * written first, so a crash mid-gate leaves the head visibly unfinished and
 * the next run sees a pending check, not a pass, until it goes stale). A
 * gate that cannot start records nothing.
 */
export declare function runLocalGate(i: LocalGateInput): Promise<LocalGateOutcome>;
//# sourceMappingURL=local-gate.d.ts.map