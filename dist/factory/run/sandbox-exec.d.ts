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
import { type CopilotRunDeps } from '../../copilot-run/job.js';
import { type GateContainerSettings, type SandboxConfigLayers, type SandboxSettings } from '../../copilot-run/sandbox.js';
/** The output tail a sandboxed command keeps (as the local gate record, local-gate.ts LOCAL_GATE_TAIL_CHARS). */
export declare const SANDBOX_OUTPUT_TAIL_CHARS = 8000;
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
    /** The user's checkout (the budget ledger the sandbox denies) when `commonGitDir` is another repository's (the private layout). */
    mainRoot?: string;
    /** The only dir a `<cwd>/node_modules` link may resolve to (the one the engine linked); another target is refused, never granted. */
    nodeModulesTarget?: string;
    /** The nested workspace node_modules of yours the engine validated (SandboxPolicyContext.nestedNodeModulesTargets); only these are granted. */
    nestedNodeModulesTargets?: string[];
    /** Where the per-command job home goes (default sandboxJobRoot(root); the private layout: under the run dir). */
    jobRoot?: string;
    /**
     * factory.run.sandbox.isolation "container" (user config only, resolved by the engine): the command runs in a
     * local container (container-gate.ts) instead of the Copilot OS sandbox, never in both, never falling back.
     */
    container?: GateContainerSettings;
    /** The run's container label (container-gate.ts containerRunLabel); needed with `container`. */
    runLabel?: string;
    /**
     * The engine-made one-commit git view of what `cwd` holds (git-view.ts), as its git dir on the host. With
     * `container` it becomes the copy's `.git` (the checkout's own `.git` never enters the container). The OS
     * sandbox reads no field: a base calibration's view is `<cwd>/.git` there, a prepare checkout uses its own link.
     */
    gitView?: string;
}
/** The gate record and PR note line for a sandboxed run on a host without denied_paths. */
export declare const CREDENTIAL_FILES_READABLE_NOTE = "sandboxed; credential files readable on this host";
/**
 * A verdict (the command ran in the attested sandbox), or why there is none.
 * `started`: the command was handed to the shell under the confirmed policy
 * and gave no verdict (the engine's gate-no-verdict park, never the
 * --allow-unsandboxed-gates one); unset: nothing of the PR's ran.
 * `refused`: the configured argv itself cannot be handed to the sandbox
 * shell (its shape or length), before any runtime launched: a property of
 * the command, which no code of the PR can cause.
 * `unavailable` (isolation "container" only): the container runtime, its
 * daemon or image is missing, or the project cannot be installed there;
 * nothing of the PR's ran (the engine's gate-container-unavailable park).
 */
export type SandboxRunResult = {
    ran: true;
    status: number;
    output: string;
    timedOut: boolean;
    credentialFilesReadable?: true;
    imageId?: string;
} | {
    ran: false;
    reason: string;
    started?: true;
    refused?: true;
    unavailable?: true;
};
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
    /** SandboxRunRequest.mainRoot / nodeModulesTarget. */
    mainRoot?: string;
    nodeModulesTarget?: string;
    nestedNodeModulesTargets?: string[];
}
export declare const MARKER_PREFIX = "omg-gate-exit-";
/** The command's output the POSIX form keeps (`tail -c`) before the marker line. */
export declare const SHELL_OUTPUT_BYTES: number;
/** The output lines, each cut to SHELL_LINE_CHARS, the PowerShell form keeps before the marker line. */
export declare const SHELL_OUTPUT_LINES = 400;
export declare const SHELL_LINE_CHARS = 2000;
/**
 * The shell command executeUserRequested runs (the runtime's shell:
 * PowerShell on Windows, bash elsewhere). No word of `cwd` or `argv` is ever
 * spliced into shell source: they travel as one base64 literal (only
 * `[A-Za-z0-9+/=]`), which the shell decodes into an array (UTF-8 words
 * separated by NUL in PowerShell, terminated by NUL in bash: no argv word can
 * hold a NUL, and no parser can retype a word), checks the word count of, changes
 * into the first (a failure runs nothing and prints no marker), runs the
 * rest as the command, keeps only the tail of its merged output, then prints
 * `<marker> <exit code>` as the last line. On Windows the argv may not hold
 * an empty word or a double quote (Windows PowerShell drops the first and
 * mangles the second when it builds the native command line): null then, as
 * for a NUL anywhere or a marker that is not `[A-Za-z0-9-]+`.
 */
