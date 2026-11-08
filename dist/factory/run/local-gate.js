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
import { spawn } from 'child_process';
import { existsSync, lstatSync, realpathSync, rmSync } from 'fs';
import { posix, resolve, win32 } from 'path';
import { LOCAL_GATE_CHECK, localCheckRecordPath, readLocalCheckRecord, writeLocalCheckRecord } from '../../forge/local/index.js';
import { getProcessStartIdentity, terminateOwnedProcessTree } from '../../platform/process-utils.js';
import { scrubShipEnv } from '../../ship/exec.js';
import { childEnv, findOnPath, hardenWindowsExeSearch, resolveBareExe } from '../../utils/windows-search.js';
import { FactorySafetyError, sameFsPath } from './exec.js';
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
/** Package-manager CLIs that are `.cmd` shims on Windows, and the node script each one runs. */
const NODE_SCRIPTS = {
    npm: { script: ['node_modules', 'npm', 'bin', 'npm-cli.js'], exeFirst: false },
    npx: { script: ['node_modules', 'npm', 'bin', 'npx-cli.js'], exeFirst: false },
    pnpm: { script: ['node_modules', 'corepack', 'dist', 'pnpm.js'], exeFirst: true },
    yarn: { script: ['node_modules', 'corepack', 'dist', 'yarn.js'], exeFirst: true },
};
/** The gate argv a hint suggests: `["npm","test"]` when npm's own script is beside node (it runs without a shell), else node with that script. */
const npmCliHint = (P, execPath, exists) => {
    const script = P.join(P.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return exists(script) ? JSON.stringify(['npm', 'test']) : JSON.stringify(['node', script, 'test']);
};
/**
 * The executable and arguments the gate argv runs as, or why it cannot start.
 * Never a `.cmd`/`.bat` on Windows and never a name found in the checkout.
 */
export function resolveLocalGateArgv(argv, o) {
    const platform = o.platform ?? process.platform;
    const env = o.env ?? process.env;
    const execPath = o.execPath ?? process.execPath;
    const exists = o.exists ?? existsSync;
    const what = o.subject ?? 'the local gate';
    const key = o.configKey ?? 'factory.forge.local.gate';
    const P = platform === 'win32' ? win32 : posix;
    const [cmd, ...args] = argv;
    if (!cmd)
        return { missing: `${what} argv is empty` };
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
        if (fromExe)
            return { exe: fromExe, args };
        const script = P.join(P.dirname(execPath), ...known.script);
        if (exists(script))
            return { exe: execPath, args: [script, ...args] };
        return { missing: `${what} executable ${cmd} cannot start: on Windows ${what} runs without a shell, so ${name}.cmd is never run, and ${script} does not exist; set ${key} to a command that starts without a shell, such as ${npmCliHint(P, execPath, exists)}` };
    }
    if (/\.(cmd|bat)$/i.test(cmd)) {
        return { missing: `${what} executable ${cmd} is a cmd.exe script, which ${what} never runs (no shell); set ${key} to node, an .exe or npm (none needs a shell), such as ${npmCliHint(P, execPath, exists)}` };
    }
    const found = exe();
    return found ? { exe: found, args } : { missing: `${what} executable ${cmd} is not on PATH as an .exe or .com (on Windows ${what} runs without a shell, so .cmd/.bat shims are skipped); set ${key} to a command that starts without a shell, such as ${npmCliHint(P, execPath, exists)}` };
}
const keepTail = (text) => (text.length > STREAM_KEEP_CHARS ? text.slice(-STREAM_KEEP_CHARS) : text);
/**
 * Kill the gate's whole process tree: the identity-checked tree kill while
 * the root lives. After the root exited only POSIX can still reach its
 * descendants (the detached process group); on Windows an orphan that
 * outlived the root is not killed, only no longer waited for.
 */
