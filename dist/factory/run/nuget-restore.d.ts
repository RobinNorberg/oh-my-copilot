/**
 * NuGet restore for a dotnet gate (engine.ts ensureLocalGate). Deterministic,
 * no LLM: the classifier reads the error codes NuGet prints, the rest names
 * fixed paths and arguments and writes git blobs.
 *
 * Every dotnet gate first runs offline in the OS sandbox, with the NuGet
 * global packages folder granted read-only. When it fails restoring
 * (classifyNugetFailure), the failure is never a code failure (no ci-fix
 * lane, which has no network and could never fix it): with
 * factory.run.gateInstall "sandboxed" the engine runs `dotnet restore` once
 * per definition hash and head in the OS sandbox with only NUGET_HOSTS
 * reachable, writing new packages into the run's own packages folder
 * (nugetRunPackagesDir; the real cache is the read-only fallback), then runs
 * the gate again offline on that folder; "park" (the default) parks with the
 * reason.
 *
 * The networked restore never runs in the PR's checkout. It runs in the
 * definition tree (writeDefinitionTree): a fresh engine-made dir under the
 * gate job root holding only the head commit's pinned definition files
 * (DOTNET_DEFINITION_PATTERNS), written from git objects and checked
 * against their object ids. A file the PR controls outside those patterns
 * (an imported .msbuild, a script, a .cs, a DLL, the sources) is not there,
 * so nothing but pinned files is evaluated with the network on.
 */
/**
 * One restore error line as MSBuild's console logger prints it, from the
 * restore phase: `<project, solution or MSBuild file> : error NUxxxx: ...`
 * (no `(line,col)`: a compiler diagnostic always has one), with MSBuild's
 * ` [<entry project>]` suffix when the erring project is not the entry one
 * (a real `dotnet restore App.csproj` prints none). The codes say a restore
 * could not get a package, never that the code is wrong: NU1100-NU1103 (no
 * package or version resolved) and the NU1300 series (a source failed:
 * NU1301 cannot load the service index or reach the host, NU1302 an
 * insecure http source, NU1303 and later). A warning (NU1900) is not one.
 */
export declare const NUGET_RESTORE_ERROR: RegExp;
/** The output before the first line that shows the build or the tests started (BUILD_OR_TEST_STARTED): the restore phase. */
export declare function restorePhase(output: string): string;
export interface NugetFailure {
    /** `private-feed`: a source other than nuget.org (a private or local feed) or a feed that wants credentials. */
    kind: 'restore' | 'private-feed';
    /** The NuGet codes seen, sorted. */
    codes: string[];
    /** The sources other than nuget.org named in the errors (urls, local paths or names). */
    sources: string[];
}
/**
 * The NuGet restore failure in a dotnet command's whole output, or null when
 * its restore phase (restorePhase) has no restore error line
 * (NUGET_RESTORE_ERROR): a compile or test failure, a pass, or an `error
 * NU1301` the PR's tests print. Read from the whole output, never a tail:
 * a long output must not hide a real restore error. Private feed signatures
 * (restore phase only): "for source <not nuget.org>", "The local source
 * '<path>'", "in source(s): <a name other than nuget.org>", and a feed's
 * HTTP 401/403 ("Response status code does not indicate success: 401").
 * The sandbox proxy's own refusal ("The proxy tunnel request to proxy ...
 * failed with status code '403'") is not one: that is nuget.org blocked
 * offline. Residual: code the PR's build runs before its first output line
 * (a source generator of the first project compiled) can print a line of
 * the same shape; that starts at most the one networked restore of the
 * pinned definition files per definition hash and head.
 */
export declare function classifyNugetFailure(output: string | undefined): NugetFailure | null;
/**
 * The `dotnet restore` arguments for a dotnet gate's arguments (after the
 * executable): the same projects or solutions (the gate's positionals and
 * its `--project` / `--solution` values), its
 * runtime (`-r`, `--runtime`: a RID-specific restore) and its MSBuild
 * properties (`-p:`, `--property:`, `/p:`). Null when the gate runs no
 * MSBuild (`dotnet test <file>.dll`, a subcommand that does not restore) or
 * names a target outside the repository: the restore runs in the
 * definition tree, which holds only the repository's pinned files.
 * The sandbox runner appends `-m:1`.
 */