export declare function sandboxShellCommand(platform: NodeJS.Platform, argv: readonly string[], cwd: string, marker: string): string | null;
/**
 * The longest shell command runSandboxed hands to the runtime. The SDK types
 * do not say how the runtime passes it to its shell; assume one argument of
 * a process command line: on Windows CreateProcess takes 32 767 characters
 * in all, and the shell's path, its flags and quote escaping need the rest;
 * elsewhere Linux caps one argv string at 131 072 bytes.
 */
export declare const sandboxCommandMaxChars: (platform: NodeJS.Platform) => number;
/** Whether `argv` in `cwd` encodes to a shell command above sandboxCommandMaxChars (false for one the shell refuses anyway). */
export declare function sandboxCommandTooLong(platform: NodeJS.Platform, argv: readonly string[], cwd: string): boolean;
/**
 * A built-in check's `<script> [run] <file...>` args (`fixed` = the words
 * before the file list) cut into several argument lists, each with at least
 * one file and, where one file allows it, short enough for the sandbox
 * shell. One list when the whole command fits. The caller runs them all and
 * counts a pass only when every one passes.
 */
export declare function splitFileListArgs(platform: NodeJS.Platform, exe: string, args: readonly string[], fixed: number, cwd: string): string[][];
/**
 * The exit code the marker line reports, and the output without it. A
 * verdict needs `marker` exactly once, and no other MARKER_PREFIX anywhere,
 * as the last non-empty line `<marker> <n>`: a forged line before the real
 * one, one after it (a detached child), or the real one missing (a killed
 * shell) gives code null.
 */
export declare function readMarker(output: string, marker: string): {
    code: number | null;
    output: string;
};
/** Token-shaped text (GitHub, npm, AWS, sk- / sk-ant- keys, JWTs, .npmrc credentials, PEM private keys, Bearer values) replaced before an output tail is kept anywhere; pattern-based: only text printed verbatim. */
export declare function redactGateOutput(text: string): string;
/**
 * Run `argv` (already resolved: argv[0] is the executable) in the sandbox.
 * Never throws: every failure before a verdict is `ran: false`.
 */
export declare function runSandboxed(argv: readonly string[], o: SandboxExecOptions, deps: SandboxExecDeps): Promise<SandboxRunResult>;
/** Where the per-command job homes live: the repository's OMC state root, outside every checkout. */
export declare const sandboxJobRoot: (root: string) => string;
/**
 * The engine's sandbox runner for the repository at `root`: the factory
 * sandbox settings (user config; the project config may only tighten), the
 * network they name, and copilot_run's runtime deps.
 */
export declare function createSandboxRunner(root: string, deps?: SandboxExecDeps, layers?: SandboxConfigLayers): SandboxRunner;
/**
 * The only variables gateEnv passes through from the engine's env (compared
 * case-insensitively; `LC_*` too). The Windows system vars let node, npm
 * (ComSpec runs its scripts) and the C runtime start; locale, time zone, CI
 * and NODE_ENV change test output only; NPM_CONFIG_CACHE names a cache dir,
 * never a credential. No token, no npm_config_* (npm_config_userconfig names
 * the real ~/.npmrc, which can hold an _authToken), no NODE_OPTIONS.
 */
export declare const GATE_ENV_KEPT: readonly string[];
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
export declare function gateEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv;
//# sourceMappingURL=sandbox-exec.d.ts.map