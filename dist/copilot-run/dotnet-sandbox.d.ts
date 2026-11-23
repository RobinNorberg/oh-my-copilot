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
 *   names one file instead (dotnetNugetConfig), and nuget.org is added only
 *   when that file plainly defines no package-source policy at all
 *   (nugetConfigVerdict): the engine never widens a repository's sources.
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
/** rootNugetConfig's answer: the file, none, or a reason the engine cannot tell which file NuGet reads there. */
export type RootNugetConfig = {
    file: string;
} | {
    none: true;
} | {
    ambiguous: string;
};
/**
 * The NuGet config file at the root of `dir` (the checkout, worktree or
 * definition tree a dotnet command runs in), as NuGet finds it there
 * (NuGet.Configuration Settings: on a case-insensitive file system it
 * probes `NuGet.Config`, which opens a file of that name in any case; on a
 * case-sensitive one it probes NUGET_CONFIG_NAMES in order; a directory of
 * that name does not exist for it). The candidates are the entries of `dir`
 * named `nuget.config` in any case that are not directories (lstat): none
 * is `none`; one is the file, except on Linux when its name is not one of
 * NUGET_CONFIG_NAMES (NuGet never probes `NUGET.CONFIG` there: `none`).
 * `ambiguous` (the caller then keeps NuGet's own hierarchy rather than
 * guess) for two or more candidates (two names that differ in case), a
 * candidate that is a symbolic link, or on macOS a name outside
 * NUGET_CONFIG_NAMES (whether NuGet opens it depends on the volume's case
 * sensitivity). Only names are read here (readdir, lstat).
 */
export declare function rootNugetConfig(dir: string, platform?: NodeJS.Platform): RootNugetConfig;
/** nuget.org's feed, as NuGet's default user config names it. */
export declare const NUGET_ORG_SOURCE = "https://api.nuget.org/v3/index.json";
/**
 * The NuGet config a sandboxed dotnet reads (dotnetNugetConfig): one file
 * (RestoreConfigFile), or NuGet's own hierarchy (`hierarchy`: why the engine
 * does not name one file).
 */
export type DotnetNugetConfig = {
    file: string;
    addNugetOrg: boolean;
} | {
    hierarchy: string;
};
/** Above this size a root nuget.config is not read for nugetConfigVerdict (nuget.org is then not added). */
export declare const NUGET_CONFIG_READ_MAX: number;
/** What nugetConfigVerdict says about one root nuget.config. */
export interface NugetConfigVerdict {
    /** The file plainly defines no package-source policy at all: NuGet, reading it with its default user config behind it, uses nuget.org, so it may be added. */
    addNugetOrg: boolean;
    /** Why nuget.org is not added (absent when it is). */
    why?: string;
    /** The raw text names `nuget.org` (any case): a restore that misses packages without it is not the file's omission. */
    namesNugetOrg: boolean;
    /**
     * `packageSourceMapping` keys (`<packageSource key>`) that no
     * `packageSources/add key` of the file defines, when the file does not
     * clear its sources: such a key names a source of another config (most
     * often the user config's `nuget.org`), so the file alone is not what
     * NuGet reads for this repository.
     */
    unmappedKeys: string[];
}
/**
 * Whether the engine may add nuget.org for a repository whose root
 * nuget.config is `bytes`, read alone (RestoreConfigFile). NuGet with its
 * hierarchy would merge the default user config (nuget.org) behind the
 * file; with one file it does not. Safe by construction, not by listing the
 * shapes that remove nuget.org: `addNugetOrg` only when the file plainly
 * defines no package-source policy at all, that is ALL of: at most
 * NUGET_CONFIG_READ_MAX bytes; no UTF-16 or UTF-32 byte order mark, no NUL
 * byte, valid UTF-8 (a UTF-8 BOM is fine); its whole raw text, compared in
 * any case, holds none of SOURCE_POLICY_WORDS and no `<?` other than one
 * leading `<?xml ...?>` declaration; no tag or attribute name holds `:` or a
 * character outside ASCII and no attribute is `xmlns`; and the linear
 * scanner (xml-scan.ts) reads it as well-formed with the one root element
 * `configuration`. Any doubt: nothing is added, and NuGet uses exactly what
 * that one file says (a restore that needed nuget.org fails or parks).
 * `unmappedKeys` keeps its own, separate reading (dotnetNugetConfig).
 */
export declare function nugetConfigVerdict(bytes: Buffer): NugetConfigVerdict;
/**
 * The bytes of the regular file `path`, at most `max`, or null: lstat
 * first (a link, directory, FIFO or device is not opened), then the file
 * opened with O_NOFOLLOW and O_NONBLOCK where the platform has them, which
 * must be that same file (dev and inode, compared as bigints), still a
 * regular file within `max`; read from that descriptor, so a file swapped
 * in after the lstat is never read.
 */
export declare function readRegularFileBounded(path: string, max: number): Buffer | null;
/**
 * A value for an MSBuild property set from the environment: MSBuild
 * unescapes `%XX` in it and expands `@(...)` (checked with .NET SDK
 * 10.0.101: `RestoreConfigFile` in a dir named `p%41` read `pA`, `p@(x)`
 * read `p`), so `%`, `$`, `@`, `'`, `;`, `?` and `*` are written `%XX`.
 * A `;` stays a separator for NuGet's targets even escaped
 * (dotnetNugetConfig never names a path with one).
 */
export declare const msbuildEscape: (value: string) => string;
/**
 * The NuGet config a sandboxed dotnet in `cwd` reads (dotnetSandboxEnv).
 * Why one file: NuGet otherwise reads every nuget.config from the project's
 * dir up to the drive root (a `<clear />` only resets what was merged; the
 * files are still read), and in the shared layout that walk reaches your
 * working tree's own `nuget.config` (or one in a dir above your
 * repository), which the Windows sandbox refuses to read: "Failed to read
 * NuGet.Config due to unauthorized access" fails every restore. With
 * RestoreConfigFile NuGet's restore reads that file alone (checked with
 * .NET SDK 10.0.101 for `dotnet restore`, `build` and `test`; NuGet's
 * RestoreTask still reads or creates the relocated profile's user config,
 * which adds no source, and the MSBuild project SDK resolver, `dotnet tool
 * restore`, `dotnet nuget` and `dotnet workload` ignore the property).
 * The file: the root config of `cwd` (rootNugetConfig), with nuget.org
 * added only when nugetConfigVerdict finds no package-source policy in it
 * at all and `noAdd` (engine.ts: a pinned MSBuild file
 * sets restore sources itself) is not set; or, with no root config,
 * NUGET_ORG_ONLY_CONFIG written to `<profile>/nuget/nuget.config`, the
 * command's own job profile (never inside the checkout). `hierarchy`
 * instead (NuGet's own walk, as before one file was named: faithful, and
 * in the shared layout it parks at the first unreadable config) when the
 * engine cannot tell which root file NuGet reads (rootNugetConfig
 * `ambiguous`), when the root file maps packages to a source key it does
 * not define (nugetConfigVerdict `unmappedKeys`: the file alone would leave
 * that source out), or when the path holds a `;`, which MSBuild splits.
 */
export declare function dotnetNugetConfig(cwd: string, profile: string, platform?: NodeJS.Platform, o?: {
    noAdd?: boolean;
}): DotnetNugetConfig;
/** True when a sandbox.allowedHosts entry lets NuGet reach nuget.org's feed (`api.nuget.org`, `*.nuget.org`). */
export declare const isNugetHost: (host: string) => boolean;
//# sourceMappingURL=dotnet-sandbox.d.ts.map