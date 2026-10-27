/**
 * `copilot_run_*` jobs: one headless Copilot SDK session per job, started from
 * an MCP tool so Claude Code (or any MCP client) can hand a task to Copilot
 * and review the result.
 *
 * A job runs inside the MCP server process (jobs are in memory and end with
 * it). Its session reuses the SDK team worker setup: the SDK loader and
 * runtime binary of the smoke driver, a per-job COPILOT_HOME with the copied
 * login identity (copilot-session-env.ts), and the worker permission policy
 * (sdk-policy.ts) with writes confined to the job's working directory.
 *
 * Safety:
 * - `start` refuses unless OMG_COPILOT_RUN_ALLOW=1 is set in the server env;
 * - the budget governor (src/budget) is asked first, like an `omg team`
 *   launch of one copilot worker, and the spend is recorded in the ledger
 *   (live estimate, then the `session.shutdown` totals);
 * - isolation `worktree` (default) runs Copilot in a new git worktree and
 *   branch (src/team/git-worktree.ts, team name {@link WORKTREE_TEAM}); the
 *   caller's tree is used only with isolation `none`;
 * - writes to the ship merge-rule files (PROTECTED_PATHS plus a configured
 *   ship.knownFlakyFile) are refused;
 * - a credit cap, a job timeout and cancel all abort the session; so does the
 *   server's shutdown (stopAll);
 * - at most {@link MAX_RUNNING_JOBS} jobs run at once;
 * - `cleanup` removes a job's worktree only when it is clean and holds no
 *   commit the repository HEAD lacks (removeWorkerWorktree refuses otherwise);
 *   ignored files in it (build output, .env) go with it, links (a junctioned
 *   node_modules) are unlinked first so their targets survive.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { formatAmount } from '../budget/governor.js';
import { ledgerPath, NANO_AIU_PER_CREDIT, recordUsage } from '../budget/ledger.js';
import { getOmcRoot } from '../lib/worktree-paths.js';
import { configuredProtectedPaths } from '../ship/config.js';
import { protectedChanges } from '../ship/merge.js';
import { resolveCopilotBinary } from '../smoke/copilot-binary.js';
import { loadCopilotSdk, resolveShimTarget, runtimePid, } from '../smoke/copilot-sdk-driver.js';
import { RUNTIME_MIN_MAX_CREDITS, usageCredits } from '../smoke/copilot-sdk-scenarios.js';
import { buildSessionEnv, loginIdentity, resolveDefaultPluginRoot } from '../smoke/copilot-session-env.js';
import { killProcessTree } from '../smoke/process-utils.js';
import { ensureWorkerWorktree, getBranchName, getWorktreePath, removeWorkerWorktree } from '../team/git-worktree.js';
import { buildSdkExcludedTools, decideSdkPermission } from '../team/sdk-policy.js';
import { getCopilotConfigDir } from '../utils/config-dir.js';
import { COPILOT_RUN_ALLOW_ENV } from './names.js';
export const DEFAULT_TIMEOUT_MS = 15 * 60_000;
export const MAX_TIMEOUT_MS = 60 * 60_000;
export const DEFAULT_MAX_CREDITS = RUNTIME_MIN_MAX_CREDITS;
export const MAX_RUNNING_JOBS = 2;
export const MAX_PROMPT_CHARS = 100_000;
/** Team name of the job worktrees: `.omg/team/copilot-run/worktrees/<jobId>`, branch `omc-team/copilot-run/<jobId>`. */
export const WORKTREE_TEAM = 'copilot-run';
const MCP_SERVER = 't';
const START_TIMEOUT_MS = 60_000;
const RPC_TIMEOUT_MS = 30_000;
const ABORT_GRACE_MS = 10_000;
const SHUTDOWN_GRACE_MS = 2_000;
const STOP_TIMEOUT_MS = 15_000;
/** stopAll's wait for the teardowns before it kills the runtimes (the server force-exits at 5 s). */
const SERVER_EXIT_GRACE_MS = 3_000;
const GIT_TIMEOUT_MS = 30_000;
const DENIED_LOG_MAX = 50;
const JOB_ID = /^cr-[0-9a-f]{12}$/;
export class CopilotRunError extends Error {
}
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const errText = (err) => (err instanceof Error ? err.message : String(err));
const isTerminal = (s) => s !== 'starting' && s !== 'running';
function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); }),
    ]).finally(() => clearTimeout(timer));
}
/** Wait for `promise` (which never rejects) or `ms`, whichever comes first; the timer is cleared either way. */
function settleWithin(promise, ms) {
    let timer;
    return Promise.race([
        promise.then(() => { }),
        new Promise((r) => { timer = setTimeout(r, ms); }),
    ]).finally(() => clearTimeout(timer));
}
/** One git command as an argv array (never a shell); trimmed stdout, or null on failure. */
function git(cwd, args) {
    try {
        return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: GIT_TIMEOUT_MS }).trim();
    }
    catch {
        return null;
    }
}
const lines = (text) => (text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
/**
 * What changed in the repository around `cwd` since `base`; null when git
 * cannot tell. Run at the toplevel (cwd may be a subdirectory), so every path
 * is root-relative and untracked files outside the subdirectory count too.
 */
export function summarizeChanges(cwd, base, extraProtected = []) {
    if (!base)
        return null;
    const top = git(cwd, ['rev-parse', '--show-toplevel']);
    if (!top)
        return null;
    const stat = git(top, ['diff', '--stat', base, '--']);
    const names = git(top, ['diff', '--name-only', base, '--']);
    if (stat === null || names === null)
        return null;
    const changedFiles = lines(names);
    const untrackedFiles = lines(git(top, ['ls-files', '--others', '--exclude-standard']));
    return {
        diffStat: stat,
        changedFiles,
        untrackedFiles,
        protectedChanges: protectedChanges([...changedFiles, ...untrackedFiles], extraProtected),
    };
}
/** The repository-relative path when `path` lies in `root`, else null. */
function relativeInside(path, root) {
    const rel = relative(resolve(root), resolve(path));
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replace(/\\/g, '/') : null;
}
export function defaultCopilotRunDeps(env = process.env) {
    return {
        env,
        platform: process.platform,
        loadSdk: () => loadCopilotSdk(env, spawnSync),
        resolveBin: () => resolveCopilotBinary(undefined, env).bin,
        pluginRoot: () => resolveDefaultPluginRoot(env),
        userConfigDir: () => getCopilotConfigDir(),
        isAlive: (pid) => { try {
            process.kill(pid, 0);
            return true;
        }
        catch (err) {
            return err.code === 'EPERM';
        } },
        killTree: (pid) => killProcessTree(pid, spawnSync),
    };
}
export class CopilotRunManager {
    deps;
    jobs = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    /** Validate, ask the budget governor, prepare the worktree, and start the session in the background. */
    start(input) {
        if (this.deps.env[COPILOT_RUN_ALLOW_ENV] !== '1') {
            throw new CopilotRunError(`copilot_run_start runs a live, billed Copilot session and is disabled. Set ${COPILOT_RUN_ALLOW_ENV}=1 in the MCP server env `
                + `(claude mcp add omg-dev -e ${COPILOT_RUN_ALLOW_ENV}=1 -- node <oh-my-copilot>/dist/mcp/standalone-server.js).`);
        }
        const prompt = input.prompt;
        if (typeof prompt !== 'string' || !prompt.trim())
            throw new CopilotRunError('copilot_run_start: prompt is empty.');
        if (prompt.length > MAX_PROMPT_CHARS)
            throw new CopilotRunError(`copilot_run_start: prompt is longer than ${MAX_PROMPT_CHARS} characters.`);
        const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
            throw new CopilotRunError(`copilot_run_start: timeoutMs must be positive and at most ${MAX_TIMEOUT_MS}.`);
        }
        const maxCredits = input.maxCredits ?? DEFAULT_MAX_CREDITS;
        if (!Number.isFinite(maxCredits) || maxCredits <= 0)
            throw new CopilotRunError('copilot_run_start: maxCredits must be a positive number.');
        const isolation = input.isolation ?? 'worktree';
        const cwd = resolve(input.cwd ?? process.cwd());
        let isDir = false;
        try {
            isDir = statSync(cwd).isDirectory();
        }
        catch { /* missing */ }
        if (!isDir)
            throw new CopilotRunError(`copilot_run_start: cwd ${JSON.stringify(cwd)} is not an existing directory.`);
        const repoRoot = git(cwd, ['rev-parse', '--show-toplevel']);
        if (isolation === 'worktree' && !repoRoot) {
            throw new CopilotRunError(`copilot_run_start: cwd ${JSON.stringify(cwd)} is not inside a git repository; isolation "worktree" needs one (or pass isolation: "none").`);
        }
        const running = [...this.jobs.values()].filter((j) => !isTerminal(j.status)).length;
        if (running >= MAX_RUNNING_JOBS) {
            throw new CopilotRunError(`copilot_run_start: ${running} job(s) already running (limit ${MAX_RUNNING_JOBS}); wait for or cancel one first.`);
        }
        const ledgerCwd = repoRoot ? resolve(repoRoot) : cwd;
        const notes = [];
        const id = `cr-${randomBytes(6).toString('hex')}`;
        let workCwd = cwd;
        let worktree = null;
        let baseCommit = repoRoot ? git(cwd, ['rev-parse', 'HEAD']) : null;
        if (isolation === 'worktree') {
            let info;
            try {
                info = ensureWorkerWorktree(WORKTREE_TEAM, id, ledgerCwd, { mode: 'named', requireCleanLeader: false });
            }
            catch (err) {
                // A failure after `git worktree add` leaves a worktree no job id can clean: remove it now (same safety checks), or name it.
                const path = getWorktreePath(ledgerCwd, WORKTREE_TEAM, id);
                const branch = getBranchName(WORKTREE_TEAM, id);
                let left = '';
                if (existsSync(path)) {
                    try {
                        removeWorkerWorktree(WORKTREE_TEAM, id, ledgerCwd);
                    }
                    catch { /* reported below */ }
                    if (existsSync(path))
                        left = ` The partly created worktree ${path} (branch ${branch}) is left; check it and remove it by hand (unlink any junction in it first).`;
                }
                throw new CopilotRunError(`copilot_run_start: could not create the job worktree: ${errText(err)}.${left}`);
            }
            if (!info)
                throw new CopilotRunError('copilot_run_start: worktree creation unexpectedly disabled.');
            // The caller's subdirectory, mirrored in the worktree.
            const sub = relativeInside(cwd, ledgerCwd);
            workCwd = sub && existsSync(join(info.path, sub)) ? join(info.path, sub) : info.path;
            worktree = { path: info.path, branch: info.branch, repoRoot: ledgerCwd };
            baseCommit = info.baseCommit ?? baseCommit;
            if (lines(git(ledgerCwd, ['status', '--porcelain', '--untracked-files=no'])).length > 0) {
                notes.push(`${ledgerCwd} has uncommitted changes; the worktree starts from HEAD ${baseCommit?.slice(0, 12) ?? '?'} without them.`);
            }
        }
        else if (repoRoot) {
            notes.push('isolation "none": Copilot works in your working tree; the change summary includes edits that were already there.');
        }
        let extraProtected = [];
        try {
            extraProtected = configuredProtectedPaths(ledgerCwd);
        }
        catch { /* the defaults still apply */ }
        const jobDir = join(getOmcRoot(ledgerCwd), 'state', 'copilot-run', id);
        let requestStop = () => { };
        const stopped = new Promise((r) => { requestStop = (reason) => { if (!job.stopReason)
            job.stopReason = reason; r(); }; });
        const job = {
            id,
            status: 'starting',
            prompt,
            cwd,
            workCwd,
            isolation,
            model: input.model ?? null,
            timeoutMs,
            maxCredits,
            ledgerCwd,
            jobDir,
            home: join(jobDir, 'home'),
            eventsPath: join(jobDir, 'events.jsonl'),
            baseCommit,
            worktree,
            extraProtected,
            pid: undefined,
            startedAt: new Date().toISOString(),
            endedAt: null,
            sessionId: null,
            finalText: null,
            error: null,
            notes,
            usage: { premiumRequests: 0, credits: 0, measured: false },
            denied: [],
            changes: null,
            cleanedUp: false,
            stopReason: null,
            requestStop: (reason) => requestStop(reason),
            stopped,
            done: Promise.resolve(),
        };
        this.jobs.set(id, job);
        const timer = setTimeout(() => job.requestStop('timeout'), timeoutMs);
        timer.unref?.();
        // The status turns terminal only after the teardown and the change summary.
        job.done = this.run(job)
            .catch((err) => { job.error ??= errText(err); return 'failed'; })
            .then((outcome) => {
            clearTimeout(timer);
            job.changes = summarizeChanges(job.workCwd, job.baseCommit, job.extraProtected);
            job.endedAt = new Date().toISOString();
            job.status = outcome;
        });
        return this.snapshot(job);
    }
    status(jobId) {
        return this.snapshot(this.find(jobId));
    }
    /** Wait until the job ends or `timeoutMs` passes; the snapshot says which. */
    async wait(jobId, timeoutMs) {
        const job = this.find(jobId);
        await settleWithin(job.done, Math.max(0, timeoutMs));
        return this.snapshot(job);
    }
    /** Abort the session and wait (bounded) for the teardown. */
    async cancel(jobId) {
        const job = this.find(jobId);
        if (!isTerminal(job.status)) {
            job.requestStop('cancelled');
            await settleWithin(job.done, ABORT_GRACE_MS + STOP_TIMEOUT_MS + RPC_TIMEOUT_MS);
        }
        return this.snapshot(job);
    }
    /**
     * Server shutdown: cancel every live job, wait up to `graceMs` for the
     * teardowns, then kill the runtimes still alive. Worktrees stay for review.
     */
    async stopAll(graceMs = SERVER_EXIT_GRACE_MS) {
        const live = [...this.jobs.values()].filter((j) => !isTerminal(j.status));
        for (const job of live)
            job.requestStop('cancelled');
        await settleWithin(Promise.all(live.map((j) => j.done)), graceMs);
        for (const job of live) {
            try {
                if (job.pid && this.deps.isAlive(job.pid))
                    this.deps.killTree(job.pid);
            }
            catch { /* best effort */ }
        }
    }
    /** Remove a finished job's worktree and branch when nothing in them would be lost. */
    cleanup(jobId) {
        const job = this.find(jobId);
        if (!isTerminal(job.status))
            throw new CopilotRunError(`copilot_run_cleanup: job ${jobId} is still ${job.status}; cancel it first.`);
        if (!job.worktree)
            throw new CopilotRunError(`copilot_run_cleanup: job ${jobId} ran with isolation "none"; there is no worktree to remove.`);
        if (!job.cleanedUp) {
            try {
                removeWorkerWorktree(WORKTREE_TEAM, job.id, job.worktree.repoRoot);
            }
            catch (err) {
                throw new CopilotRunError(`copilot_run_cleanup: kept ${job.worktree.path} (branch ${job.worktree.branch}): ${errText(err)}. `
                    + 'Merge or discard the changes yourself (commit them and merge the branch, or delete them), then call cleanup again.');
            }
            job.cleanedUp = true;
            try {
                rmSync(job.jobDir, { recursive: true, force: true });
            }
            catch { /* evidence only */ }
        }
        return { ...this.snapshot(job), cleanup: `removed worktree ${job.worktree.path} and branch ${job.worktree.branch}` };
    }
    find(jobId) {
        if (typeof jobId !== 'string' || !JOB_ID.test(jobId))
            throw new CopilotRunError(`Invalid jobId ${JSON.stringify(jobId)}.`);
        const job = this.jobs.get(jobId);
        if (!job)
            throw new CopilotRunError(`No copilot_run job ${jobId} in this MCP server (jobs live in the server process and end with it).`);
        return job;
    }
    /** Ledger record `copilot-run:<jobId>`; fail-open. False when the lock was busy (retry later). */
    recordBudget(job, lockTimeoutMs) {
        if (this.deps.env.OMC_BUDGET_GOVERNOR === '0')
            return true;
        const usage = {
            premiumRequests: job.usage.premiumRequests,
            credits: job.usage.credits,
            source: job.usage.measured ? 'measured' : 'estimated',
            detail: job.usage.measured
                ? 'session.shutdown'
                : 'copilot_run sdk assistant.usage: AI credits as billed, user-initiated calls x1 each (multiplier unknown)',
            ...(job.model ? { model: job.model } : {}),
            updatedAt: new Date().toISOString(),
        };
        try {
            recordUsage(ledgerPath(job.ledgerCwd), `copilot-run:${job.id}`, usage, undefined, { timeoutMs: lockTimeoutMs });
            return true;
        }
        catch (err) {
            return !errText(err).startsWith('Failed to acquire file lock');
        }
    }
    /** Drive the session to its end and tear it down; returns the final status. */
    async run(job) {
        const { deps } = this;
        mkdirSync(job.home, { recursive: true });
        const loaded = await deps.loadSdk().catch(() => null);
        if (!loaded) {
            job.error = '@github/copilot-sdk is not installed (npm i -g @github/copilot-sdk --omit=optional --ignore-scripts)';
            return 'failed';
        }
        const found = deps.resolveBin();
        const bin = found && deps.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(found) ? resolveShimTarget(found) : found;
        if (!bin) {
            job.error = found ? `copilot shim ${found} names no .js/.exe target` : 'copilot CLI not found (PATH, COPILOT_CLI_PATH, WinGet)';
            return 'failed';
        }
        const pluginRoot = deps.pluginRoot();
        const ident = loginIdentity(deps.userConfigDir());
        writeFileSync(join(job.home, 'config.json'), `${JSON.stringify({ ...ident, trustedFolders: [job.workCwd] }, null, 2)}\n`);
        const env = buildSessionEnv(deps.env, job.home, { session: false, hasLogin: ident.loggedInUsers !== undefined });
        // OMC_BUDGET_HOST_LEDGER: this job records the session's usage; its hooks must not count it again.
        Object.assign(env, { OMC_GIT_GUARDRAILS: '1', COPILOT_ALLOW_ALL: 'false', OMC_BUDGET_HOST_LEDGER: '1' });
        delete env[COPILOT_RUN_ALLOW_ENV];
        const policy = {
            cwd: job.workCwd,
            stateRoot: job.jobDir,
            pluginRoot,
            readRoots: [job.home],
            mcpServer: MCP_SERVER,
            platform: deps.platform,
        };
        const protectedRoot = job.worktree?.path ?? job.ledgerCwd;
        const onPermissionRequest = (req) => {
            let decision = decideSdkPermission(req, policy);
            if (decision.approve && req.kind === 'write') {
                const raw = [req.resolvedPath, req.path, req.fileName].find((v) => typeof v === 'string' && v.trim() !== '');
                const rel = raw ? relativeInside(isAbsolute(raw) ? raw : resolve(job.workCwd, raw), protectedRoot) : null;
                if (rel && protectedChanges([rel], job.extraProtected).length > 0)
                    decision = { approve: false, reason: `protected merge-rule path ${rel}` };
            }
            if (decision.approve)
                return { kind: 'approve-once' };
            job.denied.push({ kind: String(req.kind), reason: decision.reason });
            if (job.denied.length > DENIED_LOG_MAX)
                job.denied.splice(0, job.denied.length - DENIED_LOG_MAX);
            return { kind: 'reject', feedback: `copilot_run policy: ${decision.reason}` };
        };
        let onIdle = () => { };
        let onShutdown = () => { };
        let sent = false;
        let idle = new Promise((r) => { onIdle = r; });
        const shutdown = new Promise((r) => { onShutdown = r; });
        const onEvent = (event) => {
            try {
                appendFileSync(job.eventsPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
            }
            catch { /* evidence only */ }
            const data = (event.data ?? {});
            switch (event.type) {
                case 'session.idle':
                    if (sent)
                        onIdle();
                    break;
                case 'assistant.message':
                    if (typeof data.content === 'string' && data.content.trim())
                        job.finalText = data.content;
                    break;
                case 'assistant.usage':
                    job.usage.credits += usageCredits(event);
                    if (data.initiator === 'user')
                        job.usage.premiumRequests += 1;
                    if (typeof data.model === 'string' && !job.model)
                        job.model = data.model;
                    if (job.usage.credits >= job.maxCredits)
                        job.requestStop('capped');
                    this.recordBudget(job, 0);
                    break;
                case 'session.shutdown':
                    if (typeof data.totalPremiumRequests === 'number') {
                        job.usage.premiumRequests = data.totalPremiumRequests;
                        job.usage.measured = true;
                    }
                    if (typeof data.totalNanoAiu === 'number')
                        job.usage.credits = data.totalNanoAiu / NANO_AIU_PER_CREDIT;
                    if (typeof data.currentModel === 'string')
                        job.model = data.currentModel;
                    onShutdown();
                    break;
                case 'session.error':
                case 'model.turn_failed':
                    job.error = String(data.message ?? data.error ?? data.reason ?? event.type).slice(0, 500);
                    break;
                default:
                    break;
            }
        };
        const { CopilotClient, RuntimeConnection } = loaded.module;
        const cap = Math.max(RUNTIME_MIN_MAX_CREDITS, Math.ceil(job.maxCredits));
        const client = new CopilotClient({
            connection: RuntimeConnection.forStdio({ path: bin, args: ['--max-ai-credits', String(cap)], env }),
            baseDirectory: job.home,
            workingDirectory: job.workCwd,
        });
        let session = null;
        let pid;
        let outcome = 'failed';
        try {
            // A stop (cancel, server exit) during a slow start goes straight to the teardown.
            await withTimeout(Promise.race([client.start(), job.stopped]), START_TIMEOUT_MS, 'client.start()');
            pid = runtimePid(client);
            job.pid = pid;
            if (!job.stopReason) {
                session = await withTimeout(client.createSession({
                    onPermissionRequest,
                    onEvent,
                    pluginDirectories: [pluginRoot],
                    workingDirectory: job.workCwd,
                    disabledMcpServers: ['github-mcp-server'],
                    excludedTools: buildSdkExcludedTools(MCP_SERVER),
                    ...(job.model ? { model: job.model } : {}),
                }), RPC_TIMEOUT_MS, 'createSession()');
                job.sessionId = session.sessionId;
            }
            if (session && !job.stopReason) {
                job.status = 'running';
                sent = true;
                await withTimeout(session.send({ prompt: job.prompt }), RPC_TIMEOUT_MS, 'send()');
                const winner = await Promise.race([idle.then(() => 'idle'), job.stopped.then(() => 'stop')]);
                if (winner === 'stop') {
                    const s = session;
                    idle = new Promise((r) => { onIdle = r; });
                    try {
                        await withTimeout(s.abort(), RPC_TIMEOUT_MS, 'abort()');
                    }
                    catch { /* best effort */ }
                    await settleWithin(idle, ABORT_GRACE_MS);
                }
            }
            outcome = job.stopReason === 'timeout'
                ? 'timeout'
                : job.stopReason === 'cancelled'
                    ? 'cancelled'
                    : job.stopReason === 'capped'
                        ? 'failed'
                        : 'completed';
            if (job.stopReason === 'capped')
                job.error = `credit cap ${job.maxCredits} reached (${job.usage.credits.toFixed(2)} AI credits); the turn was aborted`;
            if (job.stopReason === 'timeout')
                job.error = `timed out after ${job.timeoutMs} ms; the turn was aborted`;
        }
        catch (err) {
            outcome = job.stopReason === 'cancelled' ? 'cancelled' : 'failed';
            job.error = errText(err);
        }
        finally {
            if (session) {
                try {
                    await withTimeout(session.disconnect(), RPC_TIMEOUT_MS, 'disconnect()');
                }
                catch { /* runtime gone */ }
                // session.shutdown (the billing totals) is emitted while the session closes.
                await settleWithin(shutdown, SHUTDOWN_GRACE_MS);
                try {
                    await withTimeout(client.deleteSession(session.sessionId), RPC_TIMEOUT_MS, 'deleteSession()');
                }
                catch { /* best effort */ }
            }
            pid ??= runtimePid(client);
            job.pid = pid;
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
                    await withTimeout(client.forceStop?.() ?? Promise.resolve(), STOP_TIMEOUT_MS, 'client.forceStop()');
                }
                catch { /* gone */ }
            }
            if (pid && deps.isAlive(pid))
                deps.killTree(pid);
            // The final totals: a few retries if a hook holds the ledger lock.
            for (let i = 0; i < 10 && !this.recordBudget(job, 200); i++)
                await sleep(50);
            // The per-job COPILOT_HOME holds the session state and logs; kept when the job did not complete.
            if (outcome === 'completed') {
                try {
                    rmSync(job.home, { recursive: true, force: true });
                }
                catch { /* best effort */ }
            }
        }
        return outcome;
    }
    snapshot(job) {
        const usage = {
            premiumRequests: job.usage.premiumRequests,
            credits: Number(job.usage.credits.toFixed(3)),
            source: job.usage.measured ? 'measured' : 'estimated',
            summary: `${formatAmount(job.usage.premiumRequests, 'premiumRequests')}, ${formatAmount(Number(job.usage.credits.toFixed(3)), 'credits')}`,
        };
        return {
            jobId: job.id,
            status: job.status,
            // Set as soon as a stop is asked for: a cancel that returns while the teardown runs still shows it.
            stopRequested: job.stopReason,
            isolation: job.isolation,
            cwd: job.cwd,
            workingDirectory: job.workCwd,
            model: job.model,
            startedAt: job.startedAt,
            endedAt: job.endedAt,
            timeoutMs: job.timeoutMs,
            maxCredits: job.maxCredits,
            sessionId: job.sessionId,
            finalText: job.finalText,
            error: job.error,
            usage,
            ...(job.worktree ? { worktree: { ...job.worktree, baseCommit: job.baseCommit, removed: job.cleanedUp } } : {}),
            ...(job.changes ? { changes: job.changes } : {}),
            ...(job.denied.length ? { deniedPermissions: job.denied } : {}),
            ...(job.notes.length ? { notes: job.notes } : {}),
            eventsPath: job.eventsPath,
        };
    }
}
//# sourceMappingURL=job.js.map