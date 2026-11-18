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
/** Model ids the plan offers. */
export type CopilotCatalogue = ReadonlySet<string>;
export interface CopilotCatalogueResult {
    /** null when the catalogue could not be read: tier aliases then use each tier's first id. */
    catalogue: CopilotCatalogue | null;
    source: 'cache' | 'live' | 'stale-cache' | 'none';
    /** What was read, or why not. */
    detail: string;
}
export declare const CATALOGUE_TTL_MS: number;
export declare const CATALOGUE_FAILURE_TTL_MS: number;
/** `<omg state root>/copilot-models-cache.json` (~/.omg/state on Windows and macOS). */
export declare function copilotCatalogueCacheFile(): string;
/** Ids from a listModels() answer; a model whose policy is `disabled` is not offered. */
export declare function catalogueFromListModels(entries: unknown): string[];
/**
 * The cache as of `now`: `fresh` within the TTL, `stale` past it, and
 * `recentFailure` when the last live read failed less than the failure TTL ago.
 * A missing or corrupt file reads as empty.
 */
export declare function readCatalogueCache(file: string, now: number, ttlMs?: number, failureTtlMs?: number): {
    fresh: string[] | null;
    stale: string[] | null;
    fetchedAt?: string;
    recentFailure?: string;
};
export type CatalogueFetch = () => Promise<{
    models: string[];
} | {
    error: string;
}>;
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
export declare function loadCopilotCatalogueWith(deps: CatalogueLoadDeps): Promise<CopilotCatalogueResult>;
/** Cache-only read (no runtime started) for sync paths such as the npm postinstall. */
export declare function readCopilotCatalogueCacheOnly(file: string, now: number): CopilotCatalogueResult;
/**
 * The live read: start the Copilot runtime in a throwaway job home with only
 * the login identity, call listModels(), stop it. No session, no prompt.
 * `cliPath` overrides the resolved copilot binary.
 */
export declare function fetchCopilotCatalogue(opts?: {
    cliPath?: string;
    startTimeoutMs?: number;
    listTimeoutMs?: number;
}): Promise<{
    models: string[];
} | {
    error: string;
}>;
export interface CopilotCatalogueSource {
    /** Cached or live catalogue (async commands: `omg setup`, team startup). */
    load: () => Promise<CopilotCatalogueResult>;
    /** Cache only, never starts a runtime (sync paths). */
    readCached: () => CopilotCatalogueResult;
}
/** The catalogue, read at most once per process. */
export declare function loadCopilotCatalogue(): Promise<CopilotCatalogueResult>;
export declare function readCachedCopilotCatalogue(): CopilotCatalogueResult;
/** Test seam: replace the source (undefined restores the default) and forget the memoized read. */
export declare function setCopilotCatalogueSource(next: CopilotCatalogueSource | undefined): void;
/**
 * The catalogue for team startup. When it cannot be read, says once per
 * process that tier aliases fall back to each tier's first model.
 */
export declare function teamCopilotCatalogue(warn?: (line: string) => void): Promise<CopilotCatalogue | null>;
//# sourceMappingURL=model-catalogue.d.ts.map