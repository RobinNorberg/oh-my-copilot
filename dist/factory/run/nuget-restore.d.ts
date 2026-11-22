/**
 * NuGet restore for a dotnet gate (engine.ts ensureLocalGate). Deterministic,
 * no LLM, no network: the classifier reads the error codes NuGet prints, the
 * rest names fixed paths and arguments.
 *
 * Every dotnet gate first runs offline in the OS sandbox, with the NuGet
 * global packages folder granted read-only. When it fails restoring
 * (classifyNugetFailure), the failure is never a code failure (no ci-fix
 * lane, which has no network and could never fix it): with
 * factory.run.gateInstall "sandboxed" the engine runs `dotnet restore` once
 * per head in the OS sandbox with only NUGET_HOSTS reachable, writing new
 * packages into the run's own packages folder (nugetRunPackagesDir; the
 * real cache is the read-only fallback), then runs the gate again offline
 * on that folder; "park" (the default) parks with the reason.
 */
/**
 * The NuGet error codes that say a restore could not get a package, never
 * that the code is wrong: NU1100-NU1103 (no package or version resolved:
 * NU1100 unable to resolve, NU1101 no such id, NU1102 no such version,
 * NU1103 only prereleases) and the NU1300 series (a source failed: NU1301
 * cannot load the service index or reach the host, NU1302 an insecure http
 * source, NU1303 and later source errors). Only as `error NUxxxx`: a warning
 * (NU1900, audit without the feed) is not a failure.
 */
export declare const NUGET_RESTORE_ERROR: RegExp;
export interface NugetFailure {
    /** `private-feed`: a source other than nuget.org (a private or local feed) or a feed that wants credentials. */
    kind: 'restore' | 'private-feed';
    /** The NuGet codes seen, sorted. */
    codes: string[];
    /** The sources other than nuget.org named in the errors (urls, local paths or names). */
    sources: string[];
}
/**
 * The NuGet restore failure in a dotnet command's output, or null when the
 * output has no NuGet restore error (a compile or test failure, a pass).
 * Private feed signatures: "for source <not nuget.org>", "The local source
 * '<path>'", "in source(s): <a name other than nuget.org>", and a feed's
 * HTTP 401/403 ("Response status code does not indicate success: 401").
 * The sandbox proxy's own refusal ("The proxy tunnel request to proxy ...
 * failed with status code '403'") is not one: that is nuget.org blocked
 * offline.
 */
export declare function classifyNugetFailure(output: string | undefined): NugetFailure | null;
/**
 * The `dotnet restore` arguments for a dotnet gate's arguments (after the
 * executable): the same projects or solutions (the gate's positionals and
 * its `--project` / `--solution` values), its
 * runtime (`-r`, `--runtime`: a RID-specific restore) and its MSBuild
 * properties (`-p:`, `--property:`, `/p:`). Null when the gate runs no
 * MSBuild (`dotnet test <file>.dll`, a subcommand that does not restore).
 * The sandbox runner appends `-m:1`.
 */
export declare function dotnetRestoreArgs(gateArgs: readonly string[]): string[] | null;
/** The run's own NuGet packages folder: `<gate job root>/nuget/<run slug>`, outside every checkout and never your real cache. */
export declare const nugetRunPackagesDir: (gateJobRoot: string, slug: string) => string;
/** The setting and its two values, as the parks name them. */
export declare const GATE_INSTALL_SANDBOXED_HINT = "set factory.run.gateInstall \"sandboxed\" in your user config (the engine then runs dotnet restore in the OS sandbox with only api.nuget.org reachable, after the gate definition check)";
/** The private-feed park's reason prefix. */
export declare const NUGET_PRIVATE_FEED_UNSUPPORTED = "private or local NuGet feeds are not supported in the sandbox yet";
//# sourceMappingURL=nuget-restore.d.ts.map