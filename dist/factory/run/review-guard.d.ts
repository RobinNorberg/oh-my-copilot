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
 *   `~/.gitconfig` and `$XDG_CONFIG_HOME/git/config`) and every file an
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
    /** Hash of the global git config files and every include target (see the module comment). */
    globalConfig: string;
    /** Hash of the bounded list of ignored main-checkout paths (see the module comment). */
    ignored: string;
    mainHead: string;
    mainSymbolic: string;
    /** `git status --porcelain=v1 -z --untracked-files=all` of the main checkout (stableStatus). */
    mainStatus: string;
}
export declare class SnapshotError extends Error {
}
/** Top-level ignored files and directories the snapshot hashes by content. */
export declare const SENSITIVE_IGNORED: readonly [".npmrc", ".yarnrc", ".yarnrc.yml", "node_modules/.bin"];
/** Hash of every entry under `dir` (relative name, kind and content); `absent` when there is none. */
export declare function treeHash(dir: string): string;
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
export declare function globalConfigHash(repoConfigs: readonly string[], env?: NodeJS.ProcessEnv): string;
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
/** Same file system path (realpath when both exist; case-insensitive on Windows). */
export declare function samePath(a: string, b: string): boolean;
export interface CompareAllowance {
    /** Created refs a predicate allows (a lost lane's branch, whose sha the engine never saw). */
    refAllowed?: (name: string, sha: string) => boolean;
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
 */
export declare function verifyReviewWorktree(exec: Exec, result: LaneResult, head: string, commonDir?: string): string[];
//# sourceMappingURL=review-guard.d.ts.map