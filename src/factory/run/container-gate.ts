/**
 * factory.run.sandbox.isolation "container": the PR's own code in prepare's
 * checks, the local gate and their base calibrations runs in a local
 * container (docker or podman) instead of the Copilot OS sandbox, which on
 * Windows cannot deny paths under the user profile. Opt-in, user config
 * only (copilot-run/sandbox.ts resolveGateIsolation).
 *
 * One command is three or four containers on one named volume
 * (`omg-gate-<run>-<id>`, label `omg.run=<run>`), every one `--rm`, named
 * `omg-gate-<run>-<id>[-step]`, with `--cap-drop ALL`, `no-new-privileges`,
 * `--pids-limit`, `--memory`, `--cpus`, `--init` and `--pull never`:
 *
 * 1. copy: the checkout, bind-mounted READ-ONLY at /in, is copied with tar
 *    into the volume (`.git` and every `node_modules` left out; links stay
 *    links, so one pointing outside the checkout dangles in the container).
 *    No network, no PR code runs. The only step with a host path mounted.
 * 2. install (when the checkout has a package.json that needs one):
 *    `npm ci` WITH network but without any credential: no user profile, no
 *    env but the fixed allowlist (PATH, HOME=/work/home, CI=1, the npm cache
 *    dir), no GH_TOKEN, no ssh agent, no runtime socket; read-only root fs,
 *    non-root user. The npm cache is a volume per lockfile hash
 *    (`omg-gate-cache-<hash>`): npm's cache is content-addressed and checked
 *    against the lockfile's integrity on read, so an install script that
 *    writes into it cannot change what a later install gets. Node modules
 *    themselves are never shared between commands.
 * 3. run: the command with `--network none`, same hardening, in /work/src.
 *    Its merged output keeps only a bounded tail; exit codes map as the OS
 *    sandbox's: 0 pass, other failure, a timeout kills only this container
 *    (status 124, timedOut). The runtime's own error (125) or a signal is
 *    no verdict, never a pass.
 * 4. copy back (a prepare check that passed): the volume's tree comes back
 *    as a tar stream and only regular files are written into the checkout,
 *    after every path was checked (no `..`, no absolute path, no write
 *    through a host link, no link, hardlink or device from the container);
 *    one problem and nothing is written (no verdict).
 *
 * The volume is removed after the command; `omg factory run clean` removes
 * what a killed engine left (containers and volumes by this run's label
 * only). A missing runtime, daemon or image, or a project the container
 * cannot install (no npm lockfile), is `unavailable`: the engine parks at
 * gate-container-unavailable naming the fix, never falls back to the weaker
 * sandbox. Image pulls are announced before they start.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { GateContainerSettings } from '../../copilot-run/sandbox.js';
import { redactGateOutput, SANDBOX_OUTPUT_TAIL_CHARS, type SandboxRunRequest, type SandboxRunResult } from './sandbox-exec.js';
import { runSlug, type FactoryRunKey } from './state.js';

/** The park when the container runtime, its daemon or the image is not there, or the project cannot be installed in it. */
export const GATE_CONTAINER_UNAVAILABLE_GATE = 'gate-container-unavailable';

/** What the gate-sandbox-incompatible park of a base calibration in the container tells the human to do. */
export const CONTAINER_INCOMPATIBLE_ADVICE = 'Your gate fails in the gate container on the base: there it runs with no network, no git dir, as a non-root user on a read-only root (only /tmp, the checkout and HOME writable), with the dependencies npm ci installs from your lockfile. Make the gate work there (or pick another factory.run.sandbox.container.image), or set factory.run.sandbox.isolation "copilot" in your user config';

/** Prefix of every container and volume this module makes; nothing else is ever removed. */
export const CONTAINER_NAME_PREFIX = 'omg-gate-';
export const RUN_LABEL = 'omg.run';
const GATE_LABEL = 'omg.gate';

/** The fixed environment of the install and run containers: nothing of the engine's env passes. */
export const CONTAINER_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const CONTAINER_USER = '1000:1000';
const WORK = '/work';
const SRC = `${WORK}/src`;

const PROBE_TIMEOUT_MS = 20_000;
const PULL_TIMEOUT_MS = 15 * 60_000;
const COPY_TIMEOUT_MS = 10 * 60_000;
const KILL_TIMEOUT_MS = 30_000;
/** The combined output tail kept of any runtime call. */
const OUTPUT_TAIL_BYTES = 64 * 1024;
/** Copy back: the largest tar stream, and the most entries, read from the volume. */
export const COPY_BACK_MAX_BYTES = 256 * 1024 * 1024;
export const COPY_BACK_MAX_ENTRIES = 100_000;

