/**
 * `omg team sdk-host`: the detached per-worker process behind `--transport sdk`.
 *
 * One host owns one `@github/copilot-sdk` client and one session for one team
 * worker. It is the worker's launch "provider": it writes the launch-attempt
 * ack and the `provider_started` record with its own pid and strict process
 * start identity, so the existing provider liveness, retire and cleanup code
 * observes it like a pane provider. On exit it writes the `.terminal` record.
 *
 * Inputs (all under the worker's state dir, see sdk-transport.ts):
 * - `sdk-host-spec.json`  written by the leader before the spawn;
 * - `sdk-doorbell.jsonl`  appended by anyone (leader, other workers' mailbox
 *   sends); the host tails it and `send()`s prompts only while the session is
 *   idle, so a busy session never receives a second send;
 * - `<started>.termination-request`  written by the shared retire path: hard stop.
 * Outputs: `sdk-session.json` (state, usage, permissions, timeline),
 * `sdk-events.jsonl` (every session event), and `shutdown-ack.json` when the
 * doorbell carries a shutdown.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { atomicWriteJson } from '../lib/atomic-write.js';
import { ledgerPath, NANO_AIU_PER_CREDIT, recordUsage } from '../budget/ledger.js';
import { RUNTIME_MIN_MAX_CREDITS, usageCredits } from '../smoke/copilot-sdk-scenarios.js';
import { buildSessionEnv, isCredentialEnvKey, loginIdentity } from '../smoke/copilot-session-env.js';
import { runtimePid, } from '../smoke/copilot-sdk-driver.js';
import { loadWorkerLaunchAttempt } from './worker-launch-ack.js';
import { buildSdkExcludedTools, decideSdkPermission } from './sdk-policy.js';
import { sdkWorkerFiles } from './sdk-transport.js';
const DECISION_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 60_000;
const RPC_TIMEOUT_MS = 30_000;
const ABORT_GRACE_MS = 10_000;
const SHUTDOWN_GRACE_MS = 2_000;
const STOP_TIMEOUT_MS = 15_000;
const TOOL_CLEANUP_TIMEOUT_MS = 5_000;
const PERMISSION_LOG_MAX = 200;
const STOP_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
class TimeoutError extends Error {
}
function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms} ms`)), ms); }),
    ]).finally(() => clearTimeout(timer));
}
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const errText = (err) => (err instanceof Error ? err.message : String(err));
function identityOf(a) {
    return {
        schema_version: a.schema_version,
        attempt_id: a.attempt_id,
        nonce: a.nonce,
        instance_id: a.instance_id,
        team_name: a.team_name,
        worker_name: a.worker_name,
        pane_id: a.pane_id,
        provider: a.provider,
        created_at: a.created_at,
    };
}
/** Same exclusive candidate+link publish the launch protocol uses. */
async function writeExclusive(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const candidate = `${path}.candidate.${process.pid}.${randomUUID()}`;
    const handle = await open(candidate, 'wx', 0o600);
    try {
        await handle.writeFile(JSON.stringify(value), 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await link(candidate, path);
        return true;
    }
    catch {
        return false;
    }
    finally {
        await unlink(candidate).catch(() => undefined);
    }
}
async function readJsonFile(path) {
    try {
        const value = JSON.parse(await readFile(path, 'utf8'));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    }
    catch {
        return null;
    }
}
async function waitForDecision(attempt, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const record = await readJsonFile(attempt.decisionPath);
        if (record && record.kind === 'worker_launch_decision' && record.attempt_id === attempt.attempt_id && record.nonce === attempt.nonce) {
            if (record.decision === 'accepted' || record.decision === 'revoked')
                return record.decision;
        }
        await sleep(25);
    }
    return 'timeout';
}
/** Parse doorbell lines after `offset`; returns entries and the new offset (complete lines only). */
export function readDoorbell(path, offset) {
    let buf;
    try {
        buf = readFileSync(path);
    }
    catch {
        return { entries: [], offset };
    }
    if (buf.length <= offset)
        return { entries: [], offset };
    const chunk = buf.subarray(offset).toString('utf8');
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline < 0)
        return { entries: [], offset };
    const complete = chunk.slice(0, lastNewline);
    const entries = [];
    for (const line of complete.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object' && typeof parsed.kind === 'string')
                entries.push(parsed);
        }
        catch { /* a torn or foreign line is skipped */ }
    }
    return { entries, offset: offset + Buffer.byteLength(complete, 'utf8') + 1 };
}
/** Prepend `dir` to PATH, matching the key case-insensitively on win32. */
export function prependPath(env, dir, platform) {
    const key = platform === 'win32'
        ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path'
        : 'PATH';
    const sep = platform === 'win32' ? ';' : ':';
    env[key] = env[key] ? `${dir}${sep}${env[key]}` : dir;
}
/** Env vars {@link scrubWorkerCredentials} sets on every worker. */
const WORKER_CREDENTIAL_RESET = ['GH_CONFIG_DIR', 'AZURE_CONFIG_DIR', 'GIT_TERMINAL_PROMPT', 'GCM_INTERACTIVE'];
/**
 * A credential-free worker env, in place. Workers run arbitrary toolchains
 * unsandboxed, so this is a denylist (isCredentialEnvKey): every token,
 * secret-named var, ssh-agent and askpass hook, `GIT_CONFIG*` and `GCM_*` goes,
 * COPILOT_GITHUB_TOKEN included (the session gets it over RPC instead). `gh`
 * and `az` see an empty config dir; git never prompts and runs no credential
 * helper (`credential.helper` reset through GIT_CONFIG_COUNT, so identity,
 * safe.directory and core.longpaths from the user's config still apply).
 * PATH, the home dirs, toolchain, proxy and CA vars stay.
 */
