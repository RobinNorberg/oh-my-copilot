/**
 * factory.run.sandbox.isolation "container": the PR's own code in prepare's
 * checks, the local gate and their base calibrations runs in a local
 * container (docker or podman) instead of the Copilot OS sandbox, which on
 * Windows cannot deny paths under the user profile. Opt-in, user config
 * only (copilot-run/sandbox.ts resolveGateIsolation).
 *
 * One command is a few containers on one named volume
 * (`omg-gate-<run>-<id>`, label `omg.run=<run>`), every one `--rm`, named
 * `omg-gate-<run>-<id>[-step]`, with `--cap-drop ALL`, `no-new-privileges`,
 * `--pids-limit`, `--memory`, `--cpus`, `--init`, `--pull never`, and its
 * argv under `timeout -s KILL` (the container ends itself even when the
 * runtime's kill does not get through):
 *
 * 0. scan (host, before any container): the checkout may hold no link that
 *    resolves outside it (or not at all) and no file with more than one
 *    hard link, outside the exact `.git` and `node_modules` names the copy
 *    leaves out. So the read-only bind below never presents anything from
 *    outside the checkout, however the runtime's file sharing treats links.
 * 1. copy: the checkout, bind-mounted READ-ONLY at /in, is copied with tar
 *    into the volume (`.git` and every `node_modules` left out; links stay
 *    links). No network, no PR code runs. The only step with a host path.
 * 2. install (a package.json with a package-lock.json): only npm itself
 *    gets network, never the PR's code:
 *    a. `npm ci --ignore-scripts` on a per-command bridge network
 *       (`omg-gate-<run>-<id>-net`, labelled, inter-container traffic off),
 *       no credential: no user profile, no env but the fixed allowlist, no
 *       GH_TOKEN, no ssh agent, no runtime socket; read-only root fs,
 *       non-root user. The checkout's `.npmrc` is held aside (the copy step
 *       moves it, 2b puts it back first) and npm's registry, proxy and TLS
 *       settings are forced by env (NPM_FETCH_ENV). The npm cache is a volume per lockfile hash
 *       (`omg-gate-cache-<hash>`) only when every locked package comes from
 *       the npm registry with an `integrity`; a lockfile with an entry
 *       without one uses a fresh cache inside the command's own volume, and
 *       one resolved from anywhere else (git, a tarball URL, a file) is
 *       unavailable. No code of the PR runs while the shared cache is
 *       mounted, so it holds only what npm verified.
 *    b. the install scripts (`npm rebuild`, then the root's lifecycle
 *       scripts in npm ci's order) with `--network none` and no cache.
 *    Node modules themselves are never shared between commands.
 * 3. run: the command with `--network none`, same hardening, in /work/src.
 *    Its merged output keeps only a bounded tail; exit codes map as the OS
 *    sandbox's: 0 pass, other failure, a timeout kills only this container
 *    (status 124, timedOut). The runtime's own error (125) or a signal is
 *    no verdict, never a pass. While 2 and 3 run, a watchdog measures the
 *    work volume (`du`, from a separate read-only container) and kills the
 *    step's container when it holds more than container.diskLimit.
 * 4. copy back (a prepare check that passed): the volume's tree comes back
 *    as a tar stream and only regular files are written into the checkout,
 *    after every path was checked (applyCopyBack); one problem and nothing
 *    is written (no verdict).
 *
 * The step containers, the network and the volume are removed after the
 * command; `omg factory run clean` removes what a killed engine left (by
 * this run's label and name prefix only). A missing runtime, daemon or
 * image, or a project the container cannot install, is `unavailable`: the
 * engine parks at gate-container-unavailable naming the fix, never falls
 * back to the weaker sandbox. Image pulls are announced before they start.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { redactGateOutput, SANDBOX_OUTPUT_TAIL_CHARS } from './sandbox-exec.js';
import { runSlug } from './state.js';
/** The park when the container runtime, its daemon or the image is not there, or the project cannot be installed in it. */
export const GATE_CONTAINER_UNAVAILABLE_GATE = 'gate-container-unavailable';
/** What the gate-sandbox-incompatible park of a base calibration in the container tells the human to do. */
export const CONTAINER_INCOMPATIBLE_ADVICE = 'Your gate fails in the gate container on the base: there it runs with no network, no git dir, as a non-root user on a read-only root (only /tmp, the checkout and HOME writable), with the dependencies npm ci installs from your lockfile and their install scripts run without network. Make the gate work there (or pick another factory.run.sandbox.container.image), or set factory.run.sandbox.isolation "copilot" in your user config';
/** Prefix of every container, network and volume this module makes; nothing else is ever removed. */
export const CONTAINER_NAME_PREFIX = 'omg-gate-';
export const RUN_LABEL = 'omg.run';
const GATE_LABEL = 'omg.gate';
const CACHE_LABEL = 'omg.cache';
/** The fixed environment of the install and run containers: nothing of the engine's env passes. */
export const CONTAINER_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const CONTAINER_USER = '1000:1000';
const WORK = '/work';
const SRC = `${WORK}/src`;
/** The only registry the install talks to (the checkout's .npmrc is held aside), and the hosts a locked package may come from. */
const NPM_REGISTRY = 'https://registry.npmjs.org/';
const REGISTRY_PREFIXES = [NPM_REGISTRY, 'https://registry.yarnpkg.com/'];
const PROBE_TIMEOUT_MS = 20_000;
const PULL_TIMEOUT_MS = 15 * 60_000;
const COPY_TIMEOUT_MS = 10 * 60_000;
const KILL_TIMEOUT_MS = 30_000;
/** The in-container `timeout -s KILL` fires this long after the engine's own timer (which kills by name first). */
const IN_CONTAINER_GRACE_S = 30;
/** How often the disk watchdog measures the work volume. */
const DISK_WATCH_MS = 10_000;
/** The combined output tail kept of any runtime call. */
const OUTPUT_TAIL_BYTES = 64 * 1024;
/** Copy back: the largest tar stream, and the most entries, read from the volume. */
export const COPY_BACK_MAX_BYTES = 256 * 1024 * 1024;
export const COPY_BACK_MAX_ENTRIES = 100_000;
/** The scan before the copy: the most entries it walks. */
const SCAN_MAX_ENTRIES = 200_000;
const LOCKFILE_MAX_BYTES = 64 * 1024 * 1024;
export const defaultContainerExec = (bin, args, o) => new Promise((done) => {
    let tail = Buffer.alloc(0);
    const out = [];
    let outBytes = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;
    const keep = (chunk) => {
        tail = Buffer.concat([tail, chunk]);
        if (tail.length > OUTPUT_TAIL_BYTES)
            tail = tail.subarray(tail.length - OUTPUT_TAIL_BYTES);
    };
    const finish = (r) => {
        if (settled)
            return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(hardKill);
        done({ ...r, tail: tail.toString('utf8'), overflow, timedOut, ...(o.full !== undefined && !overflow ? { stdout: Buffer.concat(out) } : {}) });
    };
    let hardKill;
    let child;
    try {
        child = spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    }
    catch (error) {
        done({ status: null, tail: '', overflow: false, timedOut: false, spawnError: error instanceof Error ? error.message : String(error) });
        return;
    }
    const timer = setTimeout(() => {
        timedOut = true;
        void Promise.resolve(o.onTimeout?.()).catch(() => undefined).finally(() => {
            hardKill = setTimeout(() => { try {
                child.kill('SIGKILL');
            }
            catch { /* gone */ } }, 10_000);
        });
    }, o.timeoutMs);
    child.stdout.on('data', (chunk) => {
        if (o.full !== undefined) {
            if (!overflow && outBytes + chunk.length <= o.full) {
                out.push(chunk);
                outBytes += chunk.length;
            }
            else {
                overflow = true;
                out.length = 0;
            }
        }
        else
            keep(chunk);
    });
    child.stderr.on('data', (chunk) => keep(chunk));
    child.on('error', (error) => finish({ status: null, spawnError: error.message }));
    child.on('close', (code) => finish({ status: code }));
});
export const defaultContainerExecSync = (bin, args) => {
    const r = spawnSync(bin, [...args], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 60_000 });
    return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
};
/** The label value (and name part) of a run: a hash of the checkout path, then the run's slug, `[a-z0-9-]` only. */
export function containerRunLabel(root, key) {
    const repo = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 10);
    return `${repo}-${runSlug(key).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40)}`;
}
/** One `--mount` value: CSV fields, each quoted when it holds a comma or a quote (the runtime parses it as CSV). */
export function mountArg(fields) {
    return fields.map((f) => (/[",\n\r]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f)).join(',');
}
/** The options every container of a gate gets. */
export function hardeningArgs(s) {
    return [
        '--rm', '--init', '--pull', 'never',
        // No container log on the runtime's disk, outside the watched volume (review-499b N1): output comes through the attached CLI only.
        '--log-driver', 'none',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--pids-limit', String(s.pidsLimit), '--memory', s.memory, '--cpus', String(s.cpus),
    ];
}
/** `-e K=V` for the fixed allowlist; nothing of the engine's own env. */
export function containerEnvArgs(extra = {}) {
    const env = {
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
/** `argv` under coreutils `timeout -s KILL`: the container ends itself `IN_CONTAINER_GRACE_S` after the engine's timer. */
export function inContainerLimit(timeoutMs, argv) {
    return ['timeout', '-s', 'KILL', `${Math.ceil(timeoutMs / 1000) + IN_CONTAINER_GRACE_S}s`, ...argv];
}
/** A size as container.diskLimit gives it ("10g", "800m") in bytes. */
export function sizeBytes(size) {
    const m = /^(\d+)([mg])$/i.exec(size);
    if (!m)
        throw new Error(`not a size: ${size}`);
    return Number(m[1]) * (m[2].toLowerCase() === 'g' ? 1024 ** 3 : 1024 ** 2);
}
/**
 * Whether the lockfile's packages may share the npm cache: every locked
 * package from the npm registry with an `integrity` ('shared'); one without
 * an integrity ('private': a fresh cache in the command's volume); one
 * resolved from anywhere else (git, a tarball URL, a file) refuses (its
 * fetch is not checked by an integrity and git is not in the image).
 */
export function lockfileCachePolicy(lock) {
    if (!lock || typeof lock !== 'object' || Array.isArray(lock))
        return { refuse: 'the lockfile is not a JSON object' };
    const outside = { refuse: 'the lockfile has a package that does not come from the npm registry (git, a tarball URL or a file); the gate container installs registry packages only' };
    let integrity = true;
    const check = (e, version) => {
        if (typeof e.resolved === 'string' && !REGISTRY_PREFIXES.some((p) => e.resolved.startsWith(p)))
            return false;
        if (typeof version === 'string' && /^[a-z+]+:/i.test(version) && !version.startsWith('npm:'))
            return false;
        if (typeof e.integrity !== 'string' || e.integrity === '')
            integrity = false;
        return true;
    };
    const packages = lock.packages;
    if (packages && typeof packages === 'object' && !Array.isArray(packages)) {
        for (const [key, raw] of Object.entries(packages)) {
            if (key === '' || !raw || typeof raw !== 'object')
                continue;
            const e = raw;
            // A workspace's own folder, a workspace link, a bundled dependency: nothing is fetched for it.
            if (!key.includes('node_modules/') || e.link === true || e.inBundle === true)
                continue;
            if (!check(e))
                return outside;
        }
        return integrity ? 'shared' : 'private';
    }
    // lockfileVersion 1: nested `dependencies`.
    const walk = (deps, depth) => {
        if (!deps || typeof deps !== 'object' || depth > 64)
            return true;
        for (const raw of Object.values(deps)) {
            if (!raw || typeof raw !== 'object')
                continue;
            const e = raw;
            if (e.bundled === true)
                continue;
            if (!check(e, e.version) || !walk(e.dependencies, depth + 1))
                return false;
        }
        return true;
    };
    if (!walk(lock.dependencies, 0))
        return outside;
    return integrity ? 'shared' : 'private';
}
/** What the checkout needs installed: read through lstat (a linked manifest or lockfile is not followed on the host). */
export function installPlan(checkout) {
    const regular = (name) => {
        try {
            return lstatSync(join(checkout, name)).isFile();
        }
        catch {
            return false;
        }
    };
    if (!regular('package.json'))
        return { kind: 'none' };
    for (const lock of ['npm-shrinkwrap.json', 'package-lock.json']) {
        if (!regular(lock))
            continue;
        const path = join(checkout, lock);
        if (lstatSync(path).size > LOCKFILE_MAX_BYTES)
            return { kind: 'unsupported', reason: `${lock} is larger than the gate container reads` };
        const bytes = readFileSync(path);
        let json;
        try {
            json = JSON.parse(bytes.toString('utf8'));
        }
        catch {
            return { kind: 'unsupported', reason: `${lock} is not valid JSON` };
        }
        const policy = lockfileCachePolicy(json);
        if (typeof policy === 'object')
            return { kind: 'unsupported', reason: policy.refuse };
        return { kind: 'npm-ci', lockHash: createHash('sha256').update(bytes).digest('hex').slice(0, 16), sharedCache: policy === 'shared' };
    }
    let pkg = {};
    try {
        pkg = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'));
    }
    catch { /* the container's npm reports it */ }
    const deps = ['dependencies', 'devDependencies', 'optionalDependencies'].some((k) => {
        const v = pkg?.[k];
        return v && typeof v === 'object' && Object.keys(v).length > 0;
    });
    if (!deps)
        return { kind: 'none' };
    const other = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'].find(regular);
    return { kind: 'unsupported', reason: other ? `the project uses ${other}; the gate container installs npm projects (package-lock.json or npm-shrinkwrap.json) only` : 'the project has dependencies but no package-lock.json; the gate container installs with npm ci only' };
}
const isNodeExe = (p) => /^node(?:\.exe)?$/i.test(basename(p));
/**
 * The argv in the container: a node script (the built-in checks, the
 * inventory generator, a calibration's adjusted args) as `node <args>`;
 * any other command as configured, its `node` executable named plainly. A
 * word that is a host path inside the checkout is mapped into /work/src.
 */
export function containerArgv(req) {
    const words = isNodeExe(req.exe) && req.args.length > 0 && !isAbsolute(req.args[0]) ? ['node', ...req.args] : [...req.argv];
    const root = resolve(req.cwd);
    return words.map((w, i) => {
        if (i === 0 && isNodeExe(w))
            return 'node';
        if (!isAbsolute(w))
            return w;
        const rel = relative(root, resolve(w));
        if (rel === '')
            return SRC;
        if (rel.startsWith('..') || isAbsolute(rel))
            return w;
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
 * The checkout's own `.npmrc` (scoped registries, proxies, strict-ssl) steers
 * npm itself, so it is held outside the project while npm ci fetches and put
 * back before any of the PR's code runs (review-499b N2). Fixed text.
 */
const NPMRC_HELD = `${WORK}/npmrc.held`;
const HOLD_NPMRC = `if [ -e ${SRC}/.npmrc ] || [ -L ${SRC}/.npmrc ]; then mv ${SRC}/.npmrc ${NPMRC_HELD}; fi`;
const RESTORE_NPMRC = `if [ -e ${NPMRC_HELD} ] || [ -L ${NPMRC_HELD} ]; then rm -rf ${SRC}/.npmrc; mv ${NPMRC_HELD} ${SRC}/.npmrc; fi`;
/** The copy step's script for a plan: the npm ci plan also holds the checkout's .npmrc aside. */
export function copyScript(npmCi) {
    return npmCi ? `${COPY_SCRIPT}; ${HOLD_NPMRC}` : COPY_SCRIPT;
}
/**
 * npm's own settings in the fetch step, over anything npm would read (no
 * .npmrc is in the project then; these beat the image's global one): the npm
 * registry only, no proxy, TLS checked, and lockfile URLs fetched from it.
 */
export const NPM_FETCH_ENV = {
    npm_config_registry: NPM_REGISTRY,
    npm_config_proxy: 'null',
    npm_config_https_proxy: 'null',
    npm_config_strict_ssl: 'true',
    npm_config_replace_registry_host: 'npmjs',
};
/**
 * The install scripts npm ci would have run, without network (fixed text):
 * the dependencies' (npm rebuild), then the root's lifecycle scripts in npm
 * ci's order, each alone (`--ignore-scripts` keeps npm run from adding the
 * pre/post scripts a second time).
 */
const SCRIPTS_SCRIPT = [
    'set -e',
    RESTORE_NPMRC,
    'npm rebuild --foreground-scripts',
    'for s in preinstall install postinstall prepublish preprepare prepare postprepare; do npm run --if-present --ignore-scripts "$s"; done',
].join('; ');
/**
 * The scan before the copy (fixed-text problem, never a name: the names are
 * the PR's): a link that resolves outside the checkout or not at all, or a
 * file with more than one hard link, outside the exact `.git` and
 * `node_modules` names tar leaves out. Null when the checkout may be bound.
 */
export function checkoutCopyProblem(checkout) {
    let root;
    try {
        root = realpathSync.native(checkout);
    }
    catch {
        return 'the checkout could not be resolved';
    }
    let seen = 0;
    const inside = (p) => samePathOrUnder(p, root);
    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
            if (name === '.git' || name === 'node_modules')
                continue;
            if (++seen > SCAN_MAX_ENTRIES)
                return 'the checkout has more files than the gate container copies';
            const path = join(dir, name);
            const st = lstatSync(path);
            if (st.isSymbolicLink()) {
                const lexical = linkTargetProblem(readlinkSync(path), relative(root, dir).split(sep).filter(Boolean).length);
                if (lexical)
                    return lexical;
                let target;
                try {
                    target = realpathSync.native(path);
                }
                catch {
                    return 'the checkout has a link whose target does not exist';
                }
                if (!inside(target))
                    return 'the checkout has a link (a symbolic link or junction) that points outside it';
                continue;
            }
            if (st.isDirectory()) {
                const p = walk(path);
                if (p)
                    return p;
            }
            else if (st.isFile() && st.nlink > 1)
                return 'the checkout has a file with more than one hard link';
        }
        return null;
    };
    try {
        return walk(root);
    }
    catch {
        return 'the checkout could not be listed';
    }
}
/**
 * A link target as the container's Linux kernel will follow it, checked
 * without the host (review-499b N5): no absolute target (POSIX or Windows
 * form, a junction's included), and `..` only as a leading run that stays
 * inside the checkout from the link's own directory (`depth` names below the
 * root). Once a name was walked, a later `..` would step back through what
 * may be another link, which the host resolved by its own rules. Both `/` and
 * `\` split, so neither side's reading slips through. A problem, or null.
 */
export function linkTargetProblem(target, depth) {
    if (target === '' || target.startsWith('/') || target.startsWith('\\') || /^[A-Za-z]:/.test(target))
        return 'the checkout has a link with an absolute target';
    let up = 0;
    let walked = false;
    for (const part of target.split(/[\\/]+/)) {
        if (part === '' || part === '.')
            continue;
        if (part !== '..') {
            walked = true;
            continue;
        }
        if (walked)
            return 'the checkout has a link whose target steps back (..) after a name';
        if (++up > depth)
            return 'the checkout has a link (a symbolic link or junction) that points outside it';
    }
    return null;
}
/** `p` is `root` or under it (case-insensitively on win32, where realpath can differ in case only). */
function samePathOrUnder(p, root) {
    const norm = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);
    const a = norm(p);
    const b = norm(root);
    return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}
/**
 * Run one request in a container. Never throws. `unavailable`: nothing of the
 * PR ran and the container path cannot run it (no runtime, daemon or image,
 * an unsupported project); the engine parks at gate-container-unavailable.
 */
export async function runContainerGate(req, s, runLabel, deps) {
    const unavailable = (reason) => ({ ran: false, reason, unavailable: true });
    const noVerdict = (reason) => ({ ran: false, reason, started: true });
    const log = deps.log ?? ((line) => { process.stderr.write(`${line}\n`); });
    const bin = s.runtime;
    const switchBack = 'or set factory.run.sandbox.isolation "copilot" in your user config';
    if (req.purpose === 'install') {
        // The container installs per command into its own volume; the host checkout needs no node_modules.
        return { ran: true, status: 0, output: 'gate container: dependencies are installed in the container per command', timedOut: false };
    }
    if (!/^[a-z0-9-]{1,60}$/.test(runLabel))
        return unavailable(`the run label ${JSON.stringify(runLabel)} is not [a-z0-9-]`);
    let diskLimit;
    try {
        diskLimit = sizeBytes(s.diskLimit);
    }
    catch {
        return unavailable(`factory.run.sandbox.container.diskLimit ${JSON.stringify(s.diskLimit)} is not a size`);
    }
    const probe = await deps.exec(bin, ['version', '--format', '{{.Server.Version}}'], { timeoutMs: PROBE_TIMEOUT_MS });
    if (probe.spawnError !== undefined)
        return unavailable(`the container runtime ${bin} is not installed or not on PATH (${probe.spawnError}); install it, ${switchBack}`);
    if (probe.status !== 0)
        return unavailable(`the container runtime ${bin} does not answer (${firstLine(probe.tail) || `exit ${probe.status}`}); start ${bin === 'docker' ? 'Docker Desktop or the docker daemon' : 'the podman machine or service'}, ${switchBack}`);
    const inspectImage = () => deps.exec(bin, ['image', 'inspect', '--format', '{{.Id}}', s.image], { timeoutMs: PROBE_TIMEOUT_MS });
    let image = await inspectImage();
    if (image.status !== 0) {
        log(`omg factory run: pulling the gate image ${s.image} with ${bin} (factory.run.sandbox.container.image); pin a digest there to fix what runs`);
        const pulled = await deps.exec(bin, ['pull', s.image], { timeoutMs: PULL_TIMEOUT_MS });
        if (pulled.status !== 0)
            return unavailable(`the gate image ${s.image} is not present and ${bin} pull failed (${firstLine(lastLines(pulled.tail)) || `exit ${pulled.status}`}); pull it yourself, set factory.run.sandbox.container.image, ${switchBack}`);
        image = await inspectImage();
    }
    const imageId = /^(sha256:[0-9a-f]{64})$/m.exec(image.tail.trim())?.[1];
    // Every container runs the exact image inspected above, never what the tag names later (review-499b N4).
    const ref = imageId ?? s.image;
    const plan = installPlan(req.cwd);
    if (plan.kind === 'unsupported')
        return unavailable(`${plan.reason}; ${switchBack}`);
    const scan = checkoutCopyProblem(req.cwd);
    if (scan)
        return noVerdict(`${scan}, so it is not copied into the gate container; nothing is counted`);
    const id = (deps.id ?? (() => randomBytes(4).toString('hex')))();
    const name = `${CONTAINER_NAME_PREFIX}${runLabel}-${id}`;
    const volume = name;
    const network = `${name}-net`;
    const cache = plan.kind === 'npm-ci' && plan.sharedCache ? `${CONTAINER_NAME_PREFIX}cache-${plan.lockHash}` : undefined;
    const labels = ['--label', `${RUN_LABEL}=${runLabel}`, '--label', `${GATE_LABEL}=1`];
    const harden = hardeningArgs(s);
    const work = ['--mount', mountArg(['type=volume', `source=${volume}`, `target=${WORK}`])];
    const workRo = ['--mount', mountArg(['type=volume', `source=${volume}`, `target=${WORK}`, 'readonly'])];
    const started = [];
    let volumeMade = false;
    let networkMade = false;
    const ran = (o) => ({ ran: true, ...o, ...(imageId ? { imageId } : {}) });
    const removeNetwork = async () => {
        if (!networkMade)
            return;
        const rm = await deps.exec(bin, ['network', 'rm', network], { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => null);
        if (rm?.status === 0)
            networkMade = false;
    };
    /** One step container: its argv under the in-container limit, killed by name at the engine's timeout. */
    const step = (container, opts, argv, timeoutMs, full) => {
        started.push(container);
        return deps.exec(bin, ['run', '--name', container, ...opts, ref, ...inContainerLimit(timeoutMs, argv)], {
            timeoutMs,
            ...(full !== undefined ? { full } : {}),
            onTimeout: async () => {
                await deps.exec(bin, ['kill', container], { timeoutMs: KILL_TIMEOUT_MS }).catch(() => null);
                await deps.exec(bin, ['rm', '-f', container], { timeoutMs: KILL_TIMEOUT_MS }).catch(() => null);
            },
        });
    };
    /**
     * The disk watchdog around one step: `du` of the work volume from a
     * read-only container; over the limit kills only `container`. Fail-closed
     * (review-499b N1): du's total counts even when du exits 1 (entries that
     * vanished mid-walk), and two checks in a row without a total kill too.
     */
    let duCount = 0;
    const watched = async (container, run) => {
        let stopped = false;
        let over;
        let misses = 0;
        let timer;
        let inflight = Promise.resolve();
        const tick = () => {
            inflight = (async () => {
                if (stopped)
                    return;
                // A fresh name per check: a leftover du container never blocks the next one.
                const duName = `${container}-du-${++duCount}`;
                started.push(duName);
                const du = await deps.exec(bin, [
                    'run', '--name', duName, ...labels, ...harden, '--network', 'none',
                    // root without DAC override: only DAC_READ_SEARCH, so a dir the PR made unreadable is still counted.
                    '--user', '0:0', '--cap-add', 'DAC_READ_SEARCH', '--read-only', ...workRo,
                    ref, ...inContainerLimit(PROBE_TIMEOUT_MS, ['du', '-sxk', WORK]),
                ], { timeoutMs: PROBE_TIMEOUT_MS + 2 * IN_CONTAINER_GRACE_S * 1000 }).catch(() => null);
                // --rm removed a du that ended normally (0, or 1 with a total); any other end is removed by name now.
                if (du !== null && (du.status === 0 || du.status === 1) && !du.timedOut)
                    started.splice(started.indexOf(duName), 1);
                else
                    await deps.exec(bin, ['rm', '-f', duName], { timeoutMs: KILL_TIMEOUT_MS }).catch(() => null);
                const m = du ? /^(\d+)\s+\/work\s*$/m.exec(du.tail) : null;
                const kb = m ? Number(m[1]) : NaN;
                if (stopped)
                    return;
                const measured = Number.isFinite(kb);
                misses = measured ? 0 : misses + 1;
                if ((measured && kb * 1024 > diskLimit) || misses >= 2) {
                    over = measured ? 'over' : 'unmeasured';
                    await deps.exec(bin, ['kill', container], { timeoutMs: KILL_TIMEOUT_MS }).catch(() => null);
                    await deps.exec(bin, ['rm', '-f', container], { timeoutMs: KILL_TIMEOUT_MS }).catch(() => null);
                    return;
                }
                if (!stopped)
                    timer = setTimeout(tick, deps.diskWatchMs ?? DISK_WATCH_MS);
            })();
        };
        timer = setTimeout(tick, deps.diskWatchMs ?? DISK_WATCH_MS);
        try {
            const r = await run();
            return over ? { ...r, overDisk: over } : r;
        }
        finally {
            stopped = true;
            clearTimeout(timer);
            await inflight;
        }
    };
    const overDisk = (what, r) => ran({
        status: 1,
        output: tail(`${r.tail.trim()}\n${what} in the gate container ${r.overDisk === 'unmeasured' ? `was stopped: its disk use could not be measured twice in a row, so factory.run.sandbox.container.diskLimit (${s.diskLimit}) could not be checked` : `used more than factory.run.sandbox.container.diskLimit (${s.diskLimit}) and was stopped`}`),
        timedOut: false,
    });
    try {
        const made = await deps.exec(bin, ['volume', 'create', ...labels, volume], { timeoutMs: PROBE_TIMEOUT_MS });
        if (made.status !== 0)
            return unavailable(`${bin} could not create the gate volume (${firstLine(made.tail) || `exit ${made.status}`}); check the runtime's disk, ${switchBack}`);
        volumeMade = true;
        if (cache) {
            const problem = await ensureCacheVolume(deps.exec, bin, cache);
            if (problem)
                return unavailable(`${problem}; ${switchBack}`);
        }
        const cacheMount = cache ? ['--mount', mountArg(['type=volume', `source=${cache}`, `target=/cache`])] : [];
        // 1. copy: root only for tar's chown; the checkout read-only; no network; no PR code runs.
        const copy = await step(`${name}-copy`, [
            ...labels, ...harden, '--network', 'none',
            '--user', '0:0', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER',
            '--read-only', '--mount', mountArg(['type=bind', `source=${resolve(req.cwd)}`, 'target=/in', 'readonly']), ...work, ...cacheMount,
        ], ['sh', '-c', copyScript(plan.kind === 'npm-ci')], COPY_TIMEOUT_MS);
        if (copy.status !== 0)
            return noVerdict(`copying the checkout into the gate container failed (exit ${copy.status ?? 'none'}${copy.timedOut ? ', timed out' : ''}); nothing is counted`);
        const runBase = [...labels, ...harden, '--user', CONTAINER_USER, '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=1g', ...work, '-w', SRC];
        const ownCache = { npm_config_cache: `${WORK}/home/.npm` };
        if (plan.kind === 'npm-ci') {
            const timeoutMs = s.installTimeoutMinutes * 60_000;
            // 2a. npm itself, with network on our own bridge (no other container on it, inter-container traffic off); no PR code runs.
            const net = await deps.exec(bin, ['network', 'create', ...labels, ...(bin === 'docker' ? ['--driver', 'bridge', '-o', 'com.docker.network.bridge.enable_icc=false'] : ['-o', 'isolate=true']), network], { timeoutMs: PROBE_TIMEOUT_MS });
            if (net.status !== 0)
                return unavailable(`${bin} could not create the gate install network (${firstLine(net.tail) || `exit ${net.status}`}); ${switchBack}`);
            networkMade = true;
            const fetchName = `${name}-install`;
            const inst = await watched(fetchName, () => step(fetchName, [
                ...runBase, '--network', network, ...cacheMount,
                ...containerEnvArgs({ ...(cache ? { npm_config_cache: '/cache/npm' } : ownCache), ...NPM_FETCH_ENV }),
            ], ['npm', 'ci', '--ignore-scripts'], timeoutMs));
            await removeNetwork();
            if (inst.overDisk)
                return overDisk('the dependency install (npm ci)', inst);
            if (inst.timedOut)
                return ran({ status: 124, output: tail(`${inst.tail.trim()}\nthe dependency install (npm ci) in the gate container timed out after ${s.installTimeoutMinutes} min`), timedOut: true });
            if (inst.status === null || inst.status === 125)
                return noVerdict(`the container runtime failed while the dependency install ran (exit ${inst.status ?? 'none'}); nothing is counted`);
            if (inst.status !== 0)
                return ran({ status: inst.status, output: tail(`${inst.tail.trim()}\nthe dependency install (npm ci) in the gate container failed (exit ${inst.status})`), timedOut: false });
            // 2b. the install scripts (the PR's code and its dependencies'): no network, no shared cache; the .npmrc is back first.
            const scriptsName = `${name}-scripts`;
            const scripts = await watched(scriptsName, () => step(scriptsName, [...runBase, '--network', 'none', ...containerEnvArgs(ownCache)], ['sh', '-c', SCRIPTS_SCRIPT], timeoutMs));
            if (scripts.overDisk)
                return overDisk('the install scripts', scripts);
            if (scripts.timedOut)
                return ran({ status: 124, output: tail(`${scripts.tail.trim()}\nthe install scripts in the gate container timed out after ${s.installTimeoutMinutes} min`), timedOut: true });
            if (scripts.status === null || scripts.status === 125)
                return noVerdict(`the container runtime failed while the install scripts ran (exit ${scripts.status ?? 'none'}); nothing is counted`);
            if (scripts.status !== 0)
                return ran({ status: scripts.status, output: tail(`${scripts.tail.trim()}\nthe install scripts (npm rebuild and the root's install scripts, no network) in the gate container failed (exit ${scripts.status})`), timedOut: false });
        }
        // 3. run: no network.
        const argv = containerArgv(req);
        const r = await watched(name, () => step(name, [...runBase, '--network', 'none', ...containerEnvArgs(ownCache)], argv, req.timeoutMs));
        if (r.overDisk)
            return overDisk('the command', r);
        if (r.timedOut)
            return ran({ status: 124, output: tail(`${r.tail.trim()}\ntimed out after ${req.timeoutMs} ms`), timedOut: true });
        if (r.spawnError !== undefined || r.status === null || r.status === 125)
            return noVerdict(`the container runtime failed while the command ran (exit ${r.status ?? 'none'}); nothing is counted`);
        const result = ran({ status: r.status, output: tail(r.tail.trim()), timedOut: false });
        if (req.purpose !== 'prepare' || r.status !== 0)
            return result;
        // 4. copy back what a passing prepare check wrote.
        const back = await step(`${name}-export`, [
            ...labels, ...harden, '--network', 'none', '--user', CONTAINER_USER, '--read-only', ...workRo,
        ], ['tar', '-C', SRC, '--exclude=.git', '--exclude=node_modules', '--format=posix', '-cf', '-', '.'], COPY_TIMEOUT_MS, COPY_BACK_MAX_BYTES);
        if (back.status !== 0 || !back.stdout)
            return noVerdict(`reading the prepare check's changes back from the gate container failed (${back.overflow ? 'over the size bound' : `exit ${back.status ?? 'none'}`}); nothing is counted`);
        const problem = applyCopyBack(req.cwd, back.stdout, deps.platform ?? process.platform);
        if (problem)
            return noVerdict(`the prepare check's changes cannot be copied back safely (${problem}); nothing is counted`);
        return result;
    }
    catch {
        return noVerdict('the gate container failed unexpectedly; nothing is counted');
    }
    finally {
        // Every step container by its own name (normally gone already: --rm), then the network and the volume.
        for (const c of started)
            await deps.exec(bin, ['rm', '-f', c], { timeoutMs: KILL_TIMEOUT_MS }).catch(() => null);
        await removeNetwork();
        if (volumeMade) {
            for (let i = 0; i < 3; i++) {
                const rm = await deps.exec(bin, ['volume', 'rm', '-f', volume], { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => null);
                if (rm?.status === 0)
                    break;
                await new Promise((r) => setTimeout(r, 500));
            }
        }
    }
}
/**
 * The shared npm cache volume: made here, or one that already carries our
 * labels on the local driver with no options (never a volume someone else
 * made under that name, never one that binds a host dir). A problem, or null.
 */
async function ensureCacheVolume(exec, bin, cache) {
    const inspect = await exec(bin, ['volume', 'inspect', '--format', '{{.Driver}}|{{json .Labels}}|{{json .Options}}', cache], { timeoutMs: PROBE_TIMEOUT_MS });
    if (inspect.status === 0) {
        const [driver, labelsJson, optionsJson] = inspect.tail.trim().split('\n')[0].split('|');
        let labels;
        let options;
        try {
            labels = JSON.parse(labelsJson ?? '');
            options = JSON.parse(optionsJson ?? '');
        }
        catch {
            return `the npm cache volume ${cache} cannot be inspected; remove it (${bin} volume rm ${cache})`;
        }
        const l = (labels ?? {});
        const noOptions = options === null || (typeof options === 'object' && Object.keys(options).length === 0);
        if (driver !== 'local' || l[CACHE_LABEL] !== 'npm' || l[GATE_LABEL] !== '1' || !noOptions)
            return `a volume named ${cache} exists that the factory did not make (driver, labels or options differ); remove or rename it`;
        return null;
    }
    const c = await exec(bin, ['volume', 'create', '--label', `${GATE_LABEL}=1`, '--label', `${CACHE_LABEL}=npm`, cache], { timeoutMs: PROBE_TIMEOUT_MS });
    return c.status === 0 ? null : `${bin} could not create the npm cache volume (${firstLine(c.tail) || `exit ${c.status}`})`;
}
const tail = (text) => {
    const clean = redactGateOutput(text);
    return clean.length > SANDBOX_OUTPUT_TAIL_CHARS ? clean.slice(-SANDBOX_OUTPUT_TAIL_CHARS) : clean;
};
const firstLine = (text) => text.trim().split('\n')[0]?.trim().slice(0, 300) ?? '';
const lastLines = (text) => text.trim().split('\n').slice(-1).join('\n');
/** A minimal POSIX/ustar tar reader (pax `x` path/linkpath/size records, GNU long names). Throws on a malformed stream. */
export function readTar(buf, maxEntries = COPY_BACK_MAX_ENTRIES) {
    const entries = [];
    let off = 0;
    let pax = {};
    let longName;
    let longLink;
    const str = (b) => { const z = b.indexOf(0); return (z === -1 ? b : b.subarray(0, z)).toString('utf8'); };
    const octal = (b) => {
        if (b[0] & 0x80)
            throw new Error('base-256 size');
        const t = str(b).trim();
        if (t === '')
            return 0;
        if (!/^[0-7]+$/.test(t))
            throw new Error('bad octal field');
        return parseInt(t, 8);
    };
    while (off + 512 <= buf.length) {
        const h = buf.subarray(off, off + 512);
        if (h.every((x) => x === 0))
            return entries;
        const sum = octal(h.subarray(148, 156));
        let calc = 0;
        for (let i = 0; i < 512; i++)
            calc += i >= 148 && i < 156 ? 32 : h[i];
        if (calc !== sum)
            throw new Error('bad header checksum');
        const flag = String.fromCharCode(h[156] || 48);
        let size = octal(h.subarray(124, 136));
        if (pax.size !== undefined)
            size = Number(pax.size);
        if (!Number.isSafeInteger(size) || size < 0)
            throw new Error('bad size');
        const start = off + 512;
        const end = start + size;
        if (end > buf.length)
            throw new Error('truncated');
        const data = buf.subarray(start, end);
        off = start + Math.ceil(size / 512) * 512;
        if (flag === 'x') {
            pax = { ...pax, ...parsePax(data) };
            continue;
        }
        if (flag === 'g')
            continue;
        if (flag === 'L') {
            longName = str(data);
            continue;
        }
        if (flag === 'K') {
            longLink = str(data);
            continue;
        }
        const prefix = str(h.subarray(345, 500));
        const path = pax.path ?? longName ?? (prefix ? `${prefix}/${str(h.subarray(0, 100))}` : str(h.subarray(0, 100)));
        const linkTarget = pax.linkpath ?? longLink ?? str(h.subarray(157, 257));
        const type = flag === '0' || flag === '7' ? 'file' : flag === '5' ? 'dir' : flag === '2' ? 'symlink' : flag === '1' ? 'hardlink' : 'other';
        entries.push({ path, type, mode: octal(h.subarray(100, 108)), ...(type === 'file' ? { data: Buffer.from(data) } : {}), ...(type === 'symlink' || type === 'hardlink' ? { linkTarget } : {}) });
        if (entries.length > maxEntries)
            throw new Error('too many entries');
        pax = {};
        longName = undefined;
        longLink = undefined;
    }
    throw new Error('no end-of-archive marker');
}
function parsePax(data) {
    const out = {};
    let i = 0;
    while (i < data.length) {
        const space = data.indexOf(0x20, i);
        if (space === -1)
            throw new Error('bad pax record');
        const len = Number(data.subarray(i, space).toString('ascii'));
        if (!Number.isSafeInteger(len) || len <= space - i || i + len > data.length)
            throw new Error('bad pax record');
        const rec = data.subarray(space + 1, i + len - 1).toString('utf8');
        const eq = rec.indexOf('=');
        if (eq > 0)
            out[rec.slice(0, eq)] = rec.slice(eq + 1);
        i += len;
    }
    return out;
}
/** Code points macOS (HFS+) ignores in names: dropped before names are compared there. */
const IGNORABLE = [[0xad, 0xad], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0xfeff, 0xfeff]];
const dropIgnorable = (s) => [...s].filter((ch) => { const c = ch.codePointAt(0); return !IGNORABLE.some(([a, b]) => c >= a && c <= b); }).join('');
/** Whether this host's file system may treat names that differ in case (or Unicode form) as one: win32 and darwin. */
const foldsCase = (platform) => platform === 'win32' || platform === 'darwin';
/** A path as this host compares it: lowercased and NFC-normalised where names fold (win32, darwin). */
export function foldPath(p, platform) {
    return foldsCase(platform) ? dropIgnorable(p.normalize('NFC')).toLowerCase() : p;
}
/** One name component is `name` (`.git`, `node_modules`) as this host would resolve it. */
function isName(component, name, platform) {
    if (!foldsCase(platform))
        return component === name;
    const c = dropIgnorable(component.normalize('NFC'));
    return c.toLowerCase() === name || c.toUpperCase() === name.toUpperCase() || c.normalize('NFKC').toLowerCase() === name;
}
/** A relative POSIX path from the tar, normalised (`./` dropped), or null when it may not be written on this host. */
export function safeRelPath(raw, platform) {
    const p = raw.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
    if (p === '' || p === '.')
        return '';
    if (p.startsWith('/') || p.includes('\0') || p.includes('\\'))
        return null;
    const parts = p.split('/');
    if (parts.some((s) => s === '' || s === '.' || s === '..'))
        return null;
    if (parts.some((s) => isName(s, '.git', platform) || isName(s, 'node_modules', platform)))
        return null;
    // win32: reserved characters and device names, a trailing dot or space, and any 8.3 short-name shape (`NODE_M~1`).
    if (platform === 'win32' && parts.some((s) => /[<>:"|?*\x00-\x1f]/.test(s) || /[. ]$/.test(s) || /~\d/.test(s) || /^(?:con|prn|aux|nul|com[\d¹²³]|lpt[\d¹²³]|conin\$|conout\$)(?:\..*)?$/i.test(s)))
        return null;
    return p;
}
/**
 * The host checkout's entries outside `.git` and `node_modules` (any case
 * where names fold), keyed by folded relative POSIX path (lstat: links are
 * not followed). A regular file with more than one hard link is 'other'.
 */
function hostTree(root, platform) {
    const out = new Map();
    const walk = (dir, rel) => {
        for (const name of readdirSync(dir)) {
            if (isName(name, '.git', platform) || isName(name, 'node_modules', platform))
                continue;
            const r = rel ? `${rel}/${name}` : name;
            const st = lstatSync(join(dir, name));
            const kind = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() && st.nlink === 1 ? 'file' : 'other';
            out.set(foldPath(r, platform), { rel: r, kind });
            if (kind === 'dir')
                walk(join(dir, name), r);
        }
    };
    walk(root, '');
    return out;
}
/**
 * Every existing component of `rel` under the checkout, read from the file
 * system itself (whatever case or short name resolves it): each parent a
 * real directory (never a link or junction), the leaf absent or a regular
 * file with one link, and the deepest existing parent's real path inside the
 * checkout's. A problem, or null.
 */
function onDiskProblem(checkout, realRoot, rel, leaf) {
    const parts = rel.split('/');
    let deepest = checkout;
    for (let i = 0; i < parts.length; i++) {
        const path = join(checkout, ...parts.slice(0, i + 1));
        let st;
        try {
            st = lstatSync(path);
        }
        catch (error) {
            // Only a missing component ends the walk (the rest is made); any other error is unchecked, never fine (review-499b N6).
            if (error.code === 'ENOENT')
                break;
            return 'a path could not be checked';
        }
        if (st.isSymbolicLink())
            return 'a file would be written through a host link';
        if (i < parts.length - 1 || leaf === 'dir') {
            if (!st.isDirectory())
                return 'a file would be written under a non-directory';
            deepest = path;
        }
        else if (!st.isFile() || st.nlink !== 1)
            return 'a file replaces a host directory, link or hard-linked file';
    }
    let real;
    try {
        real = realpathSync.native(deepest);
    }
    catch {
        return 'a parent directory could not be resolved';
    }
    return samePathOrUnder(real, realRoot) ? null : 'a file would be written outside the checkout';
}
/**
 * Write the container's tree back into the checkout: regular files that
 * differ are written, host files the container removed are removed. Checked
 * whole before anything is written; returns a fixed-text problem (never a
 * path: the names are the PR's) and writes nothing when a check fails.
 * Names are compared as this host resolves them (case and Unicode form on
 * win32/darwin; 8.3 short names refused), and every write is checked on the
 * disk itself: no parent may be a link or junction, and the real path stays
 * in the checkout. Each file is replaced atomically (a temp file in its dir,
 * then a rename, so a hard link to it is never written through); a write
 * that fails part-way leaves the files before it written and returns a
 * problem (the engine gives no verdict).
 */
export function applyCopyBack(checkout, tar, platform) {
    let entries;
    try {
        entries = readTar(tar);
    }
    catch {
        return 'the tar stream is malformed or too large';
    }
    let host;
    let realRoot;
    try {
        host = hostTree(checkout, platform);
        realRoot = realpathSync.native(checkout);
    }
    catch {
        return 'the checkout could not be listed';
    }
    const want = new Map();
    for (const e of entries) {
        const rel = safeRelPath(e.path, platform);
        if (rel === null)
            return 'an entry has a path that cannot be written here';
        if (rel === '')
            continue;
        const key = foldPath(rel, platform);
        if (want.has(key))
            return 'two entries name the same file on this host';
        want.set(key, { rel, e });
    }
    const writes = [];
    for (const [key, { rel, e }] of want) {
        const kind = host.get(key)?.kind;
        if (e.type === 'dir') {
            if (kind !== undefined && kind !== 'dir')
                return 'a directory replaces a host file or link';
            continue;
        }
        if (e.type === 'symlink') {
            // An unchanged link (copied in, copied back) is fine; a new or changed one is never made on the host.
            if (kind !== 'symlink')
                return 'the check created a symbolic link';
            continue;
        }
        if (e.type !== 'file')
            return 'the check created a hardlink, device or other special file';
        if (kind !== undefined && kind !== 'file')
            return 'a file replaces a host directory, link or hard-linked file';
        const parts = rel.split('/');
        for (let i = 1; i < parts.length; i++) {
            const pkey = foldPath(parts.slice(0, i).join('/'), platform);
            const parent = host.get(pkey)?.kind;
            if (parent !== undefined && parent !== 'dir')
                return 'a file would be written through a host link';
            const w = want.get(pkey);
            if (parent === undefined && w && w.e.type !== 'dir')
                return 'a file would be written under a non-directory';
        }
        const disk = onDiskProblem(checkout, realRoot, rel, 'file');
        if (disk)
            return disk;
        if (kind === 'file') {
            const cur = readFileSync(join(checkout, ...parts));
            if (cur.equals(e.data))
                continue;
        }
        writes.push({ rel, data: e.data, mode: e.mode });
    }
    const removals = [...host].filter(([key, h]) => (h.kind === 'file' || h.kind === 'symlink') && !want.has(key)).map(([, h]) => h.rel);
    for (const rel of removals) {
        const parent = rel.split('/').slice(0, -1).join('/');
        if (parent && onDiskProblem(checkout, realRoot, parent, 'dir'))
            return 'a file to remove lies under a host link';
    }
    for (const { rel, data, mode } of writes) {
        const path = join(checkout, ...rel.split('/'));
        const dir = dirname(path);
        let tmp;
        try {
            mkdirSync(dir, { recursive: true });
            // Re-checked after the directories exist: the real dir is still inside the checkout.
            if (!samePathOrUnder(realpathSync.native(dir), realRoot))
                return 'a file would be written outside the checkout; files before it were written';
            tmp = join(dir, `.omg-copy-back-${randomBytes(6).toString('hex')}`);
            writeFileSync(tmp, data, { flag: 'wx' });
            if (platform !== 'win32')
                chmodSync(tmp, mode & 0o111 ? 0o755 : 0o644);
            renameSync(tmp, path);
            tmp = undefined;
        }
        catch {
            if (tmp)
                try {
                    unlinkSync(tmp);
                }
                catch { /* gone */ }
            return 'writing a file back failed part-way; files before it were written';
        }
    }
    // unlink removes a link itself, never its target.
    try {
        for (const rel of removals)
            unlinkSync(join(checkout, ...rel.split('/')));
    }
    catch {
        return 'removing a file the check deleted failed part-way';
    }
    return null;
}
/** The runtime's version for `omg factory check` (null when it does not answer). */
export function probeContainerRuntime(s, execSync = defaultContainerExecSync) {
    const v = execSync(s.runtime, ['version', '--format', '{{.Server.Version}}']);
    const version = v.status === 0 ? v.stdout.trim().split('\n')[0] || 'unknown' : null;
    const image = version !== null && execSync(s.runtime, ['image', 'inspect', '--format', '{{.Id}}', s.image]).status === 0;
    return { version, image };
}
/**
 * `omg factory run clean`: this run's leftover containers (a killed engine),
 * networks and volumes, found by its label AND the name prefix; nothing
 * else. A runtime that does not answer removes nothing (and says so).
 */
export function cleanRunContainers(runtime, runLabel, execSync = defaultContainerExecSync) {
    const filter = ['--filter', `label=${RUN_LABEL}=${runLabel}`];
    const ours = (out) => out.split(/\r?\n/).map((l) => l.trim()).filter((n) => n.startsWith(`${CONTAINER_NAME_PREFIX}${runLabel}-`) && /^[a-z0-9-]+$/.test(n));
    const ps = execSync(runtime, ['ps', '-a', '--format', '{{.Names}}', ...filter]);
    if (ps.status !== 0)
        return { removed: [], problem: `${runtime} did not answer; this run's gate containers, networks and volumes (label ${RUN_LABEL}=${runLabel}) were not checked` };
    const removed = [];
    for (const n of ours(ps.stdout))
        if (execSync(runtime, ['rm', '-f', n]).status === 0)
            removed.push(n);
    const nets = execSync(runtime, ['network', 'ls', '--format', '{{.Name}}', ...filter]);
    for (const n of nets.status === 0 ? ours(nets.stdout) : [])
        if (execSync(runtime, ['network', 'rm', n]).status === 0)
            removed.push(n);
    const vols = execSync(runtime, ['volume', 'ls', '--format', '{{.Name}}', ...filter]);
    for (const n of vols.status === 0 ? ours(vols.stdout) : [])
        if (execSync(runtime, ['volume', 'rm', '-f', n]).status === 0)
            removed.push(n);
    return { removed };
}
//# sourceMappingURL=container-gate.js.map