import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SDK_LAUNCH_CONCURRENCY, isExplicitTaskRoleAssignment, resolveSdkTeamSettings, resolveTeamTransport, runBoundedLaunches, startTeamV2, } from '../runtime-v2.js';
describe('runBoundedLaunches', () => {
    const deferred = () => {
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        return { promise, resolve };
    };
    it('keeps at most `concurrency` launches in flight and records in job order', async () => {
        let inFlight = 0;
        let peak = 0;
        const gates = [deferred(), deferred(), deferred()];
        const recorded = [];
        const run = runBoundedLaunches([0, 1, 2], 2, async (job) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await gates[job].promise;
            inFlight--;
            return job;
        }, (outcome) => recorded.push(outcome));
        await new Promise((r) => setTimeout(r, 5));
        expect(inFlight).toBe(2);
        gates[1].resolve(); // job 1 finishes first; job 2 takes its slot
        await new Promise((r) => setTimeout(r, 5));
        expect(inFlight).toBe(2);
        gates[2].resolve();
        gates[0].resolve();
        expect((await run).errors).toEqual([]);
        expect(peak).toBe(2);
        expect(recorded).toEqual([0, 1, 2]);
    });
    it('serial mode records each outcome before the next launch starts', async () => {
        const order = [];
        await runBoundedLaunches(['a', 'b'], 1, async (job) => { order.push(`launch:${job}`); return job; }, (outcome) => order.push(`record:${outcome}`));
        expect(order).toEqual(['launch:a', 'record:a', 'launch:b', 'record:b']);
    });
    it('stops new launches after a throw but lets in-flight ones finish and be recorded', async () => {
        const started = [];
        const recorded = [];
        const slow = deferred();
        const run = runBoundedLaunches([0, 1, 2, 3], 2, async (job) => {
            started.push(job);
            if (job === 0)
                throw new Error('cleanup_unverified');
            await slow.promise;
            return job;
        }, (outcome) => recorded.push(outcome));
        await new Promise((r) => setTimeout(r, 5));
        slow.resolve();
        const { errors } = await run;
        expect(errors.map((e) => e.message)).toEqual(['cleanup_unverified']);
        expect(started).toEqual([0, 1]);
        expect(recorded).toEqual([1]);
    });
    it('treats a non-positive width as serial', async () => {
        const recorded = [];
        await runBoundedLaunches([1, 2], 0, async (job) => job, (o) => recorded.push(o));
        expect(recorded).toEqual([1, 2]);
    });
});
describe('team.sdk.launchConcurrency', () => {
    const previous = process.env.OMC_TEAM_SDK_LAUNCH_CONCURRENCY;
    afterEach(() => {
        if (previous === undefined)
            delete process.env.OMC_TEAM_SDK_LAUNCH_CONCURRENCY;
        else
            process.env.OMC_TEAM_SDK_LAUNCH_CONCURRENCY = previous;
    });
    const withConcurrency = (value) => ({ team: { sdk: { launchConcurrency: value } } });
    it('defaults, honours the config, and lets the env override it', () => {
        delete process.env.OMC_TEAM_SDK_LAUNCH_CONCURRENCY;
        expect(resolveSdkTeamSettings({}).launchConcurrency).toBe(DEFAULT_SDK_LAUNCH_CONCURRENCY);
        expect(resolveSdkTeamSettings(withConcurrency(1)).launchConcurrency).toBe(1);
        process.env.OMC_TEAM_SDK_LAUNCH_CONCURRENCY = '3';
        expect(resolveSdkTeamSettings(withConcurrency(1)).launchConcurrency).toBe(3);
    });
    it.each([[0], [-2], [1.5], ['2']])('rejects launchConcurrency=%s as a config error', (value) => {
        delete process.env.OMC_TEAM_SDK_LAUNCH_CONCURRENCY;
        expect(() => resolveSdkTeamSettings(withConcurrency(value))).toThrow(/^invalid_team_sdk_config:launchConcurrency/);
    });
});
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
describe('resolveTeamTransport', () => {
    const base = {
        requested: 'auto',
        host: 'copilot',
        autoMerge: false,
        agentTypes: ['copilot'],
        explicitContractRoles: [],
        sdkAvailable: async () => true,
    };
    it('passes an explicit transport through untouched', async () => {
        const sdkAvailable = vi.fn(async () => false);
        expect(await resolveTeamTransport({ ...base, requested: 'sdk', agentTypes: ['codex'], sdkAvailable }))
            .toEqual({ transport: 'sdk', requested: 'sdk' });
        expect(await resolveTeamTransport({ ...base, requested: 'pane' })).toEqual({ transport: 'pane', requested: 'pane' });
        expect(sdkAvailable).not.toHaveBeenCalled();
    });
    it('auto picks sdk under the Copilot host', async () => {
        expect(await resolveTeamTransport(base)).toEqual({ transport: 'sdk', requested: 'auto' });
    });
    it('auto picks pane under Claude Code without probing the sdk', async () => {
        const sdkAvailable = vi.fn(async () => true);
        expect(await resolveTeamTransport({ ...base, host: 'claude', sdkAvailable }))
            .toEqual({ transport: 'pane', requested: 'auto', fallbackReason: 'host_claude' });
        expect(sdkAvailable).not.toHaveBeenCalled();
    });
    it('auto picks pane with no host signal (a plain terminal)', async () => {
        const sdkAvailable = vi.fn(async () => true);
        expect(await resolveTeamTransport({ ...base, host: 'unknown', sdkAvailable }))
            .toEqual({ transport: 'pane', requested: 'auto', fallbackReason: 'host_unknown' });
        expect(sdkAvailable).not.toHaveBeenCalled();
    });
    it.each([
        [{ autoMerge: true }, 'auto_merge'],
        [{ agentTypes: ['copilot', 'codex', 'codex'] }, 'non_copilot_workers:codex'],
        [{ explicitContractRoles: ['critic', 'critic'] }, 'contract_roles:critic'],
        [{ sdkAvailable: async () => false }, 'copilot_sdk_not_installed'],
        [{ sdkAvailable: async () => { throw new Error('boom'); } }, 'copilot_sdk_not_installed'],
    ])('auto falls back to pane for %j', async (over, reason) => {
        expect(await resolveTeamTransport({ ...base, ...over })).toEqual({ transport: 'pane', requested: 'auto', fallbackReason: reason });
    });
});
describe('startTeamV2 transport auto', () => {
    let cwd;
    const saved = { PATH: process.env.PATH, Path: process.env.Path, COPILOT_CLI: process.env.COPILOT_CLI };
    afterEach(() => {
        if (cwd)
            rmSync(cwd, { recursive: true, force: true });
        cwd = undefined;
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        }
    });
    // An empty PATH makes the binary preflight fail before any side effect, so
    // these tests observe only the transport decision.
    const startWithoutBinaries = async (overrides) => {
        cwd = mkdtempSync(join(tmpdir(), 'sdk-team-auto-'));
        process.env.COPILOT_CLI = '1';
        process.env.PATH = cwd;
        if (process.env.Path !== undefined)
            process.env.Path = cwd;
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            const error = await startTeamV2({
                teamName: 'sdk-auto',
                workerCount: 1,
                agentTypes: ['copilot'],
                tasks: [{ subject: 'Critique the plan', description: 'critique', role: 'critic' }],
                cwd,
                defaultTransport: 'auto',
                pluginConfig: {},
                ...overrides,
            }).catch((e) => e);
            return { error: error, stderr: stderrSpy.mock.calls.map((args) => String(args[0])).join('') };
        }
        finally {
            stderrSpy.mockRestore();
        }
    };
    it('falls back to pane instead of rejecting an explicit reviewer role', async () => {
        const { error, stderr } = await startWithoutBinaries({ sdkAvailable: async () => true });
        expect(error.message).toMatch(/^cli_binary_preflight_failed:/);
        expect(stderr).toMatch(/transport auto: using pane workers, not sdk \(contract_roles:critic\)/);
        expect(existsSync(join(cwd, '.omg', 'state', 'team', 'sdk-auto'))).toBe(false);
    });
    it('chooses sdk for a plain copilot team and applies the sdk role rules', async () => {
        const sdkAvailable = vi.fn(async () => true);
        const { stderr } = await startWithoutBinaries({
            sdkAvailable,
            tasks: [{ subject: 'fix the failing tests', description: 'fix the failing tests' }],
        });
        expect(sdkAvailable).toHaveBeenCalledTimes(1);
        expect(stderr).not.toMatch(/transport auto: using pane/);
        expect(stderr).toMatch(/sdk transport: inferred role "test-engineer" for worker worker-1/);
    });
    it('lets team.transport override the default', async () => {
        const sdkAvailable = vi.fn(async () => true);
        const { stderr } = await startWithoutBinaries({
            sdkAvailable,
            pluginConfig: { team: { transport: 'pane' } },
            tasks: [{ subject: 'fix the failing tests', description: 'fix the failing tests' }],
        });
        expect(sdkAvailable).not.toHaveBeenCalled();
        expect(stderr).not.toMatch(/sdk transport: inferred role/);
    });
    it('keeps the historical pane default for programmatic callers', async () => {
        const sdkAvailable = vi.fn(async () => true);
        await startWithoutBinaries({ sdkAvailable, defaultTransport: undefined });
        expect(sdkAvailable).not.toHaveBeenCalled();
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