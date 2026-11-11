/**
 * Lane tamper check (owner override of design §5, extended to write lanes).
 * The review profile's shell denylist is a denylist: `git $p`,
 * `echo >> .git/config` and friends get past it, and every lane reads
 * untrusted issue or PR content. So the engine snapshots the repository's
 * shared git state before a lane starts and again after it ends, and any
 * difference the lane may not make parks the run (`review-tampered`,
 * `lane-tampered`).
 *
 * Snapshot, all from the COMMON git dir (`git rev-parse --git-common-dir`, the
 * one every worktree shares):
 * - every ref (`git for-each-ref`: loose, packed-refs and refs/stash);
 * - a hash of `config`, `config.worktree` and each `worktrees/<id>/config.worktree`;
 * - a listing hash (names and contents) of `hooks/` and `info/`;
 * - per `worktrees/<id>`: `HEAD`, `gitdir`, `commondir` and its per-worktree
 *   `refs/` (bisect, worktree, rewritten). Lock files, the index and logs are
 *   left out because git itself rewrites them;
 * - per submodule git dir under `modules/` (nested ones too): `config`,
 *   `config.worktree`, `hooks/`, `info/` and its alternates;
 * - `objects/info/alternates` and `objects/info/http-alternates`;
 * - the global git config the engine's own git reads (GIT_CONFIG_GLOBAL, else
 *   `~/.gitconfig` and `$XDG_CONFIG_HOME/git/config`), the user-level ignore
 *   files (`$XDG_CONFIG_HOME/git/ignore`, `core.excludesFile`) and every file an
 *   `include.path` / `includeIf.*.path` in it or in the repository's config
 *   names, followed {@link MAX_INCLUDE_DEPTH} levels deep: a lane's shell can
 *   reach the home directory and plant `credential.helper=!cmd`,
 *   `core.sshCommand`, `url.*.pushInsteadOf` or a `filter.*.clean` there. The
 *   system config needs admin rights to write and is left out;
 * - every `worktrees/<id>` and `modules/` entry must be a real directory
 *   (lstat: a symlink or Windows junction is reported), and an entry that
 *   disappears is reported unless it was already stale (its worktree gone,
 *   the kind `git worktree prune` removes);
 * - the main checkout's HEAD (sha and symbolic ref) and its status, untracked
 *   files included, so a deleted untracked file shows;
 * - the content of a bounded list of ignored main-checkout paths that tools
 *   load or run: top-level `.env*`, `.npmrc`, `.yarnrc`, `.yarnrc.yml` and
 *   `node_modules/.bin`. A full `--ignored` status would walk `node_modules/`
 *   and the lane worktrees under `.omg/` on every check, and it shows only
 *   presence, not content, so the list is hashed instead.
 *
 * Not snapshotted: `logs/` (reflogs). The engine never resolves reflog syntax
 * (`@{n}`), and a lane's own commits append to its branch's reflog, so a
 * reflog change cannot steer an engine command.
 *
 * When the config, `info/` or a submodule's files already differ from the
 * snapshot being compared against, the new snapshot skips `git status`:
 * status may run a clean filter that the changed config names.
 *
 * After a review lane, also: the lane worktree's common dir is the repo's, its
 * HEAD equals the reviewed sha, its `changes` summary is empty, and its status
 * is clean.
 *
 * The only ref allowed to appear is the lane's own branch (at the reviewed
 * sha for a review lane, at the lane's head for a write lane), and the only
 * worktree entry allowed to appear is the lane's own.
 */
