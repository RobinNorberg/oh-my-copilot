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
 * checkout or a lane worktree. With factory.run.sandbox.gates "enforced"
 * (the default) it runs in the Copilot runtime's OS sandbox (sandbox-exec.ts
 * runSandboxed: read-write on the checkout only, no network, no credential
 * in the env, the home's credential files denied); with "ack" or
 * "unsandboxed" it runs as the user, without a shell, with the allowlisted
 * gateEnv.
 *
 * No shell on Windows means no `.cmd`/`.bat` (cmd.exe would parse the
 * arguments; the 5.12.1 cmd-injection fix). `npm`/`npx` run as
 * `<node> <node dir>/node_modules/npm/bin/npm-cli.js` (npx-cli.js), `pnpm`/
 * `yarn` as a real .exe on PATH or corepack's script beside node
 * (resolveLocalGateArgv). A gate whose executable cannot start is never a
 * FAILURE: the run parks at awaiting-human with the reason.
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, posix, resolve, win32 } from 'path';
import { LOCAL_GATE_CHECK, localCheckRecordPath, readLocalCheckRecord, writeLocalCheckRecord, type LocalCheckRecord } from '../../forge/local/index.js';
import { getProcessStartIdentity, terminateOwnedProcessTree } from '../../platform/process-utils.js';
import { childEnv, findOnPath, hardenWindowsExeSearch, resolveBareExe } from '../../utils/windows-search.js';
import { FactorySafetyError, sameFsPath } from './exec.js';
import { createGateProcTracker, gateProcsPath, reapGateProcs, sweepGateProcs, type GateProcTracker } from './gate-procs.js';
import { gateEnv, redactGateOutput, type SandboxRunner } from './sandbox-exec.js';

/** The record keeps this many characters of the gate's output (jobLog, the ci-fix prompt). */
export const LOCAL_GATE_TAIL_CHARS = 8_000;

/** How long after the gate's timeout a PENDING record is taken as left by a crashed engine (localGateDue). */
export const LOCAL_GATE_STALE_GRACE_MS = 60_000;

/** Each output stream keeps at most this many characters while the gate runs (the record keeps less). */
const STREAM_KEEP_CHARS = 64 * 1024;

/** How long the tree kill of a timed-out gate may take. */
const KILL_DEADLINE_MS = 30_000;

/** How long after the gate's root process exits its output may still drain before the verdict settles. */
const EXIT_DRAIN_MS = 2_000;

export interface LocalGateRunResult {
  status: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The process never started (no such executable, spawn refused): not a verdict on the head. */
  startError?: string;
}

/** How the gate's process runs (tests substitute it; the default spawns without a shell and kills the whole tree at the timeout). */
export type LocalGateRunner = (argv: readonly string[], cwd: string, timeoutMs: number, track?: GateProcTracker) => Promise<LocalGateRunResult>;

export interface ResolveGateOptions {
  cwd: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** The running node (process.execPath): `npm`/`npx`/corepack scripts run under it. */
  execPath?: string;
  exists?: (p: string) => boolean;
  /** Who the messages name (default `the local gate`; prepare passes `the prepare check`). */
  subject?: string;
  /** The config key the messages point at (default `factory.forge.local.gate`). */
  configKey?: string;
}

/** Package-manager CLIs that are `.cmd` shims on Windows, and the node script each one runs. */
const NODE_SCRIPTS: Record<string, { script: string[]; exeFirst: boolean }> = {
  npm: { script: ['node_modules', 'npm', 'bin', 'npm-cli.js'], exeFirst: false },
  npx: { script: ['node_modules', 'npm', 'bin', 'npx-cli.js'], exeFirst: false },
  pnpm: { script: ['node_modules', 'corepack', 'dist', 'pnpm.js'], exeFirst: true },
  yarn: { script: ['node_modules', 'corepack', 'dist', 'yarn.js'], exeFirst: true },
};

