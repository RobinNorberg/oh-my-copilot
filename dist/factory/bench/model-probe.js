/**
 * `omg factory bench run --live`: which Copilot model the lanes will use and
 * its premium multiplier, read before any child starts. Lanes pass no model
 * (engine.ts), so they get the runtime's default for a fresh job home with
 * only the login identity. The probe starts the runtime the same way (no
 * user profile, the session env allowlist), reads `listModels()` and the
 * current model of a new session, and ends: no prompt is ever sent, so no
 * model turn runs. Never throws: what it could not read is `null` with why.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultCopilotRunDeps } from '../../copilot-run/job.js';
import { allowlistSessionEnv, sessionGitHubToken } from '../../copilot-run/sandbox.js';
import { errText, withTimeout } from '../../copilot-run/timeout.js';
import { resolveShimTarget, runtimePid } from '../../smoke/copilot-sdk-driver.js';
import { RUNTIME_MIN_MAX_CREDITS } from '../../smoke/copilot-sdk-scenarios.js';
import { buildSessionEnv, loginIdentity } from '../../smoke/copilot-session-env.js';
import { hasExited } from '../../smoke/process-utils.js';
import { childEnv } from '../../utils/windows-search.js';
const START_TIMEOUT_MS = 60_000;
const RPC_TIMEOUT_MS = 30_000;
/** The multiplier of `model` in a listModels() answer; null when absent or not a finite number >= 0. */
export function modelMultiplier(models, model) {
    const m = models.find((x) => x.id === model)?.billing?.multiplier;
    return typeof m === 'number' && Number.isFinite(m) && m >= 0 ? m : null;
}
/**
 * Null when the run may start, else why not. A known multiplier above 1
 * needs `--allow-multiplier` at or above it (one lane then costs that many
 * premium requests). An unknown model or multiplier fails closed: it needs
 * `--allow-multiplier`, given after checking the default model by hand.
 */
