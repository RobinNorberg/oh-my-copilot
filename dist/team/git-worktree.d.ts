export type TeamWorktreeMode = 'disabled' | 'detached' | 'named';
export interface WorktreeInfo {
    path: string;
    branch: string;
    workerName: string;
    teamName: string;
    createdAt: string;
    repoRoot?: string;
    detached?: boolean;
    created?: boolean;
    reused?: boolean;
    /** The commit the worktree was created at; worker commits are counted on top of it. */
    baseCommit?: string;
}
/** A clean worker worktree kept because it holds commits the leader HEAD does not contain. */
export interface PreservedWorktree {
    workerName: string;
    path: string;
    /** Named-mode branch, kept; null for a detached worktree. */
    branch: string | null;
    /** Worker commits not merged into the leader HEAD. */
    commits: number;
}
export interface EnsureWorkerWorktreeOptions {
    mode?: TeamWorktreeMode;
    baseRef?: string;
    requireCleanLeader?: boolean;
}
export interface EnsureWorkerWorktreeResult extends WorktreeInfo {
    mode: TeamWorktreeMode;
    repoRoot: string;
    detached: boolean;
    created: boolean;
    reused: boolean;
}
export interface CleanupTeamWorktreesResult {
    removed: string[];
    /** Kept because removal was unsafe or failed: blocks the team state disposal. */
    preserved: Array<{
        workerName: string;
        path: string;
        reason: string;
    }>;
    /** Kept on purpose, with unmerged worker commits: the work outlives the team. */
    retained: PreservedWorktree[];
}
export interface TeamWorktreeCleanupSafety {
    hasEvidence: boolean;
    entries: WorktreeInfo[];
    blockers: Array<{
        workerName: string;
        path: string;
        reason: string;
    }>;
}
export interface WorktreeRootAgentsRestoreResult {
    restored: boolean;
    reason?: string;
}
/** Get canonical native team worktree path for a worker. */
export declare function getWorktreePath(repoRoot: string, teamName: string, workerName: string): string;
/** Get branch name for a worker. */
export declare function getBranchName(teamName: string, workerName: string): string;
/**
 * `-c` pairs on every host-side git command in a worktree an agent may have
 * configured (a team worker, a copilot_run job): no hook, no fsmonitor, no
 * pager and no external diff it planted in a config level it can write (the
 * worktree's config.worktree, an include, a redirected common dir) runs in
 * the leader's process. Command-line config wins over every file, and git
 * passes it on to the git children it spawns (`worktree remove` runs
 * `status`). The system config stays: only an administrator writes it, and
 * Git for Windows keeps `core.autocrlf` there, so dropping it
 * (GIT_CONFIG_NOSYSTEM) would make clean worktrees look dirty. Its drivers
 * (`filter.lfs`) are blanked on work-tree commands all the same
 * (hostGitDriverOverrides).
 *
 * Every command here only reads, or changes refs and worktree records:
 * `update-ref` would run a reference-transaction hook, which no team flow
 * relies on. `worktree add` stays unhardened so the repository's own
 * post-checkout hook still runs at creation, before any agent ran there.
 * A future fetch, push, commit or merge from an agent's worktree must also
 * pass an explicit `--git-dir` (the repository's common dir).
 *
 * Every other config key that names a program is pinned too (ssh, credential
 * helper, signing programs, editors): an agent can write `config.worktree`
 * once the repository sets `extensions.worktreeConfig` (sparse-checkout does).
 * `-c extensions.worktreeConfig=false` is no defence: git reads extensions
 * from the repository config file only, so config.worktree is still read.
 * Drivers have agent-chosen names (`filter.<name>.clean`, `diff.<name>.textconv`),
 * so runHostGit lists and blanks them per command (hostGitDriverOverrides).
 */
export declare function hostGitHardeningArgs(): string[];
/**
 * The environment of a host git command that names a worktree's recorded git
 * dir (`--git-dir <common>/worktrees/<name> --work-tree <path>`, from
 * worktreeGitDirArgs): GIT_DIR, GIT_WORK_TREE and GIT_COMMON_DIR pinned to the
 * recorded paths, so git reads no link file (the admin dir's `commondir`, the
 * worktree's `.git`) after worktreeGitLinksIntact checked them; a lane child
 * that survived the session cannot flip them in between. Every host command
 * also gets GIT_LFS_SKIP_SMUDGE=1: host git only inspects and never checks
 * files out (`worktree add` does not come here), so a git-lfs that still runs
 * (hostGitDriverOverrides blanks filter.lfs) downloads and writes nothing.
 */
