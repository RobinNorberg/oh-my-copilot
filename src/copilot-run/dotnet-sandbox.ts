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
 *   names one file instead (dotnetNugetConfig). When that root file plainly
 *   defines no package-source policy at all (nugetConfigVerdict), the file
 *   named is an engine-written copy of it with nuget.org as its one package
 *   source (nugetOrgCopy): a config source, which any RestoreSources the
 *   repository sets overrides, as plain NuGet overrides the user config's
 *   nuget.org. Nothing is ever appended to the restore sources: the engine
 *   never widens them.
 * Not verified on Linux or macOS.
 */

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeFileSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseJsonc } from '../utils/jsonc.js';
import { getGlobalOmcConfigRoot, getGlobalOmcStateRoot } from '../utils/paths.js';
import { scanXml, type XmlTag } from './xml-scan.js';

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
 * An engine-written config (`written`: the nuget.org-only file or the root
 * config's copy, both in the job profile, which the sandbox can write) is
 * granted read-only: the file cannot be modified by sandboxed code, but its
 * directory can be renamed within the same command (the profile is
 * writable). It is written before the command starts, lives in that
 * command's own job home and never outlives it.
 */
export function dotnetSandboxEnv(profile: string, hostEnv: NodeJS.ProcessEnv, realHome: string, platform: NodeJS.Platform = process.platform, run?: RunNugetPackages, nugetConfig?: DotnetNugetConfig): { env: Record<string, string>; readonly: string[]; readwrite: string[]; notes: string[] } {
  const grant = nugetPackagesGrant(hostEnv, realHome, omcRoots(realHome), platform);
  const packages = grant.dir;
  const runDir = run ? resolve(run.dir) : null;
  const nuget = runDir ? { NUGET_PACKAGES: runDir, ...(packages ? { NUGET_FALLBACK_PACKAGES: packages } : {}) } : packages ? { NUGET_PACKAGES: packages } : {};
  return {
    notes: [...(grant.note ? [grant.note] : []), ...(nugetConfig && 'hierarchy' in nugetConfig ? [nugetConfig.hierarchy] : []), ...(nugetConfig && 'file' in nugetConfig && nugetConfig.note ? [nugetConfig.note] : [])],
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
      // One NuGet config file instead of the walk up to the drive root (dotnetNugetConfig; MSBuild unescapes the value).
      ...(nugetConfig && 'file' in nugetConfig ? { RestoreConfigFile: msbuildEscape(nugetConfig.file) } : {}),
    },
    readonly: [...(packages ? [packages] : []), ...(runDir && !run!.writable ? [runDir] : []), ...(nugetConfig && 'file' in nugetConfig && nugetConfig.written ? [nugetConfig.file] : [])],
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
 * does not name one file). `written`: the file is engine-written in the job
 * profile (NUGET_ORG_ONLY_CONFIG, or nugetOrgCopy of the root config).
 * `note`: why a root config that defines no package source got no copy, for
 * a failing command's output.
 */
export type DotnetNugetConfig = { file: string; written?: 'nuget.org-only' | 'root-copy'; note?: string } | { hierarchy: string };

/** Above this size a root nuget.config is not read for nugetConfigVerdict (no copy with nuget.org is then written). */
export const NUGET_CONFIG_READ_MAX = 256 * 1024;

/** What nugetConfigVerdict says about one root nuget.config. */
export interface NugetConfigVerdict {
  /**
   * The file plainly defines no package-source policy at all: NuGet, reading it with its default user config behind it,
   * uses nuget.org, so the engine may supply nuget.org as a config source (nugetOrgCopy), unless `pathSetting`.
   */
  addNugetOrg: boolean;
  /** Why nuget.org is not supplied (absent when it is). */
  why?: string;
  /**
   * With `addNugetOrg`: a setting whose value may be a path NuGet resolves against the config file's own directory
   * (pathSettingIn), so a copy elsewhere would change it: no copy is written, the file is used as it is.
   */
  pathSetting?: string;
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

const UTF16_32_BOMS = [[0x00, 0x00, 0xfe, 0xff], [0xff, 0xfe], [0xfe, 0xff]];

/**
 * Words whose presence anywhere in a root nuget.config's raw text (any case,
 * comments included) means it may define a package-source policy:
 * `packagesource` covers packageSources, disabledPackageSources,
 * packageSourceMapping, packageSource and packageSourceCredentials under any
 * prefix or namespace; then `clear`, `nuget.org`, `mapping`,
 * `fallbackpackagefolders`; `&` (any entity or character reference) and `<!`
 * (comments, CDATA, DOCTYPE).
 */
const SOURCE_POLICY_WORDS = ['packagesource', 'clear', 'nuget.org', 'mapping', 'fallbackpackagefolders', '&', '<!'];

/** The five predefined XML entities decoded (for unmappedKeys only). */
const decodePredefined = (s: string): string => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e]);

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
export function nugetConfigVerdict(bytes: Buffer): NugetConfigVerdict {
  let text: string | null = null;
  const verdict = (why: string | undefined, unmappedKeys: string[] = []): NugetConfigVerdict => ({ addNugetOrg: why === undefined, ...(why === undefined ? {} : { why }), namesNugetOrg: text !== null && text.toLowerCase().includes('nuget.org'), unmappedKeys });
  if (bytes.length > NUGET_CONFIG_READ_MAX) return verdict(`it is larger than ${NUGET_CONFIG_READ_MAX / 1024} KB`);
  if (UTF16_32_BOMS.some((b) => b.every((x, k) => bytes[k] === x))) return verdict('it is UTF-16 or UTF-32');
  if (bytes.includes(0)) return verdict('it holds NUL bytes (UTF-16 or UTF-32 without a byte order mark)');
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return verdict('it is not valid UTF-8');
  }
  const scan = scanXml(text);
  // Every source the file defines and every mapping key, as NuGet names its elements and attributes (case-sensitive).
  const cleared = scan.tags.some((t) => !t.close && t.name.toLowerCase() === 'clear');
  const defined = new Set(scan.tags.filter((t) => !t.close && t.name === 'add' && t.parent === 'packageSources').flatMap((t) => t.attrs.filter(([a]) => a === 'key').map(([, v]) => decodePredefined(v))));
  const mapped = scan.tags.filter((t) => !t.close && t.name === 'packageSource' && t.parent === 'packageSourceMapping').flatMap((t) => t.attrs.filter(([a]) => a === 'key').map(([, v]) => decodePredefined(v)));
  const unmapped = cleared || scan.odd.length > 0 ? [] : [...new Set(mapped.filter((k) => !defined.has(k)))].sort();
  const lower = text.toLowerCase();
  const word = SOURCE_POLICY_WORDS.find((w) => lower.includes(w));
  if (word) return verdict(`it may define package sources (it holds "${word}"), so it is used as it is`, unmapped);
  const pi = lower.indexOf('<?');
  if (pi >= 0 && (lower.slice(0, pi).trim() !== '' || !/^<\?xml[\s?]/.test(lower.slice(pi)) || lower.indexOf('<?', pi + 2) >= 0)) return verdict('it holds a processing instruction other than one leading XML declaration', unmapped);
  if (scan.odd.length > 0) return verdict(`its XML holds ${scan.odd.slice(0, 3).join(', ')}`, unmapped);
  const odd = (n: string) => n.includes(':') || /[^\x21-\x7e]/.test(n);
  if (scan.tags.some((t) => odd(t.name) || t.attrs.some(([a]) => odd(a) || a.toLowerCase() === 'xmlns'))) return verdict('it uses XML namespaces or prefixes', unmapped);
  if (scan.tags.find((t) => !t.close)?.name !== 'configuration') return verdict('its root element is not configuration', unmapped);
  const path = pathSettingIn(scan.tags);
  return { ...verdict(undefined, unmapped), ...(path ? { pathSetting: path } : {}) };
}

