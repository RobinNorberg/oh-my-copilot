/**
 * References from a dotnet gate's pinned definition files into a
 * `node_modules` dir (engine.ts ensureLocalGate). A trusted base whose build
 * imports a file there (`<Import Project="..\node_modules\x\build\x.props" />`)
 * reads a dir the PR's code can change in the gate checkout: a prepare check
 * runs there before the gate, and git, the clean step and the stray checks
 * all leave `node_modules` out. The engine then runs the gate only when the
 * checkout's node_modules is exactly the tree it built (prepare.ts
 * gateTreeExactProblem).
 *
 * The rule is textual and deliberately narrow: only the values that make
 * MSBuild, NuGet or the SDK read or run a file are looked at (`Import
 * Project`, `ProjectReference Include`, `UsingTask AssemblyFile`, an inline
 * task's `Code Source`, an `Exec Command` (the exit code of what it runs
 * decides the build), a solution's project entries, a `nuget.config` source
 * or fallback folder value, every token of a `.rsp` response file, and
 * `global.json` `sdk.paths`), and one counts when its value has a
 * `node_modules` path segment once `\` is read as `/`. MSBuild property
 * expansion makes exact resolution impossible, so a value is not expanded:
 * a property that holds the node_modules part (`$(NodeModules)\x.props`
 * with `<NodeModules>..\node_modules</NodeModules>`) is not seen, and a
 * reference that resolves elsewhere counts. A mere mention does not count:
 * the ASP.NET SPA templates' `<Content Remove="$(SpaRoot)node_modules\**" />`
 * and `<Exec Command="npm install" />` (or `npm ci`, `npm run build`) name no
 * path under node_modules, and a pure delete with a shell built-in or
 * system tool (`<Exec Command="rm -rf node_modules" />`, `del /q
 * node_modules\.cache`) reads nothing there; `rimraf` and a package
 * runner (NPX_RUN: `npx`, `pnpx`, `bunx`, `npm exec` / `npm x`, `pnpm dlx` /
 * `pnpm exec`, `yarn dlx` / `yarn exec`, `bun x`) run node_modules code and count.
 * ASP.NET Core 2.x SpaServices projects run `node
 * node_modules/webpack/bin/webpack.js` in an Exec: that counts, so their
 * gate runs only on the engine's exact node_modules tree (and parks on a
 * copied one).
 *
 * The same blobs also tell the engine whether the repository sets NuGet's
 * restore sources in MSBuild (restoreSettingMentions) and whether NuGet
 * resolves MSBuild project SDKs for it (projectSdkMentions). Every read is
 * a linear scan (xml-scan.ts) of at most PINNED_READ_MAX bytes.
 */

import { parseJsonc } from '../../utils/jsonc.js';
import { scanXml, type XmlTag } from '../../copilot-run/xml-scan.js';

/** Above this size a pinned file is not read: its references are unknown (nodeModulesReferences counts one; L1). */
export const PINNED_READ_MAX = 256 * 1024;

