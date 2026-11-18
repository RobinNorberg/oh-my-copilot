/**
 * Which Copilot models the user's plan offers, so a tier alias (opus, sonnet,
 * haiku, fable) resolves to the first model of its fallback list the plan can
 * use instead of always the first id (team/model-contract.ts
 * resolveCopilotModel). Read like factory/bench/model-probe.ts: the Copilot
 * SDK's `listModels()` from a runtime in an isolated job home with only the
 * login identity; no session is created and no prompt is sent.
 *
 * Kept off the hot path: the answer is cached in the omg state dir for 24 h, a
 * failed read is remembered for 1 h, the live read answers within
 * FETCH_DEADLINE_MS (its cleanup runs detached, bounded by CLEANUP_BOUND_MS),
 * and nothing here throws. A null catalogue means "unknown": callers
 * keep the old behaviour (each tier's first id).
 */

import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { atomicWriteJsonSync } from '../lib/atomic-write.js';
import { getGlobalOmcStateRoot } from '../utils/paths.js';
import { errText, withTimeout } from './timeout.js';
// Static, not lazy: bundlers keep only the names used here, while a dynamic import keeps whole modules.
// Not copilot-run/job.ts: it reaches src/factory/**, which the team bundle must not (tests/lint/team-bundle-no-native).
import { allowlistSessionEnv, scrubTokens, secretValues } from './sandbox.js';
import { loadCopilotSdk, resolveShimTarget, rethrowSdkStartError, runtimePid, type LoadedSdk, type SdkClientLike } from '../smoke/copilot-sdk-driver.js';
import { RUNTIME_MIN_MAX_CREDITS, SDK_INSTALL_COMMAND } from '../smoke/copilot-sdk-scenarios.js';
import { buildSessionEnv, loginIdentity } from '../smoke/copilot-session-env.js';
import { hasExited, killProcessTree, type SpawnSyncFn } from '../smoke/process-utils.js';
import { childEnv, hardenWindowsExeSearch } from '../utils/windows-search.js';
import { resolveCopilotBinary } from '../smoke/copilot-binary.js';
import { getCopilotConfigDir } from '../utils/config-dir.js';

/** Model ids the plan offers. */
export type CopilotCatalogue = ReadonlySet<string>;

export interface CopilotCatalogueResult {
  /** null when the catalogue could not be read: tier aliases then use each tier's first id. */
  catalogue: CopilotCatalogue | null;
  source: 'cache' | 'live' | 'stale-cache' | 'none';
  /** What was read, or why not. */
  detail: string;
}

export const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000;
export const CATALOGUE_FAILURE_TTL_MS = 60 * 60 * 1000;
/** The whole live read (SDK lookup, runtime start, listModels()) answers within this. */
export const FETCH_DEADLINE_MS = 20_000;
const STALE_JOB_DIR_MS = 60 * 60 * 1000;
/** stop(), forceStop() and the tree kill after a read, together; runs detached from the caller. */
export const CLEANUP_BOUND_MS = 5_000;
/** `npm root -g` (the last SDK lookup) is synchronous, so it is capped instead of raced. */
const NPM_ROOT_TIMEOUT_MS = 3_000;
const DETAIL_MAX_CHARS = 300;

/** A failure detail fit to store and print: tokens redacted, length capped. */
export function redactCatalogueDetail(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const clean = scrubTokens(text, secretValues(env)).replace(/\s+/g, ' ').trim();
  return clean.length > DETAIL_MAX_CHARS ? `${clean.slice(0, DETAIL_MAX_CHARS - 3)}...` : clean;
}

/** `<omg state root>/copilot-models-cache.json` (~/.omg/state on Windows and macOS). */
export function copilotCatalogueCacheFile(): string {
  return join(getGlobalOmcStateRoot(), 'copilot-models-cache.json');
}

interface CacheFileShape {
  fetchedAt?: unknown;
  models?: unknown;
  failedAt?: unknown;
  detail?: unknown;
}

/** Ids from a listModels() answer; a model whose policy is `disabled` is not offered. */
export function catalogueFromListModels(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  const ids: string[] = [];
  for (const entry of entries as Array<{ id?: unknown; policy?: { state?: unknown } }>) {
    if (typeof entry?.id !== 'string' || !entry.id) continue;
    if (entry.policy?.state === 'disabled') continue;
    ids.push(entry.id);
  }
  return ids;
}

