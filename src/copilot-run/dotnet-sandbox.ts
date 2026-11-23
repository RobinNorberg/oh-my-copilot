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
 *   when the engine is certain NuGet would use it there
 *   (nugetConfigVerdict): the engine never widens a repository's sources.
 * Not verified on Linux or macOS.
 */

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeFileSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseJsonc } from '../utils/jsonc.js';
import { getGlobalOmcConfigRoot, getGlobalOmcStateRoot } from '../utils/paths.js';
import { scanXml } from './xml-scan.js';

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
    notes: [...(grant.note ? [grant.note] : []), ...(nugetConfig && 'hierarchy' in nugetConfig ? [nugetConfig.hierarchy] : [])],
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
      // One NuGet config file instead of the walk up to the drive root (dotnetNugetConfig; MSBuild unescapes the value), plus
      // nuget.org when the engine is certain the default user config would add it there (nugetConfigVerdict).
      ...(nugetConfig && 'file' in nugetConfig ? { RestoreConfigFile: msbuildEscape(nugetConfig.file), ...(nugetConfig.addNugetOrg ? { RestoreAdditionalProjectSources: msbuildEscape(NUGET_ORG_SOURCE) } : {}) } : {}),
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

/** rootNugetConfig's answer: the file, none, or a reason the engine cannot tell which file NuGet reads there. */
export type RootNugetConfig = { file: string } | { none: true } | { ambiguous: string };

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
export function rootNugetConfig(dir: string, platform: NodeJS.Platform = process.platform): RootNugetConfig {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { none: true };
  }
  const found: Array<{ name: string; link: boolean }> = [];
  for (const name of names) {
    if (name.toLowerCase() !== 'nuget.config') continue;
    try {
      const st = lstatSync(join(dir, name));
      if (!st.isDirectory()) found.push({ name, link: st.isSymbolicLink() });
    } catch {
      // Gone since the listing: not a candidate.
    }
  }
  if (found.length === 0) return { none: true };
  if (found.length > 1) return { ambiguous: `the root of ${dir} holds ${found.map((f) => f.name).join(' and ')}, names that differ only in case, so which one NuGet reads depends on the file system` };
  const [one] = found;
  if (one.link) return { ambiguous: `${join(dir, one.name)} is a symbolic link` };
  if (!NUGET_CONFIG_NAMES.includes(one.name)) {
    if (platform === 'linux') return { none: true };
    if (platform === 'darwin') return { ambiguous: `${join(dir, one.name)} is not a name NuGet probes on a case-sensitive volume` };
  }
  return { file: join(dir, one.name) };
}

/** nuget.org's feed, as NuGet's default user config names it. */
export const NUGET_ORG_SOURCE = 'https://api.nuget.org/v3/index.json';

/**
 * The NuGet config a sandboxed dotnet reads (dotnetNugetConfig): one file
 * (RestoreConfigFile), or NuGet's own hierarchy (`hierarchy`: why the engine
 * does not name one file).
 */
export type DotnetNugetConfig = { file: string; addNugetOrg: boolean } | { hierarchy: string };

/** Above this size a root nuget.config is not read for nugetConfigVerdict (nuget.org is then not added). */
export const NUGET_CONFIG_READ_MAX = 256 * 1024;

/** What nugetConfigVerdict says about one root nuget.config. */
export interface NugetConfigVerdict {
  /** NuGet, reading this file with its default user config behind it, certainly uses nuget.org: it may be added. */
  addNugetOrg: boolean;
  /** Why nuget.org is not added (absent when it is). */
  why?: string;
  /**
   * `packageSourceMapping` keys (`<packageSource key>`) that no
   * `packageSources/add key` of the file defines, when the file does not
   * clear its sources: such a key names a source of another config (most
   * often the user config's `nuget.org`), so the file alone is not what
   * NuGet reads for this repository.
   */
  unmappedKeys: string[];
}