export declare function hostGitEnv(args: readonly string[], base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/**
 * `-c` pairs that switch off every filter and diff driver a config level an
 * agent can write (local, worktree, global, an include) defines: empty
 * `clean`, `smudge` and `process` with `required=false`, empty `textconv` and
 * `command`. Git runs a driver only when its command is non-empty, so status
 * and diff read file bytes as they are. A system-config driver is blanked
 * too: Git for Windows ships `filter.lfs` there, and git-lfs runs the
 * `lfs.extension.<name>.clean/smudge` programs of the merged config, which
 * includes a lane-written config.worktree; host inspection of a lane wants
 * raw bytes, not LFS. An LFS file whose stat changed then shows as modified:
 * a false dirty keeps a worktree, it never loses one.
 * Listing the config runs nothing. Null when the drivers cannot be listed or a
 * filter name cannot be passed as `-c` (it holds `=` or a line break): the
 * caller fails closed.
 */
export declare function hostGitDriverOverrides(cwd: string, env?: NodeJS.ProcessEnv, timeout?: number): string[] | null;
/**
 * Run one host git command, hardened: hostGitHardeningArgs on every command;
 * on a command that touches work-tree files (WORK_TREE_SUBCOMMANDS) also an
 * empty core.attributesFile and hostGitDriverOverrides; and the git dir,
 * work tree and common dir pinned in the environment (hostGitEnv) when the
 * args name a recorded git dir. A git dir worktreeGitDirArgs named is checked
 * against its recorded links (config.worktree included) before every command,
 * so a change after the caller's check still runs no git. In such a lane
 * worktree GIT_ATTR_SOURCE names the empty tree, so no attribute (and so no
 * driver, whatever any config level defines) applies, and no submodule is
 * entered (LANE_SUBMODULE_OVERRIDES, `--ignore-submodules=all`); the driver
 * blanking stays as a second layer. Without attributes no eol/text
 * conversion applies either: in a repository that relies on `.gitattributes`
 * eol (and no core.autocrlf) a stat-dirty file may show as modified, so the
 * worktree is kept, never lost. Raw stdout; throws
 * what execFileSync throws, when the drivers cannot be listed, or
 * `sandbox-escaped:` when the recorded links changed. `baseEnv` (default
 * process.env) is the environment the pins are set over (the factory
 * engine's commit identity).
 */
export declare function runHostGit(cwd: string, args: readonly string[], timeout?: number, baseEnv?: NodeJS.ProcessEnv): string;
/** The empty tree of each object format: GIT_ATTR_SOURCE names it, so host git reads no `.gitattributes`. */
export declare const EMPTY_TREE: Readonly<Record<string, string>>;
/** The first git that honours GIT_ATTR_SOURCE (git --attr-source, 2.41.0). */
export declare const HOST_GIT_ATTR_SOURCE_MIN = "2.41.0";
/**
 * Why the host git cannot inspect a sandboxed lane, or null when it can: a
 * git older than HOST_GIT_ATTR_SOURCE_MIN ignores GIT_ATTR_SOURCE, so the
 * lane's `.gitattributes` would still select drivers and only the driver
 * blanking would stand. `version` is `git --version` output (default: run it).
 */
export declare function hostGitAttrSourceProblem(version?: string | null): string | null;
/**
 * What git wrote for a linked worktree: the `<worktree>/.git` file, and the
 * `gitdir` and `commondir` files of its admin dir (`<common>/worktrees/<name>`).
 * An agent that can write its worktree and admin dir can redirect them to a
 * git dir it controls; record them at creation and compare before host git.
 * The admin dir's `config.worktree` is recorded with them (as a hash): once
 * the repository sets `extensions.worktreeConfig` git merges it into the
 * config of every command, and no `-c` turns that off, so every key a lane
 * plants there (a driver, an `lfs.extension.<name>.clean` program git-lfs
 * runs, the next one) would reach host git. The sandbox cannot keep that
 * file read-only (sandbox.ts laneGitWritePaths), so a change is a tamper.
 */
export interface WorktreeGitLinks {
    /** The admin dir, resolved from the `.git` file at creation. */
    adminDir: string;
    dotGit: string;
    gitdir: string;
    commondir: string;
    /** sha256 of the admin dir's `config.worktree`, or `absent`. */
    configWorktree: string;
}
/** The worktree's git links as they are on disk now (read without git), or null when any is missing, a link or malformed. */
export declare function readWorktreeGitLinks(wtPath: string): WorktreeGitLinks | null;
/**
 * Record a worktree's git links once, when it is created (before any agent
 * ran in it): later host git uses only this record (worktreeGitDirArgs), and
 * a second record of other links throws instead of replacing it. Also reads
 * the repository's object format, for the empty tree runHostGit names in
 * GIT_ATTR_SOURCE; throws when git cannot tell.
 */
export declare function recordWorktreeGitLinks(wtPath: string, links: WorktreeGitLinks): void;
/** The links recorded for `wtPath` at its creation, or null. */
export declare function recordedWorktreeGitLinks(wtPath: string): WorktreeGitLinks | null;
/** Drop the record of a removed worktree. */
export declare function forgetWorktreeGitLinks(wtPath: string): void;
/**
 * Whether the worktree's git links still hold exactly what was recorded, and
 * the recorded admin dir lies in the repository's own `worktrees/` dir.
 */
export declare function worktreeGitLinksIntact(wtPath: string, expected: WorktreeGitLinks, commonGitDir: string): boolean;
/**
 * Host git arguments that name the worktree's recorded git dir and work tree
 * (recordWorktreeGitLinks) instead of discovering them; runHostGit checks the
 * record again before every command that passes them. Throws when nothing
 * was recorded for `wtPath`.
 */
export declare function worktreeGitDirArgs(wtPath: string): string[];
/**
 * Delete a fully merged worker branch only while it still points at `commit`,
 * the commit the unmerged-commit check counted (`update-ref -d` with an old
 * value fails when the ref moved): that failure, or git failing to list
 * worktrees, throws `worktree_branch_delete_failed`, keeping the branch. A
 * branch some worktree (the leader) has checked out is kept with a warning
 * and no error: its commits are merged, so it must not fail the teardown.
 * @internal Exported for tests.
 */
export declare function deleteWorkerBranchAt(repoRoot: string, branch: string, commit: string): void;
/** Where the worktrees a finished team kept for their unmerged commits are listed (outlives the team state). */
export declare function getPreservedWorktreesRecordPath(repoRoot: string, teamName: string): string;
/** Record (or, when empty, clear) the worktrees a team shutdown kept for their unmerged commits. */
export declare function writePreservedWorktreesRecord(repoRoot: string, teamName: string, preserved: PreservedWorktree[]): void;
/** The recorded preserved worktrees of a team whose directory or kept branch still exists. */
export declare function readPreservedWorktreesRecord(repoRoot: string, teamName: string): PreservedWorktree[];
/**
 * Install the generated worker overlay into the root of a native worker worktree.
 * Existing root AGENTS.md content is backed up under leader-owned state so cleanup
 * can safely restore it. Reinstalling preserves the first original backup instead
 * of treating an older managed overlay as user content.
 */
export declare function installWorktreeRootAgents(teamName: string, workerName: string, repoRoot: string, worktreePath: string, overlayContent: string): void;
/**
 * Restore or remove a managed worktree-root AGENTS.md when it is still unchanged.
 * If a worker edited AGENTS.md, leave it and report agents_dirty so cleanup can
 * preserve the worktree instead of overwriting user changes.
 */
export declare function restoreWorktreeRootAgents(teamName: string, workerName: string, repoRoot: string, worktreePath?: string): WorktreeRootAgentsRestoreResult;
export declare function normalizeTeamWorktreeMode(value: unknown): TeamWorktreeMode;
/**
 * Ensure a worker worktree exists according to the selected opt-in mode.
 * Disabled mode is a no-op. Existing clean compatible worktrees are reused;
 * dirty or mismatched existing worktrees throw without deleting files.
 */
export declare function ensureWorkerWorktree(teamName: string, workerName: string, repoRoot: string, options?: EnsureWorkerWorktreeOptions): EnsureWorkerWorktreeResult | null;
/** Legacy creation helper: create or reuse a named-branch worker worktree. */
export declare function createWorkerWorktree(teamName: string, workerName: string, repoRoot: string, baseBranch?: string): WorktreeInfo;
/**
 * Dry-run validation for worker worktree removal. This does not restore/remove
 * managed root AGENTS.md and does not delete backup state.
 */
export declare function checkWorkerWorktreeRemovalSafety(teamName: string, workerName: string, repoRoot: string, worktreePath?: string, gitDirArgs?: readonly string[]): void;
/**
 * Prepare a worker worktree for later removal without deleting the worktree.
 *
 * This is transactional with respect to managed root AGENTS.md overlays: it first
 * validates the overlay is restorable and that no non-overlay files are dirty.
 * Only after that dry-run succeeds does it restore/remove AGENTS.md and delete
 * the backup. If any other dirty file exists, the worker pane/config can remain
 * intact with the managed overlay and backup still available for a later retry.
 */
export declare function prepareWorkerWorktreeForRemoval(teamName: string, workerName: string, repoRoot: string, worktreePath?: string, gitDirArgs?: readonly string[]): void;
/**
 * Remove a worker's worktree and branch, preserving dirty worktrees and
 * worktrees holding commits the leader HEAD does not contain (thrown as
 * `worktree_unmerged_commits`, carrying `preservedWorktree`; the branch is kept).
 * With the worktree directory already gone, the named branch is checked the
 * same way and kept when it holds unmerged worker commits. `contained`: commits
 * (full shas the caller verified, e.g. a fetched remote branch) whose history
 * also counts as merged.
 */
export declare function removeWorkerWorktree(teamName: string, workerName: string, repoRoot: string, options?: {
    gitLinks?: WorktreeGitLinks;
    contained?: readonly string[];
}): {
    tampered: string | null;
};
/** List all worktrees for a team. */
export declare function listTeamWorktrees(teamName: string, repoRoot: string): WorktreeInfo[];
export declare function inspectTeamWorktreeCleanupSafety(teamName: string, repoRoot: string): TeamWorktreeCleanupSafety;
/**
 * Remove all clean worktrees for a team. Dirty or unverifiable ones are
 * `preserved` (a cleanup failure); clean ones holding unmerged worker commits
 * are `retained` (kept on purpose, not a failure).
 */
export declare function cleanupTeamWorktrees(teamName: string, repoRoot: string): CleanupTeamWorktreesResult;
//# sourceMappingURL=git-worktree.d.ts.map