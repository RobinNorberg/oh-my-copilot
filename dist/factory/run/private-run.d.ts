/**
 * The engine side of the private layout (item 2 B1b; design i23 4/8-7/8):
 * `factory.run.layout: "private"` runs a run's lanes, prepare checkout and
 * gates in an engine-owned private repository outside the user's checkout
 * (private-store.ts), and its commits reach the user's repository only
 * through importFromPrivate followed by the engine's existing hardened push.
 *
 * The engine (engine.ts) keeps its call sites thin and asks this module:
 * - at run start (the implement step that seals the base): the layout
 *   (trusted layers only), then PrivateRun.create: git >= 2.44, the user's
 *   common git dir resolved once, leftover `.trash-*` swept, stale
 *   refs/omg-import/<slug>/* deleted, the user repository guard baseline,
 *   ensureSeed + createPrivateRepo at the sealed base under the import lock;
 * - per lane: a detached worktree `<run>/w/<n>` made with the store's pinned
 *   git (never the unhardened `git worktree add` of the shared layout), its
 *   links recorded, and the paths its sandbox denies (the seed, the other
 *   runs and lanes);
 * - per engine git command in the private repository: privateGit /
 *   privateExec, which run privateRepoProblem first and name the git dir and
 *   work tree explicitly;
 * - per publish: publishImports, under the import lock: the guard compared
 *   with its baseline, each engine commit imported (exactly one new commit
 *   per import, parents and start from the engine's own record), the caller's
 *   checks and hardened push, the import refs dropped, the guard compared
 *   again with the PRE-import baseline, and only then a new baseline.
 *
 * Several private-layout engines may run in one checkout (lane B2:
 * factory.run.maxConcurrent, slots in state.ts); their transports into and
 * out of the user repository are serialised by withImportLock.
 */
import { type Exec, type ExecResult } from '../../ship/exec.js';
import type { GitViewSource } from './git-view.js';
import { type ImportRefusalCode, type PrivateRepo, type PrivateRunLayout, type PrivateStoreContext, type UserGuardDetail, type UserRepoGuard } from './private-store.js';
import { type FactoryRunState, type HeldOwner } from './state.js';
export type RunLayoutChoice = 'shared' | 'private';
export type GateInstallChoice = 'park' | 'sandboxed';
/** The park when the private layout cannot run this part yet (an actionable command to continue is in the reason). */
export declare const LAYOUT_UNSUPPORTED_GATE = "layout-unsupported";
/** The park when the private store could not be set up at run start (git too old, a partial clone, the work root, the seed). */
export declare const PRIVATE_STORE_GATE = "private-store";
/** The park when the user repository guard changed between imports. */
export declare const REPO_GUARD_GATE = "repo-guard-changed";
/** The park when importFromPrivate refused an engine commit (protected paths park at protected-paths instead). */
export declare const IMPORT_REFUSED_GATE = "import-refused";
/** The park when the PR head changes a lockfile and factory.run.gateInstall is "park". */
export declare const GATE_INSTALL_GATE = "gate-install-needed";
/**
 * factory.run.layout from the trusted layers only: the user config, then the
 * `.copilot/omg.jsonc` committed at the sealed base (never the working tree
 * or the PR head). Default "shared". Throws on any other value.
 */
export declare function resolveRunLayout(user: unknown, base: unknown): {
    layout: RunLayoutChoice;
    source: string;
};
/**
 * Whether the user config opts into parallel runs (review-487 L-1): it sets
 * factory.run.maxConcurrent or maxInFlightCredits, or layout "private".
 * Without that opt-in the base layer's maxConcurrent and maxInFlightCredits
 * count for nothing (the CLI and the poller's auto-start alike). Throws on
 * an invalid user layout, as resolveRunLayout does.
 */
