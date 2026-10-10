/**
 * Tier 2 `team` scenario of `omg smoke copilot` (opt-in): a real 2-worker
 * `omg team` on the sdk transport, driven only through the CLI under test.
 *
 * 1. `omg team 2:copilot --json "<numbered task list>"` from the sandbox
 *    project with no `--transport`: under the Copilot host (COPILOT_CLI=1) the
 *    default must pick the sdk transport. Workers get detached worktrees.
 * 2. `omg team status --json` is polled until both tasks settle; the last
 *    snapshot is kept. `omg team api list-tasks` then lists owners and states,
 *    and each worker worktree's commits on top of the leader HEAD are read.
 * 3. Each worker's sdk events and runtime debug logs are copied into the smoke
 *    home (the team state is disposed at shutdown), so `scn.team.cost` and
 *    `scn.team.adapter_errors` see them.
 * 4. `omg team shutdown`, while each worker's `sdk-session.json` is polled for
 *    the final `session.shutdown` totals. Then: no host or runtime pid left,
 *    the instance reservation released, the team state gone, and each
 *    worker's committed HEAD either merged into the leader HEAD or kept in a
 *    worktree `omg team status --json` lists under `preserved_worktrees`.
 *
 * Everything runs as child processes of `node <root>/bridge/cli.cjs`, so this
 * module imports no team code; the smoke entry injects it like `chain`.
 *
 * Cost: one user prompt per worker, about 2 premium requests. Each host is
 * capped at half of the run's remaining credit budget.
 */
import { type CopilotEvent } from './copilot-session-eval.js';
import { type ScenarioCost, type ScenarioRun, type TeamEvidence } from './copilot-sdk-scenarios.js';
import { type SpawnFn, type SpawnSyncFn } from './process-utils.js';
export interface TeamScenarioInput {
    /** Plugin under test: its `bridge/cli.cjs` is the `omg` that runs the team. */
    root: string;
    /** The installed copilot binary as resolved for tier 1 (a shim is fine): its dir goes first on PATH. */
    bin: string;
    /** Tier 2 session env (isolated COPILOT_HOME with the login identity). */
    env: NodeJS.ProcessEnv;
    /** Sandbox git repo (trusted in the home's config.json). */
    projectDir: string;
    home: string;
    /** Raised to {@link TEAM_BUDGET_MS}: a team run spans start, two tasks and shutdown. */
    timeoutMs: number;
    maxCredits: number;
    /** Credits left of the run cap; each host gets half. */
    budget: number;
    eventsPath: string;
    spawnSync: SpawnSyncFn;
    /** Test seams. */
    spawn?: SpawnFn;
    pollMs?: number;
    isAlive?: (pid: number) => boolean;
    now?: () => number;
}
/** The leader env: the Copilot host signal, copilot on PATH, detached worktrees, the per-host credit cap. */
export declare function teamLeaderEnv(base: NodeJS.ProcessEnv, bin: string, budget: number): NodeJS.ProcessEnv;
/** The last stdout line that parses as a JSON object. */
export declare function lastJsonObject(stdout: string): Record<string, unknown> | null;
/** `[omg team] sdk workers launched: N in X ms` from the start command's stderr. */
export declare function parseLaunchMs(stderr: string): number | null;
/** The tasks of an `omg team api list-tasks --json` reply. */
export declare function parseApiTasks(reply: Record<string, unknown> | null): TeamEvidence['tasks'];
/** Instance reservations for `teamName` left under the project's `.omg/state/team-recovery`. */
export declare function leftoverReservations(projectDir: string, teamName: string): string[];
/** Per worker: the latest parse of `sdk-session.json`, kept across the shutdown that deletes it. */
type SessionUsage = {
    premium: number;
    credits: number;
    final: boolean;
};
/** Sum per-worker usage; any worker without a session read falls back to its copied events. */
export declare function teamCost(usage: Map<string, SessionUsage>, eventsByWorker: Map<string, CopilotEvent[]>): ScenarioCost & {
    source: string;
};
export declare function runTeamScenario(input: TeamScenarioInput): Promise<Omit<ScenarioRun, 'logText'> & {
    wedged: boolean;
}>;
export {};
//# sourceMappingURL=copilot-team-scenario.d.ts.map