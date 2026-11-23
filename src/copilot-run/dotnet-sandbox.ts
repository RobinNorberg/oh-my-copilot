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

import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseJsonc } from '../utils/jsonc.js';
import { getGlobalOmcConfigRoot, getGlobalOmcStateRoot } from '../utils/paths.js';

/** True when `exe` (a bare name or a path) is the dotnet host. */
export function isDotnetExe(exe: string | undefined): boolean {
  if (!exe) return false;
  const base = (exe.split(/[\\/]/).pop() ?? exe).toLowerCase();
  return base === 'dotnet' || base === 'dotnet.exe';
}

/**
 * dotnet subcommands that run MSBuild and pass `-m` to it. Not `run`: it
 * passes an unknown option on to the program (`dotnet run -m:1` gives the
 * program the argument `-m:1`), so a program is built with `dotnet build
 * -m:1` and started with `dotnet run --no-build`.
 */
export const MSBUILD_SUBCOMMANDS: readonly string[] = ['build', 'test', 'restore', 'pack', 'publish', 'clean', 'msbuild'];

/** The flag every MSBuild-running dotnet command needs in the sandbox (see the module comment). */
export const DOTNET_SINGLE_NODE_FLAG = '-m:1';

/** Per subcommand, the dotnet options whose value names a file, project or directory the command reads (dotnet test: -a is --test-adapter-path). */
export const DOTNET_PATH_OPTIONS: Record<string, ReadonlySet<string>> = {
  build: new Set(['--project', '--solution']),
  test: new Set(['--settings', '-s', '--project', '--solution', '--test-adapter-path', '-a']),
};
const DOTNET_COMMON_VALUE_OPTIONS = ['-c', '--configuration', '-f', '--framework', '-r', '--runtime', '-o', '--output', '-v', '--verbosity', '--arch', '--os', '--version-suffix'];
/** Per subcommand, the options that take the next argument as a value that names no repository file (dotnet build: -a is --arch, -s is --source). */
export const DOTNET_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
  build: new Set([...DOTNET_COMMON_VALUE_OPTIONS, '-a', '-s', '--source']),
  test: new Set([...DOTNET_COMMON_VALUE_OPTIONS, '--filter', '-l', '--logger', '--collect', '--results-directory', '-d', '--diag', '-e', '--environment', '--blame-hang-timeout', '--blame-crash-dump-type', '--blame-hang-dump-type']),
};

/**
 * The positional arguments of a dotnet command line (before any `--`):
 * the words that are not options and not the value of an option that takes
 * the next word (DOTNET_PATH_OPTIONS, DOTNET_VALUE_OPTIONS of `sub`; an
 * option written `--x=v` or `--x:v` carries its own value).
 */
export function dotnetPositionals(sub: string, args: readonly string[]): string[] {
  const takesValue = (flag: string) => !!DOTNET_PATH_OPTIONS[sub]?.has(flag) || !!DOTNET_VALUE_OPTIONS[sub]?.has(flag);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (!a.startsWith('-')) out.push(a);
    else if (!/[=:]/.test(a) && takesValue(a)) i++;
  }
  return out;
}

/**
 * The SDK pin says `dotnet test` runs Microsoft.Testing.Platform (MTP)
 * instead of VSTest: `global.json` `{"test": {"runner": "Microsoft.Testing.Platform"}}`.
 * In that mode `dotnet test` rejects MSBuild's `-m` ("Unknown option '--m'").
 * A `dotnet.config` `[dotnet.test.runner]` section is not read: .NET SDK
 * 10.0.101 ignores it (VSTest runs), so `-m:1` stays right there.
 */
export function isMtpGlobalJson(text: string | undefined): boolean {
  if (!text) return false;
  try {
    // global.json allows comments.
    const json = parseJsonc(text) as { test?: { runner?: unknown } } | null;
    return typeof json?.test?.runner === 'string' && json.test.runner.trim().toLowerCase() === 'microsoft.testing.platform';
  } catch {
    return false;
  }
}

/**
 * Why the engine parks a `dotnet test` gate in a Microsoft.Testing.Platform
 * repository before it runs in the OS sandbox: in the Windows sandbox the
 * test app's named pipe back to `dotnet test` is denied
 * (UnauthorizedAccessException in NamedPipeClient.ConnectAsync, exit 1,
 * zero tests run). The test app started on its own (`dotnet run --project
 * <tests> --no-build` after `dotnet build -m:1`) runs and reports in the
 * sandbox.
 */
export const DOTNET_MTP_UNSUPPORTED = 'Microsoft.Testing.Platform test gates are not supported in the sandbox yet';