const UTF16_32_BOMS = [[0x00, 0x00, 0xfe, 0xff], [0xff, 0xfe], [0xfe, 0xff]];

/** The five predefined XML entities decoded (nugetConfigVerdict refuses every other reference). */
const decodePredefined = (s: string): string => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e]);

/**
 * Whether the engine may add nuget.org for a repository whose root
 * nuget.config is `bytes`, read alone (RestoreConfigFile). NuGet with its
 * hierarchy would merge the default user config (nuget.org) behind the
 * file; with one file it does not, so the engine adds nuget.org
 * (RestoreAdditionalProjectSources) only when it is CERTAIN NuGet would use
 * it there. Fail closed: `addNugetOrg` only when ALL of these hold (else
 * nothing is added, and a restore that needed nuget.org fails or parks):
 * at most NUGET_CONFIG_READ_MAX bytes; no UTF-16 or UTF-32 byte order
 * mark, no NUL byte, valid UTF-8 (a UTF-8 BOM is fine); no CDATA, DOCTYPE,
 * processing instruction other than the leading `<?xml ...?>`, entity
 * reference other than the five predefined ones, unquoted attribute or
 * other shape xml-scan.ts reports as odd; after comments are removed, no
 * `clear` element in any letter case, no attribute `key` (any case) whose
 * value is `nuget.org` in any case, no `nuget.org` anywhere in the text
 * (host or key), no `packageSourceMapping` element in any case; and the
 * root element is `configuration`. The scan is linear (xml-scan.ts).
 * Compared with `dotnet nuget list source` for each shape in
 * dotnet-sandbox.test.ts (.NET SDK 10.0.101).
 */
export function nugetConfigVerdict(bytes: Buffer): NugetConfigVerdict {
  const no = (why: string, unmappedKeys: string[] = []): NugetConfigVerdict => ({ addNugetOrg: false, why, unmappedKeys });
  if (bytes.length > NUGET_CONFIG_READ_MAX) return no(`it is larger than ${NUGET_CONFIG_READ_MAX / 1024} KB`);
  if (UTF16_32_BOMS.some((b) => b.every((x, k) => bytes[k] === x))) return no('it is UTF-16 or UTF-32');
  if (bytes.includes(0)) return no('it holds NUL bytes (UTF-16 or UTF-32 without a byte order mark)');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return no('it is not valid UTF-8');
  }
  const scan = scanXml(text);
  if (scan.odd.length > 0) return no(`its XML holds ${scan.odd.slice(0, 3).join(', ')}`);
  // Every source the file defines and every mapping key, as NuGet names its elements and attributes (case-sensitive).
  const cleared = scan.tags.some((t) => !t.close && t.name.toLowerCase() === 'clear');
  const defined = new Set(scan.tags.filter((t) => !t.close && t.name === 'add' && t.parent === 'packageSources').flatMap((t) => t.attrs.filter(([a]) => a === 'key').map(([, v]) => decodePredefined(v))));
  const mapped = scan.tags.filter((t) => !t.close && t.name === 'packageSource' && t.parent === 'packageSourceMapping').flatMap((t) => t.attrs.filter(([a]) => a === 'key').map(([, v]) => decodePredefined(v)));
  const unmapped = cleared ? [] : [...new Set(mapped.filter((k) => !defined.has(k)))].sort();
  if (cleared) return no('it clears its package sources');
  if (scan.tags.some((t) => t.attrs.some(([a, v]) => a.toLowerCase() === 'key' && decodePredefined(v).trim().toLowerCase() === 'nuget.org'))) return no('it names the nuget.org source key', unmapped);
  const lower = (scan.text + scan.tags.map((t) => ` ${t.name} ${t.attrs.map(([a, v]) => `${a} ${decodePredefined(v)}`).join(' ')}`).join('')).toLowerCase();
  if (lower.includes('nuget.org')) return no('it names nuget.org itself', unmapped);
  if (scan.tags.some((t) => t.name.toLowerCase() === 'packagesourcemapping')) return no('it maps packages to sources (packageSourceMapping)', unmapped);
  if (scan.tags.find((t) => !t.close)?.name !== 'configuration') return no('its root element is not configuration', unmapped);
  return { addNugetOrg: true, unmappedKeys: unmapped };
}

