import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import * as processUtils from '../../platform/process-utils.js';
import { awaitWorkerLaunchAcknowledgement, awaitWorkerLaunchProviderStarted, buildWorkerLaunchBootstrapSpec, buildWindowsSupervisorInvocation, buildWindowsSupervisorSource, cleanupWorkerLaunchTransport, observeWorkerLaunchProvider, isWorkerLaunchAttemptAccepted, isWorkerLaunchProviderStarted, loadWorkerLaunchAttempt, loadCurrentWorkerLaunchAttempt, prepareWorkerLaunchAttempt, materializeWorkerLaunchTransport, runWorkerLaunchBootstrap, readAndConsumeWorkerLaunchDescriptor, retireWorkerLaunchAttempt, retireAndCleanupCurrentWorkerLaunchAttempt, terminateWorkerLaunchProvider, revokeWorkerLaunchAttempt, withWorkerLaunchAttemptFence, assertEnvPassthroughAllowed, buildProviderEnvironment, buildProviderSpawnInvocation, materializeProviderSpawnInvocation, quoteWindowsCreateProcessArgument, } from '../worker-launch-ack.js';
import { captureOwnedProcessGroup, getProcessStartIdentity, isProcessAlive, terminateOwnedProcessGroup, terminateOwnedProcessTree, } from '../../platform/process-utils.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { getWorkerEnv } from '../model-contract.js';
import { IS_WIN, posixOnly, requiresSymlinks, scaleTiming } from '../../__tests__/helpers/platform.js';
let cwd = '';
const disposableProviders = new Set();
// These waits poll for a condition produced by a spawned process, so they
// return as soon as it holds and the bound only matters on failure. A 2s bound
// was tight enough that a loaded CI runner could miss a legitimate
// acknowledgement, reddening unrelated pull requests.
const LAUNCH_WAIT_TIMEOUT_MS = 15_000;
let fixtureEnvCaptured = false;
let originalHome;
let originalUserProfile;
let originalStateDir;
function isolateFixtureRoot(root) {
    if (!fixtureEnvCaptured) {
        originalHome = process.env.HOME;
        originalUserProfile = process.env.USERPROFILE;
        originalStateDir = process.env.OMC_STATE_DIR;
        fixtureEnvCaptured = true;
    }
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    delete process.env.OMC_STATE_DIR;
}
async function createFixture(prefix) {
    const root = await mkdtemp(join(tmpdir(), prefix));
    isolateFixtureRoot(root);
    return root;
}
function restoreFixtureEnv() {
    if (!fixtureEnvCaptured)
        return;
    if (originalHome === undefined)
        delete process.env.HOME;
    else
        process.env.HOME = originalHome;
    if (originalUserProfile === undefined)
        delete process.env.USERPROFILE;
    else
        process.env.USERPROFILE = originalUserProfile;
    if (originalStateDir === undefined)
        delete process.env.OMC_STATE_DIR;
    else
        process.env.OMC_STATE_DIR = originalStateDir;
    fixtureEnvCaptured = false;
    originalHome = undefined;
    originalUserProfile = undefined;
    originalStateDir = undefined;
}
async function removeFixtureDir(dir) {
    for (let attempt = 0; attempt < 8; attempt++) {
        try {
            await rm(dir, { recursive: true, force: true });
            return;
        }
        catch (error) {
            const code = error.code;
            if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM')
                throw error;
            await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
        }
    }
    await rm(dir, { recursive: true, force: true });
}
afterEach(async () => {
    for (const child of [...disposableProviders])
        await stopDisposableProvider(child).catch(() => undefined);
    vi.unstubAllEnvs();
    restoreFixtureEnv();
    if (cwd)
        await removeFixtureDir(cwd);
    cwd = '';
});
async function attempt(provider = 'codex') {
    cwd = await createFixture('worker-launch-ack-');
    return prepareWorkerLaunchAttempt({
        cwd,
        teamName: 'launch-team',
        workerName: 'worker-1',
        instanceId: randomUUID(),
        paneId: '%2',
        provider,
        runtimeCliPath: '/runtime-cli.cjs',
    });
}
async function acceptFixtureAttempt(launchAttempt) {
    const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
    await writeFile(launchAttempt.ackPath, JSON.stringify({
        ...expected,
        kind: 'worker_launch_ack',
        written_at: new Date().toISOString(),
    }), 'utf8');
    await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
        timeoutMs: 500,
        pollIntervalMs: 5,
    })).resolves.toEqual({ ok: true });
    return expected;
}
async function writeBoundCompletionEvidence(launchAttempt, completionPath, options = {}) {
    const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
    const completionSpec = buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd);
    const processStartIdentity = await getProcessStartIdentity(process.pid);
    if (!processStartIdentity)
        throw new Error('worker_launch_test_process_identity_missing');
    await writeFile(launchAttempt.startedPath, JSON.stringify({
        ...expected,
        kind: 'worker_launch_provider_started',
        pid: process.pid,
        process_start_identity: processStartIdentity,
        supervisor_completion_path: completionPath,
        containment_nonce: completionSpec.containment_nonce,
        authority_digest: completionSpec.authority_digest,
        written_at: new Date().toISOString(),
    }), 'utf8');
    await writeFile(`${launchAttempt.startedPath}.completion-binding`, JSON.stringify({
        ...expected,
        kind: 'worker_launch_completion_binding',
        completion_path: completionPath,
        containment_nonce: completionSpec.containment_nonce,
        authority_digest: completionSpec.authority_digest,
        written_at: new Date().toISOString(),
    }), 'utf8');
    await writeFile(launchAttempt.transportOwnerPath, JSON.stringify({
        ...expected,
        kind: 'worker_launch_transport_owner',
        authority_digest: completionSpec.authority_digest,
    }), 'utf8');
    if (options.marker !== false) {
        await writeFile(completionPath, JSON.stringify({
            ...expected,
            kind: 'worker_launch_provider_completion',
            containment_nonce: completionSpec.containment_nonce,
            authority_digest: completionSpec.authority_digest,
            exit_code: 0,
            ...options.marker,
        }), 'utf8');
    }
}
async function spawnDisposableProvider() {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        detached: process.platform !== 'win32',
    });
    await new Promise((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', reject);
    });
    const pid = child.pid;
    if (!pid)
        throw new Error('disposable_provider_pid_missing');
    const processStartIdentity = await getProcessStartIdentity(pid);
    const ownedGroup = captureOwnedProcessGroup(pid);
    if (!processStartIdentity || (process.platform !== 'win32' && !ownedGroup)) {
        child.kill('SIGKILL');
        throw new Error('disposable_provider_identity_missing');
    }
    child.unref();
    disposableProviders.add(child);
    return {
        child,
        pid,
        processStartIdentity,
        processGroupId: ownedGroup?.processGroupId ?? 1,
    };
}
async function stopDisposableProvider(child) {
    try {
        if (child.exitCode === null && child.signalCode === null) {
            try {
                child.kill('SIGKILL');
            }
            catch { /* already exited */ }
        }
        await new Promise(resolve => {
            if (child.exitCode !== null || child.signalCode !== null) {
                resolve();
                return;
            }
            const timer = setTimeout(resolve, 500);
            timer.unref();
            child.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
    finally {
        disposableProviders.delete(child);
    }
}
describe('worker launch acknowledgement', () => {
    it('refuses a missing or invalid immutable instance id without generating a fallback', async () => {
        cwd = await createFixture('worker-launch-instance-id-');
        await expect(prepareWorkerLaunchAttempt({
            cwd,
            teamName: 'launch-team',
            workerName: 'worker-1',
            instanceId: undefined,
            paneId: '%2',
            provider: 'codex',
            runtimeCliPath: '/runtime-cli.cjs',
        })).rejects.toThrow('worker_launch_instance_id_invalid');
        await expect(prepareWorkerLaunchAttempt({
            cwd,
            teamName: 'launch-team',
            workerName: 'worker-1',
            instanceId: 'not-a-uuid',
            paneId: '%2',
            provider: 'codex',
            runtimeCliPath: '/runtime-cli.cjs',
        })).rejects.toThrow('worker_launch_instance_id_invalid');
    });
    it.each(['claude', 'copilot'])('builds a bootstrap spec for a %s worker identity', async (provider) => {
        cwd = await createFixture(`worker-launch-${provider}-`);
        const launchAttempt = await prepareWorkerLaunchAttempt({
            cwd,
            teamName: 'launch-team',
            workerName: 'worker-1',
            instanceId: randomUUID(),
            paneId: '%2',
            provider,
            runtimeCliPath: '/runtime-cli.cjs',
        });
        const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, [provider], cwd);
        expect(spec.provider).toBe(provider);
        expect(spec.provider_argv).toEqual([provider]);
        await expect(loadWorkerLaunchAttempt({
            cwd,
            teamName: 'launch-team',
            workerName: 'worker-1',
            instanceId: launchAttempt.instance_id,
            paneId: '%2',
            provider,
            attemptId: launchAttempt.attempt_id,
            runtimeCliPath: '/runtime-cli.cjs',
        })).resolves.toMatchObject({ provider, attempt_id: launchAttempt.attempt_id });
    });
    it('observes a live provider from an exact accepted launch receipt', async () => {
        const launchAttempt = await attempt();
        const expected = await acceptFixtureAttempt(launchAttempt);
        const processStartIdentity = await getProcessStartIdentity(process.pid);
        if (!processStartIdentity)
            throw new Error('worker_launch_test_process_identity_missing');
        await writeFile(launchAttempt.startedPath, JSON.stringify({
            ...expected,
            kind: 'worker_launch_provider_started',
            pid: process.pid,
            process_start_identity: processStartIdentity,
            written_at: new Date().toISOString(),
        }), 'utf8');
        await expect(observeWorkerLaunchProvider(launchAttempt)).resolves.toBe('alive');
    });
    it('returns unknown when the accepted launch loses its acknowledgement receipt', async () => {
        const launchAttempt = await attempt();
        const expected = await acceptFixtureAttempt(launchAttempt);
        const processStartIdentity = await getProcessStartIdentity(process.pid);
        if (!processStartIdentity)
            throw new Error('worker_launch_test_process_identity_missing');
        await rm(launchAttempt.ackPath);
        await writeFile(launchAttempt.startedPath, JSON.stringify({
            ...expected,
            kind: 'worker_launch_provider_started',
            pid: process.pid,
            process_start_identity: processStartIdentity,
            written_at: new Date().toISOString(),
        }), 'utf8');
        await expect(observeWorkerLaunchProvider(launchAttempt)).resolves.toBe('unknown');
    });
    it('observes a dead provider after its exact process identity exits', async () => {
        const launchAttempt = await attempt();
        const expected = await acceptFixtureAttempt(launchAttempt);
        const disposable = await spawnDisposableProvider();
        const { child, pid, processStartIdentity } = disposable;
        await stopDisposableProvider(child);
        await writeFile(launchAttempt.startedPath, JSON.stringify({
            ...expected,
            kind: 'worker_launch_provider_started',
            pid,
            process_start_identity: processStartIdentity,
            written_at: new Date().toISOString(),
        }), 'utf8');
        await expect(observeWorkerLaunchProvider(launchAttempt)).resolves.toBe('dead');
    });
    it('returns unknown when process identity observation is inconclusive', async () => {
        vi.resetModules();
        const dynamicProcessUtils = await import('../../platform/process-utils.js');
        const identitySpy = vi.spyOn(dynamicProcessUtils, 'isProcessIdentityLive')
            .mockResolvedValue('unknown');
        try {
            const workerLaunch = await import('../worker-launch-ack.js');
            const launchAttempt = await attempt();
            const expected = await acceptFixtureAttempt(launchAttempt);
            const processStartIdentity = await getProcessStartIdentity(process.pid);
            if (!processStartIdentity)
                throw new Error('worker_launch_test_process_identity_missing');
            await writeFile(launchAttempt.startedPath, JSON.stringify({
                ...expected,
                kind: 'worker_launch_provider_started',
                pid: process.pid,
                process_start_identity: processStartIdentity,
                written_at: new Date().toISOString(),
            }), 'utf8');
            await expect(workerLaunch.observeWorkerLaunchProvider(launchAttempt)).resolves.toBe('unknown');
        }
        finally {
            identitySpy.mockRestore();
            vi.resetModules();
        }
    });
    it('returns unknown for a live process with a mismatched start identity', async () => {
        const launchAttempt = await attempt();
        const expected = await acceptFixtureAttempt(launchAttempt);
        const processStartIdentity = await getProcessStartIdentity(process.pid);
        if (!processStartIdentity)
            throw new Error('worker_launch_test_process_identity_missing');
        const mismatchedIdentity = processStartIdentity.startsWith('ticks:')
            ? `ticks:${BigInt(processStartIdentity.slice('ticks:'.length)) + 1n}`
            : String(BigInt(processStartIdentity) + 1n);
        await writeFile(launchAttempt.startedPath, JSON.stringify({
            ...expected,
            kind: 'worker_launch_provider_started',
            pid: process.pid,
            process_start_identity: mismatchedIdentity,
            written_at: new Date().toISOString(),
        }), 'utf8');
        await expect(observeWorkerLaunchProvider(launchAttempt)).resolves.toBe('unknown');
    });
    it.runIf(process.platform !== 'win32')('observes a reaped provider as dead without requiring tree cleanup proof', async () => {
        const launchAttempt = await attempt();
        const expected = await acceptFixtureAttempt(launchAttempt);
        const processStartIdentity = await getProcessStartIdentity(process.pid);
        const processGroup = captureOwnedProcessGroup(process.pid);
        if (!processStartIdentity || !processGroup)
            throw new Error('worker_launch_test_process_identity_missing');
        const started = {
            ...expected,
            kind: 'worker_launch_provider_started',
            pid: process.pid,
            process_start_identity: processStartIdentity,
            process_group_id: processGroup.processGroupId,
            written_at: new Date().toISOString(),
        };
        await writeFile(launchAttempt.startedPath, JSON.stringify(started), 'utf8');
        await writeFile(`${launchAttempt.startedPath}.terminal`, JSON.stringify({
            ...started,
            kind: 'worker_launch_provider_terminal',
            outcome: 'cleanup_unverified',
            cleanup_verified: false,
            child_reaped: true,
            written_at: new Date().toISOString(),
        }), 'utf8');
        await expect(observeWorkerLaunchProvider(launchAttempt)).resolves.toBe('dead');
    });
    it('returns unknown while an exact retirement receipt is still awaiting cleanup', async () => {
        const launchAttempt = await attempt();
        const expected = await acceptFixtureAttempt(launchAttempt);
        const processStartIdentity = await getProcessStartIdentity(process.pid);
        if (!processStartIdentity)
            throw new Error('worker_launch_test_process_identity_missing');
        await writeFile(launchAttempt.startedPath, JSON.stringify({
            ...expected,
            kind: 'worker_launch_provider_started',
            pid: process.pid,
            process_start_identity: processStartIdentity,
            written_at: new Date().toISOString(),
        }), 'utf8');
        await writeFile(`${launchAttempt.decisionPath}.retired`, JSON.stringify({
            ...expected,
            kind: 'worker_launch_retired',
            reason: 'test_cleanup_pending',
            written_at: new Date().toISOString(),
        }), 'utf8');
        await expect(observeWorkerLaunchProvider(launchAttempt)).resolves.toBe('unknown');
    });
    it('observes a retired attempt as dead from its exact cleanup-complete receipt', async () => {
        const launchAttempt = await attempt();
        const expected = await acceptFixtureAttempt(launchAttempt);
        await rm(launchAttempt.currentPath);
        await writeFile(`${launchAttempt.decisionPath}.retired`, JSON.stringify({
            ...expected,
            kind: 'worker_launch_retired',
            reason: 'test_cleanup',
            written_at: new Date().toISOString(),
        }), 'utf8');
        await writeFile(`${launchAttempt.decisionPath}.retired.cleanup-complete`, JSON.stringify({
            ...expected,
            kind: 'worker_launch_cleanup_complete',
            reason: 'test_cleanup',
            written_at: new Date().toISOString(),
        }), 'utf8');
        await expect(observeWorkerLaunchProvider(launchAttempt)).resolves.toBe('dead');
    });
    it('accepts only the exact child-written acknowledgement before running the provider', async () => {
        const launchAttempt = await attempt();
        const stopPath = join(cwd, 'provider-stop');
        const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', `const fs=require('node:fs');setInterval(()=>{if(fs.existsSync(${JSON.stringify(stopPath)}))process.exit(0)},10)`], cwd);
        const bootstrap = runWorkerLaunchBootstrap(spec);
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
            timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: true });
        await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
            timeoutMs: 10_000,
            pollIntervalMs: 5,
        })).resolves.toBe(true);
        await writeFile(stopPath, 'stop', 'utf8');
        await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
        await expect(isWorkerLaunchAttemptAccepted(launchAttempt)).resolves.toBe(true);
        const decision = JSON.parse(await readFile(launchAttempt.decisionPath, 'utf8'));
        expect(decision).toMatchObject({
            kind: 'worker_launch_decision',
            decision: 'accepted',
            attempt_id: launchAttempt.attempt_id,
            nonce: launchAttempt.nonce,
            pane_id: '%2',
        });
    });
    it.each([
        ['zero pid', 0, 'identity'],
        ['negative pid', -1, 'identity'],
        ['empty identity', process.pid, ''],
        ['stale identity', process.pid, 'stale:identity'],
    ])('rejects %s provider-start handoff evidence', async (_case, pid, processStartIdentity) => {
        const launchAttempt = await attempt();
        await writeFile(launchAttempt.ackPath, JSON.stringify({
            schema_version: launchAttempt.schema_version,
            attempt_id: launchAttempt.attempt_id,
            nonce: launchAttempt.nonce,
            instance_id: launchAttempt.instance_id,
            team_name: launchAttempt.team_name,
            worker_name: launchAttempt.worker_name,
            pane_id: launchAttempt.pane_id,
            provider: launchAttempt.provider,
            created_at: launchAttempt.created_at,
            kind: 'worker_launch_ack',
            written_at: new Date().toISOString(),
        }), 'utf8');
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
            timeoutMs: 500,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: true });
        await writeFile(launchAttempt.startedPath, JSON.stringify({
            schema_version: launchAttempt.schema_version,
            attempt_id: launchAttempt.attempt_id,
            nonce: launchAttempt.nonce,
            instance_id: launchAttempt.instance_id,
            team_name: launchAttempt.team_name,
            worker_name: launchAttempt.worker_name,
            pane_id: launchAttempt.pane_id,
            provider: launchAttempt.provider,
            created_at: launchAttempt.created_at,
            kind: 'worker_launch_provider_started',
            pid,
            process_start_identity: processStartIdentity,
            written_at: new Date().toISOString(),
        }), 'utf8');
        await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
            timeoutMs: 50,
            pollIntervalMs: 5,
        })).resolves.toBe(false);
    });
    it('rejects supervised provider-start evidence after its completion marker exists', async () => {
        const launchAttempt = await attempt();
        const identity = await getProcessStartIdentity(process.pid);
        const completionPath = join(cwd, 'provider-exit.txt');
        const completionSpec = buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd);
        const base = {
            schema_version: launchAttempt.schema_version, attempt_id: launchAttempt.attempt_id, nonce: launchAttempt.nonce,
            instance_id: launchAttempt.instance_id,
            team_name: launchAttempt.team_name, worker_name: launchAttempt.worker_name, pane_id: launchAttempt.pane_id,
            provider: launchAttempt.provider, created_at: launchAttempt.created_at,
        };
        await writeFile(launchAttempt.ackPath, JSON.stringify({ ...base, kind: 'worker_launch_ack', written_at: new Date().toISOString() }), 'utf8');
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: 500, pollIntervalMs: 5 })).resolves.toEqual({ ok: true });
        await writeFile(completionPath, JSON.stringify({
            ...base,
            kind: 'worker_launch_provider_completion',
            containment_nonce: completionSpec.containment_nonce,
            authority_digest: completionSpec.authority_digest,
            exit_code: 0,
        }), 'utf8');
        await writeFile(launchAttempt.startedPath, JSON.stringify({ ...base, kind: 'worker_launch_provider_started',
            pid: process.pid, process_start_identity: identity, supervisor_completion_path: completionPath,
            containment_nonce: completionSpec.containment_nonce,
            authority_digest: completionSpec.authority_digest,
            written_at: new Date().toISOString() }), 'utf8');
        await writeFile(`${launchAttempt.startedPath}.completion-binding`, JSON.stringify({
            ...base,
            kind: 'worker_launch_completion_binding',
            completion_path: completionPath,
            containment_nonce: completionSpec.containment_nonce,
            authority_digest: completionSpec.authority_digest,
            written_at: new Date().toISOString(),
        }), 'utf8');
        await writeFile(launchAttempt.transportOwnerPath, JSON.stringify({
            ...base,
            kind: 'worker_launch_transport_owner',
            authority_digest: completionSpec.authority_digest,
        }), 'utf8');
        await expect(awaitWorkerLaunchProviderStarted(launchAttempt, { timeoutMs: 50, pollIntervalMs: 5 })).resolves.toBe(false);
        await expect(observeWorkerLaunchProvider(launchAttempt)).resolves.toBe('dead');
        await writeFile(completionPath, '0\n', 'utf8');
        await expect(observeWorkerLaunchProvider(launchAttempt)).resolves.toBe('unknown');
        await writeFile(completionPath, 'not-an-exit-code\n', 'utf8');
        await expect(observeWorkerLaunchProvider(launchAttempt)).resolves.toBe('unknown');
    });
    describe('stops waiting for provider start once the provider has exited', () => {
        const START_WAIT_MS = 10_000;
        async function writeStarted(launchAttempt, pid, processStartIdentity) {
            const expected = await acceptFixtureAttempt(launchAttempt);
            await writeFile(launchAttempt.startedPath, JSON.stringify({
                ...expected,
                kind: 'worker_launch_provider_started',
                pid,
                process_start_identity: processStartIdentity,
                written_at: new Date().toISOString(),
            }), 'utf8');
        }
        async function timedStartWait(launchAttempt) {
            const t0 = Date.now();
            const started = await awaitWorkerLaunchProviderStarted(launchAttempt, { timeoutMs: START_WAIT_MS, pollIntervalMs: 5 });
            return { started, elapsedMs: Date.now() - t0 };
        }
        it('returns false at once when a terminal record follows valid start evidence', async () => {
            const launchAttempt = await attempt();
            const identity = await getProcessStartIdentity(process.pid);
            await writeStarted(launchAttempt, process.pid, identity);
            await writeFile(`${launchAttempt.startedPath}.terminal`, '{}', 'utf8');
            const { started, elapsedMs } = await timedStartWait(launchAttempt);
            expect(started).toBe(false);
            expect(elapsedMs).toBeLessThan(2_000);
        });
        it('returns false at once when the supervisor completion marker exists', async () => {
            const launchAttempt = await attempt();
            await acceptFixtureAttempt(launchAttempt);
            await writeBoundCompletionEvidence(launchAttempt, join(cwd, 'provider-exit.json'));
            const { started, elapsedMs } = await timedStartWait(launchAttempt);
            expect(started).toBe(false);
            expect(elapsedMs).toBeLessThan(2_000);
        });
        it('returns false at once when the started pid is dead', async () => {
            const launchAttempt = await attempt();
            const provider = await spawnDisposableProvider();
            await writeStarted(launchAttempt, provider.pid, provider.processStartIdentity);
            await stopDisposableProvider(provider.child);
            await vi.waitFor(() => expect(isProcessAlive(provider.pid)).toBe(false), { timeout: 5_000, interval: 10 });
            const { started, elapsedMs } = await timedStartWait(launchAttempt);
            expect(started).toBe(false);
            expect(elapsedMs).toBeLessThan(2_000);
        });
        it.each(['mismatch', 'unknown'])('keeps waiting through a transient %s liveness read', async (transient) => {
            const launchAttempt = await attempt();
            const identity = await getProcessStartIdentity(process.pid);
            await writeStarted(launchAttempt, process.pid, identity);
            const liveness = vi.spyOn(processUtils, 'isProcessIdentityLive').mockResolvedValueOnce(transient);
            try {
                const { started } = await timedStartWait(launchAttempt);
                expect(started).toBe(true);
                expect(liveness.mock.calls.length).toBeGreaterThanOrEqual(2);
            }
            finally {
                liveness.mockRestore();
            }
        });
    });
    it('rejects a completion marker from another launch even when the path is substituted', async () => {
        const launchAttempt = await attempt();
        await acceptFixtureAttempt(launchAttempt);
        const foreignMarker = join(cwd, 'foreign-provider-exit.json');
        await writeBoundCompletionEvidence(launchAttempt, foreignMarker, {
            marker: { attempt_id: randomUUID() },
        });
        await expect(observeWorkerLaunchProvider(launchAttempt)).resolves.toBe('unknown');
    });
    it.runIf(process.platform !== 'win32')('rejects completion evidence through a symlinked parent', async () => {
        const launchAttempt = await attempt();
        await acceptFixtureAttempt(launchAttempt);
        const realParent = join(cwd, 'real-completion-parent');
        const linkedParent = join(cwd, 'linked-completion-parent');
        await mkdir(realParent, { recursive: true });
        await symlink(realParent, linkedParent);
        const completionPath = join(linkedParent, 'provider-exit.json');
        await writeBoundCompletionEvidence(launchAttempt, completionPath);
        await expect(observeWorkerLaunchProvider(launchAttempt)).resolves.toBe('unknown');
    });
    it.runIf(process.platform !== 'win32')('rejects a writerless FIFO completion path without blocking', async () => {
        const launchAttempt = await attempt();
        await acceptFixtureAttempt(launchAttempt);
        const completionPath = join(cwd, 'provider-exit.fifo');
        execFileSync('mkfifo', [completionPath]);
        await writeBoundCompletionEvidence(launchAttempt, completionPath, { marker: false });
        const result = await Promise.race([
            observeWorkerLaunchProvider(launchAttempt),
            new Promise(resolve => {
                const timer = setTimeout(() => resolve('timeout'), 500);
                timer.unref();
            }),
        ]);
        expect(result).toBe('unknown');
    });
    it('rejects a provider that exits after publishing start evidence but before handoff', async () => {
        const launchAttempt = await attempt();
        const stopPath = join(cwd, 'exit-after-start');
        const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', `const fs=require('node:fs');setInterval(()=>{if(fs.existsSync(${JSON.stringify(stopPath)}))process.exit(0)},10)`], cwd));
        try {
            await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
                timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
                pollIntervalMs: 5,
            })).resolves.toEqual({ ok: true });
            // Start publication waits on the win32 supervisor's ready frame, which
            // compiles its native helpers first; use the launch bound, not 2s.
            await vi.waitFor(async () => {
                await expect(isWorkerLaunchProviderStarted(launchAttempt)).resolves.toBe(true);
            }, { timeout: LAUNCH_WAIT_TIMEOUT_MS, interval: 5 });
            await writeFile(stopPath, 'exit', 'utf8');
            await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
            await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
                timeoutMs: 50,
                pollIntervalMs: 5,
            })).resolves.toBe(false);
        }
        finally {
            await writeFile(stopPath, 'exit', 'utf8');
            await terminateWorkerLaunchProvider(launchAttempt, 2_000);
            await bootstrap;
        }
    });
    it.skipIf(posixOnly('provider containment proof needs POSIX process groups; win32 reports provider_cleanup_unverified'))('kills provider descendants when the provider exits after start publication', async () => {
        const launchAttempt = await attempt();
        const childPidPath = join(cwd, 'early-exit-child-pid');
        const providerReadyPath = join(cwd, 'early-exit-provider-ready');
        const providerStopPath = join(cwd, 'early-exit-provider-stop');
        const providerScript = [
            "const fs=require('node:fs')",
            "const cp=require('node:child_process')",
            "const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref()",
            `child.once('spawn',()=>fs.writeFileSync(${JSON.stringify(childPidPath)},JSON.stringify({parent:process.pid,child:child.pid})))`,
            `child.once('spawn',()=>fs.writeFileSync(${JSON.stringify(providerReadyPath)},'ready'))`,
            `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(providerStopPath)})){clearInterval(timer);process.exit(0)}},5)`,
        ].join(';');
        let bootstrap;
        try {
            bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', providerScript], cwd, { releaseAfterSpawn: true }));
            await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
                timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
                pollIntervalMs: 5,
            })).resolves.toEqual({ ok: true });
            await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
                timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
                pollIntervalMs: 5,
            })).resolves.toBe(true);
            await vi.waitFor(async () => {
                await expect(readFile(providerReadyPath, 'utf8')).resolves.toBe('ready');
            }, { timeout: 2_000, interval: 5 });
            const pids = JSON.parse(await readFile(childPidPath, 'utf8'));
            expect(pids.parent).toBeGreaterThan(0);
            expect(pids.child).toBeGreaterThan(0);
            await writeFile(providerStopPath, 'stop', 'utf8');
            await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
            await vi.waitFor(() => {
                expect(isProcessAlive(pids.parent)).toBe(false);
                expect(isProcessAlive(pids.child)).toBe(false);
            }, { timeout: 2_000, interval: 20 });
            const terminal = JSON.parse(await readFile(`${launchAttempt.startedPath}.terminal`, 'utf8'));
            expect(terminal).toMatchObject({
                kind: 'worker_launch_provider_terminal',
                outcome: 'exit',
                cleanup_verified: true,
            });
            expect(Number.isSafeInteger(terminal.process_group_id)).toBe(true);
            expect(() => process.kill(-terminal.process_group_id, 0))
                .toThrow(expect.objectContaining({ code: 'ESRCH' }));
            expect(isProcessAlive(process.pid)).toBe(true);
        }
        finally {
            await writeFile(providerStopPath, 'stop', 'utf8').catch(() => undefined);
            await terminateWorkerLaunchProvider(launchAttempt, 2_000).catch(() => false);
            await bootstrap?.catch(() => undefined);
        }
    });
    it.runIf(process.platform !== 'win32')('proves native group absence without durable termination records', async () => {
        const launchAttempt = await attempt();
        const providerReadyPath = join(cwd, 'native-direct-termination-ready');
        const providerScript = [
            `require('node:fs').writeFileSync(${JSON.stringify(providerReadyPath)},'ready')`,
            'setInterval(()=>{},1000)',
        ].join(';');
        let bootstrap;
        let ownedGroup = null;
        try {
            bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', providerScript], cwd, { releaseAfterSpawn: true }));
            await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
                timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
                pollIntervalMs: 5,
            })).resolves.toEqual({ ok: true });
            await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
                timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
                pollIntervalMs: 5,
            })).resolves.toBe(true);
            await vi.waitFor(async () => {
                await expect(readFile(providerReadyPath, 'utf8')).resolves.toBe('ready');
            }, { timeout: 2_000, interval: 5 });
            const fenced = await withWorkerLaunchAttemptFence(launchAttempt, async () => {
                const started = JSON.parse(await readFile(launchAttempt.startedPath, 'utf8'));
                expect(isProcessAlive(started.pid)).toBe(true);
                ownedGroup = captureOwnedProcessGroup(started.pid);
                expect(ownedGroup).toMatchObject({
                    pid: started.pid,
                    processStartIdentity: started.process_start_identity,
                    processGroupId: started.process_group_id,
                });
                if (!ownedGroup)
                    throw new Error('worker_launch_owned_group_capture_failed');
                return await terminateOwnedProcessGroup({
                    pid: ownedGroup.pid,
                    expectedStartIdentity: ownedGroup.processStartIdentity,
                    processGroupId: ownedGroup.processGroupId,
                    deadlineAt: new Date(Date.now() + 2_000).toISOString(),
                    force: true,
                });
            });
            expect(fenced).toMatchObject({ ok: true, value: 'terminated' });
            await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: null, signal: 'SIGKILL' });
            await expect(readFile(`${launchAttempt.startedPath}.termination-request`, 'utf8'))
                .rejects.toMatchObject({ code: 'ENOENT' });
            await expect(readFile(`${launchAttempt.startedPath}.termination-complete`, 'utf8'))
                .rejects.toMatchObject({ code: 'ENOENT' });
            const terminal = JSON.parse(await readFile(`${launchAttempt.startedPath}.terminal`, 'utf8'));
            expect(terminal).toMatchObject({
                kind: 'worker_launch_provider_terminal',
                outcome: 'exit',
                cleanup_verified: true,
                process_group_id: ownedGroup.processGroupId,
                signal: 'SIGKILL',
            });
            expect(() => process.kill(-ownedGroup.processGroupId, 0))
                .toThrow(expect.objectContaining({ code: 'ESRCH' }));
        }
        finally {
            // The fence callback assigns this handle; retain its declared type
            // rather than TypeScript's pre-callback null narrowing.
            const cleanupGroup = ownedGroup;
            if (cleanupGroup) {
                await terminateOwnedProcessGroup({
                    pid: cleanupGroup.pid,
                    expectedStartIdentity: cleanupGroup.processStartIdentity,
                    processGroupId: cleanupGroup.processGroupId,
                    deadlineAt: new Date(Date.now() + 2_000).toISOString(),
                    force: true,
                }).catch(() => 'unknown');
            }
            else {
                await terminateWorkerLaunchProvider(launchAttempt, 2_000).catch(() => false);
            }
            await bootstrap?.catch(() => undefined);
            if (ownedGroup) {
                await vi.waitFor(() => {
                    expect(() => process.kill(-ownedGroup.processGroupId, 0))
                        .toThrow(expect.objectContaining({ code: 'ESRCH' }));
                }, { timeout: 2_000, interval: 20 });
            }
        }
    });
    it('revokes a timed-out attempt and treats a later acknowledgement as losing evidence', async () => {
        const launchAttempt = await attempt();
        const providerMarker = join(cwd, 'provider-ran');
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
            timeoutMs: 20,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: false, reason: 'ack_timeout' });
        const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(providerMarker)}, 'ran')`], cwd);
        await expect(runWorkerLaunchBootstrap(spec)).resolves.toEqual({ outcome: 'revoked' });
        await expect(readFile(providerMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(isWorkerLaunchAttemptAccepted(launchAttempt)).resolves.toBe(false);
        const decision = JSON.parse(await readFile(launchAttempt.decisionPath, 'utf8'));
        expect(decision).toMatchObject({ decision: 'revoked', reason: 'ack_timeout' });
    });
    it('rejects a mismatched nonce and seals the attempt against later acceptance', async () => {
        const launchAttempt = await attempt();
        const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
        await writeFile(launchAttempt.ackPath, JSON.stringify({
            ...expected,
            kind: 'worker_launch_ack',
            nonce: '00000000-0000-4000-8000-000000000000',
            written_at: new Date().toISOString(),
        }), 'utf8');
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
            timeoutMs: 100,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: false, reason: 'ack_mismatch' });
        await expect(isWorkerLaunchAttemptAccepted(launchAttempt)).resolves.toBe(false);
    });
    it('rejects malformed acknowledgement bytes and records a terminal revocation', async () => {
        const launchAttempt = await attempt();
        await writeFile(launchAttempt.ackPath, '{not-json', 'utf8');
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
            timeoutMs: 100,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: false, reason: 'ack_malformed' });
        await expect(isWorkerLaunchAttemptAccepted(launchAttempt)).resolves.toBe(false);
        const decision = JSON.parse(await readFile(launchAttempt.decisionPath, 'utf8'));
        expect(decision).toMatchObject({ decision: 'revoked', reason: 'ack_malformed' });
    });
    it('does not clean a superseded or expected-only current launch attempt', async () => {
        const accepted = await attempt();
        await writeFile(accepted.ackPath, JSON.stringify({
            schema_version: accepted.schema_version, attempt_id: accepted.attempt_id, nonce: accepted.nonce,
            instance_id: accepted.instance_id,
            team_name: accepted.team_name, worker_name: accepted.worker_name, pane_id: accepted.pane_id,
            provider: accepted.provider, created_at: accepted.created_at, kind: 'worker_launch_ack', written_at: new Date().toISOString(),
        }), 'utf8');
        await expect(awaitWorkerLaunchAcknowledgement(accepted, { timeoutMs: 500, pollIntervalMs: 5 })).resolves.toEqual({ ok: true });
        await expect(retireWorkerLaunchAttempt(accepted, 'superseded')).resolves.toBe(true);
        const successor = await prepareWorkerLaunchAttempt({
            cwd, teamName: accepted.team_name, workerName: accepted.worker_name, instanceId: randomUUID(), paneId: '%3',
            provider: accepted.provider, runtimeCliPath: accepted.runtimeCliPath,
        });
        const cleanup = vi.fn(async () => true);
        await expect(retireAndCleanupCurrentWorkerLaunchAttempt(accepted, 'stale_cleanup', cleanup)).resolves.toBe(false);
        await expect(retireAndCleanupCurrentWorkerLaunchAttempt(successor, 'expected_only_cleanup', cleanup)).resolves.toBe(false);
        expect(cleanup).not.toHaveBeenCalled();
    });
    it('reuses exact durable cleanup-complete evidence without touching a successor or pane again', async () => {
        const launchAttempt = await attempt();
        const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
        await writeFile(launchAttempt.ackPath, JSON.stringify({ ...expected, kind: 'worker_launch_ack', written_at: new Date().toISOString() }), 'utf8');
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: 500, pollIntervalMs: 5 })).resolves.toEqual({ ok: true });
        await writeFile(`${launchAttempt.startedPath}.terminal`, JSON.stringify({ ...expected,
            kind: 'worker_launch_provider_terminal', outcome: 'exit', cleanup_verified: true,
            pid: 999_999, process_start_identity: '1',
            ...(process.platform !== 'win32' ? { process_group_id: 999_999 } : {}),
            written_at: new Date().toISOString() }), 'utf8');
        const firstCleanup = vi.fn(async () => true);
        await expect(retireAndCleanupCurrentWorkerLaunchAttempt(launchAttempt, 'partial_shutdown', firstCleanup)).resolves.toBe(true);
        expect(firstCleanup).toHaveBeenCalledOnce();
        const retryCleanup = vi.fn(async () => true);
        await expect(retireAndCleanupCurrentWorkerLaunchAttempt(launchAttempt, 'partial_shutdown_retry', retryCleanup)).resolves.toBe(true);
        expect(retryCleanup).not.toHaveBeenCalled();
    });
    it.skipIf(posixOnly('provider containment proof needs POSIX process groups; win32 reports provider_cleanup_unverified'))('retries cleanup-complete retirement after a current-pointer unlink failure', async () => {
        const launchAttempt = await attempt();
        const expected = await acceptFixtureAttempt(launchAttempt);
        const processStartIdentity = await getProcessStartIdentity(process.pid);
        const processGroup = captureOwnedProcessGroup(process.pid);
        if (!processStartIdentity || !processGroup)
            throw new Error('worker_launch_test_process_identity_missing');
        const started = {
            ...expected,
            kind: 'worker_launch_provider_started',
            pid: process.pid,
            process_start_identity: processStartIdentity,
            process_group_id: processGroup.processGroupId,
            written_at: new Date().toISOString(),
        };
        await writeFile(launchAttempt.startedPath, JSON.stringify(started), 'utf8');
        await writeFile(`${launchAttempt.startedPath}.terminal`, JSON.stringify({
            ...started,
            kind: 'worker_launch_provider_terminal',
            outcome: 'exit',
            cleanup_verified: true,
            child_reaped: true,
            written_at: new Date().toISOString(),
        }), 'utf8');
        vi.resetModules();
        const actualFsPromises = await vi.importActual('node:fs/promises');
        let currentUnlinkFailuresRemaining = 2;
        vi.doMock('node:fs/promises', () => ({
            ...actualFsPromises,
            unlink: async (...args) => {
                if (args[0] === launchAttempt.currentPath && currentUnlinkFailuresRemaining > 0) {
                    currentUnlinkFailuresRemaining--;
                    throw Object.assign(new Error('fixture_current_unlink_failure'), { code: 'EACCES' });
                }
                return actualFsPromises.unlink(...args);
            },
        }));
        const workerLaunch = await import('../worker-launch-ack.js');
        const cleanup = vi.fn(async () => true);
        try {
            await expect(workerLaunch.retireAndCleanupCurrentWorkerLaunchAttempt(launchAttempt, 'retry_after_unlink_failure', cleanup)).resolves.toBe(false);
            expect(cleanup).toHaveBeenCalledOnce();
            await expect(readFile(launchAttempt.currentPath, 'utf8')).resolves.toContain(launchAttempt.attempt_id);
            const retryCleanup = vi.fn(async () => true);
            await expect(workerLaunch.retireAndCleanupCurrentWorkerLaunchAttempt(launchAttempt, 'retry_after_unlink_failure', retryCleanup)).resolves.toBe(false);
            expect(retryCleanup).not.toHaveBeenCalled();
            await expect(readFile(launchAttempt.currentPath, 'utf8')).resolves.toContain(launchAttempt.attempt_id);
            await expect(workerLaunch.retireAndCleanupCurrentWorkerLaunchAttempt(launchAttempt, 'retry_after_unlink_failure', retryCleanup)).resolves.toBe(true);
            expect(retryCleanup).not.toHaveBeenCalled();
            await expect(readFile(launchAttempt.currentPath, 'utf8'))
                .rejects.toMatchObject({ code: 'ENOENT' });
        }
        finally {
            vi.doUnmock('node:fs/promises');
            vi.resetModules();
        }
    });
    it('preserves a successor current pointer when retrying an older cleanup-complete retirement', async () => {
        const launchAttempt = await attempt();
        const expected = await acceptFixtureAttempt(launchAttempt);
        await writeFile(`${launchAttempt.decisionPath}.retired`, JSON.stringify({
            ...expected,
            kind: 'worker_launch_retired',
            reason: 'successor_race',
            written_at: new Date().toISOString(),
        }), 'utf8');
        await writeFile(`${launchAttempt.decisionPath}.retired.cleanup-complete`, JSON.stringify({
            ...expected,
            kind: 'worker_launch_cleanup_complete',
            reason: 'successor_race',
            written_at: new Date().toISOString(),
        }), 'utf8');
        const successor = await prepareWorkerLaunchAttempt({
            cwd,
            teamName: launchAttempt.team_name,
            workerName: launchAttempt.worker_name,
            instanceId: launchAttempt.instance_id,
            paneId: '%3',
            provider: launchAttempt.provider,
            runtimeCliPath: launchAttempt.runtimeCliPath,
        });
        await expect(retireAndCleanupCurrentWorkerLaunchAttempt(launchAttempt, 'successor_race_retry', vi.fn(async () => true))).resolves.toBe(true);
        await expect(readFile(successor.currentPath, 'utf8')).resolves.toContain(successor.attempt_id);
    });
    it.runIf(process.platform !== 'win32')('does not synthesize completion from an already-dead retry after a prior request', async () => {
        const launchAttempt = await attempt();
        const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
        await writeFile(launchAttempt.startedPath, JSON.stringify({ ...expected,
            kind: 'worker_launch_provider_started', pid: 999_999_999, process_start_identity: '1',
            process_group_id: 999_999_999, written_at: new Date().toISOString() }), 'utf8');
        await writeFile(`${launchAttempt.startedPath}.termination-request`, JSON.stringify({ ...expected,
            kind: 'worker_launch_termination_request', pid: 999_999_999,
            process_start_identity: '1', containment_nonce: launchAttempt.nonce,
            written_at: new Date().toISOString() }), 'utf8');
        await expect(terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(false);
        await expect(readFile(`${launchAttempt.startedPath}.termination-complete`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it.skipIf(posixOnly('provider containment proof needs POSIX process groups; win32 reports provider_cleanup_unverified'))('does not treat a reused provider PID as cleaned without terminal descendant proof', async () => {
        const launchAttempt = await attempt();
        const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
        const currentIdentity = await getProcessStartIdentity(process.pid);
        expect(currentIdentity).toMatch(/^\d+$/);
        const staleIdentity = String(BigInt(currentIdentity) + 1n);
        await writeFile(launchAttempt.ackPath, JSON.stringify({ ...expected, kind: 'worker_launch_ack', written_at: new Date().toISOString() }), 'utf8');
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: 500, pollIntervalMs: 5 })).resolves.toEqual({ ok: true });
        await writeFile(launchAttempt.startedPath, JSON.stringify({ ...expected, kind: 'worker_launch_provider_started',
            pid: process.pid, process_start_identity: staleIdentity, written_at: new Date().toISOString() }), 'utf8');
        await expect(terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(false);
        expect(isProcessAlive(process.pid)).toBe(true);
        await writeFile(`${launchAttempt.startedPath}.terminal`, JSON.stringify({ ...expected,
            kind: 'worker_launch_provider_terminal', outcome: 'exit', cleanup_verified: true,
            pid: process.pid, process_start_identity: staleIdentity, written_at: new Date().toISOString() }), 'utf8');
        await expect(terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(false);
        expect(isProcessAlive(process.pid)).toBe(true);
        expect(currentIdentity).toBeTruthy();
        await writeFile(launchAttempt.startedPath, JSON.stringify({ ...expected, kind: 'worker_launch_provider_started',
            pid: process.pid, process_start_identity: currentIdentity, written_at: new Date().toISOString() }), 'utf8');
        await expect(terminateWorkerLaunchProvider(launchAttempt, 0)).resolves.toBe(false);
        expect(isProcessAlive(process.pid)).toBe(true);
    });
    it.runIf(process.platform !== 'win32')('rejects terminal cleanup proof bound to the wrong process group', async () => {
        const launchAttempt = await attempt();
        const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
        const currentIdentity = await getProcessStartIdentity(process.pid);
        await writeFile(launchAttempt.startedPath, JSON.stringify({ ...expected,
            kind: 'worker_launch_provider_started', pid: process.pid,
            process_start_identity: currentIdentity, process_group_id: 999_998,
            written_at: new Date().toISOString() }), 'utf8');
        await writeFile(`${launchAttempt.startedPath}.terminal`, JSON.stringify({ ...expected,
            kind: 'worker_launch_provider_terminal', outcome: 'exit', cleanup_verified: true,
            pid: process.pid, process_start_identity: currentIdentity, process_group_id: 999_999,
            written_at: new Date().toISOString() }), 'utf8');
        await expect(terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(false);
        expect(isProcessAlive(process.pid)).toBe(true);
    });
    it('rejects malformed terminal and provider-start records as cleanup authority', async () => {
        const launchAttempt = await attempt();
        const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
        await writeFile(launchAttempt.ackPath, JSON.stringify({ ...expected,
            kind: 'worker_launch_ack', written_at: new Date().toISOString() }), 'utf8');
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: 500, pollIntervalMs: 5 }))
            .resolves.toEqual({ ok: true });
        await writeFile(`${launchAttempt.startedPath}.terminal`, JSON.stringify({ ...expected,
            kind: 'not_a_provider_terminal', outcome: 'exit', cleanup_verified: true,
            pid: 999_999, process_start_identity: '1', written_at: new Date().toISOString() }), 'utf8');
        await expect(terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(false);
        await writeFile(launchAttempt.startedPath, JSON.stringify({ ...expected,
            kind: 'worker_launch_provider_started', pid: 0, process_start_identity: '', written_at: new Date().toISOString() }), 'utf8');
        await writeFile(`${launchAttempt.startedPath}.terminal`, JSON.stringify({ ...expected,
            kind: 'worker_launch_provider_terminal', outcome: 'exit', cleanup_verified: true,
            pid: 999_999, process_start_identity: '1', written_at: new Date().toISOString() }), 'utf8');
        await expect(terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(false);
    });
    it.runIf(process.platform !== 'win32')('signals only a live provider when no terminal evidence exists', async () => {
        vi.resetModules();
        const dynamicProcessUtils = await import('../../platform/process-utils.js');
        const terminateSpy = vi.spyOn(dynamicProcessUtils, 'terminateOwnedProcessGroup')
            .mockResolvedValue('identity-mismatch');
        const workerLaunch = await import('../worker-launch-ack.js');
        let disposable;
        try {
            const launchAttempt = await attempt();
            const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
            disposable = await spawnDisposableProvider();
            await writeFile(launchAttempt.startedPath, JSON.stringify({
                ...expected, kind: 'worker_launch_provider_started', pid: disposable.pid,
                process_start_identity: disposable.processStartIdentity, process_group_id: disposable.processGroupId,
                written_at: new Date().toISOString(),
            }), 'utf8');
            await expect(workerLaunch.terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(false);
            expect(terminateSpy).toHaveBeenCalledOnce();
        }
        finally {
            if (disposable)
                await stopDisposableProvider(disposable.child);
            terminateSpy.mockRestore();
            vi.resetModules();
        }
    });
    it.runIf(process.platform !== 'win32')('accepts verified terminal cleanup without signaling its provider PID', async () => {
        vi.resetModules();
        const dynamicProcessUtils = await import('../../platform/process-utils.js');
        const terminateSpy = vi.spyOn(dynamicProcessUtils, 'terminateOwnedProcessGroup')
            .mockResolvedValue('terminated');
        const workerLaunch = await import('../worker-launch-ack.js');
        let disposable;
        try {
            const launchAttempt = await attempt();
            const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
            disposable = await spawnDisposableProvider();
            const started = {
                ...expected, kind: 'worker_launch_provider_started', pid: disposable.pid,
                process_start_identity: disposable.processStartIdentity, process_group_id: disposable.processGroupId,
                written_at: new Date().toISOString(),
            };
            await writeFile(launchAttempt.startedPath, JSON.stringify(started), 'utf8');
            await writeFile(`${launchAttempt.startedPath}.terminal`, JSON.stringify({
                ...started, kind: 'worker_launch_provider_terminal', outcome: 'exit', cleanup_verified: true,
                child_reaped: true,
            }), 'utf8');
            await expect(workerLaunch.terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(true);
            expect(terminateSpy).not.toHaveBeenCalled();
        }
        finally {
            if (disposable)
                await stopDisposableProvider(disposable.child);
            terminateSpy.mockRestore();
            vi.resetModules();
        }
    });
    it.runIf(process.platform !== 'win32').each([
        ['malformed terminal', 'malformed'],
        ['null terminal', 'null'],
        ['unreadable terminal', 'unreadable'],
        ['wrong-identity terminal', 'wrong-identity'],
        ['unbound live terminal', 'unbound-live'],
    ])('fails closed without signaling for a %s', async (_name, terminalKind) => {
        vi.resetModules();
        const dynamicProcessUtils = await import('../../platform/process-utils.js');
        const terminateSpy = vi.spyOn(dynamicProcessUtils, 'terminateOwnedProcessGroup')
            .mockResolvedValue('terminated');
        const workerLaunch = await import('../worker-launch-ack.js');
        let disposable;
        try {
            const launchAttempt = await attempt();
            const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
            disposable = await spawnDisposableProvider();
            const started = {
                ...expected, kind: 'worker_launch_provider_started', pid: disposable.pid,
                process_start_identity: disposable.processStartIdentity, process_group_id: disposable.processGroupId,
                written_at: new Date().toISOString(),
            };
            await writeFile(launchAttempt.startedPath, JSON.stringify(started), 'utf8');
            const terminalPath = `${launchAttempt.startedPath}.terminal`;
            if (terminalKind === 'malformed') {
                await writeFile(terminalPath, '{not-json', 'utf8');
            }
            else if (terminalKind === 'null') {
                await writeFile(terminalPath, 'null', 'utf8');
            }
            else if (terminalKind === 'unreadable') {
                await mkdir(terminalPath);
            }
            else if (terminalKind === 'wrong-identity') {
                await writeFile(terminalPath, JSON.stringify({
                    ...started, attempt_id: '00000000-0000-4000-8000-000000000000',
                    kind: 'worker_launch_provider_terminal', outcome: 'exit', cleanup_verified: true,
                }), 'utf8');
            }
            else {
                await writeFile(terminalPath, JSON.stringify({
                    ...started, kind: 'worker_launch_provider_terminal',
                    outcome: 'cleanup_unverified', cleanup_verified: false, child_reaped: false,
                }), 'utf8');
                const terminal = JSON.parse(await readFile(terminalPath, 'utf8'));
                delete terminal.process_group_id;
                await writeFile(terminalPath, JSON.stringify(terminal), 'utf8');
            }
            await expect(workerLaunch.terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(false);
            expect(terminateSpy).not.toHaveBeenCalled();
        }
        finally {
            if (disposable)
                await stopDisposableProvider(disposable.child);
            terminateSpy.mockRestore();
            vi.resetModules();
        }
    });
    it.runIf(process.platform !== 'win32')('retries a matching live-unreaped cleanup terminal with its bound group', async () => {
        vi.resetModules();
        const dynamicProcessUtils = await import('../../platform/process-utils.js');
        const nativeTerminate = dynamicProcessUtils.terminateOwnedProcessGroup;
        const terminateSpy = vi.spyOn(dynamicProcessUtils, 'terminateOwnedProcessGroup')
            .mockImplementation(options => nativeTerminate(options));
        const workerLaunch = await import('../worker-launch-ack.js');
        let disposable;
        try {
            const launchAttempt = await attempt();
            const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
            disposable = await spawnDisposableProvider();
            const started = {
                ...expected, kind: 'worker_launch_provider_started', pid: disposable.pid,
                process_start_identity: disposable.processStartIdentity, process_group_id: disposable.processGroupId,
                written_at: new Date().toISOString(),
            };
            await writeFile(launchAttempt.startedPath, JSON.stringify(started), 'utf8');
            await writeFile(`${launchAttempt.startedPath}.terminal`, JSON.stringify({
                ...started, kind: 'worker_launch_provider_terminal',
                outcome: 'cleanup_unverified', cleanup_verified: false, child_reaped: false,
            }), 'utf8');
            await expect(workerLaunch.terminateWorkerLaunchProvider(launchAttempt, 2_000)).resolves.toBe(true);
            expect(terminateSpy).toHaveBeenCalledOnce();
            await expect(readFile(`${launchAttempt.startedPath}.termination-complete`, 'utf8')).resolves.toContain('worker_launch_termination_complete');
        }
        finally {
            if (disposable)
                await stopDisposableProvider(disposable.child);
            terminateSpy.mockRestore();
            vi.resetModules();
        }
    });
    it.runIf(process.platform !== 'win32').each([
        ['already-dead', 'verified/reaped', true],
        ['already-dead', 'absent', false],
        ['already-dead', 'unverified', false],
        ['already-dead', 'wrong-bound', false],
        ['identity-mismatch', 'verified/reaped', true],
        ['identity-mismatch', 'absent', false],
        ['identity-mismatch', 'unverified', false],
        ['identity-mismatch', 'wrong-bound', false],
    ])('re-reads cleanup proof after %s and accepts only a %s terminal', async (terminationResult, proofKind, expectedResult) => {
        vi.resetModules();
        const dynamicProcessUtils = await import('../../platform/process-utils.js');
        let disposable;
        let terminateSpy;
        try {
            const launchAttempt = await attempt();
            const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
            disposable = await spawnDisposableProvider();
            const started = {
                ...expected, kind: 'worker_launch_provider_started', pid: disposable.pid,
                process_start_identity: disposable.processStartIdentity, process_group_id: disposable.processGroupId,
                written_at: new Date().toISOString(),
            };
            await writeFile(launchAttempt.startedPath, JSON.stringify(started), 'utf8');
            const terminalPath = `${launchAttempt.startedPath}.terminal`;
            await writeFile(terminalPath, JSON.stringify({
                ...started, kind: 'worker_launch_provider_terminal',
                outcome: 'cleanup_unverified', cleanup_verified: false, child_reaped: false,
            }), 'utf8');
            terminateSpy = vi.spyOn(dynamicProcessUtils, 'terminateOwnedProcessGroup')
                .mockImplementation(async () => {
                if (proofKind === 'absent') {
                    await rm(terminalPath, { force: true });
                }
                else {
                    await writeFile(terminalPath, JSON.stringify({
                        ...started,
                        kind: 'worker_launch_provider_terminal',
                        outcome: proofKind === 'verified/reaped' ? 'exit' : 'cleanup_unverified',
                        cleanup_verified: proofKind === 'verified/reaped',
                        child_reaped: true,
                        ...(proofKind === 'wrong-bound'
                            ? { process_group_id: disposable.processGroupId + 1 }
                            : {}),
                    }), 'utf8');
                }
                return terminationResult;
            });
            const workerLaunch = await import('../worker-launch-ack.js');
            await expect(workerLaunch.terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(expectedResult);
            expect(terminateSpy).toHaveBeenCalledOnce();
            await expect(readFile(`${launchAttempt.startedPath}.termination-complete`, 'utf8'))
                .rejects.toMatchObject({ code: 'ENOENT' });
        }
        finally {
            if (disposable)
                await stopDisposableProvider(disposable.child);
            terminateSpy?.mockRestore();
            vi.resetModules();
        }
    });
    it.runIf(process.platform !== 'win32')('rechecks terminal evidence before signaling after the request read', async () => {
        const launchAttempt = await attempt();
        const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
        const disposable = await spawnDisposableProvider();
        const started = {
            ...expected, kind: 'worker_launch_provider_started', pid: disposable.pid,
            process_start_identity: disposable.processStartIdentity, process_group_id: disposable.processGroupId,
            written_at: new Date().toISOString(),
        };
        await writeFile(launchAttempt.startedPath, JSON.stringify(started), 'utf8');
        const terminalPath = `${launchAttempt.startedPath}.terminal`;
        const terminationRequestPath = `${launchAttempt.startedPath}.termination-request`;
        let terminalInjected = false;
        vi.resetModules();
        const actualFsPromises = await vi.importActual('node:fs/promises');
        vi.doMock('node:fs/promises', () => ({
            ...actualFsPromises,
            readFile: async (path, encoding) => {
                try {
                    return await actualFsPromises.readFile(path, encoding ?? 'utf8');
                }
                catch (error) {
                    if (!terminalInjected && path === terminalPath
                        && existsSync(terminationRequestPath)
                        && error.code === 'ENOENT') {
                        terminalInjected = true;
                        await actualFsPromises.writeFile(terminalPath, JSON.stringify({
                            ...started, kind: 'worker_launch_provider_terminal',
                            outcome: 'cleanup_unverified', cleanup_verified: false, child_reaped: true,
                        }), 'utf8');
                        return await actualFsPromises.readFile(path, encoding ?? 'utf8');
                    }
                    throw error;
                }
            },
        }));
        const dynamicProcessUtils = await import('../../platform/process-utils.js');
        const terminateSpy = vi.spyOn(dynamicProcessUtils, 'terminateOwnedProcessGroup')
            .mockResolvedValue('terminated');
        const workerLaunch = await import('../worker-launch-ack.js');
        try {
            await expect(workerLaunch.terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(false);
            expect(terminalInjected).toBe(true);
            expect(terminateSpy).not.toHaveBeenCalled();
            expect(isProcessAlive(disposable.pid)).toBe(true);
            await expect(readFile(`${launchAttempt.startedPath}.termination-complete`, 'utf8'))
                .rejects.toMatchObject({ code: 'ENOENT' });
        }
        finally {
            await stopDisposableProvider(disposable.child);
            terminateSpy.mockRestore();
            vi.doUnmock('node:fs/promises');
            vi.resetModules();
        }
    });
    it.runIf(process.platform !== 'win32')('returns a verified terminal that arrives at the first recovery gate', async () => {
        const launchAttempt = await attempt();
        const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
        const disposable = await spawnDisposableProvider();
        const started = {
            ...expected, kind: 'worker_launch_provider_started', pid: disposable.pid,
            process_start_identity: disposable.processStartIdentity, process_group_id: disposable.processGroupId,
            written_at: new Date().toISOString(),
        };
        await writeFile(launchAttempt.startedPath, JSON.stringify(started), 'utf8');
        const terminalPath = `${launchAttempt.startedPath}.terminal`;
        const terminationRequestPath = `${launchAttempt.startedPath}.termination-request`;
        let terminalReadCount = 0;
        const terminalReadPhases = [];
        vi.resetModules();
        const actualFsPromises = await vi.importActual('node:fs/promises');
        vi.doMock('node:fs/promises', () => ({
            ...actualFsPromises,
            readFile: async (path, encoding) => {
                try {
                    return await actualFsPromises.readFile(path, encoding ?? 'utf8');
                }
                catch (error) {
                    if (path === terminalPath
                        && !existsSync(terminationRequestPath)
                        && error.code === 'ENOENT') {
                        terminalReadCount++;
                        if (terminalReadCount === 1) {
                            terminalReadPhases.push('initial-proof-absent');
                        }
                        else if (terminalReadCount === 2) {
                            terminalReadPhases.push('first-gate-inject');
                            await actualFsPromises.writeFile(terminalPath, JSON.stringify({
                                ...started, kind: 'worker_launch_provider_terminal',
                                outcome: 'exit', cleanup_verified: true, child_reaped: true,
                            }), 'utf8');
                            return await actualFsPromises.readFile(path, encoding ?? 'utf8');
                        }
                    }
                    throw error;
                }
            },
        }));
        const dynamicProcessUtils = await import('../../platform/process-utils.js');
        const terminateSpy = vi.spyOn(dynamicProcessUtils, 'terminateOwnedProcessGroup')
            .mockResolvedValue('terminated');
        const workerLaunch = await import('../worker-launch-ack.js');
        try {
            await expect(workerLaunch.terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(true);
            expect(terminalReadPhases).toEqual(['initial-proof-absent', 'first-gate-inject']);
            expect(terminateSpy).not.toHaveBeenCalled();
            await expect(readFile(terminationRequestPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        }
        finally {
            await stopDisposableProvider(disposable.child);
            terminateSpy.mockRestore();
            vi.doUnmock('node:fs/promises');
            vi.resetModules();
        }
    });
    it.runIf(process.platform !== 'win32')('returns an unverified reaped terminal at the first recovery gate without signaling', async () => {
        const launchAttempt = await attempt();
        const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
        const disposable = await spawnDisposableProvider();
        const started = {
            ...expected, kind: 'worker_launch_provider_started', pid: disposable.pid,
            process_start_identity: disposable.processStartIdentity, process_group_id: disposable.processGroupId,
            written_at: new Date().toISOString(),
        };
        await writeFile(launchAttempt.startedPath, JSON.stringify(started), 'utf8');
        const terminalPath = `${launchAttempt.startedPath}.terminal`;
        const terminationRequestPath = `${launchAttempt.startedPath}.termination-request`;
        let terminalReadCount = 0;
        const terminalReadPhases = [];
        vi.resetModules();
        const actualFsPromises = await vi.importActual('node:fs/promises');
        vi.doMock('node:fs/promises', () => ({
            ...actualFsPromises,
            readFile: async (path, encoding) => {
                try {
                    return await actualFsPromises.readFile(path, encoding ?? 'utf8');
                }
                catch (error) {
                    if (path === terminalPath
                        && !existsSync(terminationRequestPath)
                        && error.code === 'ENOENT') {
                        terminalReadCount++;
                        if (terminalReadCount === 1) {
                            terminalReadPhases.push('initial-proof-absent');
                        }
                        else if (terminalReadCount === 2) {
                            terminalReadPhases.push('first-gate-inject');
                            await actualFsPromises.writeFile(terminalPath, JSON.stringify({
                                ...started, kind: 'worker_launch_provider_terminal',
                                outcome: 'cleanup_unverified', cleanup_verified: false, child_reaped: true,
                            }), 'utf8');
                            return await actualFsPromises.readFile(path, encoding ?? 'utf8');
                        }
                    }
                    throw error;
                }
            },
        }));
        const dynamicProcessUtils = await import('../../platform/process-utils.js');
        const terminateSpy = vi.spyOn(dynamicProcessUtils, 'terminateOwnedProcessGroup')
            .mockResolvedValue('terminated');
        const workerLaunch = await import('../worker-launch-ack.js');
        try {
            await expect(workerLaunch.terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(false);
            expect(terminalReadPhases).toEqual(['initial-proof-absent', 'first-gate-inject']);
            expect(terminateSpy).not.toHaveBeenCalled();
            await expect(readFile(terminationRequestPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        }
        finally {
            await stopDisposableProvider(disposable.child);
            terminateSpy.mockRestore();
            vi.doUnmock('node:fs/promises');
            vi.resetModules();
        }
    });
    it.runIf(process.platform !== 'win32')('returns a verified terminal that arrives at the signal gate', async () => {
        const launchAttempt = await attempt();
        const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
        const disposable = await spawnDisposableProvider();
        const started = {
            ...expected, kind: 'worker_launch_provider_started', pid: disposable.pid,
            process_start_identity: disposable.processStartIdentity, process_group_id: disposable.processGroupId,
            written_at: new Date().toISOString(),
        };
        await writeFile(launchAttempt.startedPath, JSON.stringify(started), 'utf8');
        const terminalPath = `${launchAttempt.startedPath}.terminal`;
        const terminationRequestPath = `${launchAttempt.startedPath}.termination-request`;
        let terminalInjected = false;
        vi.resetModules();
        const actualFsPromises = await vi.importActual('node:fs/promises');
        vi.doMock('node:fs/promises', () => ({
            ...actualFsPromises,
            readFile: async (path, encoding) => {
                try {
                    return await actualFsPromises.readFile(path, encoding ?? 'utf8');
                }
                catch (error) {
                    if (!terminalInjected && path === terminalPath
                        && existsSync(terminationRequestPath)
                        && error.code === 'ENOENT') {
                        terminalInjected = true;
                        await actualFsPromises.writeFile(terminalPath, JSON.stringify({
                            ...started, kind: 'worker_launch_provider_terminal',
                            outcome: 'exit', cleanup_verified: true, child_reaped: true,
                        }), 'utf8');
                        return await actualFsPromises.readFile(path, encoding ?? 'utf8');
                    }
                    throw error;
                }
            },
        }));
        const dynamicProcessUtils = await import('../../platform/process-utils.js');
        const terminateSpy = vi.spyOn(dynamicProcessUtils, 'terminateOwnedProcessGroup')
            .mockResolvedValue('terminated');
        const workerLaunch = await import('../worker-launch-ack.js');
        try {
            await expect(workerLaunch.terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(true);
            expect(terminalInjected).toBe(true);
            expect(terminateSpy).not.toHaveBeenCalled();
        }
        finally {
            await stopDisposableProvider(disposable.child);
            terminateSpy.mockRestore();
            vi.doUnmock('node:fs/promises');
            vi.resetModules();
        }
    });
    it('rejects replay when the acknowledgement path is already owned', async () => {
        const launchAttempt = await attempt();
        const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', 'setTimeout(() => process.exit(0), 300)'], cwd);
        const first = runWorkerLaunchBootstrap(spec);
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
            timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: true });
        await expect(first).resolves.toMatchObject({ outcome: 'ran', exitCode: 0 });
        await expect(runWorkerLaunchBootstrap(spec)).resolves.toEqual({ outcome: 'ack_conflict' });
    });
    it.skipIf(posixOnly('provider containment proof needs POSIX process groups; win32 reports provider_cleanup_unverified'))('reports provider spawn failure after acknowledgement without hanging the bootstrap', async () => {
        const launchAttempt = await attempt();
        const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, [join(cwd, 'definitely-missing-provider')], cwd);
        const bootstrap = runWorkerLaunchBootstrap(spec);
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
            timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: true });
        await expect(bootstrap).resolves.toEqual({ outcome: 'provider_spawn_failed' });
        await expect(loadCurrentWorkerLaunchAttempt({
            cwd,
            teamName: launchAttempt.team_name,
            workerName: launchAttempt.worker_name,
            instanceId: launchAttempt.instance_id,
            provider: launchAttempt.provider,
        })).resolves.toBeNull();
    });
    it('terminates a started provider process tree when durable start publication fails', async () => {
        vi.resetModules();
        const actualFs = await vi.importActual('node:fs/promises');
        const launchAttempt = await attempt();
        await mkdir(launchAttempt.startedPath);
        const pidMarker = join(cwd, 'provider-tree-pids.json');
        // Publication fails 75ms after release, so a provider still starting up
        // on a loaded runner would be killed before writing its marker. Hold the
        // failing start publication until the tree exists.
        const linkMock = vi.fn(async (existingPath, newPath) => {
            if (newPath === launchAttempt.startedPath) {
                await vi.waitFor(() => expect(existsSync(pidMarker)).toBe(true), {
                    timeout: LAUNCH_WAIT_TIMEOUT_MS,
                    interval: 10,
                }).catch(() => undefined);
            }
            return actualFs.link(existingPath, newPath);
        });
        vi.doMock('node:fs/promises', () => ({ ...actualFs, link: linkMock }));
        let bootstrap;
        try {
            const workerLaunch = await import('../worker-launch-ack.js');
            const providerScript = [
                "const fs=require('node:fs')",
                "const cp=require('node:child_process')",
                "const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
                `fs.writeFileSync(${JSON.stringify(pidMarker)},JSON.stringify({parent:process.pid,child:child.pid}))`,
                'setInterval(()=>{},1000)',
            ].join(';');
            bootstrap = workerLaunch.runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', providerScript], cwd));
            await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
                timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
                pollIntervalMs: 5,
            })).resolves.toEqual({ ok: true });
            await expect(bootstrap).resolves.toEqual({ outcome: 'provider_spawn_failed' });
            expect(linkMock).toHaveBeenCalledWith(expect.any(String), launchAttempt.startedPath);
            const pids = JSON.parse(await readFile(pidMarker, 'utf8'));
            await vi.waitFor(() => {
                expect(isProcessAlive(pids.parent)).toBe(false);
                expect(isProcessAlive(pids.child)).toBe(false);
            }, { timeout: 2_000, interval: 20 });
        }
        finally {
            await bootstrap?.catch(() => undefined);
            vi.doUnmock('node:fs/promises');
            vi.resetModules();
        }
    });
    it.runIf(process.platform !== 'win32').each(['identity', 'group'])('gates provider execution when %s ownership capture is unavailable', async (missingCapture) => {
        const launchAttempt = await attempt();
        const providerMarker = join(cwd, `provider-ran-${missingCapture}`);
        const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(providerMarker)}, 'ran');process.exit(0)`], cwd);
        const captureSpy = missingCapture === 'identity'
            ? vi.spyOn(processUtils, 'getProcessStartIdentitySync').mockReturnValue(null)
            : vi.spyOn(processUtils, 'captureOwnedProcessGroup').mockReturnValue(null);
        try {
            const bootstrap = runWorkerLaunchBootstrap(spec);
            await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
                timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
                pollIntervalMs: 5,
            })).resolves.toEqual({ ok: true });
            await expect(bootstrap).resolves.toEqual({ outcome: 'provider_spawn_failed' });
            await expect(readFile(providerMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
            const terminal = JSON.parse(await readFile(`${launchAttempt.startedPath}.terminal`, 'utf8'));
            expect(terminal).toMatchObject({
                kind: 'worker_launch_provider_terminal',
                outcome: 'exit',
                cleanup_verified: true,
                exit_code: null,
                signal: null,
            });
            expect(Number.isSafeInteger(terminal.pid)).toBe(true);
            expect(() => process.kill(-terminal.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
        }
        finally {
            captureSpy.mockRestore();
        }
    });
    it.runIf(process.platform !== 'win32').each(['event-first', 'callback-first'])('fails closed on asynchronous EPIPE after peer exit (%s)', async (errorOrder) => {
        vi.resetModules();
        const actualChildProcess = await vi.importActual('node:child_process');
        const spawnMock = vi.fn((command, args, options) => {
            const child = actualChildProcess.spawn(command, args, options);
            child.once('spawn', () => {
                const gate = child.stdio[3];
                if (!gate)
                    return;
                gate.end = ((_, callback) => {
                    setImmediate(() => {
                        child.kill('SIGKILL');
                        const error = Object.assign(new Error('provider gate peer exited'), { code: 'EPIPE' });
                        if (errorOrder === 'callback-first')
                            callback?.(error);
                        gate.emit('error', error);
                        if (errorOrder === 'event-first')
                            callback?.(error);
                    });
                    return gate;
                });
            });
            return child;
        });
        vi.doMock('node:child_process', () => ({ ...actualChildProcess, spawn: spawnMock }));
        let bootstrap;
        try {
            const workerLaunch = await import('../worker-launch-ack.js');
            const launchAttempt = await attempt();
            const providerMarker = join(cwd, 'async-release-provider-ran');
            bootstrap = workerLaunch.runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(providerMarker)}, 'ran');setInterval(()=>{},1000)`], cwd));
            await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
                timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
                pollIntervalMs: 5,
            })).resolves.toEqual({ ok: true });
            const result = await bootstrap;
            expect(result.outcome).toBe('provider_spawn_failed');
            expect(result.outcome).not.toBe('ran');
            await expect(readFile(providerMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(workerLaunch.isWorkerLaunchProviderStarted(launchAttempt)).resolves.toBe(false);
            const terminal = JSON.parse(await readFile(`${launchAttempt.startedPath}.terminal`, 'utf8'));
            expect(terminal).toMatchObject({
                kind: 'worker_launch_provider_terminal',
                outcome: 'exit',
                cleanup_verified: true,
            });
            expect(Number.isSafeInteger(terminal.process_group_id)).toBe(true);
            expect(() => process.kill(-terminal.process_group_id, 0))
                .toThrow(expect.objectContaining({ code: 'ESRCH' }));
        }
        finally {
            await bootstrap?.catch(() => undefined);
            vi.doUnmock('node:child_process');
            vi.resetModules();
        }
    });
    it.runIf(process.platform !== 'win32')('ignores a late EPIPE emitted after release before start publication', async () => {
        vi.resetModules();
        const actualChildProcess = await vi.importActual('node:child_process');
        const lateError = Object.assign(new Error('provider gate peer closed'), { code: 'EPIPE' });
        const spawnMock = vi.fn((command, args, options) => {
            const child = actualChildProcess.spawn(command, args, options);
            child.once('spawn', () => {
                const gate = child.stdio[3];
                if (!gate)
                    return;
                const nativeEnd = gate.end.bind(gate);
                gate.end = ((chunk, callback) => {
                    if (chunk !== 'release\n')
                        return nativeEnd(chunk, callback);
                    return nativeEnd(chunk, (error) => {
                        callback?.(error);
                        // The release callback has succeeded, but this peer-close event
                        // arrives before the bootstrap publishes provider-started.
                        gate.emit('error', lateError);
                    });
                });
            });
            return child;
        });
        vi.doMock('node:child_process', () => ({ ...actualChildProcess, spawn: spawnMock }));
        let bootstrap;
        const launchAttempt = await attempt();
        const providerMarker = join(cwd, 'late-release-before-start-provider-ran');
        const providerStop = join(cwd, 'late-release-before-start-provider-stop');
        try {
            const workerLaunch = await import('../worker-launch-ack.js');
            bootstrap = workerLaunch.runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', [
                    "const fs=require('node:fs')",
                    `fs.writeFileSync(${JSON.stringify(providerMarker)},'ran')`,
                    `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(providerStop)})){clearInterval(timer);process.exit(0)}},5)`,
                ].join(';')], cwd));
            await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
                timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
                pollIntervalMs: 5,
            })).resolves.toEqual({ ok: true });
            await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
                timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
                pollIntervalMs: 5,
            })).resolves.toBe(true);
            await expect(readFile(providerMarker, 'utf8')).resolves.toBe('ran');
            await writeFile(providerStop, 'stop', 'utf8');
            await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
        }
        finally {
            await writeFile(providerStop, 'stop', 'utf8').catch(() => undefined);
            await terminateWorkerLaunchProvider(launchAttempt, 2_000).catch(() => false);
            await bootstrap?.catch(() => undefined);
            vi.doUnmock('node:child_process');
            vi.resetModules();
        }
    });
    it.runIf(process.platform !== 'win32').each(['EPIPE', 'ECONNRESET', 'ERR_PROVIDER_GATE_LATE'])('ignores a post-release %s after provider-start publication', async (errorCode) => {
        vi.resetModules();
        const actualChildProcess = await vi.importActual('node:child_process');
        const lateError = Object.assign(new Error(`provider gate ${errorCode}`), { code: errorCode });
        let emitLateGateError;
        const spawnMock = vi.fn((command, args, options) => {
            const child = actualChildProcess.spawn(command, args, options);
            child.once('spawn', () => {
                const gate = child.stdio[3];
                if (!gate)
                    return;
                const nativeEnd = gate.end.bind(gate);
                gate.end = ((chunk, callback) => {
                    if (chunk !== 'release\n')
                        return nativeEnd(chunk, callback);
                    return nativeEnd(chunk, (error) => {
                        callback?.(error);
                        emitLateGateError = () => { gate.emit('error', lateError); };
                    });
                });
            });
            return child;
        });
        vi.doMock('node:child_process', () => ({ ...actualChildProcess, spawn: spawnMock }));
        let bootstrap;
        const launchAttempt = await attempt();
        const providerStop = join(cwd, `late-release-${errorCode}-provider-stop`);
        try {
            const workerLaunch = await import('../worker-launch-ack.js');
            bootstrap = workerLaunch.runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', [
                    "const fs=require('node:fs')",
                    `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(providerStop)})){clearInterval(timer);process.exit(0)}},5)`,
                ].join(';')], cwd, { releaseAfterSpawn: true }));
            await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
                timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
                pollIntervalMs: 5,
            })).resolves.toEqual({ ok: true });
            await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
                timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
                pollIntervalMs: 5,
            })).resolves.toBe(true);
            expect(emitLateGateError).toBeDefined();
            emitLateGateError();
            await new Promise(resolve => setImmediate(resolve));
            const started = JSON.parse(await readFile(launchAttempt.startedPath, 'utf8'));
            expect(isProcessAlive(started.pid)).toBe(true);
            await writeFile(providerStop, 'stop', 'utf8');
            await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
        }
        finally {
            await writeFile(providerStop, 'stop', 'utf8').catch(() => undefined);
            await terminateWorkerLaunchProvider(launchAttempt, 2_000).catch(() => false);
            await bootstrap?.catch(() => undefined);
            vi.doUnmock('node:child_process');
            vi.resetModules();
        }
    });
    it.runIf(process.platform !== 'win32')('does not signal a still-present group after supervisor exit', async () => {
        vi.resetModules();
        const actualChildProcess = await vi.importActual('node:child_process');
        const dynamicProcessUtils = await import('../../platform/process-utils.js');
        const lateError = Object.assign(new Error('provider gate peer closed'), { code: 'EPIPE' });
        let killSupervisor;
        let supervisorExited = false;
        let exitMetadataObserved = false;
        let postReapTerminateCalls = 0;
        const nativeTerminate = dynamicProcessUtils.terminateOwnedProcessGroup;
        const terminateSpy = vi.spyOn(dynamicProcessUtils, 'terminateOwnedProcessGroup').mockImplementation(async (options) => {
            if (supervisorExited) {
                postReapTerminateCalls++;
                return 'already-dead';
            }
            return nativeTerminate(options);
        });
        const spawnMock = vi.fn((command, args, options) => {
            const child = actualChildProcess.spawn(command, args, options);
            let gate = null;
            // Attach before returning so this observer runs before the bootstrap's
            // exit listener. Node has populated signalCode by this point.
            child.once('exit', () => {
                supervisorExited = true;
                exitMetadataObserved = child.exitCode === null && child.signalCode === 'SIGKILL';
                gate?.emit('error', lateError);
            });
            child.once('spawn', () => {
                gate = child.stdio[3];
                if (!gate)
                    return;
                const nativeEnd = gate.end.bind(gate);
                gate.end = ((chunk, callback) => {
                    if (chunk !== 'release\n')
                        return nativeEnd(chunk, callback);
                    // Let the provider execute, but withhold the release callback. This
                    // is a real failed release with a live descendant when the supervisor
                    // is killed below.
                    const result = nativeEnd(chunk);
                    killSupervisor = () => { child.kill('SIGKILL'); };
                    return result;
                });
            });
            return child;
        });
        vi.doMock('node:child_process', () => ({ ...actualChildProcess, spawn: spawnMock }));
        let bootstrap;
        const launchAttempt = await attempt();
        let providerPid;
        let providerGroupId;
        try {
            const workerLaunch = await import('../worker-launch-ack.js');
            bootstrap = workerLaunch.runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', [
                    "const fs=require('node:fs')",
                    `fs.writeFileSync(${JSON.stringify(join(cwd, 'failed-release-provider.json'))},JSON.stringify({pid:process.pid}))`,
                    'setInterval(()=>{},1000)',
                ].join(';')], cwd, { releaseAfterSpawn: true }));
            await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
                timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
                pollIntervalMs: 5,
            })).resolves.toEqual({ ok: true });
            const providerMarker = join(cwd, 'failed-release-provider.json');
            await vi.waitFor(async () => {
                const record = JSON.parse(await readFile(providerMarker, 'utf8'));
                expect(record.pid).toBeGreaterThan(0);
                providerPid = record.pid;
            }, { timeout: 2_000, interval: 5 });
            const ownedGroup = dynamicProcessUtils.captureOwnedProcessGroup(providerPid);
            expect(ownedGroup).not.toBeNull();
            providerGroupId = ownedGroup.processGroupId;
            expect(killSupervisor).toBeDefined();
            killSupervisor();
            await expect(bootstrap).resolves.toEqual({ outcome: 'provider_cleanup_unverified' });
            expect(exitMetadataObserved).toBe(true);
            expect(postReapTerminateCalls).toBe(0);
            expect(() => process.kill(-providerGroupId, 0)).not.toThrow();
            await vi.waitFor(async () => {
                const terminal = JSON.parse(await readFile(`${launchAttempt.startedPath}.terminal`, 'utf8'));
                expect(terminal).toMatchObject({
                    outcome: 'cleanup_unverified',
                    cleanup_verified: false,
                    child_reaped: true,
                    signal: 'SIGKILL',
                });
            }, { timeout: 2_000, interval: 5 });
            expect(postReapTerminateCalls).toBe(0);
        }
        finally {
            killSupervisor?.();
            if (!providerGroupId && providerPid) {
                providerGroupId = dynamicProcessUtils.captureOwnedProcessGroup(providerPid)?.processGroupId;
            }
            if (providerGroupId) {
                try {
                    process.kill(-providerGroupId, 'SIGKILL');
                }
                catch { /* group already absent */ }
            }
            await bootstrap?.catch(() => undefined);
            terminateSpy.mockRestore();
            vi.doUnmock('node:child_process');
            vi.resetModules();
        }
    });
    it.runIf(process.platform !== 'win32')('upgrades a live timer terminal to reaped evidence after the supervisor exits', async () => {
        vi.resetModules();
        const actualChildProcess = await vi.importActual('node:child_process');
        const dynamicProcessUtils = await import('../../platform/process-utils.js');
        const terminateSpy = vi.spyOn(dynamicProcessUtils, 'terminateOwnedProcessGroup')
            .mockResolvedValue('unknown');
        let supervisor;
        const spawnMock = vi.fn((command, args, options) => {
            const child = actualChildProcess.spawn(command, args, options);
            supervisor = child;
            return child;
        });
        vi.doMock('node:child_process', () => ({ ...actualChildProcess, spawn: spawnMock }));
        let bootstrap;
        const launchAttempt = await attempt();
        const descendantPidPath = join(cwd, 'timer-transition-descendant.pid');
        const providerExitPath = join(cwd, 'timer-transition-provider.exit');
        let providerGroupId;
        try {
            const workerLaunch = await import('../worker-launch-ack.js');
            // The provider exits only once the test has observed it started: an
            // immediate exit lets the timer terminal land first, and a published
            // terminal makes awaitWorkerLaunchProviderStarted wait out its bound.
            bootstrap = workerLaunch.runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', [
                    "const fs=require('node:fs'),cp=require('node:child_process')",
                    "const descendant=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
                    'descendant.unref()',
                    `fs.writeFileSync(${JSON.stringify(descendantPidPath)},String(descendant.pid))`,
                    `setInterval(()=>{if(fs.existsSync(${JSON.stringify(providerExitPath)}))process.exit(0)},10)`,
                ].join(';')], cwd, { releaseAfterSpawn: true }));
            await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
                timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
                pollIntervalMs: 5,
            })).resolves.toEqual({ ok: true });
            await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
                timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
                pollIntervalMs: 5,
            })).resolves.toBe(true);
            const started = JSON.parse(await readFile(launchAttempt.startedPath, 'utf8'));
            providerGroupId = started.process_group_id;
            await writeFile(providerExitPath, '', 'utf8');
            await vi.waitFor(async () => {
                const terminal = JSON.parse(await readFile(`${launchAttempt.startedPath}.terminal`, 'utf8'));
                expect(terminal).toMatchObject({
                    outcome: 'cleanup_unverified',
                    cleanup_verified: false,
                    child_reaped: false,
                    process_group_id: providerGroupId,
                });
            }, { timeout: LAUNCH_WAIT_TIMEOUT_MS, interval: 20 });
            expect(supervisor).toBeDefined();
            supervisor.kill('SIGKILL');
            await expect(bootstrap).resolves.toEqual({ outcome: 'provider_cleanup_unverified' });
            expect(() => process.kill(-providerGroupId, 0)).not.toThrow();
            await vi.waitFor(async () => {
                const terminal = JSON.parse(await readFile(`${launchAttempt.startedPath}.terminal`, 'utf8'));
                expect(terminal).toMatchObject({
                    outcome: 'cleanup_unverified',
                    cleanup_verified: false,
                    child_reaped: true,
                    process_group_id: providerGroupId,
                });
            }, { timeout: LAUNCH_WAIT_TIMEOUT_MS, interval: 20 });
        }
        finally {
            try {
                if (providerGroupId)
                    process.kill(-providerGroupId, 'SIGKILL');
            }
            catch { /* group already absent */ }
            supervisor?.kill('SIGKILL');
            await bootstrap?.catch(() => undefined);
            terminateSpy.mockRestore();
            vi.doUnmock('node:child_process');
            vi.resetModules();
        }
    });
    it.skipIf(posixOnly('provider containment proof needs POSIX process groups; win32 reports provider_cleanup_unverified'))('terminates the exact started provider process group before failed-startup pane cleanup', async () => {
        const launchAttempt = await attempt();
        const pidMarker = join(cwd, 'started-provider-tree-pids.json');
        const providerScript = [
            "const fs=require('node:fs')",
            "const cp=require('node:child_process')",
            "const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
            `fs.writeFileSync(${JSON.stringify(pidMarker)},JSON.stringify({parent:process.pid,child:child.pid}))`,
            'setInterval(()=>{},1000)',
        ].join(';');
        const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', providerScript], cwd));
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
            timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: true });
        await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
            timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
            pollIntervalMs: 5,
        })).resolves.toBe(true);
        const started = JSON.parse(await readFile(launchAttempt.startedPath, 'utf8'));
        const cleanup = vi.fn(async () => {
            const pids = JSON.parse(await readFile(pidMarker, 'utf8'));
            expect(isProcessAlive(pids.parent)).toBe(false);
            expect(isProcessAlive(pids.child)).toBe(false);
            expect(isProcessAlive(process.pid)).toBe(true);
            expect(() => process.kill(-started.process_group_id, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
            return true;
        });
        await expect(retireAndCleanupCurrentWorkerLaunchAttempt(launchAttempt, 'startup_dispatch_failed', cleanup)).resolves.toBe(true);
        expect(cleanup).toHaveBeenCalledOnce();
        await expect(bootstrap).resolves.toMatchObject({ outcome: 'ran' });
        const pids = JSON.parse(await readFile(pidMarker, 'utf8'));
        await vi.waitFor(() => {
            expect(isProcessAlive(pids.parent)).toBe(false);
            expect(isProcessAlive(pids.child)).toBe(false);
            expect(isProcessAlive(process.pid)).toBe(true);
        }, { timeout: 2_000, interval: 20 });
    });
    it('reloads an accepted attempt only for the exact pane and provider identity', async () => {
        const launchAttempt = await attempt();
        const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', 'setTimeout(() => process.exit(0), 300)'], cwd);
        const bootstrap = runWorkerLaunchBootstrap(spec);
        await awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: LAUNCH_WAIT_TIMEOUT_MS, pollIntervalMs: 5 });
        await bootstrap;
        await expect(loadWorkerLaunchAttempt({
            cwd,
            teamName: 'launch-team',
            workerName: 'worker-1',
            instanceId: launchAttempt.instance_id,
            paneId: '%2',
            provider: 'codex',
            attemptId: launchAttempt.attempt_id,
            runtimeCliPath: '/runtime-cli.cjs',
        })).resolves.toMatchObject({ attempt_id: launchAttempt.attempt_id, nonce: launchAttempt.nonce });
        await expect(loadWorkerLaunchAttempt({
            cwd,
            teamName: 'launch-team',
            workerName: 'worker-1',
            instanceId: randomUUID(),
            paneId: '%2',
            provider: 'codex',
            attemptId: launchAttempt.attempt_id,
            runtimeCliPath: '/runtime-cli.cjs',
        })).resolves.toBeNull();
        await expect(loadWorkerLaunchAttempt({
            cwd,
            teamName: 'launch-team',
            workerName: 'worker-1',
            instanceId: launchAttempt.instance_id,
            paneId: '%1',
            provider: 'codex',
            attemptId: launchAttempt.attempt_id,
            runtimeCliPath: '/runtime-cli.cjs',
        })).resolves.toBeNull();
        await expect(loadCurrentWorkerLaunchAttempt({
            cwd,
            teamName: 'launch-team',
            workerName: 'worker-1',
            instanceId: launchAttempt.instance_id,
            provider: 'claude',
        })).resolves.toBeNull();
    });
    it('keeps revocation terminal when a valid acknowledgement is already present', async () => {
        const launchAttempt = await attempt();
        const providerMarker = join(cwd, 'revocation-race-provider-ran');
        const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(providerMarker)}, 'ran')`], cwd));
        await vi.waitFor(async () => {
            const acknowledgement = JSON.parse(await readFile(launchAttempt.ackPath, 'utf8'));
            expect(acknowledgement.kind).toBe('worker_launch_ack');
        }, { timeout: 2_000, interval: 5 });
        await expect(revokeWorkerLaunchAttempt(launchAttempt, 'timeout')).resolves.toBe(true);
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
            timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: false, reason: 'decision_conflict' });
        await expect(bootstrap).resolves.toEqual({ outcome: 'revoked' });
        await expect(readFile(providerMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(isWorkerLaunchAttemptAccepted(launchAttempt)).resolves.toBe(false);
    });
    it('prevents provider spawn after durable launch retirement wins ordering', async () => {
        const launchAttempt = await attempt();
        const providerMarker = join(cwd, 'retired-provider-ran');
        const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(providerMarker)}, 'ran')`], cwd));
        await vi.waitFor(async () => {
            const acknowledgement = JSON.parse(await readFile(launchAttempt.ackPath, 'utf8'));
            expect(acknowledgement.kind).toBe('worker_launch_ack');
        }, { timeout: 2_000, interval: 5 });
        await expect(retireWorkerLaunchAttempt(launchAttempt, 'pane_cleanup')).resolves.toBe(true);
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
            timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: false, reason: 'attempt_superseded' });
        await expect(bootstrap).resolves.toEqual({ outcome: 'revoked' });
        await new Promise(resolve => setTimeout(resolve, 100));
        await expect(readFile(providerMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(`${launchAttempt.decisionPath}.retired`, 'utf8')).resolves.toContain('worker_launch_retired');
    });
    it('keeps an accepted decision terminal when revocation arrives later', async () => {
        const launchAttempt = await attempt();
        const providerMarker = join(cwd, 'accepted-provider-ran');
        const providerReadyPath = join(cwd, 'accepted-provider-ready');
        const providerStopPath = join(cwd, 'accepted-provider-stop');
        const providerScript = [
            "const fs=require('node:fs')",
            `fs.writeFileSync(${JSON.stringify(providerReadyPath)},JSON.stringify({pid:process.pid}))`,
            `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(providerStopPath)})){clearInterval(timer);fs.writeFileSync(${JSON.stringify(providerMarker)},'ran');process.exit(0)}},5)`,
        ].join(';');
        let bootstrap;
        try {
            bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', providerScript], cwd, { releaseAfterSpawn: true }));
            await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
                timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
                pollIntervalMs: 5,
            })).resolves.toEqual({ ok: true });
            await expect(revokeWorkerLaunchAttempt(launchAttempt, 'late_timeout')).resolves.toBe(false);
            const decision = JSON.parse(await readFile(launchAttempt.decisionPath, 'utf8'));
            expect(decision).toMatchObject({ decision: 'accepted', reason: 'ack_valid' });
            await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
                timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
                pollIntervalMs: 5,
            })).resolves.toBe(true);
            await vi.waitFor(async () => {
                const ready = JSON.parse(await readFile(providerReadyPath, 'utf8'));
                expect(ready.pid).toBeGreaterThan(0);
            }, { timeout: 2_000, interval: 5 });
            await writeFile(providerStopPath, 'stop', 'utf8');
            await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
            await expect(readFile(providerMarker, 'utf8')).resolves.toBe('ran');
        }
        finally {
            await writeFile(providerStopPath, 'stop', 'utf8').catch(() => undefined);
            await terminateWorkerLaunchProvider(launchAttempt, 2_000).catch(() => false);
            await bootstrap?.catch(() => undefined);
        }
    });
    it('prevents an older acknowledged attempt from releasing a provider after supersession', async () => {
        cwd = await createFixture('omc-worker-launch-recovery-generation-');
        const olderAttempt = await prepareWorkerLaunchAttempt({
            cwd,
            teamName: 'launch-team',
            workerName: 'worker-1',
            instanceId: randomUUID(),
            paneId: '%2',
            provider: 'codex',
            runtimeCliPath: '/runtime-cli.cjs',
            context: { kind: 'recovery', recovery_id: 'recovery-old', replacement_generation: 1, pane_attempt_id: 'pane-old' },
        });
        const providerMarker = join(cwd, 'superseded-provider-ran');
        const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(olderAttempt, [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(providerMarker)}, 'ran')`], cwd));
        let acknowledged;
        for (let index = 0; index < 200 && !acknowledged; index++) {
            try {
                acknowledged = JSON.parse(await readFile(olderAttempt.ackPath, 'utf8'));
            }
            catch {
                await new Promise(resolve => setTimeout(resolve, 5));
            }
        }
        expect(acknowledged).toMatchObject({
            attempt_id: olderAttempt.attempt_id,
            nonce: olderAttempt.nonce,
            pane_id: olderAttempt.pane_id,
            kind: 'worker_launch_ack',
        });
        const newerAttempt = await prepareWorkerLaunchAttempt({
            cwd,
            teamName: olderAttempt.team_name,
            workerName: olderAttempt.worker_name,
            instanceId: randomUUID(),
            paneId: '%3',
            provider: olderAttempt.provider,
            runtimeCliPath: olderAttempt.runtimeCliPath,
            context: { kind: 'recovery', recovery_id: 'recovery-new', replacement_generation: 2, pane_attempt_id: 'pane-new' },
        });
        await expect(awaitWorkerLaunchAcknowledgement(olderAttempt, {
            timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
            pollIntervalMs: 5,
        })).resolves.toEqual({ ok: false, reason: 'attempt_superseded' });
        await expect(bootstrap).resolves.toEqual({ outcome: 'revoked' });
        await expect(readFile(providerMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(isWorkerLaunchAttemptAccepted(olderAttempt)).resolves.toBe(false);
        await expect(isWorkerLaunchAttemptAccepted(newerAttempt)).resolves.toBe(false);
        const current = JSON.parse(await readFile(newerAttempt.currentPath, 'utf8'));
        expect(current).toMatchObject({
            attempt_id: newerAttempt.attempt_id,
            pane_id: '%3',
            context: { kind: 'recovery', recovery_id: 'recovery-new', replacement_generation: 2, pane_attempt_id: 'pane-new' },
        });
    });
    it('reloads the accepted current recovery launch with its durable context', async () => {
        cwd = await createFixture('omc-worker-launch-current-');
        const launchAttempt = await prepareWorkerLaunchAttempt({
            cwd,
            teamName: 'launch-team',
            workerName: 'worker-1',
            instanceId: randomUUID(),
            paneId: '%22',
            provider: 'codex',
            runtimeCliPath: '/runtime-cli.cjs',
            context: {
                kind: 'recovery',
                recovery_id: 'recovery-current',
                replacement_generation: 2,
                pane_attempt_id: 'pane-attempt-current',
            },
        });
        const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd);
        const bootstrap = runWorkerLaunchBootstrap(spec);
        await awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: LAUNCH_WAIT_TIMEOUT_MS, pollIntervalMs: 5 });
        await expect(awaitWorkerLaunchProviderStarted(launchAttempt, { timeoutMs: 10_000, pollIntervalMs: 5 })).resolves.toBe(true);
        const started = JSON.parse(await readFile(launchAttempt.startedPath, 'utf8'));
        expect(started).toMatchObject({
            kind: 'worker_launch_provider_started',
            attempt_id: launchAttempt.attempt_id,
            pane_id: '%22',
            provider: 'codex',
            process_start_identity: expect.any(String),
        });
        await expect(loadCurrentWorkerLaunchAttempt({
            cwd,
            teamName: 'launch-team',
            workerName: 'worker-1',
            instanceId: launchAttempt.instance_id,
            provider: 'codex',
        })).resolves.toMatchObject({
            attempt_id: launchAttempt.attempt_id,
            pane_id: '%22',
            context: {
                kind: 'recovery',
                recovery_id: 'recovery-current',
                replacement_generation: 2,
                pane_attempt_id: 'pane-attempt-current',
            },
        });
        await expect(retireWorkerLaunchAttempt(launchAttempt, 'test_cleanup')).resolves.toBe(true);
        await expect(terminateWorkerLaunchProvider(launchAttempt)).resolves.toBe(true);
        await expect(bootstrap).resolves.toMatchObject({ outcome: 'ran' });
    });
    it('materializes an attempt-owned Windows transport without exposing provider secrets in pane text', async () => {
        const launchAttempt = await attempt();
        const secret = 'synthetic-token-value';
        const longValue = `long-${'x'.repeat(12_000)}`;
        const providerArgv = [
            'C:\\Program Files\\Codex\\codex.exe',
            '--token', secret,
            '--metacharacters', '100% ! ^ & | ( ) "quoted" with spaces',
            '--unicode', 'Grüße-λ-漢字',
            '--long', longValue,
        ];
        const providerEnv = {
            OMC_TEAM_WORKER: 'launch-team/worker-1',
            OMC_WORKER_LAUNCH_ATTEMPT_ID: launchAttempt.attempt_id,
            PROVIDER_TOKEN: secret,
            PROVIDER_URL: 'https://provider.example.test/path?x=1&y=2',
            PATH: 'C:\\Program Files\\Node;C:\\Tools',
            SYNTHETIC_METACHARS: '100% ! ^ & | ( ) "quoted" with spaces',
            SYNTHETIC_UNICODE: 'Grüße-λ-漢字',
            SYNTHETIC_CRLF: 'line-one\r\nline-two',
            SYNTHETIC_LONG: longValue,
        };
        const materialized = await materializeWorkerLaunchTransport({
            attempt: launchAttempt,
            providerArgv,
            providerEnv,
            cwd,
        });
        const canonicalWrapperPath = join(getOmcRoot(cwd), 'state', 'team', 'launch-team', 'workers', 'worker-1', 'launch-attempts', launchAttempt.attempt_id, 'launch.cmd');
        expect(materialized.wrapperPath).toBe(canonicalWrapperPath);
        expect(materialized.wrapperRelativePath).toBe(relative(cwd, canonicalWrapperPath).replace(/\//g, '\\'));
        expect(Buffer.byteLength(materialized.wrapperRelativePath, 'utf8')).toBeLessThan(256);
        const wrapper = await readFile(materialized.wrapperPath, 'utf8');
        expect(wrapper).toContain('setlocal DisableDelayedExpansion');
        expect(wrapper).toContain('OMC_WORKER_LAUNCH_SPEC_FILE=%~dp0bootstrap.json');
        expect(wrapper).toContain('--worker-launch');
        for (const value of [secret, providerEnv.PROVIDER_URL, providerEnv.SYNTHETIC_METACHARS,
            providerEnv.SYNTHETIC_UNICODE, providerEnv.SYNTHETIC_CRLF, longValue]) {
            expect(wrapper).not.toContain(value);
        }
        expect(wrapper).not.toContain('PROVIDER_TOKEN');
        const descriptorRaw = await readFile(materialized.bootstrapDescriptorPath, 'utf8');
        expect(Buffer.byteLength(descriptorRaw, 'utf8')).toBeGreaterThan(12_000);
        const descriptor = JSON.parse(descriptorRaw);
        expect(descriptor).toMatchObject({
            attempt_id: launchAttempt.attempt_id,
            nonce: launchAttempt.nonce,
        });
        expect(descriptor.provider_argv).toEqual(providerArgv);
        expect(descriptor.provider_env).toEqual(providerEnv);
        await expect(materializeWorkerLaunchTransport({
            attempt: launchAttempt,
            providerArgv: ['codex'],
            cwd,
        })).rejects.toThrow('worker_launch_transport_owner_conflict');
        const consumed = await readAndConsumeWorkerLaunchDescriptor(materialized.bootstrapDescriptorPath);
        expect(consumed).toMatchObject({ attempt_id: launchAttempt.attempt_id, provider_env: { PROVIDER_TOKEN: secret } });
        await expect(readFile(materialized.bootstrapDescriptorPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(cleanupWorkerLaunchTransport(launchAttempt, 'test_cleanup')).resolves.toBe(true);
        await expect(readFile(materialized.wrapperPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(cleanupWorkerLaunchTransport(launchAttempt, 'test_cleanup_retry')).resolves.toBe(true);
        await expect(readFile(launchAttempt.transportCleanupCompletePath, 'utf8').then(JSON.parse))
            .resolves.toMatchObject({ attempt_id: launchAttempt.attempt_id, kind: 'worker_launch_transport_cleanup_complete' });
    });
    it('uses a safe relative wrapper command when worker cwd is nested below the leader state root', async () => {
        const launchAttempt = await attempt();
        const workerCwd = join(getOmcRoot(cwd), 'team', 'launch-team', 'worktrees', 'worker-1');
        await mkdir(workerCwd, { recursive: true });
        const materialized = await materializeWorkerLaunchTransport({
            attempt: launchAttempt,
            providerArgv: ['codex'],
            providerEnv: { OMC_TEAM_WORKER: 'launch-team/worker-1' },
            cwd: workerCwd,
        });
        expect(materialized.wrapperRelativePath).toBe(relative(workerCwd, launchAttempt.wrapperPath).replace(/\//g, '\\'));
        expect(materialized.wrapperRelativePath).toMatch(/^(?:\.\.\\)+state\\team\\launch-team\\workers\\worker-1\\launch-attempts\\[0-9a-f-]+\\launch\.cmd$/);
        expect(materialized.wrapperRelativePath).not.toMatch(/[\s"%!^&|()]/);
        await expect(cleanupWorkerLaunchTransport(launchAttempt, 'nested_worktree_cleanup')).resolves.toBe(true);
    });
    it('removes only partial current-attempt transport files when exclusive materialization fails', async () => {
        const launchAttempt = await attempt();
        await writeFile(launchAttempt.wrapperPath, 'foreign-wrapper', 'utf8');
        await expect(materializeWorkerLaunchTransport({
            attempt: launchAttempt,
            providerArgv: ['codex'],
            providerEnv: { OMC_TEAM_WORKER: 'launch-team/worker-1' },
            cwd,
        })).rejects.toThrow('worker_launch_transport_path_conflict');
        await expect(readFile(launchAttempt.transportOwnerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(launchAttempt.bootstrapDescriptorPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(launchAttempt.wrapperPath, 'utf8')).resolves.toBe('foreign-wrapper');
    });
    it('refuses transport cleanup when the durable owner belongs to another attempt identity', async () => {
        const launchAttempt = await attempt();
        await materializeWorkerLaunchTransport({ attempt: launchAttempt, providerArgv: ['codex'], cwd });
        const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
        await writeFile(launchAttempt.transportOwnerPath, JSON.stringify({
            ...expected,
            nonce: '00000000-0000-4000-8000-000000000000',
            kind: 'worker_launch_transport_owner',
        }), 'utf8');
        await expect(readAndConsumeWorkerLaunchDescriptor(launchAttempt.bootstrapDescriptorPath))
            .rejects.toThrow('worker_launch_descriptor_owner_invalid');
        await expect(readFile(launchAttempt.bootstrapDescriptorPath, 'utf8')).resolves.toContain(launchAttempt.attempt_id);
        await expect(cleanupWorkerLaunchTransport(launchAttempt, 'foreign_owner')).resolves.toBe(false);
        await expect(readFile(launchAttempt.wrapperPath, 'utf8')).resolves.toContain('--worker-launch');
        await expect(readFile(launchAttempt.bootstrapDescriptorPath, 'utf8')).resolves.toContain(launchAttempt.attempt_id);
    });
    it('round trips a Windows descriptor and reapplies one canonical SystemRoot to the supervisor environment', async () => {
        const launchAttempt = await attempt();
        const providerEnv = { EXPLICIT_PROVIDER_VALUE: 'yes' };
        const baselineEnv = {
            PATH: 'C:\\Windows\\System32',
            TEMP: 'C:\\Temp',
            TMP: 'C:\\Temp',
            SystemRoot: 'C:\\Windows',
            SYSTEMROOT: 'D:\\ConflictingWindows',
            USERPROFILE: 'C:\\Users\\provider',
            HOME: '/home/wrong-platform',
            GH_TOKEN: 'ambient-secret',
        };
        const materialized = await materializeWorkerLaunchTransport({
            attempt: launchAttempt,
            providerArgv: ['codex'],
            providerEnv,
            cwd,
            platform: 'win32',
        });
        const written = JSON.parse(await readFile(materialized.bootstrapDescriptorPath, 'utf8'));
        expect(written.provider_env).toEqual(providerEnv);
        const consumed = await readAndConsumeWorkerLaunchDescriptor(materialized.bootstrapDescriptorPath, 'win32');
        const invocation = buildWindowsSupervisorInvocation(consumed, baselineEnv);
        if (!invocation.stdinPayload)
            throw new Error('worker_launch_test_supervisor_payload_missing');
        expect(invocation.command.length + invocation.args.join(' ').length + 16).toBeLessThan(32_767);
        const payload = JSON.parse(invocation.stdinPayload);
        expect(JSON.parse(payload.canonical_json)).toMatchObject({ provider_env: providerEnv });
        expect(createHash('sha256').update(payload.canonical_json, 'utf8').digest('hex')).toBe(payload.authority_digest);
        expect(payload.provider_env).toEqual({
            ...providerEnv,
            PATH: 'C:\\Windows\\System32',
            TEMP: 'C:\\Temp',
            TMP: 'C:\\Temp',
            SystemRoot: 'C:\\Windows',
            USERPROFILE: 'C:\\Users\\provider',
            NoDefaultCurrentDirectoryInExePath: '1',
        });
        expect(Object.keys(payload.provider_env).filter(key => key.toUpperCase() === 'SYSTEMROOT'))
            .toEqual(['SystemRoot']);
        await expect(cleanupWorkerLaunchTransport(launchAttempt, 'windows_descriptor_round_trip')).resolves.toBe(true);
    });
    it('gives the Windows supervisor one NoDefaultCurrentDirectoryInExePath=1 over the allowlisted baseline without changing the authority digest', async () => {
        const launchAttempt = await attempt();
        const providerEnv = { EXPLICIT_PROVIDER_VALUE: 'yes', nodefaultcurrentdirectoryinexepath: '' };
        const materialized = await materializeWorkerLaunchTransport({ attempt: launchAttempt, providerArgv: ['codex'], providerEnv, cwd, platform: 'win32' });
        const consumed = await readAndConsumeWorkerLaunchDescriptor(materialized.bootstrapDescriptorPath, 'win32');
        // The allowlists (SAFE_BASELINE_ENV_KEYS, WINDOWS_BASELINE_ENV_KEYS) never forward an ambient value, here 0.
        const invocation = buildWindowsSupervisorInvocation(consumed, { PATH: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows', NODEFAULTCURRENTDIRECTORYINEXEPATH: '0' });
        const payload = JSON.parse(invocation.stdinPayload);
        expect(JSON.parse(payload.canonical_json).provider_env).toEqual(providerEnv);
        expect(createHash('sha256').update(payload.canonical_json, 'utf8').digest('hex')).toBe(payload.authority_digest);
        expect(Object.entries(payload.provider_env).filter(([key]) => key.toUpperCase() === 'NODEFAULTCURRENTDIRECTORYINEXEPATH'))
            .toEqual([['NoDefaultCurrentDirectoryInExePath', '1']]);
        await expect(cleanupWorkerLaunchTransport(launchAttempt, 'windows_cwd_search')).resolves.toBe(true);
    });
    it('propagates only the canonical home variable for each platform', () => {
        const posix = buildProviderEnvironment(undefined, {
            PATH: '/usr/bin:/bin',
            HOME: '/home/provider',
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            USERPROFILE: 'C:\\Users\\wrong-platform',
            GH_TOKEN: 'ambient-secret',
        }, 'linux');
        expect(posix).toEqual({
            PATH: '/usr/bin:/bin',
            HOME: '/home/provider',
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
        });
        const macos = buildProviderEnvironment(undefined, {
            PATH: '/usr/bin:/bin',
            HOME: '/Users/provider',
            USERPROFILE: 'C:\\Users\\wrong-platform',
        }, 'darwin');
        expect(macos).toEqual({ PATH: '/usr/bin:/bin', HOME: '/Users/provider' });
        const windows = buildProviderEnvironment(undefined, {
            PATH: 'C:\\Windows\\System32',
            HOME: '/home/wrong-platform',
            USERPROFILE: 'C:\\Users\\provider',
            SystemRoot: 'C:\\Windows',
            GH_TOKEN: 'ambient-secret',
        }, 'win32');
        expect(windows).toEqual({
            PATH: 'C:\\Windows\\System32',
            SystemRoot: 'C:\\Windows',
            USERPROFILE: 'C:\\Users\\provider',
            NoDefaultCurrentDirectoryInExePath: '1',
        });
    });
    // Fork fix (win32): without SystemDrive a provider expanded `%SystemDrive%`
    // literally and created a `%SystemDrive%/` folder in the project cwd.
    it('passes the fixed Windows OS-identity variables through case-insensitively on win32 only', () => {
        const windowsIdentity = {
            SystemDrive: 'C:',
            windir: 'C:\\Windows',
            ProgramData: 'C:\\ProgramData',
            ProgramFiles: 'C:\\Program Files',
            'ProgramFiles(x86)': 'C:\\Program Files (x86)',
            ProgramW6432: 'C:\\Program Files',
            CommonProgramFiles: 'C:\\Program Files\\Common Files',
            COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
            PATHEXT: '.COM;.EXE;.BAT;.CMD',
            HOMEDRIVE: 'C:',
            HOMEPATH: '\\Users\\provider',
            APPDATA: 'C:\\Users\\provider\\AppData\\Roaming',
            LOCALAPPDATA: 'C:\\Users\\provider\\AppData\\Local',
            USERNAME: 'provider',
            USERDOMAIN: 'DOMAIN',
            COMPUTERNAME: 'HOST',
            NUMBER_OF_PROCESSORS: '8',
            PROCESSOR_ARCHITECTURE: 'AMD64',
            OS: 'Windows_NT',
            TEMP: 'C:\\Temp',
            TMP: 'C:\\Temp',
            PUBLIC: 'C:\\Users\\Public',
            ALLUSERSPROFILE: 'C:\\ProgramData',
        };
        const secrets = { COPILOT_GITHUB_TOKEN: 'ambient-secret', FOO_SECRET: 'ambient-secret', GH_TOKEN: 'ambient-secret' };
        const windows = buildProviderEnvironment(undefined, {
            PATH: 'C:\\Windows\\System32',
            SystemRoot: 'C:\\Windows',
            USERPROFILE: 'C:\\Users\\provider',
            ...windowsIdentity,
            ...secrets,
        }, 'win32');
        expect(windows).toEqual({
            PATH: 'C:\\Windows\\System32',
            SystemRoot: 'C:\\Windows',
            USERPROFILE: 'C:\\Users\\provider',
            ...windowsIdentity,
            NoDefaultCurrentDirectoryInExePath: '1',
        });
        const mixedCase = buildProviderEnvironment(undefined, {
            systemdrive: 'C:', Windir: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe',
            userprofile: 'C:\\Users\\provider', foo_secret: 'ambient-secret',
        }, 'win32');
        expect(mixedCase).toEqual({
            SystemDrive: 'C:', windir: 'C:\\Windows', COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
            USERPROFILE: 'C:\\Users\\provider', NoDefaultCurrentDirectoryInExePath: '1',
        });
        const posix = buildProviderEnvironment(undefined, {
            PATH: '/usr/bin:/bin', HOME: '/home/provider', ...windowsIdentity, ...secrets,
        }, 'linux');
        expect(posix).toEqual({ PATH: '/usr/bin:/bin', HOME: '/home/provider', TEMP: 'C:\\Temp', TMP: 'C:\\Temp' });
    });
    it('omits missing or empty ambient homes while preserving explicit overrides', () => {
        expect(buildProviderEnvironment(undefined, { PATH: '/usr/bin:/bin' }, 'linux'))
            .toEqual({ PATH: '/usr/bin:/bin' });
        expect(buildProviderEnvironment(undefined, {
            PATH: '/usr/bin:/bin', HOME: '', USERPROFILE: 'C:\\Users\\wrong-platform',
        }, 'linux')).toEqual({ PATH: '/usr/bin:/bin' });
        expect(buildProviderEnvironment(undefined, {
            PATH: 'C:\\Windows\\System32', USERPROFILE: '', HOME: '/home/wrong-platform',
        }, 'win32')).toEqual({ PATH: 'C:\\Windows\\System32', NoDefaultCurrentDirectoryInExePath: '1' });
        expect(buildProviderEnvironment({ HOME: '/home/explicit' }, {
            PATH: '/usr/bin:/bin', HOME: '/home/ambient',
        }, 'linux')).toMatchObject({ PATH: '/usr/bin:/bin', HOME: '/home/explicit' });
        expect(buildProviderEnvironment({ USERPROFILE: 'D:\\Users\\explicit' }, {
            PATH: 'C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\ambient',
        }, 'win32')).toMatchObject({ PATH: 'C:\\Windows\\System32', USERPROFILE: 'D:\\Users\\explicit' });
        expect(buildProviderEnvironment({ userprofile: 'D:\\Users\\mixed-case' }, {
            PATH: 'C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\ambient',
        }, 'win32')).toEqual({ PATH: 'C:\\Windows\\System32', userprofile: 'D:\\Users\\mixed-case', NoDefaultCurrentDirectoryInExePath: '1' });
        // A provider or ambient value, in any case, never turns the cwd search back on.
        expect(buildProviderEnvironment({ nodefaultcurrentdirectoryinexepath: '' }, {
            PATH: 'C:\\Windows\\System32', NODEFAULTCURRENTDIRECTORYINEXEPATH: '',
        }, 'win32')).toEqual({ PATH: 'C:\\Windows\\System32', NoDefaultCurrentDirectoryInExePath: '1' });
        expect(buildProviderEnvironment({ HOME: '' }, {
            PATH: '/usr/bin:/bin', HOME: '/home/ambient',
        }, 'linux')).toMatchObject({ PATH: '/usr/bin:/bin', HOME: '' });
    });
    it.runIf(process.platform !== 'win32' && Boolean(process.env.HOME) && existsSync('/bin/bash'))('passes HOME to a real set -u bash provider wrapper', async () => {
        const launchAttempt = await attempt();
        const marker = join(cwd, 'provider-home.txt');
        const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, ['/bin/bash', '--noprofile', '--norc', '-u', '-c', 'set -u; printf "%s" "$HOME" > "$1"; sleep 0.2', 'bash-provider', marker], cwd, { releaseAfterSpawn: true });
        expect(spec.provider_env).not.toHaveProperty('HOME');
        const bootstrap = runWorkerLaunchBootstrap(spec);
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: LAUNCH_WAIT_TIMEOUT_MS, pollIntervalMs: 5 }))
            .resolves.toEqual({ ok: true });
        await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
        await expect(readFile(marker, 'utf8')).resolves.toBe(process.env.HOME);
    });
    it('validates provider environment keys and propagates only explicit provider values', async () => {
        const launchAttempt = await attempt();
        expect(() => buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, {
            providerEnv: { 'BAD-KEY': 'value' },
        })).toThrow('worker_launch_provider_env_key_invalid');
        expect(() => buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, {
            providerEnv: { VALID_KEY: undefined },
        })).toThrow('worker_launch_provider_env_value_invalid');
        const internalEnv = { OMC_WORKER_LAUNCH_SPEC_FILE: 'must-be-filtered' };
        // win32 rejects internal launch keys outright instead of filtering them.
        if (IS_WIN) {
            expect(() => buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, {
                providerEnv: internalEnv,
            })).toThrow('worker_launch_provider_env_reserved');
        }
        const marker = join(cwd, 'provider-env.json');
        const providerScript = `require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({value:process.env.OMC_TEST_PROVIDER_VALUE,attempt:process.env.OMC_WORKER_LAUNCH_ATTEMPT_ID,internal:process.env.OMC_WORKER_LAUNCH_SPEC_FILE}));setTimeout(()=>process.exit(0),200)`;
        const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', providerScript], cwd, {
            providerEnv: {
                OMC_TEST_PROVIDER_VALUE: 'provider-value',
                OMC_WORKER_LAUNCH_ATTEMPT_ID: launchAttempt.attempt_id,
                ...(IS_WIN ? {} : internalEnv),
            },
            releaseAfterSpawn: true,
        }));
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: LAUNCH_WAIT_TIMEOUT_MS, pollIntervalMs: 5 }))
            .resolves.toEqual({ ok: true });
        await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
        await expect(readFile(marker, 'utf8').then(JSON.parse)).resolves.toEqual({
            value: 'provider-value',
            attempt: launchAttempt.attempt_id,
        });
    });
    it('preserves Claude secure-storage login and terminal colors through supervised launch', async () => {
        const launchAttempt = await attempt();
        const envKeys = ['CLAUDE_SECURESTORAGE_CONFIG_DIR', 'TERM', 'COLORTERM'];
        const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
        process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = join(cwd, 'claude-secure-storage');
        process.env.TERM = 'xterm-256color';
        process.env.COLORTERM = 'truecolor';
        try {
            const workerEnv = getWorkerEnv('launch-team', 'worker-1', 'claude', process.env);
            const marker = join(cwd, 'claude-worker-env.json');
            const providerScript = `require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({secureStorage:process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,term:process.env.TERM,color:process.env.COLORTERM}));setTimeout(()=>process.exit(0),200)`;
            const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', providerScript], cwd, { providerEnv: workerEnv, releaseAfterSpawn: true }));
            await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
                timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
                pollIntervalMs: 5,
            })).resolves.toEqual({ ok: true });
            await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
            await expect(readFile(marker, 'utf8').then(JSON.parse)).resolves.toEqual({
                secureStorage: join(cwd, 'claude-secure-storage'),
                term: 'xterm-256color',
                color: 'truecolor',
            });
        }
        finally {
            for (const key of envKeys) {
                const value = saved[key];
                if (value === undefined)
                    delete process.env[key];
                else
                    process.env[key] = value;
            }
        }
    });
    it('rejects provider environment tampering through the authority digest', async () => {
        const launchAttempt = await attempt();
        const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, {
            providerEnv: { HOME: '/home/authority-original' },
        });
        const tampered = {
            ...spec,
            provider_env: { ...spec.provider_env, HOME: '/home/authority-tampered' },
        };
        expect(tampered.authority_digest).toBe(spec.authority_digest);
        await expect(runWorkerLaunchBootstrap(tampered)).resolves.toEqual({ outcome: 'invalid_spec' });
    });
    it('binds the authority digest to the immutable instance identity', async () => {
        const launchAttempt = await attempt();
        const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd);
        const tampered = {
            ...spec,
            instance_id: randomUUID(),
        };
        await expect(runWorkerLaunchBootstrap(tampered)).resolves.toEqual({ outcome: 'invalid_spec' });
    });
    it('routes native Windows batch shims through an argv-free temporary wrapper without changing POSIX argv', async () => {
        const providerArgv = [
            'C:\\Program Files\\Codex\\codex.cmd',
            '--label=100% ready',
            '--home=%USERPROFILE%',
            '--encoded=%25',
            'say "hello" & continue',
            '--literal=bang! caret^',
        ];
        vi.stubEnv('SystemRoot', 'C:\\Windows'); // a win32 host reads SystemRoot from process.env
        const windowsInvocation = buildProviderSpawnInvocation(providerArgv, 'win32', { SystemRoot: 'C:\\Windows' });
        const [lineVar] = Object.keys(windowsInvocation.env ?? {});
        expect(lineVar).toMatch(/^_OMC_PL_[0-9A-F]{16}$/);
        expect(windowsInvocation).toEqual({
            command: 'C:\\Windows\\System32\\cmd.exe',
            args: ['/d', '/v:off', '/s', '/c'],
            batchScript: `@echo off\r\nif not defined ${lineVar} exit /b 87\r\n"C:\\Windows\\System32\\cmd.exe" /d /v:off /s /c "set "${lineVar}=" & %%${lineVar}%%"\r\n`,
            env: {
                [lineVar]: '"C:\\Program Files\\Codex\\codex.cmd" "--label=100% ready" "--home=%USERPROFILE%" "--encoded=%25" "say ""hello"" & continue" "--literal=bang! caret^"',
                NoDefaultCurrentDirectoryInExePath: '1',
            },
        });
        // Each launch gets its own variable name, so an inherited value never matches.
        expect(Object.keys(buildProviderSpawnInvocation(providerArgv, 'win32', { SystemRoot: 'C:\\Windows' }).env ?? {}))
            .not.toEqual([lineVar]);
        const materialized = await materializeProviderSpawnInvocation(windowsInvocation);
        expect(materialized.windowsVerbatimArguments).toBe(true);
        expect(materialized.env).toEqual(windowsInvocation.env);
        const wrapperPath = materialized.args[4].slice(2, -2);
        await expect(readFile(wrapperPath, 'utf8')).resolves.toBe(windowsInvocation.batchScript);
        await materialized.cleanup();
        await expect(readFile(wrapperPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        const supervised = await materializeProviderSpawnInvocation(windowsInvocation, { superviseWindowsTree: true });
        expect(supervised.completionPath).toBeTruthy();
        await expect(readFile(supervised.args[4].slice(2, -2), 'utf8')).resolves.toContain(':omc_hold');
        await expect(readFile(supervised.args[4].slice(2, -2), 'utf8')).resolves.toContain('provider-exit.txt');
        await supervised.cleanup();
        expect(buildProviderSpawnInvocation(providerArgv, 'linux')).toEqual({
            command: providerArgv[0],
            args: providerArgv.slice(1),
        });
        expect(buildProviderSpawnInvocation(['C:\\Tools\\codex.exe', '--version'], 'win32', { SystemRoot: 'C:\\Windows' }))
            .toEqual({ command: 'C:\\Tools\\codex.exe', args: ['--version'] });
        expect(buildProviderSpawnInvocation(['C:\\Tools\\CODEX.COM', '100%'], 'win32', { SystemRoot: 'C:\\Windows' }))
            .toEqual({ command: 'C:\\Tools\\CODEX.COM', args: ['100%'] });
        // A bare name or a trailing-dot batch path keeps the cmd route.
        for (const command of ['codex', 'C:\\Tools\\codex.cmd.', 'C:\\Tools\\CODEX.BAT']) {
            expect(buildProviderSpawnInvocation([command], 'win32', { SystemRoot: 'C:\\Windows' }))
                .toMatchObject({ command: 'C:\\Windows\\System32\\cmd.exe', batchScript: expect.any(String) });
        }
    });
    it('pins the batch wrapper cmd under SystemRoot and ignores ComSpec', () => {
        const argv = ['C:\\Tools\\provider.cmd', 'x'];
        // A win32 host reads SystemRoot from process.env and other hosts from the caller env, so set both.
        vi.stubEnv('SystemRoot', 'D:\\Win\\');
        try {
            const invocation = buildProviderSpawnInvocation(argv, 'win32', { ComSpec: process.execPath, SystemRoot: 'D:\\Win\\' });
            expect(invocation.command).toBe('D:\\Win\\System32\\cmd.exe');
            expect(invocation.batchScript).toContain('\r\n"D:\\Win\\System32\\cmd.exe" /d /v:off /s /c ');
            expect(invocation.batchScript).not.toContain(process.execPath);
            // A missing or non-absolute SystemRoot fails closed instead of searching for cmd.exe.
            for (const root of ['', 'Windows', '\\\\server\\share', 'C:\\%X%']) {
                vi.stubEnv('SystemRoot', root);
                expect(() => buildProviderSpawnInvocation(argv, 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe', SystemRoot: root })).toThrow('worker_launch_cmd_authority_missing');
            }
        }
        finally {
            vi.unstubAllEnvs();
        }
    });
    it('rejects control characters and over-long lines in native Windows batch arguments', async () => {
        const comSpec = { SystemRoot: 'C:\\Windows' };
        for (let code = 0; code < 0x20; code++) {
            expect(() => buildProviderSpawnInvocation(['C:\\Tools\\provider.cmd', `x${String.fromCharCode(code)}y`], 'win32', comSpec))
                .toThrow('worker_launch_provider_argv_invalid');
        }
        expect(() => buildProviderSpawnInvocation(['C:\\Tools\\provider.cmd', 'A'.repeat(8000)], 'win32', comSpec))
            .toThrow('worker_launch_provider_argv_too_long');
        expect(Object.values(buildProviderSpawnInvocation(['C:\\Tools\\provider.cmd', 'A'.repeat(7900)], 'win32', comSpec).env ?? {}))
            .toEqual([`"C:\\Tools\\provider.cmd" "${'A'.repeat(7900)}"`, '1']);
        // The bootstrap spec refuses the same argv before the supervisor runs.
        const launchAttempt = await attempt();
        expect(() => buildWorkerLaunchBootstrapSpec(launchAttempt, ['C:\\Tools\\provider.cmd', 'x\x1Ay'], cwd, { platform: 'win32' }))
            .toThrow('worker_launch_provider_argv_invalid');
        expect(() => buildWorkerLaunchBootstrapSpec(launchAttempt, ['C:\\Tools\\provider.bat', 'A'.repeat(8000)], cwd, { platform: 'win32' }))
            .toThrow('worker_launch_provider_argv_too_long');
        expect(() => buildWorkerLaunchBootstrapSpec(launchAttempt, ['C:\\Tools\\provider.cmd', 'x\x1Ay'], cwd, { platform: 'linux' }))
            .not.toThrow();
    });
    it('cleans up a temporary provider wrapper when wrapper write fails', async () => {
        vi.resetModules();
        const actualFs = await vi.importActual('node:fs/promises');
        const rmMock = vi.fn(actualFs.rm);
        const writeFileMock = vi.fn(async (path, ...args) => {
            if (String(path).endsWith('launch.cmd'))
                throw new Error('synthetic write failure');
            return actualFs.writeFile(path, ...args);
        });
        vi.doMock('node:fs/promises', () => ({ ...actualFs, rm: rmMock, writeFile: writeFileMock }));
        try {
            const workerLaunch = await import('../worker-launch-ack.js');
            await expect(workerLaunch.materializeProviderSpawnInvocation({
                command: 'cmd.exe', args: ['/d', '/v:off', '/s', '/c'], batchScript: '@echo off\r\n',
            })).rejects.toThrow('synthetic write failure');
            expect(rmMock).toHaveBeenCalledWith(expect.stringContaining('omc-provider-'), { recursive: true, force: true });
        }
        finally {
            vi.doUnmock('node:fs/promises');
            vi.resetModules();
        }
    });
    it('materializes POSIX supervision without changing direct provider argv', async () => {
        cwd = await createFixture('worker-launch-posix-supervisor-');
        const invocation = await materializeProviderSpawnInvocation(buildProviderSpawnInvocation(['/usr/bin/codex', '--prompt', 'literal & value'], 'linux'), { superviseProcessTree: true });
        expect(invocation.command).toBe('/bin/sh');
        expect(invocation.args.slice(1)).toEqual(['/usr/bin/codex', '--prompt', 'literal & value']);
        expect(invocation.completionPath).toBeTruthy();
        await expect(readFile(invocation.args[0], 'utf8')).resolves.toContain('"$@"');
        await invocation.cleanup();
        const gated = await materializeProviderSpawnInvocation(buildProviderSpawnInvocation(['/usr/bin/codex', '--prompt', 'literal & value'], 'linux'), { superviseProcessTree: true, gateProviderExecution: true });
        expect(gated.providerGateFd).toBe(3);
        await expect(readFile(gated.args[0], 'utf8')).resolves.toContain('<&3');
        await gated.cleanup();
    });
    it.runIf(process.platform !== 'win32')('proves gated providers retain stdio and see fd3 closed', async () => {
        cwd = await createFixture('worker-launch-posix-fd-contract-');
        const providerScript = [
            'IFS= read -r message',
            'printf "stdin:%s\\n" "$message"',
            'printf "stdout:preserved\\n"',
            'printf "stderr:preserved\\n" >&2',
            'if ( : >&3 ) 2>/dev/null; then printf "fd3:open\\n" >&2; else printf "fd3:closed\\n" >&2; fi',
            'exit 0',
        ].join(';');
        const invocation = await materializeProviderSpawnInvocation(buildProviderSpawnInvocation(['/bin/sh', '-c', providerScript], 'linux'), { superviseProcessTree: true, gateProviderExecution: true });
        let child;
        let ownedGroup = null;
        let childExit;
        let stdout = '';
        let stderr = '';
        try {
            child = spawn(invocation.command, invocation.args, {
                cwd,
                stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
                detached: true,
            });
            child.stdout?.setEncoding('utf8');
            child.stdout?.on('data', chunk => { stdout += String(chunk); });
            child.stderr?.setEncoding('utf8');
            child.stderr?.on('data', chunk => { stderr += String(chunk); });
            childExit = new Promise((resolve, reject) => {
                child.once('exit', () => resolve());
                child.once('error', reject);
            });
            await new Promise((resolve, reject) => {
                child.once('spawn', () => resolve());
                child.once('error', reject);
            });
            ownedGroup = captureOwnedProcessGroup(child.pid);
            expect(ownedGroup).not.toBeNull();
            expect(invocation.providerGateFd).toBe(3);
            const gate = child.stdio[invocation.providerGateFd];
            const gateErrors = [];
            gate.on('error', error => { gateErrors.push(error); });
            child.stdin?.write('descriptor-message\n');
            await new Promise((resolve, reject) => {
                gate.end('release\n', () => resolve());
                if (gateErrors.length > 0)
                    reject(gateErrors[0]);
            });
            expect(gateErrors).toHaveLength(0);
            await vi.waitFor(() => {
                expect(stdout).toContain('stdin:descriptor-message\n');
                expect(stdout).toContain('stdout:preserved\n');
                expect(stderr).toContain('stderr:preserved\n');
                expect(stderr).toContain('fd3:closed\n');
                expect(stderr).not.toContain('fd3:open\n');
            }, { timeout: 2_000, interval: 5 });
            await vi.waitFor(async () => {
                await expect(readFile(invocation.completionPath, 'utf8')).resolves.toMatch(/^0\s*$/);
            }, { timeout: 2_000, interval: 5 });
        }
        finally {
            if (ownedGroup) {
                await terminateOwnedProcessGroup({
                    pid: ownedGroup.pid,
                    expectedStartIdentity: ownedGroup.processStartIdentity,
                    processGroupId: ownedGroup.processGroupId,
                    deadlineAt: new Date(Date.now() + 2_000).toISOString(),
                    force: true,
                }).catch(() => 'unknown');
            }
            await childExit?.catch(() => undefined);
            if (ownedGroup) {
                await vi.waitFor(() => {
                    expect(() => process.kill(-ownedGroup.processGroupId, 0))
                        .toThrow(expect.objectContaining({ code: 'ESRCH' }));
                }, { timeout: 2_000, interval: 20 });
            }
            await invocation.cleanup();
        }
    });
    it.runIf(process.platform === 'win32')('distinguishes provider starts created within the same wall-clock second', async () => {
        const first = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)']);
        const second = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)']);
        await Promise.all([
            new Promise((resolve, reject) => { first.once('spawn', resolve); first.once('error', reject); }),
            new Promise((resolve, reject) => { second.once('spawn', resolve); second.once('error', reject); }),
        ]);
        try {
            const [firstIdentity, secondIdentity] = await Promise.all([
                getProcessStartIdentity(first.pid), getProcessStartIdentity(second.pid),
            ]);
            expect(firstIdentity).toMatch(/^(dmtf|ticks):/);
            expect(secondIdentity).toMatch(/^(dmtf|ticks):/);
            expect(firstIdentity).not.toBe(secondIdentity);
        }
        finally {
            first.kill('SIGKILL');
            second.kill('SIGKILL');
        }
    });
    it.runIf(process.platform === 'win32').each(['cmd', 'bat'])('round-trips native .%s arguments through a real batch shim', async (extension) => {
        cwd = await createFixture(`worker-launch-native-${extension}-`);
        const providerPath = join(cwd, `provider.${extension}`);
        const outputPath = join(cwd, 'argv.json');
        const canaryPath = join(cwd, 'injected.txt');
        // The provider records its argv and whether the wrapper's line variable
        // leaked into its environment, then exits 7 so the exit code is proven to
        // propagate through both cmd layers.
        await writeFile(providerPath, `@echo off\r\n"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1],JSON.stringify({argv:process.argv.slice(2),leaked:Object.keys(process.env).some(k=>k.toUpperCase().startsWith('_OMC_P'))}));process.exit(7)" %*\r\n`, 'utf8');
        const injection = `echo pwned>"${canaryPath}"`;
        const payload = [
            '100% ready', '%USERPROFILE%', '%PATH:~0,1%', 'bang!', '!PATH!', 'caret^', '^', 'say "hello" & continue', 'two words',
            `& ${injection}`, `| ${injection}`, `a" & ${injection} & "b`, `a\\" & ${injection} & \\"`, `"" & ${injection}`,
            '<', '>', '(x)', '"', '""', '', 'trail\\', 'C:\\dir with space\\', 'x\\\\"y',
        ];
        const invocation = await materializeProviderSpawnInvocation(buildProviderSpawnInvocation([providerPath, outputPath, ...payload], 'win32', { SystemRoot: process.env.SystemRoot }));
        const exitCode = await new Promise((resolve, reject) => {
            const child = spawn(invocation.command, invocation.args, {
                stdio: 'pipe', windowsVerbatimArguments: invocation.windowsVerbatimArguments, env: { ...process.env, ...invocation.env },
            });
            child.once('error', reject);
            child.once('exit', code => resolve(code));
        });
        expect(exitCode).toBe(7);
        await expect(readFile(outputPath, 'utf8').then(JSON.parse)).resolves.toEqual({ argv: payload, leaked: false });
        expect(existsSync(canaryPath)).toBe(false);
        const wrapperPath = invocation.args[4].slice(2, -2);
        await expect(readFile(wrapperPath, 'utf8')).resolves.not.toContain('injected.txt');
        await invocation.cleanup();
        await expect(readFile(wrapperPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
    describe.runIf(process.platform === 'win32')('native Windows batch provider hardening', () => {
        async function runBatchProvider(providerDir, payload) {
            await mkdir(providerDir, { recursive: true });
            const providerPath = join(providerDir, 'provider.cmd');
            const outputPath = join(cwd, 'argv.json');
            await writeFile(providerPath, `@echo off\r\n"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1],JSON.stringify({argv:process.argv.slice(2),leaked:Object.keys(process.env).some(k=>k.toUpperCase().startsWith('_OMC_P'))}))" %*\r\n`, 'utf8');
            const invocation = await materializeProviderSpawnInvocation(buildProviderSpawnInvocation([providerPath, outputPath, ...payload], 'win32', { SystemRoot: process.env.SystemRoot }));
            try {
                const exitCode = await new Promise((resolve, reject) => {
                    const child = spawn(invocation.command, invocation.args, {
                        stdio: 'pipe', windowsVerbatimArguments: invocation.windowsVerbatimArguments, env: { ...process.env, ...invocation.env },
                    });
                    child.once('error', reject);
                    child.once('exit', code => resolve(code));
                });
                return { exitCode, output: JSON.parse(await readFile(outputPath, 'utf8')) };
            }
            finally {
                await invocation.cleanup();
            }
        }
        it('rejects Ctrl-Z payloads before any wrapper runs', async () => {
            cwd = await createFixture('worker-launch-native-ctrlz-');
            const canaryPath = join(cwd, 'injected.txt');
            const injection = `echo pwned>>"${canaryPath}"`;
            for (const payload of [[`x\x1A${injection} & rem "`], [`\x1A${injection}`], [`a\x1A"`, `${injection} & rem `]]) {
                await expect(runBatchProvider(join(cwd, 'bin'), payload)).rejects.toThrow('worker_launch_provider_argv_invalid');
                expect(existsSync(canaryPath)).toBe(false);
            }
        });
        it('rejects payloads past the cmd line limit instead of splitting them', async () => {
            cwd = await createFixture('worker-launch-native-long-');
            const canaryPath = join(cwd, 'injected.txt');
            const injection = `echo pwned>>"${canaryPath}"`;
            for (const payload of [['A'.repeat(8191 - 60) + `" & ${injection} & "`], ['A'.repeat(8180), `B & ${injection} & rem `]]) {
                await expect(runBatchProvider(join(cwd, 'bin'), payload)).rejects.toThrow('worker_launch_provider_argv_too_long');
                expect(existsSync(canaryPath)).toBe(false);
            }
            // A line just under the cap still arrives intact.
            const near = ['A'.repeat(7700), 'two words'];
            await expect(runBatchProvider(join(cwd, 'bin'), near)).resolves.toEqual({ exitCode: 0, output: { argv: near, leaked: false } });
        });
        it('round-trips non-ASCII arguments and a non-ASCII provider path exactly', async () => {
            cwd = await createFixture('worker-launch-native-unicode-');
            const payload = ['åäö ü 漢字', '“quoted”', 'a＂ & b'];
            await expect(runBatchProvider(join(cwd, 'bin åäö 漢字'), payload)).resolves.toEqual({ exitCode: 0, output: { argv: payload, leaked: false } });
        });
        it('spawns an .exe provider directly so cmd never sees its arguments', async () => {
            cwd = await createFixture('worker-launch-native-exe-');
            const outputPath = join(cwd, 'argv.json');
            const payload = ['%USERPROFILE%', '100% ready', 'a" & echo x & "b', '!PATH!', 'åäö'];
            const invocation = buildProviderSpawnInvocation([process.execPath, '-e', "require('fs').writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2)))", outputPath, ...payload], 'win32', { SystemRoot: process.env.SystemRoot });
            expect(invocation).toEqual({ command: process.execPath, args: expect.any(Array) });
            await new Promise((resolve, reject) => {
                const child = spawn(invocation.command, invocation.args, { stdio: 'ignore' });
                child.once('error', reject);
                child.once('exit', () => resolve());
            });
            await expect(readFile(outputPath, 'utf8').then(JSON.parse)).resolves.toEqual(payload);
        });
        it('runs a .cmd provider through the supervisor without cmd reparsing its arguments', async () => {
            const launchAttempt = await attempt();
            const providerDir = join(cwd, 'bin åäö');
            await mkdir(providerDir, { recursive: true });
            const providerPath = join(providerDir, 'provider.cmd');
            const outputPath = join(cwd, 'argv.json');
            const canaryPath = join(cwd, 'injected.txt');
            await writeFile(providerPath, `@echo off\r\n"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1],JSON.stringify({argv:process.argv.slice(2),leaked:Object.keys(process.env).some(k=>k.toUpperCase().startsWith('_OMC_P'))}));process.exit(7)" %*\r\n`, 'utf8');
            const payload = [
                `--deny-tool=x" & echo pwned>"${canaryPath}" & rem "`, `a b & echo pwned>"${canaryPath}"`, `x\\" & echo pwned>"${canaryPath}" & \\"`,
                'hello world', 'say "hi"', '%USERPROFILE%', '100% ready', '!PATH!', '^', '', 'trail\\', 'åäö ü 漢字',
            ];
            const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, [providerPath, outputPath, ...payload], cwd);
            const bootstrap = runWorkerLaunchBootstrap(spec);
            await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: LAUNCH_WAIT_TIMEOUT_MS, pollIntervalMs: 5 }))
                .resolves.toEqual({ ok: true });
            await expect(bootstrap).resolves.toMatchObject({ outcome: 'ran' });
            await expect(readFile(outputPath, 'utf8').then(JSON.parse)).resolves.toEqual({ argv: payload, leaked: false });
            expect(existsSync(canaryPath)).toBe(false);
        }, 30_000);
        it('refuses to run the wrapper when the spawn env lacks its line variable', async () => {
            cwd = await createFixture('worker-launch-native-noline-');
            const providerPath = join(cwd, 'provider.cmd');
            const outputPath = join(cwd, 'argv.json');
            const canaryPath = join(cwd, 'injected.txt');
            await writeFile(providerPath, `@echo off\r\n"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1],'ran')" %*\r\n`, 'utf8');
            const invocation = await materializeProviderSpawnInvocation(buildProviderSpawnInvocation([providerPath, outputPath], 'win32', { SystemRoot: process.env.SystemRoot }));
            try {
                // An inherited fixed-name line from older builds must never stand in for the per-launch one.
                const exitCode = await new Promise((resolve, reject) => {
                    const child = spawn(invocation.command, invocation.args, {
                        stdio: 'pipe', windowsVerbatimArguments: invocation.windowsVerbatimArguments,
                        env: { ...process.env, _OMC_PROVIDER_LINE: `echo pwned>"${canaryPath}"` },
                    });
                    child.once('error', reject);
                    child.once('exit', code => resolve(code));
                });
                expect(exitCode).toBe(87);
                expect(existsSync(outputPath)).toBe(false);
                expect(existsSync(canaryPath)).toBe(false);
            }
            finally {
                await invocation.cleanup();
            }
        });
        it.each([
            ['filters a case-variant pre-set provider-line variable', (canaryPath) => ({ _omc_provider_line: `echo pwned>"${canaryPath}"` })],
            ['ignores a provider_env ComSpec', () => ({ ComSpec: process.execPath })],
        ])('supervisor %s', async (_name, providerEnvFor) => {
            const launchAttempt = await attempt();
            const providerPath = join(cwd, 'provider.cmd');
            const outputPath = join(cwd, 'argv.json');
            const canaryPath = join(cwd, 'injected.txt');
            await writeFile(providerPath, `@echo off\r\n"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1],JSON.stringify({argv:process.argv.slice(2),leaked:Object.keys(process.env).some(k=>k.toUpperCase().startsWith('_OMC_P'))}))" %*\r\n`, 'utf8');
            const payload = ['hello world', '100% ready'];
            const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, [providerPath, outputPath, ...payload], cwd, { providerEnv: providerEnvFor(canaryPath) });
            const bootstrap = runWorkerLaunchBootstrap(spec);
            await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: LAUNCH_WAIT_TIMEOUT_MS, pollIntervalMs: 5 }))
                .resolves.toEqual({ ok: true });
            await expect(bootstrap).resolves.toMatchObject({ outcome: 'ran' });
            await expect(readFile(outputPath, 'utf8').then(JSON.parse)).resolves.toEqual({ argv: payload, leaked: false });
            expect(existsSync(canaryPath)).toBe(false);
        }, 30_000);
    });
    describe('Windows providers never run a program planted in the worker cwd', () => {
        // These need real cmd.exe: its cwd-before-PATH search is the behaviour under test.
        const needsCmd = process.platform !== 'win32';
        // An npm cmd-shim installed without a node.exe beside it (the normal global
        // install) falls back to `_prog=node` and runs `"%_prog%"`, which cmd.exe
        // resolves in the current directory before PATH.
        async function plantNpmShim() {
            const shimDir = join(cwd, 'npm-global');
            await mkdir(shimDir, { recursive: true });
            const outputPath = join(cwd, 'real-node.txt');
            const canaryPath = join(cwd, 'planted-node-ran.txt');
            const envPath = join(cwd, 'provider-nodefault.txt');
            await writeFile(join(shimDir, 'provider.js'), "require('fs').writeFileSync(process.argv[2], 'real-node')\n", 'utf8');
            await writeFile(join(shimDir, 'provider.cmd'), [
                '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
                `>"${envPath}" echo(%NoDefaultCurrentDirectoryInExePath%`,
                'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')',
                'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\provider.js" %*', '',
            ].join('\r\n'), 'utf8');
            await writeFile(join(cwd, 'node.cmd'), `@echo off\r\necho pwned>"${canaryPath}"\r\n`, 'utf8');
            return { shimPath: join(shimDir, 'provider.cmd'), outputPath, canaryPath, envPath };
        }
        // node.exe under a planted name runs its first argument as a script.
        async function plantNodeAs(name, canaryPath) {
            const scriptPath = join(cwd, `${name}-canary.js`);
            await writeFile(scriptPath, `require('fs').appendFileSync(${JSON.stringify(canaryPath)}, ${JSON.stringify(name)})\n`, 'utf8');
            await link(process.execPath, join(cwd, name)).catch(() => copyFile(process.execPath, join(cwd, name)));
            return scriptPath;
        }
        it.skipIf(needsCmd).each([
            ['no provider value', {}],
            ['an empty provider value', { NoDefaultCurrentDirectoryInExePath: '' }],
            ['an empty case-variant provider value', { nodefaultcurrentdirectoryinexepath: '' }],
        ])('supervisor runs the real node from PATH with %s', async (_name, providerEnv) => {
            const launchAttempt = await attempt();
            const { shimPath, outputPath, canaryPath, envPath } = await plantNpmShim();
            const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, [shimPath, outputPath], cwd, { providerEnv });
            const bootstrap = runWorkerLaunchBootstrap(spec);
            await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: LAUNCH_WAIT_TIMEOUT_MS, pollIntervalMs: 5 }))
                .resolves.toEqual({ ok: true });
            await expect(bootstrap).resolves.toMatchObject({ outcome: 'ran' });
            expect(existsSync(canaryPath)).toBe(false);
            await expect(readFile(outputPath, 'utf8')).resolves.toBe('real-node');
            expect((await readFile(envPath, 'utf8')).trim()).toBe('1');
        }, 30_000);
        it.skipIf(needsCmd)('supervisor runs an .exe provider whose children never run a git planted in the cwd', async () => {
            const launchAttempt = await attempt();
            const canaryPath = join(cwd, 'planted-git-ran.txt');
            const envPath = join(cwd, 'provider-nodefault.txt');
            await writeFile(join(cwd, 'git.cmd'), `@echo off\r\necho git.cmd>>"${canaryPath}"\r\n`, 'utf8');
            const gitScript = await plantNodeAs('git.exe', canaryPath);
            const providerScript = join(cwd, 'exe-provider.js');
            // A bare `git` through cmd.exe (execSync) and through Node's own search (spawnSync).
            await writeFile(providerScript, [
                "const { execSync, spawnSync } = require('child_process');",
                "try { execSync('git --version', { stdio: 'ignore' }); } catch {}",
                `spawnSync('git', [${JSON.stringify(gitScript)}], { stdio: 'ignore' });`,
                `require('fs').writeFileSync(${JSON.stringify(envPath)}, String(process.env.NoDefaultCurrentDirectoryInExePath));`,
                '',
            ].join('\n'), 'utf8');
            const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, providerScript], cwd);
            const bootstrap = runWorkerLaunchBootstrap(spec);
            await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: LAUNCH_WAIT_TIMEOUT_MS, pollIntervalMs: 5 }))
                .resolves.toEqual({ ok: true });
            await expect(bootstrap).resolves.toMatchObject({ outcome: 'ran' });
            expect(existsSync(canaryPath) ? await readFile(canaryPath, 'utf8') : '').toBe('');
            await expect(readFile(envPath, 'utf8')).resolves.toBe('1');
        }, 60_000);
        it.skipIf(needsCmd)('activation-gate wrapper runs the real node from PATH', async () => {
            cwd = await createFixture('worker-launch-native-cwd-hijack-');
            const { shimPath, outputPath, canaryPath, envPath } = await plantNpmShim();
            const invocation = await materializeProviderSpawnInvocation(buildProviderSpawnInvocation([shimPath, outputPath], 'win32', { SystemRoot: process.env.SystemRoot }));
            // The host may already set the variable (Claude Code does); the wrapper must not rely on it.
            const ambient = Object.fromEntries(Object.entries(process.env)
                .filter(([key]) => key.toUpperCase() !== 'NODEFAULTCURRENTDIRECTORYINEXEPATH'));
            try {
                await new Promise((resolve, reject) => {
                    const child = spawn(invocation.command, invocation.args, {
                        cwd, stdio: 'pipe', windowsVerbatimArguments: invocation.windowsVerbatimArguments, env: { ...ambient, ...invocation.env },
                    });
                    child.once('error', reject);
                    child.once('exit', () => resolve());
                });
            }
            finally {
                await invocation.cleanup();
            }
            expect(existsSync(canaryPath)).toBe(false);
            await expect(readFile(outputPath, 'utf8')).resolves.toBe('real-node');
            expect((await readFile(envPath, 'utf8')).trim()).toBe('1');
        });
        it.skipIf(needsCmd)('supervisor refuses an argv[0] that is not an existing fully qualified path', async () => {
            const launchAttempt = await attempt();
            const canaryPath = join(cwd, 'cwd-provider-ran.txt');
            for (const name of ['x.cmd', 'provider.cmd']) {
                await writeFile(join(cwd, name), `@echo off\r\necho pwned>>"${canaryPath}"\r\n`, 'utf8');
            }
            // CreateProcessW searches the cwd for a bare or drive-relative native name too.
            const exeScript = await plantNodeAs('x.exe', canaryPath);
            for (const argv0 of [
                'provider.cmd', 'C:x.cmd', '.\\x.cmd', join(cwd, 'missing', 'x.cmd'),
                'x', 'x.exe', 'C:x.exe', '.\\x.exe', join(cwd, 'missing', 'x.exe'),
            ]) {
                const invocation = buildWindowsSupervisorInvocation(buildWorkerLaunchBootstrapSpec(launchAttempt, [argv0, exeScript], cwd));
                const child = spawn(invocation.command, invocation.args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
                let stderr = '';
                child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
                child.stdout.resume();
                child.stdin.end(`${invocation.stdinPayload}\n`);
                const exitCode = await new Promise((resolve, reject) => {
                    child.once('error', reject);
                    child.once('exit', code => resolve(code));
                });
                expect(exitCode, argv0).not.toBe(0);
                expect(stderr, argv0).toContain('worker_launch_provider_executable_invalid');
                expect(existsSync(canaryPath), argv0).toBe(false);
            }
        }, 60_000);
    });
    it.runIf(process.platform === 'win32')('holds a supervisor root after an early-exit provider and terminates the root with its live descendants', async () => {
        cwd = await createFixture('worker-launch-native-supervisor-');
        const providerPath = join(cwd, 'early-provider.cmd');
        const orphanPidPath = join(cwd, 'early-provider-orphan.pid');
        // `start /b` leaves a descendant that outlives the provider's exit.
        await writeFile(providerPath, `@echo off\r\nstart "" /b "${process.execPath}" -e "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)" "${orphanPidPath}"\r\n`, 'utf8');
        const invocation = await materializeProviderSpawnInvocation(buildProviderSpawnInvocation([providerPath], 'win32', { SystemRoot: process.env.SystemRoot }), { superviseWindowsTree: true });
        const supervisor = spawn(invocation.command, invocation.args, {
            stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments, env: { ...process.env, ...invocation.env },
        });
        const childrenOf = (pid) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8' })
            .split(/\s+/).filter(Boolean).map(Number);
        let orphanPid = 0;
        try {
            await expect.poll(async () => invocation.completionPath ? await readFile(invocation.completionPath, 'utf8').catch(() => '') : '', { timeout: scaleTiming(5_000), interval: 20 }).toMatch(/0/);
            await expect.poll(async () => Number(await readFile(orphanPidPath, 'utf8').catch(() => '0')), { timeout: scaleTiming(5_000), interval: 20 }).toBeGreaterThan(0);
            orphanPid = Number(await readFile(orphanPidPath, 'utf8'));
            // The provider has exited but its descendant is still running, and the
            // wrapper root is holding with its own live descendant (the hold loop).
            expect(isProcessAlive(orphanPid)).toBe(true);
            expect(isProcessAlive(supervisor.pid)).toBe(true);
            const rootDescendants = childrenOf(supervisor.pid);
            expect(rootDescendants.length).toBeGreaterThan(0);
            expect(rootDescendants.every(isProcessAlive)).toBe(true);
            const identity = await getProcessStartIdentity(supervisor.pid);
            expect(identity).toBeTruthy();
            await expect(terminateOwnedProcessTree({ pid: supervisor.pid, expectedStartIdentity: identity,
                deadlineAt: new Date(Date.now() + 5_000).toISOString(), force: true })).resolves.toBe('terminated');
            await expect.poll(() => isProcessAlive(supervisor.pid), { timeout: scaleTiming(2_000), interval: 20 }).toBe(false);
            await expect.poll(() => rootDescendants.some(isProcessAlive), { timeout: scaleTiming(2_000), interval: 20 }).toBe(false);
            // The provider's own descendant is an orphan (its parent exited), which
            // this parent-PID walk cannot reach: a known Windows gap, recorded in
            // .omc/skills/windows-test-conventions.md. It is killed below instead.
        }
        finally {
            if (orphanPid > 0) {
                try {
                    process.kill(orphanPid);
                }
                catch { /* already gone */ }
            }
            supervisor.kill();
            await invocation.cleanup();
        }
    });
    it('rejects CRLF-bearing native Windows batch arguments before materializing a wrapper', () => {
        expect(() => buildProviderSpawnInvocation(['C:\\Tools\\provider.cmd', '--prompt=line one\r\nwhoami'], 'win32', { SystemRoot: 'C:\\Windows' })).toThrow('worker_launch_provider_argv_invalid');
    });
    it('excludes ambient secret environment values and rejects Windows aliases', async () => {
        const launchAttempt = await attempt();
        const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, { providerEnv: { EXPLICIT: 'yes' } });
        for (const key of ['GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'HTTPS_PROXY']) {
            expect(spec.provider_env).not.toHaveProperty(key);
        }
        const platform = 'win32';
        expect(() => buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, {
            providerEnv: { OMC_WORKER_LAUNCH_SPEC_FILE: 'x' }, platform,
        })).toThrow('worker_launch_provider_env_reserved');
        expect(() => buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, {
            providerEnv: { PATH: 'one', Path: 'two' }, platform,
        })).toThrow('worker_launch_provider_env_key_alias_conflict');
        expect(() => buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, {
            providerEnv: { SystemRoot: 'D:\\attacker' }, platform,
        })).toThrow('worker_launch_provider_env_reserved');
        expect(() => buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, {
            providerEnv: { SYSTEMROOT: 'D:\\attacker' }, platform,
        })).toThrow('worker_launch_provider_env_reserved');
    });
    it('binds the Windows supervisor source, environment, Job Object, and argv protocol', () => {
        const source = buildWindowsSupervisorSource();
        // Fork: the fork keeps its own supervisor (CreateProcessW with the pane
        // console and .cmd/.bat via cmd.exe), not upstream's CreateConsoleProcess.
        const create = source.indexOf('CreateProcessW(');
        const assign = source.indexOf('AssignProcessToJobObject(');
        const resume = source.indexOf('ResumeThread(');
        expect(create).toBeGreaterThan(-1);
        expect(source).toContain('0x00000400');
        expect(source).toContain('AllocHGlobal($envBytes.Length)');
        expect(source).toContain('BasicLimitInformation.LimitFlags = 0x2000');
        expect(source).toContain('SetInformationJobObject');
        expect(assign).toBeGreaterThan(create);
        expect(resume).toBeGreaterThan(assign);
        expect(source).toContain('TerminateJobObject');
        expect(source).toContain('if (-not [O]::TerminateJobObject');
        expect(source).toContain('WaitForSingleObject($job, 5000)');
        expect(source).toContain('worker_launch_job_cleanup_timeout');
        expect(source).toContain('process_start_identity=("ticks:" +');
        expect(source).toContain('instance_id=$payload.identity.instance_id');
        expect(source).toContain('$msg.instance_id -ne $payload.identity.instance_id');
        expect(source).toContain('containment_nonce=$payload.containment_nonce');
        expect(source).toContain('finally {');
    });
    // Fork fix: each of these made Windows PowerShell 5.1 reject the supervisor.
    it('emits Windows supervisor source that PowerShell 5.1 and C# can parse', () => {
        const source = buildWindowsSupervisorSource();
        expect(source).not.toContain('`n');
        expect(source.split('\n')[0]).toBe('$ErrorActionPreference = "Stop"');
        expect(source).toContain("if (c == '\\\\')");
        expect(source).not.toMatch(/'\\'[,)]/);
        expect(source).toContain('$app = [NullString]::Value;');
        expect(source).toContain('CreateProcessW($app, $cmd,');
        // A batch argv[0] runs under cmd.exe from the system directory, with the
        // line in the environment block rather than the command line.
        expect(source).toContain('$argv = [string[]]$payload.provider_argv; [O]::RequireProviderExecutable($argv[0]);');
        expect(source).toContain("if ($argv[0] -match '\\.(cmd|bat)[. ]*$') { $providerLine = [O]::BuildCmdLine($argv); $app = Join-Path ([Environment]::SystemDirectory) 'cmd.exe';");
        expect(source).toContain('Regex.IsMatch(app, @"^(?:[A-Za-z]:[\\\\/]|\\\\\\\\[^\\\\/]+[\\\\/][^\\\\/]+[\\\\/])") || !System.IO.File.Exists(app)) throw new ArgumentException("worker_launch_provider_executable_invalid")');
        expect(source).toContain('/d /v:off /s /c "set "_OMC_PROVIDER_LINE=" & %_OMC_PROVIDER_LINE%"');
        expect(source).toContain('if (c < \' \') throw new ArgumentException("worker_launch_provider_argv_invalid")');
        expect(source).toContain('if (b.Length > 8000) throw new ArgumentException("worker_launch_provider_argv_too_long")');
        expect(source).toContain('CreateJobObjectW([IntPtr]::Zero, [NullString]::Value)');
        expect(source).toContain('[uint32]::MaxValue');
        expect(source).not.toContain('0xffffffff');
        // The provider talks to the pane console, never the protocol pipes.
        expect(source).toContain("CreateFileW('CONOUT$'");
        expect(source).toContain('$si.dwFlags = 0x00000100; $si.hStdInput = $conIn; $si.hStdOutput = $conOut; $si.hStdError = $conOut;');
        expect(source).not.toContain('[Console]::In.ReadLineAsync()');
        expect(source.match(/\$stdinReader\.ReadLineAsync\(\)/g)).toHaveLength(2);
    });
    it('binds every Windows supervisor frame to the exact launch instance', () => {
        const source = buildWindowsSupervisorSource();
        expect(source.match(/instance_id=\$payload\.identity\.instance_id/g)).toHaveLength(3);
        expect(source).toContain('$msg.instance_id -ne $payload.identity.instance_id');
        expect(source).toContain('if ([string]::IsNullOrWhiteSpace($line) -or $line.Length -gt 4096) { continue }');
        expect(source).toContain('try { $msg = $line | ConvertFrom-Json } catch { continue }');
    });
    it('rejects a Windows termination request from another launch instance', async () => {
        const launchAttempt = await attempt();
        const expected = await acceptFixtureAttempt(launchAttempt);
        const processStartIdentity = await getProcessStartIdentity(process.pid);
        if (!processStartIdentity)
            throw new Error('worker_launch_test_process_identity_missing');
        await writeFile(launchAttempt.startedPath, JSON.stringify({
            ...expected,
            kind: 'worker_launch_provider_started',
            pid: process.pid,
            process_start_identity: processStartIdentity,
            written_at: new Date().toISOString(),
        }), 'utf8');
        vi.resetModules();
        const actualFsPromises = await vi.importActual('node:fs/promises');
        const openMock = vi.fn(actualFsPromises.open);
        vi.doMock('node:fs/promises', () => ({ ...actualFsPromises, open: openMock }));
        const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: 'win32' });
        try {
            const workerLaunch = await import('../worker-launch-ack.js');
            await expect(workerLaunch.terminateWorkerLaunchProvider(launchAttempt, 5)).resolves.toBe(false);
            const requestPath = `${launchAttempt.startedPath}.termination-request`;
            const request = JSON.parse(await readFile(requestPath, 'utf8'));
            expect(request.instance_id).toBe(launchAttempt.instance_id);
            const requestWrites = openMock.mock.calls.filter(call => String(call[0]).includes('.candidate')).length;
            expect(requestWrites).toBeGreaterThan(0);
            await writeFile(requestPath, JSON.stringify({
                ...request,
                instance_id: randomUUID(),
            }), 'utf8');
            await expect(workerLaunch.terminateWorkerLaunchProvider(launchAttempt, 5)).resolves.toBe(false);
            // A mismatched request is rejected before another durable write; the
            // first false result was only a bounded wait with a valid request.
            expect(openMock.mock.calls.filter(call => String(call[0]).includes('.candidate')).length)
                .toBe(requestWrites);
        }
        finally {
            if (originalPlatform)
                Object.defineProperty(process, 'platform', originalPlatform);
            vi.doUnmock('node:fs/promises');
            vi.resetModules();
        }
    });
    // A supervisor that exits while the bootstrap writes its stdin fails that
    // write asynchronously with EPIPE. The bootstrap must own that stream error
    // and settle through its exit handling instead of crashing the process.
    it.runIf(process.platform === 'win32').each(['payload', 'terminate'])('settles a Windows supervisor stdin EPIPE after supervisor exit through exit handling (%s write)', async (failingWrite) => {
        vi.resetModules();
        const actualChildProcess = await vi.importActual('node:child_process');
        const supervisorScript = failingWrite === 'payload'
            ? 'process.exit(0)'
            : [
                "const rl=require('node:readline').createInterface({input:process.stdin})",
                "rl.once('line',line=>{const p=JSON.parse(line);process.stdout.write(JSON.stringify({protocol:'worker-launch-windows-supervisor-v1',kind:'ready',attempt_id:p.identity.attempt_id,instance_id:p.identity.instance_id,authority_digest:p.authority_digest,containment_nonce:p.containment_nonce,pid:process.pid,process_start_identity:'1'})+'\\n')})",
                'setInterval(()=>{},1000)',
            ].join(';');
        let supervisor;
        const epipeOwned = [];
        const spawnMock = vi.fn((_command, _args, options) => {
            const child = actualChildProcess.spawn(process.execPath, ['-e', supervisorScript], options);
            supervisor = child;
            const stdin = child.stdin;
            const realWrite = stdin.write.bind(stdin);
            let writes = 0;
            stdin.write = ((chunk) => {
                writes += 1;
                if ((failingWrite === 'payload' && writes === 1) || (failingWrite === 'terminate' && writes === 2)) {
                    child.kill();
                    setImmediate(() => {
                        epipeOwned.push(stdin.listenerCount('error') > 0);
                        stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -4047, syscall: 'write' }));
                    });
                    return false;
                }
                return realWrite(chunk);
            });
            return child;
        });
        vi.doMock('node:child_process', () => ({ ...actualChildProcess, spawn: spawnMock }));
        let bootstrap;
        try {
            const workerLaunch = await import('../worker-launch-ack.js');
            const launchAttempt = await attempt();
            const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', ''], cwd);
            bootstrap = workerLaunch.runWorkerLaunchBootstrap(spec);
            await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
                timeoutMs: LAUNCH_WAIT_TIMEOUT_MS,
                pollIntervalMs: 5,
            })).resolves.toEqual({ ok: true });
            if (failingWrite === 'terminate') {
                await vi.waitFor(() => expect(existsSync(launchAttempt.startedPath)).toBe(true), { timeout: 10_000, interval: 20 });
                const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
                await writeFile(`${launchAttempt.startedPath}.termination-request`, JSON.stringify({
                    ...expected,
                    kind: 'worker_launch_termination_request', operation: 'terminate',
                    pid: supervisor?.pid, process_start_identity: '1',
                    authority_digest: spec.authority_digest, containment_nonce: spec.containment_nonce,
                    written_at: new Date().toISOString(),
                }), 'utf8');
            }
            // No terminal proof arrived before the supervisor died, so the
            // existing early-exit path reports cleanup as unverified.
            await expect(bootstrap).resolves.toEqual({ outcome: 'provider_cleanup_unverified' });
            expect(epipeOwned).toEqual([true]);
            if (failingWrite === 'terminate') {
                const terminal = JSON.parse(await readFile(`${launchAttempt.startedPath}.terminal`, 'utf8'));
                expect(terminal).toMatchObject({ outcome: 'cleanup_unverified', cleanup_verified: false, pid: supervisor?.pid });
            }
        }
        finally {
            await bootstrap?.catch(() => undefined);
            supervisor?.kill();
            vi.doUnmock('node:child_process');
            vi.resetModules();
        }
    }, 20_000);
    it('quotes exact Windows CreateProcess arguments', () => {
        expect(quoteWindowsCreateProcessArgument('')).toBe('""');
        expect(quoteWindowsCreateProcessArgument('plain')).toBe('"plain"');
        expect(quoteWindowsCreateProcessArgument('two words')).toBe('"two words"');
        expect(quoteWindowsCreateProcessArgument('C:\\path with space\\')).toBe('"C:\\path with space\\\\"');
        expect(quoteWindowsCreateProcessArgument('say "hello"')).toBe('"say \\"hello\\""');
        expect(() => quoteWindowsCreateProcessArgument('bad\r\narg')).toThrow('worker_launch_provider_argv_invalid');
    });
    it('rejects substituted authority fields', async () => {
        const launchAttempt = await attempt();
        const materialized = await materializeWorkerLaunchTransport({ attempt: launchAttempt, providerArgv: ['codex'], cwd });
        const descriptor = JSON.parse(await readFile(materialized.bootstrapDescriptorPath, 'utf8'));
        descriptor.provider_argv = ['tampered'];
        await writeFile(materialized.bootstrapDescriptorPath, JSON.stringify(descriptor), 'utf8');
        await expect(readAndConsumeWorkerLaunchDescriptor(materialized.bootstrapDescriptorPath)).rejects.toThrow('worker_launch_descriptor_invalid');
    });
    it.skipIf(requiresSymlinks())('rejects descriptor symlinks', async () => {
        const launchAttempt = await attempt();
        const materialized = await materializeWorkerLaunchTransport({ attempt: launchAttempt, providerArgv: ['codex'], cwd });
        await rm(materialized.bootstrapDescriptorPath, { force: true });
        await symlink(materialized.wrapperPath, materialized.bootstrapDescriptorPath);
        await expect(readAndConsumeWorkerLaunchDescriptor(materialized.bootstrapDescriptorPath)).rejects.toThrow();
    });
    it('resolves env passthrough at provider exec time without persisting to bootstrap.json', async () => {
        const sourceEnv = {
            PATH: '/usr/bin:/bin',
            HOME: '/home/provider',
            CUSTOM_PROVIDER_SETTING: 'secret-token-123',
            ANOTHER_CUSTOM_VAR: 'another-value',
        };
        // Verify that without passthrough, custom vars are NOT in the environment
        const runtimeEnv = buildProviderEnvironment({ EXPLICIT: 'yes' }, sourceEnv, 'linux');
        expect(runtimeEnv).toHaveProperty('EXPLICIT', 'yes');
        expect(runtimeEnv).not.toHaveProperty('CUSTOM_PROVIDER_SETTING');
        expect(runtimeEnv).not.toHaveProperty('ANOTHER_CUSTOM_VAR');
        // Verify that custom vars ARE included when passthrough is specified
        const runtimeEnvWithPassthrough = buildProviderEnvironment({ EXPLICIT: 'yes' }, sourceEnv, 'linux', ['CUSTOM_PROVIDER_SETTING', 'ANOTHER_CUSTOM_VAR']);
        expect(runtimeEnvWithPassthrough).toHaveProperty('EXPLICIT', 'yes');
        expect(runtimeEnvWithPassthrough).toHaveProperty('CUSTOM_PROVIDER_SETTING', 'secret-token-123');
        expect(runtimeEnvWithPassthrough).toHaveProperty('ANOTHER_CUSTOM_VAR', 'another-value');
        // Passthrough vars that don't exist in sourceEnv should be silently skipped
        const runtimeEnvMissingVar = buildProviderEnvironment({ EXPLICIT: 'yes' }, sourceEnv, 'linux', ['NONEXISTENT_VAR', 'CUSTOM_PROVIDER_SETTING']);
        expect(runtimeEnvMissingVar).toHaveProperty('CUSTOM_PROVIDER_SETTING', 'secret-token-123');
        expect(runtimeEnvMissingVar).not.toHaveProperty('NONEXISTENT_VAR');
    });
    it('parses OMC_TEAM_WORKER_ENV_PASSTHROUGH from source environment', () => {
        const sourceEnv = {
            PATH: '/usr/bin',
            HOME: '/home/user',
            OMC_TEAM_WORKER_ENV_PASSTHROUGH: 'CUSTOM_VAR1, CUSTOM_VAR2, CUSTOM_VAR3',
            CUSTOM_VAR1: 'value1',
            CUSTOM_VAR2: 'value2',
            CUSTOM_VAR3: 'value3',
        };
        // When OMC_TEAM_WORKER_ENV_PASSTHROUGH is set, those vars should be included
        const runtimeEnv = buildProviderEnvironment({}, sourceEnv, 'linux');
        expect(runtimeEnv).toHaveProperty('CUSTOM_VAR1', 'value1');
        expect(runtimeEnv).toHaveProperty('CUSTOM_VAR2', 'value2');
        expect(runtimeEnv).toHaveProperty('CUSTOM_VAR3', 'value3');
        // The passthrough env var itself should NOT be in the output
        expect(runtimeEnv).not.toHaveProperty('OMC_TEAM_WORKER_ENV_PASSTHROUGH');
    });
    it('validates passthrough env var names and rejects invalid syntax', () => {
        const sourceEnv = {
            PATH: '/usr/bin',
            HOME: '/home/user',
            VALID_NAME: 'value',
        };
        // Valid names should work
        expect(() => buildProviderEnvironment({}, sourceEnv, 'linux', ['VALID_NAME', '_UNDERSCORE_PREFIX', 'VAR123'])).not.toThrow();
        // Invalid names should be rejected
        expect(() => buildProviderEnvironment({}, sourceEnv, 'linux', ['INVALID-NAME'])).toThrow('worker_launch_env_passthrough_key_invalid');
        expect(() => buildProviderEnvironment({}, sourceEnv, 'linux', ['123INVALID'])).toThrow('worker_launch_env_passthrough_key_invalid');
    });
    it('rejects reserved and internal env var names in passthrough', () => {
        const sourceEnv = {
            PATH: '/usr/bin',
            HOME: '/home/user',
            OMC_WORKER_LAUNCH_SPEC: 'value',
        };
        // Internal keys should be rejected
        expect(() => buildProviderEnvironment({}, sourceEnv, 'linux', ['OMC_WORKER_LAUNCH_SPEC'])).toThrow('worker_launch_env_passthrough_key_reserved');
        // Windows reserved keys should be rejected on win32
        expect(() => buildProviderEnvironment({}, sourceEnv, 'win32', ['SYSTEMROOT'])).toThrow('worker_launch_env_passthrough_key_reserved');
    });
});
describe('worker env passthrough refuses credentials except the provider login', () => {
    const sourceEnv = {
        PATH: '/usr/bin',
        HOME: '/home/user',
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
        AWS_REGION: 'eu-north-1',
        NPM_TOKEN: 'npm-secret',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        GH_TOKEN: 'gh-secret',
        ANTHROPIC_API_KEY: 'anthropic-secret',
        GOOGLE_APPLICATION_CREDENTIALS: '/keys/sa.json',
    };
    afterEach(() => { vi.unstubAllEnvs(); });
    it('builds the provider env without the source env credentials', () => {
        for (const provider of ['copilot', 'claude', undefined]) {
            const env = buildProviderEnvironment({}, sourceEnv, 'linux', undefined, provider);
            expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH']);
        }
    });
    it.each(['AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN', 'SSH_AUTH_SOCK'])('refuses passthrough of %s for every provider', key => {
        for (const provider of ['copilot', 'claude', 'codex', undefined]) {
            expect(() => buildProviderEnvironment({}, sourceEnv, 'linux', [key], provider))
                .toThrow('worker_launch_env_passthrough_credential');
        }
    });
    it('passes ANTHROPIC_API_KEY to claude only and GH_TOKEN to copilot only, skipping the other', () => {
        const notice = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        expect(buildProviderEnvironment({}, sourceEnv, 'linux', ['ANTHROPIC_API_KEY'], 'claude'))
            .toHaveProperty('ANTHROPIC_API_KEY', 'anthropic-secret');
        expect(buildProviderEnvironment({}, sourceEnv, 'linux', ['GH_TOKEN'], 'copilot'))
            .toHaveProperty('GH_TOKEN', 'gh-secret');
        expect(notice).not.toHaveBeenCalled();
        // A mixed team shares one list: another provider's login is skipped, not refused.
        const mixed = ['ANTHROPIC_API_KEY', 'GH_TOKEN', 'CUSTOM_SETTING'];
        const env = { ...sourceEnv, CUSTOM_SETTING: 'custom' };
        const copilot = buildProviderEnvironment({}, env, 'linux', mixed, 'copilot');
        expect(copilot).toMatchObject({ GH_TOKEN: 'gh-secret', CUSTOM_SETTING: 'custom' });
        expect(copilot).not.toHaveProperty('ANTHROPIC_API_KEY');
        const claude = buildProviderEnvironment({}, env, 'linux', mixed, 'claude');
        expect(claude).toMatchObject({ ANTHROPIC_API_KEY: 'anthropic-secret', CUSTOM_SETTING: 'custom' });
        expect(claude).not.toHaveProperty('GH_TOKEN');
        const codex = buildProviderEnvironment({}, env, 'linux', mixed, 'codex');
        expect(codex).not.toHaveProperty('ANTHROPIC_API_KEY');
        expect(codex).not.toHaveProperty('GH_TOKEN');
        expect(notice).toHaveBeenCalledWith(expect.stringMatching(/ANTHROPIC_API_KEY is another provider's login; not forwarded to this copilot worker/));
        notice.mockRestore();
        // The pane shell hosts any provider: any provider's login passes there.
        expect(buildProviderEnvironment({}, sourceEnv, 'linux', ['ANTHROPIC_API_KEY', 'GH_TOKEN']))
            .toMatchObject({ ANTHROPIC_API_KEY: 'anthropic-secret', GH_TOKEN: 'gh-secret' });
    });
    it('passes AWS_* and GOOGLE_* to claude only when Bedrock or Vertex is enabled', () => {
        const bedrock = { ...sourceEnv, CLAUDE_CODE_USE_BEDROCK: '1' };
        expect(buildProviderEnvironment({}, bedrock, 'linux', ['AWS_SECRET_ACCESS_KEY', 'AWS_REGION'], 'claude'))
            .toMatchObject({ AWS_SECRET_ACCESS_KEY: 'aws-secret', AWS_REGION: 'eu-north-1' });
        const notice = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        expect(buildProviderEnvironment({}, bedrock, 'linux', ['AWS_SECRET_ACCESS_KEY'], 'copilot'))
            .not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
        notice.mockRestore();
        expect(() => buildProviderEnvironment({}, sourceEnv, 'linux', ['AWS_SECRET_ACCESS_KEY'], 'copilot'))
            .toThrow('worker_launch_env_passthrough_credential');
        expect(() => buildProviderEnvironment({}, { ...sourceEnv, CLAUDE_CODE_USE_BEDROCK: '0' }, 'linux', ['AWS_SECRET_ACCESS_KEY'], 'claude'))
            .toThrow('worker_launch_env_passthrough_credential');
        expect(() => buildProviderEnvironment({}, bedrock, 'linux', ['GOOGLE_APPLICATION_CREDENTIALS'], 'claude'))
            .toThrow('worker_launch_env_passthrough_credential');
        expect(buildProviderEnvironment({}, { ...sourceEnv, CLAUDE_CODE_USE_VERTEX: 'true' }, 'linux', ['GOOGLE_APPLICATION_CREDENTIALS'], 'claude'))
            .toHaveProperty('GOOGLE_APPLICATION_CREDENTIALS', '/keys/sa.json');
    });
    it('matches the provider login by case on POSIX and case-insensitively on Windows', () => {
        const env = { ...sourceEnv, gh_token: 'lower' };
        expect(() => buildProviderEnvironment({}, env, 'linux', ['gh_token'], 'copilot'))
            .toThrow('worker_launch_env_passthrough_credential');
        expect(buildProviderEnvironment({}, env, 'win32', ['gh_token'], 'copilot')).toHaveProperty('gh_token', 'lower');
    });
    it('names the key, the provider and the allowed logins in the error', () => {
        expect(() => assertEnvPassthroughAllowed('copilot', { OMC_TEAM_WORKER_ENV_PASSTHROUGH: 'PATH, NPM_TOKEN' }, 'linux'))
            .toThrow(/^worker_launch_env_passthrough_credential: .*NPM_TOKEN for a copilot worker; remove it\..*COPILOT_GITHUB_TOKEN/);
        expect(() => assertEnvPassthroughAllowed('copilot', { OMC_TEAM_WORKER_ENV_PASSTHROUGH: 'COPILOT_GITHUB_TOKEN,CUSTOM_SETTING' }, 'linux'))
            .not.toThrow();
    });
    it('the supervisor refuses a passthrough credential no provider owns', async () => {
        const launchAttempt = await attempt();
        const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, { platform: 'win32' });
        expect(() => buildWindowsSupervisorInvocation(spec, { ...sourceEnv, OMC_TEAM_WORKER_ENV_PASSTHROUGH: 'NPM_TOKEN' }))
            .toThrow('worker_launch_env_passthrough_credential');
    });
    it('the supervisor takes the Bedrock switch from the worker env, not only the pane shell env', async () => {
        const launchAttempt = await attempt('claude');
        const providerEnv = { CLAUDE_CODE_USE_BEDROCK: '1' };
        const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, ['claude'], cwd, { platform: 'win32', providerEnv });
        // The pane shell env (env -i + baseline + passthrough) carries no switch.
        const paneEnv = { ...sourceEnv, OMC_TEAM_WORKER_ENV_PASSTHROUGH: 'AWS_SECRET_ACCESS_KEY,AWS_REGION' };
        expect(() => buildWindowsSupervisorInvocation(spec, paneEnv)).not.toThrow('worker_launch_env_passthrough_credential');
        expect(buildProviderEnvironment(spec.provider_env, paneEnv, 'linux', undefined, 'claude'))
            .toMatchObject({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_SECRET_ACCESS_KEY: 'aws-secret', AWS_REGION: 'eu-north-1' });
        expect(() => assertEnvPassthroughAllowed('claude', paneEnv, 'linux', providerEnv)).not.toThrow();
    });
    it('the leader refuses before materializing the launch transport', async () => {
        const launchAttempt = await attempt();
        vi.stubEnv('OMC_TEAM_WORKER_ENV_PASSTHROUGH', 'NPM_TOKEN');
        vi.stubEnv('NPM_TOKEN', 'npm-secret');
        await expect(materializeWorkerLaunchTransport({ attempt: launchAttempt, providerArgv: ['codex'], cwd }))
            .rejects.toThrow('worker_launch_env_passthrough_credential');
        expect(existsSync(launchAttempt.bootstrapDescriptorPath)).toBe(false);
    });
});
//# sourceMappingURL=worker-launch-ack.test.js.map