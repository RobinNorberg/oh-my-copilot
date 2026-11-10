/**
 * The PR's own code in prepare's checks and the local gate, run inside the
 * Copilot runtime's OS sandbox (audit C1; design i23 2/8).
 *
 * runSandboxed starts one turnless Copilot runtime per command (no prompt is
 * sent, so no model turn runs), applies the write-profile sandbox policy with
 * hostCommits (read-write: the checkout and the job's own temp and profile
 * dirs only; the git dir and a node_modules link target read-only; network
 * per factory.run.sandbox.writeNetwork, default none), on the allowlisted
 * runtime env (no GH_TOKEN, PAT or other credential), and runs the command
 * through `session.rpc.shell.executeUserRequested`. It is the smoke spawn
 * canary (src/smoke/copilot-sdk-driver.ts sandboxSpawnCanary) generalised.
 *
 * A verdict counts only when the call answered (success, output), the
 * command's own exit code came back (a per-call marker line the shell prints
 * after the command), and the call was attested `sandboxed: true` by its
 * `tool.execution_complete` event, with no other call attested otherwise.
 * Anything else is `ran: false` ("not started"): the engine parks, it never
 * counts as a pass and never as a failure that would start a ci-fix lane.
 * A timeout cancels the call (cancelUserRequested), then the session is
 * disconnected, the runtime's process tree killed and the client stopped.
 *
 * gateEnv is the environment of a command the engine runs WITHOUT the
 * sandbox (gates "ack" or "unsandboxed"): ship's scrubbed env minus every
 * credential variable, with an empty home. It is a speed bump, not a
 * boundary: unsandboxed code still runs with the user's rights.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { defaultCopilotRunDeps } from '../../copilot-run/job.js';
import { allowlistSessionEnv, loadSandboxSettings, laneToolPaths, missingSandboxEnv, proxyCaEnv, sessionGitHubToken, } from '../../copilot-run/sandbox.js';
import { SessionSandboxController } from '../../copilot-run/sandbox-session.js';
import { errText, withTimeout } from '../../copilot-run/timeout.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { scrubShipEnv } from '../../ship/exec.js';
import { resolveShimTarget, runtimePid } from '../../smoke/copilot-sdk-driver.js';
import { RUNTIME_MIN_MAX_CREDITS } from '../../smoke/copilot-sdk-scenarios.js';
import { buildSessionEnv, loginIdentity } from '../../smoke/copilot-session-env.js';
import { childEnv } from '../../utils/windows-search.js';
/** The output tail a sandboxed command keeps (as the local gate record, local-gate.ts LOCAL_GATE_TAIL_CHARS). */
export const SANDBOX_OUTPUT_TAIL_CHARS = 8_000;
const START_TIMEOUT_MS = 60_000;
const RPC_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 15_000;
/** How long a cancelled call may take to answer before the runtime is torn down anyway. */
const CANCEL_GRACE_MS = 5_000;
/** How long the completion event (the attestation) may trail the call's answer. */
const ATTEST_WAIT_MS = 2_000;
const MARKER_PREFIX = 'omg-gate-exit-';
/** `'...'` for PowerShell: a literal string, single quotes doubled. */
const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;
/** `'...'` for a POSIX shell: a literal string, single quotes closed and escaped. */
const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
/**
 * The shell command executeUserRequested runs (the runtime's shell:
 * PowerShell on Windows, bash elsewhere): change into `cwd` (a failure runs
 * nothing and prints no marker), run the argv with every word quoted as a
 * literal, then print `<marker> <exit code>` on its own line. On Windows the
 * argv may not hold an empty word or a double quote (Windows PowerShell drops
 * the first and mangles the second when it builds the native command line):
 * null then.
 */
export function sandboxShellCommand(platform, argv, cwd, marker) {
    if (argv.length === 0)
        return null;
    if (platform === 'win32') {
        if (argv.some((a) => a === '' || a.includes('"')))
            return null;
        const [exe, ...args] = argv;
        return `Set-Location -LiteralPath ${psQuote(cwd)} -ErrorAction Stop; $global:LASTEXITCODE = $null; & ${[psQuote(exe), ...args.map(psQuote)].join(' ')}; "${marker} $LASTEXITCODE"`;
    }
    return `if cd -- ${shQuote(cwd)}; then ${argv.map(shQuote).join(' ')}; printf '%s %s\\n' ${shQuote(marker)} "$?"; fi`;
}
/**
 * The exit code the marker line reports (the last `<marker> <n>` line), and
 * the output without that line; code null when no such line was printed.
 */
