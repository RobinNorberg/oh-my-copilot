/**
 * The repositories this host's engine ledger knows (`omg factory attention
 * --all-repos`, `omg factory dashboard --serve --all-repos`). READ-ONLY: it
 * lists and reads files under the ledger dir and stats each root; it never
 * creates, locks or writes anything, and runs no subprocess. Collecting a
 * listed root's state afterwards does not run git either when the root has a
 * `stateRoot` (withKnownOmcRoots); with OMC_STATE_DIR set, or for a --repo
 * root, the state dir is resolved the usual way (one git probe per collection).
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
 * - a ledger dir's name is the id the engine derives from it (ledgerRepoId),
 *   and every readable record of the dir (up to RECORDS_PER_DIR) agrees: a
 *   record copied or forged into another repository's dir is refused;
 * - it exists, is a directory, is not reached through a link (its real path
 *   is itself, compared case-insensitively on win32/darwin), and holds `.git`
 *   (a directory with HEAD, or a `gitdir:` file whose target holds HEAD): a
 *   subdirectory of a repository, a plain folder or an empty `.git` is
 *   refused (`not-a-repository`);
 * - the state the collector reads for it is its own (`<root>/.omg`, or
 *   `$OMC_STATE_DIR/<its id>`): a submodule (state at the superproject) or a
 *   root under a workspace marker (a shared `.omg`) is refused
 *   (`state-elsewhere`);
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
export type SkipReason = 'invalid-root' | 'id-mismatch' | 'conflict' | 'missing' | 'not-a-directory' | 'not-a-repository' | 'state-elsewhere' | 'link' | 'duplicate' | 'timeout' | 'unreadable' | 'no-root';
export interface LedgerRoot {
    /** The ledger id (ledgerRepoId of the root): the opaque handle the dashboard uses. */
    id: string;
    root: string;
    /** Where the root came from: a ledger dir's records, a claim, or --repo. */
    source: 'ledger' | 'claim' | 'pinned';
    /** The ledger holds a dir for this root (runs the engine recorded on this host). */
    recorded: boolean;
    /**
     * The root's own state dir (`<root>/.omg`), validated by probeRoot without git: collection resolves it
     * from here (withKnownOmcRoots) instead of spawning git in the repository. Absent with OMC_STATE_DIR
     * (the centralized id needs git) and for a pinned root: resolved the usual way then.
     */
    stateRoot?: string;
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
type Probed = {
    real: string;
    stateRoot?: string;
};
/**
 * Whether `root` is a repository top level here whose factory state is its
 * own: a directory, not reached through a link, holding `.git` (a dir with
 * `HEAD`, or a `gitdir:` file whose target holds `HEAD`: a linked worktree
 * or a `--separate-git-dir` repository), not a submodule (its state anchors
 * at the superproject) and not under a workspace marker (a shared `.omg`):
 * `state-elsewhere`. Returns its canonical real path (the dedupe key) and,
 * without OMC_STATE_DIR, its state root (`<root>/.omg`), or why not.
 *
 * A linked worktree is a valid root: its state is its own `.omg` (getOmcRoot
 * does not climb from a worktree), though the engine's ledger records the
 * main checkout, so it is listed only when a record or --repo names it.
 */
export declare function probeRoot(root: string, platform?: NodeJS.Platform, ms?: number): Promise<Probed | {
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
export {};
//# sourceMappingURL=ledger-roots.d.ts.map