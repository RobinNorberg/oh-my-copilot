/**
 * The factory engine's private git store (item 2: a private repository per
 * run; design i23 4/8 and 6/8, audit-gitstore 6/6). This module only builds
 * and checks the store; the engine wiring (lane cwd, prepare checkout,
 * import before push, clean) is a separate change.
 *
 * Layout under the work root (privateWorkRoot), never under the repository
 * or the OMC state root:
 *
 *   <work>/<repo8>/seed.git          engine-only object seed (bare)
 *   <work>/<repo8>/<slug>/repo       private clone (git dir repo/.git, nothing checked out)
 *   <work>/<repo8>/<slug>/w/<n>      lane worktrees and `prep`
 *   <work>/<repo8>/<slug>/jobs       copilot_run job dirs
 *   <work>/<repo8>/<slug>/run.lock
 *
 * The private repository is a full copy of the seed (no alternates), and
 * the seed, like `<work>/<repo8>` as a whole, must stay read-only to lanes.
 * Objects travel only by sealed sha: user repository -> seed -> private on
 * the way in (ensureSeed, fetchIntoPrivate), private -> user repository on
 * the way out (importFromPrivate, the audit 6/6 import minus the push).
 *
 * Every git command here runs with privateGitPins on its own command line,
 * an engine-owned empty global config, no system config, replace objects and
 * grafts off (privateGitEnv), and, on a transport, the stock upload-pack with
 * its own pins (uploadPackCommand): git drops `-c` and GIT_NO_REPLACE_OBJECTS
 * for the process it spawns on the other side of a local transport, so only
 * the upload-pack command line can pin that side. Before a transport each
 * repository is checked for a redirect (a `.git`, `commondir`, `gitdir` or
 * `config.worktree` entry, or a link: review-476 HIGH-1 / 476b B2), replace
 * refs, grafts, shallow and unexpected alternates; the engine-made
 * repositories also for a config the engine did not write.
 *
 * Errors: setup functions throw PrivateStoreError with fixed text plus
 * engine-derived paths and shas only (git's stderr goes in `detail`, never in
 * the message). importFromPrivate returns a typed result whose reasons are
 * fixed text: nothing a lane wrote (paths, ref names, git output) is in them.
 */
import { type Exec, type ExecResult } from '../../ship/exec.js';
export declare class PrivateStoreError extends Error {
    /** git's stderr or other tool output: diagnostics only, never part of `message`. */
    readonly detail: string;
    constructor(message: string, detail?: string);
}
export interface WorkRootInput {
    /** The trusted user config (userConfigLayers().trustedUser): factory.run.workDir is read from it only, never from a repository. */
    userConfig: unknown;
    /** The user's checkout. */
    root: string;
    /** The OMC state root of that checkout (getOmcRoot(root)). */
    omcRoot: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    home?: string;
}
/**
 * The private store's work root: factory.run.workDir from the trusted user
 * config, else %LOCALAPPDATA%\omg\fw on Windows and $XDG_CACHE_HOME/omg/fw
 * (fallback ~/.cache/omg/fw) elsewhere. Throws when it is not absolute, or
 * when it and the repository or the OMC state root contain one another
 * (links resolved): the sandbox un-denies the whole state root once a grant
 * sits inside it (sandbox.ts), and a lane worktree inside the checkout would
 * be the shared-git-dir layout again.
 */
export declare function privateWorkRoot(input: WorkRootInput): string;
export interface PrivateRunLayout {
    work: string;
    repo8: string;
    /** <work>/<repo8> */
    repoDir: string;
    /** <work>/<repo8>/seed.git */
    seed: string;
    /** <work>/<repo8>/<slug> */
    runDir: string;
    /** <work>/<repo8>/<slug>/repo (nothing checked out) */
    repo: string;
    /** <work>/<repo8>/<slug>/repo/.git */
    gitDir: string;
    /** <work>/<repo8>/<slug>/w */
    worktrees: string;
    /** <work>/<repo8>/<slug>/jobs */
    jobs: string;
    /** <work>/<repo8>/<slug>/run.lock */
    lock: string;
}
/** The layout of one run; `repoKey` is claimRepoKey (its first 8 hex name the repository dir), `slug` e.g. `issue-12` or `heal-0a1b2c3d`. */
export declare function privateRunLayout(work: string, repoKey: string, slug: string): PrivateRunLayout;
/** A lane worktree (`n`) or the prepare/gate checkout (`prep`) of the run. */
export declare function privateWorktreePath(layout: PrivateRunLayout, n: number | 'prep'): string;
/**
 * Git for Windows handles long paths with core.longpaths=true (set on every
 * command here and in the private config), but its MSYS tools (sh, the
 * `true` of core.alternateRefsCommand) stop at PATH_MAX.
 */