export function readMarker(output, marker) {
    const lines = output.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const m = new RegExp(`^${marker} (-?\\d+)\\r?$`).exec(lines[i]);
        if (m)
            return { code: Number(m[1]), output: [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n') };
    }
    return { code: null, output };
}
const tail = (text) => (text.length > SANDBOX_OUTPUT_TAIL_CHARS ? text.slice(-SANDBOX_OUTPUT_TAIL_CHARS) : text);
/**
 * Run `argv` (already resolved: argv[0] is the executable) in the sandbox.
 * Never throws: every failure before a verdict is `ran: false`.
 */
export async function runSandboxed(argv, o, deps) {
    const notStarted = (reason) => ({ ran: false, reason });
    const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const marker = `${MARKER_PREFIX}${randomBytes(8).toString('hex')}`;
    const command = sandboxShellCommand(deps.platform, argv, o.cwd, marker);
    if (command === null)
        return notStarted(`the command ${JSON.stringify(argv)} cannot be passed to the sandbox shell unchanged (an empty argument or a double quote on Windows)`);
    const jobHome = join(o.jobRoot, `gate-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`);
    let client = null;
    let session = null;
    let pid;
    try {
        mkdirSync(jobHome, { recursive: true });
        const loaded = await deps.loadSdk().catch(() => null);
        if (!loaded)
            return notStarted('@github/copilot-sdk is not installed or could not be loaded, so the sandbox cannot start');
        const found = deps.resolveBin();
        const bin = found && deps.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(found) ? resolveShimTarget(found) : found;
        if (!bin)
            return notStarted(found ? `copilot shim ${found} names no .js/.exe target` : 'copilot CLI not found (PATH, COPILOT_CLI_PATH, WinGet), so the sandbox cannot start');
        const ident = loginIdentity(deps.userConfigDir());
        writeFileSync(join(jobHome, 'config.json'), `${JSON.stringify({ ...ident, trustedFolders: [o.cwd] }, null, 2)}\n`);
        const env = childEnv(allowlistSessionEnv(buildSessionEnv(deps.env, jobHome, { session: false, hasLogin: ident.loggedInUsers !== undefined }), jobHome));
        const missing = missingSandboxEnv(env, deps.platform);
        if (missing.length)
            return notStarted(`the sandbox env lacks ${missing.join(', ')}, which the Windows sandbox needs to launch any process`);
        mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
        mkdirSync(dirname(env.GIT_CONFIG_GLOBAL), { recursive: true });
        mkdirSync(env.TEMP, { recursive: true });
        // No credential helper for a git the command starts (the system one is Git for Windows' manager).
        writeFileSync(env.GIT_CONFIG_GLOBAL, '[credential]\n\thelper =\n');
        Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', COPILOT_ALLOW_ALL: 'false' });
        const gitHubToken = sessionGitHubToken(deps.env);
        const { CopilotClient, RuntimeConnection } = loaded.module;
        const c = new CopilotClient({
            connection: RuntimeConnection.forStdio({ path: bin, args: ['--max-ai-credits', String(RUNTIME_MIN_MAX_CREDITS)], env }),
            baseDirectory: jobHome,
            workingDirectory: o.cwd,
        });
        client = c;
        await withTimeout(c.start(), START_TIMEOUT_MS, 'client.start()');
        pid = runtimePid(c);
        const pluginRoot = deps.pluginRoot();
        const realHome = (deps.realHome ?? (() => userInfo().homedir))();
        const settings = { ...o.settings, enabled: true, writeUnsandboxed: 'refuse', writeNetwork: o.network, extraReadwritePaths: [] };
        const notes = [];
        const sandbox = new SessionSandboxController({
            profile: 'write',
            settings,
            env: deps.env,
            platform: deps.platform,
            rpcTimeoutMs: RPC_TIMEOUT_MS,
            ...(deps.sandboxTrialLaunch ? { trialLaunch: deps.sandboxTrialLaunch } : {}),
            policyContext: () => {
                const proxy = proxyCaEnv(deps.env, deps.platform, realHome);
                return {
                    worktree: resolve(o.cwd),
                    commonGitDir: resolve(o.commonGitDir),
                    pluginRoot,
                    jobHome,
                    jobDir: jobHome,
                    realHome,
                    platform: deps.platform,
                    settings,
                    hostCommits: true,
                    toolPaths: (deps.toolPaths ?? laneToolPaths)(deps.env, deps.platform),
                    extraReadonly: proxy.caPaths,
                };
            },
            note: (text) => { notes.push(text); },
        });
        const config = await sandbox.decide(c, loaded);
        if (!config)
            return notStarted(`the sandbox is not available: ${sandbox.state?.reason ?? 'unknown reason'}`);
        const attested = new Map();
        const onPermissionRequest = () => ({ kind: 'reject', feedback: 'omg factory run: a gate session grants nothing' });
        const atCreate = sandbox.atCreate(loaded, config);
        session = await withTimeout(c.createSession({
            onPermissionRequest,
            onEvent: (e) => {
                const data = (e.data ?? {});
                if (e.type === 'tool.execution_start')
                    sandbox.toolStarted(data);
                if (e.type === 'tool.execution_complete') {
                    attested.set(String(data.toolCallId ?? ''), data.sandboxed);
                    sandbox.toolCompleted(data);
                }
            },
            // No plugin: its hooks would run in the runtime, outside the sandbox.
            pluginDirectories: [],
            workingDirectory: o.cwd,
            disabledMcpServers: ['github-mcp-server'],
            excludedTools: [],
            ...(gitHubToken ? { gitHubToken } : {}),
            ...(atCreate ? { sandboxConfig: config } : {}),
        }), RPC_TIMEOUT_MS, 'createSession()');
        await sandbox.confirm(session, config, atCreate);
        if (sandbox.state?.mode !== 'enforced')
            return notStarted(`the sandbox policy was not confirmed: ${sandbox.state?.reason ?? 'unknown reason'}`);
        const shell = session.rpc.shell;
        if (typeof shell?.executeUserRequested !== 'function')
            return notStarted('the SDK has no shell.executeUserRequested RPC, so the command cannot run in the sandbox');
        const requestId = randomUUID();
        let timer;
        const call = shell.executeUserRequested.call(shell, { requestId, command }).then((value) => ({ value }), (error) => ({ error }));
        const timedOut = new Promise((r) => { timer = setTimeout(() => r('timeout'), o.timeoutMs); });
        let answer = await Promise.race([call, timedOut]);
        clearTimeout(timer);
        let timeout = false;
        if (answer === 'timeout') {
            timeout = true;
            try {
                await withTimeout(shell.cancelUserRequested?.call(shell, { requestId }) ?? Promise.resolve(), RPC_TIMEOUT_MS, 'cancelUserRequested()');
            }
            catch { /* torn down below */ }
            let grace;
            answer = await Promise.race([call, new Promise((r) => { grace = setTimeout(() => r('timeout'), CANCEL_GRACE_MS); })]);
            clearTimeout(grace);
        }
        const r = answer !== 'timeout' && 'value' in answer ? answer.value : null;
        const id = typeof r?.toolCallId === 'string' ? r.toolCallId : '';
        // The completion event can trail the RPC answer.
        for (let waited = 0; id && !attested.has(id) && waited < ATTEST_WAIT_MS; waited += 100)
            await sleep(100);
        const escapes = sandbox.state?.unsandboxedCalls ?? 0;
        if (escapes > 0)
            return notStarted(`${escapes} call(s) of the gate session were not attested sandboxed: true; nothing is counted`);
        if (!id || attested.get(id) !== true) {
            const why = !r ? (answer !== 'timeout' && 'error' in answer ? `the call failed: ${errText(answer.error)}` : 'the call gave no answer') : `its completion was ${attested.get(id) === false ? 'attested sandboxed: false' : 'not attested sandboxed'}`;
            return notStarted(`${timeout ? `timed out after ${o.timeoutMs} ms and ` : ''}${why}; the command is not counted as run in the sandbox`);
        }
        const raw = typeof r?.output === 'string' ? r.output : '';
        const read = readMarker(raw, marker);
        if (timeout)
            return { ran: true, status: 124, output: tail(`${read.output.trim()}\ntimed out after ${o.timeoutMs} ms`), timedOut: true };
        if (typeof r?.success !== 'boolean')
            return notStarted('the sandbox shell call reported no success field');
        if (read.code === null) {
            const err = typeof r?.error === 'string' && r.error ? `: ${r.error.slice(0, 300)}` : '';
            return notStarted(`the command did not finish in the sandbox shell (no exit code came back; shell exit ${String(r?.exitCode)})${err}`);
        }
        // The marker is the shell's last statement, so the shell itself succeeds; anything else contradicts it.
        if (r.success !== true || (typeof r.exitCode === 'number' && r.exitCode !== 0)) {
            return notStarted(`the sandbox shell reported failure (exit ${String(r.exitCode)}) after the command printed exit ${read.code}; not counted`);
        }
        return { ran: true, status: read.code, output: tail(read.output.trim()), timedOut: false };
    }
    catch (err) {
        return notStarted(`the sandbox runtime failed: ${errText(err).slice(0, 300)}`);
    }
    finally {
        if (session) {
            try {
                await withTimeout(session.disconnect(), RPC_TIMEOUT_MS, 'disconnect()');
            }
            catch { /* runtime gone */ }
            try {
                await withTimeout(client.deleteSession(session.sessionId), RPC_TIMEOUT_MS, 'deleteSession()');
            }
            catch { /* best effort */ }
        }
        if (client) {
            pid ??= runtimePid(client);
            // The command's children (a detached one survives a clean stop): kill the runtime's whole tree while it is their parent.
            if (session && pid && deps.isAlive(pid)) {
                try {
                    deps.killTree(pid);
                }
                catch { /* best effort */ }
            }
            let stopped = false;
            try {
                await withTimeout(client.stop(), STOP_TIMEOUT_MS, 'client.stop()');
                stopped = true;
            }
            catch { /* escalate */ }
            if (!stopped) {
                if (pid && deps.isAlive(pid)) {
                    try {
                        deps.killTree(pid);
                    }
                    catch { /* best effort */ }
                }
                try {
                    await withTimeout(client.forceStop?.() ?? Promise.resolve(), STOP_TIMEOUT_MS, 'client.forceStop()');
                }
                catch { /* gone */ }
            }
            if (pid && deps.isAlive(pid)) {
                try {
                    deps.killTree(pid);
                }
                catch { /* best effort */ }
            }
        }
        // The job home holds the runtime's session state and package cache, not evidence.
        try {
            rmSync(jobHome, { recursive: true, force: true });
        }
        catch { /* best effort */ }
    }
}
/** Where the per-command job homes live: the repository's OMC state root, outside every checkout. */
export const sandboxJobRoot = (root) => join(getOmcRoot(root), 'state', 'factory-gates');
/**
 * The engine's sandbox runner for the repository at `root`: the factory
 * sandbox settings (user config; the project config may only tighten), the
 * network they name, and copilot_run's runtime deps.
 */
export function createSandboxRunner(root, deps = defaultCopilotRunDeps()) {
    return async (req) => {
        let settings;
        try {
            settings = loadSandboxSettings(root, 'factory').settings;
        }
        catch (err) {
            return { ran: false, reason: `the sandbox settings could not be read: ${errText(err)}` };
        }
        return runSandboxed([req.exe, ...req.args], {
            cwd: req.cwd,
            commonGitDir: req.commonGitDir,
            timeoutMs: req.timeoutMs,
            network: settings.writeNetwork,
            settings,
            jobRoot: sandboxJobRoot(root),
        }, deps);
    };
}
/** Variables gateEnv drops on top of scrubShipEnv: every credential an unsandboxed gate could use. */
export const GATE_ENV_DROPPED = [
    'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GH_CONFIG_DIR', 'AZURE_DEVOPS_EXT_PAT', 'AZURE_CONFIG_DIR',
    'COPILOT_GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'GIT_ASKPASS',
];
/** The home variables gateEnv points at the empty per-run home. */
const GATE_HOME_VARS = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'APPDATA'];
/**
 * The environment of a gate or prepare check that runs WITHOUT the sandbox
 * (gates "ack" / "unsandboxed"): scrubShipEnv, minus GATE_ENV_DROPPED, with
 * HOME, USERPROFILE and XDG_CONFIG_HOME pointing at `home` (an empty dir the
 * caller creates per run and removes after), APPDATA (when set) at
 * `<home>/AppData/Roaming` (gh keeps its hosts.yml under it on Windows),
 * no system or global git config (GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL =
 * an empty file in `home`) and no credential prompt. LOCALAPPDATA is kept:
 * npm's cache and per-user tools live under it and it holds no credential
 * file of git, gh or az. A speed bump, not a boundary: the code still runs
 * with the user's rights (the Windows Credential Manager, ~/.config/gh read
 * by an absolute path).
 */
export function gateEnv(env, home) {
    const drop = new Set([...GATE_ENV_DROPPED, ...GATE_HOME_VARS].map((k) => k.toUpperCase()));
    const hadAppData = Object.keys(env).some((k) => k.toUpperCase() === 'APPDATA');
    const out = {};
    for (const [key, value] of Object.entries(scrubShipEnv(env))) {
        if (!drop.has(key.toUpperCase()))
            out[key] = value;
    }
    mkdirSync(home, { recursive: true });
    const gitConfig = join(home, '.gitconfig-empty');
    writeFileSync(gitConfig, '');
    return {
        ...out,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        ...(hadAppData ? { APPDATA: join(home, 'AppData', 'Roaming') } : {}),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: gitConfig,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
    };
}
//# sourceMappingURL=sandbox-exec.js.map