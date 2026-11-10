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
 * in after the checks cannot make git read a file outside it), then
 * `write-tree` and `commit-tree` with engine-chosen parents and the
 * engine-owned identity, so no commit hook and no signing program runs and
 * nothing the lane wrote picks the author. The lane's branch and its
 * worktree's HEAD move to the commit only from the value they started at.
 * The caller first proves the lane's process tree gone (lane-procs.ts).
 *
 * Refused before any commit: a lane that moved its HEAD, a new or changed
 * gitlink (host git never enters a nested repository, so its content is
 * unreviewed), a link host git could follow out of the worktree, a
 * merge-rule or lane-protected path, secret-shaped content (heal/sanitize.ts
 * SECRET_SHAPES: a key or token the lane could have copied in from outside
 * its sandbox) unless acknowledged or allow-listed, and an empty change.
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
 * husky installs.
 */
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
}
/**
 * A commit message from untrusted lane text: no control, format or bidi
 * characters except newlines, no skip-CI marker, no trailer the lane wrote,
 * bounded.
 */
export declare function laneCommitMessage(title: string, body: string | null): string;
/** The staged paths whose real directory is outside the worktree's (a link git followed). */
export declare function outsideWorktree(worktree: string, files: readonly string[]): string[];
/** `**` any path segments, `*` and `?` within one segment; matched against the whole repo-relative path. */
export declare function pathGlobMatches(glob: string, path: string): boolean;
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
    kind: 'swapped';
    why: string;
} | {
    kind: 'file';
    bytes: Buffer;
    exec: boolean;
    nlink: number;
};
/**
 * Read `rel` under `worktree` without following any link: every parent
 * component lstat'ed (a link there is `swapped`; a missing or non-directory
 * one means the path is gone), the file itself lstat'ed, opened (O_NOFOLLOW
 * where the platform has it), its fstat dev/ino compared with the lstat, read
 * whole, then lstat'ed again (same file, same size). Anything that changed
 * between the steps is `swapped`.
 */
export declare function engineRead(worktree: string, rel: string): EngineRead;
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