/**
 * The dotnet arguments with `-m:1` appended (before any `--`) when the
 * subcommand runs MSBuild. Always appended: MSBuild's last switch wins, so
 * an explicit `-m:4` or bare `-m` earlier (which would hang in the sandbox)
 * becomes one node. Not for `dotnet test <file>.dll|.exe` (VSTest, no
 * MSBuild; an option's value such as `--diag log.exe` is not one), which
 * rejects `-m:1`, and not for `dotnet test` in Microsoft.Testing.Platform
 * mode (`mtp`, isMtpGlobalJson of the trusted base), which rejects it too.
 */
export function dotnetSandboxArgs(args: readonly string[], o: { mtp?: boolean } = {}): string[] {
  const sub = args[0]?.toLowerCase();
  if (!sub || !MSBUILD_SUBCOMMANDS.includes(sub)) return [...args];
  if (sub === 'test' && (o.mtp || dotnetPositionals(sub, args.slice(1)).some((a) => /\.(?:dll|exe)$/i.test(a)))) return [...args];
  const end = args.indexOf('--');
  return end < 0 ? [...args, DOTNET_SINGLE_NODE_FLAG] : [...args.slice(0, end), DOTNET_SINGLE_NODE_FLAG, ...args.slice(end)];
}

/**
 * The NuGet global packages folder on this host: NUGET_PACKAGES when set to
 * an absolute path, else `<real home>/.nuget/packages`; null when that is
 * not an existing directory. A repository nuget.config's
 * globalPackagesFolder is not read (the sandbox env names this one).
 */
export function nugetPackagesDir(env: NodeJS.ProcessEnv, realHome: string): string | null {
  return nugetPackagesGrant(env, realHome).dir;
}

/** The OMC config and state roots a NUGET_PACKAGES grant may not overlap (defaults: this process's). */
const omcRoots = (realHome: string): string[] => [getGlobalOmcConfigRoot(), getGlobalOmcStateRoot(), join(realHome, '.omg')];

/**
 * nugetPackagesDir with why a NUGET_PACKAGES folder is refused (`note`, one
 * line the caller surfaces; `dir` null, nothing granted): the home dir, an
 * ancestor of it, a filesystem root, or a dir inside or above an OMC config
 * or state root (`protectedRoots`). Granting one of those read-only would
 * open your profile or the engine's state to the PR's code.
 */
export function nugetPackagesGrant(env: NodeJS.ProcessEnv, realHome: string, protectedRoots: readonly string[] = omcRoots(realHome), platform: NodeJS.Platform = process.platform): { dir: string | null; note?: string } {
  const fromEnv = Object.entries(env).find(([k]) => k.toUpperCase() === 'NUGET_PACKAGES')?.[1]?.trim();
  const dir = fromEnv && isAbsolute(fromEnv) ? resolve(fromEnv) : join(realHome, '.nuget', 'packages');
  if (fromEnv && isAbsolute(fromEnv)) {
    const fold = (p: string) => (platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
    // `a` is `b` or inside it.
    const within = (a: string, b: string) => { const r = relative(fold(b), fold(a)); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
    const why = dirname(dir) === dir ? 'a filesystem root'
      : within(realHome, dir) ? 'your home dir or a dir above it'
        : protectedRoots.some((r) => within(dir, r) || within(r, dir)) ? 'inside or above the OMC config or state dir'
          : null;
    if (why) return { dir: null, note: `NUGET_PACKAGES (${dir}) is ${why}, so it is not granted to the sandbox: dotnet restores nothing offline there; point NUGET_PACKAGES at a dir of its own` };
  }
  try {
    return { dir: statSync(dir).isDirectory() ? dir : null };
  } catch {
    return { dir: null };
  }
}

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
export function dotnetSandboxEnv(profile: string, hostEnv: NodeJS.ProcessEnv, realHome: string, platform: NodeJS.Platform = process.platform, run?: RunNugetPackages, nugetConfig?: DotnetNugetConfig): { env: Record<string, string>; readonly: string[]; readwrite: string[]; notes: string[] } {
  const grant = nugetPackagesGrant(hostEnv, realHome, omcRoots(realHome), platform);
  const packages = grant.dir;
  const runDir = run ? resolve(run.dir) : null;
  const nuget = runDir ? { NUGET_PACKAGES: runDir, ...(packages ? { NUGET_FALLBACK_PACKAGES: packages } : {}) } : packages ? { NUGET_PACKAGES: packages } : {};
  return {
    notes: grant.note ? [grant.note] : [],
    env: {
      // NuGet's user config dir: the job's empty profile, never the real %APPDATA%\NuGet.
      ...(platform === 'win32' ? { APPDATA: join(resolve(profile), 'AppData', 'Roaming') } : {}),
      ...nuget,
      DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      DOTNET_NOLOGO: '1',
      // The MSBuild server and reused nodes talk over the same pipes the sandbox blocks.
      DOTNET_CLI_USE_MSBUILD_SERVER: '0',
      MSBUILDDISABLENODEREUSE: '1',
      // MSBuild properties from the environment: no compiler server, no SourceLink git read.
      UseSharedCompilation: 'false',
      EnableSourceControlManagerQueries: 'false',
      // One NuGet config file instead of the walk up to the drive root (dotnetNugetConfig), plus the nuget.org your
      // user config would add when that file does not clear its sources.
      ...(nugetConfig ? { RestoreConfigFile: nugetConfig.file, ...(nugetConfig.addNugetOrg ? { RestoreAdditionalProjectSources: NUGET_ORG_SOURCE } : {}) } : {}),
    },
    readonly: [...(packages ? [packages] : []), ...(runDir && !run!.writable ? [runDir] : [])],
    readwrite: runDir && run!.writable ? [runDir] : [],
  };
}

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
export const NUGET_ORG_ONLY_CONFIG = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<configuration>',
  '  <packageSources>',
  '    <clear />',
  '    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" protocolVersion="3" />',
  '  </packageSources>',
  '  <disabledPackageSources>',
  '    <clear />',
  '  </disabledPackageSources>',
  '  <packageSourceMapping>',
  '    <clear />',
  '  </packageSourceMapping>',
  '</configuration>',
  '',
].join('\n');

/** The names NuGet looks for in a directory, in its order (case-sensitive file systems). */
export const NUGET_CONFIG_NAMES: readonly string[] = ['nuget.config', 'NuGet.config', 'NuGet.Config'];

/**
 * The NuGet config file at the root of `dir` (the checkout, worktree or
 * definition tree a dotnet command runs in), as NuGet would find it there:
 * the first of NUGET_CONFIG_NAMES that is an entry of `dir`, compared
 * without case on Windows and macOS (their file systems open it so), and
 * not a directory. Null when there is none. Only its name is read here
 * (readdir, lstat): NuGet reads the file itself, in the sandbox.
 */
export function rootNugetConfig(dir: string, platform: NodeJS.Platform = process.platform): string | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const fold = platform === 'win32' || platform === 'darwin';
  for (const want of NUGET_CONFIG_NAMES) {
    const hit = names.find((n) => (fold ? n.toLowerCase() === want.toLowerCase() : n === want));
    if (!hit) continue;
    try {
      if (!lstatSync(join(dir, hit)).isDirectory()) return join(dir, hit);
    } catch {
      // Gone since the listing: none.
    }
    return null;
  }
  return null;
}