import { type Exec } from '../../ship/exec.js';
import type { LaneResult } from './lane.js';
export interface WorktreeEntry {
    /** Hash of HEAD, gitdir, commondir and the per-worktree refs/. */
    meta: string;
    /** Content of `gitdir` (the worktree's `.git` file path). */
    gitdir: string;
    /** Content of `commondir` (`../..` for every `git worktree add`). */
    commondir: string;
    /** The worktree its `gitdir` names is gone (`git worktree prune` may drop the entry). */
    stale?: boolean;
    /** Set when the entry is not a real directory (symlink, junction, file): what it is instead. */
    notDir?: string;
}
export interface RepoSnapshot {
    commonDir: string;
    /** `refname sha` per ref, sorted. */
    refs: Record<string, string>;
    config: string;
    configWorktree: string;
    /** `worktrees/<id>/config.worktree` hash per worktree that has one. */
    worktreeConfigs: Record<string, string>;
    /** Every `worktrees/<id>` entry (copilot_run's `git worktree prune` may drop a stale one). */
    worktreeIds: string[];
    worktrees: Record<string, WorktreeEntry>;
    hooks: string;
    info: string;
    /** Submodule git dir (relative to `modules/`) -> hash of its config, hooks, info and alternates. */
    modules: Record<string, string>;
    alternates: string;
    /**
     * Hash of what steers ancestry answers besides the commits: `shallow`,
     * `objects/info/alternates` and `http-alternates` (objectStoreMetaHash). Absent in a
     * baseline recorded by an older release (the compare then skips it).
     */
    objectMeta?: string;
    /** Hash of the global git config files and every include target (see the module comment). */
    globalConfig: string;
    /** Hash of the bounded list of ignored main-checkout paths (see the module comment). */
    ignored: string;
    mainHead: string;
    mainSymbolic: string;
    /** `git status --porcelain=v1 -z --untracked-files=all` of the main checkout (stableStatus). */
    mainStatus: string;
    /**
     * The bytes of what a tamper is quarantined and restored from
     * (tamper-quarantine.ts, restorableFiles): `config`, `config.worktree`,
     * every file under `hooks/` and `info/` (not info/refs), every
     * `worktrees/<id>/config.worktree` and the submodule git dirs' config,
     * hooks and info, by path relative to the common git dir, as
     * `b64:<bytes>` (`b64x:` when executable), `big:<sha256>` (over
     * RESTORE_FILE_MAX_BYTES, or past RESTORE_TOTAL_MAX_BYTES),
     * `link:<target>` or `unreadable:<code>`. Absent in a snapshot recorded by
     * an older release.
     */
    restore?: Record<string, string>;
}
/** A file the snapshot keeps the bytes of is at most this big; a bigger one is kept as its hash. */
export declare const RESTORE_FILE_MAX_BYTES: number;
/** All the kept bytes of one snapshot together. */
export declare const RESTORE_TOTAL_MAX_BYTES: number;
/**
 * The key of RepoSnapshot.restore that marks a snapshot whose kept bytes also
 * cover `worktrees/<id>/config.worktree` and the submodule git dirs under
 * `modules/` (no real path starts with `#`). A snapshot without it was
 * recorded by an earlier release: the quarantine then leaves those paths
 * alone and names them as still active.
 */
export declare const RESTORE_SCOPE_KEY = "#scope";
export declare const RESTORE_SCOPE = "modules,worktrees";
/**
 * The paths (relative to the common git dir, `/`-separated) the snapshot
 * keeps bytes of, as RepoSnapshot.restore encodes them: `config`,
 * `config.worktree`, `hooks/**`, `info/**` (not info/refs), every
 * `worktrees/<id>/config.worktree`, and per submodule git dir under
 * `modules/` (nested ones too) its `config`, `config.worktree`, `hooks/**`
 * and `info/**`. Never follows a link (lstat). A file or directory that
 * cannot be read is kept as `unreadable:<code>` (a lane can chmod a planted
 * hook to 000; the quarantine then moves it aside without reading it).
 */
export declare function restorableFiles(commonDir: string): Record<string, string>;
export declare class SnapshotError extends Error {
}
/** Top-level ignored files and directories the snapshot hashes by content. */
export declare const SENSITIVE_IGNORED: readonly [".npmrc", ".yarnrc", ".yarnrc.yml", "node_modules/.bin"];
/** Hash of every entry under `dir` (relative name, kind and content), minus the top-level names in `omit`; `absent` when there is none. */
export declare function treeHash(dir: string, omit?: readonly string[]): string;
/**
 * The object store state a forged file could use to change merge-base,
 * rev-list or a three-dot diff without a ref moving (RepoSnapshot.objectMeta):
 * `shallow` and the alternates. Not the commit-graph, commit-graphs/,
 * multi-pack-index or bitmaps: the engine and host git read none of them
 * (core.commitGraph / core.multiPackIndex=false), while the user's own
 * `git gc --auto` and `git maintenance` rewrite them, so hashing them only
 * parked runs. Not the `*.promisor` packs either: they take effect only
 * under the partial clone config, which the config hash covers.
 */