/** `config` keys whose value is a path (NuGet resolves a relative one against the config file's dir). */
const PATH_KEYS = new Set(['repositorypath', 'globalpackagesfolder']);

/**
 * The first setting of a root nuget.config (its scanned tags) that may hold
 * a path, as `<attribute>="<value>"`, or null. Conservative and textual: an
 * `add` of a PATH_KEYS key (any case, any value), or any attribute value
 * that starts with `.` or `~`, holds `%` (NuGet expands environment
 * variables), or holds `/` or `\` without being an `http(s)://` URL. NuGet
 * resolves a relative path in a config against that file's directory, so
 * an engine-written copy elsewhere (nugetOrgCopy) would read it from the
 * wrong place: the file is then used as it is.
 */
function pathSettingIn(tags: readonly XmlTag[]): string | null {
  for (const t of tags) {
    if (t.close) continue;
    for (const [a, v] of t.attrs) {
      const pathKey = t.name.toLowerCase() === 'add' && a.toLowerCase() === 'key' && PATH_KEYS.has(v.trim().toLowerCase());
      const pathLike = /^\s*[.~]|%/.test(v) || (/[\\/]/.test(v) && !/^\s*https?:\/\/[^\s\\]*\s*$/i.test(v));
      if (pathKey || pathLike) return `${a}="${v.slice(0, 120)}"`;
    }
  }
  return null;
}

