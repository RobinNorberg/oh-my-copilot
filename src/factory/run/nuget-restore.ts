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

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { dotnetPositionals, MSBUILD_SUBCOMMANDS } from '../../copilot-run/dotnet-sandbox.js';
import { visibleLine } from '../../forge/review-feedback.js';
import { isDotnetDefinitionFile } from './local-gate.js';

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
export const NUGET_RESTORE_ERROR = /^\S[^\r\n]*?\.(?:sln|slnx|slnf|[A-Za-z]*proj|props|targets) : error (NU(?:110[0-3]|13\d\d)):/gm;

/**
 * The first line that shows the build or the tests started, after which no
 * line is a restore error: MSBuild runs no build when its restore fails, so
 * a project's output line (`  App -> C:\...\App.dll`), a compiler
 * diagnostic, `Build succeeded.`, and VSTest's or Microsoft.Testing.Platform's
 * test-run lines all come after a good restore. What the PR's tests print
 * comes after them.
 */
const BUILD_OR_TEST_STARTED = /^(?:[ \t]+\S[^\r\n]* -> (?:[A-Za-z]:[\\/]|\/|\\\\)[^\r\n]*|Test run for [^\r\n]*|Starting test execution[^\r\n]*|A total of \d+ test files? matched[^\r\n]*|(?:Passed|Failed|Skipped)![ \t][^\r\n]*|[ \t]*Build succeeded\.[^\r\n]*|[ \t]*Running tests from [^\r\n]*|[^\r\n]*\): (?:error|warning) (?:CS|FS|BC)\d{4}:[^\r\n]*)\r?$/m;

/** The output before the first line that shows the build or the tests started (BUILD_OR_TEST_STARTED): the restore phase. */
export function restorePhase(output: string): string {
  const m = BUILD_OR_TEST_STARTED.exec(output);
  return m ? output.slice(0, m.index) : output;
}

export interface NugetFailure {
  /** `private-feed`: a source other than nuget.org (a private or local feed) or a feed that wants credentials. */
  kind: 'restore' | 'private-feed';
  /** The NuGet codes seen, sorted. */
  codes: string[];
  /** The sources other than nuget.org named in the errors (urls, local paths or names). */
  sources: string[];
}

/**
 * nuget.org's own feed host or source name, or the machine-wide local
 * source a Visual Studio install adds (it holds no credentials and NuGet
 * lists it next to nuget.org: "Found 1 version(s) in Microsoft Visual
 * Studio Offline Packages").
 */