/**
 * The cache as of `now`: `fresh` within the TTL, `stale` past it, and
 * `recentFailure` when the last live read failed less than the failure TTL ago.
 * A missing or corrupt file reads as empty.
 */
export function readCatalogueCache(
  file: string,
  now: number,
  ttlMs = CATALOGUE_TTL_MS,
  failureTtlMs = CATALOGUE_FAILURE_TTL_MS,
): { fresh: string[] | null; stale: string[] | null; fetchedAt?: string; recentFailure?: string } {
  let parsed: CacheFileShape;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8')) as CacheFileShape;
  } catch {
    return { fresh: null, stale: null };
  }
  const models = Array.isArray(parsed?.models) && parsed.models.every((m) => typeof m === 'string') && parsed.models.length > 0
    ? (parsed.models as string[])
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

export type CatalogueFetch = () => Promise<{ models: string[] } | { error: string }>;

export interface CatalogueLoadDeps {
  file: string;
  now: () => number;
  fetch: CatalogueFetch;
  ttlMs?: number;
  failureTtlMs?: number;
  /** Secrets to redact from failure details (default process.env). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Fresh cache, else a live read (cached on success), else the stale cache,
 * else null. A failed live read is recorded so the next command within the
 * failure TTL does not wait for it again. Never throws.
 */
export async function loadCopilotCatalogueWith(deps: CatalogueLoadDeps): Promise<CopilotCatalogueResult> {
  const now = deps.now();
  const cache = readCatalogueCache(deps.file, now, deps.ttlMs, deps.failureTtlMs);
  if (cache.fresh) return { catalogue: new Set(cache.fresh), source: 'cache', detail: `cached in ${deps.file}` };
  const fromStale = (why: string): CopilotCatalogueResult => cache.stale
    ? { catalogue: new Set(cache.stale), source: 'stale-cache', detail: `${why}; using the stale cached catalogue` }
    : { catalogue: null, source: 'none', detail: why };
  if (cache.recentFailure) return fromStale(`the Copilot model catalogue could not be read recently (${cache.recentFailure})`);
  let outcome: { models: string[] } | { error: string };
  try {
    outcome = await deps.fetch();
  } catch (error) {
    outcome = { error: errText(error) };
  }
  if ('models' in outcome && outcome.models.length > 0) {
    try {
      mkdirSync(dirname(deps.file), { recursive: true });
      atomicWriteJsonSync(deps.file, { fetchedAt: new Date(deps.now()).toISOString(), models: outcome.models });
    } catch { /* an unwritable state dir only costs the next command a live read */ }
    return { catalogue: new Set(outcome.models), source: 'live', detail: `listModels() offers ${outcome.models.length} models` };
  }
  const why = redactCatalogueDetail('error' in outcome ? outcome.error : 'listModels() returned no models', deps.env);
  // Another command may have cached a catalogue while this read ran (even one
  // that started earlier than this command): keep and use it.
  const latest = readCatalogueCache(deps.file, deps.now(), deps.ttlMs, deps.failureTtlMs);
  if (latest.fresh) return { catalogue: new Set(latest.fresh), source: 'cache', detail: `cached in ${deps.file}` };
  if (latest.stale && latest.fetchedAt !== cache.fetchedAt) {
    return { catalogue: new Set(latest.stale), source: 'stale-cache', detail: `the Copilot model catalogue could not be read (${why}); using the stale cached catalogue` };
  }
  try {
    mkdirSync(dirname(deps.file), { recursive: true });
    atomicWriteJsonSync(deps.file, {
      ...(cache.stale ? { fetchedAt: cache.fetchedAt, models: cache.stale } : {}),
      failedAt: new Date(now).toISOString(),
      detail: why,
    });
  } catch { /* best effort */ }
  return fromStale(`the Copilot model catalogue could not be read (${why})`);
}

/** Cache-only read (no runtime started) for sync paths such as the npm postinstall. */
export function readCopilotCatalogueCacheOnly(file: string, now: number): CopilotCatalogueResult {
  const cache = readCatalogueCache(file, now);
  if (cache.fresh) return { catalogue: new Set(cache.fresh), source: 'cache', detail: `cached in ${file}` };
  if (cache.stale) return { catalogue: new Set(cache.stale), source: 'stale-cache', detail: `stale cache in ${file}` };
  return { catalogue: null, source: 'none', detail: `no cached Copilot model catalogue in ${file}` };
}

/** What the live read touches; tests replace any of it. */
export interface CatalogueFetchDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  loadSdk: () => Promise<Pick<LoadedSdk, 'module'> | null>;
  resolveBin: () => string | null | undefined;
  userConfigDir: () => string;
  killTree: (pid: number) => void;
  /** Parent of the throwaway job homes (default os.tmpdir()). */
  tmpRoot: string;
}