export declare const WINDOWS_GIT_PATH_MAX = 4095;
/** Null, or why `dir` + `/` + a repository path of `longest` characters is too long for git on Windows. */
export declare function longPathProblem(dir: string, longest: number, platform?: NodeJS.Platform): string | null;
/** The engine-owned empty hooks dir and empty global config every command here runs with. */
export interface PrivateGitTools {
    hooksDir: string;
    globalConfig: string;
}
/** Make (or reuse) the tools under `dir` (the engine's ledger dir: its `empty-hooks` is the engine's own, emptyHooksDir). */
export declare function privateGitTools(dir: string): PrivateGitTools;
export interface PrivateStoreContext {
    tools: PrivateGitTools;
    /** Default defaultExec (scrubShipEnv environment). Not the engine's guarded exec: these shapes are not on its allowlist. */
    exec?: Exec;
    platform?: NodeJS.Platform;
    /** Kill any git command here after this many milliseconds (default PRIVATE_GIT_TIMEOUT_MS); a timeout is a refusal (PrivateGitTimeout). */
    timeoutMs?: number;
}
/** Ten minutes: a first seed fetch or clone of a large repository fits; a hung pack or a FIFO include does not hang the engine (review-481 L7). */
export declare const PRIVATE_GIT_TIMEOUT_MS = 600000;
/** resolveUserGitDir's budget (review-481c N5): a plain rev-parse, which a FIFO include holds no longer than this. */
export declare const RESOLVE_TIMEOUT_MS = 30000;
/** A git command here ran out of time and was killed; fixed text. */
export declare class PrivateGitTimeout extends PrivateStoreError {
    constructor(ms: number);
}
/**
 * `-c` pairs on every command here (the git process itself). Hooks,
 * fsmonitor, pager, external diff, alternate-ref commands off; commit-graph
 * and multi-pack-index not read or written (a forged one could answer
 * ancestry: audit M2), no auto gc or maintenance; fsck on every object
 * received; only the file protocol (a rewrite to ext:: or a remote helper
 * cannot run); no bundle URI, no submodule recursion, no credential helper;
 * long paths on.
 */
export declare function privateGitPins(tools: PrivateGitTools): string[];
/**
 * The `--upload-pack` of every transport here. Git runs it through the
 * shell in the repository on the other side, without our `-c` (local
 * transport drops GIT_CONFIG_PARAMETERS), so its pins are on its own command
 * line, where they beat that repository's config files (also a config
 * rewritten after the checks). uploadpack.packObjectsHook is read from
 * protected config only (system, global, command line): system is off and
 * the global config is the engine's empty file.
 */
export declare function uploadPackCommand(tools: PrivateGitTools): string;
/**
 * The environment on top of scrubShipEnv: no system config, the empty global
 * config, no replace objects, no grafts, no prompts, no LFS download, and no
 * lazy fetch: a promisor remote planted in a repository's config (its
 * uploadpack a command) would otherwise run on any read of a missing object,
 * a plain `ls-tree` or `cat-file -e` included (review-481 HIGH-1); with it a
 * missing object is an error, and a partial-clone user repository fails
 * closed.
 */
export declare function privateGitEnv(tools: PrivateGitTools): Record<string, string>;
/** A file in a capped (hooks) listing larger than this is not read: the listing is TOO_LARGE (review-481c N1). */
export declare const HOOK_FILE_MAX_BYTES: number;
/**
 * The user repository's common git dir, resolved once (at run start) from
 * the checkout and then passed to every function here, so a later rewrite of
 * the checkout's `.git` cannot move it; userRepoGuardSnapshot records it.
 */
export declare function resolveUserGitDir(root: string, ctx: PrivateStoreContext): string;
/**
 * Fixed-text reason to refuse a transport with the user repository: a
 * redirect, alternates, grafts, shallow, replace refs, a config that changes
 * fsck severities or skip lists (fetch.fsck.* beats our transfer pins), or a
 * url rewrite / remote named after one of `paths` (the private git dir it
 * fetches from: a rewrite to another protocol or repository).
 */
