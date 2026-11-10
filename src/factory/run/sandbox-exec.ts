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
 * Anything else is `ran: false`: the engine parks, it never counts as a
 * pass and never as a failure that would start a ci-fix lane. `started`
 * tells the two apart: before the command was handed to a confirmed policy
 * (host unsupported, policy not applied, no SDK, or no denied_paths with
 * factory.run.sandbox.requireDeniedPaths) it is
 * unset; after that (no single marker, a contradiction, no attestation, a
 * timeout with no answer) it is true, and the reason is fixed text, never
 * the command's. The argv reaches the shell only as base64 that the shell
 * decodes into an array, never as shell source, and the command's output is
 * bounded inside the shell. The runtime's working directory is an empty dir
 * in the job home: the checkout is a read-write policy path the command
 * changes into, so repository config an earlier check wrote there is never
 * loaded by the next runtime.
 * A timeout cancels the call (cancelUserRequested), then the session is
 * disconnected, the runtime's process tree killed and the client stopped.
 *
 * gateEnv is the environment of a command the engine runs WITHOUT the
 * sandbox (gates "ack" or "unsandboxed"): an allowlist (no credential
 * variable passes), with an empty home. It is a speed bump, not a
 * boundary: unsandboxed code still runs with the user's rights.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { defaultCopilotRunDeps, type CopilotRunDeps } from '../../copilot-run/job.js';
import {
  allowlistSessionEnv,
  loadSandboxSettings,
  laneToolPaths,
  missingSandboxEnv,
  proxyCaEnv,
  sessionGitHubToken,
  type SandboxConfigLayers,
  type SandboxSettings,
} from '../../copilot-run/sandbox.js';
import { SessionSandboxController } from '../../copilot-run/sandbox-session.js';
import { errText, withTimeout } from '../../copilot-run/timeout.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { TRUSTED_READ_ENV } from '../../ship/exec.js';
import { redactSecrets } from '../heal/sanitize.js';
import { resolveShimTarget, runtimePid, type PermissionResult, type SdkClientLike, type SdkSessionLike } from '../../smoke/copilot-sdk-driver.js';
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

/** One command for the sandbox: the configured argv (for records and messages) and what it resolved to. */
export interface SandboxRunRequest {
  /** What runs it: a prepare check, the local gate, or a base calibration of either. */
  purpose: 'prepare' | 'gate' | 'calibrate' | 'install';
  /** The configured argv (ship.prepare.checks, factory.forge.local.gate) or the built-in check's. */
  argv: readonly string[];
  /** The executable and arguments it resolved to (resolveLocalGateArgv: never a .cmd/.bat). */
  exe: string;
  args: readonly string[];
  /** The engine-owned checkout it runs in (read-write in the sandbox). */
  cwd: string;
  /** The repository's common git dir (read-only in the sandbox). */
  commonGitDir: string;
  timeoutMs: number;
  /** factory.run.sandbox.requireDeniedPaths: a host without denied_paths gives no verdict instead of running. */
  requireDeniedPaths?: boolean;
  /** The network this command needs over factory.run.sandbox.writeNetwork (the private layout's `npm ci --ignore-scripts`: the registry). */
  network?: 'registry';
}

/** The gate record and PR note line for a sandboxed run on a host without denied_paths. */
export const CREDENTIAL_FILES_READABLE_NOTE = 'sandboxed; credential files readable on this host';

/**
 * A verdict (the command ran in the attested sandbox), or why there is none.
 * `started`: the command was handed to the shell under the confirmed policy
 * and gave no verdict (the engine's gate-no-verdict park, never the
 * --allow-unsandboxed-gates one); unset: nothing of the PR's ran.
 */
export type SandboxRunResult =
  | { ran: true; status: number; output: string; timedOut: boolean; credentialFilesReadable?: true }
  | { ran: false; reason: string; started?: true };

export type SandboxRunner = (req: SandboxRunRequest) => Promise<SandboxRunResult>;