export function multiplierRefusal(info, allow) {
    if (info.multiplier === null) {
        if (allow !== undefined)
            return null;
        return `the lanes' default Copilot model ${info.model ?? '(unknown)'} has no known premium multiplier (${info.detail}); check the default Copilot model by hand (/model in an interactive copilot), then rerun with --allow-multiplier <its multiplier, rounded up>`;
    }
    if (info.multiplier <= 1)
        return null;
    if (allow !== undefined && allow >= info.multiplier)
        return null;
    return `the lanes' default Copilot model ${info.model ?? '(unnamed)'} bills ${info.multiplier}x premium requests per call; rerun with --allow-multiplier ${Math.ceil(info.multiplier)} to accept it, or pick a cheaper default model in Copilot`;
}
export async function probeLaneModel(jobRoot, deps = defaultCopilotRunDeps()) {
    const none = (detail) => ({ model: null, multiplier: null, detail });
    const jobHome = join(jobRoot, `model-probe-${randomBytes(4).toString('hex')}`);
    const workDir = join(jobHome, 'work');
    let client = null;
    let session = null;
    try {
        mkdirSync(workDir, { recursive: true });
        const loaded = await deps.loadSdk().catch(() => null);
        if (!loaded)
            return none('@github/copilot-sdk is not installed or could not be loaded');
        const found = deps.resolveBin();
        const bin = found && deps.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(found) ? resolveShimTarget(found) : found;
        if (!bin)
            return none('the copilot CLI was not found');
        const ident = loginIdentity(deps.userConfigDir());
        writeFileSync(join(jobHome, 'config.json'), `${JSON.stringify({ ...ident, trustedFolders: [workDir] }, null, 2)}\n`);
        const env = childEnv(allowlistSessionEnv(buildSessionEnv(deps.env, jobHome, { session: false, hasLogin: ident.loggedInUsers !== undefined }), jobHome));
        mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
        mkdirSync(dirname(env.GIT_CONFIG_GLOBAL), { recursive: true });
        mkdirSync(env.TEMP, { recursive: true });
        const gitHubToken = sessionGitHubToken(deps.env);
        const { CopilotClient, RuntimeConnection } = loaded.module;
        const c = new CopilotClient({
            connection: RuntimeConnection.forStdio({ path: bin, args: ['--max-ai-credits', String(RUNTIME_MIN_MAX_CREDITS)], env }),
            baseDirectory: jobHome,
            workingDirectory: workDir,
        });
        client = c;
        await withTimeout(c.start(), START_TIMEOUT_MS, 'client.start()');
        const models = (await withTimeout(c.listModels(), RPC_TIMEOUT_MS, 'listModels()'));
        // A session with no tools and every permission refused; it is never sent a prompt.
        session = await withTimeout(c.createSession({
            onPermissionRequest: () => ({ kind: 'reject' }),
            pluginDirectories: [],
            workingDirectory: workDir,
            disabledMcpServers: ['github-mcp-server'],
            excludedTools: [],
            availableTools: [],
            ...(gitHubToken ? { gitHubToken } : {}),
        }), RPC_TIMEOUT_MS, 'createSession()');
        const getCurrent = session.rpc.model?.getCurrent;
        if (!getCurrent)
            return none(`this SDK (${loaded.version ?? 'unknown version'}) has no session.rpc.model.getCurrent`);
        const current = await withTimeout(getCurrent(), RPC_TIMEOUT_MS, 'model.getCurrent()');
        const model = typeof current?.modelId === 'string' && current.modelId ? current.modelId : null;
        if (!model) {
            // Picked at the first turn: say what the account offers instead.
            const list = Array.isArray(models) ? models : [];
            const known = list.map((m) => (typeof m.id === 'string' ? modelMultiplier(list, m.id) : null)).filter((m) => m !== null);
            const range = known.length ? `; listModels() offers ${list.length} models, multipliers ${Math.min(...known)}x to ${Math.max(...known)}x` : '';
            return none(`the runtime names no current model for a new session (model.getCurrent: ${JSON.stringify(current ?? null).slice(0, 200)}); the default is picked at the first turn${range}`);
        }
        const multiplier = modelMultiplier(Array.isArray(models) ? models : [], model);
        return { model, multiplier, detail: multiplier === null ? `listModels() gives no billing multiplier for ${model}` : `listModels() billing.multiplier of ${model}` };
    }
    catch (error) {
        return none(`the probe failed: ${errText(error)}`);
    }
    finally {
        if (session) {
            try {
                await withTimeout(session.disconnect(), RPC_TIMEOUT_MS, 'disconnect()');
            }
            catch { /* runtime gone */ }
            try {
                await withTimeout(client.deleteSession(session.sessionId), RPC_TIMEOUT_MS, 'deleteSession()');
            }
            catch { /* best effort */ }
        }
        if (client) {
            try {
                await withTimeout(client.stop(), RPC_TIMEOUT_MS, 'client.stop()');
            }
            catch {
                try {
                    await withTimeout(client.forceStop?.() ?? Promise.resolve(), RPC_TIMEOUT_MS, 'client.forceStop()');
                }
                catch { /* gone */ }
            }
            // The runtime this probe's client spawned, through the SDK's own child handle (set at spawn, also when
            // start() then hung or timed out): if it still runs, end its tree. The handle's exit state guards against
            // a recycled pid. No handle means start() hung before spawning, so nothing of ours is running.
            const proc = client.cliProcess;
            const pid = runtimePid(client);
            if (proc && pid && !hasExited(proc)) {
                try {
                    deps.killTree(pid);
                }
                catch { /* gone */ }
            }
        }
        try {
            rmSync(jobHome, { recursive: true, force: true });
        }
        catch { /* best effort */ }
        try {
            rmdirSync(jobRoot);
        }
        catch { /* not empty, or gone */ }
    }
}
//# sourceMappingURL=model-probe.js.map