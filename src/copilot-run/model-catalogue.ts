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
import { loadCopilotSdk, resolveShimTarget, runtimePid, type SdkClientLike } from '../smoke/copilot-sdk-driver.js';
import { RUNTIME_MIN_MAX_CREDITS, SDK_INSTALL_COMMAND } from '../smoke/copilot-sdk-scenarios.js';
import { buildSessionEnv, loginIdentity } from '../smoke/copilot-session-env.js';
import { hasExited, killProcessTree } from '../smoke/process-utils.js';
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
const START_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 5_000;

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
      atomicWriteJsonSync(deps.file, { fetchedAt: new Date(now).toISOString(), models: outcome.models });
    } catch { /* an unwritable state dir only costs the next command a live read */ }
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

/**
 * The live read: start the Copilot runtime in a throwaway job home with only
 * the login identity, call listModels(), stop it. No session, no prompt.
 * `cliPath` overrides the resolved copilot binary.
 */
export async function fetchCopilotCatalogue(opts: { cliPath?: string; startTimeoutMs?: number; listTimeoutMs?: number } = {}): Promise<{ models: string[] } | { error: string }> {
  // The same runtime dependencies as copilot-run/job.ts defaultCopilotRunDeps().
  hardenWindowsExeSearch();
  const hostEnv = process.env;
  const deps = {
    env: hostEnv,
    platform: process.platform,
    loadSdk: () => loadCopilotSdk(hostEnv, spawnSync),
    resolveBin: () => resolveCopilotBinary(undefined, hostEnv).bin,
    userConfigDir: () => getCopilotConfigDir(),
    killTree: (pid: number) => killProcessTree(pid, spawnSync),
  };
  const jobRoot = join(tmpdir(), 'omg-model-catalogue');
  const jobHome = join(jobRoot, `list-${randomBytes(4).toString('hex')}`);
  const workDir = join(jobHome, 'work');
  let client: SdkClientLike | null = null;
  try {
    mkdirSync(workDir, { recursive: true });
    const loaded = await deps.loadSdk().catch(() => null);
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
    await withTimeout(c.start(), opts.startTimeoutMs ?? START_TIMEOUT_MS, 'client.start()');
    const models = await withTimeout(c.listModels(), opts.listTimeoutMs ?? LIST_TIMEOUT_MS, 'listModels()');
    return { models: catalogueFromListModels(models) };
  } catch (error) {
    return { error: errText(error) };
  } finally {
    if (client) {
      try { await withTimeout(client.stop(), STOP_TIMEOUT_MS, 'client.stop()'); } catch {
        try { await withTimeout(client.forceStop?.() ?? Promise.resolve(), STOP_TIMEOUT_MS, 'client.forceStop()'); } catch { /* gone */ }
      }
      // Same guard as model-probe.ts: end the runtime this client spawned if it still runs.
      const proc = (client as unknown as { cliProcess?: { exitCode?: number | null; signalCode?: NodeJS.Signals | null } | null }).cliProcess;
      const pid = runtimePid(client);
      if (proc && pid && !hasExited(proc)) {
        try { deps.killTree(pid); } catch { /* gone */ }
      }
    }
    try { rmSync(jobHome, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmdirSync(jobRoot); } catch { /* not empty, or gone */ }
  }
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
  memo ??= source.load().catch((error: unknown) => ({ catalogue: null, source: 'none' as const, detail: errText(error) }));
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
 * process that tier aliases fall back to each tier's first model.
 */
export async function teamCopilotCatalogue(warn: (line: string) => void = (line) => console.warn(line)): Promise<CopilotCatalogue | null> {
  const result = await loadCopilotCatalogue();
  if (!result.catalogue && !warnedUnreadable) {
    warnedUnreadable = true;
    warn(`[omg] ${result.detail}; Copilot tier aliases use each tier's first model`);
  }
  return result.catalogue;
}