async function killGateTree(child, rootExited) {
    const pid = child.pid;
    if (!pid)
        return;
    if (!rootExited) {
        // Our own unreaped child: its pid cannot be reused yet, so its identity is the one we started.
        const identity = await getProcessStartIdentity(pid, Date.now() + KILL_DEADLINE_MS);
        if (identity) {
            const done = await terminateOwnedProcessTree({ pid, expectedStartIdentity: identity, deadlineAt: new Date(Date.now() + KILL_DEADLINE_MS).toISOString(), force: true });
            if (done === 'terminated' || done === 'already-dead')
                return;
        }
        try {
            child.kill('SIGKILL');
        }
        catch { /* already gone */ }
    }
    // The root exited but a descendant still holds the output pipes: its process group (POSIX only, detached; Windows has no group to signal).
    if (process.platform !== 'win32') {
        try {
            process.kill(-pid, 'SIGKILL');
        }
        catch { /* the group is gone */ }
    }
}
/** Spawn without a shell; at `timeoutMs` kill the whole tree (test workers too) and stop waiting for its output. */
function runOwned(exe, args, cwd, env, timeoutMs) {
    return new Promise((done) => {
        let child;
        try {
            // detached on POSIX: the gate leads its own process group, so the timeout reaches its grandchildren.
            child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
        }
        catch (error) {
            done({ status: 127, stdout: '', stderr: '', timedOut: false, startError: `${exe}: ${error.message}` });
            return;
        }
        let stdout = '';
        let stderr = '';
        let exitStatus = null;
        let timedOut = false;
        let settled = false;
        let drain;
        const finish = (r) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(drain);
            done(r);
        };
        child.stdout.setEncoding('utf8').on('data', (d) => { stdout = keepTail(stdout + d); });
        child.stderr.setEncoding('utf8').on('data', (d) => { stderr = keepTail(stderr + d); });
        child.on('error', (error) => {
            // No pid: it never started (ENOENT, EACCES, EINVAL for a .cmd). With a pid it is a kill/IO error, reported by close.
            if (!child.pid)
                finish({ status: 127, stdout, stderr, timedOut: false, startError: `${exe}: ${error.message}` });
        });
        child.on('exit', (code, signal) => {
            exitStatus = code ?? (signal ? 128 : 1);
            // The root's exit status is the verdict: a descendant still holding the pipes gets a short drain, then is
            // killed best-effort (its process group, POSIX only; a Windows orphan survives) and no longer delays the verdict or turns it into a timeout.
            drain = setTimeout(() => {
                if (settled || timedOut)
                    return;
                void killGateTree(child, true);
                child.stdout?.destroy();
                child.stderr?.destroy();
                finish({ status: exitStatus, stdout, stderr, timedOut: false });
            }, EXIT_DRAIN_MS);
        });
        child.on('close', (code, signal) => {
            finish({ status: timedOut ? 124 : (exitStatus ?? code ?? (signal ? 128 : 1)), stdout, stderr, timedOut });
        });
        const timer = setTimeout(() => {
            // Firing inside the post-exit drain: the root already exited, so its exit status stays the verdict.
            const exited = exitStatus !== null;
            if (!exited)
                timedOut = true;
            void killGateTree(child, exited).finally(() => {
                // Whatever still holds the pipes (an orphan on Windows) no longer delays the verdict.
                child.stdout?.destroy();
                child.stderr?.destroy();
                finish(exited ? { status: exitStatus, stdout, stderr, timedOut: false } : { status: 124, stdout, stderr, timedOut: true });
            });
        }, timeoutMs);
    });
}
export const defaultLocalGateRunner = async (argv, cwd, timeoutMs) => {
    // A bare name is never resolved from the checkout (a planted npm.cmd / node.exe there).
    hardenWindowsExeSearch();
    const target = resolveLocalGateArgv(argv, { cwd });
    if ('missing' in target)
        return { status: 127, stdout: '', stderr: '', timedOut: false, startError: target.missing };
    // resolveLocalGateArgv already gave an absolute path on Windows; resolveBareExe keeps a path unchanged.
    const exe = resolveBareExe(target.exe) ?? target.exe;
    return runOwned(exe, target.args, cwd, childEnv(scrubShipEnv(process.env)), timeoutMs);
};
const realOrResolved = (p) => {
    try {
        return realpathSync.native(p);
    }
    catch {
        return resolve(p);
    }
};
const isLink = (p) => {
    try {
        return lstatSync(p).isSymbolicLink();
    }
    catch {
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
export function assertLocalGateCommand(recorded, configured, checkout, expectedCheckout) {
    if (!configured || configured.length === 0)
        throw new FactorySafetyError('omg factory run refuses the local gate: factory.forge.local.gate is not set in a trusted config layer');
    if (recorded.length !== configured.length || recorded.some((a, i) => a !== configured[i])) {
        throw new FactorySafetyError(`omg factory run refuses the local gate \`${configured.join(' ')}\`: this run recorded \`${recorded.join(' ')}\`; restore factory.forge.local.gate, or cancel the run (omg factory run cancel) and start a new one`);
    }
    const real = realOrResolved(checkout);
    for (const p of [checkout, expectedCheckout]) {
        if (isLink(p))
            throw new FactorySafetyError(`omg factory run refuses the local gate in ${checkout} (really ${real}): ${p} is a junction or symlink, never the engine's prepare checkout`);
    }
    if (!sameFsPath(real, realOrResolved(expectedCheckout)))
        throw new FactorySafetyError(`omg factory run refuses the local gate in ${checkout} (really ${real}): it runs only in the engine's prepare checkout ${expectedCheckout}`);
}
/** The record of `head`, or undefined when the gate has not run for it (or a rerun removed it). */
export function localGateRecord(stateDir, root, head) {
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
export function localGateDue(stateDir, root, head, timeoutMinutes, now) {
    const r = localGateRecord(stateDir, root, head);
    if (!r)
        return true;
    if (r.state !== 'PENDING')
        return false;
    const started = Date.parse(r.startedAt);
    return !Number.isFinite(started) || now.getTime() - started > timeoutMinutes * 60_000 + LOCAL_GATE_STALE_GRACE_MS;
}
/** A run id unique enough per head: positive, from the clock (ForgeRun.databaseId). */
const runIdAt = (d) => Math.max(1, Math.floor(d.getTime() / 1000));
const tailOf = (text) => (text.length > LOCAL_GATE_TAIL_CHARS ? text.slice(-LOCAL_GATE_TAIL_CHARS) : text);
/**
 * Run the gate for `head` and record SUCCESS or FAILURE (a PENDING record is
 * written first, so a crash mid-gate leaves the head visibly unfinished and
 * the next run sees a pending check, not a pass, until it goes stale). A
 * gate that cannot start records nothing.
 */
export async function runLocalGate(i) {
    if (i.gate.length === 0)
        throw new FactorySafetyError('omg factory run refuses an empty local gate');
    const now = i.now ?? (() => new Date());
    const started = now();
    const base = { name: LOCAL_GATE_CHECK, head: i.head, state: 'PENDING', argv: [...i.gate], runId: runIdAt(started), startedAt: started.toISOString() };
    writeLocalCheckRecord(i.stateDir, i.root, base);
    let r;
    try {
        r = await (i.runner ?? defaultLocalGateRunner)(i.gate, i.checkout, i.timeoutMinutes * 60_000);
    }
    catch (error) {
        rmSync(localCheckRecordPath(i.stateDir, i.root, i.head), { force: true });
        throw error;
    }
    if (r.startError !== undefined) {
        rmSync(localCheckRecordPath(i.stateDir, i.root, i.head), { force: true });
        return { started: false, reason: r.startError };
    }
    const output = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}${r.timedOut ? `\nlocal gate timed out after ${i.timeoutMinutes} min` : ''}`;
    const done = {
        ...base,
        state: r.status === 0 && !r.timedOut ? 'SUCCESS' : 'FAILURE',
        completedAt: now().toISOString(),
        exitCode: r.timedOut ? 124 : r.status,
        tail: tailOf(output.trim()),
    };
    writeLocalCheckRecord(i.stateDir, i.root, done);
    return { started: true, record: done };
}
const NPM_TEST = new Set(['test', 't', 'tst']);
const NPM_RUN = new Set(['run', 'run-script', 'rum', 'urn']);
/** Package-manager project config that can redirect how a script runs. */
const PM_CONFIG_FILES = ['.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs'];
/** Options that move the package directory (npm --prefix/-C, pnpm --dir/-C, yarn --cwd). */
const DIR_FLAGS = new Set(['--prefix', '-C', '--dir', '--cwd']);
/** Options that name a config file the package manager reads. */
const CONFIG_FLAGS = new Set(['--userconfig', '--globalconfig']);
/** Options that select workspace packages: the script's package.json is not known from the argv. */
const WORKSPACE_FLAGS = new Set(['--workspace', '-w', '--workspaces', '--ws', '--filter', '-F', '--recursive', '-r', '--include-workspace-root']);
/** Options that take the next argument as their value. */
const VALUE_FLAGS = new Set([...DIR_FLAGS, ...CONFIG_FLAGS, '--workspace', '-w', '--filter', '-F', '--registry', '--cache', '--loglevel', '--script-shell', '--node-options', '--tag', '--otp', '--reporter']);
/** A repository-relative POSIX path, or undefined for an absolute path or one leaving the repository. */
function repoPath(p) {
    if (posix.isAbsolute(p) || win32.isAbsolute(p) || /^[a-z]:/i.test(p))
        return undefined;
    const norm = posix.normalize(p.replace(/\\/g, '/'));
    return norm === '.' || norm.startsWith('../') || norm === '..' ? undefined : norm;
}
function scriptSource(manager, args, shown) {
    const words = [];
    let dir = '';
    const configs = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--')
            break;
        if (!a.startsWith('-') || a === '-') {
            words.push(a);
            continue;
        }
        // pnpm and yarn pass options after the script name to the script; npm reads them anywhere before `--`.
        if (manager !== 'npm' && words.length > 0)
            break;
        const eq = a.indexOf('=');
        const flag = eq > 0 ? a.slice(0, eq) : a;
        let value;
        if (eq > 0)
            value = a.slice(eq + 1);
        else if (VALUE_FLAGS.has(flag))
            value = args[++i];
        if (WORKSPACE_FLAGS.has(flag))
            return { sources: [], unresolved: `${shown} selects workspace packages (${flag}), so the script's package.json is not known` };
        if (DIR_FLAGS.has(flag)) {
            const p = value === undefined ? undefined : /^\.\/?$/.test(posix.normalize(value.replace(/\\/g, '/'))) ? '' : repoPath(value)?.replace(/\/+$/, '');
            if (p === undefined)
                return { sources: [], unresolved: `${shown} runs in ${JSON.stringify(value ?? '')}, which is not a directory inside the repository` };
            dir = p;
        }
        else if (CONFIG_FLAGS.has(flag) && value !== undefined) {
            const p = repoPath(value);
            if (p)
                configs.push(p);
        }
    }
    const [sub, next] = words;
    let script;
    if (!sub)
        script = undefined;
    else if (NPM_TEST.has(sub))
        script = 'test';
    else if (sub === 'start')
        script = 'start';
    else if (NPM_RUN.has(sub))
        script = next;
    else if (manager !== 'npm')
        script = sub;
    if (!script)
        return { sources: [], unresolved: `${shown} names no package.json script (such as npm test or npm run <script>)` };
    const at = (f) => (dir ? `${dir}/${f}` : f);
    const files = [...new Set([...PM_CONFIG_FILES, ...PM_CONFIG_FILES.map(at), ...configs])];
    return { sources: [{ path: at('package.json'), scripts: [`pre${script}`, script, `post${script}`] }, ...files.map((path) => ({ path }))] };
}
export function gateDefinitionSources(gate) {
    const [cmd, ...args] = gate;
    if (!cmd)
        return { sources: [] };
    const shown = `the gate "${gate.join(' ')}"`;
    const name = (cmd.split(/[\\/]/).pop() ?? cmd).toLowerCase().replace(/\.(cmd|bat|exe)$/, '');
    if (name === 'npm' || name === 'pnpm' || name === 'yarn')
        return scriptSource(name, args, shown);
    if (name === 'node') {
        const at = args.findIndex((a) => !a.startsWith('-'));
        if (at < 0)
            return { sources: [] };
        const target = args[at];
        const base = (target.split(/[\\/]/).pop() ?? '').toLowerCase();
        if (base === 'npm-cli.js')
            return scriptSource('npm', args.slice(at + 1), shown);
        const p = repoPath(target);
        return { sources: p ? [{ path: p }] : [] };
    }
    const own = /[\\/]/.test(cmd) ? repoPath(cmd) : undefined;
    return { sources: own ? [{ path: own }] : [] };
}
/**
 * The gate's definition at one commit, comparable across commits: per source
 * the named package.json scripts (a file that is not JSON compares by its
 * text), or the file's text. `read` returns a path's content at that commit,
 * undefined when the file is absent there.
 */
export function gateDefinition(sources, read) {
    return JSON.stringify(sources.map((s) => {
        const text = read(s.path);
        if (!s.scripts || text === undefined)
            return [s.path, text ?? null];
        let scripts;
        try {
            const parsed = JSON.parse(text);
            scripts = parsed && typeof parsed.scripts === 'object' && parsed.scripts !== null ? parsed.scripts : {};
        }
        catch {
            return [s.path, text];
        }
        return [s.path, s.scripts.map((k) => [k, Object.prototype.hasOwnProperty.call(scripts, k) ? scripts[k] : null])];
    }));
}
/** What a gate change touches, for the park message: `package.json scripts lint` or the file path. */
export const describeGateSources = (sources) => sources.map((s) => (s.scripts ? `${s.path} scripts ${s.scripts.join('/')}` : s.path)).join(', ');
//# sourceMappingURL=local-gate.js.map