/** The gate argv a hint suggests: `["npm","test"]` when npm's own script is beside node (it runs without a shell), else node with that script. */
const npmCliHint = (P: typeof win32, execPath: string, exists: (p: string) => boolean): string => {
  const script = P.join(P.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return exists(script) ? JSON.stringify(['npm', 'test']) : JSON.stringify(['node', script, 'test']);
};

/**
 * The executable and arguments the gate argv runs as, or why it cannot start.
 * Never a `.cmd`/`.bat` on Windows and never a name found in the checkout.
 */
export function resolveLocalGateArgv(argv: readonly string[], o: ResolveGateOptions): { exe: string; args: string[] } | { missing: string } {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const execPath = o.execPath ?? process.execPath;
  const exists = o.exists ?? existsSync;
  const what = o.subject ?? 'the local gate';
  const key = o.configKey ?? 'factory.forge.local.gate';
  const P = platform === 'win32' ? win32 : posix;
  const [cmd, ...args] = argv;
  if (!cmd) return { missing: `${what} argv is empty` };
  const hasPath = /[\\/]/.test(cmd) || (platform === 'win32' && cmd.includes(':'));
  if (hasPath) {
    const at = P.isAbsolute(cmd) ? cmd : P.resolve(o.cwd, cmd);
    return exists(at) ? { exe: cmd, args } : { missing: `${what} executable ${cmd} does not exist (resolved in the prepare checkout to ${at})` };
  }
  if (platform !== 'win32') {
    return findOnPath(cmd, env, platform, exists) ? { exe: cmd, args } : { missing: `${what} executable ${cmd} is not on PATH` };
  }
  const name = cmd.toLowerCase().replace(/\.(cmd|bat)$/, '');
  const known = NODE_SCRIPTS[name];
  const exe = () => findOnPath(name === cmd.toLowerCase() ? cmd : name, { ...env, PATHEXT: '.COM;.EXE' }, 'win32', exists);
  if (known) {
    const fromExe = known.exeFirst ? exe() : null;
    if (fromExe) return { exe: fromExe, args };
    const script = P.join(P.dirname(execPath), ...known.script);
    if (exists(script)) return { exe: execPath, args: [script, ...args] };
    return { missing: `${what} executable ${cmd} cannot start: on Windows ${what} runs without a shell, so ${name}.cmd is never run, and ${script} does not exist; set ${key} to a command that starts without a shell, such as ${npmCliHint(P, execPath, exists)}` };
  }
  if (/\.(cmd|bat)$/i.test(cmd)) {
    return { missing: `${what} executable ${cmd} is a cmd.exe script, which ${what} never runs (no shell); set ${key} to node, an .exe or npm (none needs a shell), such as ${npmCliHint(P, execPath, exists)}` };
  }
  const found = exe();
  return found ? { exe: found, args } : { missing: `${what} executable ${cmd} is not on PATH as an .exe or .com (on Windows ${what} runs without a shell, so .cmd/.bat shims are skipped); set ${key} to a command that starts without a shell, such as ${npmCliHint(P, execPath, exists)}` };
}

const keepTail = (text: string): string => (text.length > STREAM_KEEP_CHARS ? text.slice(-STREAM_KEEP_CHARS) : text);

/**
 * Kill the gate's whole process tree: the identity-checked tree kill while
 * the root lives. After the root exited only POSIX can still reach its
 * descendants (the detached process group); on Windows an orphan that
 * outlived the root is not killed, only no longer waited for.
 */
async function killGateTree(child: ChildProcess, rootExited: boolean): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (!rootExited) {
    // Our own unreaped child: its pid cannot be reused yet, so its identity is the one we started.
    const identity = await getProcessStartIdentity(pid, Date.now() + KILL_DEADLINE_MS);
    if (identity) {
      const done = await terminateOwnedProcessTree({ pid, expectedStartIdentity: identity, deadlineAt: new Date(Date.now() + KILL_DEADLINE_MS).toISOString(), force: true });
      if (done === 'terminated' || done === 'already-dead') return;
    }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  // The root exited but a descendant still holds the output pipes: its process group (POSIX only, detached; Windows has no group to signal).
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* the group is gone */ }
  }
}

