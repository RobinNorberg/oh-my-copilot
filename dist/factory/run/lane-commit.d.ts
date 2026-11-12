/**
 * Engine-side commits for `omg factory run` write lanes
 * (.omc/plans/2026-10-27-sandboxed-lanes-design.md §4.3).
 *
 * A write lane's sandbox keeps the common git dir read-only, so the lane only
 * edits its worktree. The engine commits for it, after the lane confirmed its
 * end and passed the tamper check, with host git hardened by runHostGit: no
 * hook, fsmonitor, filter or diff driver, GIT_ATTR_SOURCE the empty tree,
 * and the git dir, work tree and common dir pinned to the links recorded when
 * the worktree was created (a changed link refuses before any git runs).
 *
 * The commit is built from objects: the engine reads every changed file
 * itself and writes the bytes as blobs into a temporary index seeded from the
 * start tree (stageEngineRead: git never reads the worktree, so a link swapped
 * in after the checks cannot make GIT read a file outside it; the engine's
 * own read could follow a link swapped onto a parent directory, so
 * engineRead pins every parent's identity and checks it again after the
 * read, which leaves only a swap away and back inside that window: see
 * REFERENCE's security model), then
 * `write-tree` and `commit-tree` with engine-chosen parents and the
 * engine-owned identity, so no commit hook and no signing program runs and
 * nothing the lane wrote picks the author. The lane's branch and its
 * worktree's HEAD move to the commit only from the value they started at.
 * The caller first proves the lane's process tree gone (lane-procs.ts).
 *
 * Refused before any commit: a lane that moved its HEAD, a new or changed
 * gitlink (host git never enters a nested repository, so its content is
 * unreviewed; the engine reads each start gitlink's checked-out HEAD
 * itself; a submodule directory that is gone is committed as a deletion,
 * as `add -A` did), a link host git could follow out of the worktree, a
 * changed symlink placeholder (core.symlinks=false), a file over
 * LANE_FILE_MAX_BYTES, changed files over LANE_COMMIT_MAX_BYTES together,
 * a merge-rule or lane-protected path, secret-shaped
 * content in a changed file, a changed path's name or the commit message
 * (heal/sanitize.ts SECRET_SHAPES: a key or token the lane could have copied
 * in from outside its sandbox) unless acknowledged or allow-listed, and an
 * empty change.
 *
 * Parameterised by explicit paths only (the worktree with its recorded git
 * links, and `repoRoot`, whose common git dir holds the lane's branch): a
 * run whose lanes work in another repository passes that repository's root.
 *
 * Links: Git for Windows follows a directory junction in `add -A`, and the
 * engine's git runs outside the sandbox with the user's read rights, so a
 * junction to `~/.ssh` would be committed and pushed by the engine. Before
 * staging, the worktree (minus what git ignores) is walked with lstat: a
 * directory link, or on win32 any link, refuses. After staging, a new or
 * changed symlink entry (120000) refuses, and so does a staged path whose
 * real directory is outside the worktree's; those refusals reset the index
 * to the start tree.
 */
import { type SecretShapeKind } from '../heal/sanitize.js';
/** Author and committer of every engine-made lane commit (fixed: nothing a lane wrote chooses it). */
export declare const ENGINE_COMMIT_IDENTITY: Readonly<{
    name: "omg factory";
    email: "omg-factory@oh-my-copilot.invalid";
}>;
/** The refusal of a completed lane that changed nothing (the bench scores a trap's implement-failed park with it as "declined"). */
export declare const LANE_LEFT_NO_CHANGES = "the lane left no changes in its worktree";
/**
 * oh-my-copilot's own runtime artifacts a lane's session and plugin hooks
 * write in its worktree: everything under `.omg/` (state, sessions,
 * notepad.md, project-memory.json with your home path in it, plans, research,
 * logs, artifacts, handoffs, ultragoal, ...) except `.omg/skills/`, the
 * documented committable exception. Skipped by the engine's staging when
 * untracked (never committed or summarized; a lane that changed only these
 * left no changes); a path the start tree tracks is staged as any other (L1).
 */
export declare function isOmcRuntimePath(path: string): boolean;
/**
 * Where Azure Pipelines definitions conventionally live: the CI that gates an
 * ADO PR. A lane may not change them (a red build could turn green), and on
 * Azure DevOps a PR touching them needs the owner (merge-policy.ts).
 */
