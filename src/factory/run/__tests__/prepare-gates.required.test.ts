import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { resolveShipConfig } from '../../../ship/config.js';
import type { ExecResult } from '../../../ship/exec.js';
import { NO_CI_CHECKS_NOTE } from '../../../ship/gates.js';
import { readShipState } from '../../../ship/state.js';
import { EXIT_AWAITING_HUMAN } from '../engine.js';
import { commitFile, greenGates, ISSUE, PR, review } from './fake-lanes.js';
import { scaleTiming } from '../../../__tests__/helpers/platform.js';
import { h, usePrepareGatesHarness, run } from './prepare-gates-harness.js';

vi.setConfig({ testTimeout: scaleTiming(90_000) });

usePrepareGatesHarness();

const config = (requiredChecks: string[]) => () => ({ config: { ...resolveShipConfig(undefined), requiredChecks, advisoryChecks: [] }, known: [] });
const ok = (body: unknown): ExecResult => ({ status: 0, stdout: JSON.stringify(body), stderr: '' });
/** The base commit's check runs / statuses (review-493 HIGH-1); every other GitHub read is unscripted. */
const baseChecks = (names: string[]) => (path: string): ExecResult | undefined => {
  if (/\/commits\/[0-9a-f]{40}\/check-runs\?per_page=100$/.test(path)) return ok({ check_runs: names.map((name) => ({ name })) });
  if (/\/commits\/[0-9a-f]{40}\/status\?per_page=100$/.test(path)) return ok({ statuses: [] });
  return undefined;
};

describe('M1: required checks on a repository that is not oh-my-copilot', () => {
  it('a configured name that never reports parks missing-checks with the fix, long before the gates timeout', async () => {
    h.gh.gates = [greenGates()];
    const start = Date.parse('2026-10-27T10:00:00.000Z');
    let now = start;
    const out = await run([commitFile('a.ts'), review('approve')], { gateConfig: config(['Test', 'Lint & Type Check']), now: () => now, sleep: async (ms) => { now += ms; } }).done;
    expect(out.exitCode).toBe(EXIT_AWAITING_HUMAN);
    expect(out.gate?.name, out.message).toBe('missing-checks');
    expect(out.gate?.reason).toContain('required check(s) Lint & Type Check never reported for this head: no CI job has that name; fix ship.requiredChecks in your user config or in the base branch');
    expect(out.gate?.reason).toContain('nothing new reported for the settle window, so the gates stop waiting');
    expect(out.message.match(/omg factory run /g)).toHaveLength(1);
    expect(now - start).toBeLessThan(15 * 60_000);
  });

  it('no names and no CI at all (the base commit reported no check either): green with the no-CI note in the merge park and the PR merge comment', async () => {
    h.gh.gates = [{ checks: [], runs: [] }];
    h.gh.api = baseChecks([]);
    const bodies: string[] = [];
    h.onCall = (c) => { if (c.startsWith(`gh pr comment ${PR} --body-file `)) bodies.push(readFileSync(c.split('--body-file ')[1], 'utf8')); };
    const out = await run([commitFile('a.ts'), review('approve')], { gateConfig: config([]) }).done;
    expect(out.gate?.name, out.message).toBe('merge');
    expect(out.gate?.reason).toContain(`gates green at ${out.state!.head!.slice(0, 12)} (${NO_CI_CHECKS_NOTE}: no CI ran on this head, check the change yourself)`);
    expect(readShipState(h.root, PR)!.phase).toBe('ready');
    const comment = bodies.find((b) => b.includes('Merge is a human step'));
    expect(comment).toContain(`Note: ${NO_CI_CHECKS_NOTE}`);
  });

  it('review-493 HIGH-1: no check on the head while the base commit ran CI parks no-workflows naming the base checks, never the no-CI merge', async () => {
    h.gh.gates = [{ checks: [], runs: [] }];
    h.gh.api = baseChecks(['Build', 'Test']);
    const out = await run([commitFile('a.ts'), review('approve')], { gateConfig: config([]) }).done;
    expect(out.gate?.name, out.message).toBe('no-workflows');
    expect(out.gate?.reason).toContain('the base commit ran CI (Build, Test) but nothing has reported for this head: Actions may be disabled, delayed, or the push did not trigger workflows');
    expect(out.message).not.toContain(NO_CI_CHECKS_NOTE);
    expect(out.message.match(/omg factory run /g)).toHaveLength(1);
    expect(readShipState(h.root, PR)!.phase).toBe('gates');
  });

  it('no names: every reported check counts; a green read is accepted after the settle window', async () => {
    h.gh.gates = [greenGates()];
    const out = await run([commitFile('a.ts'), review('approve')], { gateConfig: config([]) }).done;
    expect(out.gate?.name, out.message).toBe('merge');
    expect(out.gate?.reason).not.toContain(NO_CI_CHECKS_NOTE);
    expect(ISSUE).toBeGreaterThan(0);
  });
});