/** Spawn without a shell; at `timeoutMs` kill the whole tree (test workers too) and stop waiting for its output. */
function runOwned(exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, track?: GateProcTracker): Promise<LocalGateRunResult> {
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      // detached on POSIX: the gate leads its own process group, so the timeout reaches its grandchildren.
      child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (error) {
      done({ status: 127, stdout: '', stderr: '', timedOut: false, startError: `${exe}: ${(error as Error).message}` });
      return;
    }
    if (child.pid) track?.spawned(child.pid);
    let stdout = '';
    let stderr = '';
    let exitStatus: number | null = null;
    let timedOut = false;
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    const finish = (r: LocalGateRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      done(r);
    };
    child.stdout!.setEncoding('utf8').on('data', (d: string) => { stdout = keepTail(stdout + d); });
    child.stderr!.setEncoding('utf8').on('data', (d: string) => { stderr = keepTail(stderr + d); });
    child.on('error', (error) => {
      // No pid: it never started (ENOENT, EACCES, EINVAL for a .cmd). With a pid it is a kill/IO error, reported by close.
      if (!child.pid) finish({ status: 127, stdout, stderr, timedOut: false, startError: `${exe}: ${error.message}` });
    });
    child.on('exit', (code, signal) => {
      exitStatus = code ?? (signal ? 128 : 1);
      // The root's exit status is the verdict: a descendant still holding the pipes gets a short drain, then is
      // killed best-effort (its process group, POSIX only; a Windows orphan survives) and no longer delays the verdict or turns it into a timeout.
      const exitedAt = Date.now();
      drain = setTimeout(() => {
        if (settled || timedOut) return;
        void killGateTree(child, true);
        child.stdout?.destroy();
        child.stderr?.destroy();
        // Windows has no group to signal: the root's identity-checked leftovers are killed before the verdict settles.
        void (track ? track.rootGone(exitedAt) : Promise.resolve()).catch(() => undefined).then(() => {
          finish({ status: exitStatus!, stdout, stderr, timedOut: false });
        });
      }, EXIT_DRAIN_MS);
    });
    child.on('close', (code, signal) => {
      finish({ status: timedOut ? 124 : (exitStatus ?? code ?? (signal ? 128 : 1)), stdout, stderr, timedOut });
    });
    const timer = setTimeout(() => {
      // Firing inside the post-exit drain: the root already exited, so its exit status stays the verdict.
      const exited = exitStatus !== null;
      if (!exited) timedOut = true;
      void killGateTree(child, exited).then(() => (exited ? track?.rootGone(Date.now()) : undefined)).catch(() => undefined).finally(() => {
        // Whatever still holds the pipes (an orphan on Windows) no longer delays the verdict.
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(exited ? { status: exitStatus!, stdout, stderr, timedOut: false } : { status: 124, stdout, stderr, timedOut: true });
      });
    }, timeoutMs);
  });
}

/**
 * The gate (or a prepare check) WITHOUT the OS sandbox (factory.run.sandbox.gates
 * "ack" or "unsandboxed"): no shell, the whole tree killed at the timeout,
 * and the credential-scrubbed gateEnv with an empty home made for this run
 * and removed after it.
 */
export const defaultLocalGateRunner: LocalGateRunner = async (argv, cwd, timeoutMs, track) => {
  // A bare name is never resolved from the checkout (a planted npm.cmd / node.exe there).
  hardenWindowsExeSearch();
  const target = resolveLocalGateArgv(argv, { cwd });
  if ('missing' in target) return { status: 127, stdout: '', stderr: '', timedOut: false, startError: target.missing };
  // resolveLocalGateArgv already gave an absolute path on Windows; resolveBareExe keeps a path unchanged.
  const exe = resolveBareExe(target.exe) ?? target.exe;
  const home = mkdtempSync(join(tmpdir(), 'omg-gate-home-'));
  try {
    return await runOwned(exe, target.args, cwd, childEnv(gateEnv(process.env, home)), timeoutMs, track);
  } finally {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
};

const realOrResolved = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
};