/** The XML entities an attribute value can use (`&#x6E;ode_modules` reads as node_modules). */
function decodeXml(value: string): string {
  return value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (whole, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (hex || dec) {
      const code = Number.parseInt(hex ?? dec!, hex ? 16 : 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[name!.toLowerCase()] ?? whole;
  });
}

/**
 * True when a path has a `node_modules` segment (`\` read as `/`, any case,
 * trailing dots and spaces dropped as Windows does). The parentheses,
 * quotes, commas, `:`, `=`, `@` and other punctuation of an MSBuild expression or a response-file switch count as
 * boundaries too, so `$(MSBuildThisFileDirectory)node_modules\x` (a property
 * ends in a separator) and a property function's argument
 * (`$([MSBuild]::NormalizePath('..', 'node_modules', 'x.props'))`) count.
 */
export function hasNodeModulesSegment(value: string): boolean {
  return value.split(/[\\/'"`,;:=@()[\]\s|]+/).some((s) => s.replace(/[. ]+$/, '').toLowerCase() === 'node_modules');
}

/** The decoded values of `attr` on every `<element ...>` tag of a scan (xml-scan.ts: comments skipped, linear), names in any case. */
function attributeValues(tags: readonly XmlTag[], element: string, attr: string): string[] {
  const out: string[] = [];
  const el = element.toLowerCase();
  const at = attr.toLowerCase();
  for (const t of tags) {
    if (t.close || t.name.toLowerCase() !== el) continue;
    const a = t.attrs.find(([n]) => n.toLowerCase() === at);
    if (a) out.push(decodeXml(a[1]));
  }
  return out;
}

/** The contents of every double-quoted JSON string in `text` (escapes kept), in one forward pass; an unclosed one ends it. */
function jsonStrings(text: string): string[] {
  const out: string[] = [];
  let i = text.indexOf('"');
  while (i >= 0) {
    let j = i + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
    if (j >= text.length) break;
    out.push(text.slice(i + 1, j));
    i = text.indexOf('"', j + 1);
  }
  return out;
}

/** The `.cmd` / `.exe` / `.ps1` a package-manager shim may carry. */
const SHIM_EXT = String.raw`(?:\.(?:cmd|exe|ps1))?`;
/** Up to eight option tokens before a package manager's subcommand (`--yes`, `-y`, `--cwd web`, `--dir=web`); bounded so a scan stays linear. */
const PM_OPTIONS = String.raw`(?:\s+-{1,2}[\w-]+(?:=[^\s"'&|;]*|\s+[^\s"'&|;-][^\s"'&|;]*)?){0,8}`;
/**
 * A package-runner run anywhere in a command, quoted or not, bare or after
 * a path (`C:\nodejs\npx.cmd`, `/usr/bin/npx`), with or without `.cmd` /
 * `.exe` / `.ps1`: `npx`, `pnpx`, `bunx`, and `npm exec` / `npm x`, `pnpm
 * dlx` / `pnpm exec`, `yarn dlx` / `yarn exec`, `bun x`, each with option
 * tokens allowed before the subcommand (`npm --yes exec`); each resolves
 * `node_modules/.bin/<name>` (or fetches a package) before anything else.
 * `npm run <script>`, `npm install`, `npm ci`, `yarn run <script>` and a
 * bare `yarn <bin>` / `pnpm <bin>` are not counted, like `npm run` (the SPA
 * templates' `npm install` / `npm run build`).
 */
const NPX_RUN = new RegExp(String.raw`(?:^|[\s&|;(\x60"'\\/])(?:(?:npx|pnpx|bunx)${SHIM_EXT}|(?:npm${SHIM_EXT}["']?${PM_OPTIONS}\s+(?:exec|x))|(?:pnpm${SHIM_EXT}["']?${PM_OPTIONS}\s+(?:dlx|exec))|(?:yarn${SHIM_EXT}["']?${PM_OPTIONS}\s+(?:dlx|exec))|(?:bun${SHIM_EXT}["']?${PM_OPTIONS}\s+x))(?=[\s"'&|;)\x60]|$)`, 'i');

/**
 * A pure delete command, whole (M3): a shell built-in or system tool,
 * `rm`, `del`, `rd`, `rmdir` or `Remove-Item` (optionally `.exe`), then
 * only simple flags (`-rf`, `--force`, `/q`) and plain path arguments.
 * Not `rimraf` or a package runner (NPX_RUN; round 4): rimraf is a
 * node_modules binary found through PATH (`node_modules/.bin` first under
 * npm), and a package runner runs `node_modules/.bin/<x>` before anything
 * else, so either runs node_modules code and counts as a reference.
 */
const PURE_DELETE =/^(?:rm|del|rd|rmdir|remove-item)(?:\.exe)?(?:\s+(?:--?[a-z][a-z-]*|\/[a-z]|[\w.:\\/-]+))+$/i;

/** A value with MSBuild's `%XX` escapes unescaped (`%2e%2e` reads as `..`, `%3B` as `;`), as MSBuild does before it uses it. */
const msbuildUnescape = (value: string): string => value.replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)));