export interface ContainerExecResult {
  /** The runtime CLI's exit code; null on a signal or when it did not start. */
  status: number | null;
  /** The merged stdout and stderr tail (OUTPUT_TAIL_BYTES). */
  tail: string;
  /** All of stdout when `full` was asked and it fit, else undefined. */
  stdout?: Buffer;
  /** stdout went over `full`. */
  overflow: boolean;
  timedOut: boolean;
  /** The CLI could not be started (ENOENT and the like). */
  spawnError?: string;
}

export interface ContainerExecOptions {
  timeoutMs: number;
  /** Keep stdout whole up to this many bytes. */
  full?: number;
  /** Called once at the timeout, before the CLI process is killed (the caller kills its container by name). */
  onTimeout?: () => Promise<void> | void;
}

/** One runtime CLI call (argv only, never a shell); tests pass a fake that records the argv. */
export type ContainerExec = (bin: string, args: readonly string[], o: ContainerExecOptions) => Promise<ContainerExecResult>;

/** One synchronous runtime CLI call for clean (status and stdout). */
export type ContainerExecSync = (bin: string, args: readonly string[]) => { status: number | null; stdout: string };

export interface ContainerGateDeps {
  exec: ContainerExec;
  /** Where announcements go (an image pull); default stderr. */
  log?: (line: string) => void;
  platform?: NodeJS.Platform;
  /** The command's unique part of the names (default 8 random hex). */
  id?: () => string;
}

export const defaultContainerExec: ContainerExec = (bin, args, o) => new Promise((done) => {
  let tail = Buffer.alloc(0);
  const out: Buffer[] = [];
  let outBytes = 0;
  let overflow = false;
  let timedOut = false;
  let settled = false;
  const keep = (chunk: Buffer) => {
    tail = Buffer.concat([tail, chunk]);
    if (tail.length > OUTPUT_TAIL_BYTES) tail = tail.subarray(tail.length - OUTPUT_TAIL_BYTES);
  };
  const finish = (r: Omit<ContainerExecResult, 'tail' | 'overflow' | 'timedOut'>) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(hardKill);
    done({ ...r, tail: tail.toString('utf8'), overflow, timedOut, ...(o.full !== undefined && !overflow ? { stdout: Buffer.concat(out) } : {}) });
  };
  let hardKill: NodeJS.Timeout | undefined;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
  } catch (error) {
    done({ status: null, tail: '', overflow: false, timedOut: false, spawnError: error instanceof Error ? error.message : String(error) });
    return;
  }
  const timer = setTimeout(() => {
    timedOut = true;
    void Promise.resolve(o.onTimeout?.()).catch(() => undefined).finally(() => {
      hardKill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 10_000);
    });
  }, o.timeoutMs);
  child.stdout!.on('data', (chunk: Buffer) => {
    if (o.full !== undefined) {
      if (!overflow && outBytes + chunk.length <= o.full) { out.push(chunk); outBytes += chunk.length; }
      else { overflow = true; out.length = 0; }
    } else keep(chunk);
  });
  child.stderr!.on('data', (chunk: Buffer) => keep(chunk));
  child.on('error', (error) => finish({ status: null, spawnError: error.message }));
  child.on('close', (code) => finish({ status: code }));
});

export const defaultContainerExecSync: ContainerExecSync = (bin, args) => {
  const r = spawnSync(bin, [...args], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 60_000 });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
};

/** The label value (and name part) of a run: a hash of the checkout path, then the run's slug, `[a-z0-9-]` only. */
export function containerRunLabel(root: string, key: FactoryRunKey): string {
  const repo = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 10);
  return `${repo}-${runSlug(key).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40)}`;
}

