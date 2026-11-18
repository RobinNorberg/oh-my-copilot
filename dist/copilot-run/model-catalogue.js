/**
 * Which Copilot models the user's plan offers, so a tier alias (opus, sonnet,
 * haiku, fable) resolves to the first model of its fallback list the plan can
 * use instead of always the first id (team/model-contract.ts
 * resolveCopilotModel). Read like factory/bench/model-probe.ts: the Copilot
 * SDK's `listModels()` from a runtime in an isolated job home with only the
 * login identity; no session is created and no prompt is sent.
 *
 * Kept off the hot path: the answer is cached in the omg state dir for 24 h, a
 * failed read is remembered for 1 h, the live read times out after a few
 * seconds, and nothing here throws. A null catalogue means "unknown": callers
 * keep the old behaviour (each tier's first id).
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { atomicWriteJsonSync } from '../lib/atomic-write.js';
import { getGlobalOmcStateRoot } from '../utils/paths.js';
import { errText, withTimeout } from './timeout.js';
// Static, not lazy: bundlers keep only the names used here, while a dynamic import keeps whole modules.
// Not copilot-run/job.ts: it reaches src/factory/**, which the team bundle must not (tests/lint/team-bundle-no-native).
import { allowlistSessionEnv } from './sandbox.js';
import { loadCopilotSdk, resolveShimTarget, runtimePid } from '../smoke/copilot-sdk-driver.js';
import { RUNTIME_MIN_MAX_CREDITS, SDK_INSTALL_COMMAND } from '../smoke/copilot-sdk-scenarios.js';
import { buildSessionEnv, loginIdentity } from '../smoke/copilot-session-env.js';
import { hasExited, killProcessTree } from '../smoke/process-utils.js';
import { childEnv, hardenWindowsExeSearch } from '../utils/windows-search.js';
import { resolveCopilotBinary } from '../smoke/copilot-binary.js';
import { getCopilotConfigDir } from '../utils/config-dir.js';
export const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000;
export const CATALOGUE_FAILURE_TTL_MS = 60 * 60 * 1000;
const START_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 5_000;
/** `<omg state root>/copilot-models-cache.json` (~/.omg/state on Windows and macOS). */
export function copilotCatalogueCacheFile() {
    return join(getGlobalOmcStateRoot(), 'copilot-models-cache.json');
}
/** Ids from a listModels() answer; a model whose policy is `disabled` is not offered. */
export function catalogueFromListModels(entries) {
    if (!Array.isArray(entries))
        return [];
    const ids = [];
    for (const entry of entries) {
        if (typeof entry?.id !== 'string' || !entry.id)
            continue;
        if (entry.policy?.state === 'disabled')
            continue;
        ids.push(entry.id);
    }
    return ids;
}
/**
 * The cache as of `now`: `fresh` within the TTL, `stale` past it, and
 * `recentFailure` when the last live read failed less than the failure TTL ago.
 * A missing or corrupt file reads as empty.
 */
export function readCatalogueCache(file, now, ttlMs = CATALOGUE_TTL_MS, failureTtlMs = CATALOGUE_FAILURE_TTL_MS) {
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(file, 'utf-8'));
    }
    catch {
        return { fresh: null, stale: null };
    }
    const models = Array.isArray(parsed?.models) && parsed.models.every((m) => typeof m === 'string') && parsed.models.length > 0
        ? parsed.models
        : null;
    const fetchedAt = typeof parsed?.fetchedAt === 'string' ? Date.parse(parsed.fetchedAt) : NaN;
    const failedAt = typeof parsed?.failedAt === 'string' ? Date.parse(parsed.failedAt) : NaN;
    const isFresh = models !== null && Number.isFinite(fetchedAt) && now - fetchedAt >= 0 && now - fetchedAt < ttlMs;
    const recentFailure = Number.isFinite(failedAt) && now - failedAt >= 0 && now - failedAt < failureTtlMs
        ? (typeof parsed.detail === 'string' ? parsed.detail : 'the last read failed')
        : undefined;
    return {
        fresh: isFresh ? models : null,
        stale: isFresh ? null : models,
        ...(typeof parsed.fetchedAt === 'string' ? { fetchedAt: parsed.fetchedAt } : {}),
        ...(recentFailure ? { recentFailure } : {}),
    };
}
/**
 * Fresh cache, else a live read (cached on success), else the stale cache,
 * else null. A failed live read is recorded so the next command within the
 * failure TTL does not wait for it again. Never throws.
 */
export async function loadCopilotCatalogueWith(deps) {
    const now = deps.now();
    const cache = readCatalogueCache(deps.file, now, deps.ttlMs, deps.failureTtlMs);
    if (cache.fresh)
        return { catalogue: new Set(cache.fresh), source: 'cache', detail: `cached in ${deps.file}` };
    const fromStale = (why) => cache.stale
        ? { catalogue: new Set(cache.stale), source: 'stale-cache', detail: `${why}; using the stale cached catalogue` }
        : { catalogue: null, source: 'none', detail: why };
    if (cache.recentFailure)
        return fromStale(`the Copilot model catalogue could not be read recently (${cache.recentFailure})`);
    let outcome;
    try {
        outcome = await deps.fetch();
    }
    catch (error) {
        outcome = { error: errText(error) };
    }
    if ('models' in outcome && outcome.models.length > 0) {
        try {
            mkdirSync(dirname(deps.file), { recursive: true });
            atomicWriteJsonSync(deps.file, { fetchedAt: new Date(now).toISOString(), models: outcome.models });
        }
        catch { /* an unwritable state dir only costs the next command a live read */ }
        return { catalogue: new Set(outcome.models), source: 'live', detail: `listModels() offers ${outcome.models.length} models` };
    }
    const why = 'error' in outcome ? outcome.error : 'listModels() returned no models';
    try {
        mkdirSync(dirname(deps.file), { recursive: true });
        atomicWriteJsonSync(deps.file, {
            ...(cache.stale ? { fetchedAt: cache.fetchedAt, models: cache.stale } : {}),
            failedAt: new Date(now).toISOString(),
            detail: why,
        });
    }
    catch { /* best effort */ }
    return fromStale(`the Copilot model catalogue could not be read (${why})`);
}
/** Cache-only read (no runtime started) for sync paths such as the npm postinstall. */
export function readCopilotCatalogueCacheOnly(file, now) {
    const cache = readCatalogueCache(file, now);
    if (cache.fresh)
        return { catalogue: new Set(cache.fresh), source: 'cache', detail: `cached in ${file}` };
    if (cache.stale)
        return { catalogue: new Set(cache.stale), source: 'stale-cache', detail: `stale cache in ${file}` };
    return { catalogue: null, source: 'none', detail: `no cached Copilot model catalogue in ${file}` };
}
/**
 * The live read: start the Copilot runtime in a throwaway job home with only
 * the login identity, call listModels(), stop it. No session, no prompt.
 * `cliPath` overrides the resolved copilot binary.
 */
