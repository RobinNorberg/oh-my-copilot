/**
 * The implement lane's free pre-scan (no model call): from the issue's title
 * and plan text it takes the file paths and code identifiers, matches them
 * against the BASE commit's tree (path names, then the text of small tracked
 * files), and returns a short ranked list of likely relevant paths for the
 * implement prompt. A hint only: the lane still changes whatever the plan
 * needs.
 *
 * Only paths and a one-line reason ever leave this module, never file
 * contents. Skipped: anything under a dependency or build directory, binary
 * and large files, secret-looking names, files with secret-shaped content
 * (the lane commit's scan, heal/sanitize.ts), paths a write lane may not
 * change (LANE_PROTECTED_PATHS), paths with characters outside a plain set,
 * and paths the caller's `ignored` check reports (.gitignore). Bounded in
 * tree bytes and entries and in bytes read, so the list depends on the input
 * and the tree only; the wall-time budget is an abort that lists nothing. A
 * git failure rejects (the caller warns and drops the hint).
 */
/** One likely relevant file: a repo path and why it was picked (never file contents). */
export interface LikelyFile {
    path: string;
    reason: string;
}
/**
 * Host git in the repository that holds the base commit (hardened, replace
 * objects off, asynchronous so the engine loop keeps running); stdout as
 * bytes. Output beyond `maxBuffer` rejects.
 */
export type PrescanGit = (args: readonly string[], input: Buffer | undefined, maxBuffer: number) => Promise<Buffer>;
export interface PrescanOptions {
    /** The most paths listed (default 8). */
    maxFiles?: number;
    /** A file larger than this is never read (default 200 KB). */
    maxFileBytes?: number;
    /** The content phase stops after reading this many bytes in all (default 8 MB). */
    maxTotalBytes?: number;
    /** A tree with more entries gets path matches only, no content phase (default 50,000). */
    maxTreeEntries?: number;
    /** The `ls-tree` output above this many bytes rejects: a huge tree gets no list (default 16 MB). */
    maxTreeBytes?: number;
    /** Past this many milliseconds the scan lists nothing (an abort, never a partial list; default 2,000). */
    budgetMs?: number;
    /** The clock (tests). */
    now?: () => number;
    /** The candidate paths a .gitignore excludes; a rejection rejects the scan. */
    ignored?: (paths: readonly string[]) => Promise<ReadonlySet<string>>;
    /** Called with every tracked file path of the base once the tree is read (the implement prompt's outside-path note). */
    onTree?: (tracked: ReadonlySet<string>) => void;
}
/**
 * The repo paths and code identifiers an issue names, each once, in
 * first-seen order. With the base's `tracked` paths, an outside path that
 * ends in a tracked file (a stack frame `/home/alice/proj/src/a.ts:3`)
 * names that file.
 */
export declare function prescanTerms(input: string, tracked?: ReadonlySet<string>): {
    paths: string[];
    identifiers: string[];
};
/**
 * The absolute paths outside any repository that `text` names as a possible
 * input: a Windows drive or UNC path, `~/`, or a POSIX path under a system or
 * home root. Left out: a location in a stack trace or log (`:line` or
 * `:line:col` after it), an executable or scratch path (BENIGN_OUTSIDE), and,
 * with the base's `tracked` paths, a path ending in a tracked file of two or
 * more segments (a frame of this repository at another checkout). Each once,
 * in first-seen order, at most `max`. Linear, deterministic and free; the
 * implement prompt only counts them.
 */
export declare function outsidePaths(text: string, max?: number, tracked?: ReadonlySet<string>): string[];
/**
 * The likely relevant files of the base commit `sha` for `text` (issue title
 * and plan): at most `maxFiles`, highest score first, ties by path. A path
 * the issue names scores above a file that defines a named identifier, which
 * scores above one that only mentions it. Empty past the time budget; a git
 * failure (a huge tree included) or a failed ignore check rejects.
 */
export declare function likelyRelevantFiles(text: string, sha: string, git: PrescanGit, o?: PrescanOptions): Promise<LikelyFile[]>;
//# sourceMappingURL=prescan.d.ts.map