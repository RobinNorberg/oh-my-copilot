import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const runCjs = require('../../scripts/run.cjs');

interface StdinLib {
  HOOK_INNER_BUDGET_ENV: string;
  HOOK_INNER_BUDGET_START_ENV: string;
  HOOK_STDIN_TIMEOUT_MS: number;
  HOOK_STDIN_MARGIN_MS: number;
  HOOK_STDIN_MIN_WAIT_MS: number;
  hookStdinTimeoutMs(
    capMs?: number,
    fallbackMs?: number,
    env?: Record<string, string | undefined>,
    nowMs?: number,
  ): number;
}

const STDIN_LIB_PATH = '../../scripts/lib/stdin.mjs';
const originalPlatform = process.platform;

// stdin.mjs picks its margin from process.platform at import, so load a fresh
// copy with the platform under test.
async function stdinLibFor(platform: NodeJS.Platform): Promise<StdinLib> {
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    vi.resetModules();
    return (await import(STDIN_LIB_PATH)) as StdinLib;
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  }
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.resetModules();
});

describe('hook stdin wait vs run.cjs inner budget', () => {
  it('names the same env variables on both sides', async () => {
    const lib = await stdinLibFor(originalPlatform);
    expect(runCjs.HOOK_INNER_BUDGET_ENV).toBe('OMC_HOOK_INNER_BUDGET_MS');
    expect(runCjs.HOOK_INNER_BUDGET_START_ENV).toBe('OMC_HOOK_INNER_BUDGET_START_MS');
    expect(lib.HOOK_INNER_BUDGET_ENV).toBe(runCjs.HOOK_INNER_BUDGET_ENV);
    expect(lib.HOOK_INNER_BUDGET_START_ENV).toBe(runCjs.HOOK_INNER_BUDGET_START_ENV);
  });

  const cases: Array<{ platform: NodeJS.Platform; timeoutMs: number; event: string }> = [];
  for (const platform of ['win32', 'linux'] as NodeJS.Platform[]) {
    cases.push({ platform, timeoutMs: 5000, event: 'PreToolUse' });
    cases.push({ platform, timeoutMs: 3000, event: 'PostToolUse' });
  }

  it.each(cases)(
    'derived wait plus margin fits the inner budget ($platform, $timeoutMs ms $event)',
    async ({ platform, timeoutMs, event }) => {
      const lib = await stdinLibFor(platform);
      const budget = runCjs.resolveInnerTimeoutMs({ timeoutMs, event }, platform);
      const startedAt = Date.now();
      // The env run.cjs hands the hook, read as the hook starts.
      const env = runCjs.hookBudgetEnv(budget, startedAt);
      expect(env[lib.HOOK_INNER_BUDGET_ENV]).toBe(String(budget));
      // 5s hooks pass the platform constant as cap; 3s hooks use the default.
      const wait = timeoutMs === 5000
        ? lib.hookStdinTimeoutMs(lib.HOOK_STDIN_TIMEOUT_MS, lib.HOOK_STDIN_TIMEOUT_MS, env, startedAt)
        : lib.hookStdinTimeoutMs(undefined, undefined, env, startedAt);
      expect(wait).toBeGreaterThanOrEqual(lib.HOOK_STDIN_MIN_WAIT_MS);
      expect(wait + lib.HOOK_STDIN_MARGIN_MS).toBeLessThanOrEqual(budget);
    },
  );

  it('keeps the POSIX waits the hooks had before the budget was exported', async () => {
    const lib = await stdinLibFor('linux');
    const now = 50_000;
    const env = (timeoutMs: number, event: string) =>
      runCjs.hookBudgetEnv(runCjs.resolveInnerTimeoutMs({ timeoutMs, event }, 'linux'), now);
    expect(lib.hookStdinTimeoutMs(lib.HOOK_STDIN_TIMEOUT_MS, lib.HOOK_STDIN_TIMEOUT_MS, env(5000, 'PreToolUse'), now)).toBe(3000);
    expect(lib.hookStdinTimeoutMs(undefined, undefined, env(3000, 'PostToolUse'), now)).toBe(2000);
  });

  it('subtracts the start-up time already spent from the budget', async () => {
    const lib = await stdinLibFor('win32');
    const env = runCjs.hookBudgetEnv(3500, 10_000);
    // 3500 - 400 elapsed - 1500 margin = 1600, capped at 1500.
    expect(lib.hookStdinTimeoutMs(1500, 1500, env, 10_400)).toBe(1500);
    // 3500 - 1200 elapsed - 1500 margin = 800.
    expect(lib.hookStdinTimeoutMs(1500, 1500, env, 11_200)).toBe(800);
    // Past the point where any wait fits: the floor.
    expect(lib.hookStdinTimeoutMs(1500, 1500, env, 13_000)).toBe(lib.HOOK_STDIN_MIN_WAIT_MS);
    // A clock that went backwards counts as no time spent.
    expect(lib.hookStdinTimeoutMs(1500, 1500, env, 9_000)).toBe(1500);
    // No start exported: the budget alone.
    expect(lib.hookStdinTimeoutMs(5000, 5000, { [lib.HOOK_INNER_BUDGET_ENV]: '3500' }, 99_999)).toBe(2000);
  });

  it('falls back without a usable budget and floors a starved one', async () => {
    const lib = await stdinLibFor(originalPlatform);
    const key = lib.HOOK_INNER_BUDGET_ENV;
    expect(lib.hookStdinTimeoutMs(1500, 1500, {})).toBe(1500);
    expect(lib.hookStdinTimeoutMs(undefined, undefined, {})).toBe(2000);
    for (const bad of ['', 'abc', '0', '-5', '12.5']) {
      expect(lib.hookStdinTimeoutMs(2000, 777, { [key]: bad })).toBe(777);
    }
    expect(lib.hookStdinTimeoutMs(2000, 2000, { [key]: '1' })).toBe(lib.HOOK_STDIN_MIN_WAIT_MS);
    expect(lib.hookStdinTimeoutMs(2000, 2000, { [key]: '600000' })).toBe(2000);
  });

  it('exports the budget and its start to a generic child', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omc-stdin-budget-'));
    try {
      const probe = join(dir, 'probe.mjs');
      const out = join(dir, 'budget.json');
      writeFileSync(
        probe,
        "import { writeFileSync } from 'node:fs';\n" +
          'const env = process.env;\n' +
          'writeFileSync(process.argv[2], JSON.stringify([env.OMC_HOOK_INNER_BUDGET_MS, env.OMC_HOOK_INNER_BUDGET_START_MS]));\n',
      );
      const before = Date.now();
      const status = await runCjs.runGenericChild(probe, [out], 30000, { timeoutMs: 31000, event: 'PostToolUse' });
      expect(status).toBe(0);
      const [budget, start] = JSON.parse(readFileSync(out, 'utf8')) as [string, string];
      expect(budget).toBe('30000');
      expect(Number.isInteger(Number(start))).toBe(true);
      expect(Number(start)).toBeGreaterThanOrEqual(before - 1);
      expect(Number(start)).toBeLessThanOrEqual(Date.now());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);
});