const isNugetOrg = (s: string): boolean => {
  const t = s.trim().replace(/[.'"]+$/, '');
  if (/^(?:nuget\.org|Microsoft Visual Studio Offline Packages)$/i.test(t)) return true;
  const host = /^https?:\/\/([^/:\s'"]+)/i.exec(t)?.[1];
  return !!host && /(?:^|\.)nuget\.org$/i.test(host);
};

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
export function classifyNugetFailure(output: string | undefined): NugetFailure | null {
  if (!output) return null;
  const phase = restorePhase(output);
  const codes = [...new Set([...phase.matchAll(NUGET_RESTORE_ERROR)].map((m) => m[1]))].sort();
  if (codes.length === 0) return null;
  const sources = new Set<string>();
  for (const m of phase.matchAll(/\bfor source '?(https?:\/\/[^\s'"\]]+)/gi)) if (!isNugetOrg(m[1])) sources.add(m[1].replace(/[.'"]+$/, ''));
  for (const m of phase.matchAll(/\bThe local source '([^'\r\n]+)'/gi)) sources.add(m[1]);
  for (const m of phase.matchAll(/\bin source\(s\): ([^\r\n\[]+)/gi)) {
    for (const name of m[1].split(',')) if (name.trim() && !isNugetOrg(name)) sources.add(name.trim().replace(/[.'"]+$/, ''));
  }
  const auth = /Response status code does not indicate success: 40[13]\b/i.test(phase);
  return { kind: sources.size > 0 || auth ? 'private-feed' : 'restore', codes, sources: [...sources].sort() };
}

/** True for a relative path that stays inside the repository (not absolute, no leading `..`, no drive). */
function insideRepo(p: string): boolean {
  if (posix.isAbsolute(p) || win32.isAbsolute(p) || /^[a-z]:/i.test(p)) return false;
  const norm = posix.normalize(p.replace(/\\/g, '/'));
  return norm !== '..' && !norm.startsWith('../');
}

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
export function dotnetRestoreArgs(gateArgs: readonly string[]): string[] | null {
  const sub = gateArgs[0]?.toLowerCase();
  if (!sub || !MSBUILD_SUBCOMMANDS.includes(sub) || sub === 'clean') return null;
  const rest = gateArgs.slice(1);
  const end = rest.indexOf('--');
  const args = end < 0 ? rest : rest.slice(0, end);
  const targets = dotnetPositionals(sub, args);
  if (sub === 'test' && targets.some((a) => /\.(?:dll|exe)$/i.test(a))) return null;
  const extra: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '--project' || a === '--solution') && i + 1 < args.length) targets.push(args[++i]);
    else if (/^--(?:project|solution)[=:]/.test(a)) targets.push(a.replace(/^--(?:project|solution)[=:]/, ''));
    else if ((a === '-r' || a === '--runtime') && i + 1 < args.length) extra.push(a, args[++i]);
    else if (/^(?:-r|--runtime)[=:]/.test(a) || /^(?:-p|--property|\/p|\/property):/i.test(a)) extra.push(a);
  }
  if (!targets.every(insideRepo)) return null;
  return ['restore', ...targets, ...extra];
}

/** The run's own NuGet packages folder: `<gate job root>/nuget/<run slug>`, outside every checkout and never your real cache. */
export const nugetRunPackagesDir = (gateJobRoot: string, slug: string): string => join(gateJobRoot, 'nuget', slug);

/** The run's definition tree, where the networked restore runs: `<gate job root>/nuget-defs/<run slug>`, outside every checkout. */
export const nugetDefinitionTreeDir = (gateJobRoot: string, slug: string): string => join(gateJobRoot, 'nuget-defs', slug);

/** A commit's file as `git ls-tree -r` lists it: [repository path, object id, mode]. */
export type DefinitionEntry = readonly [path: string, oid: string, mode: string];

/** A Windows device name as a path segment (`nul`, `com1.props`): never written. */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;

/**
 * Why a repository path cannot be written as a plain file under the tree
 * on any host, or null: an empty, `.` or `..` segment, a `.git` segment, a
 * `\`, `:` (an NTFS stream), a character Windows refuses, a segment ending
 * in a dot or space (Windows drops them), or a device name.
 */
export function unwritableTreePath(path: string): string | null {
  for (const s of path.split('/')) {
    if (s === '' || s === '.' || s === '..') return 'an empty, . or .. path segment';
    if (s.toLowerCase() === '.git') return 'a .git path segment';
    if (/[\\:<>"|?*\x00-\x1f]/.test(s)) return 'a character Windows cannot write in a file name';
    if (/[. ]$/.test(s)) return 'a path segment ending in a dot or space';
    if (WINDOWS_DEVICE.test(s)) return 'a Windows device name';
  }
  return null;
}

/** git's object id of a blob's bytes (`blob <size>\0<bytes>`): SHA-1, or SHA-256 for a 64-hex id. */
export function gitBlobId(content: Buffer, oidLength: number): string {
  return createHash(oidLength === 64 ? 'sha256' : 'sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

/** The blobs `git cat-file --batch` printed, by object id (a `<oid> missing` line is left out). */
export function parseCatFileBatch(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) break;
    const line = buf.subarray(at, nl).toString('latin1');
    const m = /^([0-9a-f]+) blob (\d+)$/.exec(line);
    if (!m) {
      if (/^\S+ missing$/.test(line)) { at = nl + 1; continue; }
      throw new Error(`git cat-file --batch printed ${JSON.stringify(line.slice(0, 80))}`);
    }
    const size = Number(m[2]);
    out.set(m[1], buf.subarray(nl + 1, nl + 1 + size));
    at = nl + 1 + size + 1;
  }
  return out;
}

/** An MSBuild file that ends MSBuild's walk up from a project at the tree root (it defines nothing). */
const EMPTY_PROJECT = '<Project />\n';

/**
 * The NuGet config written at the tree root when the head has none there:
 * nuget.org as the only source, and every source, disabled source and
 * source mapping of the configs above the tree (and the machine-wide ones,
 * such as Visual Studio's offline packages folder) cleared. Checked with
 * .NET SDK 10.0.101: an ancestor config that adds a feed, disables nuget.org
 * and maps every package to its feed restores from nuget.org with this one
 * at the root, and a project restores the same packages as with the
 * default config (only the offline folder's source goes, and its packages
 * are nuget.org's).
 */
export const DEFINITION_TREE_NUGET_CONFIG = [
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

/**
 * The files written at the definition tree's root when the head has no file
 * of that name there, so MSBuild's and NuGet's walk up from the tree stops
 * at the tree, as a clone of the repository would see nothing above it
 * (apart from your own parent dirs): `Directory.Build.props`,
 * `Directory.Build.targets`, `Directory.Solution.props`,
 * `Directory.Solution.targets` and `Directory.Packages.props` as an empty
 * project (with .NET SDK 10.0.101 an empty `Directory.Packages.props` does
 * not switch central package management on, and stops an ancestor's that
 * would), and `nuget.config` (DEFINITION_TREE_NUGET_CONFIG). Never
 * `global.json` or a `.rsp`: those select the SDK or add arguments, and an
 * empty one would change what the head's own files say. [name, content].
 */
export const DEFINITION_TREE_STUBS: ReadonlyArray<readonly [string, string]> = [
  ['Directory.Build.props', EMPTY_PROJECT],
  ['Directory.Build.targets', EMPTY_PROJECT],
  ['Directory.Solution.props', EMPTY_PROJECT],
  ['Directory.Solution.targets', EMPTY_PROJECT],
  ['Directory.Packages.props', EMPTY_PROJECT],
  ['nuget.config', DEFINITION_TREE_NUGET_CONFIG],
];

/**
 * Write the definition tree into `dir` (made here, so it must not exist;
 * its parent must): every entry of the head's tree that is a pinned
 * definition file (DOTNET_DEFINITION_PATTERNS) as a regular file at its
 * repository path, its bytes from `blobs` (git objects, never a checkout's
 * working files) and checked against its object id. A gitlink is skipped;
 * a pattern-matching symlink, a path that cannot be written as a plain
 * file, a blob that is missing or does not hash to its id, or two paths
 * that land on the same file (a case clash) is a problem (nothing is
 * evaluated: the caller parks). `files`: the paths written, sorted. Then
 * the stubs (DEFINITION_TREE_STUBS) the head's root lacks: an MSBuild one
 * when no root file has its exact name (MSBuild matches names exactly on
 * Linux; a root file that differs only in case on a case-insensitive file
 * system keeps the stub out), `nuget.config` when no root file is named so
 * in any case (NuGet looks for several casings). `stubs`: the names
 * written, in that order. Stubs live in this tree only, never a checkout.
 */
export function writeDefinitionTree(dir: string, entries: readonly DefinitionEntry[], blobs: (oids: string[]) => Map<string, Buffer>): { files: string[]; stubs: string[] } | { problem: string } {
  const pinned = entries.filter(([p, , mode]) => mode !== '160000' && isDotnetDefinitionFile(p));
  const link = pinned.find(([, , mode]) => mode === '120000');
  if (link) return { problem: `the pinned definition file ${link[0]} is a symbolic link, which the definition tree never holds` };
  const odd = pinned.find(([, , mode]) => mode !== '100644' && mode !== '100755');
  if (odd) return { problem: `the pinned definition file ${odd[0]} has the git mode ${odd[2]}, not a regular file's` };
  for (const [p] of pinned) {
    const why = unwritableTreePath(p);
    if (why) return { problem: `the pinned definition file path ${JSON.stringify(p)} has ${why}` };
  }
  const oids = [...new Set(pinned.map(([, oid]) => oid))];
  const bytes = oids.length > 0 ? blobs(oids) : new Map<string, Buffer>();
  mkdirSync(dir);
  const root = resolve(dir);
  for (const [p, oid] of pinned) {
    const content = bytes.get(oid);
    if (!content || gitBlobId(content, oid.length) !== oid) return { problem: `the blob ${oid.slice(0, 12)} of ${p} could not be read from git as that object` };
    const target = join(root, ...p.split('/'));
    const rel = relative(root, target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { problem: `the pinned definition file path ${JSON.stringify(p)} leaves the definition tree` };
    mkdirSync(dirname(target), { recursive: true });
    try {
      // `wx`: never over an existing file (a case clash on a case-insensitive file system).
      writeFileSync(target, content, { flag: 'wx' });
    } catch (error) {
      return { problem: `the pinned definition file ${p} could not be written to the definition tree (${(error as NodeJS.ErrnoException).code ?? String(error)})` };
    }
  }
  const atRoot = pinned.map(([p]) => p).filter((p) => !p.includes('/'));
  const stubs: string[] = [];
  for (const [name, content] of DEFINITION_TREE_STUBS) {
    const nuget = name === 'nuget.config';
    if (atRoot.some((p) => (nuget ? p.toLowerCase() === name : p === name))) continue;
    try {
      writeFileSync(join(root, name), content, { flag: 'wx' });
      stubs.push(name);
    } catch (error) {
      // A root file differing only in case on a case-insensitive file system: MSBuild finds that one there.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      return { problem: `the definition tree's ${name} could not be written (${(error as NodeJS.ErrnoException).code ?? String(error)})` };
    }
  }
  return { files: pinned.map(([p]) => p).sort(), stubs };
}

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
export function removeEngineDir(dir: string, root: string): boolean {
  let st;
  try {
    st = lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is a link or not a directory, so the engine did not remove it; remove it by hand`);
  const real = realpathSync.native(dir);
  const top = realpathSync.native(root);
  const rel = relative(top, real);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${dir} does not resolve below ${root}, so the engine did not remove it; remove it by hand`);
  rmSync(real, { recursive: true, force: true, maxRetries: 2 });
  return true;
}

/**
 * The definition file a failed restore in the definition tree needed but
 * the tree lacks (MSBuild's "The imported project ... was not found", "The
 * project file ... was not found", "Project file does not exist"), as a
 * path relative to the tree, or undefined. A path outside the tree comes
 * back as MSBuild printed it, made one line of visible text (visibleLine:
 * format and line characters as `<U+XXXX>`, other control characters
 * dropped), at most 200 characters and JSON-quoted: it is restore output,
 * and goes into a park reason.
 */
export function missingDefinitionFile(output: string, tree: string): string | undefined {
  // MSB4019: The imported project "<path>" was not found. MSB3202: The project file "<path>" was not found.
  const m = /error (?:MSB4019|MSB3202): [^"\r\n]*"([^"\r\n]+)"/.exec(output);
  if (!m) return undefined;
  const rel = relative(resolve(tree), resolve(m[1]));
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return visibleLine(rel.split(sep).join('/'));
  return JSON.stringify(visibleLine(m[1]).slice(0, 200));
}

/** The setting and its two values, as the parks name them. */
export const GATE_INSTALL_SANDBOXED_HINT = 'set factory.run.gateInstall "sandboxed" in your user config (the engine then runs dotnet restore in the OS sandbox with only api.nuget.org reachable, on the pinned definition files only, after the gate definition check)';

/**
 * What the gate-definition-changed park of a dotnet gate adds with
 * gateInstall "sandboxed": the approval also lets the engine restore those
 * files with the network on. On Windows also what that restore can reach
 * beyond nuget.org: the Windows sandbox runs nothing with outbound access on
 * and the local network off (the documented known gap), so the MSBuild
 * targets in the approved files run with loopback and the local network
 * reachable.
 */
export function restoreApprovalNote(platform: NodeJS.Platform): string {
  const note = '. With factory.run.gateInstall "sandboxed", approving with --allow-gate-change also lets the engine run dotnet restore on these definition files with api.nuget.org reachable';
  return platform === 'win32' ? `${note}; on Windows the MSBuild targets in these files run during that restore, and loopback and your local network are reachable from it too` : note;
}

/** The private-feed park's reason prefix. */
export const NUGET_PRIVATE_FEED_UNSUPPORTED = 'private or local NuGet feeds are not supported in the sandbox yet';
