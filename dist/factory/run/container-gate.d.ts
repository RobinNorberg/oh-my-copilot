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
import type { GateContainerSettings } from '../../copilot-run/sandbox.js';
import { type SandboxRunRequest, type SandboxRunResult } from './sandbox-exec.js';
import { type FactoryRunKey } from './state.js';
/** The park when the container runtime, its daemon or the image is not there, or the project cannot be installed in it. */
export declare const GATE_CONTAINER_UNAVAILABLE_GATE = "gate-container-unavailable";
/** What the gate-sandbox-incompatible park of a base calibration in the container tells the human to do. */
export declare const CONTAINER_INCOMPATIBLE_ADVICE = "Your gate fails in the gate container on the base: there it runs with no network, no git dir, as a non-root user on a read-only root (only /tmp, the checkout and HOME writable), with the dependencies npm ci installs from your lockfile. Make the gate work there (or pick another factory.run.sandbox.container.image), or set factory.run.sandbox.isolation \"copilot\" in your user config";
/** Prefix of every container and volume this module makes; nothing else is ever removed. */
export declare const CONTAINER_NAME_PREFIX = "omg-gate-";
export declare const RUN_LABEL = "omg.run";
/** The fixed environment of the install and run containers: nothing of the engine's env passes. */
export declare const CONTAINER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** Copy back: the largest tar stream, and the most entries, read from the volume. */
export declare const COPY_BACK_MAX_BYTES: number;
export declare const COPY_BACK_MAX_ENTRIES = 100000;
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
export type ContainerExecSync = (bin: string, args: readonly string[]) => {
    status: number | null;
    stdout: string;
};
export interface ContainerGateDeps {
    exec: ContainerExec;
    /** Where announcements go (an image pull); default stderr. */
    log?: (line: string) => void;
    platform?: NodeJS.Platform;
    /** The command's unique part of the names (default 8 random hex). */
    id?: () => string;
}
export declare const defaultContainerExec: ContainerExec;
export declare const defaultContainerExecSync: ContainerExecSync;
/** The label value (and name part) of a run: a hash of the checkout path, then the run's slug, `[a-z0-9-]` only. */
export declare function containerRunLabel(root: string, key: FactoryRunKey): string;
/** One `--mount` value: CSV fields, each quoted when it holds a comma or a quote (the runtime parses it as CSV). */
export declare function mountArg(fields: readonly string[]): string;
/** The options every container of a gate gets. */
export declare function hardeningArgs(s: GateContainerSettings): string[];
/** `-e K=V` for the fixed allowlist; nothing of the engine's own env. */
export declare function containerEnvArgs(extra?: Readonly<Record<string, string>>): string[];
export type InstallPlan = {
    kind: 'none';
} | {
    kind: 'npm-ci';
    lockHash: string;
} | {
    kind: 'unsupported';
    reason: string;
};
/** What the checkout needs installed: read through lstat (a linked manifest or lockfile is not followed on the host). */
export declare function installPlan(checkout: string): InstallPlan;
/**
 * The argv in the container: a node script (the built-in checks, the
 * inventory generator, a calibration's adjusted args) as `node <args>`;
 * any other command as configured, its `node` executable named plainly. A
 * word that is a host path inside the checkout is mapped into /work/src.
 */
export declare function containerArgv(req: Pick<SandboxRunRequest, 'argv' | 'exe' | 'args' | 'cwd'>): string[];
/**
 * Run one request in a container. Never throws. `unavailable`: nothing of the
 * PR ran and the container path cannot run it (no runtime, daemon or image,
 * an unsupported project); the engine parks at gate-container-unavailable.
 */
export declare function runContainerGate(req: SandboxRunRequest, s: GateContainerSettings, runLabel: string, deps: ContainerGateDeps): Promise<SandboxRunResult>;
/** One entry of a tar stream. */
export interface TarEntry {
    path: string;
    type: 'file' | 'dir' | 'symlink' | 'hardlink' | 'other';
    mode: number;
    data?: Buffer;
    linkTarget?: string;
}
/** A minimal POSIX/ustar tar reader (pax `x` path/linkpath/size records, GNU long names). Throws on a malformed stream. */
export declare function readTar(buf: Buffer, maxEntries?: number): TarEntry[];
/** A relative POSIX path from the tar, normalised (`./` dropped), or null when it may not be written on this host. */
export declare function safeRelPath(raw: string, platform: NodeJS.Platform): string | null;
/**
 * Write the container's tree back into the checkout: regular files that
 * differ are written, host files the container removed are removed. Checked
 * whole before anything is written; returns a fixed-text problem (never a
 * path: the names are the PR's) and writes nothing when one fails.
 */
export declare function applyCopyBack(checkout: string, tar: Buffer, platform: NodeJS.Platform): string | null;
/** The runtime's version for `omg factory check` (null when it does not answer). */
export declare function probeContainerRuntime(s: GateContainerSettings, execSync?: ContainerExecSync): {
    version: string | null;
    image: boolean;
};
/**
 * `omg factory run clean`: this run's leftover containers (a killed engine)
 * and volumes, found by its label AND the name prefix; nothing else. A
 * runtime that does not answer removes nothing (and says so).
 */
export declare function cleanRunContainers(runtime: GateContainerSettings['runtime'], runLabel: string, execSync?: ContainerExecSync): {
    removed: string[];
    problem?: string;
};
//# sourceMappingURL=container-gate.d.ts.map