#!/usr/bin/env node

/**
 * Premium-request budget hook (SessionStart, UserPromptSubmit, Stop).
 *
 * argv[2] is the phase: `session-start` records the session and prints the
 * budget summary line, `stop` records the turn's usage and marks a crossed
 * soft/hard limit, `prompt` delivers that pending notice as context. The
 * logic lives in dist/budget/governor.js (src/budget, docs/REFERENCE.md
 * "Premium-request budget").
 *
 * Fail-open by contract: any error, a missing build or a bad payload prints
 * the no-op output and exits 0. This hook never blocks a session.
 * Kill switch: OMC_BUDGET_GOVERNOR=0.
 */

import { readStdin } from './lib/stdin.mjs';

const noop = { continue: true, suppressOutput: true };
const PHASES = new Set(['session-start', 'prompt', 'stop']);

async function main() {
  const phase = process.argv[2];
  if (!PHASES.has(phase) || process.env.OMC_BUDGET_GOVERNOR === '0') return noop;
  const raw = await readStdin(3000);
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    return noop;
  }
  try {
    const { runBudgetHook } = await import('../dist/budget/governor.js');
    return runBudgetHook({ phase, payload: payload && typeof payload === 'object' ? payload : null }) ?? noop;
  } catch (error) {
    if (process.env.OMC_DEBUG_HOOKS === '1') process.stderr.write(`[premium-budget] ${error?.message ?? error}\n`);
    return noop;
  }
}

console.log(JSON.stringify(await main()));
