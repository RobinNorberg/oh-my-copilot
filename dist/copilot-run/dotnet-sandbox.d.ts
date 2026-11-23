/**
 * What `dotnet` needs to build and test inside the Copilot OS sandbox, for a
 * factory gate or prepare check whose executable is `dotnet` and for the
 * write lanes of a .NET repository (the caller decides, from trusted config
 * and the trusted base commit only: engine.ts dotnetRepo; nothing here looks
 * at repository files, so no PR can switch it on or off).
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
 * - NuGet reads every nuget.config from the project's dir up to the drive
 *   root; from a checkout under `<repo>/.omg/` (the shared layout) that
 *   reaches your working tree's own file, which the sandbox refuses ("Failed
 *   to read NuGet.Config due to unauthorized access"): RestoreConfigFile
 *   names one file instead (dotnetNugetConfig).
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
/** Per subcommand, the dotnet options whose value names a file, project or directory the command reads (dotnet test: -a is --test-adapter-path). */
export declare const DOTNET_PATH_OPTIONS: Record<string, ReadonlySet<string>>;
/** Per subcommand, the options that take the next argument as a value that names no repository file (dotnet build: -a is --arch, -s is --source). */
export declare const DOTNET_VALUE_OPTIONS: Record<string, ReadonlySet<string>>;
/**
 * The positional arguments of a dotnet command line (before any `--`):
 * the words that are not options and not the value of an option that takes
 * the next word (DOTNET_PATH_OPTIONS, DOTNET_VALUE_OPTIONS of `sub`; an
 * option written `--x=v` or `--x:v` carries its own value).
 */
export declare function dotnetPositionals(sub: string, args: readonly string[]): string[];
/**
 * The SDK pin says `dotnet test` runs Microsoft.Testing.Platform (MTP)
 * instead of VSTest: `global.json` `{"test": {"runner": "Microsoft.Testing.Platform"}}`.
 * In that mode `dotnet test` rejects MSBuild's `-m` ("Unknown option '--m'").
 * A `dotnet.config` `[dotnet.test.runner]` section is not read: .NET SDK
 * 10.0.101 ignores it (VSTest runs), so `-m:1` stays right there.
 */
export declare function isMtpGlobalJson(text: string | undefined): boolean;
/**
 * Why the engine parks a `dotnet test` gate in a Microsoft.Testing.Platform
 * repository before it runs in the OS sandbox: in the Windows sandbox the
 * test app's named pipe back to `dotnet test` is denied
 * (UnauthorizedAccessException in NamedPipeClient.ConnectAsync, exit 1,
 * zero tests run). The test app started on its own (`dotnet run --project
 * <tests> --no-build` after `dotnet build -m:1`) runs and reports in the
 * sandbox.
 */
export declare const DOTNET_MTP_UNSUPPORTED = "Microsoft.Testing.Platform test gates are not supported in the sandbox yet";
/**
 * The dotnet arguments with `-m:1` appended (before any `--`) when the
 * subcommand runs MSBuild. Always appended: MSBuild's last switch wins, so
 * an explicit `-m:4` or bare `-m` earlier (which would hang in the sandbox)
 * becomes one node. Not for `dotnet test <file>.dll|.exe` (VSTest, no
 * MSBuild; an option's value such as `--diag log.exe` is not one), which
 * rejects `-m:1`, and not for `dotnet test` in Microsoft.Testing.Platform
 * mode (`mtp`, isMtpGlobalJson of the trusted base), which rejects it too.
 */
export declare function dotnetSandboxArgs(args: readonly string[], o?: {
    mtp?: boolean;
}): string[];
/**
 * The NuGet global packages folder on this host: NUGET_PACKAGES when set to
 * an absolute path, else `<real home>/.nuget/packages`; null when that is
 * not an existing directory. A repository nuget.config's
 * globalPackagesFolder is not read (the sandbox env names this one).
 */
export declare function nugetPackagesDir(env: NodeJS.ProcessEnv, realHome: string): string | null;
/**
 * nugetPackagesDir with why a NUGET_PACKAGES folder is refused (`note`, one
 * line the caller surfaces; `dir` null, nothing granted): the home dir, an
 * ancestor of it, a filesystem root, or a dir inside or above an OMC config
 * or state root (`protectedRoots`). Granting one of those read-only would
 * open your profile or the engine's state to the PR's code.
 */
export declare function nugetPackagesGrant(env: NodeJS.ProcessEnv, realHome: string, protectedRoots?: readonly string[], platform?: NodeJS.Platform): {
    dir: string | null;
    note?: string;
};
/**
 * A factory run's own NuGet packages folder (engine-made, outside every
 * checkout; factory/run/nuget-restore.ts): the dotnet restore step writes
 * new packages there (`writable`), every other dotnet command of the run
 * reads it.
 */
