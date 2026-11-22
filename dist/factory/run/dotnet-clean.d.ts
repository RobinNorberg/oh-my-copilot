/** The directory names (any case) whose untracked content is build output a dotnet gate starts without. */
export declare const DOTNET_BUILD_DIRS: ReadonlySet<string>;
export interface DotnetCleanResult {
    /** Entries removed (a whole build dir counts once). */
    removed: number;
    /** `<repository path>: <message>` for each entry that could not be removed. */
    errors: string[];
}
/**
 * Remove every entry under each directory named `bin`, `obj` or `artifacts`
 * (any case, any depth, outside `node_modules` and the checkout's own `.git`)
 * of `checkout`, except the tracked paths in `keep` (repository paths, `/`
 * separated, as git lists them). A build dir without a kept path under it
 * goes whole. A link (symlink or junction) is unlinked, never followed: at a
 * build dir, under it, or on the way to one (the walk does not descend
 * through a link). A directory outside the build dirs that holds `.git` (a
 * nested repository) is not descended into: the engine's check parks on it.
 * Names compare case-insensitively on Windows.
 */
export declare function cleanDotnetBuildOutput(checkout: string, keep: readonly string[], platform?: NodeJS.Platform): DotnetCleanResult;
//# sourceMappingURL=dotnet-clean.d.ts.map