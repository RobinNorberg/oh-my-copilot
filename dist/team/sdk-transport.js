/**
 * Leader side of the headless SDK team transport (`omg team --transport sdk`).
 *
 * Pane workers are processes a multiplexer owns; SDK workers are sessions a
 * detached `omg team sdk-host` process owns (sdk-host.ts). This module holds
 * what the leader, the monitor, mailbox delivery and shutdown need:
 * - the per-worker file layout under the team state root;
 * - the doorbell (`sdk-doorbell.jsonl`), the only way to reach a session;
 * - the session file (`sdk-session.json`), read instead of a pane capture;
 * - host launch (launch attempt + detached spawn + ack/started handshake)
 *   and host stop (doorbell stop, then a bounded wait, then a tree kill).
 *
 * The team target is `sdk:<team>` and each worker's `pane_id` is `sdk:<worker>`:
 * neither names a multiplexer resource, so pane code paths must skip them
 * ({@link isSdkTarget}).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { killProcessTree, isProcessAlive, isProcessIdentityLive } from '../platform/process-utils.js';
import { resolveRuntimeCliPath } from './runtime-owner-client.js';
import { awaitWorkerLaunchAcknowledgement, awaitWorkerLaunchProviderStarted, observeWorkerLaunchProvider, prepareWorkerLaunchAttempt, } from './worker-launch-ack.js';
export const SDK_TARGET_PREFIX = 'sdk:';
/** True for the sdk team target (`sdk:<team>`) and sdk worker ids (`sdk:<worker>`). */
export function isSdkTarget(value) {
    return typeof value === 'string' && value.startsWith(SDK_TARGET_PREFIX);
}
export function sdkTeamTarget(teamName) {
    return `${SDK_TARGET_PREFIX}${teamName}`;
}
export function sdkPaneId(workerName) {
    return `${SDK_TARGET_PREFIX}${workerName}`;
}
export function sdkWorkerFiles(stateRoot, workerName) {
    const dir = join(stateRoot, 'workers', workerName);
    return {
        dir,
        spec: join(dir, 'sdk-host-spec.json'),
        doorbell: join(dir, 'sdk-doorbell.jsonl'),
        session: join(dir, 'sdk-session.json'),
        probe: join(dir, 'sdk-probe.json'),
        events: join(dir, 'sdk-events.jsonl'),
        log: join(dir, 'sdk-host.log'),
        home: join(dir, 'copilot-home'),
        bin: join(dir, 'bin'),
        shutdownAck: join(dir, 'shutdown-ack.json'),
    };
}
/** Append one doorbell entry; returns its id. Appends are line-sized and atomic enough for one writer per call. */
export function ringDoorbell(stateRoot, workerName, entry) {
    const files = sdkWorkerFiles(stateRoot, workerName);
    mkdirSync(files.dir, { recursive: true });
    const id = entry.id ?? randomUUID();
    const line = { ...entry, id, at: new Date().toISOString() };
    appendFileSync(files.doorbell, `${JSON.stringify(line)}\n`);
    return id;
}
export function readSdkSession(stateRoot, workerName) {
    try {
        const parsed = JSON.parse(readFileSync(sdkWorkerFiles(stateRoot, workerName).session, 'utf8'));
        return parsed && parsed.schema_version === 1 ? parsed : null;
    }
    catch {
        return null;
    }
}
function spawnDetachedHost(cliPath, specPath, logPath, cwd) {
    mkdirSync(dirname(logPath), { recursive: true });
    const fd = openSync(logPath, 'a');
    try {
        const child = spawn(process.execPath, [cliPath, 'team', 'sdk-host', '--spec', specPath], {
            cwd,
            detached: true,
            windowsHide: true,
            stdio: ['ignore', fd, fd],
            env: process.env,
        });
        child.unref();
        return child.pid;
    }
    finally {
        closeSync(fd);
    }
}
/**
 * Create the launch attempt, write the host spec and spawn the detached host,
 * then run the same ack -> accepted -> provider_started handshake a pane
 * bootstrap runs. A failed handshake tree-kills the host it spawned.
 */