export declare const ADO_PIPELINE_PATHS: readonly string[];
/**
 * Paths a write lane may not change, on top of ship's PROTECTED_PATHS (which
 * `omg ship` keeps as it is): agent instructions, hooks, skills and CI.
 * `.github/` covers `.github/copilot-instructions.md` and the workflows;
 * `.claude/`, `.mcp.json` and `.vscode/` hold the hooks, MCP servers and
 * tasks other agents and editors run from a checkout, `.husky/` the git hooks
 * husky installs. CI_DEFINITION_PATHS: with no `ship.requiredChecks` the
 * gates require every check the forge reports, so a lane must not be able to
 * drop a CI system's definition and with it the checks.
 */
export declare const CI_DEFINITION_PATHS: readonly string[];
/** Every CI system's definition paths (GitHub Actions, Azure Pipelines, the rest): the gates' no-CI rule reads them from the base and head trees. */
export declare const CI_TREE_PATHS: readonly string[];
export declare const LANE_PROTECTED_PATHS: readonly string[];
export type LaneCommitRefusal = 'moved' | 'gitlink' | 'escaped' | 'protected' | 'secret' | 'empty' | 'error';
/** One secret-shaped hit of the content scan: the path and the shape, never the value. */
export interface SecretFinding {
    path: string;
    kind: SecretShapeKind;
}
export type LaneCommitResult = {
    ok: true;
    sha: string;
    files: string[];
    notes: string[];
} | {
    ok: false;
    refusal: LaneCommitRefusal;
    reason: string;
    findings?: SecretFinding[];
};
export interface LaneCommitInput {
    /** The lane worktree (its git links were recorded at creation). */
    worktree: string;
    /** The commit the lane started at: its worktree's HEAD must still be here. */
    start: string;
    /** The new commit's parents (the start for a plain lane; the PR head and the base for conflict-fix). */
    parents: readonly string[];
    /** The repository root (the lane's branch is moved from there). */
    repoRoot: string;
    /** The lane's branch, moved to the commit when it is still at `start`. */
    branch: string | null;
    message: string;
    /** Configured merge-rule paths beyond PROTECTED_PATHS (ship.knownFlakyFile). */
    extraProtected?: readonly string[];
    /** (path, kind) pairs of the secret scan the human acknowledged (`--allow-secret-shapes` after a secret-shaped-content park). */
    secretAck?: readonly SecretFinding[];
    /** Path globs the secret scan skips (factory.run.secretScan.allowPaths, trusted layers only: test fixtures). */
    secretAllowPaths?: readonly string[];
    /** Test seam: lower limits (default LANE_COMMIT_MAX_BYTES and FAST_IMPORT_BATCH_BYTES). */
    limits?: {
        totalBytes?: number;
        batchBytes?: number;
    };
}
/**
 * A commit message from untrusted lane text: no control, format or bidi
 * characters except newlines, no skip-CI marker, no trailer the lane wrote,
 * bounded.
 */
export declare function laneCommitMessage(title: string, body: string | null): string;
/** The staged paths whose real directory is outside the worktree's (a link git followed). */
export declare function outsideWorktree(worktree: string, files: readonly string[]): string[];
/** The finding path of a secret shape in the commit message. */
export declare const SECRET_MESSAGE_PATH = "(commit message)";
/** The finding path of a secret shape in a changed path's NAME: a hash of it, so the value is never echoed. */
export declare const secretPathLabel: (path: string) => string;
/** `**` any path segments, `*` and `?` within one segment; matched against the whole repo-relative path. */
export declare function pathGlobMatches(glob: string, path: string): boolean;
/**
 * A changed file bigger than this is refused (`error`) instead of read: the
 * engine holds every changed file in memory (and a batch of them twice
 * while it builds a fast-import stream), so a multi-GB file would crash
 * it. 100 MiB is
 * GitHub's own hard per-file limit: a bigger file could never be pushed.
 */
