/** The directory names (any case) whose untracked content is build output a dotnet gate starts without. */
export declare const DOTNET_BUILD_DIRS: ReadonlySet<string>;
/**
 * The two path-segment tests the clean step's walk and the engine's checks
 * (local-gate.ts dotnetBuildDirIndex) share, so both sides fold a name the
 * same way: any case, on every platform. A build dir's untracked content is
 * removed; a package tree (`node_modules`, whoever installed it: the engine,
 * a sandboxed `npm ci`, a trusted prepare build) is never entered, and the
 * engine's checks leave paths under one out the same way.
 */
export declare const isDotnetBuildDirName: (name: string) => boolean;
export declare const isPackageTreeName: (name: string) => boolean;
export interface DotnetCleanResult {
    /** Entries removed (a whole build dir counts once). */
    removed: number;
    /** `<repository path>: <message>` for each entry that could not be removed. */
    errors: string[];
}
/**
 * Remove every entry under each directory named `bin`, `obj` or `artifacts`
 * (any case, any depth, outside every `node_modules` dir and the checkout's
 * own `.git`) of `checkout`, except the tracked paths in `keep` (repository
 * paths, `/` separated, as git lists them). A `node_modules` dir on the way
 * to a build dir is never entered (isPackageTreeName); one inside a build dir
 * is build output like the rest. A build dir without a kept path under it
 * goes whole. A link (symlink or junction) is unlinked, never followed: at a
 * build dir, under it, or on the way to one (the walk does not descend
 * through a link). A directory outside the build dirs that holds `.git` (a
 * nested repository) is not descended into: the engine's check parks on it.
 * Kept paths compare case-insensitively where the file system usually does
 * (Windows, macOS).
 */
export declare function cleanDotnetBuildOutput(checkout: string, keep: readonly string[], platform?: NodeJS.Platform): DotnetCleanResult;
//# sourceMappingURL=dotnet-clean.d.ts.map