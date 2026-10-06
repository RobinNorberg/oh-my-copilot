import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isExplicitTaskRoleAssignment, resolveSdkTeamSettings, startTeamV2 } from '../runtime-v2.js';
describe('team.sdk settings', () => {
    const previous = process.env.OMC_TEAM_SDK_MAX_CREDITS;
    afterEach(() => {
        if (previous === undefined)
            delete process.env.OMC_TEAM_SDK_MAX_CREDITS;
        else
            process.env.OMC_TEAM_SDK_MAX_CREDITS = previous;
    });
    const withCap = (value) => ({ team: { sdk: { maxCreditsPerWorker: value } } });
    it.each([['abc'], [0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY], [null]])('rejects maxCreditsPerWorker=%s as a config error', (value) => {
        delete process.env.OMC_TEAM_SDK_MAX_CREDITS;
        expect(() => resolveSdkTeamSettings(withCap(value))).toThrow(/^invalid_team_sdk_config:maxCreditsPerWorker/);
    });
    it('accepts a positive cap below the runtime floor (the host enforces it; the runtime floors its own flag)', () => {
        delete process.env.OMC_TEAM_SDK_MAX_CREDITS;
        expect(resolveSdkTeamSettings(withCap(2.5)).maxCreditsPerWorker).toBe(2.5);
        expect(resolveSdkTeamSettings({}).maxCreditsPerWorker).toBe(10);
    });
    it('lets a valid env value override the config cap', () => {
        process.env.OMC_TEAM_SDK_MAX_CREDITS = '7';
        expect(resolveSdkTeamSettings(withCap(3)).maxCreditsPerWorker).toBe(7);
    });
});
describe('startTeamV2 --transport sdk guards', () => {
    let cwd;
    afterEach(() => {
        if (cwd)
            rmSync(cwd, { recursive: true, force: true });
        cwd = undefined;
    });
    it('rejects an explicitly assigned reviewer-contract role before any side effect', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'sdk-team-contract-guard-'));
        const pluginConfig = { team: { roleRouting: { critic: { provider: 'copilot' } } } };
        await expect(startTeamV2({
            teamName: 'sdk-guard',
            workerCount: 1,
            agentTypes: ['copilot'],
            tasks: [{ subject: 'Critique the plan', description: 'critique', role: 'critic' }],
            cwd,
            transport: 'sdk',
            pluginConfig,
        })).rejects.toThrow(/^sdk_transport_unsupported:contract_roles:critic /);
        expect(existsSync(join(cwd, '.omg', 'state', 'team', 'sdk-guard'))).toBe(false);
    });
    it('drops a contract role only inferred from task text instead of rejecting the team start', async () => {
        cwd = mkdtempSync(join(tmpdir(), 'sdk-team-contract-guard-'));
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            // No `role` on the task and no roleRouting config for test-engineer: the
            // "fix the failing tests" subject is inferred as test-engineer by
            // routeTaskToRole, purely from task text, never assigned by the caller.
            const err = await startTeamV2({
                teamName: 'sdk-guard-inferred',
                workerCount: 1,
                agentTypes: ['copilot'],
                tasks: [{ subject: 'fix the failing tests', description: 'fix the failing tests' }],
                cwd,
                transport: 'sdk',
            }).catch((e) => e);
            // The contract-role guard no longer fires for an inferred role. Whatever
            // happens next (e.g. this host has no `copilot` binary on PATH) is an
            // unrelated environment fact, not the guard this test targets.
            expect(err).toBeInstanceOf(Error);
            expect(err.message).not.toMatch(/^sdk_transport_unsupported:contract_roles/);
            // The dropped-role note was logged, proving the role was actually
            // cleared before startup continued (and so no verdict contract — see
            // shouldInjectContract/renderCliWorkerOutputContract — is ever built
            // into this worker's prompt).
            const logged = stderrSpy.mock.calls.map((args) => String(args[0])).join('');
            expect(logged).toMatch(/sdk transport: inferred role "test-engineer" for worker worker-1/);
        }
        finally {
            stderrSpy.mockRestore();
        }
    });
});
describe('isExplicitTaskRoleAssignment', () => {
    it('is explicit when the task spec sets role directly, regardless of config', () => {
        expect(isExplicitTaskRoleAssignment({ role: 'critic' }, undefined, 'critic')).toBe(true);
    });
    it('is explicit when team.roleRouting configures the role, even with no task.role', () => {
        const config = { 'test-engineer': { provider: 'copilot' } };
        expect(isExplicitTaskRoleAssignment({}, config, 'test-engineer')).toBe(true);
    });
    it('is not explicit when the role is neither on the task nor configured', () => {
        expect(isExplicitTaskRoleAssignment({}, undefined, 'test-engineer')).toBe(false);
        const config = { critic: { provider: 'copilot' } };
        expect(isExplicitTaskRoleAssignment({}, config, 'test-engineer')).toBe(false);
    });
});
//# sourceMappingURL=sdk-transport.runtime.test.js.map