export declare function dotnetRestoreArgs(gateArgs: readonly string[]): string[] | null;
/** The run's own NuGet packages folder: `<gate job root>/nuget/<run slug>`, outside every checkout and never your real cache. */
export declare const nugetRunPackagesDir: (gateJobRoot: string, slug: string) => string;
/** The run's definition tree, where the networked restore runs: `<gate job root>/nuget-defs/<run slug>`, outside every checkout. */
export declare const nugetDefinitionTreeDir: (gateJobRoot: string, slug: string) => string;
/** A commit's file as `git ls-tree -r` lists it: [repository path, object id, mode]. */
export type DefinitionEntry = readonly [path: string, oid: string, mode: string];
/**
 * Why a repository path cannot be written as a plain file under the tree
 * on any host, or null: an empty, `.` or `..` segment, a `.git` segment, a
 * `\`, `:` (an NTFS stream), a character Windows refuses, a segment ending
 * in a dot or space (Windows drops them), or a device name.
 */
export declare function unwritableTreePath(path: string): string | null;
/** git's object id of a blob's bytes (`blob <size>\0<bytes>`): SHA-1, or SHA-256 for a 64-hex id. */
export declare function gitBlobId(content: Buffer, oidLength: number): string;
/** The blobs `git cat-file --batch` printed, by object id (a `<oid> missing` line is left out). */
export declare function parseCatFileBatch(buf: Buffer): Map<string, Buffer>;
/**
 * Write the definition tree into `dir` (made here, so it must not exist;
 * its parent must): every entry of the head's tree that is a pinned
 * definition file (DOTNET_DEFINITION_PATTERNS) as a regular file at its
 * repository path, its bytes from `blobs` (git objects, never a checkout's
 * working files) and checked against its object id. A gitlink is skipped;
 * a pattern-matching symlink, a path that cannot be written as a plain
 * file, a blob that is missing or does not hash to its id, or two paths
 * that land on the same file (a case clash) is a problem (nothing is
 * evaluated: the caller parks). `files`: the paths written, sorted.
 */
export declare function writeDefinitionTree(dir: string, entries: readonly DefinitionEntry[], blobs: (oids: string[]) => Map<string, Buffer>): {
    files: string[];
} | {
    problem: string;
};
/**
 * Remove an engine-made dir (the run's packages folder, the definition
 * tree) that must lie under `root` (the gate job root). Refused (throws)
 * when `dir` is a symbolic link or junction (lstat) or not a directory, or
 * when its real path is not below `root`'s real path. Why an unsandboxed
 * recursive removal is safe here: only the sandboxed `dotnet restore`
 * writes inside these dirs, and since it runs on the pinned definition
 * files alone no PR-written code runs in it; sandboxed code cannot create a
 * junction on Windows (refused in the Windows sandbox); and node's rmSync
 * unlinks a link it meets inside the tree rather than following it (checked
 * for junctions and symlinks in nuget-restore.test.ts). The top dir itself
 * is checked here, since rmSync on a link to a dir would empty nothing but
 * is still refused rather than trusted.
 */
export declare function removeEngineDir(dir: string, root: string): boolean;
/**
 * The definition file a failed restore in the definition tree needed but
 * the tree lacks (MSBuild's "The imported project ... was not found", "The
 * project file ... was not found", "Project file does not exist"), as a
 * path relative to the tree, or undefined.
 */
export declare function missingDefinitionFile(output: string, tree: string): string | undefined;
/** The setting and its two values, as the parks name them. */
export declare const GATE_INSTALL_SANDBOXED_HINT = "set factory.run.gateInstall \"sandboxed\" in your user config (the engine then runs dotnet restore in the OS sandbox with only api.nuget.org reachable, on the pinned definition files only, after the gate definition check)";
/** The private-feed park's reason prefix. */
export declare const NUGET_PRIVATE_FEED_UNSUPPORTED = "private or local NuGet feeds are not supported in the sandbox yet";
//# sourceMappingURL=nuget-restore.d.ts.map