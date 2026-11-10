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
import { type CopilotRunDeps } from '../../copilot-run/job.js';
import { type SandboxSettings } from '../../copilot-run/sandbox.js';
/** The output tail a sandboxed command keeps (as the local gate record, local-gate.ts LOCAL_GATE_TAIL_CHARS). */
export declare const SANDBOX_OUTPUT_TAIL_CHARS = 8000;
/** One command for the sandbox: the configured argv (for records and messages) and what it resolved to. */
export interface SandboxRunRequest {
    /** What runs it: a prepare check, the local gate, or a base calibration of either. */
    purpose: 'prepare' | 'gate' | 'calibrate';
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
}
/** A verdict (the command ran in the attested sandbox), or why there is none. */
export type SandboxRunResult = {
    ran: true;
    status: number;
    output: string;
    timedOut: boolean;
} | {
    ran: false;
    reason: string;
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
}
/**
 * The shell command executeUserRequested runs (the runtime's shell:
 * PowerShell on Windows, bash elsewhere): change into `cwd` (a failure runs
 * nothing and prints no marker), run the argv with every word quoted as a
 * literal, then print `<marker> <exit code>` on its own line. On Windows the
 * argv may not hold an empty word or a double quote (Windows PowerShell drops
 * the first and mangles the second when it builds the native command line):
 * null then.
 */
export declare function sandboxShellCommand(platform: NodeJS.Platform, argv: readonly string[], cwd: string, marker: string): string | null;
/**
 * The exit code the marker line reports (the last `<marker> <n>` line), and
 * the output without that line; code null when no such line was printed.
 */
export declare function readMarker(output: string, marker: string): {
    code: number | null;
    output: string;
};
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
export declare function createSandboxRunner(root: string, deps?: SandboxExecDeps): SandboxRunner;
/** Variables gateEnv drops on top of scrubShipEnv: every credential an unsandboxed gate could use. */
export declare const GATE_ENV_DROPPED: readonly string[];
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
export declare function gateEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv;
//# sourceMappingURL=sandbox-exec.d.ts.map