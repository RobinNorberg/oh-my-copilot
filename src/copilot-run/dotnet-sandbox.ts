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
 *   'path1')"): it points into the job's own profile, never at your real
 *   %APPDATA%\NuGet\NuGet.Config (it can hold private-feed credentials).
 * - NuGet and SourceLink find your profile from the OS, not USERPROFILE: the
 *   global packages folder is granted read-only (and named in
 *   NUGET_PACKAGES), and SourceLink's read of your real ~/.gitconfig, which
 *   the sandbox denies, is switched off (EnableSourceControlManagerQueries,
 *   read by MSBuild as a property from the environment).
 * Not verified on Linux or macOS.
 */

import { statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/** True when `exe` (a bare name or a path) is the dotnet host. */
export function isDotnetExe(exe: string | undefined): boolean {
  if (!exe) return false;
  const base = (exe.split(/[\\/]/).pop() ?? exe).toLowerCase();
  return base === 'dotnet' || base === 'dotnet.exe';
}

/** dotnet subcommands that run MSBuild, so they take `-m`. */
const MSBUILD_SUBCOMMANDS = new Set(['build', 'test', 'restore', 'pack', 'publish', 'clean', 'msbuild', 'run']);

/** `-m`, `-m:N`, `-maxcpucount[:N]`, `/m...`, in any case. */
const NODE_COUNT_FLAG = /^[-/](?:m|maxcpucount)(?::.*)?$/i;

/** The flag every MSBuild-running dotnet command needs in the sandbox (see the module comment). */
export const DOTNET_SINGLE_NODE_FLAG = '-m:1';

/**
 * The dotnet arguments with `-m:1` added (before any `--`) when the
 * subcommand runs MSBuild and names no node count itself. An explicit
 * `-m`/`-maxcpucount` is kept as given (above 1 it hangs in the sandbox).
 */
export function dotnetSandboxArgs(args: readonly string[]): string[] {
  const sub = args[0]?.toLowerCase();
  if (!sub || !MSBUILD_SUBCOMMANDS.has(sub)) return [...args];
  const end = args.indexOf('--');
  const own = end < 0 ? args : args.slice(0, end);
  if (own.some((a) => NODE_COUNT_FLAG.test(a))) return [...args];
  return end < 0 ? [...args, DOTNET_SINGLE_NODE_FLAG] : [...args.slice(0, end), DOTNET_SINGLE_NODE_FLAG, ...args.slice(end)];
}

/**
 * The NuGet global packages folder on this host: NUGET_PACKAGES when set to
 * an absolute path, else `<real home>/.nuget/packages`; null when that is
 * not an existing directory. A repository nuget.config's
 * globalPackagesFolder is not read (the sandbox env names this one).
 */
export function nugetPackagesDir(env: NodeJS.ProcessEnv, realHome: string): string | null {
  const fromEnv = Object.entries(env).find(([k]) => k.toUpperCase() === 'NUGET_PACKAGES')?.[1]?.trim();
  const dir = fromEnv && isAbsolute(fromEnv) ? resolve(fromEnv) : join(realHome, '.nuget', 'packages');
  try {
    return statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/**
 * The variables a sandboxed dotnet needs, for an env whose USERPROFILE is
 * already the job's profile (relocatedProfileEnv), and the paths to grant
 * read-only. `hostEnv` and `realHome` locate the NuGet packages folder.
 */
export function dotnetSandboxEnv(profile: string, hostEnv: NodeJS.ProcessEnv, realHome: string, platform: NodeJS.Platform = process.platform): { env: Record<string, string>; readonly: string[] } {
  const packages = nugetPackagesDir(hostEnv, realHome);
  return {
    env: {
      // NuGet's user config dir: the job's empty profile, never the real %APPDATA%\NuGet.
      ...(platform === 'win32' ? { APPDATA: join(resolve(profile), 'AppData', 'Roaming') } : {}),
      ...(packages ? { NUGET_PACKAGES: packages } : {}),
      DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      DOTNET_NOLOGO: '1',
      // The MSBuild server and reused nodes talk over the same pipes the sandbox blocks.
      DOTNET_CLI_USE_MSBUILD_SERVER: '0',
      MSBUILDDISABLENODEREUSE: '1',
      // MSBuild properties from the environment: no compiler server, no SourceLink git read.
      UseSharedCompilation: 'false',
      EnableSourceControlManagerQueries: 'false',
    },
    readonly: packages ? [packages] : [],
  };
}