export declare function userRepoProblem(gitDir: string, ctx: PrivateStoreContext, paths?: readonly string[]): string | null;
export type UserGuardItem = 'gitdir' | 'redirect' | 'config' | 'hooks' | 'hooksPath' | 'modules' | 'worktrees' | 'grafts' | 'shallow' | 'alternates' | 'http-alternates' | 'replace';
/**
 * What one guard entry is (machine-readable, for the engine's park message):
 * - `config-key`: a dangerous key in a config file (`path` the file, `key` its name);
 * - `config-link`: a config or included file that is a link (`path` the link);
 * - `include-not-followed`: a conditional include (includeIf) whose target is
 *   a directory or cannot be read; git skips it while the condition is false
 *   and fails while it is true, so it is recorded, not counted as unreadable;
 * - `unreadable`: what could not be read (`path`), or the snapshot failed;
 * - `hooks-dir`: a hooks dir listing (`path` the dir); `hooks-path`: a
 *   core.hooksPath value's dir (`path` the resolved dir, `key` core.hookspath);
 * - `hooks-too-large`: a hooks dir deeper than 3 levels or over 2 000
 *   entries; `hooks-path-root`: a hooksPath that resolves to the work tree
 *   root or the git dir;
 * - `module`: a submodule git dir (`path` modules/<name>); `worktree`: a
 *   worktrees/<id> entry that is not stock;
 * - `redirect-entry`, `grafts`, `shallow`, `alternates`, `http-alternates`:
 *   that file (`path`); `replace-ref`: a refs/replace/* ref (`path` its name);
 *   `gitdir`: the git dir itself.
 */
export type UserGuardKind = 'gitdir' | 'redirect-entry' | 'config-key' | 'config-link' | 'include-not-followed' | 'unreadable' | 'hooks-dir' | 'hooks-path' | 'hooks-too-large' | 'hooks-path-root' | 'module' | 'worktree' | 'grafts' | 'shallow' | 'alternates' | 'http-alternates' | 'replace-ref';
/** One guard entry as the engine may print it: never a config value (values may hold secrets); URL userinfo in a key name is masked. */
export interface UserGuardDetail {
    item: UserGuardItem;
    kind: UserGuardKind;
    path: string;
    key?: string;
}
/** A guard entry with its fingerprint (a sha256 over what it covers, values included: compare only, never print). */
export interface UserGuardEntry extends UserGuardDetail {
    fingerprint: string;
}
export interface UserRepoGuard {
    gitDir: string;
    items: Record<UserGuardItem, string>;
    entries: UserGuardEntry[];
}
/**
 * A config key name fit to print: URL userinfo in a subsection
 * (`url.https://user:token@host/.insteadof`) and a URL query or fragment up to
 * the key name (`url.https://h/?t=X.insteadof`: review-481c N4) masked.
 */
export declare const printableKey: (key: string) => string;
/**
 * The narrow user-repository guard the engine takes under the import lock
 * (design 6/8; review-481 M4 with the lead's L5 rule): hashes of only what
 * can make git (or the user's next git command) run something or go
 * elsewhere:
 * - `config`: the dangerous keys (DANGEROUS_CONFIG) of config,
 *   config.worktree, worktrees/<id>/config.worktree and every file they
 *   include (depth-bounded);
 * - `hooks`: hooks/; `hooksPath`: the effective core.hooksPath (merged
 *   config: local, worktree, includes) and every value met in the files
 *   above, each with its dir's listing (capped: HOOKS_CAP; a hooksPath at
 *   the work tree root or the git dir is its own `hooks-path-root` entry);
 * - `modules`: each submodule git dir's hooks/ and dangerous config;
 * - `worktrees`: entries whose commondir is not the stock `../..` or whose
 *   commondir/gitdir is not a regular file (a redirect); a plain
 *   `git worktree add` changes nothing;
 * - `grafts`, `shallow`, alternates, http-alternates, refs/replace/*, and
 *   redirect entries.
 * Not branch.*, remote urls, user.*, info/exclude, info/sparse-checkout,
 * commit-graph, multi-pack-index, packs or info/refs: the user's own
 * `push -u`, `remote add`, `sparse-checkout`, gc and maintenance write those,
 * and every command here pins the graph files off (review-476 M-E).
 * The git commands in the repository (the effective hooksPath read and the
 * refs/replace listing, which read the merged config) are skipped when a
 * config file or an include cannot be read (a FIFO include would block
 * them); those items are then `unreadable`. It never
 * throws: a timeout or any other error makes every item `unreadable`, with
 * one `unreadable` entry for the git dir. `entries` carry each entry's kind
 * and path for the park message (userRepoGuardChanges).
 */