/** spawnSync with every call capped at NPM_ROOT_TIMEOUT_MS (both call shapes npmRootG uses). */
const cappedSpawnSync = ((command: string, a?: unknown, b?: unknown) => (Array.isArray(a)
  ? spawnSync(command, a as string[], { ...(b as SpawnSyncOptions), timeout: NPM_ROOT_TIMEOUT_MS })
  : spawnSync(command, { ...(a as SpawnSyncOptions), timeout: NPM_ROOT_TIMEOUT_MS }))) as SpawnSyncFn;

function defaultFetchDeps(): CatalogueFetchDeps {
  // The same runtime dependencies as copilot-run/job.ts defaultCopilotRunDeps().
  const env = process.env;
  return {
    env,
    platform: process.platform,
    loadSdk: () => loadCopilotSdk(env, cappedSpawnSync),
    resolveBin: () => resolveCopilotBinary(undefined, env).bin,
    userConfigDir: () => getCopilotConfigDir(),
    killTree: (pid: number) => killProcessTree(pid, spawnSync),
    tmpRoot: tmpdir(),
  };
}

/** stop(), else forceStop(), within `boundMs` together; then the tree kill if the runtime still runs. */
async function stopCatalogueClient(client: SdkClientLike, killTree: (pid: number) => void, boundMs: number): Promise<void> {
  const end = Date.now() + boundMs;
  try { await withTimeout(Promise.resolve().then(() => client.stop()), boundMs, 'client.stop()'); } catch {
    try { await withTimeout(Promise.resolve().then(() => client.forceStop?.()), Math.max(1, end - Date.now()), 'client.forceStop()'); } catch { /* gone */ }
  }
  // Same guard as model-probe.ts: end the runtime this client spawned if it still runs.
  const proc = (client as unknown as { cliProcess?: { exitCode?: number | null; signalCode?: NodeJS.Signals | null } | null }).cliProcess;
  const pid = runtimePid(client);
  if (proc && pid && !hasExited(proc)) {
    try { killTree(pid); } catch { /* gone */ }
  }
}

/** Remove `list-*` job homes older than an hour (left by a killed command). Best effort. */
function sweepStaleJobDirs(jobRoot: string): void {
  try {
    for (const name of readdirSync(jobRoot)) {
      if (!name.startsWith('list-')) continue;
      const dir = join(jobRoot, name);
      try {
        if (Date.now() - statSync(dir).mtimeMs > STALE_JOB_DIR_MS) rmSync(dir, { recursive: true, force: true });
      } catch { /* raced or gone */ }
    }
  } catch { /* no job root yet */ }
}

/**
 * The live read: start the Copilot runtime in a throwaway job home with only
 * the login identity, call listModels(), stop it. No session, no prompt.
 * `cliPath` overrides the resolved copilot binary.
 *
 * The answer (or a timeout error) comes within `deadlineMs` (FETCH_DEADLINE_MS);
 * only a synchronous step already running when it passes can delay it, and the
 * one slow such step, `npm root -g`, is capped at 3 s. Cleanup (stop the
 * runtime, remove the job home) then runs detached, its stop/kill bounded by
 * `cleanupMs`; `onCleanup` receives that promise.
 */
