/**
 * What `dotnet` needs to build and test inside the Copilot OS sandbox, for a
 * factory gate or prepare check whose executable is `dotnet` and for the
 * write lanes of a run whose local gate is one (the caller decides; nothing
 * here looks at repository files, so no PR can switch it on or off).
 *
 * Found by running `dotnet build` / `dotnet test` in the Windows sandbox
 * (Copilot CLI 1.0.107, .NET SDK 10.0.101):
 * - MSBuild's worker nodes (`MSBuild.dll /nodemode:1`) create their named
 *   pipe for the current user only; the parent, an AppContainer process,
 *   gets "Access to the path is denied" connecting to it (MSBUILDDEBUGCOMM
 *   trace), launches node after node, and the leftovers wait 15 minutes for
 *   a connection with the output pipes open: the command hangs. No MSBuild
 *   or dotnet variable lowers the node count (MSBUILDNODELIMITOFFSET does
 *   not), so the command line needs `-m:1` (dotnetSandboxArgs; lanes are told
 *   in their prompt). The compiler server (VBCSCompiler) is reached over a
 *   pipe too: UseSharedCompilation=false compiles in process instead (a
 *   two-project `dotnet test` went from 56 s to 16 s).
 * - With no APPDATA NuGet stops ("Value cannot be null. (Parameter
 *   'path1')"): it points into the job's own profile, so NuGet does not load
 *   your real %APPDATA%\NuGet\NuGet.Config (it can hold private-feed
 *   credentials). On Windows the sandbox cannot deny the file itself (the
 *   "Known gap" in docs/REFERENCE.md); on Linux and macOS sandbox.ts denies
 *   the NuGet config and credential-provider dirs.
 * - NuGet and SourceLink find your profile from the OS, not USERPROFILE: the
 *   global packages folder is granted read-only (and named in
 *   NUGET_PACKAGES), and SourceLink's read of your real ~/.gitconfig, which
 *   the sandbox denies, is switched off (EnableSourceControlManagerQueries,
 *   read by MSBuild as a property from the environment).
 * Not verified on Linux or macOS.
 */
/** True when `exe` (a bare name or a path) is the dotnet host. */
export declare function isDotnetExe(exe: string | undefined): boolean;
/**
 * dotnet subcommands that run MSBuild and pass `-m` to it. Not `run`: it
 * passes an unknown option on to the program (`dotnet run -m:1` gives the
 * program the argument `-m:1`), so a program is built with `dotnet build
 * -m:1` and started with `dotnet run --no-build`.
 */
export declare const MSBUILD_SUBCOMMANDS: readonly string[];
/** The flag every MSBuild-running dotnet command needs in the sandbox (see the module comment). */
export declare const DOTNET_SINGLE_NODE_FLAG = "-m:1";
/**
 * The dotnet arguments with `-m:1` appended (before any `--`) when the
 * subcommand runs MSBuild. Always appended: MSBuild's last switch wins, so
 * an explicit `-m:4` or bare `-m` earlier (which would hang in the sandbox)
 * becomes one node. Not for `dotnet test <file>.dll|.exe` (VSTest, no
 * MSBuild), which rejects `-m:1`.
 */
export declare function dotnetSandboxArgs(args: readonly string[]): string[];
/**
 * The NuGet global packages folder on this host: NUGET_PACKAGES when set to
 * an absolute path, else `<real home>/.nuget/packages`; null when that is
 * not an existing directory. A repository nuget.config's
 * globalPackagesFolder is not read (the sandbox env names this one).
 */
export declare function nugetPackagesDir(env: NodeJS.ProcessEnv, realHome: string): string | null;
/**
 * The variables a sandboxed dotnet needs, for an env whose USERPROFILE is
 * already the job's profile (relocatedProfileEnv), and the paths to grant
 * read-only. `hostEnv` and `realHome` locate the NuGet packages folder.
 */
export declare function dotnetSandboxEnv(profile: string, hostEnv: NodeJS.ProcessEnv, realHome: string, platform?: NodeJS.Platform): {
    env: Record<string, string>;
    readonly: string[];
};
/** True when a sandbox.allowedHosts entry lets NuGet reach nuget.org's feed (`api.nuget.org`, `*.nuget.org`). */
export declare const isNugetHost: (host: string) => boolean;
//# sourceMappingURL=dotnet-sandbox.d.ts.map