export async function launchSdkHost(input) {
    const paneId = sdkPaneId(input.workerName);
    const runtimeCliPath = resolveRuntimeCliPath();
    const attempt = await prepareWorkerLaunchAttempt({
        cwd: input.leaderCwd,
        teamName: input.teamName,
        workerName: input.workerName,
        instanceId: input.instanceId,
        paneId,
        provider: 'copilot',
        runtimeCliPath,
        context: { kind: 'initial' },
    });
    const files = sdkWorkerFiles(input.stateRoot, input.workerName);
    mkdirSync(files.dir, { recursive: true });
    const cliPath = join(dirname(runtimeCliPath), 'cli.cjs');
    const spec = {
        schema_version: 1,
        leader_cwd: input.leaderCwd,
        team_name: input.teamName,
        worker_name: input.workerName,
        instance_id: input.instanceId,
        attempt_id: attempt.attempt_id,
        pane_id: paneId,
        runtime_cli_path: runtimeCliPath,
        worker_cwd: input.workerCwd,
        state_root: input.stateRoot,
        plugin_root: input.pluginRoot,
        copilot_bin: input.copilotBin,
        ...(input.model ? { model: input.model } : {}),
        max_credits: input.maxCredits,
        worker_env: { ...input.workerEnv, OMC_WORKER_LAUNCH_ATTEMPT_ID: attempt.attempt_id },
        deny_tools: input.denyTools,
        deny_urls: input.denyUrls,
        mcp_server: input.mcpServer ?? 't',
        omg_cli_path: cliPath,
        node_path: process.execPath,
        user_config_dir: input.userConfigDir,
    };
    writeFileSync(files.spec, `${JSON.stringify(spec, null, 2)}\n`);
    // A new host reads the doorbell from offset 0: start it empty so a previous
    // attempt's prompts, stop or shutdown entries are never replayed into it.
    writeFileSync(files.doorbell, '');
    const hostPid = (input.spawnHost ?? spawnDetachedHost)(cliPath, files.spec, files.log, input.workerCwd);
    const kill = async () => { if (hostPid && isProcessAlive(hostPid))
        await killProcessTree(hostPid, 'SIGKILL').catch(() => undefined); };
    const timeoutMs = input.ackTimeoutMs ?? 30_000;
    const ack = await awaitWorkerLaunchAcknowledgement(attempt, { timeoutMs });
    if (!ack.ok) {
        await kill();
        return { ok: false, attempt, reason: `sdk_host_ack_${ack.reason}`, ...(hostPid ? { hostPid } : {}) };
    }
    const startDeadline = Date.now() + timeoutMs;
    for (;;) {
        const sliceMs = Math.max(1, Math.min(1_000, startDeadline - Date.now()));
        if (await awaitWorkerLaunchProviderStarted(attempt, { timeoutMs: sliceMs }))
            break;
        // A host that failed before provider_started says so in its session file: stop waiting.
        if (failedBeforeProviderStarted(attempt, input.stateRoot)) {
            await kill();
            const error = readSdkSession(input.stateRoot, input.workerName)?.last_error ?? 'unknown';
            return { ok: false, attempt, reason: `sdk_host_failed_before_start:${error}`, ...(hostPid ? { hostPid } : {}) };
        }
        if (Date.now() >= startDeadline) {
            await kill();
            return { ok: false, attempt, reason: 'sdk_host_provider_not_started', ...(hostPid ? { hostPid } : {}) };
        }
    }
    return { ok: true, attempt, hostPid, paneId };
}
/** Floor for a shutdown's host stop budget: lets a host already mid-teardown finish. */
export const SDK_HOST_STOP_FLOOR_MS = 5_000;
/** Gone = dead, or the pid now names a different process (identity mismatch). */
async function isTargetGone(target) {
    if (!target.identity)
        return !isProcessAlive(target.pid);
    const liveness = await isProcessIdentityLive(target.pid, target.identity);
    return liveness === 'dead' || liveness === 'mismatch';
}
/**
 * True when the host failed before publishing provider_started (sdk-host.ts
 * writes its terminal record, then the `failed` session file). It never
 * started a runtime, so there is nothing left to stop; the shared observer
 * reads such an attempt as `unknown` and would make a stop wait out its budget.
 */
