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
 * (any case, any depth, outside the checkout's own `.git` and the package
 * trees in `trees`) of `checkout`, except the tracked paths in `keep`
 * (repository paths, `/` separated, as git lists them). `trees` are the
 * `node_modules` dirs the engine itself links or copies there (the root one
 * and the workspace packages' it vouches for, engine.ts engineTrees); an entry
 * not named `node_modules` is ignored. Any other dir named `node_modules` is
 * walked like the rest. A build dir without a kept path under it
 * goes whole. A link (symlink or junction) is unlinked, never followed: at a
 * build dir, under it, or on the way to one (the walk does not descend
 * through a link). A directory outside the build dirs that holds `.git` (a
 * nested repository) is not descended into: the engine's check parks on it.
 * Names compare case-insensitively on Windows.
 */
export declare function cleanDotnetBuildOutput(checkout: string, keep: readonly string[], platform?: NodeJS.Platform, trees?: readonly string[]): DotnetCleanResult;
/**
 * The step's arguments (dotnet-clean-step.ts): a first argument of digits only
 * is the count of package trees that follow; the rest are the kept paths
 * (each under a build dir, so it holds a `/` and is never all digits).
 * Without the count only the root `node_modules` is a tree.
 */
export declare function parseCleanStepArgs(args: readonly string[]): {
    trees: string[];
    keep: string[];
};
//# sourceMappingURL=dotnet-clean.d.ts.map