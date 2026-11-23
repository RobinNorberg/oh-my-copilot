/**
 * The repositories this host's engine ledger knows (`omg factory attention
 * --all-repos`, `omg factory dashboard --serve --all-repos`). READ-ONLY: it
 * lists and reads files under the ledger dir and stats each root; it never
 * creates, locks or writes anything, and runs no subprocess.
 *
 * Trust: the ledger (defaultLedgerDir: `$OMC_STATE_DIR/factory-ledger` or
 * `~/.omg/factory-ledger`) lives outside every repository, so a root is only
 * ever taken from it: the `root` of a repository dir's `run-<key>.json`
 * records, and the `root` of claim owner records (`claims/<16 hex>/run-<key>.owner`)
 * for repositories whose ledger dir is gone. Never from a file inside a
 * repository.
 *
 * A root is listed only when:
 * - it is a plain local absolute, normalised path (claimRoot: no control or
 *   format character, no UNC / device path);
 * - a ledger dir's name is the id the engine derives from it (ledgerRepoId):
 *   a record copied or forged into another repository's dir is refused;
 * - it exists, is a directory, is not reached through a link (its real path
 *   is itself, compared case-insensitively on win32/darwin), and holds `.git`
 *   (a directory, or a `gitdir:` file of a linked worktree or submodule): a
 *   subdirectory of a repository or a plain folder is refused;
 * - no other listed root has the same real path.
 * Each filesystem probe of a root runs async with a timeout (ROOT_PROBE_MS),
 * so a slow or unreachable drive is skipped (`timeout`) rather than stalling
 * the rest. A refused root is counted in `skipped` with its ledger id and a
 * reason; its path (sanitised) is for --verbose / --json only.
 *
 * Bounds: at most MAX_REPOS repository dirs and MAX_CLAIM_DIRS claim dirs are
 * looked at, at most RECORDS_PER_DIR records read per dir, each record
 * through readRegularFile (no link, no FIFO, size-capped). A malformed or
 * unreadable record is skipped with a warning, never fatal.
 */
export declare const MAX_REPOS = 200;
export declare const MAX_CLAIM_DIRS = 200;
export declare const RECORDS_PER_DIR = 4;
/** A ledger record or claim larger than this is not read for its root. */
export declare const RECORD_MAX_BYTES: number;
export declare const ROOT_PROBE_MS = 3000;
export type SkipReason = 'invalid-root' | 'id-mismatch' | 'missing' | 'not-a-directory' | 'not-a-repository' | 'link' | 'duplicate' | 'timeout' | 'unreadable' | 'no-root';
export interface LedgerRoot {
    /** The ledger id (ledgerRepoId of the root): the opaque handle the dashboard uses. */
    id: string;
    root: string;
    /** Where the root came from: a ledger dir's records, a claim, or --repo. */
    source: 'ledger' | 'claim' | 'pinned';
    /** The ledger holds a dir for this root (runs the engine recorded on this host). */
    recorded: boolean;
}
export interface SkippedRoot {
    id: string;
    reason: SkipReason;
    /** The recorded root, sanitised and cut: --verbose / --json only, never a command. */
    root?: string;
}
export interface LedgerRoots {
    roots: LedgerRoot[];
    skipped: SkippedRoot[];
    warnings: string[];
}
export interface DiscoverOptions {
    ledgerDir: string;
    /** --repo: only these roots (each already checked by checkPinnedRoot). */
    pinned?: readonly string[];
    platform?: NodeJS.Platform;
    maxRepos?: number;
    probeMs?: number;
}
/**
 * Whether `root` is a repository top level here: a directory, not reached
 * through a link, holding `.git` (a dir, or a `gitdir:` file). Returns its
 * canonical real path (the dedupe key) or why not.
 */
export declare function probeRoot(root: string, platform?: NodeJS.Platform, ms?: number): Promise<{
    real: string;
} | {
    reason: SkipReason;
}>;
/** --repo <path>: resolved against the cwd; it must be a repository top level (null) or the reason it is not. */
export declare function checkPinnedRoot(path: string, platform?: NodeJS.Platform, ms?: number): Promise<{
    root: string;
} | {
    error: string;
}>;
/** Every repository the engine ledger of this host records (or the pinned ones), validated; read-only. */
export declare function discoverLedgerRoots(o: DiscoverOptions): Promise<LedgerRoots>;
//# sourceMappingURL=ledger-roots.d.ts.map