const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * The exec guard's allowance for the gate. `recorded` is the gate argv the
 * run sealed when it first ran the gate (FactoryRunState.localGate); the
 * current trusted config must still name exactly that argv, so a gate
 * changed mid-run is refused rather than run against a head the old gate
 * judged. `checkout` must really be the engine's prepare checkout
 * (`expectedCheckout`): neither path may itself be a junction or symlink
 * (one pointing at the user's checkout or a lane worktree is refused), and
 * their real paths must match, so a root reached through a junction,
 * symlink, subst drive or 8.3 name still matches itself. Throws
 * FactorySafetyError otherwise.
 */
export function assertLocalGateCommand(recorded: readonly string[], configured: readonly string[] | undefined, checkout: string, expectedCheckout: string): void {
  if (!configured || configured.length === 0) throw new FactorySafetyError('omg factory run refuses the local gate: factory.forge.local.gate is not set in a trusted config layer');
  if (recorded.length !== configured.length || recorded.some((a, i) => a !== configured[i])) {
    throw new FactorySafetyError(`omg factory run refuses the local gate \`${configured.join(' ')}\`: this run recorded \`${recorded.join(' ')}\`; restore factory.forge.local.gate, or cancel the run (omg factory run cancel) and start a new one`);
  }
  const real = realOrResolved(checkout);
  for (const p of [checkout, expectedCheckout]) {
    if (isLink(p)) throw new FactorySafetyError(`omg factory run refuses the local gate in ${checkout} (really ${real}): ${p} is a junction or symlink, never the engine's prepare checkout`);
  }
  if (!sameFsPath(real, realOrResolved(expectedCheckout))) throw new FactorySafetyError(`omg factory run refuses the local gate in ${checkout} (really ${real}): it runs only in the engine's prepare checkout ${expectedCheckout}`);
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
  /** The unsandboxed runner (gates "ack" / "unsandboxed"; default defaultLocalGateRunner, gateEnv). */
  runner?: LocalGateRunner;
  /**
   * How the gate runs (factory.run.sandbox.gates, resolved by the engine), recorded on the record.
   * `enforced` needs `sandbox`: the gate then runs only through it, never through `runner`.
   */
  mode: 'enforced' | 'ack' | 'unsandboxed';
  sandbox?: { run: SandboxRunner; commonGitDir: string };
  now?: () => Date;
}

/** The record of `head`, or undefined when the gate has not run for it (or a rerun removed it). */
export function localGateRecord(stateDir: string, root: string, head: string): LocalCheckRecord | undefined {
  return readLocalCheckRecord(stateDir, root, head);
}

/**
 * True when the gate must run for `head`: no record, or a PENDING record
 * left behind by an engine that died mid-gate. A PENDING record is stale
 * once its `startedAt` is older than the gate's timeout plus
 * LOCAL_GATE_STALE_GRACE_MS: a live engine always replaces PENDING with
 * SUCCESS or FAILURE by then (it kills the gate at the timeout). The record
 * shape carries no pid on purpose: a pid can be reused, the clock cannot.
 */
export function localGateDue(stateDir: string, root: string, head: string, timeoutMinutes: number, now: Date): boolean {
  const r = localGateRecord(stateDir, root, head);
  if (!r) return true;
  if (r.state !== 'PENDING') return false;
  const started = Date.parse(r.startedAt);
  return !Number.isFinite(started) || now.getTime() - started > timeoutMinutes * 60_000 + LOCAL_GATE_STALE_GRACE_MS;
}

/** A run id unique enough per head: positive, from the clock (ForgeRun.databaseId). */
const runIdAt = (d: Date): number => Math.max(1, Math.floor(d.getTime() / 1000));

/** The record's tail, token-shaped text redacted first (it reaches the ci-fix prompt and the PR notes). */
const tailOf = (text: string): string => {
  const clean = redactGateOutput(text);
  return clean.length > LOCAL_GATE_TAIL_CHARS ? clean.slice(-LOCAL_GATE_TAIL_CHARS) : clean;
};

/**
 * The gate ran and recorded a verdict, or it never started (the PENDING
 * record is removed again): its executable cannot start, or (`sandbox`) the
 * OS sandbox could not run it with an attested verdict.
 */
export type LocalGateOutcome = { started: true; record: LocalCheckRecord } | { started: false; reason: string; sandbox?: true; noVerdict?: true };

/**
 * Run the gate for `head` and record SUCCESS or FAILURE (a PENDING record is
 * written first, so a crash mid-gate leaves the head visibly unfinished and
 * the next run sees a pending check, not a pass, until it goes stale). A
 * gate that cannot start records nothing. In mode `enforced` the gate runs
 * only in the sandbox: a sandbox that gives no attested verdict records
 * nothing either (`sandbox: true`), and the plain runner is never tried.
 */
export async function runLocalGate(i: LocalGateInput): Promise<LocalGateOutcome> {
  if (i.gate.length === 0) throw new FactorySafetyError('omg factory run refuses an empty local gate');
  if (i.mode === 'enforced' && !i.sandbox) throw new FactorySafetyError('omg factory run refuses an enforced local gate without a sandbox runner');
  const now = i.now ?? (() => new Date());
  const started = now();
  const base: LocalCheckRecord = { name: LOCAL_GATE_CHECK, head: i.head, state: 'PENDING', argv: [...i.gate], runId: runIdAt(started), startedAt: started.toISOString(), sandbox: i.mode };
  writeLocalCheckRecord(i.stateDir, i.root, base);
  if (i.mode === 'enforced') return runSandboxedGate(i, base, now);
  // What an earlier run of this gate left behind (an engine that died mid-gate): killed only on a matching start identity.
  const procs = gateProcsPath(i.stateDir, i.root, i.head);
  await sweepGateProcs(dirname(procs)).catch(() => undefined);
  await reapGateProcs(procs).catch(() => undefined);
  let r: LocalGateRunResult;
  try {
    r = await (i.runner ?? defaultLocalGateRunner)(i.gate, i.checkout, i.timeoutMinutes * 60_000, createGateProcTracker(procs, Date.now(), undefined, (m) => process.stderr.write(`omg factory run: ${m}\n`)));
  } catch (error) {
    rmSync(localCheckRecordPath(i.stateDir, i.root, i.head), { force: true });
    throw error;
  } finally {
    await reapGateProcs(procs).catch(() => undefined);
  }
  if (r.startError !== undefined) {
    rmSync(localCheckRecordPath(i.stateDir, i.root, i.head), { force: true });
    return { started: false, reason: r.startError };
  }
  const output = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}${r.timedOut ? `\nlocal gate timed out after ${i.timeoutMinutes} min` : ''}`;
  const done: LocalCheckRecord = {
    ...base,
    state: r.status === 0 && !r.timedOut ? 'SUCCESS' : 'FAILURE',
    completedAt: now().toISOString(),
    exitCode: r.timedOut ? 124 : r.status,
    tail: tailOf(output.trim()),
  };
  writeLocalCheckRecord(i.stateDir, i.root, done);
  return { started: true, record: done };
}

/** runLocalGate in the OS sandbox: the argv resolved as for the plain runner, the verdict only when attested. */
async function runSandboxedGate(i: LocalGateInput, base: LocalCheckRecord, now: () => Date): Promise<LocalGateOutcome> {
  const drop = () => rmSync(localCheckRecordPath(i.stateDir, i.root, i.head), { force: true });
  hardenWindowsExeSearch();
  const target = resolveLocalGateArgv(i.gate, { cwd: i.checkout });
  if ('missing' in target) {
    drop();
    return { started: false, reason: target.missing };
  }
  let r: Awaited<ReturnType<SandboxRunner>>;
  try {
    r = await i.sandbox!.run({ purpose: 'gate', argv: i.gate, exe: target.exe, args: target.args, cwd: i.checkout, commonGitDir: i.sandbox!.commonGitDir, timeoutMs: i.timeoutMinutes * 60_000 });
  } catch (error) {
    drop();
    throw error;
  }
  if (!r.ran) {
    drop();
    // `noVerdict`: the command was handed to the sandbox and gave no verdict (gate-no-verdict, never the ack park).
    return { started: false, reason: r.reason, sandbox: true, ...(r.started ? { noVerdict: true as const } : {}) };
  }
  const output = `${r.output}${r.timedOut ? `\nlocal gate timed out after ${i.timeoutMinutes} min` : ''}`;
  const done: LocalCheckRecord = {
    ...base,
    state: r.status === 0 && !r.timedOut ? 'SUCCESS' : 'FAILURE',
    completedAt: now().toISOString(),
    exitCode: r.timedOut ? 124 : r.status,
    tail: tailOf(output.trim()),
  };
  writeLocalCheckRecord(i.stateDir, i.root, done);
  return { started: true, record: done };
}

/**
 * Where the gate argv is defined inside the repository (dogfood F41): an
 * npm-style gate (`npm test`, `npm run <s>`, `pnpm <s>`, `yarn <s>`, or node
 * with npm's own CLI script) is defined by its package.json's `scripts` entry
 * for that script and its `pre`/`post` hooks, plus the package managers'
 * project config (`.npmrc` script-shell/node-options, `.yarnrc`,
 * `.yarnrc.yml`, `.pnpmfile.cjs`) at the repository top and in the package
 * directory; a node gate by the script file it runs; a gate executable given
 * as a repository path by that file. What the script itself runs
 * (vitest.config, scripts/test.mjs) is covered by review, not here.
 * Empty when the argv names nothing in the repository (`node --test`).
 *
 * Config files compare by their text, so a changed `script-shell=` or
 * `userconfig=` line (.npmrc) or `yarnPath:` line (.yarnrc.yml) is caught,
 * but the file such a line points at is not tracked. A `--userconfig` or
 * `--globalconfig` outside the repository is not a repository file and is
 * not compared; an argv `--script-shell` inside the repository is.
 */
export type GateDefinitionSource = { path: string; scripts?: string[] };

/**
 * The gate's definition sources, or why an npm-style gate's definition
 * cannot be pinned (`unresolved`: no script named, a workspace selector, a
 * package directory outside the repository). The engine parks on that
 * rather than run without the check.
 */
export interface GateDefinitionSources { sources: GateDefinitionSource[]; unresolved?: string }

const NPM_TEST = new Set(['test', 't', 'tst']);
const NPM_RUN = new Set(['run', 'run-script', 'rum', 'urn']);
/** Package-manager project config that can redirect how a script runs. */
const PM_CONFIG_FILES = ['.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs'];
/** Options that move the package directory (npm --prefix/-C, pnpm --dir/-C, yarn --cwd). */
const DIR_FLAGS = new Set(['--prefix', '-C', '--dir', '--cwd']);
/** Options that name a config file the package manager reads. */
const CONFIG_FLAGS = new Set(['--userconfig', '--globalconfig']);
/** Options that select workspace packages: the script's package.json is not known from the argv. */
const WORKSPACE_FLAGS = new Set(['--workspace', '-w', '--workspaces', '--ws', '-ws', '--filter', '-F', '--recursive', '-r', '--include-workspace-root']);
/**
 * pnpm/yarn commands that are not a script of the package.json: a workspace
 * selector (`yarn workspace app test`) or a binary or file run outside
 * `scripts` (`pnpm exec`, `yarn dlx`, `yarn node`).
 */
const PM_NON_SCRIPT = new Set(['workspace', 'workspaces', 'recursive', 'exec', 'dlx', 'node', 'create']);
/** Options that take the next argument as their value. */
const VALUE_FLAGS = new Set([...DIR_FLAGS, ...CONFIG_FLAGS, '--workspace', '-w', '--filter', '-F', '--registry', '--cache', '--loglevel', '--script-shell', '--node-options', '--tag', '--otp', '--reporter']);

/** A repository-relative POSIX path, or undefined for an absolute path or one leaving the repository. */
function repoPath(p: string): string | undefined {
  if (posix.isAbsolute(p) || win32.isAbsolute(p) || /^[a-z]:/i.test(p)) return undefined;
  const norm = posix.normalize(p.replace(/\\/g, '/'));
  return norm === '.' || norm.startsWith('../') || norm === '..' ? undefined : norm;
}

function scriptSource(manager: string, args: readonly string[], shown: string): GateDefinitionSources {
  const words: string[] = [];
  let dir = '';
  const configs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (!a.startsWith('-') || a === '-') {
      words.push(a);
      continue;
    }
    // pnpm and yarn pass options after the script name to the script; npm reads them anywhere before `--`.
    if (manager !== 'npm' && words.length > 0) break;
    const eq = a.indexOf('=');
    const flag = eq > 0 ? a.slice(0, eq) : a;
    let value: string | undefined;
    if (eq > 0) value = a.slice(eq + 1);
    else if (VALUE_FLAGS.has(flag)) value = args[++i];
    if (WORKSPACE_FLAGS.has(flag)) return { sources: [], unresolved: `${shown} selects workspace packages (${flag}), so the script's package.json is not known` };
    if (DIR_FLAGS.has(flag)) {
      const p = value === undefined ? undefined : /^\.\/?$/.test(posix.normalize(value.replace(/\\/g, '/'))) ? '' : repoPath(value)?.replace(/\/+$/, '');
      if (p === undefined) return { sources: [], unresolved: `${shown} runs in ${JSON.stringify(value ?? '')}, which is not a directory inside the repository` };
      dir = p;
    } else if ((CONFIG_FLAGS.has(flag) || flag === '--script-shell') && value !== undefined) {
      const p = repoPath(value);
      if (p) configs.push(p);
    }
  }
  const [sub, next] = words;
  let script: string | undefined;
  if (!sub) script = undefined;
  else if (NPM_TEST.has(sub)) script = 'test';
  else if (sub === 'start') script = 'start';
  else if (NPM_RUN.has(sub)) script = next;
  else if (PM_NON_SCRIPT.has(sub)) return { sources: [], unresolved: `${shown} runs ${manager} ${sub}, not a package.json script, so its definition is not known` };
  else if (manager !== 'npm') script = sub;
  if (!script) return { sources: [], unresolved: `${shown} names no package.json script (such as npm test or npm run <script>)` };
  const at = (f: string) => (dir ? `${dir}/${f}` : f);
  const files = [...new Set([...PM_CONFIG_FILES, ...PM_CONFIG_FILES.map(at), ...configs])];
  return { sources: [{ path: at('package.json'), scripts: [`pre${script}`, script, `post${script}`] }, ...files.map((path) => ({ path }))] };
}