export declare function userRepoGuardSnapshot(gitDir: string, ctx: PrivateStoreContext): UserRepoGuard;
/** The items that differ (fixed names); empty = unchanged. An `unreadable` or `too-large` item always counts as changed. */
export declare function compareUserRepoGuard(before: UserRepoGuard, after: UserRepoGuard): UserGuardItem[];
/**
 * The entries behind compareUserRepoGuard, for an actionable park message
 * (kind, path, key name; no values, no fingerprints): those added or changed
 * in `after`, those gone from it, and every `unreadable`, `include-not-followed`,
 * `hooks-too-large` or `hooks-path-root` entry of a changed item.
 */
export declare function userRepoGuardChanges(before: UserRepoGuard, after: UserRepoGuard): UserGuardDetail[];
/**
 * A fresh snapshot of `before.gitDir` compared with `before` (review-481
 * M3). The publish order under the import lock is:
 *   1. checkUserRepoGuard(baseline) must be empty (else park, no push);
 *   2. importFromPrivate, then the hardened push, then dropImportRef;
 *   3. checkUserRepoGuard(baseline) must be empty again: anything planted
 *      during the import window parks the run instead of becoming the
 *      baseline;
 *   4. only then baseline = userRepoGuardSnapshot(userGitDir) for the next import.
 * For the park message, take a snapshot and userRepoGuardChanges(baseline, it).
 */
export declare function checkUserRepoGuard(before: UserRepoGuard, ctx: PrivateStoreContext): UserGuardItem[];
/** Fixed-text reason to refuse the seed: a redirect, a config the engine did not write, alternates, grafts, shallow, replace refs. */
export declare function seedProblem(seed: string, ctx: PrivateStoreContext): string | null;
/**
 * Make the seed (`git init --bare --template=`) when it is missing, check
 * it, then fetch `sha` by sha from the user repository into
 * `refs/heads/omg-<sha>` (a ref per sha, so runs on other bases never race).
 * The user repository is checked first (userRepoProblem); its upload-pack
 * runs pinned (uploadPackCommand). The seed never gets refs/replace or tags:
 * the one refspec names its destination.
 */
export declare function ensureSeed(layout: PrivateRunLayout, userGitDir: string, sha: string, ctx: PrivateStoreContext): void;
export interface PrivateRepo {
    /** <slug>/repo */
    repo: string;
    /** <slug>/repo/.git */
    gitDir: string;
    /** The seed it was cloned from and fetches from (no alternates: a full copy). */
    seed: string;
    baseSha: string;
    /** privateRepoConfigHash at creation (or the engine's last own config write). */
    configHash: string;
    /** The longest tracked path at the base, for longPathProblem on lane worktrees. */
    longestPath: number;
}
/**
 * sha256 over the private git dir's config, config.worktree, hooks/ and
 * info/ (listings with content). The engine records it after its own last
 * config write and compares it before every transport.
 */
export declare function privateRepoConfigHash(gitDir: string): string;
/**
 * Fixed-text reason to refuse the private repository: a redirect, a
 * config/hooks/info hash other than the recorded one, a config the engine
 * did not write (core.bare must be false, no core.worktree, no partial clone
 * or promisor remote, no extension beyond the object format), any
 * alternates, grafts, shallow, replace refs. Run it before every engine
 * command in the private repository, reads included (lockfileUnchanged).
 */
export declare function privateRepoProblem(p: PrivateRepo, ctx: PrivateStoreContext): string | null;
/**
 * Clone the run's private repository from the seed: a `--no-local` clone
 * (every object sent as a pack and re-hashed by index-pack with fsck on, so
 * a replaced seed object arrives under another id and the clone fails: no
 * separate seed fsck is needed; review-481b 1); only reachable objects, no
 * refs/replace, no copied info/), `--no-checkout --no-tags --single-branch
 * --template=`, and NO `--reference`: no alternates at all, so nothing in
 * the seed is read unverified later (review-481 M1). Then HEAD == baseSha
 * (detached; the clone's branch deleted), the origin remote removed,
 * core.longpaths=true written, the config checked against what the engine
 * wrote, and its hash recorded.
 */
