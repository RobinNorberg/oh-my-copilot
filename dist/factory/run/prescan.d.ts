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
 * tree entries, bytes read and wall time; any git failure yields no list.
 */
/** One likely relevant file: a repo path and why it was picked (never file contents). */
export interface LikelyFile {
    path: string;
    reason: string;
}
/** Host git in the repository that holds the base commit (hardened, replace objects off); stdout as bytes. */
export type PrescanGit = (args: readonly string[], input?: Buffer) => Buffer;
export interface PrescanOptions {
    /** The most paths listed (default 8). */
    maxFiles?: number;
    /** A file larger than this is never read (default 200 KB). */
    maxFileBytes?: number;
    /** The content phase stops after reading this many bytes in all (default 8 MB). */
    maxTotalBytes?: number;
    /** A tree with more entries gets path matches only, no content phase (default 50,000). */
    maxTreeEntries?: number;
    /** The content phase stops after this many milliseconds (default 2,000). */
    budgetMs?: number;
    /** The clock (tests). */
    now?: () => number;
    /** The candidate paths a .gitignore excludes; a throw drops every candidate. */
    ignored?: (paths: readonly string[]) => ReadonlySet<string>;
}
/** The repo paths and code identifiers an issue names, each once, in first-seen order. */
export declare function prescanTerms(input: string): {
    paths: string[];
    identifiers: string[];
};
/**
 * The absolute paths outside any repository that `text` names: a Windows
 * drive or UNC path, `~/`, or a POSIX path under a system or home root.
 * Each once, in first-seen order, at most 5. Deterministic and free; the
 * implement prompt only counts them.
 */
export declare function outsidePaths(text: string, max?: number): string[];
/**
 * The likely relevant files of the base commit `sha` for `text` (issue title
 * and plan): at most `maxFiles`, highest score first, ties by path. A path
 * the issue names scores above a file that defines a named identifier, which
 * scores above one that only mentions it. Empty on any git failure.
 */
export declare function likelyRelevantFiles(text: string, sha: string, git: PrescanGit, o?: PrescanOptions): LikelyFile[];
//# sourceMappingURL=prescan.d.ts.map