export declare const LANE_FILE_MAX_BYTES: number;
/**
 * The changed files of one lane commit together (review-484b 6): over this
 * the commit is refused (`error`) instead of read on. The engine keeps
 * every changed file's bytes for the secret scan, so this bounds its memory;
 * 1 GiB is half of GitHub's 2 GiB limit for one push (the run's push
 * carries the lane commit), and no reviewable change of a coding lane comes
 * near it.
 */
export declare const LANE_COMMIT_MAX_BYTES: number;
/** The blobs go to git in `fast-import` streams of about this size, so the stream never doubles all the bytes at once. */
export declare const FAST_IMPORT_BATCH_BYTES: number;
/** One path of the lane's change, read by the engine (never by git). */
type EngineRead = {
    kind: 'deleted';
} | {
    kind: 'dir';
} | {
    kind: 'link';
} | {
    kind: 'other';
} | {
    kind: 'big';
    size: bigint;
} | {
    kind: 'swapped';
    why: string;
} | {
    kind: 'file';
    bytes: Buffer;
    exec: boolean;
    nlink: number;
};
/**
 * Read `rel` under `worktree` without following any link: the worktree and
 * every parent component lstat'ed (a link there is `swapped`; a missing or
 * non-directory one means the path is gone) and their (dev, ino) kept, the
 * file itself lstat'ed, opened (O_NOFOLLOW where the platform has it), its
 * fstat dev/ino compared with the lstat, read whole, then lstat'ed again
 * (same file, same size), and then the whole parent chain lstat'ed again: a
 * junction or symlink swapped onto a parent after its first lstat (O_NOFOLLOW
 * guards only the last component, and open follows a link in the middle)
 * changes that component's identity. On Linux the opened descriptor's own
 * path (/proc/self/fd) must also be the expected one. Anything that changed
 * between the steps is `swapped`. Not closed: a parent swapped away and back
 * again entirely between two lstats (see REFERENCE, security model).
 * `realRoot` is the worktree's realpath (computed once by the caller).
 */
export declare function engineRead(worktree: string, rel: string, realRoot?: string): EngineRead;
/**
 * What a start-tree gitlink (160000) at `rel` is checked out at, read by the
 * engine (host git runs with --ignore-submodules=all and never enters it):
 * `absent` when the directory is gone, `unchecked` when it holds no `.git`
 * (a submodule that was never initialised: git keeps the gitlink as it is),
 * the sha its HEAD names, or `unknown` with why. Nothing here is committed;
 * the sha is only compared.
 */
export declare function gitlinkHead(worktree: string, rel: string): {
    kind: 'absent';
} | {
    kind: 'unchecked';
} | {
    kind: 'not-dir';
} | {
    kind: 'head';
    sha: string;
} | {
    kind: 'unknown';
    why: string;
};
/** git's gather_stats (convert.c): CRLF pairs, lone CR, NUL, printable and non-printable bytes. */
export declare function textStats(buf: Buffer): {
    crlf: number;
    lonecr: number;
    nul: number;
    printable: number;
    nonprintable: number;
};
/** git's convert_is_binary. */
export declare function isBinaryText(s: ReturnType<typeof textStats>): boolean;
/**
 * git's crlf_to_git for core.autocrlf true or input with no text/eol
 * attribute (CRLF_AUTO_*), after the caller checked that the bytes are text
 * with a CRLF and that the start blob has none (has_crlf_in_index): every CR
 * goes (a text file has no lone CR).
 */
export declare function autoCrlfToGit(buf: Buffer): Buffer;
/**
 * Commit a write lane's worktree changes for it (see the module comment).
 * Call only after the lane confirmed its end and its tamper check passed.
 * Never throws: a git failure is `error`.
 */
export declare function commitLaneWork(input: LaneCommitInput): LaneCommitResult;
/**
 * The start commit of a conflict-fix lane: `merge-tree --write-tree` of the
 * PR head and the base, committed with both as parents. Conflicted files keep
 * git's conflict markers for the lane to resolve; nothing is checked out, no
 * ref moves, and GIT_ATTR_SOURCE is the empty tree, so no merge driver,
 * filter or attribute from either side applies. The engine's final commit
 * takes the same two parents (commitLaneWork), never this commit.
 */
export declare function conflictFixStart(repoRoot: string, head: string, base: string, message: string): {
    sha: string;
    conflicted: string[];
};
export {};
//# sourceMappingURL=lane-commit.d.ts.map