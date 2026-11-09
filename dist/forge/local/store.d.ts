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
/**
 * Refuse a path under `anchor` (the checkout or the runtime root, both in
 * the untrusted working tree) when any component below `anchor`, the leaf
 * included, is a symbolic link (or a junction), or a parent is not a
 * directory: a planted link must not redirect a write or a read outside the
 * tree. With `create`, the anchor is made when missing and the parents below
 * it one at a time, each checked again; without it, false when a parent is
 * missing. The leaf may be absent.
 */
export declare function noLinkPath(anchor: string, path: string, create?: boolean, allowLinkedAnchor?: boolean): boolean;
/**
 * Write a file atomically; the parent is created. With `anchor`, no
 * component below it may be a symbolic link (noLinkPath).
 */
export declare function writeAtomic(path: string, content: string, anchor?: string, allowLinkedAnchor?: boolean): void;
/** Append to a file under `anchor` without following a link below it (O_NOFOLLOW on the leaf where the platform has it). */
export declare function appendNoFollow(anchor: string, path: string, text: string, allowLinkedAnchor?: boolean): void;
export declare const LOCK_TIMEOUT_MS = 15000;
/** A lock directory older than this is left over from a crashed writer. */
export declare const LOCK_STALE_MS = 60000;
/** How long a Windows EPERM/EACCES on the lock directory is waited out as a pending delete. */
export declare const PENDING_DELETE_MS = 5000;
/**
 * Remove a stale lock: rename it to a name only this waiter uses, so two
 * waiters never both break one lock (the second rename fails), then check
 * the renamed lock is still stale (a fresh lock taken in between goes back)
 * and remove it.
 */
export declare function breakStaleLock(lock: string, staleMs: number, token: string, seenOwner: string | undefined): void;
/**
 * Run `fn` while holding `<path>.lock` (an exclusive mkdir holding an owner
 * token). Only the owner releases the lock; a lock older than `staleMs` is
 * broken by one waiter.
 */
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
    /** Why a CLOSED PR was closed (`cancelled`: omg factory run cancel), when, and its head then. */
    closedReason?: string;
    closedAt?: string;
    closedHead?: string;
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