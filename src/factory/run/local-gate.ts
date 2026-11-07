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

import { spawnSync } from 'child_process';
import { resolve } from 'path';
import { LOCAL_GATE_CHECK, readLocalCheckRecord, writeLocalCheckRecord, type LocalCheckRecord } from '../../forge/local/index.js';
import { scrubShipEnv } from '../../ship/exec.js';
import { childEnv, hardenWindowsExeSearch, resolveBareExe } from '../../utils/windows-search.js';
import { FactorySafetyError } from './exec.js';

/** The record keeps this many characters of the gate's output (jobLog, the ci-fix prompt). */
export const LOCAL_GATE_TAIL_CHARS = 8_000;

export interface LocalGateRunResult {
  status: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** How the gate's process runs (tests substitute it; the default spawns without a shell). */
export type LocalGateRunner = (argv: readonly string[], cwd: string, timeoutMs: number) => LocalGateRunResult;

export const defaultLocalGateRunner: LocalGateRunner = (argv, cwd, timeoutMs) => {
  // A bare name is never resolved from the checkout (a planted npm.cmd / node.exe there).
  hardenWindowsExeSearch();
  const exe = resolveBareExe(argv[0]);
  if (exe === null) return { status: 127, stdout: '', stderr: `${argv[0]}: not found on PATH`, timedOut: false };
  const r = spawnSync(exe, argv.slice(1), {
    cwd,
    env: childEnv(scrubShipEnv(process.env)),
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
  });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error && !timedOut ? r.error.message : ''}`, timedOut };
};

const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

/**
 * The exec guard's allowance for the gate: exactly the configured argv, in
 * exactly the engine's prepare checkout. Throws FactorySafetyError otherwise.
 */
export function assertLocalGateCommand(argv: readonly string[], cwd: string, configured: readonly string[] | undefined, checkout: string): void {
  if (!configured || configured.length === 0) throw new FactorySafetyError('omg factory run refuses the local gate: factory.forge.local.gate is not set in a trusted config layer');
  if (argv.length !== configured.length || argv.some((a, i) => a !== configured[i])) {
    throw new FactorySafetyError(`omg factory run refuses \`${argv.join(' ')}\`: it is not factory.forge.local.gate`);
  }
  if (!samePath(cwd, checkout)) throw new FactorySafetyError(`omg factory run refuses the local gate in ${cwd}: it runs only in the engine's prepare checkout ${checkout}`);
}

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
export function localGateRecord(stateDir: string, root: string, head: string): LocalCheckRecord | undefined {
  return readLocalCheckRecord(stateDir, root, head);
}

/** A run id unique enough per head: positive, from the clock (ForgeRun.databaseId). */
const runIdAt = (d: Date): number => Math.max(1, Math.floor(d.getTime() / 1000));

const tailOf = (text: string): string => (text.length > LOCAL_GATE_TAIL_CHARS ? text.slice(-LOCAL_GATE_TAIL_CHARS) : text);

/**
 * Run the gate for `head` and record SUCCESS or FAILURE (a PENDING record is
 * written first, so a crash mid-gate leaves the head visibly unfinished and
 * the next run sees a pending check, not a pass).
 */
export function runLocalGate(i: LocalGateInput): LocalCheckRecord {
  if (i.gate.length === 0) throw new FactorySafetyError('omg factory run refuses an empty local gate');
  const now = i.now ?? (() => new Date());
  const started = now();
  const base: LocalCheckRecord = { name: LOCAL_GATE_CHECK, head: i.head, state: 'PENDING', argv: [...i.gate], runId: runIdAt(started), startedAt: started.toISOString() };
  writeLocalCheckRecord(i.stateDir, i.root, base);
  const r = (i.runner ?? defaultLocalGateRunner)(i.gate, i.checkout, i.timeoutMinutes * 60_000);
  const output = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}${r.timedOut ? `\nlocal gate timed out after ${i.timeoutMinutes} min` : ''}`;
  const done: LocalCheckRecord = {
    ...base,
    state: r.status === 0 && !r.timedOut ? 'SUCCESS' : 'FAILURE',
    completedAt: now().toISOString(),
    exitCode: r.timedOut ? 124 : r.status,
    tail: tailOf(output.trim()),
  };
  writeLocalCheckRecord(i.stateDir, i.root, done);
  return done;
}