/** What nugetOrgCopy inserts before the root's end: nuget.org as the file's one package source. */
export const NUGET_ORG_PACKAGE_SOURCES = `  <packageSources>\n    <add key="nuget.org" value="${NUGET_ORG_SOURCE}" protocolVersion="3" />\n  </packageSources>\n`;

/**
 * The bytes of the engine-written copy of a root nuget.config that defines
 * no package source (`bytes`, read alone through RestoreConfigFile): the
 * same bytes with NUGET_ORG_PACKAGE_SOURCES inserted before the root's
 * closing `</configuration>` (a self-closed `<configuration .../>` becomes
 * an open and a close tag around it). nuget.org is then an ordinary config
 * source: a `RestoreSources` the repository sets anywhere (a project, a
 * props or imported file, a task) replaces it, exactly as plain NuGet
 * replaces the user config's nuget.org. `why` instead (no copy; the caller
 * uses the file as it is, never widens) when nugetConfigVerdict does not
 * say `addNugetOrg`, when it holds a `pathSetting`, when its XML
 * declaration names an encoding other than utf-8 or us-ascii (the bytes are
 * read as UTF-8; NuGet would decode them otherwise), or when the root's end
 * is not certain: an attribute value holds `<` (a quoted `</configuration>`
 * would look like one), or the last `</configuration` (or, for a
 * self-closed root, the last `/>`) is followed by anything but `>` and
 * whitespace. The verdict already refuses comments, CDATA, DOCTYPE, entity
 * references, processing instructions other than one leading declaration,
 * namespaces, a second root and an unclosed element, so those cannot hide
 * or fake the root's end.
 */
