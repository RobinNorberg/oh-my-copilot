export declare const RUNNER_CLOCK_ENV = "OMC_TEST_RUNNER_CLOCK_FILE";
export interface RunnerClock {
    /** Runner process start, epoch ms (the origin run.cjs counts its inner timeout from). */
    startedAt: number;
    /** Epoch ms at which the runner's process 'exit' event fired. */
    exitedAt: number;
    /** exitedAt - startedAt. */
    lifetimeMs: number;
}
/** node argv for a clocked run.cjs: `[...clockedRunnerArgs(runCjs, target)]`. */
export declare function clockedRunnerArgs(runCjsPath: string, ...args: string[]): string[];
/** Env entry that tells the preload where to write the clock record. */
export declare function runnerClockEnv(clockFile: string): Record<string, string>;
/** Read the record written at runner exit; throws if the runner never exited normally. */
export declare function readRunnerClock(clockFile: string): RunnerClock;
/**
 * Test-side hang guard for a runner whose budget is `budgetMs`: the budget plus
 * a scaled slack for process creation and exit notification. It only stops a
 * hung runner; the budget assertion uses the runner's clock.
 */
export declare function runnerHangGuardMs(budgetMs: number, slackMs?: number): number;
//# sourceMappingURL=runner-clock.d.ts.map