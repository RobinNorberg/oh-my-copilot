import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeV2Mocks = vi.hoisted(() => ({
  isRuntimeV2Enabled: vi.fn(() => true),
  startTeamV2: vi.fn(),
  monitorTeamV2: vi.fn(),
  findActiveTeamsV2: vi.fn(async () => []),
}));

vi.mock('../../../team/runtime-v2.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../team/runtime-v2.js')>();
  return { ...actual, ...runtimeV2Mocks };
});

// `omg team` start path -> applyBudgetGovernor -> governTeamFanout (src/budget).
describe('omg team start under budget.mode "enforce"', () => {
  const originalCwd = process.cwd();
  let root: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omg-team-budget-'));
    vi.stubEnv('OMC_STATE_DIR', join(root, 'state'));
    vi.stubEnv('APPDATA', join(root, 'appdata'));
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'appdata'));
    vi.stubEnv('OMC_BUDGET_GOVERNOR', '');
    mkdirSync(join(root, '.copilot'), { recursive: true });
    writeFileSync(join(root, '.copilot', 'omg.jsonc'), JSON.stringify({ budget: { mode: 'enforce', perTeamLimit: 1 } }));
    process.chdir(root);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    process.exitCode = 0;
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses a mixed-provider launch over budget without starting any worker', async () => {
    const { teamCommand } = await import('../team.js');
    await teamCommand(['2:copilot,1:claude', 'fix the bug']);
    expect(runtimeV2Mocks.startTeamV2).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.flat().join('\n')).toMatch(/projected \d+ AI credits \(2 copilot worker\(s\) x \d+ credit cap\) exceeds budget\.perTeamLimit 1; team launch refused/);
  });
});