export async function fetchCopilotCatalogue(opts: {
  cliPath?: string;
  deadlineMs?: number;
  cleanupMs?: number;
  deps?: Partial<CatalogueFetchDeps>;
  onCleanup?: (done: Promise<void>) => void;
} = {}): Promise<{ models: string[] } | { error: string }> {
  hardenWindowsExeSearch();
  const deps: CatalogueFetchDeps = { ...defaultFetchDeps(), ...opts.deps };
  const jobRoot = join(deps.tmpRoot, 'omg-model-catalogue');
  sweepStaleJobDirs(jobRoot);
  const jobHome = join(jobRoot, `list-${randomBytes(4).toString('hex')}`);
  const workDir = join(jobHome, 'work');
  let client: SdkClientLike | null = null;
  let cancelled = false;
  const read = async (): Promise<{ models: string[] } | { error: string }> => {
    mkdirSync(workDir, { recursive: true });
    const loaded = await deps.loadSdk().catch(() => null);
    // Past the deadline: cleanup may already have run, so start nothing.
    if (cancelled) return { error: 'cancelled' };
    if (!loaded) return { error: `@github/copilot-sdk is not installed or could not be loaded (${SDK_INSTALL_COMMAND})` };
    const found = opts.cliPath && existsSync(opts.cliPath) ? opts.cliPath : deps.resolveBin();
    const bin = found && deps.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(found) ? resolveShimTarget(found) : found;
    if (!bin) return { error: 'the copilot CLI was not found' };
    const ident = loginIdentity(deps.userConfigDir());
    writeFileSync(join(jobHome, 'config.json'), `${JSON.stringify({ ...ident, trustedFolders: [workDir] }, null, 2)}\n`);
    const env = childEnv(allowlistSessionEnv(buildSessionEnv(deps.env, jobHome, { session: false, hasLogin: ident.loggedInUsers !== undefined }), jobHome));
    mkdirSync(env.XDG_CONFIG_HOME!, { recursive: true });
    mkdirSync(dirname(env.GIT_CONFIG_GLOBAL!), { recursive: true });
    mkdirSync(env.TEMP!, { recursive: true });
    const { CopilotClient, RuntimeConnection } = loaded.module;
    const c: SdkClientLike = new CopilotClient({
      connection: RuntimeConnection.forStdio({ path: bin, args: ['--max-ai-credits', String(RUNTIME_MIN_MAX_CREDITS)], env }),
      baseDirectory: jobHome,
      workingDirectory: workDir,
    });
    client = c;
    await c.start().catch(rethrowSdkStartError);
    return { models: catalogueFromListModels(await c.listModels()) };
  };
  let result: { models: string[] } | { error: string };
  try {
    result = await withTimeout(read(), opts.deadlineMs ?? FETCH_DEADLINE_MS, 'reading the Copilot model catalogue');
  } catch (error) {
    result = { error: errText(error) };
  }
  cancelled = true;
  const started = client as SdkClientLike | null;
  const done = (async () => {
    if (started) await stopCatalogueClient(started, deps.killTree, opts.cleanupMs ?? CLEANUP_BOUND_MS);
    try { rmSync(jobHome, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmdirSync(jobRoot); } catch { /* not empty, or gone */ }
  })();
  opts.onCleanup?.(done);
  return result;
}

export interface CopilotCatalogueSource {
  /** Cached or live catalogue (async commands: `omg setup`, team startup). */
  load: () => Promise<CopilotCatalogueResult>;
  /** Cache only, never starts a runtime (sync paths). */
  readCached: () => CopilotCatalogueResult;
}

const defaultSource: CopilotCatalogueSource = {
  load: () => loadCopilotCatalogueWith({ file: copilotCatalogueCacheFile(), now: Date.now, fetch: () => fetchCopilotCatalogue() }),
  readCached: () => readCopilotCatalogueCacheOnly(copilotCatalogueCacheFile(), Date.now()),
};
let source: CopilotCatalogueSource = defaultSource;
let memo: Promise<CopilotCatalogueResult> | undefined;

/** The catalogue, read at most once per process. */
export function loadCopilotCatalogue(): Promise<CopilotCatalogueResult> {
  memo ??= source.load().catch((error: unknown) => ({ catalogue: null, source: "none" as const, detail: redactCatalogueDetail(errText(error)) }));
  return memo;
}

export function readCachedCopilotCatalogue(): CopilotCatalogueResult {
  try {
    return source.readCached();
  } catch (error) {
    return { catalogue: null, source: 'none', detail: errText(error) };
  }
}

/** Test seam: replace the source (undefined restores the default) and forget the memoized read. */
export function setCopilotCatalogueSource(next: CopilotCatalogueSource | undefined): void {
  source = next ?? defaultSource;
  memo = undefined;
}

let warnedUnreadable = false;

/**
 * The catalogue for team startup. When it cannot be read, says once per
 * process that tier aliases fall back to each tier's first confirmed model.
 */
export async function teamCopilotCatalogue(warn: (line: string) => void = (line) => console.warn(line)): Promise<CopilotCatalogue | null> {
  const result = await loadCopilotCatalogue();
  if (!result.catalogue && !warnedUnreadable) {
    warnedUnreadable = true;
    warn(`[omg] ${result.detail}; Copilot tier aliases use each tier's first confirmed model`);
  }
  return result.catalogue;
}