export function nugetOrgCopy(bytes: Buffer): { copy: Buffer } | { why: string } {
  const v = nugetConfigVerdict(bytes);
  if (!v.addNugetOrg) return { why: v.why ?? 'it may define package sources' };
  if (v.pathSetting) return { why: `it holds ${v.pathSetting}, which may be a path NuGet resolves against that file's own directory, so the engine writes no copy of it elsewhere` };
  // The bytes are read as UTF-8: a declaration naming another encoding would make NuGet read them otherwise.
  const decoded = bytes.toString('utf8');
  const declared = /^\s*<\?xml\b([^?]*)\?>/.exec(decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded)?.[1];
  const encoding = declared === undefined ? undefined : /\bencoding\s*=\s*(["'])([^"']*)\1/i.exec(declared)?.[2];
  if (declared !== undefined && /\bencoding\b/i.test(declared) && !/^(?:utf-8|us-ascii)$/i.test(encoding?.trim() ?? '')) return { why: `its XML declaration names the encoding ${JSON.stringify((encoding ?? '?').slice(0, 40))}, not utf-8 or us-ascii, so the engine writes no copy of it` };
  const tags = scanXml(bytes.toString('utf8')).tags;
  if (tags.some((t) => t.attrs.some(([, val]) => val.includes('<')))) return { why: 'an attribute value holds "<", so the end of its root element is not certain' };
  const tail = (at: number) => bytes.subarray(at).toString('latin1');
  const root = tags[0];
  if (root?.selfClose && tags.length === 1) {
    const at = bytes.lastIndexOf('/>');
    if (at < 0 || !/^\/>[ \t\r\n]*$/.test(tail(at))) return { why: 'the end of its root element is not certain' };
    return { copy: Buffer.concat([bytes.subarray(0, at), Buffer.from(`>\n${NUGET_ORG_PACKAGE_SOURCES}</configuration>`), bytes.subarray(at + 2)]) };
  }
  const at = bytes.lastIndexOf('</configuration');
  if (at < 0 || !/^<\/configuration[ \t\r\n]*>[ \t\r\n]*$/.test(tail(at))) return { why: 'the end of its root element is not certain' };
  return { copy: Buffer.concat([bytes.subarray(0, at), Buffer.from(`\n${NUGET_ORG_PACKAGE_SOURCES}`), bytes.subarray(at)]) };
}

/**
 * The bytes of the regular file `path`, at most `max`, or null: lstat
 * first (a link, directory, FIFO or device is not opened), then the file
 * opened with O_NOFOLLOW and O_NONBLOCK where the platform has them, which
 * must be that same file (dev and inode, compared as bigints), still a
 * regular file within `max`; read from that descriptor, so a file swapped
 * in after the lstat is never read. With `singleLink`, both the lstat and
 * the descriptor's fstat must report exactly one link (a hard link made
 * between them is refused too).
 */
export function readRegularFileBounded(path: string, max: number, opts: { singleLink?: boolean } = {}): Buffer | null {
  let st: BigIntStats;
  try {
    st = lstatSync(path, { bigint: true });
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > BigInt(max) || (opts.singleLink && st.nlink !== 1n)) return null;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const f = fstatSync(fd, { bigint: true });
    if (!f.isFile() || f.ino !== st.ino || f.dev !== st.dev || f.size > BigInt(max) || (opts.singleLink && f.nlink !== 1n)) return null;
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

/** How many dirs lowerNugetConfigs reads before it stops and answers that it cannot tell. */
const LOWER_NUGET_SCAN_DIRS = 100_000;

/**
 * The nuget.config files (any letter case) below `dir`'s root, as paths
 * relative to `dir` with `/`, at most five; links are not followed, and
 * these dirs are not looked in: `.git` at any depth, `.omg` at the root only
 * (the engine's state and other checkouts; a `tools/.omg/` of the
 * repository is read), and `node_modules` at any depth (a package's own
 * files; a repository that tracks a .NET project or solution under one
 * keeps NuGet's hierarchy by the engine's git policy instead, engine.ts
 * dotnetNugetPolicy). A dir that cannot be read, or more than
 * LOWER_NUGET_SCAN_DIRS dirs, is reported as an entry too: the caller then
 * cannot rule a lower config out. The cost is one readdir per dir (about
 * 0.1 ms each on Windows), so the engine's gates and restore step, whose
 * policy comes from git objects, skip it (sandboxNugetConfig `fromGit`).
 */
export function lowerNugetConfigs(dir: string): string[] {
  const found: string[] = [];
  const queue: string[] = [''];
  for (let next = 0; next < queue.length && found.length < 5; next++) {
    const rel = queue[next];
    if (next >= LOWER_NUGET_SCAN_DIRS) return [...found, `more than ${LOWER_NUGET_SCAN_DIRS} dirs, not all read`];
    let entries;
    try {
      entries = readdirSync(rel ? join(dir, rel) : dir, { withFileTypes: true });
    } catch {
      if (!rel) return [];
      found.push(`${rel} (unreadable)`);
      continue;
    }
    for (const e of entries) {
      const name = e.name.replace(/[. ]+$/, '').toLowerCase();
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (name !== '.git' && name !== 'node_modules' && (rel || name !== '.omg')) queue.push(p);
      } else if (rel && e.name.toLowerCase() === 'nuget.config' && (e.isFile() || e.isSymbolicLink())) found.push(p);
    }
  }
  return found.slice(0, 5);
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
 * The file: the root config of `cwd` (rootNugetConfig) as it is; or, when
 * that file defines no package source at all (nugetOrgCopy: nugetConfigVerdict
 * `addNugetOrg`, no `pathSetting`, a certain root end) and `noAdd` (engine.ts:
 * the pinned files set restore sources themselves, an extra signal that can
 * only restrict) is not set, its copy with nuget.org as a config source,
 * written from the bytes read here to
 * `<profile>/nuget/copy-<sha256 of the copy>/nuget.config` with exclusive
 * create (an existing file is used only when it holds exactly those bytes);
 * or, with no root config, NUGET_ORG_ONLY_CONFIG written to
 * `<profile>/nuget/nuget.config`. `<profile>` is the command's own job
 * profile (never inside the checkout), and dotnetSandboxEnv grants either
 * written file read-only. Any doubt writing the copy: the root file as it
 * is (a restore that needed nuget.org then fails with `note`). `hierarchy`
 * instead (NuGet's own walk, as before one file was named: faithful, and
 * in the shared layout it parks at the first unreadable config) when the
 * engine cannot tell which root file NuGet reads (rootNugetConfig
 * `ambiguous`), when the root file maps packages to a source key it does
 * not define (nugetConfigVerdict `unmappedKeys`: the file alone would leave
 * that source out), when the path holds a `;`, which MSBuild splits, or
 * when `cwd`'s tree holds a nuget.config below its root (lowerNugetConfigs:
 * NuGet reads it for the projects under it, and one file would hide it,
 * so nothing is added and no nuget.org-only file is written). This check
 * reads the tree as it is, so it holds for every caller that passes no
 * decision of its own (a write lane's worktree, a caller outside the
 * engine); `fromGit` skips it: the engine read the lower configs of every
 * commit the command runs on from git objects (sandboxNugetConfig).
 */
export function dotnetNugetConfig(cwd: string, profile: string, platform: NodeJS.Platform = process.platform, o: { noAdd?: boolean; fromGit?: boolean } = {}): DotnetNugetConfig {
  const lower = o.fromGit ? [] : lowerNugetConfigs(cwd);
  if (lower.length > 0) return { hierarchy: `NuGet reads its own config hierarchy: ${cwd} holds a nuget.config below its root (${lower.join(', ')}), which one config file would hide` };
  const root = rootNugetConfig(cwd, platform);
  if ('ambiguous' in root) return { hierarchy: `NuGet reads its own config hierarchy: ${root.ambiguous}` };
  if ('file' in root) {
    if (root.file.includes(';')) return { hierarchy: `NuGet reads its own config hierarchy: the path ${root.file} holds a ";", which MSBuild splits in RestoreConfigFile` };
    const bytes = readRegularFileBounded(root.file, NUGET_CONFIG_READ_MAX);
    const verdict = bytes ? nugetConfigVerdict(bytes) : null;
    if (verdict && verdict.unmappedKeys.length > 0) {
      return { hierarchy: `NuGet reads its own config hierarchy: ${root.file} maps packages to the source key(s) ${verdict.unmappedKeys.join(', ')}, which it does not define` };
    }
    if (!bytes || !verdict?.addNugetOrg || o.noAdd) return { file: root.file };
    const made = nugetOrgCopy(bytes);
    const remedy = `add nuget.org to it explicitly inside <packageSources> (<add key="nuget.org" value="${NUGET_ORG_SOURCE}" />) if the repository uses nuget.org`;
    if ('why' in made) return { file: root.file, note: `${root.file} defines no package source and the engine supplied none: ${made.why}; NuGet read that file alone; ${remedy}` };
    const copy = join(profile, 'nuget', `copy-${createHash('sha256').update(made.copy).digest('hex').slice(0, 32)}`, 'nuget.config');
    if (copy.includes(';')) return { file: root.file, note: `the path ${copy} holds a ";", which MSBuild splits in RestoreConfigFile, so the engine supplied no nuget.org for ${root.file}; ${remedy}` };
    try {
      mkdirSync(dirname(copy), { recursive: true });
      writeFileSync(copy, made.copy, { flag: 'wx' });
    } catch {
      // Exclusive create: a file already there is used only when it holds exactly these bytes.
      const there = readRegularFileBounded(copy, made.copy.length);
      if (!there || !there.equals(made.copy)) return { file: root.file, note: `the engine could not write its copy of ${root.file} with nuget.org (${copy}), so it supplied none; ${remedy}` };
    }
    return { file: copy, written: 'root-copy' };
  }
  const dir = join(profile, 'nuget');
  const file = join(dir, 'nuget.config');
  if (file.includes(';')) return { hierarchy: `NuGet reads its own config hierarchy: the path ${file} holds a ";", which MSBuild splits in RestoreConfigFile` };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, NUGET_ORG_ONLY_CONFIG);
  return { file, written: 'nuget.org-only' };
}

/**
 * The NuGet config of one sandboxed dotnet command or write lane (the
 * builder sandbox-exec.ts and job.ts both call): `hierarchy` when the caller
 * decided NuGet keeps its own walk (engine.ts dotnetNugetPolicy), else
 * dotnetNugetConfig of `cwd` with `noAdd`, its lower-config scan skipped
 * when `fromGit` (the engine's policy already read every lower config of
 * the commits the command runs on from git objects: the gates, prepare
 * checks, calibrations and the restore step).
 */
export function sandboxNugetConfig(cwd: string, profile: string, platform: NodeJS.Platform, o: { hierarchy?: string | null; noAdd?: boolean; fromGit?: boolean }): DotnetNugetConfig {
  if (o.hierarchy) return { hierarchy: o.hierarchy };
  return dotnetNugetConfig(cwd, profile, platform, { noAdd: o.noAdd === true, fromGit: o.fromGit === true });
}

/** True when a sandbox.allowedHosts entry lets NuGet reach nuget.org's feed (`api.nuget.org`, `*.nuget.org`). */
export const isNugetHost = (host: string): boolean => /^(?:api|\*)\.nuget\.org$/i.test(host.trim());
