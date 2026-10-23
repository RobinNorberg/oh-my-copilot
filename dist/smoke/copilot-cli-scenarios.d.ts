/**
 * Tier 2 CLI scenarios of `omg smoke copilot` (opt-in): headless `copilot`
 * sessions with the plugin under test, outside the SDK runtime, for what an
 * SDK session cannot set up: a stub plugin next to ours, a resumed session,
 * or a seeded workflow state. Ported from the 2026-10-23 live probe.
 *
 * - continuation: a stub Stop hook blocks the first stop with a reason that
 *   carries a nonce. Copilot injects the reason as a user.message, the model
 *   answers it, and the next stop carries stop_hook_active:true.
 * - prompt-context: a stub UserPromptSubmit hook returns a top-level
 *   additionalContext (the shape our adapter emits) with a nonce, and the
 *   model must echo it.
 * - events: a view of a missing file (postToolUseFailure) and a shell call
 *   under default permissions (permissionRequest), then the same session
 *   resumed with `/compact` (preCompact).
 * - ultragoal: our UserPromptSubmit group activates ultragoal for the session,
 *   the state is backdated past the confirmation TTL, and the session's tool
 *   calls must not be denied (pending lane g-cont, see PENDING_SCENARIOS).
 *
 * Every process gets the tier 1 isolation (the tier 2 env and COPILOT_HOME),
 * `--plugin-dir` for the plugin under test, `--max-ai-credits`, debug logs in
 * the shared `<home>/logs` (sliced per scenario by the driver), and the
 * persisted events.jsonl of its session id as the scenario's event stream.
 */
import { type CliEvidence, type CliScenario, type ScenarioRun } from './copilot-sdk-scenarios.js';
import { type SpawnFn, type SpawnSyncFn } from './process-utils.js';
export interface CliScenarioInput {
    name: CliScenario;
    /** The installed copilot binary (.exe or the .js a shim launches). */
    bin: string;
    root: string;
    /** Tier 2 session env (isolated COPILOT_HOME, login identity, OMC_HOOK_FAIL_CLOSED). */
    env: NodeJS.ProcessEnv;
    projectDir: string;
    home: string;
    /** Per copilot process. */
    timeoutMs: number;
    maxCredits: number;
    budget: number;
    eventsPath: string;
    spawnSync: SpawnSyncFn;
    /** Test seams. */
    spawn?: SpawnFn;
    randomUUID?: () => string;
    node?: string;
    now?: () => number;
}
/**
 * Sandbox flags per scenario (deny rules beat allow rules). Every scenario
 * denies our host_smoke tool and the built-in MCP servers; no scenario may
 * write files. `events` and `ultragoal` pre-approve only `view`, so the shell
 * call of `events` goes through a permission request.
 */
export declare const CLI_SCENARIO_PERMISSIONS: Record<CliScenario, string[]>;
/**
 * Writes the stub plugin under the home: `stub.cjs <kind> <config> <log>`.
 * `stop` blocks the first stop with the configured reason, then allows;
 * `prompt` returns the configured additionalContext. Each run appends
 * `{kind, payload, out}` to the log.
 */
export declare function prepareStubPlugin(home: string, name: CliScenario, text: string, node?: string): {
    dir: string;
    log: string;
} | null;
/**
 * Where the hooks write the session's ultragoal state. A literal `.omg/`, not
 * getOmcRoot(): the hook env is stripped of OMC_STATE_DIR (buildSessionEnv),
 * while this process may carry one.
 */
export declare function ultragoalStatePath(projectDir: string, sessionId: string): string;
/**
 * Activate ultragoal for the session through our real UserPromptSubmit hook
 * group (keyword-detector), then backdate the confirmation past its TTL and
 * cap the reinforcements at 1, so a continuation loop ends after one turn.
 */
export declare function seedUltragoal(input: Pick<CliScenarioInput, 'root' | 'projectDir' | 'env' | 'spawnSync'>, sessionId: string, now: number): NonNullable<CliEvidence['seed']>;
export declare function runCliScenario(input: CliScenarioInput): Promise<Omit<ScenarioRun, 'logText'> & {
    wedged: boolean;
}>;
//# sourceMappingURL=copilot-cli-scenarios.d.ts.map