export declare function createPrivateRepo(layout: PrivateRunLayout, baseSha: string, ctx: PrivateStoreContext): PrivateRepo;
/**
 * Objects in (a moved base, an adopted head): `sha` by sha from the user
 * repository into the seed (ensureSeed), then from the seed into the
 * private repository (no ref, no FETCH_HEAD: the objects stay reachable
 * through the seed's ref), both checked first; then the private repository
 * must have the commit.
 */
export declare function fetchIntoPrivate(layout: PrivateRunLayout, p: PrivateRepo, userGitDir: string, sha: string, ctx: PrivateStoreContext): void;
/** privateRepoProblem refused an engine command: the private repository changed outside the engine (the engine parks). */
export declare class PrivateRepoTampered extends PrivateStoreError {
    constructor(problem: string, gitDir: string);
}
/** Throws PrivateRepoTampered unless privateRepoProblem passes. */
export declare function assertPrivateRepo(p: PrivateRepo, ctx: PrivateStoreContext): void;
export interface PrivateGitOptions {
    /** The work tree: a lane worktree, `prep` or the clone dir (default: the clone dir). */
    workTree?: string;
    /** The git dir to name (a worktree's admin dir as recorded at its creation; default: the private git dir). */
    gitDir?: string;
    /** Extra environment (the engine's commit identity); never GIT_* that redirects (the pins and privateGitEnv win). */
    env?: Readonly<Record<string, string>>;
}
/**
 * One engine git command in the private repository (review-481 B1b a/b):
 * privateRepoProblem first (PrivateRepoTampered), then git with the pins and
 * privateGitEnv, and the git dir and work tree named on the command line,
 * never discovered from a lane-writable `.git` file.
 */
export declare function privateGit(p: PrivateRepo, ctx: PrivateStoreContext, args: readonly string[], o?: PrivateGitOptions): ExecResult;
/** privateGit that throws PrivateStoreError (fixed text `what`, stderr in detail) on a non-zero exit; returns stdout. */
export declare function privateGitOk(p: PrivateRepo, ctx: PrivateStoreContext, args: readonly string[], what: string, o?: PrivateGitOptions): string;
/**
 * An Exec for code that runs plain `git <args>` with a cwd (snapshotRepo,
 * ship's runPrepare) against the private repository: every call goes through
 * privateGit with the git dir `gitDirOf(cwd)` names (a recorded admin dir, or
 * the private git dir for the clone dir); a cwd it does not know, or any
 * other program, is refused (exit 127), so nothing runs by discovery.
 */
export declare function privateExec(p: PrivateRepo, ctx: PrivateStoreContext, gitDirOf: (cwd: string) => string | null, env?: Readonly<Record<string, string>>): Exec;
/** git 2.44 is the first that knows GIT_NO_LAZY_FETCH (older git ignores it silently: review-481b j). */
export declare const PRIVATE_GIT_MIN_VERSION: readonly [2, 44];
/** Null, or why the git on PATH is too old for the private store (or its version cannot be read). */
export declare function gitVersionProblem(exec?: Exec): string | null;
/**
 * Re-record the config hash after an engine-made config write (review-481
 * h): the allowlist (engineConfigProblem) still applies, so a write the
 * engine did not mean to make is refused, not accepted.
 */