function failedBeforeProviderStarted(attempt, stateRoot) {
    if (existsSync(attempt.startedPath))
        return false;
    const session = readSdkSession(stateRoot, attempt.worker_name);
    return session?.attempt_id === attempt.attempt_id && session.state === 'failed';
}
/**
 * Ring `stop` (or `shutdown`, which also writes the shutdown ack), wait for the
 * host to report its provider dead, then tree-kill it as the last resort.
 * True once the provider is observed dead.
 */
export async function stopSdkHost(attempt, stateRoot, opts = {}) {
    const pollMs = opts.pollMs ?? 250;
    const exited = async () => failedBeforeProviderStarted(attempt, stateRoot) || await observeWorkerLaunchProvider(attempt) === 'dead';
    if (await exited())
        return true;
    ringDoorbell(stateRoot, attempt.worker_name, { kind: opts.kind ?? 'stop', from: 'leader-fixed' });
    const deadline = Date.now() + (opts.timeoutMs ?? 45_000);
    while (Date.now() < deadline) {
        if (await exited())
            return true;
        await new Promise((r) => setTimeout(r, pollMs));
    }
    // Last resort: kill only processes whose recorded start identity still
    // matches (a recycled pid is never signalled): the host, and the runtime it
    // spawned, which outlives a host that died without tearing it down.
    const started = readStartedRecord(attempt);
    const session = readSdkSession(stateRoot, attempt.worker_name);
    const targets = [];
    if (started)
        targets.push({ pid: started.pid, identity: started.process_start_identity });
    if (session?.attempt_id === attempt.attempt_id && session.runtime_pid && session.runtime_pid > 0) {
        targets.push({ pid: session.runtime_pid, identity: session.runtime_start_identity ?? null });
    }
    for (const target of targets) {
        if (target.identity && await isProcessIdentityLive(target.pid, target.identity) === 'live') {
            await killProcessTree(target.pid, 'SIGKILL').catch(() => undefined);
        }
    }
    const killDeadline = Date.now() + 5_000;
    for (;;) {
        if ((await Promise.all(targets.map(isTargetGone))).every(Boolean)) {
            // The host died without its own terminal record: publish the
            // termination proof the shared retire path accepts (pid + identity),
            // and only once its runtime is gone too.
            if (started)
                writeTerminationComplete(attempt, started.pid, started.process_start_identity);
            return true;
        }
        if (Date.now() >= killDeadline)
            return false;
        await new Promise((r) => setTimeout(r, pollMs));
    }
}
function readStartedRecord(attempt) {
    try {
        const record = JSON.parse(readFileSync(attempt.startedPath, 'utf8'));
        return typeof record.pid === 'number' && record.pid > 0 && typeof record.process_start_identity === 'string'
            ? { pid: record.pid, process_start_identity: record.process_start_identity }
            : null;
    }
    catch {
        return null;
    }
}
function writeTerminationComplete(attempt, pid, startIdentity) {
    const path = `${attempt.startedPath}.termination-complete`;
    if (existsSync(path))
        return;
    try {
        writeFileSync(path, JSON.stringify({
            schema_version: attempt.schema_version,
            attempt_id: attempt.attempt_id,
            nonce: attempt.nonce,
            instance_id: attempt.instance_id,
            team_name: attempt.team_name,
            worker_name: attempt.worker_name,
            pane_id: attempt.pane_id,
            provider: attempt.provider,
            created_at: attempt.created_at,
            kind: 'worker_launch_termination_complete',
            cleanup_verified: true,
            pid,
            process_start_identity: startIdentity,
            ...(process.platform === 'win32' ? {} : { process_group_id: pid }),
            written_at: new Date().toISOString(),
        }), { flag: 'wx' });
    }
    catch { /* a concurrent writer won */ }
}
//# sourceMappingURL=sdk-transport.js.map