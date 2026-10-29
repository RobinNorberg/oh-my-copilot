/**
 * Tier 2 `sandbox-lane` scenario of `omg smoke copilot` (opt-in, never in
 * `all`): copilot_run lanes in the Copilot OS sandbox, in-process, with the
 * default sandbox settings (the user config and OMG_SANDBOX do not apply).
 * It answers open questions Q1, Q2 and Q5 of
 * .omc/plans/2026-10-27-sandboxed-lanes-design.md §10 with one result line each.
 *
 * 1. A fresh repository next to the sandbox project (prepareFactoryRepo) with
 *    a probe script at its root. The script writes each path it is given,
 *    and in `full` mode also `<os.homedir()>/omg-canary-<nonce>` (the
 *    relocated profile), a loopback URL the scenario listens on and
 *    https://github.com, then prints one JSON line.
 * 2. A review lane is asked to run `git status`, the probe (the review shell
 *    allowlist refuses `node`) and to create a file. Nothing may land.
 * 3. A write lane (engine commits, as `omg factory run` write lanes) runs the
 *    probe against the main checkout, a shared directory outside the temp dir
 *    and the profile, the common git dir (Q2), the real home (Q1) and its own
 *    worktree. Only the worktree file may land, the network must stay shut,
 *    and the engine commits that one file with commitLaneWork.
 * 4. A canary lane runs the probe through `session.rpc.shell.executeUserRequested`
 *    before its first turn, a free command with no model turn (Q5): was it
 *    sandboxed, did it pass onPermissionRequest. Its turn is one short reply.
 *
 * The host checks every target itself after each lane and deletes what
 * landed (only files named after the run's nonce). The relocated profile is
 * the exception: the job deletes its home at the end, so that write is the
 * probe's own report. Each lane is capped at the 30-credit runtime minimum.
 */
import { type SandboxHostRecord } from '../copilot-run/sandbox.js';
import { type LaneBackend } from '../factory/run/lane.js';
import type { LoadedSdk } from './copilot-sdk-driver.js';
import { type SandboxCanaryRecord, type ScenarioRun } from './copilot-sdk-scenarios.js';
/** A lane wall time that fits one probe command or a short review with its tool turns. */
export declare const SANDBOX_LANE_TIMEOUT_MS = 300000;
/** The probe committed at the repository root: argv `<nonce> <full|writes> [<loopback url>] <path>...`. */
export declare const SANDBOX_PROBE_SOURCE: string;
/** What the canary lane's wrapped SDK did before the first turn; filled in place. */
export interface SandboxCanaryProbe {
    /** The shell command passed to executeUserRequested. */
    command: string;
    called: boolean;
    error?: string;
    result: SandboxCanaryRecord['result'];
    /** onPermissionRequest calls while the RPC ran. */
    permissionRequests: number;
}
export interface SandboxLaneScenarioInput {
    /** Plugin under test: the lanes' plugin root. */
    root: string;
    /** The copilot binary the lanes run (a resolved .js/.exe, not a shim). */
    bin: string;
    /** Tier 2 session env (isolated COPILOT_HOME, login identity). */
    env: NodeJS.ProcessEnv;
    /** Sandbox project: its parent holds this scenario's repository. */
    projectDir: string;
    /** Smoke home: its config.json holds the login identity the lanes copy. */
    home: string;
    /** Raised to {@link SANDBOX_LANE_TIMEOUT_MS} per lane. */
    timeoutMs: number;
    maxCredits: number;
    budget: number;
    eventsPath: string;
    /**
     * Test seams: the lane backend over the scenario repository (`canary` is
     * set for the canary lane's backend, which fills it), the clock, the
     * account's real home, the shared directory outside the temp dir, and the
     * temp dir the default grant includes.
     */
    lanes?: (repoRoot: string, canary: SandboxCanaryProbe | null) => LaneBackend;
    now?: () => number;
    realHome?: string;
    sharedDir?: string;
    tempDir?: string;
    /** Test seam: the host support probe that gates the lanes (default: a credit-free SDK client on `bin`). */
    probeHost?: () => Promise<SandboxHostRecord>;
    /** The model every lane runs on (the driver's cheap pick); unset: runtime auto. */
    model?: string;
}
/** A world-writable directory outside the temp dir and the profile: `%PUBLIC%` on Windows, else /var/tmp. */
export declare function defaultSharedDir(env: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string;
/**
 * The SDK with a client whose sessions run `probe.command` through
 * `session.rpc.shell.executeUserRequested` right before their first `send`,
 * after copilot_run applied and confirmed the sandbox. The override is an
 * instance property, so the prototype's createSession (what
 * sdkCreateSessionAcceptsSandbox reads) is the SDK's own.
 */
export declare function withSandboxCanary(loaded: LoadedSdk, probe: SandboxCanaryProbe): LoadedSdk;
/** The real copilot_run backend on the smoke's binary, plugin and login, with the default sandbox settings. */
export declare function sandboxLanes(input: Pick<SandboxLaneScenarioInput, 'env' | 'bin' | 'root' | 'home' | 'realHome'>, canary: SandboxCanaryProbe | null): LaneBackend;
export declare function runSandboxLaneScenario(input: SandboxLaneScenarioInput): Promise<Omit<ScenarioRun, 'logText'> & {
    wedged: boolean;
}>;
//# sourceMappingURL=copilot-sandbox-lane-scenario.d.ts.map