export declare function objectStoreMetaHash(commonDir: string): string;
/** Every submodule git dir under `modules/` (module names may hold slashes; submodules nest); a non-directory entry is kept as such. */
export declare function moduleEntries(commonDir: string): Record<string, string>;
/** git's own include depth limit. */
export declare const MAX_INCLUDE_DEPTH = 10;
/** The global config files git reads: GIT_CONFIG_GLOBAL when set, else `~/.gitconfig` and `$XDG_CONFIG_HOME/git/config`. */
export declare function globalConfigFiles(env?: NodeJS.ProcessEnv): string[];
/**
 * The `path` values of `[include]` and `[includeIf "..."]` sections in a git
 * config text, resolved like git does (`~/` from the home directory, a
 * relative path from the including file's directory). Every includeIf is
 * followed whatever its condition: the snapshot over-approximates.
 */
export declare function includeTargets(text: string, fromFile: string, home: string): string[];
/**
 * Hash of the global config files and of every file an include in them, or
 * in `repoConfigs` (hashed elsewhere themselves), names, up to
 * {@link MAX_INCLUDE_DEPTH} levels.
 */
export declare function globalConfigHash(repoConfigs: readonly string[], env?: NodeJS.ProcessEnv, excludesFile?: string): string;
/**
 * Porcelain `-z` status entries, sorted, minus untracked entries under the
 * engine's own state root (`.omg/`: state, progress, job dirs and lane
 * worktrees are written there while the lane runs; the engine-owned state
 * files there are covered by the engine ledger, ledger.ts). Untracked files
 * under `.omg/skills/` (committable) still count, and so does every tracked
 * change.
 */
export declare function stableStatus(raw: string, stateRootRel: string | null): string;
/**
 * Snapshot the shared git state. With `against`, `git status` is skipped
 * when a file that can configure status (config, info/, a submodule) already
 * differs from it; the comparison then reports that file.
 */
export declare function snapshotRepo(exec: Exec, root: string, stateRootRel?: string | null, against?: RepoSnapshot): RepoSnapshot;
/**
 * Why the shared git dir may not carry a factory run, or null: replace refs
 * (`refs/replace/*`, loose or packed) or an `info/grafts` file. The engine's
 * own git ignores both (GIT_NO_REPLACE_OBJECTS, an empty GIT_GRAFT_FILE), but
 * a replace ref planted before the run would sit in every baseline snapshot,
 * so the compare would never flag it; the repository's other git users still
 * honour them. Refused at the start and at every resume.
 */
export declare function replaceObjectsProblem(exec: Exec, root: string): string | null;
/** Same file system path (realpath when both exist; case-insensitive on Windows). */
export declare function samePath(a: string, b: string): boolean;
export interface CompareAllowance {
    /** Created refs a predicate allows (a lost lane's branch, whose sha the engine never saw). */
    refAllowed?: (name: string, sha: string) => boolean;
    /**
     * Remote-tracking refs created or moved to exactly the sha the remote holds
     * for that branch (a `git fetch` that moved no branch on the remote, by the
     * user or anyone else): the value is what the engine's own fetch would
     * write, so it steers nothing (dogfood F42). Deletions and any other sha
     * still count.
     */
    fetchedRef?: (name: string, sha: string) => boolean;
    /** The lane's own new worktree entry, by its worktree path or by its entry id. */
    newWorktree?: {
        path?: string | null;
        id?: string;
    };
}
/**
 * Differences between two snapshots. `allowedNewRefs` may appear (or stay
 * absent) at exactly the given sha (`*`: any sha).
 */
export declare function compareSnapshots(before: RepoSnapshot, after: RepoSnapshot, allowedNewRefs?: Readonly<Record<string, string>>, allow?: CompareAllowance): string[];
/**
 * The review lane's own worktree after it ended: its git dir is the repo's,
 * it is at the reviewed sha, nothing changed. Run only after the shared-state
 * comparison passed (git here reads that shared config).
 *
 * The lane could write its `.git` file, its admin dir (`commondir`,
 * `config.worktree`) and its attributes, so git here never discovers the git
 * dir: it uses the links copilot_run recorded at the lane's creation
 * (recordWorktreeGitLinks), whose admin dir must be a direct child of the
 * repository's `worktrees/`, and runHostGit pins GIT_DIR, GIT_WORK_TREE and
 * GIT_COMMON_DIR to those paths, hardened, after comparing them (and
 * `config.worktree`) with the disk. No attribute applies there
 * (GIT_ATTR_SOURCE is the empty tree), so no filter, diff driver or git-lfs
 * runs whatever a config level defines, and no submodule is entered; the
 * shared-state comparison before this call and the driver blanking stay as
 * further layers.
 */
export declare function verifyReviewWorktree(result: LaneResult, head: string, commonDir?: string): string[];
//# sourceMappingURL=review-guard.d.ts.map