/**
 * The bytes of the regular file `path`, at most `max`, or null: lstat
 * first (a link, directory, FIFO or device is not opened), then the file
 * opened with O_NOFOLLOW and O_NONBLOCK where the platform has them, which
 * must be that same file (dev and inode, compared as bigints), still a
 * regular file within `max`; read from that descriptor, so a file swapped
 * in after the lstat is never read.
 */
export function readRegularFileBounded(path: string, max: number): Buffer | null {
  let st: BigIntStats;
  try {
    st = lstatSync(path, { bigint: true });
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > BigInt(max)) return null;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const f = fstatSync(fd, { bigint: true });
    if (!f.isFile() || f.ino !== st.ino || f.dev !== st.dev || f.size > BigInt(max)) return null;
    const size = Number(f.size);
    const buf = Buffer.alloc(size);
    let n = 0;
    while (n < size) {
      const got = readSync(fd, buf, n, size - n, n);
      if (got === 0) break;
      n += got;
    }
    // A file that grew while it was read is not this one.
    if (readSync(fd, Buffer.alloc(1), 0, 1, n) > 0) return null;
    return buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * A value for an MSBuild property set from the environment: MSBuild
 * unescapes `%XX` in it and expands `@(...)` (checked with .NET SDK
 * 10.0.101: `RestoreConfigFile` in a dir named `p%41` read `pA`, `p@(x)`
 * read `p`), so `%`, `$`, `@`, `'`, `;`, `?` and `*` are written `%XX`.
 * A `;` stays a separator for NuGet's targets even escaped
 * (dotnetNugetConfig never names a path with one).
 */
export const msbuildEscape = (value: string): string => value.replace(/[%$@';?*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

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
 * added only when nugetConfigVerdict is certain NuGet would take it from
 * the default user config and `noAdd` (engine.ts: a pinned MSBuild file
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
export function dotnetNugetConfig(cwd: string, profile: string, platform: NodeJS.Platform = process.platform, o: { noAdd?: boolean } = {}): DotnetNugetConfig {
  const root = rootNugetConfig(cwd, platform);
  if ('ambiguous' in root) return { hierarchy: `NuGet reads its own config hierarchy: ${root.ambiguous}` };
  if ('file' in root) {
    if (root.file.includes(';')) return { hierarchy: `NuGet reads its own config hierarchy: the path ${root.file} holds a ";", which MSBuild splits in RestoreConfigFile` };
    const bytes = readRegularFileBounded(root.file, NUGET_CONFIG_READ_MAX);
    const verdict = bytes ? nugetConfigVerdict(bytes) : null;
    if (verdict && verdict.unmappedKeys.length > 0) {
      return { hierarchy: `NuGet reads its own config hierarchy: ${root.file} maps packages to the source key(s) ${verdict.unmappedKeys.join(', ')}, which it does not define` };
    }
    return { file: root.file, addNugetOrg: !!verdict?.addNugetOrg && !o.noAdd };
  }
  const dir = join(profile, 'nuget');
  const file = join(dir, 'nuget.config');
  if (file.includes(';')) return { hierarchy: `NuGet reads its own config hierarchy: the path ${file} holds a ";", which MSBuild splits in RestoreConfigFile` };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, NUGET_ORG_ONLY_CONFIG);
  return { file, addNugetOrg: false };
}

/** True when a sandbox.allowedHosts entry lets NuGet reach nuget.org's feed (`api.nuget.org`, `*.nuget.org`). */
export const isNugetHost = (host: string): boolean => /^(?:api|\*)\.nuget\.org$/i.test(host.trim());