export declare function userParallelOptIn(user: unknown): boolean;
/** factory.run.gateInstall from the same trusted layers: "park" (default) or "sandboxed". */
export declare function resolveGateInstall(user: unknown, base: unknown): {
    mode: GateInstallChoice;
    source: string;
};
export interface PrivateRunInput {
    /** The user's checkout. */
    root: string;
    /** Its OMC state root (getOmcRoot(root)). */
    omcRoot: string;
    /** runSlug(key): `issue-7`, `heal-0a1b2c3d`; also the import ref label. */
    slug: string;
    /** The run's repository url (claimRepoKey names the store's repository dir). */
    repoUrl: string;
    /** The trusted user config (factory.run.workDir). */
    userConfig: unknown;
    /** The engine ledger dir: its empty hooks dir and empty global config are the store's tools. */
    ledgerDir: string;
    /** The unguarded command runner (the factory guard has no shapes for the store's commands). */
    exec?: Exec;
    platform?: NodeJS.Platform;
    warn?: (message: string) => void;
}
/** The sealed state's record of the private store (FactoryRunState.privateStore). */
export type PrivateStoreRecord = NonNullable<FactoryRunState['privateStore']>;
/** One engine commit to import: its parents and the diff start, both from the engine's own record. */
export interface ImportStep {
    sha: string;
    parents: readonly string[];
    start: string;
}
export type Park = {
    name: string;
    reason: string;
    detail?: string;
};
/** What publishImports returns: the body's value, or the park (nothing more was pushed once it parked before the body). */
export type ImportOutcome<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    park: Park;
    pushed: boolean;
};
/**
 * The park message for a changed user repository guard (review-481b k):
 * kind, path and key name of each changed entry, never a value or a
 * fingerprint, and that the user's own change trips it too.
 */
export declare function guardChangedReason(details: readonly UserGuardDetail[], resume: string, cancel: string, stuck?: readonly UserGuardDetail[]): string;
/**
 * The entries of `guard` that compareUserRepoGuard always reports as changed
 * (an unreadable config, include or git state; a hooks dir too large to
 * compare; core.hooksPath at the work tree root or the git dir): with one of
 * them a private run would park at every import (review-483 HIGH-1). Empty
 * when the guard compares cleanly.
 */
