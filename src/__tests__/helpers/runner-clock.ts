/**
 * The run.cjs runner's own clock, for tests that assert a wall-time budget.
 *
 * run.cjs counts its inner timeout from its own process start
 * (`performance.timeOrigin`). A test that measures from its `spawn()` call to
 * its `exit` event also counts two delays the runner does not control: the OS
 * creating the process before node starts, and the test's event loop noticing
 * the exit. Both grow without bound on a loaded host. These helpers start the
 * runner with a `--require` preload (src/__tests__/fixtures/runner-clock.cjs)
 * that records its start and exit, so the budget is asserted on the runner's
 * clock while the declared budget itself stays unchanged.
 *
 * The test-side wall clock is still a hang guard: `runnerHangGuardMs` scales
 * only the slack above the budget with the platform timing scale.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scaleTiming } from './platform.js';

const RUNNER_CLOCK_PRELOAD = join(process.cwd(), 'src', '__tests__', 'fixtures', 'runner-clock.cjs');

export const RUNNER_CLOCK_ENV = 'OMC_TEST_RUNNER_CLOCK_FILE';

export interface RunnerClock {
  /** Runner process start, epoch ms (the origin run.cjs counts its inner timeout from). */
  startedAt: number;
  /** Epoch ms at which the runner's process 'exit' event fired. */
  exitedAt: number;
  /** exitedAt - startedAt. */
  lifetimeMs: number;
}

/** node argv for a clocked run.cjs: `[...clockedRunnerArgs(runCjs, target)]`. */
export function clockedRunnerArgs(runCjsPath: string, ...args: string[]): string[] {
  return ['--require', RUNNER_CLOCK_PRELOAD, runCjsPath, ...args];
}

/** Env entry that tells the preload where to write the clock record. */
export function runnerClockEnv(clockFile: string): Record<string, string> {
  return { [RUNNER_CLOCK_ENV]: clockFile };
}

/** Read the record written at runner exit; throws if the runner never exited normally. */
export function readRunnerClock(clockFile: string): RunnerClock {
  if (!existsSync(clockFile)) {
    throw new Error(`run.cjs wrote no clock record at ${clockFile}: it was killed or never exited`);
  }
  const { startedAt, exitedAt } = JSON.parse(readFileSync(clockFile, 'utf8')) as { startedAt: number; exitedAt: number };
  return { startedAt, exitedAt, lifetimeMs: exitedAt - startedAt };
}

/**
 * Test-side hang guard for a runner whose budget is `budgetMs`: the budget plus
 * a scaled slack for process creation and exit notification. It only stops a
 * hung runner; the budget assertion uses the runner's clock.
 */
export function runnerHangGuardMs(budgetMs: number, slackMs = 1_000): number {
  return budgetMs + scaleTiming(slackMs);
}
