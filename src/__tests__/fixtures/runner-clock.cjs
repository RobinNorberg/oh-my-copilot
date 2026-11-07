'use strict';

// Preloaded into a run.cjs process under test with `node --require <this> run.cjs ...`.
// It records the runner's own clock: process start (performance.timeOrigin,
// the same origin run.cjs counts its inner timeout from) and the moment the
// runner exits. A --require flag reaches only this process; run.cjs spawns
// its supervisor and hook with a fresh argv, so they are not instrumented.
//
// The record lets a budget test measure the runner's lifetime on its own
// clock, without the OS process-creation delay before the runner starts or
// the test's own event-loop delay in noticing the exit, which both grow on a
// loaded host and are not the runner's to control.
// Worker threads inherit execArgv (and so this preload); only the main thread
// is the runner.
const { writeFileSync } = require('node:fs');
const { isMainThread } = require('node:worker_threads');

const clockFile = process.env.OMC_TEST_RUNNER_CLOCK_FILE;
if (clockFile && isMainThread) {
  const startedAt = performance.timeOrigin;
  process.once('exit', () => {
    writeFileSync(clockFile, JSON.stringify({ startedAt, exitedAt: Date.now() }));
  });
}