/** The runtime operations runSandboxed needs (copilot_run's deps; tests pass a fake SDK). */
export type SandboxExecDeps = Pick<CopilotRunDeps, 'env' | 'platform' | 'loadSdk' | 'resolveBin' | 'pluginRoot' | 'userConfigDir' | 'isAlive' | 'killTree' | 'realHome' | 'toolPaths' | 'sandboxTrialLaunch'> & {
  /** Wait (default a timer); tests make it instant. */
  sleep?: (ms: number) => Promise<void>;
};

export interface SandboxExecOptions {
  cwd: string;
  commonGitDir: string;
  timeoutMs: number;
  network: 'none' | 'registry';
  /** The factory sandbox settings (allowedHosts, extra read-only paths); extra read-write paths are dropped. */
  settings: SandboxSettings;
  /** The dir the per-command job homes go under (never inside `cwd`). */
  jobRoot: string;
  /** factory.run.sandbox.requireDeniedPaths (default false: a host without denied_paths runs, its verdict marked). */
  requireDeniedPaths?: boolean;
}

export const MARKER_PREFIX = 'omg-gate-exit-';
/** The command's output the POSIX form keeps (`tail -c`) before the marker line. */
export const SHELL_OUTPUT_BYTES = 64 * 1024;
/** The output lines, each cut to SHELL_LINE_CHARS, the PowerShell form keeps before the marker line. */
export const SHELL_OUTPUT_LINES = 400;
export const SHELL_LINE_CHARS = 2_000;

/**
 * The shell command executeUserRequested runs (the runtime's shell:
 * PowerShell on Windows, bash elsewhere). No word of `cwd` or `argv` is ever
 * spliced into shell source: they travel as one base64 literal (only
 * `[A-Za-z0-9+/=]`), which the shell decodes into an array (PowerShell: UTF-8
 * JSON `{cwd, argv}`; bash: NUL-terminated words, since bash has no JSON
 * parser and no argv word can hold a NUL), checks the word count of, changes
 * into the first (a failure runs nothing and prints no marker), runs the
 * rest as the command, keeps only the tail of its merged output, then prints
 * `<marker> <exit code>` as the last line. On Windows the argv may not hold
 * an empty word or a double quote (Windows PowerShell drops the first and
 * mangles the second when it builds the native command line): null then, as
 * for a NUL anywhere or a marker that is not `[A-Za-z0-9-]+`.
 */