export interface RunNugetPackages {
    dir: string;
    writable: boolean;
}
/**
 * The variables a sandboxed dotnet needs, for an env whose USERPROFILE is
 * already the job's profile (relocatedProfileEnv), and the paths to grant
 * read-only. `hostEnv` and `realHome` locate the NuGet packages folder;
 * `notes` say why it was refused (nugetPackagesGrant). With `run` (a
 * factory run's own packages folder, RunNugetPackages) NUGET_PACKAGES names
 * that folder and the real one becomes NUGET_FALLBACK_PACKAGES, still
 * read-only: NuGet writes a new package only into its global packages
 * folder, so the real cache is never written (a read-only grant could not
 * take one anyway); `readwrite` holds the run's folder when it is writable.
 */
export declare function dotnetSandboxEnv(profile: string, hostEnv: NodeJS.ProcessEnv, realHome: string, platform?: NodeJS.Platform, run?: RunNugetPackages, nugetConfig?: DotnetNugetConfig): {
    env: Record<string, string>;
    readonly: string[];
    readwrite: string[];
    notes: string[];
};
/**
 * The NuGet config a sandboxed dotnet reads when its working dir's root has
 * none: nuget.org as the only source, with every source, disabled source
 * and source mapping cleared (a config named alone needs no `<clear />`;
 * the clears keep the file right where it is merged, as the definition
 * tree's stub, nuget-restore.ts). Checked with .NET SDK 10.0.101: a project
 * restores the same packages with it as with the default config (only
 * Visual Studio's machine-wide offline folder goes, whose packages are
 * nuget.org's).
 */
export declare const NUGET_ORG_ONLY_CONFIG: string;
/** The names NuGet looks for in a directory, in its order (case-sensitive file systems). */
export declare const NUGET_CONFIG_NAMES: readonly string[];
/**
 * The NuGet config file at the root of `dir` (the checkout, worktree or
 * definition tree a dotnet command runs in), as NuGet would find it there:
 * the first of NUGET_CONFIG_NAMES that is an entry of `dir`, compared
 * without case on Windows and macOS (their file systems open it so), and
 * not a directory. Null when there is none. Only its name is read here
 * (readdir, lstat): NuGet reads the file itself, in the sandbox.
 */
export declare function rootNugetConfig(dir: string, platform?: NodeJS.Platform): string | null;
/** nuget.org's feed, as NuGet's default user config names it. */
export declare const NUGET_ORG_SOURCE = "https://api.nuget.org/v3/index.json";
/** The one NuGet config file a sandboxed dotnet reads (dotnetNugetConfig). */
export interface DotnetNugetConfig {
    /** RestoreConfigFile: an absolute path. */
    file: string;
    /** RestoreAdditionalProjectSources gets nuget.org (nugetOrgImplied). */
    addNugetOrg: boolean;
}
/**
 * True when NuGet, reading `text` (a repository's root nuget.config) with
 * your user config behind it, would also use nuget.org from the user
 * config: the file's `<packageSources>` has no `<clear />`, lists no
 * nuget.org feed itself, and its `<disabledPackageSources>` does not
 * disable the source named `nuget.org`. NuGet reads one file in the sandbox
 * (RestoreConfigFile), so that nuget.org has to be added
 * (RestoreAdditionalProjectSources): without it such a file has no source
 * at all, and NuGet then quietly takes a higher version from the packages
 * folder (NU1603, a warning) instead of failing offline. XML comments are
 * dropped first; NuGet's element and attribute names are case-sensitive.
 */
export declare function nugetOrgImplied(text: string): boolean;
/**
 * The one NuGet config a sandboxed dotnet in `cwd` reads (RestoreConfigFile,
 * dotnetSandboxEnv): the root config of `cwd` (rootNugetConfig), with
 * nuget.org added when NuGet would take it from your user config there
 * (nugetOrgImplied; the file is read only when lstat says it is a regular
 * file of at most 1 MB, else nothing is added), or else
 * NUGET_ORG_ONLY_CONFIG written to `<profile>/nuget/nuget.config`, the
 * command's own job profile (never inside the checkout). Why: NuGet
 * otherwise reads every nuget.config from the project's dir up to the
 * drive root (a `<clear />` only resets what was merged; the files are
 * still read), and in the shared layout that walk reaches your working
 * tree's own `nuget.config` (or one in a dir above your repository), which
 * the Windows sandbox refuses to read: "Failed to read NuGet.Config due to
 * unauthorized access" fails every restore. With RestoreConfigFile NuGet
 * reads that file alone: no other nuget.config of the repository, no user
 * config, no machine-wide config (checked with .NET SDK 10.0.101 for
 * `dotnet restore`, `build` and `test`).
 */
export declare function dotnetNugetConfig(cwd: string, profile: string, platform?: NodeJS.Platform): DotnetNugetConfig;
/** True when a sandbox.allowedHosts entry lets NuGet reach nuget.org's feed (`api.nuget.org`, `*.nuget.org`). */
export declare const isNugetHost: (host: string) => boolean;
//# sourceMappingURL=dotnet-sandbox.d.ts.map