import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ledgerPath, recordUsage } from '../../../budget/ledger.js';
const runtimeV2Mocks = vi.hoisted(() => ({
    isRuntimeV2Enabled: vi.fn(() => true),
    startTeamV2: vi.fn(async () => { throw new Error('launch captured'); }),
    monitorTeamV2: vi.fn(),
    findActiveTeamsV2: vi.fn(async () => []),
}));
vi.mock('../../../team/runtime-v2.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, ...runtimeV2Mocks };
});
// Budgets are reported, never enforced: `omg team` starts every worker whatever the ledger says.
describe('omg team start over budget', () => {
    const originalCwd = process.cwd();
    let root;
    let errorSpy;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'omg-team-budget-'));
        vi.stubEnv('OMC_STATE_DIR', join(root, 'state'));
        vi.stubEnv('APPDATA', join(root, 'appdata'));
        vi.stubEnv('XDG_CONFIG_HOME', join(root, 'appdata'));
        vi.stubEnv('OMC_BUDGET_GOVERNOR', '');
        mkdirSync(join(root, '.copilot'), { recursive: true });
        // Every retired enforcement key, far below what the ledger already holds.
        writeFileSync(join(root, '.copilot', 'omg.jsonc'), JSON.stringify({ budget: { mode: 'enforce', unit: 'premiumRequests', softLimit: 1, hardLimit: 1, perTeamLimit: 1 } }));
        recordUsage(ledgerPath(root), 's1', { premiumRequests: 500, credits: 500, source: 'measured', detail: 'test', updatedAt: new Date().toISOString() });
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
    it('starts the full worker count without a clamp or refusal', async () => {
        const { teamCommand } = await import('../team.js');
        await teamCommand(['4:copilot', 'fix the bug']);
        expect(runtimeV2Mocks.startTeamV2).toHaveBeenCalledTimes(1);
        expect(runtimeV2Mocks.startTeamV2).toHaveBeenCalledWith(expect.objectContaining({ workerCount: 4, agentTypes: ['copilot', 'copilot', 'copilot', 'copilot'] }));
        const stderr = errorSpy.mock.calls.flat().join('\n');
        expect(stderr).not.toMatch(/clamped|refused|projected/);
    });
    it('accepts --budget-override as a no-op that warns once', async () => {
        const { teamCommand } = await import('../team.js');
        await teamCommand(['2:copilot,1:claude', '--budget-override', 'fix the bug']);
        expect(runtimeV2Mocks.startTeamV2).toHaveBeenCalledWith(expect.objectContaining({ workerCount: 3, agentTypes: ['copilot', 'copilot', 'claude'] }));
        const warnings = errorSpy.mock.calls.flat().filter((m) => String(m).includes('--budget-override'));
        expect(warnings).toEqual(['[omg team] --budget-override is deprecated and does nothing: omg team no longer clamps or refuses on budget (docs/MIGRATION.md).']);
    });
});
//# sourceMappingURL=team-budget-governor.test.js.map