export async function fetchCopilotCatalogue(opts = {}) {
    // The same runtime dependencies as copilot-run/job.ts defaultCopilotRunDeps().
    hardenWindowsExeSearch();
    const hostEnv = process.env;
    const deps = {
        env: hostEnv,
        platform: process.platform,
        loadSdk: () => loadCopilotSdk(hostEnv, spawnSync),
        resolveBin: () => resolveCopilotBinary(undefined, hostEnv).bin,
        userConfigDir: () => getCopilotConfigDir(),
        killTree: (pid) => killProcessTree(pid, spawnSync),
    };
    const jobRoot = join(tmpdir(), 'omg-model-catalogue');
    const jobHome = join(jobRoot, `list-${randomBytes(4).toString('hex')}`);
    const workDir = join(jobHome, 'work');
    let client = null;
    try {
        mkdirSync(workDir, { recursive: true });
        const loaded = await deps.loadSdk().catch(() => null);
        if (!loaded)
            return { error: `@github/copilot-sdk is not installed or could not be loaded (${SDK_INSTALL_COMMAND})` };
        const found = opts.cliPath && existsSync(opts.cliPath) ? opts.cliPath : deps.resolveBin();
        const bin = found && deps.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(found) ? resolveShimTarget(found) : found;
        if (!bin)
            return { error: 'the copilot CLI was not found' };
        const ident = loginIdentity(deps.userConfigDir());
        writeFileSync(join(jobHome, 'config.json'), `${JSON.stringify({ ...ident, trustedFolders: [workDir] }, null, 2)}\n`);
        const env = childEnv(allowlistSessionEnv(buildSessionEnv(deps.env, jobHome, { session: false, hasLogin: ident.loggedInUsers !== undefined }), jobHome));
        mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
        mkdirSync(dirname(env.GIT_CONFIG_GLOBAL), { recursive: true });
        mkdirSync(env.TEMP, { recursive: true });
        const { CopilotClient, RuntimeConnection } = loaded.module;
        const c = new CopilotClient({
            connection: RuntimeConnection.forStdio({ path: bin, args: ['--max-ai-credits', String(RUNTIME_MIN_MAX_CREDITS)], env }),
            baseDirectory: jobHome,
            workingDirectory: workDir,
        });
        client = c;
        await withTimeout(c.start(), opts.startTimeoutMs ?? START_TIMEOUT_MS, 'client.start()');
        const models = await withTimeout(c.listModels(), opts.listTimeoutMs ?? LIST_TIMEOUT_MS, 'listModels()');
        return { models: catalogueFromListModels(models) };
    }
    catch (error) {
        return { error: errText(error) };
    }
    finally {
        if (client) {
            try {
                await withTimeout(client.stop(), STOP_TIMEOUT_MS, 'client.stop()');
            }
            catch {
                try {
                    await withTimeout(client.forceStop?.() ?? Promise.resolve(), STOP_TIMEOUT_MS, 'client.forceStop()');
                }
                catch { /* gone */ }
            }
            // Same guard as model-probe.ts: end the runtime this client spawned if it still runs.
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
const defaultSource = {
    load: () => loadCopilotCatalogueWith({ file: copilotCatalogueCacheFile(), now: Date.now, fetch: () => fetchCopilotCatalogue() }),
    readCached: () => readCopilotCatalogueCacheOnly(copilotCatalogueCacheFile(), Date.now()),
};
let source = defaultSource;
let memo;
/** The catalogue, read at most once per process. */
export function loadCopilotCatalogue() {
    memo ??= source.load().catch((error) => ({ catalogue: null, source: 'none', detail: errText(error) }));
    return memo;
}
export function readCachedCopilotCatalogue() {
    try {
        return source.readCached();
    }
    catch (error) {
        return { catalogue: null, source: 'none', detail: errText(error) };
    }
}
/** Test seam: replace the source (undefined restores the default) and forget the memoized read. */
export function setCopilotCatalogueSource(next) {
    source = next ?? defaultSource;
    memo = undefined;
}
let warnedUnreadable = false;
/**
 * The catalogue for team startup. When it cannot be read, says once per
 * process that tier aliases fall back to each tier's first model.
 */
export async function teamCopilotCatalogue(warn = (line) => console.warn(line)) {
    const result = await loadCopilotCatalogue();
    if (!result.catalogue && !warnedUnreadable) {
        warnedUnreadable = true;
        warn(`[omg] ${result.detail}; Copilot tier aliases use each tier's first model`);
    }
    return result.catalogue;
}
//# sourceMappingURL=model-catalogue.js.map