export function scrubWorkerCredentials(env, emptyDir) {
    const reset = new Set(WORKER_CREDENTIAL_RESET);
    for (const key of Object.keys(env)) {
        if (isCredentialEnvKey(key) || reset.has(key.toUpperCase()))
            delete env[key];
    }
    mkdirSync(emptyDir, { recursive: true });
    Object.assign(env, {
        GH_CONFIG_DIR: emptyDir,
        AZURE_CONFIG_DIR: emptyDir,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        // An empty value clears the helper list (system `manager` included).
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
    });
}
/**
 * The Copilot credential for the session RPC: COPILOT_GITHUB_TOKEN, else
 * GH_TOKEN / GITHUB_TOKEN when no stored login was copied (with a login they
 * would shadow it, as buildSessionEnv drops them then).
 */
export function workerGitHubToken(env, hasLogin) {
    const names = hasLogin ? ['COPILOT_GITHUB_TOKEN'] : ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];
    for (const name of names) {
        const key = Object.keys(env).find((k) => k.toUpperCase() === name);
        const value = key ? env[key]?.trim() : undefined;
        if (value)
            return value;
    }
    return undefined;
}
/**
 * Make `target` hold exactly `env`. The `t` MCP server child runs with the
 * session env; in-process tool handlers read `process.env`, so with
 * `in_process_tools` the host adopts that env once the runtime is spawned.
 */
export function adoptSessionEnv(target, env) {
    for (const key of Object.keys(target)) {
        if (!(key in env))
            delete target[key];
    }
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined)
            target[key] = value;
    }
}
/** `omg` shims so `omg team api …` inside the worker runs the leader's own CLI build. */
function writeOmgShims(binDir, cliPath, nodePath) {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'omg.cmd'), `@echo off\r\n"${nodePath}" "${cliPath}" %*\r\n`);
    writeFileSync(join(binDir, 'omg.ps1'), `& "${nodePath}" "${cliPath}" @args\r\nexit $LASTEXITCODE\r\n`);
    writeFileSync(join(binDir, 'omg'), `#!/bin/sh\nexec "${nodePath}" "${cliPath}" "$@"\n`, { mode: 0o755 });
}
/** Zero-model introspection: the offered tool names and MCP server states. */
async function probeSession(s) {
    const out = { at: new Date().toISOString() };
    try {
        const tools = s.rpc.tools;
        if (tools?.initializeAndValidate)
            await withTimeout(tools.initializeAndValidate(), RPC_TIMEOUT_MS, 'tools.initializeAndValidate');
        const meta = tools?.getCurrentMetadata ? await withTimeout(tools.getCurrentMetadata(), RPC_TIMEOUT_MS, 'tools.getCurrentMetadata') : null;
        const list = meta?.tools ?? [];
        out.tools = list.map((t) => t.name).filter(Boolean).sort();
    }
    catch (err) {
        out.tools_error = errText(err);
    }
    try {
        out.mcp = await withTimeout(s.rpc.mcp.list(), RPC_TIMEOUT_MS, 'mcp.list');
    }
    catch (err) {
        out.mcp_error = errText(err);
    }
    return out;
}
/**
 * Whether the session offers tool `name` (zero-model tool metadata, built
 * first when empty); null when the SDK has no metadata RPC, it fails, or it
 * lists no tools at all, so the answer is unknown.
 */