export function sandboxShellCommand(platform: NodeJS.Platform, argv: readonly string[], cwd: string, marker: string): string | null {
  if (argv.length === 0 || !/^[A-Za-z0-9-]+$/.test(marker) || [cwd, ...argv].some((a) => a.includes('\0'))) return null;
  if (platform === 'win32') {
    if (argv.some((a) => a === '' || a.includes('"'))) return null;
    const payload = Buffer.from(JSON.stringify({ cwd, argv }), 'utf8').toString('base64');
    return [
      `$omgP = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
      '$omgV = @($omgP.argv)',
      `if ($omgV.Count -eq ${argv.length} -and $omgP.cwd -is [string]) { Set-Location -LiteralPath $omgP.cwd -ErrorAction Stop; $ErrorActionPreference = 'Continue'; $omgE = $omgV[0]; $omgR = @($omgV | Select-Object -Skip 1); $global:LASTEXITCODE = $null; & $omgE @omgR 2>&1 | ForEach-Object { $omgL = "$_"; if ($omgL.Length -gt ${SHELL_LINE_CHARS}) { $omgL.Substring(0, ${SHELL_LINE_CHARS}) } else { $omgL } } | Select-Object -Last ${SHELL_OUTPUT_LINES}; "${marker} $LASTEXITCODE" }`,
    ].join('; ');
  }
  const payload = Buffer.from([cwd, ...argv].map((w) => `${w}\0`).join(''), 'utf8').toString('base64');
  // The output goes to a temp file (TMPDIR: the job's own temp dir) and only its tail is printed: `tail -c` on a file
  // seeks, while on a pipe some coreutils releases print more than the bound (seen with 9.4 on Ubuntu 24.04).
  return `omg_a=(); while IFS= read -r -d '' omg_w; do omg_a+=("$omg_w"); done < <(printf '%s' '${payload}' | base64 -d); if [ "\${#omg_a[@]}" -eq ${argv.length + 1} ] && omg_o=$(mktemp) && cd -- "\${omg_a[0]}"; then "\${omg_a[@]:1}" > "$omg_o" 2>&1; omg_s=$?; tail -c ${SHELL_OUTPUT_BYTES} -- "$omg_o"; rm -f -- "$omg_o"; printf '\\n%s %s\\n' '${marker}' "$omg_s"; fi`;
}

/**
 * The exit code the marker line reports, and the output without it. A
 * verdict needs `marker` exactly once, and no other MARKER_PREFIX anywhere,
 * as the last non-empty line `<marker> <n>`: a forged line before the real
 * one, one after it (a detached child), or the real one missing (a killed
 * shell) gives code null.
 */
export function readMarker(output: string, marker: string): { code: number | null; output: string } {
  const none = { code: null, output };
  const count = (s: string) => output.split(s).length - 1;
  if (count(marker) !== 1 || count(MARKER_PREFIX) !== (marker.includes(MARKER_PREFIX) ? 1 : 0)) return none;
  const lines = output.split('\n');
  let i = lines.length - 1;
  while (i >= 0 && lines[i].trim() === '') i--;
  const m = i >= 0 ? /^(\S+) (-?\d+)\r?$/.exec(lines[i]) : null;
  if (!m || m[1] !== marker) return none;
  return { code: Number(m[2]), output: lines.slice(0, i).join('\n') };
}

/** Token-shaped text (GitHub, npm, AWS keys, PEM private keys, Bearer values) replaced before an output tail is kept anywhere. */
export function redactGateOutput(text: string): string {
  return redactSecrets(text)
    .replace(/\bnpm_[A-Za-z0-9]{36}\b/g, '[redacted]')
    // A key block whose BEGIN line the output bound cut off: its base64 body lines up to the END line.
    .replace(/(?:[A-Za-z0-9+/=]{40,}\r?\n)+-----END [A-Z0-9 ]*KEY-----/g, '[redacted]');
}

const tail = (text: string): string => {
  const clean = redactGateOutput(text);
  return clean.length > SANDBOX_OUTPUT_TAIL_CHARS ? clean.slice(-SANDBOX_OUTPUT_TAIL_CHARS) : clean;
};

type ShellRpc = {
  executeUserRequested?: (p: { requestId: string; command: string }) => Promise<unknown>;
  cancelUserRequested?: (p: { requestId: string }) => Promise<unknown>;
};

/**
 * Run `argv` (already resolved: argv[0] is the executable) in the sandbox.
 * Never throws: every failure before a verdict is `ran: false`.
 */
export async function runSandboxed(argv: readonly string[], o: SandboxExecOptions, deps: SandboxExecDeps): Promise<SandboxRunResult> {
  const notStarted = (reason: string): SandboxRunResult => ({ ran: false, reason });
  // After the command was handed over: fixed text only (the output and the runtime's error may be the command's).
  const noVerdict = (reason: string): SandboxRunResult => ({ ran: false, reason, started: true });
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const marker = `${MARKER_PREFIX}${randomBytes(8).toString('hex')}`;
  const command = sandboxShellCommand(deps.platform, argv, o.cwd, marker);
  if (command === null) return notStarted('the command cannot be passed to the sandbox shell unchanged (a NUL, or on Windows an empty argument or a double quote)');
  const jobHome = join(o.jobRoot, `gate-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`);
  // The runtime's own working directory and its only trusted folder: empty, fresh per command, never the checkout.
  const workDir = join(jobHome, 'work');
  let client: SdkClientLike | null = null;
  let session: SdkSessionLike | null = null;
  let pid: number | undefined;
  let started = false;
  try {
    mkdirSync(workDir, { recursive: true });
    const loaded = await deps.loadSdk().catch(() => null);
    if (!loaded) return notStarted('@github/copilot-sdk is not installed or could not be loaded, so the sandbox cannot start');
    const found = deps.resolveBin();
    const bin = found && deps.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(found) ? resolveShimTarget(found) : found;
    if (!bin) return notStarted(found ? `copilot shim ${found} names no .js/.exe target` : 'copilot CLI not found (PATH, COPILOT_CLI_PATH, WinGet), so the sandbox cannot start');
    const ident = loginIdentity(deps.userConfigDir());
    writeFileSync(join(jobHome, 'config.json'), `${JSON.stringify({ ...ident, trustedFolders: [workDir] }, null, 2)}\n`);
    const env = childEnv(allowlistSessionEnv(buildSessionEnv(deps.env, jobHome, { session: false, hasLogin: ident.loggedInUsers !== undefined }), jobHome));
    const missing = missingSandboxEnv(env, deps.platform);
    if (missing.length) return notStarted(`the sandbox env lacks ${missing.join(', ')}, which the Windows sandbox needs to launch any process`);
    mkdirSync(env.XDG_CONFIG_HOME!, { recursive: true });
    mkdirSync(dirname(env.GIT_CONFIG_GLOBAL!), { recursive: true });
    mkdirSync(env.TEMP!, { recursive: true });
    // No credential helper for a git the command starts (the system one is Git for Windows' manager).
    writeFileSync(env.GIT_CONFIG_GLOBAL!, '[credential]\n\thelper =\n');
    Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', COPILOT_ALLOW_ALL: 'false' });
    const gitHubToken = sessionGitHubToken(deps.env);

    const { CopilotClient, RuntimeConnection } = loaded.module;
    const c: SdkClientLike = new CopilotClient({
      connection: RuntimeConnection.forStdio({ path: bin, args: ['--max-ai-credits', String(RUNTIME_MIN_MAX_CREDITS)], env }),
      baseDirectory: jobHome,
      workingDirectory: workDir,
    });
    client = c;
    await withTimeout(c.start(), START_TIMEOUT_MS, 'client.start()');
    pid = runtimePid(c);
    const pluginRoot = deps.pluginRoot();
    const realHome = (deps.realHome ?? (() => userInfo().homedir))();
    const settings: SandboxSettings = { ...o.settings, enabled: true, writeUnsandboxed: 'refuse', writeNetwork: o.network, extraReadwritePaths: [] };
    const notes: string[] = [];
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
    if (!config) return notStarted(`the sandbox is not available: ${sandbox.state?.reason ?? 'unknown reason'}`);
    // Without a deny list (the Copilot sandbox on Windows) the command can read files under the user profile, credential
    // stores included: it runs and counts, marked, unless factory.run.sandbox.requireDeniedPaths asks for no verdict.
    const readable = !config.userPolicy.filesystem.deniedPaths?.length;
    if (readable && o.requireDeniedPaths) {
      return notStarted('the sandbox host does not report denied_paths, so it cannot hide your credential files from the PR\'s code, and factory.run.sandbox.requireDeniedPaths is true');
    }
    const attested = new Map<string, unknown>();
    const onPermissionRequest = (): PermissionResult => ({ kind: 'reject', feedback: 'omg factory run: a gate session grants nothing' });
    const atCreate = sandbox.atCreate(loaded, config);
    session = await withTimeout(c.createSession({
      onPermissionRequest,
      onEvent: (e) => {
        const data = (e.data ?? {}) as Record<string, unknown>;
        if (e.type === 'tool.execution_start') sandbox.toolStarted(data);
        if (e.type === 'tool.execution_complete') {
          attested.set(String(data.toolCallId ?? ''), data.sandboxed);
          sandbox.toolCompleted(data);
        }
      },
      // No plugin: its hooks would run in the runtime, outside the sandbox.
      pluginDirectories: [],
      workingDirectory: workDir,
      disabledMcpServers: ['github-mcp-server'],
      excludedTools: [],
      ...(gitHubToken ? { gitHubToken } : {}),
      ...(atCreate ? { sandboxConfig: config } : {}),
    }), RPC_TIMEOUT_MS, 'createSession()');
    await sandbox.confirm(session, config, atCreate);
    if (sandbox.state?.mode !== 'enforced') return notStarted(`the sandbox policy was not confirmed: ${sandbox.state?.reason ?? 'unknown reason'}`);
    const shell = (session.rpc as { shell?: ShellRpc }).shell;
    if (typeof shell?.executeUserRequested !== 'function') return notStarted('the SDK has no shell.executeUserRequested RPC, so the command cannot run in the sandbox');

    const requestId = randomUUID();
    let timer: NodeJS.Timeout | undefined;
    started = true;
    const call = shell.executeUserRequested.call(shell, { requestId, command }).then((value) => ({ value }), (error: unknown) => ({ error }));
    const timedOut = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), o.timeoutMs); });
    let answer = await Promise.race([call, timedOut]);
    clearTimeout(timer);
    let timeout = false;
    if (answer === 'timeout') {
      timeout = true;
      try { await withTimeout(shell.cancelUserRequested?.call(shell, { requestId }) ?? Promise.resolve(), RPC_TIMEOUT_MS, 'cancelUserRequested()'); } catch { /* torn down below */ }
      let grace: NodeJS.Timeout | undefined;
      answer = await Promise.race([call, new Promise<'timeout'>((r) => { grace = setTimeout(() => r('timeout'), CANCEL_GRACE_MS); })]);
      clearTimeout(grace);
    }
    const r = answer !== 'timeout' && 'value' in answer ? answer.value as Record<string, unknown> | null : null;
    const id = typeof r?.toolCallId === 'string' ? r.toolCallId : '';
    // The completion event can trail the RPC answer.
    for (let waited = 0; id && !attested.has(id) && waited < ATTEST_WAIT_MS; waited += 100) await sleep(100);
    const escapes = sandbox.state?.unsandboxedCalls ?? 0;
    if (escapes > 0) return noVerdict(`${escapes} call(s) of the gate session were not attested sandboxed: true; nothing is counted`);
    if (!id || attested.get(id) !== true) {
      const why = !r ? (answer !== 'timeout' && 'error' in answer ? 'the shell call failed' : 'the shell call gave no answer') : `its completion was ${attested.get(id) === false ? 'attested sandboxed: false' : 'not attested sandboxed'}`;
      return noVerdict(`${timeout ? `timed out after ${o.timeoutMs} ms and ` : ''}${why}; the command is not counted as run in the sandbox`);
    }
    const raw = typeof r?.output === 'string' ? r.output : '';
    const read = readMarker(raw, marker);
    const marked = readable ? { credentialFilesReadable: true as const } : {};
    if (timeout) return { ran: true, status: 124, output: tail(`${read.output.trim()}\ntimed out after ${o.timeoutMs} ms`), timedOut: true, ...marked };
    if (typeof r?.success !== 'boolean') return noVerdict('the sandbox shell call reported no success field');
    if (read.code === null) return noVerdict('the output did not end with the one exit-code marker line the sandbox shell prints after the command');
    // The marker is the shell's last statement: the shell's own exit is 0, or (if the runtime reports the last native
    // exit code) the command's. A shell killed after a forged marker line reports neither.
    const exitOk = r.exitCode === undefined || r.exitCode === null || r.exitCode === 0 || r.exitCode === read.code;
    const successOk = r.success === true || read.code !== 0;
    if (!exitOk || !successOk) return noVerdict('the sandbox shell\'s own result contradicts the exit code the command printed');
    return { ran: true, status: read.code, output: tail(read.output.trim()), timedOut: false, ...marked };
  } catch (err) {
    if (started) return noVerdict('the sandbox runtime failed while the command ran');
    return notStarted(`the sandbox runtime failed: ${errText(err).slice(0, 300)}`);
  } finally {
    if (session) {
      try { await withTimeout(session.disconnect(), RPC_TIMEOUT_MS, 'disconnect()'); } catch { /* runtime gone */ }
      try { await withTimeout(client!.deleteSession(session.sessionId), RPC_TIMEOUT_MS, 'deleteSession()'); } catch { /* best effort */ }
    }
    if (client) {
      pid ??= runtimePid(client);
      // The command's children (a detached one survives a clean stop): kill the runtime's whole tree while it is their parent.
      if (session && pid && deps.isAlive(pid)) { try { deps.killTree(pid); } catch { /* best effort */ } }
      let stopped = false;
      try { await withTimeout(client.stop(), STOP_TIMEOUT_MS, 'client.stop()'); stopped = true; } catch { /* escalate */ }
      if (!stopped) {
        if (pid && deps.isAlive(pid)) { try { deps.killTree(pid); } catch { /* best effort */ } }
        try { await withTimeout(client.forceStop?.() ?? Promise.resolve(), STOP_TIMEOUT_MS, 'client.forceStop()'); } catch { /* gone */ }
      }
      if (pid && deps.isAlive(pid)) { try { deps.killTree(pid); } catch { /* best effort */ } }
    }
    // The job home holds the runtime's session state and package cache, not evidence.
    try { rmSync(jobHome, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Where the per-command job homes live: the repository's OMC state root, outside every checkout. */
export const sandboxJobRoot = (root: string): string => join(getOmcRoot(root), 'state', 'factory-gates');

/**
 * The engine's sandbox runner for the repository at `root`: the factory
 * sandbox settings (user config; the project config may only tighten), the
 * network they name, and copilot_run's runtime deps.
 */
export function createSandboxRunner(root: string, deps: SandboxExecDeps = defaultCopilotRunDeps(), layers?: SandboxConfigLayers): SandboxRunner {
  return async (req) => {
    let settings: SandboxSettings;
    try {
      settings = (layers ? loadSandboxSettings(root, 'factory', layers) : loadSandboxSettings(root, 'factory')).settings;
    } catch (err) {
      return { ran: false, reason: `the sandbox settings could not be read: ${errText(err)}` };
    }
    return runSandboxed([req.exe, ...req.args], {
      cwd: req.cwd,
      commonGitDir: req.commonGitDir,
      timeoutMs: req.timeoutMs,
      network: req.network ?? settings.writeNetwork,
      settings,
      jobRoot: sandboxJobRoot(root),
      ...(req.requireDeniedPaths ? { requireDeniedPaths: true } : {}),
    }, deps);
  };
}

/**
 * The only variables gateEnv passes through from the engine's env (compared
 * case-insensitively; `LC_*` too). The Windows system vars let node, npm
 * (ComSpec runs its scripts) and the C runtime start; locale, time zone, CI
 * and NODE_ENV change test output only; NPM_CONFIG_CACHE names a cache dir,
 * never a credential. No token, no npm_config_* (npm_config_userconfig names
 * the real ~/.npmrc, which can hold an _authToken), no NODE_OPTIONS.
 */
export const GATE_ENV_KEPT: readonly string[] = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC',
  'LANG', 'TZ', 'CI', 'NODE_ENV', 'NPM_CONFIG_CACHE',
];

/**
 * The environment of a gate or prepare check that runs WITHOUT the sandbox
 * (gates "ack" / "unsandboxed"), built from an allowlist (GATE_ENV_KEPT and
 * `LC_*`), never from the engine's env minus a denylist: HOME, USERPROFILE
 * and XDG_CONFIG_HOME point at `home` (an empty dir the caller creates per
 * run and removes after), APPDATA and LOCALAPPDATA (when set) at
 * `<home>/AppData/Roaming` and `<home>/AppData/Local` (gh's hosts.yml, the
 * GCM/MSAL `.IdentityService` cache; npm's cache then lands in the empty
 * home, which a real `npm test` does not need), TEMP, TMP and TMPDIR at
 * `<home>/tmp`, no system or global git config (GIT_CONFIG_NOSYSTEM=1,
 * GIT_CONFIG_GLOBAL = an empty file in `home`) and no credential prompt. A
 * speed bump, not a boundary: the code still runs with the user's rights
 * (the Windows Credential Manager, ~/.config/gh read by an absolute path).
 */
export function gateEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const kept = new Set(GATE_ENV_KEPT);
  const has = (name: string) => Object.keys(env).some((k) => k.toUpperCase() === name);
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (value !== undefined && (kept.has(upper) || upper.startsWith('LC_'))) out[key] = value;
  }
  const tmp = join(home, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const gitConfig = join(home, '.gitconfig-empty');
  writeFileSync(gitConfig, '');
  return {
    ...out,
    ...TRUSTED_READ_ENV,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    ...(has('APPDATA') ? { APPDATA: join(home, 'AppData', 'Roaming') } : {}),
    ...(has('LOCALAPPDATA') ? { LOCALAPPDATA: join(home, 'AppData', 'Local') } : {}),
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  };
}