/** One `--mount` value: CSV fields, each quoted when it holds a comma or a quote (the runtime parses it as CSV). */
export function mountArg(fields: readonly string[]): string {
  return fields.map((f) => (/[",\n\r]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f)).join(',');
}

/** The options every container of a gate gets. */
export function hardeningArgs(s: GateContainerSettings): string[] {
  return [
    '--rm', '--init', '--pull', 'never',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', String(s.pidsLimit), '--memory', s.memory, '--cpus', String(s.cpus),
  ];
}

/** `-e K=V` for the fixed allowlist; nothing of the engine's own env. */
export function containerEnvArgs(extra: Readonly<Record<string, string>> = {}): string[] {
  const env: Record<string, string> = {
    PATH: CONTAINER_PATH,
    HOME: `${WORK}/home`,
    CI: '1',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    ...extra,
  };
  return Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
}

export type InstallPlan = { kind: 'none' } | { kind: 'npm-ci'; lockHash: string } | { kind: 'unsupported'; reason: string };

/** What the checkout needs installed: read through lstat (a linked manifest or lockfile is not followed on the host). */
export function installPlan(checkout: string): InstallPlan {
  const regular = (name: string): boolean => {
    try { return lstatSync(join(checkout, name)).isFile(); } catch { return false; }
  };
  if (!regular('package.json')) return { kind: 'none' };
  for (const lock of ['npm-shrinkwrap.json', 'package-lock.json']) {
    if (regular(lock)) return { kind: 'npm-ci', lockHash: createHash('sha256').update(readFileSync(join(checkout, lock))).digest('hex').slice(0, 16) };
  }
  let pkg: Record<string, unknown> = {};
  try { pkg = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')) as Record<string, unknown>; } catch { /* the container's npm reports it */ }
  const deps = ['dependencies', 'devDependencies', 'optionalDependencies'].some((k) => {
    const v = pkg?.[k];
    return v && typeof v === 'object' && Object.keys(v).length > 0;
  });
  if (!deps) return { kind: 'none' };
  const other = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'].find(regular);
  return { kind: 'unsupported', reason: other ? `the project uses ${other}; the gate container installs npm projects (package-lock.json or npm-shrinkwrap.json) only` : 'the project has dependencies but no package-lock.json; the gate container installs with npm ci only' };
}

const isNodeExe = (p: string): boolean => /^node(?:\.exe)?$/i.test(basename(p));

/**
 * The argv in the container: a node script (the built-in checks, the
 * inventory generator, a calibration's adjusted args) as `node <args>`;
 * any other command as configured, its `node` executable named plainly. A
 * word that is a host path inside the checkout is mapped into /work/src.
 */
export function containerArgv(req: Pick<SandboxRunRequest, 'argv' | 'exe' | 'args' | 'cwd'>): string[] {
  const words = isNodeExe(req.exe) && req.args.length > 0 && !isAbsolute(req.args[0]) ? ['node', ...req.args] : [...req.argv];
  const root = resolve(req.cwd);
  return words.map((w, i) => {
    if (i === 0 && isNodeExe(w)) return 'node';
    if (!isAbsolute(w)) return w;
    const rel = relative(root, resolve(w));
    if (rel === '') return SRC;
    if (rel.startsWith('..') || isAbsolute(rel)) return w;
    return `${SRC}/${rel.split(sep).join('/')}`;
  });
}

/** The copy step's script (fixed text: no word of the checkout reaches it). */
const COPY_SCRIPT = [
  'set -e',
  `mkdir -p ${SRC} ${WORK}/home`,
  // Through a file, not a pipe: sh has no pipefail, and a partial copy must fail the step (copy back removes what is missing).
  `tar -C /in --exclude=.git --exclude=node_modules -cf ${WORK}/in.tar .`,
  `tar -C ${SRC} -xf ${WORK}/in.tar`,
  `rm -f ${WORK}/in.tar`,
  `chown -R ${CONTAINER_USER} ${WORK}`,
  'if [ -d /cache ]; then mkdir -p /cache/npm; [ "$(stat -c %u /cache/npm)" = 1000 ] || chown -R 1000:1000 /cache; fi',
].join('; ');

/**
 * Run one request in a container. Never throws. `unavailable`: nothing of the
 * PR ran and the container path cannot run it (no runtime, daemon or image,
 * an unsupported project); the engine parks at gate-container-unavailable.
 */
export async function runContainerGate(req: SandboxRunRequest, s: GateContainerSettings, runLabel: string, deps: ContainerGateDeps): Promise<SandboxRunResult> {
  const unavailable = (reason: string): SandboxRunResult => ({ ran: false, reason, unavailable: true });
  const noVerdict = (reason: string): SandboxRunResult => ({ ran: false, reason, started: true });
  const log = deps.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const bin = s.runtime;
  const switchBack = 'or set factory.run.sandbox.isolation "copilot" in your user config';
  if (req.purpose === 'install') {
    // The container installs per command into its own volume; the host checkout needs no node_modules.
    return { ran: true, status: 0, output: 'gate container: dependencies are installed in the container per command', timedOut: false };
  }
  if (!/^[a-z0-9-]{1,60}$/.test(runLabel)) return unavailable(`the run label ${JSON.stringify(runLabel)} is not [a-z0-9-]`);
  const probe = await deps.exec(bin, ['version', '--format', '{{.Server.Version}}'], { timeoutMs: PROBE_TIMEOUT_MS });
  if (probe.spawnError !== undefined) return unavailable(`the container runtime ${bin} is not installed or not on PATH (${probe.spawnError}); install it, ${switchBack}`);
  if (probe.status !== 0) return unavailable(`the container runtime ${bin} does not answer (${firstLine(probe.tail) || `exit ${probe.status}`}); start ${bin === 'docker' ? 'Docker Desktop or the docker daemon' : 'the podman machine or service'}, ${switchBack}`);
  const image = await deps.exec(bin, ['image', 'inspect', '--format', '{{.Id}}', s.image], { timeoutMs: PROBE_TIMEOUT_MS });
  if (image.status !== 0) {
    log(`omg factory run: pulling the gate image ${s.image} with ${bin} (factory.run.sandbox.container.image); pin a digest there to fix what runs`);
    const pulled = await deps.exec(bin, ['pull', s.image], { timeoutMs: PULL_TIMEOUT_MS });
    if (pulled.status !== 0) return unavailable(`the gate image ${s.image} is not present and ${bin} pull failed (${firstLine(lastLines(pulled.tail)) || `exit ${pulled.status}`}); pull it yourself, set factory.run.sandbox.container.image, ${switchBack}`);
  }
  const plan = installPlan(req.cwd);
  if (plan.kind === 'unsupported') return unavailable(`${plan.reason}; ${switchBack}`);

  const id = (deps.id ?? (() => randomBytes(4).toString('hex')))();
  const name = `${CONTAINER_NAME_PREFIX}${runLabel}-${id}`;
  const volume = name;
  const cache = plan.kind === 'npm-ci' ? `${CONTAINER_NAME_PREFIX}cache-${plan.lockHash}` : undefined;
  const labels = ['--label', `${RUN_LABEL}=${runLabel}`, '--label', `${GATE_LABEL}=1`];
  const harden = hardeningArgs(s);
  const work = ['--mount', mountArg(['type=volume', `source=${volume}`, `target=${WORK}`])];
  const kill = (container: string) => async () => { await deps.exec(bin, ['kill', container], { timeoutMs: KILL_TIMEOUT_MS }); };
  let volumeMade = false;
  try {
    const made = await deps.exec(bin, ['volume', 'create', ...labels, volume], { timeoutMs: PROBE_TIMEOUT_MS });
    if (made.status !== 0) return unavailable(`${bin} could not create the gate volume (${firstLine(made.tail) || `exit ${made.status}`}); check the runtime's disk, ${switchBack}`);
    volumeMade = true;
    if (cache) {
      const c = await deps.exec(bin, ['volume', 'create', '--label', `${GATE_LABEL}=1`, '--label', 'omg.cache=npm', cache], { timeoutMs: PROBE_TIMEOUT_MS });
      if (c.status !== 0) return unavailable(`${bin} could not create the npm cache volume (${firstLine(c.tail) || `exit ${c.status}`}); ${switchBack}`);
    }
    const cacheMount = cache ? ['--mount', mountArg(['type=volume', `source=${cache}`, `target=/cache`])] : [];

    // 1. copy: root only for tar's chown; the checkout read-only; no network; no PR code runs.
    const copy = await deps.exec(bin, [
      'run', '--name', `${name}-copy`, ...labels, ...harden, '--network', 'none',
      '--user', '0:0', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER',
      '--read-only', '--mount', mountArg(['type=bind', `source=${resolve(req.cwd)}`, 'target=/in', 'readonly']), ...work, ...cacheMount,
      s.image, 'sh', '-c', COPY_SCRIPT,
    ], { timeoutMs: COPY_TIMEOUT_MS, onTimeout: kill(`${name}-copy`) });
    if (copy.status !== 0) return noVerdict(`copying the checkout into the gate container failed (exit ${copy.status ?? 'none'}${copy.timedOut ? ', timed out' : ''}); nothing is counted`);

    const runBase = [...labels, ...harden, '--user', CONTAINER_USER, '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=1g', ...work, '-w', SRC];
    // 2. install: network on, no credential, the npm cache volume.
    if (cache) {
      const timeoutMs = s.installTimeoutMinutes * 60_000;
      const inst = await deps.exec(bin, [
        'run', '--name', `${name}-install`, ...runBase, ...cacheMount, ...containerEnvArgs({ npm_config_cache: '/cache/npm' }),
        s.image, 'npm', 'ci',
      ], { timeoutMs, onTimeout: kill(`${name}-install`) });
      if (inst.timedOut) return { ran: true, status: 124, output: tail(`${inst.tail.trim()}\nthe dependency install (npm ci) in the gate container timed out after ${s.installTimeoutMinutes} min`), timedOut: true };
      if (inst.status === null || inst.status === 125) return noVerdict(`the container runtime failed while the dependency install ran (exit ${inst.status ?? 'none'}); nothing is counted`);
      if (inst.status !== 0) return { ran: true, status: inst.status, output: tail(`${inst.tail.trim()}\nthe dependency install (npm ci) in the gate container failed (exit ${inst.status})`), timedOut: false };
    }

    // 3. run: no network.
    const argv = containerArgv(req);
    const r = await deps.exec(bin, [
      'run', '--name', name, ...runBase, '--network', 'none', ...containerEnvArgs({ npm_config_cache: `${WORK}/home/.npm` }),
      s.image, ...argv,
    ], { timeoutMs: req.timeoutMs, onTimeout: kill(name) });
    if (r.timedOut) return { ran: true, status: 124, output: tail(`${r.tail.trim()}\ntimed out after ${req.timeoutMs} ms`), timedOut: true };
    if (r.spawnError !== undefined || r.status === null || r.status === 125) return noVerdict(`the container runtime failed while the command ran (exit ${r.status ?? 'none'}); nothing is counted`);
    const result: SandboxRunResult = { ran: true, status: r.status, output: tail(r.tail.trim()), timedOut: false };
    if (req.purpose !== 'prepare' || r.status !== 0) return result;

    // 4. copy back what a passing prepare check wrote.
    const back = await deps.exec(bin, [
      'run', '--name', `${name}-export`, ...labels, ...harden, '--network', 'none', '--user', CONTAINER_USER, '--read-only',
      '--mount', mountArg(['type=volume', `source=${volume}`, `target=${WORK}`, 'readonly']),
      s.image, 'tar', '-C', SRC, '--exclude=.git', '--exclude=node_modules', '--format=posix', '-cf', '-', '.',
    ], { timeoutMs: COPY_TIMEOUT_MS, full: COPY_BACK_MAX_BYTES, onTimeout: kill(`${name}-export`) });
    if (back.status !== 0 || !back.stdout) return noVerdict(`reading the prepare check's changes back from the gate container failed (${back.overflow ? 'over the size bound' : `exit ${back.status ?? 'none'}`}); nothing is counted`);
    const problem = applyCopyBack(req.cwd, back.stdout, deps.platform ?? process.platform);
    if (problem) return noVerdict(`the prepare check's changes cannot be copied back safely (${problem}); nothing is counted`);
    return result;
  } catch {
    return noVerdict('the gate container failed unexpectedly; nothing is counted');
  } finally {
    if (volumeMade) {
      for (let i = 0; i < 3; i++) {
        const rm = await deps.exec(bin, ['volume', 'rm', '-f', volume], { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => null);
        if (rm?.status === 0) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
}

const tail = (text: string): string => {
  const clean = redactGateOutput(text);
  return clean.length > SANDBOX_OUTPUT_TAIL_CHARS ? clean.slice(-SANDBOX_OUTPUT_TAIL_CHARS) : clean;
};
const firstLine = (text: string): string => text.trim().split('\n')[0]?.trim().slice(0, 300) ?? '';
const lastLines = (text: string): string => text.trim().split('\n').slice(-1).join('\n');

/** One entry of a tar stream. */
export interface TarEntry { path: string; type: 'file' | 'dir' | 'symlink' | 'hardlink' | 'other'; mode: number; data?: Buffer; linkTarget?: string }

/** A minimal POSIX/ustar tar reader (pax `x` path/linkpath/size records, GNU long names). Throws on a malformed stream. */
export function readTar(buf: Buffer, maxEntries = COPY_BACK_MAX_ENTRIES): TarEntry[] {
  const entries: TarEntry[] = [];
  let off = 0;
  let pax: Record<string, string> = {};
  let longName: string | undefined;
  let longLink: string | undefined;
  const str = (b: Buffer) => { const z = b.indexOf(0); return (z === -1 ? b : b.subarray(0, z)).toString('utf8'); };
  const octal = (b: Buffer): number => {
    if (b[0] & 0x80) throw new Error('base-256 size');
    const t = str(b).trim();
    if (t === '') return 0;
    if (!/^[0-7]+$/.test(t)) throw new Error('bad octal field');
    return parseInt(t, 8);
  };
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) return entries;
    const sum = octal(h.subarray(148, 156));
    let calc = 0;
    for (let i = 0; i < 512; i++) calc += i >= 148 && i < 156 ? 32 : h[i];
    if (calc !== sum) throw new Error('bad header checksum');
    const flag = String.fromCharCode(h[156] || 48);
    let size = octal(h.subarray(124, 136));
    if (pax.size !== undefined) size = Number(pax.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('bad size');
    const start = off + 512;
    const end = start + size;
    if (end > buf.length) throw new Error('truncated');
    const data = buf.subarray(start, end);
    off = start + Math.ceil(size / 512) * 512;
    if (flag === 'x') { pax = { ...pax, ...parsePax(data) }; continue; }
    if (flag === 'g') continue;
    if (flag === 'L') { longName = str(data); continue; }
    if (flag === 'K') { longLink = str(data); continue; }
    const prefix = str(h.subarray(345, 500));
    const path = pax.path ?? longName ?? (prefix ? `${prefix}/${str(h.subarray(0, 100))}` : str(h.subarray(0, 100)));
    const linkTarget = pax.linkpath ?? longLink ?? str(h.subarray(157, 257));
    const type: TarEntry['type'] = flag === '0' || flag === '7' ? 'file' : flag === '5' ? 'dir' : flag === '2' ? 'symlink' : flag === '1' ? 'hardlink' : 'other';
    entries.push({ path, type, mode: octal(h.subarray(100, 108)), ...(type === 'file' ? { data: Buffer.from(data) } : {}), ...(type === 'symlink' || type === 'hardlink' ? { linkTarget } : {}) });
    if (entries.length > maxEntries) throw new Error('too many entries');
    pax = {};
    longName = undefined;
    longLink = undefined;
  }
  throw new Error('no end-of-archive marker');
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) throw new Error('bad pax record');
    const len = Number(data.subarray(i, space).toString('ascii'));
    if (!Number.isSafeInteger(len) || len <= space - i || i + len > data.length) throw new Error('bad pax record');
    const rec = data.subarray(space + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** A relative POSIX path from the tar, normalised (`./` dropped), or null when it may not be written on this host. */
export function safeRelPath(raw: string, platform: NodeJS.Platform): string | null {
  const p = raw.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if (p === '' || p === '.') return '';
  if (p.startsWith('/') || p.includes('\0') || p.includes('\\')) return null;
  const parts = p.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return null;
  if (parts.some((s) => s === '.git' || s === 'node_modules')) return null;
  if (platform === 'win32' && parts.some((s) => /[<>:"|?*\x00-\x1f]/.test(s) || /[. ]$/.test(s) || /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i.test(s))) return null;
  return p;
}

/** The host checkout's files outside `.git` and `node_modules`, by relative POSIX path (lstat: links are not followed). */
function hostTree(root: string): Map<string, 'file' | 'symlink' | 'dir' | 'other'> {
  const out = new Map<string, 'file' | 'symlink' | 'dir' | 'other'>();
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      if (name === '.git' || name === 'node_modules') continue;
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, name));
      const kind = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
      out.set(r, kind);
      if (kind === 'dir') walk(join(dir, name), r);
    }
  };
  walk(root, '');
  return out;
}

/**
 * Write the container's tree back into the checkout: regular files that
 * differ are written, host files the container removed are removed. Checked
 * whole before anything is written; returns a fixed-text problem (never a
 * path: the names are the PR's) and writes nothing when one fails.
 */
export function applyCopyBack(checkout: string, tar: Buffer, platform: NodeJS.Platform): string | null {
  let entries: TarEntry[];
  try { entries = readTar(tar); } catch { return 'the tar stream is malformed or too large'; }
  let host: Map<string, 'file' | 'symlink' | 'dir' | 'other'>;
  try { host = hostTree(checkout); } catch { return 'the checkout could not be listed'; }
  const want = new Map<string, TarEntry>();
  for (const e of entries) {
    const rel = safeRelPath(e.path, platform);
    if (rel === null) return 'an entry has a path that cannot be written here';
    if (rel === '') continue;
    want.set(rel, e);
  }
  const writes: Array<{ rel: string; data: Buffer; mode: number }> = [];
  for (const [rel, e] of want) {
    const kind = host.get(rel);
    if (e.type === 'dir') {
      if (kind !== undefined && kind !== 'dir') return 'a directory replaces a host file or link';
      continue;
    }
    if (e.type === 'symlink') {
      // An unchanged link (copied in, copied back) is fine; a new or changed one is never made on the host.
      if (kind !== 'symlink') return 'the check created a symbolic link';
      continue;
    }
    if (e.type !== 'file') return 'the check created a hardlink, device or other special file';
    if (kind !== undefined && kind !== 'file') return 'a file replaces a host directory or link';
    // Every parent on the host is a real directory or does not exist yet (made below): never a link.
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = host.get(parts.slice(0, i).join('/'));
      if (parent !== undefined && parent !== 'dir') return 'a file would be written through a host link';
      const w = want.get(parts.slice(0, i).join('/'));
      if (parent === undefined && w && w.type !== 'dir') return 'a file would be written under a non-directory';
    }
    if (kind === 'file') {
      const cur = readFileSync(join(checkout, ...parts));
      if (cur.equals(e.data!)) continue;
    }
    writes.push({ rel, data: e.data!, mode: e.mode });
  }
  const removals = [...host].filter(([rel, kind]) => (kind === 'file' || kind === 'symlink') && !want.has(rel)).map(([rel]) => rel);
  for (const { rel, data, mode } of writes) {
    const path = join(checkout, ...rel.split('/'));
    mkdirSync(join(checkout, ...rel.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(path, data);
    if (platform !== 'win32') chmodSync(path, mode & 0o111 ? 0o755 : 0o644);
  }
  // unlink removes a link itself, never its target.
  for (const rel of removals) unlinkSync(join(checkout, ...rel.split('/')));
  return null;
}

/** The runtime's version for `omg factory check` (null when it does not answer). */
export function probeContainerRuntime(s: GateContainerSettings, execSync: ContainerExecSync = defaultContainerExecSync): { version: string | null; image: boolean } {
  const v = execSync(s.runtime, ['version', '--format', '{{.Server.Version}}']);
  const version = v.status === 0 ? v.stdout.trim().split('\n')[0] || 'unknown' : null;
  const image = version !== null && execSync(s.runtime, ['image', 'inspect', '--format', '{{.Id}}', s.image]).status === 0;
  return { version, image };
}

/**
 * `omg factory run clean`: this run's leftover containers (a killed engine)
 * and volumes, found by its label AND the name prefix; nothing else. A
 * runtime that does not answer removes nothing (and says so).
 */
export function cleanRunContainers(runtime: GateContainerSettings['runtime'], runLabel: string, execSync: ContainerExecSync = defaultContainerExecSync): { removed: string[]; problem?: string } {
  const filter = ['--filter', `label=${RUN_LABEL}=${runLabel}`];
  const ours = (out: string) => out.split(/\r?\n/).map((l) => l.trim()).filter((n) => n.startsWith(`${CONTAINER_NAME_PREFIX}${runLabel}-`) && /^[a-z0-9-]+$/.test(n));
  const ps = execSync(runtime, ['ps', '-a', '--format', '{{.Names}}', ...filter]);
  if (ps.status !== 0) return { removed: [], problem: `${runtime} did not answer; this run's gate containers and volumes (label ${RUN_LABEL}=${runLabel}) were not checked` };
  const removed: string[] = [];
  for (const n of ours(ps.stdout)) if (execSync(runtime, ['rm', '-f', n]).status === 0) removed.push(n);
  const vols = execSync(runtime, ['volume', 'ls', '--format', '{{.Name}}', ...filter]);
  for (const n of vols.status === 0 ? ours(vols.stdout) : []) if (execSync(runtime, ['volume', 'rm', '-f', n]).status === 0) removed.push(n);
  return { removed };
}