export declare function stuckGuardEntries(guard: UserRepoGuard): UserGuardDetail[];
/** The park for an import refusal: the module's fixed reason, and the command that continues or cancels. */
export declare function importRefusalPark(code: ImportRefusalCode, reason: string, what: string, ref: string, resume: string, cancel: string, privateDir: string): Park;
export declare class PrivateRun {
    readonly layout: PrivateRunLayout;
    repo: PrivateRepo;
    readonly ctx: PrivateStoreContext;
    readonly userGitDir: string;
    private readonly root;
    private readonly warn;
    constructor(layout: PrivateRunLayout, repo: PrivateRepo, ctx: PrivateStoreContext, userGitDir: string, root: string, warn?: (m: string) => void);
    /** The context of every store command: the ledger dir's tools, the unguarded exec. */
    static context(input: Pick<PrivateRunInput, 'ledgerDir' | 'exec' | 'platform'>): PrivateStoreContext;
    /** The layout of the run (work root from the trusted user config, repository dir from the claim key). */
    static runLayout(input: Pick<PrivateRunInput, 'root' | 'omcRoot' | 'slug' | 'repoUrl' | 'userConfig' | 'platform'>): PrivateRunLayout;
    /**
     * Run start (B1b scope 1): every check before the store is touched, then
     * the seed and the private clone at the sealed base under the import lock.
     * A run dir left by a failed earlier start of this run (the state records
     * no private store yet) is removed first. Throws PrivateStoreError.
     */
    static create(input: PrivateRunInput, baseSha: string): {
        run: PrivateRun;
        record: PrivateStoreRecord;
        guard: UserRepoGuard;
    };
    /**
     * The run of a private-layout state (resume). The recorded dir must be
     * exactly where the trusted user config's work root and the run's
     * repository and slug put it (review-483 M5: a wrong or tampered privateDir
     * never names a dir to resume in or remove), and git must still be 2.44 or
     * later (review-483 L4). Throws PrivateStoreError.
     */
    static fromState(s: FactoryRunState, input: Pick<PrivateRunInput, 'root' | 'omcRoot' | 'slug' | 'userConfig' | 'ledgerDir' | 'exec' | 'platform' | 'warn'>): PrivateRun;
    /** At every resume (B1b scope 1/5): leftover `.trash-*` and this run's stale import refs (a crash after an import). */
    resumeSweep(slug: string): void;
    problem(): string | null;
    /** privateRepoProblem, thrown (PrivateRepoTampered). */
    assert(): void;
    /** An engine git command in the private repository (privateRepoProblem first; explicit git dir and work tree). */
    gitOk(args: readonly string[], what: string, workTree?: string): string;
    /** gitOk without the exit check (the caller reads the status). */
    git(args: readonly string[], workTree?: string): ExecResult;
    /**
     * git-view.ts's source in the private repository (a gate container's view
     * of a commit made here): privateRepoProblem before every command, the
     * store's pins and env, the private git dir named, stdout as bytes.
     */
    viewSource(): GitViewSource;
    private gitOptions;
    /** The admin dir recorded for `workTree` at its creation (recordWorktreeGitLinks), or null. */
    recordedGitDir(workTree: string): string | null;
    /** The Exec for snapshotRepo and ship's runPrepare: the clone dir and the recorded worktrees only; the engine's commit identity. */
    exec(): Exec;
    /** `sha` is in the private repository: else fetched by sha from the user repository (seed first), kept by an engine ref. */
    ensureCommit(sha: string): void;
    /** `<run>/w/<n>` or `<run>/w/prep`. */
    worktreePath(n: number | 'prep'): string;
    /**
     * A new worktree at `sha` (detached, or on `branch`, which `-B` resets),
     * made with the store's pins (no hook, no filter, no global config), its
     * links recorded before anything else runs in it; the config hash is
     * re-recorded after (the allowlist still applies), so the caller seals
     * `repo.configHash` again.
     */
    addWorktree(path: string, sha: string, branch?: string): void;
    /**
     * Remove a private worktree: its node_modules link first, then removeRunDir
     * (links unlinked, never followed), then its own admin entry under the
     * private git dir's worktrees/ (the one whose gitdir file names
     * `<path>/.git`), by path; never `git worktree prune`. Only after its
     * process tree is gone (the caller's lane end or gate end).
     */
    removeWorktree(path: string): void;
    /**
     * The paths a lane in `own` is denied (where the host can deny paths): the
     * seed, the other run dirs and trash under the repository dir, and the
     * other worktrees of this run. Its own worktree and the private git dir
     * (read-only) stay readable.
     */
    deniedFor(own: string): string[];
    /**
     * Publish (B1b scope 5) under the import lock: the guard against its
     * baseline (a change parks before anything is imported), each step
     * imported in order, `body` (the caller's checks and hardened push; it may
     * return a park of its own), the import refs dropped, the guard compared
     * AGAIN with the pre-import baseline (a change parks: whatever the body
     * pushed is out, nothing more is), and only then the new baseline.
     * `nextImport` reserves and seals an import number; `baseline`/`setBaseline`
     * are the ledger's.
     */
    publishImports<T>(o: {
        steps: readonly ImportStep[];
        slug: string;
        nextImport: () => number;
        baseline: UserRepoGuard | undefined;
        setBaseline: (g: UserRepoGuard) => void;
        extraProtected: readonly string[];
        what: string;
        resume: string;
        cancel: string;
        body: () => T;
        pushed: (value: T) => boolean;
    }): ImportOutcome<T>;
}
/**
 * The layout of a private-layout state, recomputed from the trusted user
 * config's work root (privateWorkRoot), the run's repository (claimRepoKey)
 * and its slug, and required to equal the recorded privateDir before
 * anything resumes in it or removes it (review-483 M5). Throws
 * PrivateStoreError naming both dirs; nothing is touched.
 */
export declare function expectedPrivateLayout(s: Pick<FactoryRunState, 'privateDir' | 'repoUrl'>, input: Pick<PrivateRunInput, 'root' | 'omcRoot' | 'slug' | 'userConfig' | 'platform'>): PrivateRunLayout;
/**
 * The lock around the store's transports into and out of the user
 * repository (seed fetch, clone, imports, push), lane B2: first the
 * checkout's repository import lock (state.ts withRepoImportLock: an owner
 * record, a dead holder taken over by process identity, a live one never;
 * shared with the parallel engines' base fetches and the scan holders), then
 * the per-repository seed lock under the work root, which every checkout of
 * the repository shares (its seed). Lock order: import.lock, then the seed lock.
 */
export declare function withImportLock<T>(root: string, layout: PrivateRunLayout, label: string, fn: () => T, held?: HeldOwner): T;
/**
 * The per-repository seed lock (`<work>/<repo8>/import.lock`, a plain file
 * lock): a holder whose pid is alive is never reaped, however old the lock
 * (file-lock's rule: stale only when old AND its pid is dead), so a first
 * seed fetch of a big repository is not stolen (review-483 L9).
 */
export declare const SEED_LOCK_STALE_MS = 60000;
export declare function withSeedLock<T>(layout: PrivateRunLayout, fn: () => T, waitMs?: number): T;
//# sourceMappingURL=private-run.d.ts.map