/**
 * An `Exec Command` (XML-decoded) as MSBuild runs it: `%XX` unescaped
 * (MSBuild turns `%0A`, `%26%26` or `%3B` into a line break, `&&` or
 * `;` before the shell sees them), or null when it is a pure delete
 * (PURE_DELETE, after unescaping) with no `%`, `$`, backtick, `&`, `|`,
 * `;`, `<`, `>`, line break, `(` or `)` anywhere: `rm -rf ./node_modules`
 * or `del /q node_modules\.cache` reads nothing there. Everything else is
 * read whole (M4 of an earlier review exempted delete segments of a
 * chained command; a chain, a substitution or an escape can run more).
 */
function execRunText(command: string): string | null {
  const run = msbuildUnescape(command);
  return !/[%$`&|;<>\r\n()]/.test(run) && PURE_DELETE.test(run.trim()) ? null : run;
}

/** The kind of a pinned file this module reads, by its basename, or null. */
function fileKind(path: string): 'msbuild' | 'sln' | 'slnx' | 'slnf' | 'nuget' | 'rsp' | 'global' | null {
  const base = (path.split('/').pop() ?? path).toLowerCase();
  if (base === 'nuget.config') return 'nuget';
  if (base === 'global.json') return 'global';
  if (base.endsWith('.rsp')) return 'rsp';
  if (base.endsWith('.sln')) return 'sln';
  if (base.endsWith('.slnx')) return 'slnx';
  if (base.endsWith('.slnf')) return 'slnf';
  if (/\.(?:[a-z0-9]*proj|props|targets|tasks|projitems|user)$/.test(base)) return 'msbuild';
  return null;
}

/** True when this module reads a pinned definition file of that name (the others are never fetched). */
export const readsForNodeModulesRefs = (path: string): boolean => fileKind(path) !== null;

/**
 * The references into a node_modules dir in one pinned definition file:
 * `<what> <value>` for each, in file order. `path` is its repository path
 * (its basename decides how it is read); `text` its bytes as UTF-8. A file
 * larger than PINNED_READ_MAX is not read: one reference, "not read",
 * so the caller treats its references as unknown (conservative). Every
 * scan is linear (L1).
 */
export function nodeModulesReferences(path: string, text: string): string[] {
  const kind = fileKind(path);
  if (kind && text.length > PINNED_READ_MAX) return [`file larger than ${PINNED_READ_MAX / 1024} KB, not read (its references are unknown)`];
  const values: Array<[string, string]> = [];
  // References that count whatever their text names (an npx run: npx runs node_modules/.bin/<name> first).
  const always: Array<[string, string]> = [];
  if (kind === 'msbuild') {
    const { tags } = scanXml(text);
    for (const v of attributeValues(tags, 'Import', 'Project')) values.push(['Import Project', v]);
    for (const v of attributeValues(tags, 'ProjectReference', 'Include')) values.push(['ProjectReference Include', v]);
    for (const v of attributeValues(tags, 'UsingTask', 'AssemblyFile')) values.push(['UsingTask AssemblyFile', v]);
    // An inline task's code file (RoslynCodeTaskFactory compiles it).
    for (const v of attributeValues(tags, 'Code', 'Source')) values.push(['UsingTask Code Source', v]);
    // A command whose exit code decides the build, when it names a path under node_modules (`node node_modules/x/check.js`);
    // `npm install`, `npm ci` or `npm run build` name none, and a pure delete (`rm -rf node_modules`) reads nothing there.
    // An Exec's WorkingDirectory and EnvironmentVariables count as references too (`PATH=node_modules/.bin`), and with
    // either naming node_modules no Command is a pure delete (round 4).
    for (const t of tags) {
      if (t.close || t.name.toLowerCase() !== 'exec') continue;
      const attr = (name: string) => { const a = t.attrs.find(([n]) => n.toLowerCase() === name); return a ? decodeXml(a[1]) : undefined; };
      const where = (['workingdirectory', 'environmentvariables'] as const).map((n) => [n, attr(n)] as const).filter(([, v]) => v !== undefined && hasNodeModulesSegment(v));
      for (const [n, v] of where) values.push([n === 'workingdirectory' ? 'Exec WorkingDirectory' : 'Exec EnvironmentVariables', v!]);
      const command = attr('command');
      if (command === undefined) continue;
      const run = execRunText(command);
      if (run !== null && NPX_RUN.test(run)) always.push(['Exec Command (npx runs node_modules/.bin)', run]);
      else if (run !== null) values.push(['Exec Command', run]);
      else if (where.length > 0) values.push(['Exec Command (run in or with node_modules)', `${command} [${where.map(([, v]) => v).join('; ')}]`]);
    }
  } else if (kind === 'rsp') {
    // A response file: every token outside `#` comment lines (`-logger:<dll>`, `-distributedlogger:...`, `@file`,
    // `-p:Name=<value>`; hasNodeModulesSegment reads `:`, `=` and `@` as boundaries).
    for (const line of text.split(/\r?\n/)) {
      if (line.trimStart().startsWith('#')) continue;
      for (const m of line.matchAll(/"([^"]*)"|(\S+)/g)) {
        const token = m[1] ?? m[2];
        values.push(['response file token', token]);
      }
    }
  } else if (kind === 'global') {
    // global.json `sdk.paths`: the dirs the SDK resolver looks in for an SDK.
    let parsed: unknown;
    try { parsed = parseJsonc(text); } catch { parsed = undefined; }
    if (parsed && typeof parsed === 'object') {
      const paths = (parsed as { sdk?: { paths?: unknown } }).sdk?.paths;
      if (Array.isArray(paths)) for (const p of paths) if (typeof p === 'string') values.push(['global.json sdk.paths', p]);
    } else {
      // Not JSON the SDK would read the same way: every string in it, conservatively.
      for (const s of jsonStrings(text)) values.push(['global.json string', s]);
    }
  } else if (kind === 'slnx') {
    for (const v of attributeValues(scanXml(text).tags, 'Project', 'Path')) values.push(['solution project', v]);
  } else if (kind === 'sln') {
    // `Project("{type guid}") = "Name", "path\to\App.csproj", "{project guid}"`: one line each (no match spans lines).
    for (const m of text.matchAll(/^[ \t]*Project[ \t]*\([^)\r\n]*\)[ \t]*=[ \t]*"[^"\r\n]*"[ \t]*,[ \t]*"([^"\r\n]*)"/gim)) values.push(['solution project', m[1]]);
  } else if (kind === 'slnf') {
    let parsed: unknown;
    try { parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch { parsed = undefined; }
    const solution = (parsed as { solution?: { path?: unknown; projects?: unknown } } | undefined)?.solution;
    if (solution && typeof solution === 'object') {
      if (typeof solution.path === 'string') values.push(['solution filter path', solution.path]);
      if (Array.isArray(solution.projects)) for (const p of solution.projects) if (typeof p === 'string') values.push(['solution filter project', p]);
    } else {
      // Not JSON MSBuild would read the same way: every string in it, conservatively.
      for (const s of jsonStrings(text)) values.push(['solution filter string', s]);
    }
  } else if (kind === 'nuget') {
    // A local source or fallback folder: any `<add value="...">` that is not an http(s) feed.
    for (const v of attributeValues(scanXml(text).tags, 'add', 'value')) if (!/^https?:\/\//i.test(v.trim())) values.push(['nuget.config value', v]);
  }
  return [...values.filter(([, v]) => hasNodeModulesSegment(v)), ...always].map(([what, v]) => `${what} ${JSON.stringify(v.slice(0, 200))}`);
}

/** The MSBuild properties that set NuGet's restore sources or config (restoreSettingMentions). */
const RESTORE_SETTINGS = /\bRestore(?:Sources|AdditionalProjectSources|FallbackFolders|ConfigFile|PackagesPath|NoCache|IgnoreFailedSources)\b/gi;

/**
 * The NuGet restore properties a pinned MSBuild file (`*.*proj`, `*.props`,
 * `*.targets`, `*.tasks`, `*.projitems`, `*.user`) or response file
 * (`*.rsp`) names, textually and in any case (`RestoreSources`,
 * `RestoreAdditionalProjectSources`, `RestoreFallbackFolders`,
 * `RestoreConfigFile`, `RestorePackagesPath`, `RestoreNoCache`,
 * `RestoreIgnoreFailedSources`): the repository sets its restore sources
 * itself, so the engine never adds nuget.org (H2: an added
 * RestoreAdditionalProjectSources is appended to `RestoreSources`).
 * Conservative: a comment or a condition counts, and a file larger than
 * PINNED_READ_MAX counts as `not read`. Other files: none.
 */
export function restoreSettingMentions(path: string, text: string): string[] {
  const kind = fileKind(path);
  if (kind !== 'msbuild' && kind !== 'rsp') return [];
  if (text.length > PINNED_READ_MAX) return [`not read (larger than ${PINNED_READ_MAX / 1024} KB)`];
  return [...new Set([...text.matchAll(RESTORE_SETTINGS)].map((m) => m[0]))].sort();
}

/** An `Import Project` value (one `;` part, trimmed) that names a pinned definition file: it ends, textually, in one of their MSBuild extensions. */
const PINNED_IMPORT = /\.(?:[a-z0-9]*proj|props|targets|tasks|projitems|user)$/i;
/** `$(MSBuildThisFileDirectory)` optionally followed by `..` segments (`..`, `../..`, `..\`): the importing file's dir or one above it. */
const THIS_DIR_UP = String.raw`\$\(MSBuildThisFileDirectory\)((?:\.\.(?:[\\/]\.\.)*)?)[\\/]?`;
/**
 * `$([MSBuild]::GetPathOfFileAbove('<name>'[, <start>]))`: a file of that literal name, so it counts by that name's
 * extension; `<start>` (quoted or not) only as THIS_DIR_UP. Groups: the name (quoted, bare), the `..` part (quoted, bare).
 */
const FILE_ABOVE = new RegExp(String.raw`^\$\(\[MSBuild\]::GetPathOfFileAbove\(\s*(?:'([^'$%@()]+)'|([^'"$%@(),\s]+))\s*(?:,\s*(?:'${THIS_DIR_UP}'|${THIS_DIR_UP})\s*)?\)\)$`, 'i');
/** An Import path relative to the importing file's dir: literal, or after `$(MSBuildThisFileDirectory)` and any separators (it ends in one). Group: the relative path. */
const THIS_DIR_PATH = /^(?:\$\(MSBuildThisFileDirectory\)[\\/]*)?([^$@%*?]*)$/i;

/**
 * True when `rel` (a path relative to the dir of the repository file
 * `path`, `\` read as `/`) is absolute or climbs above the repository root.
 */
function leavesRepository(path: string, rel: string): boolean {
  const r = rel.replace(/\\/g, '/');
  if (/^(?:[a-z]:|\/)/i.test(r)) return true;
  let depth = path.split('/').length - 1;
  for (const seg of r.split('/')) {
    if (seg === '..') depth--;
    else if (seg !== '' && seg !== '.') depth++;
    if (depth < 0) return true;
  }
  return false;
}

/**
 * The `Import Project` values of a pinned MSBuild file that do not name a
 * pinned definition file (M2): each `;` part of the decoded value, `%XX`
 * unescaped as MSBuild does, that
 * - has a `node_modules` path segment (any case, `\` or `/`): such a file
 *   is never pinned (the engine does not read node_modules trees);
 * - does not end, textually, in `.props`, `.targets`, `.tasks`,
 *   `.projitems`, `.user` or a `*proj` extension, including one that ends
 *   in a property reference (`$(X)`) or a wildcard;
 * - is a literal path, or one after `$(MSBuildThisFileDirectory)` (which
 *   ends in a separator, so separators after it are dropped), that is
 *   absolute or climbs above the repository root (round 5).
 * `$([MSBuild]::GetPathOfFileAbove('<name>.props'[, <start>]))` counts by
 * its literal name (a name with a `..` segment or an absolute one counts),
 * with a start dir only as `$(MSBuildThisFileDirectory)` plus `..`
 * segments (any other start, such as `'C:/corp'` or `$(CorpRoot)`,
 * counts). A start at or above the repository root is pinned: the search
 * finds nothing above the root in the engine's trees, like
 * `GetDirectoryNameOfFileAbove` (counted by the extension after it); a
 * file above the checkout on your machine is a config the engine cannot
 * see. Such an unpinned file is absent from the definition tree and may set the restore
 * sources, so the engine cannot tell which sources the repository uses.
 * Not seen: a path built from another property (`$(RepoRoot)eng/x.props`
 * counts by its extension). A file larger than PINNED_READ_MAX counts as
 * `not read`. Other files: none.
 */
export function unpinnedImports(path: string, text: string): string[] {
  if (fileKind(path) !== 'msbuild') return [];
  if (text.length > PINNED_READ_MAX) return [`not read (larger than ${PINNED_READ_MAX / 1024} KB)`];
  const out = new Set<string>();
  for (const v of attributeValues(scanXml(text).tags, 'Import', 'Project')) {
    // MSBuild splits on a literal `;` only: an escaped `%3B` stays in its part.
    for (const raw of v.split(';').map((s) => s.trim()).filter(Boolean)) {
      const part = msbuildUnescape(raw).trim();
      const above = FILE_ABOVE.exec(part);
      const name = above ? (above[1] ?? above[2]).trim() : part;
      const local = above ? null : THIS_DIR_PATH.exec(part);
      const outside = above ? /^(?:[a-z]:|[\\/])|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(name) : local ? leavesRepository(path, local[1]) : false;
      if (hasNodeModulesSegment(part) || outside || !PINNED_IMPORT.test(name)) out.add(raw.slice(0, 200));
    }
  }
  return [...out];
}

/**
 * The MSBuild project SDKs a pinned file has NuGet resolve (M3): a
 * versioned `Sdk="<name>/<version>"` on `Project` or `Import` (a `;` list
 * too), an `Sdk` element or `Import` with `Name` and `Version`, or a
 * `global.json` `msbuild-sdks` entry. NuGet's MSBuild SDK resolver reads
 * NuGet's own config hierarchy (it ignores RestoreConfigFile). An
 * unversioned `Sdk="Microsoft.NET.Sdk"` is the dotnet SDK's own and does
 * not count. A file larger than PINNED_READ_MAX is not read (none).
 */
export function projectSdkMentions(path: string, text: string): string[] {
  const kind = fileKind(path);
  if (text.length > PINNED_READ_MAX) return [];
  const out = new Set<string>();
  if (kind === 'msbuild') {
    const { tags } = scanXml(text);
    for (const t of tags) {
      if (t.close) continue;
      const name = t.name.toLowerCase();
      const attr = (a: string) => t.attrs.find(([n]) => n.toLowerCase() === a)?.[1];
      const sdk = name === 'project' || name === 'import' ? attr('sdk') : undefined;
      if (sdk) for (const s of decodeXml(sdk).split(';')) if (s.includes('/')) out.add(s.trim());
      if (sdk && attr('version')) out.add(`${decodeXml(sdk).trim()}/${decodeXml(attr('version')!).trim()}`);
      if (name === 'sdk' && attr('name') && attr('version')) out.add(`${decodeXml(attr('name')!).trim()}/${decodeXml(attr('version')!).trim()}`);
    }
  } else if (kind === 'global') {
    let parsed: unknown;
    try { parsed = parseJsonc(text); } catch { parsed = undefined; }
    const sdks = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)['msbuild-sdks'] : undefined;
    if (sdks && typeof sdks === 'object') for (const [k, v] of Object.entries(sdks as Record<string, unknown>)) out.add(`${k}/${String(v)}`);
    else if (!(parsed && typeof parsed === 'object') && /"msbuild-sdks"/i.test(text)) out.add('msbuild-sdks (global.json)');
  }
  return [...out].sort();
}