async function sessionOffersTool(s, name) {
    const tools = s.rpc.tools;
    if (!tools?.getCurrentMetadata)
        return null;
    const names = async () => {
        const meta = await withTimeout(tools.getCurrentMetadata(), RPC_TIMEOUT_MS, 'tools.getCurrentMetadata');
        const list = meta?.tools;
        return Array.isArray(list) ? list.map((t) => t?.name) : [];
    };
    try {
        let offered = await names();
        if (offered.length === 0 && tools.initializeAndValidate) {
            await withTimeout(tools.initializeAndValidate(), RPC_TIMEOUT_MS, 'tools.initializeAndValidate');
            offered = await names();
        }
        return offered.length === 0 ? null : offered.includes(name);
    }
    catch {
        return null;
    }
}
export async function runSdkHost(spec, deps) {
    const files = sdkWorkerFiles(spec.state_root, spec.worker_name);
    const log = deps.log ?? (() => { });
    const attempt = await loadWorkerLaunchAttempt({
        cwd: spec.leader_cwd,
        teamName: spec.team_name,
        workerName: spec.worker_name,
        instanceId: spec.instance_id,
        paneId: spec.pane_id,
        provider: 'copilot',
        attemptId: spec.attempt_id,
        runtimeCliPath: spec.runtime_cli_path,
    });
    if (!attempt)
        return 'invalid_spec';
    const session = {
        schema_version: 1,
        team_name: spec.team_name,
        worker_name: spec.worker_name,
        attempt_id: spec.attempt_id,
        host_pid: deps.pid,
        runtime_pid: null,
        runtime_start_identity: null,
        session_id: null,
        model: spec.model ?? null,
        state: 'starting',
        turns: 0,
        queued: 0,
        delivered: [],
        last_event_type: null,
        last_event_at: null,
        updated_at: new Date().toISOString(),
        usage: { credits: 0, premium_requests: 0, shutdown_premium_requests: null, shutdown_credits: null },
        hooks: { session_end_runs: 0, failed: 0 },
        aborts: 0,
        permissions: [],
        last_error: null,
        timeline: { host_started_at: new Date().toISOString() },
    };
    let dirty = true;
    const writeSessionJson = deps.writeSessionJson ?? atomicWriteJson;
    // Budget ledger (src/budget): this worker's live usage under its team. Fail-open.
    // Live AI Credits are summed from `assistant.usage` as billed; the legacy premium
    // request count is x1 per user-initiated call. The record is an estimate until the
    // shutdown totals arrive; the ledger lets measured replace it.
    // The lock is tried once (timeoutMs 0) so the event loop never blocks on it:
    // on contention the next flush retries. Returns false when a retry is due.
    let recordedUsage = 'estimated:0:0';
    const recordBudget = () => {
        const u = session.usage;
        const measured = u.shutdown_credits !== null || u.shutdown_premium_requests !== null;
        const premiumRequests = u.shutdown_premium_requests ?? u.premium_requests;
        const credits = u.shutdown_credits ?? u.credits;
        const stamp = `${measured ? 'measured' : 'estimated'}:${premiumRequests}:${credits}`;
        if (stamp === recordedUsage || deps.env.OMC_BUDGET_GOVERNOR === '0')
            return true;
        try {
            recordUsage(ledgerPath(spec.leader_cwd), `${spec.worker_name}:${spec.attempt_id}`, {
                credits,
                premiumRequests,
                source: measured ? 'measured' : 'estimated',
                detail: measured ? 'session.shutdown' : 'sdk assistant.usage: AI credits as billed (legacy premium requests: user-initiated calls x1 each)',
                ...(session.model ? { model: session.model } : {}),
                updatedAt: new Date().toISOString(),
            }, spec.team_name, { timeoutMs: 0 });
            recordedUsage = stamp;
            return true;
        }
        catch (err) {
            const busy = errText(err).startsWith('Failed to acquire file lock');
            if (!busy) {
                log(`budget ledger write failed: ${errText(err)}`);
                recordedUsage = stamp; // not a contention: do not retry every tick
            }
            return !busy;
        }
    };
    const flush = async (force = false) => {
        if (!dirty && !force)
            return;
        dirty = false;
        session.updated_at = new Date().toISOString();
        if (!recordBudget())
            dirty = true;
        try {
            await writeSessionJson(files.session, session);
        }
        catch (err) {
            // win32: the rename fails (EPERM/EBUSY) while a reader holds the file; retry on the next tick.
            dirty = true;
            log(`session write failed: ${errText(err)}`);
        }
    };
    const mark = (stamp) => {
        if (stamp && !session.timeline[stamp])
            session.timeline[stamp] = new Date().toISOString();
        dirty = true;
    };
    // 1. Launch protocol: ack, leader decision, provider_started (this host).
    const identity = identityOf(attempt);
    const startIdentity = deps.startIdentity(deps.pid);
    const groupFields = deps.platform === 'win32' ? {} : { process_group_id: deps.pid };
    const writeTerminal = async (cleanupVerified) => {
        // Without a start identity no terminal record is valid evidence; the
        // leader's stop then falls back to the session file and the host pid.
        if (!startIdentity)
            return;
        const record = {
            ...identity,
            kind: 'worker_launch_provider_terminal',
            outcome: cleanupVerified ? 'exit' : 'cleanup_unverified',
            cleanup_verified: cleanupVerified,
            pid: deps.pid,
            process_start_identity: startIdentity,
            exit_code: 0,
            signal: null,
            written_at: new Date().toISOString(),
            ...(deps.platform === 'win32' ? {} : { child_reaped: true, ...groupFields }),
        };
        try {
            await atomicWriteJson(`${attempt.startedPath}.terminal`, record);
        }
        catch (err) {
            log(`terminal write failed: ${errText(err)}`);
        }
        if (cleanupVerified && existsSync(`${attempt.startedPath}.termination-request`)) {
            await writeExclusive(`${attempt.startedPath}.termination-complete`, {
                ...identity,
                kind: 'worker_launch_termination_complete',
                cleanup_verified: true,
                pid: deps.pid,
                process_start_identity: startIdentity,
                ...groupFields,
                written_at: new Date().toISOString(),
            }).catch(() => false);
        }
    };
    const fail = async (outcome, error) => {
        session.state = 'failed';
        session.last_error = error;
        mark('closed_at');
        // Terminal first: a leader that sees the `failed` session file may retire
        // the attempt at once, and retirement needs the terminal record.
        await writeTerminal(true);
        await flush(true);
        return outcome;
    };
    if (!await writeExclusive(attempt.ackPath, { ...identity, kind: 'worker_launch_ack', written_at: new Date().toISOString() })) {
        // Another host owns this attempt: its session file and records are not ours to write.
        return 'ack_conflict';
    }
    mark('ack_at');
    const decision = await waitForDecision(attempt, DECISION_TIMEOUT_MS);
    // A host that fails before provider_started still publishes its exit (session
    // file + a terminal record), so a leader stop does not wait out its timeout.
    if (decision !== 'accepted') {
        return fail(decision === 'revoked' ? 'decision_revoked' : 'decision_timeout', `launch decision ${decision}`);
    }
    mark('accepted_at');
    if (!startIdentity)
        return fail('start_failed', 'host process start identity unavailable');
    await writeExclusive(attempt.startedPath, {
        ...identity,
        kind: 'worker_launch_provider_started',
        pid: deps.pid,
        process_start_identity: startIdentity,
        written_at: new Date().toISOString(),
        ...groupFields,
    });
    await flush(true);
    // 2. SDK client + session.
    let loaded = null;
    try {
        loaded = await deps.loadSdk();
    }
    catch {
        loaded = null;
    }
    if (!loaded)
        return fail('sdk_missing', '@github/copilot-sdk is not installed (npm i -g @github/copilot-sdk --omit=optional --ignore-scripts)');
    mkdirSync(files.home, { recursive: true });
    const homeConfig = join(files.home, 'config.json');
    const ident = loginIdentity(spec.user_config_dir);
    if (!existsSync(homeConfig)) {
        writeFileSync(homeConfig, `${JSON.stringify({ ...ident, trustedFolders: [spec.worker_cwd, spec.leader_cwd] }, null, 2)}\n`);
    }
    const hasLogin = ident.loggedInUsers !== undefined;
    const gitHubToken = workerGitHubToken(deps.env, hasLogin);
    if (!hasLogin && !gitHubToken) {
        return fail('start_failed', 'an SDK team worker needs a stored Copilot login (copilot login) or COPILOT_GITHUB_TOKEN; GH_TOKEN and GITHUB_TOKEN are used only without a login');
    }
    writeOmgShims(files.bin, spec.omg_cli_path, spec.node_path);
    const env = buildSessionEnv(deps.env, files.home, { session: false, hasLogin });
    // OMC_BUDGET_HOST_LEDGER: this host records the session's usage; its hooks must not count it again.
    Object.assign(env, spec.worker_env, { OMC_GIT_GUARDRAILS: '1', COPILOT_ALLOW_ALL: 'false', OMC_BUDGET_HOST_LEDGER: '1' });
    // The leader's COPILOT_HOME / COPILOT_MODEL (pane workers' getWorkerEnv) must not replace the worker's own home
    // or the explicit --model; the scrub runs after the merge, so worker_env cannot bring a credential back.
    env.COPILOT_HOME = files.home;
    delete env.COPILOT_MODEL;
    scrubWorkerCredentials(env, join(files.home, 'no-credentials'));
    prependPath(env, files.bin, deps.platform);
    const policy = {
        cwd: spec.worker_cwd,
        stateRoot: spec.state_root,
        pluginRoot: spec.plugin_root,
        readRoots: [files.home],
        mcpServer: spec.mcp_server,
        denyTools: spec.deny_tools,
        denyUrls: spec.deny_urls,
        platform: deps.platform,
    };
    const cap = Math.max(RUNTIME_MIN_MAX_CREDITS, Math.ceil(spec.max_credits));
    const denyFlags = [
        ...spec.deny_tools.map((p) => `--deny-tool=${p}`),
        ...spec.deny_urls.map((p) => `--deny-url=${p}`),
    ];
    const { CopilotClient, RuntimeConnection } = loaded.module;
    const client = new CopilotClient({
        connection: RuntimeConnection.forStdio({
            path: spec.copilot_bin,
            args: ['--log-level', 'debug', '--max-ai-credits', String(cap), ...denyFlags],
            env,
        }),
        baseDirectory: files.home,
        workingDirectory: spec.worker_cwd,
    });
    let sessionRef = null;
    let busy = false;
    let capped = false;
    let idleWaiter = null;
    let shutdownSeen = null;
    const shutdownEvent = new Promise((r) => { shutdownSeen = r; });
    const onEvent = (event) => {
        const at = new Date().toISOString();
        try {
            appendFileSync(files.events, `${JSON.stringify({ at, ...event })}\n`);
        }
        catch { /* evidence only */ }
        session.last_event_type = event.type ?? null;
        session.last_event_at = at;
        const data = (event.data ?? {});
        switch (event.type) {
            case 'session.idle':
                busy = false;
                session.state = capped ? 'capped' : 'idle';
                idleWaiter?.();
                break;
            case 'assistant.message':
                mark('first_message_at');
                break;
            case 'assistant.usage': {
                session.usage.credits += usageCredits(event);
                if (data.initiator === 'user')
                    session.usage.premium_requests += 1;
                if (!capped && session.usage.credits >= spec.max_credits) {
                    capped = true;
                    session.last_error = `credit cap ${spec.max_credits} reached (${session.usage.credits.toFixed(2)})`;
                    void sessionRef?.abort().catch(() => undefined);
                }
                break;
            }
            case 'session.shutdown':
                if (typeof data.totalPremiumRequests === 'number')
                    session.usage.shutdown_premium_requests = data.totalPremiumRequests;
                if (typeof data.totalNanoAiu === 'number')
                    session.usage.shutdown_credits = data.totalNanoAiu / NANO_AIU_PER_CREDIT;
                shutdownSeen?.();
                break;
            case 'session.error':
            case 'model.turn_failed':
                session.last_error = String(data.message ?? data.error ?? data.reason ?? event.type).slice(0, 500);
                break;
            case 'abort':
                session.aborts += 1;
                break;
            case 'hook.start':
                if (data.hookType === 'sessionEnd')
                    session.hooks.session_end_runs += 1;
                break;
            case 'hook.end':
                if (data.success === false)
                    session.hooks.failed += 1;
                break;
            default:
                break;
        }
        dirty = true;
    };
    const onPermissionRequest = (req) => {
        const decision = decideSdkPermission(req, policy);
        session.permissions.push({
            at: new Date().toISOString(),
            kind: String(req.kind),
            approve: decision.approve,
            reason: decision.reason,
            detail: String(req.fullCommandText ?? req.resolvedPath ?? req.fileName ?? req.path ?? req.url ?? req.toolName ?? '').slice(0, 300),
        });
        if (session.permissions.length > PERMISSION_LOG_MAX)
            session.permissions.splice(0, session.permissions.length - PERMISSION_LOG_MAX);
        dirty = true;
        return decision.approve
            ? { kind: 'approve-once' }
            : { kind: 'reject', feedback: `omg team sdk worker policy: ${decision.reason}` };
    };
    const excludedTools = buildSdkExcludedTools(spec.mcp_server, spec.deny_tools);
    // team.sdk.inProcessTools: the plugin tools as SDK session tools; null (no
    // builder, or an SDK without the capability) keeps the `t` MCP server.
    let inProcess = null;
    let builderLoaded = false;
    if (spec.in_process_tools) {
        try {
            const build = deps.loadInProcessTools ? await deps.loadInProcessTools() : null;
            builderLoaded = build !== null;
            inProcess = build ? build(loaded.module, spec.mcp_server, excludedTools, env.OMC_DISABLE_TOOLS) : null;
        }
        catch (err) {
            log(`in-process tools failed to load: ${errText(err)}`);
        }
        if (!inProcess)
            log(`in-process tools unavailable; using the ${spec.mcp_server} MCP server`);
    }
    session.tool_transport = inProcess ? 'in-process' : 'mcp';
    // In-process guards. The tools share this process, so a throw that escapes
    // a tool handler (timer, stream, native module) would kill the worker with
    // no terminal record. An unhandled rejection is logged and recorded and the
    // host keeps serving: the rejected promise is not the handler's own (callTool
    // turns those into isError results). An uncaughtException leaves the process
    // state undefined (Node docs), so the host stops hard: the runtime is
    // killed, the tools are cleaned up, and the terminal record plus a `failed`
    // session let the leader reclaim the task at once instead of waiting for a
    // dead pid. The builder's import also adds the LSP client manager's
    // SIGTERM/SIGINT/SIGHUP listeners, which replace Node's default exit, so the
    // host handles those signals itself: a hard stop, as for a termination request.
    let crashed = null;
    let signalled = null;
    const guards = [];
    if (builderLoaded && deps.processEvents) {
        guards.push(['uncaughtException', (err) => {
                crashed = errText(err);
                session.last_error = `in-process tool crash: ${crashed}`.slice(0, 500);
                log(`uncaughtException: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
                dirty = true;
            }]);
        guards.push(['unhandledRejection', (reason) => {
                session.last_error = `unhandled rejection: ${errText(reason)}`.slice(0, 500);
                log(`unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
                dirty = true;
            }]);
        for (const sig of STOP_SIGNALS)
            guards.push([sig, () => { signalled ??= sig; log(`${sig}: stopping`); }]);
        for (const [event, handler] of guards)
            deps.processEvents.on(event, handler);
    }
    const removeGuards = () => { for (const [event, handler] of guards)
        deps.processEvents?.off(event, handler); };
    const createWith = (tools) => withTimeout(client.createSession({
        onPermissionRequest,
        onEvent,
        pluginDirectories: [spec.plugin_root],
        workingDirectory: spec.worker_cwd,
        disabledMcpServers: tools ? ['github-mcp-server', tools.disabledMcpServer] : ['github-mcp-server'],
        // The explicit Copilot credential over the session RPC, never in the env shell children inherit.
        ...(gitHubToken ? { gitHubToken } : {}),
        excludedTools,
        ...(tools ? { tools: tools.tools } : {}),
        ...(spec.model ? { model: spec.model } : {}),
    }), RPC_TIMEOUT_MS, 'createSession()');
    try {
        await withTimeout(client.start(), START_TIMEOUT_MS, 'client.start()');
        session.runtime_pid = runtimePid(client) ?? null;
        // The leader's last-resort kill checks this identity, never a bare pid.
        session.runtime_start_identity = session.runtime_pid ? deps.startIdentity(session.runtime_pid) : null;
        mark('client_started_at');
        // The runtime has its env now; the in-process handlers get the same one.
        if (inProcess)
            adoptSessionEnv(deps.env, env);
        sessionRef = await createWith(inProcess);
        // The SDK capability check above sees the module only. Ask the session
        // whether it offers a tool: not offered means the runtime ignored
        // `tools`, so recreate the session on the MCP server; unknown (no metadata
        // RPC) keeps in-process but records it as unverified.
        if (inProcess && inProcess.tools.length > 0) {
            const probe = inProcess.tools.find((t) => t.name === `${spec.mcp_server}-state_read`)?.name ?? inProcess.tools[0].name;
            const offered = await sessionOffersTool(sessionRef, probe);
            if (offered === false) {
                log(`in-process tool ${probe} not offered by the session; recreating it on the ${spec.mcp_server} MCP server`);
                const stale = sessionRef;
                sessionRef = null;
                try {
                    await withTimeout(stale.disconnect(), RPC_TIMEOUT_MS, 'disconnect()');
                }
                catch { /* replaced */ }
                try {
                    await withTimeout(client.deleteSession(stale.sessionId), RPC_TIMEOUT_MS, 'deleteSession()');
                }
                catch { /* best effort */ }
                inProcess = null;
                session.tool_transport = 'mcp';
                sessionRef = await createWith(null);
            }
            else {
                session.tool_transport_verified = offered === true;
                if (offered === null)
                    log(`in-process tools unverified: the session reports no tool metadata`);
            }
        }
        else if (inProcess) {
            // Nothing to offer (workerDenyTools denies the whole server): nothing to verify.
            session.tool_transport_verified = true;
        }
        session.session_id = sessionRef.sessionId;
        session.state = 'idle';
        mark('session_created_at');
        await flush(true);
    }
    catch (err) {
        const pid = session.runtime_pid ?? runtimePid(client);
        if (pid && deps.isAlive(pid))
            deps.killTree(pid);
        try {
            await withTimeout(client.forceStop?.() ?? Promise.resolve(), 5_000, 'forceStop()');
        }
        catch { /* gone */ }
        removeGuards();
        return fail('start_failed', errText(err));
    }
    // 3. Doorbell loop.
    const queue = [];
    let offset = 0;
    let stop = null;
    let outcome = 'stopped';
    const s = sessionRef;
    for (;;) {
        const read = readDoorbell(files.doorbell, offset);
        offset = read.offset;
        for (const entry of read.entries) {
            if (entry.kind === 'prompt' && typeof entry.text === 'string' && entry.text.trim()) {
                queue.push({ id: entry.id, text: entry.text });
            }
            else if (entry.kind === 'abort') {
                if (busy)
                    await s.abort().catch(() => undefined);
            }
            else if (entry.kind === 'shutdown') {
                try {
                    await atomicWriteJson(files.shutdownAck, { status: 'accept', reason: 'sdk_host_shutdown', updated_at: new Date().toISOString() });
                }
                catch (err) {
                    log(`shutdown ack failed: ${errText(err)}`);
                }
                stop = 'graceful';
            }
            else if (entry.kind === 'stop') {
                stop = 'graceful';
            }
            else if (entry.kind === 'probe' && !busy) {
                await atomicWriteJson(files.probe, await probeSession(s)).catch(() => undefined);
            }
        }
        // Also the first check of a crash or signal that arrived during startup
        // (its RPCs cannot be cancelled): before any prompt is sent.
        if (!stop && crashed) {
            stop = 'hard';
            outcome = 'tool_crash';
        }
        if (!stop && signalled) {
            stop = 'hard';
            outcome = 'terminated';
        }
        if (!stop && existsSync(`${attempt.startedPath}.termination-request`)) {
            stop = 'hard';
            outcome = 'terminated';
        }
        if (!stop && !existsSync(spec.state_root)) {
            stop = 'hard';
            outcome = 'team_gone';
        }
        if (stop)
            break;
        session.queued = queue.length;
        if (!busy && queue.length > 0 && !capped) {
            const next = queue.shift();
            busy = true;
            session.state = 'busy';
            session.turns += 1;
            session.delivered.push(next.id);
            mark('first_send_at');
            try {
                await withTimeout(s.send({ prompt: next.text }), RPC_TIMEOUT_MS, 'send()');
            }
            catch (err) {
                busy = false;
                session.state = 'idle';
                session.last_error = `send failed: ${errText(err)}`;
            }
        }
        await flush();
        await sleep(deps.pollMs);
    }
    // 4. Teardown.
    session.state = 'closing';
    await flush(true);
    const pid = session.runtime_pid ?? runtimePid(client) ?? undefined;
    if (stop === 'hard') {
        if (pid && deps.isAlive(pid))
            deps.killTree(pid);
        try {
            await withTimeout(client.forceStop?.() ?? Promise.resolve(), 5_000, 'forceStop()');
        }
        catch { /* gone */ }
    }
    else {
        if (busy) {
            const settled = new Promise((r) => { idleWaiter = r; });
            await s.abort().catch(() => undefined);
            await Promise.race([settled, sleep(ABORT_GRACE_MS)]);
        }
        try {
            await withTimeout(s.disconnect(), RPC_TIMEOUT_MS, 'disconnect()');
        }
        catch { /* runtime gone */ }
        await Promise.race([shutdownEvent, sleep(SHUTDOWN_GRACE_MS)]);
        try {
            await withTimeout(client.deleteSession(s.sessionId), RPC_TIMEOUT_MS, 'deleteSession()');
        }
        catch { /* best effort */ }
        let stopped = false;
        try {
            await withTimeout(client.stop(), STOP_TIMEOUT_MS, 'client.stop()');
            stopped = true;
        }
        catch { /* escalate */ }
        if (!stopped) {
            if (pid && deps.isAlive(pid))
                deps.killTree(pid);
            try {
                await withTimeout(client.forceStop?.() ?? Promise.resolve(), STOP_TIMEOUT_MS, 'forceStop()');
            }
            catch { /* gone */ }
        }
    }
    if (pid && deps.isAlive(pid))
        deps.killTree(pid);
    const runtimeGone = !pid || !deps.isAlive(pid);
    // The MCP server's shutdown cleanup, which in-process mode does not get: the
    // detached Python REPL bridges and the LSP servers would outlive the host.
    if (inProcess) {
        try {
            await withTimeout(inProcess.cleanup(), TOOL_CLEANUP_TIMEOUT_MS, 'in-process tool cleanup');
        }
        catch (err) {
            log(`in-process tool cleanup: ${errText(err)}`);
        }
    }
    removeGuards();
    mark('closed_at');
    if (outcome === 'tool_crash') {
        // As fail(): terminal record first, then the `failed` session file.
        session.state = 'failed';
        await writeTerminal(runtimeGone);
        await flush(true);
        return outcome;
    }
    session.state = 'closed';
    await flush(true);
    // The final totals: a few async retries if a hook holds the ledger lock.
    for (let i = 0; i < 10 && !recordBudget(); i++)
        await sleep(50);
    await writeTerminal(runtimeGone);
    return outcome;
}
/** CLI entry (`omg team sdk-host --spec <file>`): runs the host, then exits the process. */
export async function runSdkHostMain(specPath, loadInProcessTools) {
    const { spawnSync } = await import('node:child_process');
    const { loadCopilotSdk } = await import('../smoke/copilot-sdk-driver.js');
    const { killProcessTree } = await import('../smoke/process-utils.js');
    const { getProcessStartIdentitySync, isProcessAlive } = await import('../platform/process-utils.js');
    const log = (line) => { process.stdout.write(`${new Date().toISOString()} [sdk-host ${process.pid}] ${line}\n`); };
    let code = 1;
    try {
        const spec = JSON.parse(readFileSync(specPath, 'utf8'));
        if (spec?.schema_version !== 1 || !spec.worker_name || !spec.state_root)
            throw new Error('invalid sdk host spec');
        log(`start team=${spec.team_name} worker=${spec.worker_name} attempt=${spec.attempt_id}`);
        const outcome = await runSdkHost(spec, {
            loadSdk: () => loadCopilotSdk(process.env, spawnSync),
            pid: process.pid,
            startIdentity: (pid) => getProcessStartIdentitySync(pid),
            isAlive: (pid) => isProcessAlive(pid),
            killTree: (pid) => killProcessTree(pid, spawnSync),
            platform: process.platform,
            pollMs: 250,
            env: process.env,
            log,
            ...(loadInProcessTools ? { loadInProcessTools, processEvents: process } : {}),
        });
        log(`exit outcome=${outcome}`);
        code = outcome === 'stopped' || outcome === 'terminated' || outcome === 'team_gone' ? 0 : 1;
    }
    catch (err) {
        log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
    process.exit(code);
}
//# sourceMappingURL=sdk-host.js.map