/**
 * The local forge's engine-owned files (offline forge plan §1.1): the PR
 * store and the check records live under the forge stateDir, which must be
 * outside every untrusted root (a lane must not be able to forge a PR state
 * or a green gate). Writes are atomic (temp file + rename); a store
 * read-modify-write holds a lock directory, so concurrent writers never lose
 * an update or reuse a PR number.
 */
/** `path` is `root` or inside it (both resolved through symlinks where they exist). */
export declare function isUnder(path: string, root: string): boolean;
/**
 * Refuse `dir` when it is not absolute, exists but is not a directory, or is
 * under one of `untrustedRoots`. Nothing is created (a dry run writes
 * nothing); the writers create it on first write. Returns the real path
 * when it exists, else the resolved one.
 */
export declare function engineOwnedDir(dir: string, untrustedRoots: readonly string[]): string;
/** Write a file atomically; the parent is created. */
export declare function writeAtomic(path: string, content: string): void;
export declare const LOCK_TIMEOUT_MS = 15000;
/** A lock directory older than this is left over from a crashed writer. */
export declare const LOCK_STALE_MS = 60000;
/** Run `fn` while holding `<path>.lock` (an exclusive mkdir). */
export declare function withFileLock<T>(path: string, fn: () => T, o?: {
    timeoutMs?: number;
    staleMs?: number;
}): T;
export interface LocalPr {
    number: number;
    /** Branch names (refs/heads/<name> in the mirror). */
    head: string;
    base: string;
    title: string;
    state: 'OPEN' | 'MERGED' | 'CLOSED';
    isDraft: boolean;
    itemId?: number;
    createdAt: string;
    /** The head sha MERGED was detected at. */
    mergedHead?: string;
    mergedAt?: string;
}
export interface LocalPrStore {
    version: 1;
    /** The next PR number; numbers are never reused. */
    next: number;
    prs: LocalPr[];
}
/** The store at `path`; an absent file is an empty store, a malformed one throws. */
export declare function readPrStore(path: string): LocalPrStore;
/** Locked read-modify-write of the store; `fn` mutates the store and returns a result. */
export declare function updatePrStore<T>(path: string, fn: (store: LocalPrStore) => T): T;
//# sourceMappingURL=store.d.ts.map