export declare function rerecordConfigHash(p: PrivateRepo, ctx: PrivateStoreContext): PrivateRepo;
/** True when the private repository has `sha` as a commit (privateRepoProblem first). */
export declare function privateHasCommit(p: PrivateRepo, ctx: PrivateStoreContext, sha: string): boolean;
/** The import refs (`refs/omg-import/<run>/*`) left in the user repository, with their values (a crash after an import). */
export declare function staleImportRefs(userGitDir: string, run: string, ctx: PrivateStoreContext): Array<{
    ref: string;
    sha: string;
}>;
/** Delete one stale import ref against the value it holds (staleImportRefs); false when it stays. */
export declare function dropStaleImportRef(userGitDir: string, ref: string, sha: string, ctx: PrivateStoreContext): boolean;
export interface ImportInput {
    /** The user repository's common git dir (resolveUserGitDir at run start). */
    userGitDir: string;
    privateRepo: PrivateRepo;
    /** The sealed commit to import (the engine's commit-tree output). */
    sha: string;
    /** Its parents, in order, exactly. */
    expectedParents: readonly string[];
    /** The tree the protected-path diff starts from (the lane's start: base or the previous head). */
    startSha: string;
    /** Run label (ref component): `refs/omg-import/<run>/<n>`. */
    run: string;
    n: number;
    /** Configured protected paths (factory/ship config), on top of ship PROTECTED_PATHS and LANE_PROTECTED_PATHS. */
    extraProtected?: readonly string[];
}
export type ImportRefusalCode = 'bad-input' | 'user-repo' | 'private-repo' | 'fetch-failed' | 'ref-mismatch' | 'parents-mismatch' | 'diff-failed' | 'protected-path' | 'gitlink' | 'symlink' | 'ref-left' | 'timeout';
export type ImportResult = {
    ok: true;
    ref: string;
    files: string[];
} | {
    ok: false;
    code: ImportRefusalCode;
    reason: string;
};
/** The user-repository ref an import lands on; never a branch. */
export declare function importRef(run: string, n: number): string;
/**
 * Import `sha` from the private repository into the user repository (audit
 * 6/6 steps 1-4): both repositories checked (userRepoProblem with the url
 * rewrite check on the private path; privateRepoProblem), `startSha` and
 * every expected parent already commits in the user repository (review-481
 * M2: no private-only history rides in), then a hardened
 * `fetch +<sha>:refs/omg-import/<run>/<n>` in the user repository (fsck on
 * every object, no FETCH_HEAD, no tags, no submodules, pinned upload-pack),
 * then the ref must name `sha`, `rev-list --parents` must equal
 * `expectedParents` exactly, `rev-list --count <sha> --not <parents>` must be
 * 1 (no allowance for more), and the two-tree `diff-tree -r --no-renames
 * <startSha> <sha>` may touch no protected path (ship + lane + configured)
 * and add or change no gitlink (160000) or symlink (120000). Any refusal
 * after the fetch deletes the import ref against its value (`ref-left` when
 * that fails); a git timeout is the `timeout` refusal. The push and
 * dropImportRef are the caller's.
 */
export declare function importFromPrivate(input: ImportInput, ctx: PrivateStoreContext): ImportResult;
/** Delete the import ref (after the push, or to clean up) against its expected value `sha`; throws `import ref left` when it stays. */
export declare function dropImportRef(userGitDir: string, run: string, n: number, sha: string, ctx: PrivateStoreContext): void;
/** Test seam for removeRunDir: called right before each directory's re-lstat and readdir (a swap there is the M5 race). */
export interface RemoveSeam {
    beforeReaddir?: (dir: string) => void;
}
/**
 * Remove a run dir (or the seed) under the work root without ever following
 * a link (a worktree removal once emptied the TARGET of a node_modules
 * junction). First the dir is renamed to an engine-only `.trash-<random>`
 * next to it (under the repository dir), so a process still holding the old
 * path cannot reach what is walked (and on Windows the rename fails while a
 * process has a cwd or open file there: refused). Then: unlink every symlink
 * and junction at any depth, prove by a second walk that none remains
 * (refuse otherwise), then delete files and directories bottom up, refusing
 * at any link that appeared meanwhile. Every directory is re-lstat-ed (same
 * node, still a plain directory) right before it is read. B1b calls it only
 * after every lane process tree is gone. The module keeps this walk rather
 * than PR #478's removal helper, which does not re-lstat before each read
 * and ends in a recursive rm (review-481b nit).
 */
export declare function removeRunDir(dir: string, work: string, platform?: NodeJS.Platform, seam?: RemoveSeam): void;
/** The lockfiles whose bytes decide the node_modules policy, at the repository root. */
export declare const LOCKFILES: readonly string[];
export interface LockfileRule {
    /** `junction`: the main checkout's node_modules may be linked read-only; `park`: factory.run.gateInstall decides. */
    policy: 'junction' | 'park';
    /** The lockfiles at the base. */
    lockfiles: string[];
    /** Lockfiles changed, removed or added at the head (fixed names from LOCKFILES). */
    changed: string[];
}
/**
 * The design 4/8 node_modules rule: `junction` only when the base has at
 * least one lockfile and every lockfile entry at the head is identical to
 * the base's (mode and blob id: git's ids are content hashes, so equal ids
 * are equal bytes), no lockfile added, and each is a regular file; `park`
 * otherwise. Both shas are sealed and read from the private repository
 * (it holds both), which must pass privateRepoProblem first: its config is
 * what a read there obeys (review-481 HIGH-1).
 */
export declare function lockfileUnchanged(p: PrivateRepo, baseSha: string, headSha: string, ctx: PrivateStoreContext): LockfileRule;
//# sourceMappingURL=private-store.d.ts.map