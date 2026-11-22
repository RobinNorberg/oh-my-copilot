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
import { statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseJsonc } from '../utils/jsonc.js';
import { getGlobalOmcConfigRoot, getGlobalOmcStateRoot } from '../utils/paths.js';
/** True when `exe` (a bare name or a path) is the dotnet host. */
export function isDotnetExe(exe) {
    if (!exe)
        return false;
    const base = (exe.split(/[\\/]/).pop() ?? exe).toLowerCase();
    return base === 'dotnet' || base === 'dotnet.exe';
}
/**
 * dotnet subcommands that run MSBuild and pass `-m` to it. Not `run`: it
 * passes an unknown option on to the program (`dotnet run -m:1` gives the
 * program the argument `-m:1`), so a program is built with `dotnet build
 * -m:1` and started with `dotnet run --no-build`.
 */
export const MSBUILD_SUBCOMMANDS = ['build', 'test', 'restore', 'pack', 'publish', 'clean', 'msbuild'];
/** The flag every MSBuild-running dotnet command needs in the sandbox (see the module comment). */
export const DOTNET_SINGLE_NODE_FLAG = '-m:1';
/** Per subcommand, the dotnet options whose value names a file, project or directory the command reads (dotnet test: -a is --test-adapter-path). */
export const DOTNET_PATH_OPTIONS = {
    build: new Set(['--project', '--solution']),
    test: new Set(['--settings', '-s', '--project', '--solution', '--test-adapter-path', '-a']),
};
const DOTNET_COMMON_VALUE_OPTIONS = ['-c', '--configuration', '-f', '--framework', '-r', '--runtime', '-o', '--output', '-v', '--verbosity', '--arch', '--os', '--version-suffix'];
/** Per subcommand, the options that take the next argument as a value that names no repository file (dotnet build: -a is --arch, -s is --source). */
export const DOTNET_VALUE_OPTIONS = {
    build: new Set([...DOTNET_COMMON_VALUE_OPTIONS, '-a', '-s', '--source']),
    test: new Set([...DOTNET_COMMON_VALUE_OPTIONS, '--filter', '-l', '--logger', '--collect', '--results-directory', '-d', '--diag', '-e', '--environment', '--blame-hang-timeout', '--blame-crash-dump-type', '--blame-hang-dump-type']),
};
/**
 * The positional arguments of a dotnet command line (before any `--`):
 * the words that are not options and not the value of an option that takes
 * the next word (DOTNET_PATH_OPTIONS, DOTNET_VALUE_OPTIONS of `sub`; an
 * option written `--x=v` or `--x:v` carries its own value).
 */
export function dotnetPositionals(sub, args) {
    const takesValue = (flag) => !!DOTNET_PATH_OPTIONS[sub]?.has(flag) || !!DOTNET_VALUE_OPTIONS[sub]?.has(flag);
    const out = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--')
            break;
        if (!a.startsWith('-'))
            out.push(a);
        else if (!/[=:]/.test(a) && takesValue(a))
            i++;
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
export function isMtpGlobalJson(text) {
    if (!text)
        return false;
    try {
        // global.json allows comments.
        const json = parseJsonc(text);
        return typeof json?.test?.runner === 'string' && json.test.runner.trim().toLowerCase() === 'microsoft.testing.platform';
    }
    catch {
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
export function dotnetSandboxArgs(args, o = {}) {
    const sub = args[0]?.toLowerCase();
    if (!sub || !MSBUILD_SUBCOMMANDS.includes(sub))
        return [...args];
    if (sub === 'test' && (o.mtp || dotnetPositionals(sub, args.slice(1)).some((a) => /\.(?:dll|exe)$/i.test(a))))
        return [...args];
    const end = args.indexOf('--');
    return end < 0 ? [...args, DOTNET_SINGLE_NODE_FLAG] : [...args.slice(0, end), DOTNET_SINGLE_NODE_FLAG, ...args.slice(end)];
}
/**
 * The NuGet global packages folder on this host: NUGET_PACKAGES when set to
 * an absolute path, else `<real home>/.nuget/packages`; null when that is
 * not an existing directory. A repository nuget.config's
 * globalPackagesFolder is not read (the sandbox env names this one).
 */
export function nugetPackagesDir(env, realHome) {
    return nugetPackagesGrant(env, realHome).dir;
}
/** The OMC config and state roots a NUGET_PACKAGES grant may not overlap (defaults: this process's). */
const omcRoots = (realHome) => [getGlobalOmcConfigRoot(), getGlobalOmcStateRoot(), join(realHome, '.omg')];
/**
 * nugetPackagesDir with why a NUGET_PACKAGES folder is refused (`note`, one
 * line the caller surfaces; `dir` null, nothing granted): the home dir, an
 * ancestor of it, a filesystem root, or a dir inside or above an OMC config
 * or state root (`protectedRoots`). Granting one of those read-only would
 * open your profile or the engine's state to the PR's code.
 */
export function nugetPackagesGrant(env, realHome, protectedRoots = omcRoots(realHome), platform = process.platform) {
    const fromEnv = Object.entries(env).find(([k]) => k.toUpperCase() === 'NUGET_PACKAGES')?.[1]?.trim();
    const dir = fromEnv && isAbsolute(fromEnv) ? resolve(fromEnv) : join(realHome, '.nuget', 'packages');
    if (fromEnv && isAbsolute(fromEnv)) {
        const fold = (p) => (platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
        // `a` is `b` or inside it.
        const within = (a, b) => { const r = relative(fold(b), fold(a)); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
        const why = dirname(dir) === dir ? 'a filesystem root'
            : within(realHome, dir) ? 'your home dir or a dir above it'
                : protectedRoots.some((r) => within(dir, r) || within(r, dir)) ? 'inside or above the OMC config or state dir'
                    : null;
        if (why)
            return { dir: null, note: `NUGET_PACKAGES (${dir}) is ${why}, so it is not granted to the sandbox: dotnet restores nothing offline there; point NUGET_PACKAGES at a dir of its own` };
    }
    try {
        return { dir: statSync(dir).isDirectory() ? dir : null };
    }
    catch {
        return { dir: null };
    }
}
/**
 * The variables a sandboxed dotnet needs, for an env whose USERPROFILE is
 * already the job's profile (relocatedProfileEnv), and the paths to grant
 * read-only. `hostEnv` and `realHome` locate the NuGet packages folder;
 * `notes` say why it was refused (nugetPackagesGrant).
 */
export function dotnetSandboxEnv(profile, hostEnv, realHome, platform = process.platform) {
    const grant = nugetPackagesGrant(hostEnv, realHome, omcRoots(realHome), platform);
    const packages = grant.dir;
    return {
        notes: grant.note ? [grant.note] : [],
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
/** True when a sandbox.allowedHosts entry lets NuGet reach nuget.org's feed (`api.nuget.org`, `*.nuget.org`). */
export const isNugetHost = (host) => /^(?:api|\*)\.nuget\.org$/i.test(host.trim());
//# sourceMappingURL=dotnet-sandbox.js.map