/** nuget.org's feed, as NuGet's default user config names it. */
export const NUGET_ORG_SOURCE = 'https://api.nuget.org/v3/index.json';

/** The one NuGet config file a sandboxed dotnet reads (dotnetNugetConfig). */
export interface DotnetNugetConfig {
  /** RestoreConfigFile: an absolute path. */
  file: string;
  /** RestoreAdditionalProjectSources gets nuget.org (nugetOrgImplied). */
  addNugetOrg: boolean;
}

/** Above this size a root nuget.config is not read for nugetOrgImplied (nuget.org is then not added). */
const NUGET_CONFIG_READ_MAX = 1024 * 1024;

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
export function nugetOrgImplied(text: string): boolean {
  const xml = text.replace(/<!--[\s\S]*?-->/g, '');
  const section = (name: string): string => [...xml.matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`, 'g'))].map((m) => m[1]).join('\n');
  const sources = section('packageSources');
  if (/<clear\b[^>]*\/?>/.test(sources)) return false;
  if (/\bvalue\s*=\s*["']https?:\/\/api\.nuget\.org\//i.test(sources)) return false;
  const disabled = section('disabledPackageSources');
  if ([...disabled.matchAll(/<add\b([^>]*)>/g)].some((m) => /\bkey\s*=\s*["']nuget\.org["']/i.test(m[1]) && /\bvalue\s*=\s*["']true["']/i.test(m[1]))) return false;
  return true;
}

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
export function dotnetNugetConfig(cwd: string, profile: string, platform: NodeJS.Platform = process.platform): DotnetNugetConfig {
  const own = rootNugetConfig(cwd, platform);
  if (own) {
    let addNugetOrg = false;
    try {
      const st = lstatSync(own);
      if (st.isFile() && st.size <= NUGET_CONFIG_READ_MAX) addNugetOrg = nugetOrgImplied(readFileSync(own, 'utf8'));
    } catch {
      // Unreadable here: NuGet reports it in the sandbox.
    }
    return { file: own, addNugetOrg };
  }
  const dir = join(profile, 'nuget');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'nuget.config');
  writeFileSync(file, NUGET_ORG_ONLY_CONFIG);
  return { file, addNugetOrg: false };
}

/** True when a sandbox.allowedHosts entry lets NuGet reach nuget.org's feed (`api.nuget.org`, `*.nuget.org`). */
export const isNugetHost = (host: string): boolean => /^(?:api|\*)\.nuget\.org$/i.test(host.trim());