const npxUnresolved = (shown: string): string => `${shown} runs npx, which fetches and runs registry code that the repository cannot pin`;

export function gateDefinitionSources(gate: readonly string[]): GateDefinitionSources {
  const [cmd, ...args] = gate;
  if (!cmd) return { sources: [] };
  const shown = `the gate "${gate.join(' ')}"`;
  const name = (cmd.split(/[\\/]/).pop() ?? cmd).toLowerCase().replace(/\.(cmd|bat|exe)$/, '');
  if (name === 'npm' || name === 'pnpm' || name === 'yarn') return scriptSource(name, args, shown);
  // npx runs code the registry serves at that moment: nothing in the repository, at any commit, pins it.
  if (name === 'npx') return { sources: [], unresolved: npxUnresolved(shown) };
  if (name === 'node') {
    const at = args.findIndex((a) => !a.startsWith('-'));
    // An option before the script can change what node runs (-e, -r, --import, --loader, --env-file): only `--run <script>` has a known definition.
    if (args[0] === '--run' && args[1] !== undefined && !args[1].startsWith('-')) return scriptSource('npm', ['run', args[1]], shown);
    // `node --test [--test-* flags] [paths]` and inline code (-e/--eval/-p/--print) are the command itself, held in trusted config: nothing in the repository defines them.
    if (args[0] === '--test' && args.slice(1).every((a) => !a.startsWith('-') || a.startsWith('--test-') || a === '--experimental-test-coverage')) return { sources: [] };
    if (['-e', '--eval', '-p', '--print'].includes(args[0]) && args[1] !== undefined) return { sources: [] };
    if (/^--(eval|print)=/.test(args[0] ?? '')) return { sources: [] };
    if (at !== 0 && args.length > 0) return { sources: [], unresolved: `${shown} passes node the option ${JSON.stringify(args[0])} before its script, so what it runs is not known` };
    if (at < 0) return { sources: [] };
    const target = args[at];
    const base = (target.split(/[\\/]/).pop() ?? '').toLowerCase();
    if (base === 'npm-cli.js') return scriptSource('npm', args.slice(at + 1), shown);
    if (base === 'npx-cli.js') return { sources: [], unresolved: npxUnresolved(shown) };
    const pm = /^(pnpm|yarn)([-.][\w.]+)?\.c?js$/.exec(base);
    if (pm) return scriptSource(pm[1], args.slice(at + 1), shown);
    const p = repoPath(target);
    return { sources: p ? [{ path: p }] : [] };
  }
  // A path names the file the gate runs: a repository file is its own definition; one outside the repository is not the PR's to change.
  if (/[\\/]/.test(cmd)) {
    const own = repoPath(cmd);
    if (own) return { sources: [{ path: own }] };
    // The program itself is not the PR's to change, but its arguments may name repository files (/bin/sh scripts/ci.sh, /usr/bin/env npx x), and the bare name of the same tool parks.
    return { sources: [], unresolved: `${shown} runs ${JSON.stringify(cmd)}, a program outside the repository that may read repository files the gate does not name (a Makefile, pytest.ini, its arguments)` };
  }
  // A bare name is looked up on PATH, never in the checkout (resolveLocalGateArgv): the repository holds no file that defines it.
  return { sources: [], unresolved: `${shown} runs ${JSON.stringify(cmd)} from PATH, and the repository holds no file that defines it` };
}

/**
 * The gate's definition at one commit, comparable across commits: per source
 * the named package.json scripts (a file that is not JSON compares by its
 * text), or the file's text. `read` returns a path's content at that commit,
 * undefined when the file is absent there.
 */
export function gateDefinition(sources: readonly GateDefinitionSource[], read: (path: string) => string | undefined): string {
  return JSON.stringify(sources.map((s) => {
    const text = read(s.path);
    if (!s.scripts || text === undefined) return [s.path, text ?? null];
    let scripts: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(text) as { scripts?: unknown };
      scripts = parsed && typeof parsed.scripts === 'object' && parsed.scripts !== null ? parsed.scripts as Record<string, unknown> : {};
    } catch {
      return [s.path, text];
    }
    return [s.path, s.scripts.map((k) => [k, Object.prototype.hasOwnProperty.call(scripts, k) ? scripts![k] : null])];
  }));
}

/** What a gate change touches, for the park message: `package.json scripts lint` or the file path. */
export const describeGateSources = (sources: readonly GateDefinitionSource[]): string =>
  sources.map((s) => (s.scripts ? `${s.path} scripts ${s.scripts.join('/')}` : s.path)).join(', ');
