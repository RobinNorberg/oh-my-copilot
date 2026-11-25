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
import { scanXml } from '../../copilot-run/xml-scan.js';
/** Above this size a pinned file is not read: its references are unknown (nodeModulesReferences counts one; L1). */
export const PINNED_READ_MAX = 256 * 1024;
/** The XML entities an attribute value can use (`&#x6E;ode_modules` reads as node_modules). */
function decodeXml(value) {
    return value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (whole, hex, dec, name) => {
        if (hex || dec) {
            const code = Number.parseInt(hex ?? dec, hex ? 16 : 10);
            return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
        }
        return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name.toLowerCase()] ?? whole;
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
export function hasNodeModulesSegment(value) {
    return value.split(/[\\/'"`,;:=@()[\]\s|]+/).some((s) => s.replace(/[. ]+$/, '').toLowerCase() === 'node_modules');
}
/** The decoded values of `attr` on every `<element ...>` tag of a scan (xml-scan.ts: comments skipped, linear), names in any case. */
function attributeValues(tags, element, attr) {
    const out = [];
    const el = element.toLowerCase();
    const at = attr.toLowerCase();
    for (const t of tags) {
        if (t.close || t.name.toLowerCase() !== el)
            continue;
        const a = t.attrs.find(([n]) => n.toLowerCase() === at);
        if (a)
            out.push(decodeXml(a[1]));
    }
    return out;
}
/** The contents of every double-quoted JSON string in `text` (escapes kept), in one forward pass; an unclosed one ends it. */
function jsonStrings(text) {
    const out = [];
    let i = text.indexOf('"');
    while (i >= 0) {
        let j = i + 1;
        while (j < text.length && text[j] !== '"')
            j += text[j] === '\\' ? 2 : 1;
        if (j >= text.length)
            break;
        out.push(text.slice(i + 1, j));
        i = text.indexOf('"', j + 1);
    }
    return out;
}
/** The `.cmd` / `.exe` / `.ps1` a package-manager shim may carry. */
const SHIM_EXT = String.raw `(?:\.(?:cmd|exe|ps1))?`;
/** Up to eight option tokens before a package manager's subcommand (`--yes`, `-y`, `--cwd web`, `--dir=web`); bounded so a scan stays linear. */
const PM_OPTIONS = String.raw `(?:\s+-{1,2}[\w-]+(?:=[^\s"'&|;]*|\s+[^\s"'&|;-][^\s"'&|;]*)?){0,8}`;
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
const NPX_RUN = new RegExp(String.raw `(?:^|[\s&|;(\x60"'\\/])(?:(?:npx|pnpx|bunx)${SHIM_EXT}|(?:npm${SHIM_EXT}["']?${PM_OPTIONS}\s+(?:exec|x))|(?:pnpm${SHIM_EXT}["']?${PM_OPTIONS}\s+(?:dlx|exec))|(?:yarn${SHIM_EXT}["']?${PM_OPTIONS}\s+(?:dlx|exec))|(?:bun${SHIM_EXT}["']?${PM_OPTIONS}\s+x))(?=[\s"'&|;)\x60]|$)`, 'i');
/**
 * A pure delete command, whole (M3): a shell built-in or system tool,
 * `rm`, `del`, `rd`, `rmdir` or `Remove-Item` (optionally `.exe`), then
 * only simple flags (`-rf`, `--force`, `/q`) and plain path arguments.
 * Not `rimraf` or a package runner (NPX_RUN; round 4): rimraf is a
 * node_modules binary found through PATH (`node_modules/.bin` first under
 * npm), and a package runner runs `node_modules/.bin/<x>` before anything
 * else, so either runs node_modules code and counts as a reference.
 */
const PURE_DELETE = /^(?:rm|del|rd|rmdir|remove-item)(?:\.exe)?(?:\s+(?:--?[a-z][a-z-]*|\/[a-z]|[\w.:\\/-]+))+$/i;
/** A value with MSBuild's `%XX` escapes unescaped (`%2e%2e` reads as `..`, `%3B` as `;`), as MSBuild does before it uses it. */
const msbuildUnescape = (value) => value.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16)));
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
function execRunText(command) {
    const run = msbuildUnescape(command);
    return !/[%$`&|;<>\r\n()]/.test(run) && PURE_DELETE.test(run.trim()) ? null : run;
}
/** The kind of a pinned file this module reads, by its basename, or null. */
function fileKind(path) {
    const base = (path.split('/').pop() ?? path).toLowerCase();
    if (base === 'nuget.config')
        return 'nuget';
    if (base === 'global.json')
        return 'global';
    if (base.endsWith('.rsp'))
        return 'rsp';
    if (base.endsWith('.sln'))
        return 'sln';
    if (base.endsWith('.slnx'))
        return 'slnx';
    if (base.endsWith('.slnf'))
        return 'slnf';
    if (/\.(?:[a-z0-9]*proj|props|targets|tasks|projitems|user)$/.test(base))
        return 'msbuild';
    return null;
}
/** True when this module reads a pinned definition file of that name (the others are never fetched). */
export const readsForNodeModulesRefs = (path) => fileKind(path) !== null;
/**
 * The references into a node_modules dir in one pinned definition file:
 * `<what> <value>` for each, in file order. `path` is its repository path
 * (its basename decides how it is read); `text` its bytes as UTF-8. A file
 * larger than PINNED_READ_MAX is not read: one reference, "not read",
 * so the caller treats its references as unknown (conservative). Every
 * scan is linear (L1).
 */
export function nodeModulesReferences(path, text) {
    const kind = fileKind(path);
    if (kind && text.length > PINNED_READ_MAX)
        return [`file larger than ${PINNED_READ_MAX / 1024} KB, not read (its references are unknown)`];
    const values = [];
    // References that count whatever their text names (an npx run: npx runs node_modules/.bin/<name> first).
    const always = [];
    if (kind === 'msbuild') {
        const { tags } = scanXml(text);
        for (const v of attributeValues(tags, 'Import', 'Project'))
            values.push(['Import Project', v]);
        for (const v of attributeValues(tags, 'ProjectReference', 'Include'))
            values.push(['ProjectReference Include', v]);
        for (const v of attributeValues(tags, 'UsingTask', 'AssemblyFile'))
            values.push(['UsingTask AssemblyFile', v]);
        // An inline task's code file (RoslynCodeTaskFactory compiles it).
        for (const v of attributeValues(tags, 'Code', 'Source'))
            values.push(['UsingTask Code Source', v]);
        // A command whose exit code decides the build, when it names a path under node_modules (`node node_modules/x/check.js`);
        // `npm install`, `npm ci` or `npm run build` name none, and a pure delete (`rm -rf node_modules`) reads nothing there.
        // An Exec's WorkingDirectory and EnvironmentVariables count as references too (`PATH=node_modules/.bin`), and with
        // either naming node_modules no Command is a pure delete (round 4).
        for (const t of tags) {
            if (t.close || t.name.toLowerCase() !== 'exec')
                continue;
            const attr = (name) => { const a = t.attrs.find(([n]) => n.toLowerCase() === name); return a ? decodeXml(a[1]) : undefined; };
            const where = ['workingdirectory', 'environmentvariables'].map((n) => [n, attr(n)]).filter(([, v]) => v !== undefined && hasNodeModulesSegment(v));
            for (const [n, v] of where)
                values.push([n === 'workingdirectory' ? 'Exec WorkingDirectory' : 'Exec EnvironmentVariables', v]);
            const command = attr('command');
            if (command === undefined)
                continue;
            const run = execRunText(command);
            if (run !== null && NPX_RUN.test(run))
                always.push(['Exec Command (npx runs node_modules/.bin)', run]);
            else if (run !== null)
                values.push(['Exec Command', run]);
            else if (where.length > 0)
                values.push(['Exec Command (run in or with node_modules)', `${command} [${where.map(([, v]) => v).join('; ')}]`]);
        }
    }
    else if (kind === 'rsp') {
        // A response file: every token outside `#` comment lines (`-logger:<dll>`, `-distributedlogger:...`, `@file`,
        // `-p:Name=<value>`; hasNodeModulesSegment reads `:`, `=` and `@` as boundaries).
        for (const line of text.split(/\r?\n/)) {
            if (line.trimStart().startsWith('#'))
                continue;
            for (const m of line.matchAll(/"([^"]*)"|(\S+)/g)) {
                const token = m[1] ?? m[2];
                values.push(['response file token', token]);
            }
        }
    }
    else if (kind === 'global') {
        // global.json `sdk.paths`: the dirs the SDK resolver looks in for an SDK.
        let parsed;
        try {
            parsed = parseJsonc(text);
        }
        catch {
            parsed = undefined;
        }
        if (parsed && typeof parsed === 'object') {
            const paths = parsed.sdk?.paths;
            if (Array.isArray(paths))
                for (const p of paths)
                    if (typeof p === 'string')
                        values.push(['global.json sdk.paths', p]);
        }
        else {
            // Not JSON the SDK would read the same way: every string in it, conservatively.
            for (const s of jsonStrings(text))
                values.push(['global.json string', s]);
        }
    }
    else if (kind === 'slnx') {
        for (const v of attributeValues(scanXml(text).tags, 'Project', 'Path'))
            values.push(['solution project', v]);
    }
    else if (kind === 'sln') {
        // `Project("{type guid}") = "Name", "path\to\App.csproj", "{project guid}"`: one line each (no match spans lines).
        for (const m of text.matchAll(/^[ \t]*Project[ \t]*\([^)\r\n]*\)[ \t]*=[ \t]*"[^"\r\n]*"[ \t]*,[ \t]*"([^"\r\n]*)"/gim))
            values.push(['solution project', m[1]]);
    }
    else if (kind === 'slnf') {
        let parsed;
        try {
            parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
        }
        catch {
            parsed = undefined;
        }
        const solution = parsed?.solution;
        if (solution && typeof solution === 'object') {
            if (typeof solution.path === 'string')
                values.push(['solution filter path', solution.path]);
            if (Array.isArray(solution.projects))
                for (const p of solution.projects)
                    if (typeof p === 'string')
                        values.push(['solution filter project', p]);
        }
        else {
            // Not JSON MSBuild would read the same way: every string in it, conservatively.
            for (const s of jsonStrings(text))
                values.push(['solution filter string', s]);
        }
    }
    else if (kind === 'nuget') {
        // A local source or fallback folder: any `<add value="...">` that is not an http(s) feed.
        for (const v of attributeValues(scanXml(text).tags, 'add', 'value'))
            if (!/^https?:\/\//i.test(v.trim()))
                values.push(['nuget.config value', v]);
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
 * itself, so the engine writes no root-config copy with nuget.org
 * (dotnet-sandbox.ts nugetOrgCopy; an extra signal that can only restrict:
 * such a setting overrides the copy's config source anyway).
 * Conservative: a comment or a condition counts, and a file larger than
 * PINNED_READ_MAX counts as `not read`. Other files: none.
 */
export function restoreSettingMentions(path, text) {
    const kind = fileKind(path);
    if (kind !== 'msbuild' && kind !== 'rsp')
        return [];
    if (text.length > PINNED_READ_MAX)
        return [`not read (larger than ${PINNED_READ_MAX / 1024} KB)`];
    return [...new Set([...text.matchAll(RESTORE_SETTINGS)].map((m) => m[0]))].sort();
}
/** An `Import Project` value (one `;` part, trimmed) that names a pinned definition file: it ends, textually, in one of their MSBuild extensions. */
const PINNED_IMPORT = /\.(?:[a-z0-9]*proj|props|targets|tasks|projitems|user)$/i;
/** `$(MSBuildThisFileDirectory)` optionally followed by `..` segments (`..`, `../..`, `..\`): the importing file's dir or one above it. */
const THIS_DIR_UP = String.raw `\$\(MSBuildThisFileDirectory\)((?:\.\.(?:[\\/]\.\.)*)?)[\\/]?`;
/**
 * `$([MSBuild]::GetPathOfFileAbove('<name>'[, <start>]))`: a file of that literal name, so it counts by that name's
 * extension; `<start>` (quoted or not) only as THIS_DIR_UP. Groups: the name (quoted, bare), the `..` part (quoted, bare).
 */
const FILE_ABOVE = new RegExp(String.raw `^\$\(\[MSBuild\]::GetPathOfFileAbove\(\s*(?:'([^'$%@()]+)'|([^'"$%@(),\s]+))\s*(?:,\s*(?:'${THIS_DIR_UP}'|${THIS_DIR_UP})\s*)?\)\)$`, 'i');
/** An Import path relative to the importing file's dir: literal, or after `$(MSBuildThisFileDirectory)` and any separators (it ends in one). Group: the relative path. */
const THIS_DIR_PATH = /^(?:\$\(MSBuildThisFileDirectory\)[\\/]*)?([^$@%*?]*)$/i;
/**
 * True when `rel` (a path relative to the dir of the repository file
 * `path`, `\` read as `/`) is absolute or climbs above the repository root.
 */
function leavesRepository(path, rel) {
    const r = rel.replace(/\\/g, '/');
    if (/^(?:[a-z]:|\/)/i.test(r))
        return true;
    let depth = path.split('/').length - 1;
    for (const seg of r.split('/')) {
        if (seg === '..')
            depth--;
        else if (seg !== '' && seg !== '.')
            depth++;
        if (depth < 0)
            return true;
    }
    return false;
}
/**
 * The `Import Project` values of a pinned MSBuild file that do not name a
 * pinned definition file (M2): each `;` part of the decoded value, `%XX`
 * unescaped as MSBuild does, that
 * - has a `node_modules` path segment (any case, `\` or `/`): such a file
 *   is never pinned (the engine does not read node_modules trees);
 * - holds a wildcard (`*` or `?`) anywhere: MSBuild imports every match,
 *   which may include files that are not pinned;
 * - does not end, textually, in `.props`, `.targets`, `.tasks`,
 *   `.projitems`, `.user` or a `*proj` extension, including one that ends
 *   in a property reference (`$(X)`);
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
export function unpinnedImports(path, text) {
    if (fileKind(path) !== 'msbuild')
        return [];
    if (text.length > PINNED_READ_MAX)
        return [`not read (larger than ${PINNED_READ_MAX / 1024} KB)`];
    const out = new Set();
    for (const v of attributeValues(scanXml(text).tags, 'Import', 'Project')) {
        // MSBuild splits on a literal `;` only: an escaped `%3B` stays in its part.
        for (const raw of v.split(';').map((s) => s.trim()).filter(Boolean)) {
            const part = msbuildUnescape(raw).trim();
            const above = FILE_ABOVE.exec(part);
            const name = above ? (above[1] ?? above[2]).trim() : part;
            const local = above ? null : THIS_DIR_PATH.exec(part);
            const outside = above ? /^(?:[a-z]:|[\\/])|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(name) : local ? leavesRepository(path, local[1]) : false;
            if (hasNodeModulesSegment(part) || /[*?]/.test(part) || outside || !PINNED_IMPORT.test(name))
                out.add(raw.slice(0, 200));
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
export function projectSdkMentions(path, text) {
    const kind = fileKind(path);
    if (text.length > PINNED_READ_MAX)
        return [];
    const out = new Set();
    if (kind === 'msbuild') {
        const { tags } = scanXml(text);
        for (const t of tags) {
            if (t.close)
                continue;
            const name = t.name.toLowerCase();
            const attr = (a) => t.attrs.find(([n]) => n.toLowerCase() === a)?.[1];
            const sdk = name === 'project' || name === 'import' ? attr('sdk') : undefined;
            if (sdk)
                for (const s of decodeXml(sdk).split(';'))
                    if (s.includes('/'))
                        out.add(s.trim());
            if (sdk && attr('version'))
                out.add(`${decodeXml(sdk).trim()}/${decodeXml(attr('version')).trim()}`);
            if (name === 'sdk' && attr('name') && attr('version'))
                out.add(`${decodeXml(attr('name')).trim()}/${decodeXml(attr('version')).trim()}`);
        }
    }
    else if (kind === 'global') {
        let parsed;
        try {
            parsed = parseJsonc(text);
        }
        catch {
            parsed = undefined;
        }
        const sdks = parsed && typeof parsed === 'object' ? parsed['msbuild-sdks'] : undefined;
        if (sdks && typeof sdks === 'object')
            for (const [k, v] of Object.entries(sdks))
                out.add(`${k}/${String(v)}`);
        else if (!(parsed && typeof parsed === 'object') && /"msbuild-sdks"/i.test(text))
            out.add('msbuild-sdks (global.json)');
    }
    return [...out].sort();
}
/**
 * NuGet's restore properties that name package sources, folders or the
 * config NuGet reads (restoreHostReads' source settings). Not
 * `RestorePackagesPath`: the global packages folder is where packages land,
 * not where they come from.
 */
const RESTORE_SOURCE_SETTING = /^Restore(?:Sources|AdditionalProjectSources|FallbackFolders|AdditionalProjectFallbackFolders|ConfigFile|RootConfigDirectory)$/i;
/**
 * The properties through which the SDK imports a file (Microsoft.Common.props/targets, Microsoft.Common.CrossTargeting,
 * Microsoft.CSharp, Microsoft.VisualBasic and Microsoft.FSharp targets, Directory.Build.props/targets,
 * Directory.Packages.props): a definition of one is an Import whose path is its value; an `Import*` switch turns its
 * Directory file (HOOK_SWITCH) on or off.
 */
const IMPORT_HOOK = /^(?:Custom(?:Before|After)(?:MicrosoftCommon|MicrosoftCommonCrossTargeting|MicrosoftCSharp|MicrosoftVisualBasic|MicrosoftFSharp|DirectoryBuild)(?:Props|Targets)|Directory(?:BuildProps|BuildTargets|PackagesProps)Path|ImportDirectory(?:BuildProps|BuildTargets|PackagesProps))$/i;
const HOOK_SWITCH = { importdirectorybuildprops: 'Directory.Build.props', importdirectorybuildtargets: 'Directory.Build.targets', importdirectorypackagesprops: 'Directory.Packages.props' };
/**
 * An Sdk an Import may load with no file of the repository (a `/version` suffix allowed): the .NET SDK's own
 * (`Microsoft.NET.Sdk`, `Microsoft.NET.Sdk.<name>`) and `Microsoft.Build.<name>` SDKs.
 */
const PLAIN_SDK = /^\s*(?:Microsoft\.NET\.Sdk(?:\.[^\s/;]+)?|Microsoft\.Build\.[^\s/;]+)\s*(?:\/[^;]*)?$/i;
/** The Arcade SDK (its `Sdk` name, a `/version` suffix allowed). */
const ARCADE_SDK = /^\s*Microsoft\.DotNet\.Arcade\.Sdk\s*(?:\/[^;]*)?$/i;
/** Properties the Arcade SDK defines: reserved only in a repository that uses it (msbuildReads). */
const ARCADE_PROPERTIES = /^(?:RepositoryEngineeringDir|RepoRoot|RepositoryRoot|ArtifactsDir|ArtifactsBinDir|ArtifactsObjDir|ArtifactsPackagesDir|DotNetRoot|DotNetTool|ArcadeSdk\w*)$/i;
/** The .NET project files and auto-imported files whose evaluation rule (c)'s undefined-name clause covers (msbuildReads). */
const DOTNET_EVALUATED = /(?:^|\/)(?:[^/]+\.(?:cs|fs|vb)proj|directory\.build\.props|directory\.build\.targets|directory\.packages\.props|directory\.build\.rsp)$/i;
/** A literal relative path piece (no property, item, wildcard, quote, parenthesis, comma or `;`). */
const LITERAL_PIECE = /^[^$@%*?'"(),;]*$/;
/**
 * The path relative to the defining file's dir that a property value names (`/`-joined, leading separators dropped):
 * `$(MSBuildThisFileDirectory)` plus a relative literal path, or `$([MSBuild]::NormalizeDirectory(...))` (its first
 * argument that, the others relative literals) / `EnsureTrailingSlash(...)` of that, plus a literal path; else null.
 */
function thisDirDef(value) {
    const v = value.trim();
    const plain = /^\$\(MSBuildThisFileDirectory\)(.*)$/i.exec(v);
    let pieces;
    if (plain)
        pieces = [plain[1]];
    else {
        const fn = /^\$\(\[MSBuild\]::(NormalizeDirectory|EnsureTrailingSlash)\((.*)\)\)([^()]*)$/i.exec(v);
        if (!fn)
            return null;
        const args = fn[2].split(',').map((a) => a.trim().replace(/^'(.*)'$/, '$1').trim());
        const first = /^\$\(MSBuildThisFileDirectory\)(.*)$/i.exec(args[0]);
        if (!first || (args.length > 1 && fn[1].toLowerCase() !== 'normalizedirectory'))
            return null;
        // A later absolute argument would replace the path before it (Path.Combine).
        if (args.slice(1).some((a) => /^(?:[a-z]:|[\\/])/i.test(a)))
            return null;
        pieces = [first[1], ...args.slice(1), fn[3]];
    }
    if (!pieces.every((p) => LITERAL_PIECE.test(p)))
        return null;
    return pieces.map((p) => p.trim().replace(/^[\\/]+/, '')).filter(Boolean).join('/');
}
/**
 * Properties MSBuild, the .NET SDK, NuGet or Visual Studio define (lower
 * case; `MSBuild*` and NuGet's generated `Pkg*` path properties by prefix):
 * a reference to one is not a read of your environment. Never CI variables
 * (`CI`, `TF_BUILD`, `GITHUB_ACTIONS`, `BUILD_*`) or profile names
 * (`USERPROFILE`, `HOME`, `USERDOMAIN`, `APPDATA`): your environment sets those.
 */
const RESERVED_PROPERTIES = new Set([
    'configuration', 'platform', 'platforms', 'platformtarget', 'platformname', 'targetframework', 'targetframeworks', 'targetframeworkidentifier', 'targetframeworkversion',
    'targetframeworkmoniker', 'targetframeworkprofile', 'targetplatformidentifier', 'targetplatformversion', 'targetplatformminversion', 'supportedosplatformversion',
    'runtimeidentifier', 'runtimeidentifiers', 'os',
    'outputpath', 'outdir', 'intermediateoutputpath', 'baseintermediateoutputpath', 'baseoutputpath', 'projectdir', 'projectname',
    'projectpath', 'projectfilename', 'projectext', 'solutiondir', 'solutionname', 'solutionpath', 'solutionfilename', 'solutionext',
    'targetname', 'targetpath', 'targetdir', 'targetext', 'targetfilename', 'assemblyname', 'rootnamespace', 'artifactspath', 'useartifactsoutput',
    'appendtargetframeworktooutputpath', 'appendruntimeidentifiertooutputpath', 'packageoutputpath', 'documentationfile',
    'nugetpackageroot', 'nugetpackagefolders', 'nugetprojectstyle', 'nugettargetmoniker', 'netcoresdkversion', 'netcoresdkruntimeidentifier', 'netcoreroot',
    'netcoretargetingpackroot', 'bundlednetcoreapppackageversion', 'bundlednetcoreapptargetframeworkversion', 'netcoreappmaximumversion', 'microsoftnetcoreapprefpackageversion',
    'dotnet_host_path', 'visualstudioversion', 'vstoolspath', 'designtimebuild',
    'buildinginsidevisualstudio', 'buildingforliveunittesting', 'buildingproject', 'buildingsolutionfile', 'buildprojectreferences', 'isimplicitlytriggeredbuild',
    'language', 'defineconstants', 'langversion', 'nullable', 'implicitusings',
    'version', 'versionprefix', 'versionsuffix', 'packageversion', 'assemblyversion', 'fileversion', 'informationalversion', 'packageid',
    'authors', 'company', 'product', 'copyright', 'description', 'neutrallanguage', 'ispackable', 'ispublishable', 'istestproject', 'istestingplatformapplication',
    'isaspirehost', 'ispublishing', '_ispublishing',
    'outputtype', 'iscrosstargetingbuild', 'usingmicrosoftnetsdk', 'usingmicrosoftnetsdkweb', 'usingmicrosoftnetsdkrazor', 'usingmicrosoftnetsdkworker',
    'usingmicrosoftnetsdkblazorwebassembly', 'usingmicrosoftnetsdkwebassembly', 'usingmicrosoftnetsdkstaticwebassets', 'excluderestorepackageimports', 'restoregraphoutputpath', 'restoreprojectstyle',
    'enabledefaultitems', 'enabledefaultcompileitems', 'defaultitemexcludes', 'importdirectorybuildprops', 'importdirectorybuildtargets', 'sdkanalysislevel',
    'usemaui', 'mauiversion', 'prefer32bit',
    'selfcontained', 'publishtrimmed', 'publishaot', 'publishsinglefile', 'publishreadytorun', 'useapphost', 'isaotcompatible', 'istrimmable',
    'usewpf', 'usewindowsforms', 'enablewindowstargeting', 'invariantglobalization',
    'optimize', 'debugtype', 'debugsymbols', 'deterministic', 'warninglevel', 'nowarn', 'warningsaserrors', 'warningsnotaserrors', 'treatwarningsaserrors',
    'generatedocumentationfile', 'generateassemblyinfo', 'generatepackageonbuild', 'signassembly', 'analysislevel', 'analysismode',
    'enablenetanalyzers', 'enforcecodestyleinbuild', 'runanalyzers', 'runanalyzersduringbuild',
    'managepackageversionscentrally', 'centralpackagetransitivepinningenabled', 'restorepackageswithlockfile', 'restorelockedmode',
    'restoreusestaticgraphevaluation', 'nugetaudit', 'nugetauditmode', 'nugetauditlevel',
    // Other project kinds' toolsets: C++ (.vcxproj), SSDT (.sqlproj), WiX (.wixproj).
    'vctargetspath', 'userrootdir', 'sqldbextensionsrefpath', 'wixtargetspath',
]);
/** True when `name` is a property MSBuild or the SDK defines (RESERVED_PROPERTIES). */
export const isReservedProperty = (name) => /^MSBuild/i.test(name) || /^Pkg[A-Za-z_]/.test(name) || RESERVED_PROPERTIES.has(name.toLowerCase());
/** Names your user profile sets (an Import path that reads one picks a file of your machine, restoreHostReads rule c). */
const PROFILE_ENV = /^(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|USERNAME|USERDOMAIN|ALLUSERSPROFILE|PROGRAMDATA|XDG_\w+)$/i;
/** Variables a CI system sets. */
const CI_ENV = /^(?:CI|TF_BUILD|GITHUB_\w+|BUILD_\w+|SYSTEM_\w+|AGENT_\w+|RUNNER_\w+|GITLAB_CI|JENKINS_URL|TEAMCITY_VERSION|APPVEYOR|TRAVIS)$/i;
/**
 * True when `name` is one your CI system or user profile sets (`CI`,
 * `TF_BUILD`, `GITHUB_*`, `BUILD_*`, `SYSTEM_*`, `HOME`, `USERPROFILE`, ...):
 * a value a repository should not pin, so the park's remedy is to move the
 * source setting out from under it rather than to give it a value.
 */
export const isEnvironmentOnlyName = (name) => CI_ENV.test(name) || PROFILE_ENV.test(name);
/** `$(Name` (a property, a property function on it, or `$(Registry:`). Group 1: the name; group 2: a `:` after it. */
const PROPERTY_REF = /\$\(\s*([A-Za-z_][A-Za-z0-9_-]*)\s*(:?)/g;
/** A property function that reads the host: the environment, a user-profile folder, the registry, the user or machine name. Groups 3-5: a literal variable name. */
const HOST_READ = /\b(GetEnvironmentVariables?|ExpandEnvironmentVariables|GetFolderPath|GetRegistryValue(?:FromView)?|(?<=::\s*)(?:UserDomainName|UserName|MachineName))\b(\s*\(\s*(?:'([A-Za-z_][\w-]*)'|"([A-Za-z_][\w-]*)"|([A-Za-z_][\w-]*))\s*\))?/gi;
/** A word every HOST_READ match holds (a cheap test before it). */
const HOST_READ_HINT = /Environment|FolderPath|Registry|User|MachineName/i;
/** `%NAME%`: an environment variable NuGet (a config value) or MSBuild (a response file) expands. The closing `%` is not consumed: it may open the next one. */
const ENV_PERCENT = /%([A-Za-z_][A-Za-z0-9_]*)(?=%)/g;
/** `@(Name` or `%(Name`: an item list or item metadata (the engine does not follow items). Group 1: the sigil; group 2: the item type (or metadata name). */
const ITEM_REF = /([@%])\(\s*([A-Za-z_]\w*)?/g;
/**
 * The names an MSBuild expression reads: each `$(Name)` as `Name`, and
 * host reads as pseudo-names in brackets (`[env NAME]` for a literal
 * GetEnvironmentVariable, `[env ?]` for a computed one, `[registry]`,
 * `[GetFolderPath]`, ...). With `percent`, `%NAME%` counts as `[env NAME]`;
 * a two-hex-digit name (`%AB%`) counts too unless it is part of a run of
 * `%XX` escapes (`%C3%A9`: an escape just before it, or one starting at
 * its closing `%`).
 */
export function expressionRefs(expr, percent = false) {
    const out = new Set();
    // Property references and property functions need a `$(`; item lists a `@(`, item metadata a `%(`; `%NAME%` a `%`.
    if (!expr.includes('$(') && !expr.includes('@(') && !expr.includes('%(') && !(percent && expr.includes('%')))
        return [];
    for (const m of expr.matchAll(PROPERTY_REF))
        out.add(m[2] && m[1].toLowerCase() === 'registry' ? '[registry]' : m[1]);
    for (const m of expr.matchAll(ITEM_REF))
        out.add(`[${m[1] === '@' ? 'item' : 'metadata'} ${m[2] ?? '?'}]`);
    if (HOST_READ_HINT.test(expr))
        for (const m of expr.matchAll(HOST_READ)) {
            const literal = m[3] ?? m[4] ?? m[5];
            out.add(m[1].toLowerCase() === 'getenvironmentvariable' ? `[env ${literal ?? '?'}]` : `[${m[1]}]`);
        }
    if (percent) {
        for (const m of expr.matchAll(ENV_PERCENT)) {
            const at = m.index ?? 0;
            const close = at + 1 + m[1].length;
            if (/^[0-9a-f]{2}$/i.test(m[1]) && (/%[0-9a-f]{2}$/i.test(expr.slice(Math.max(0, at - 3), at)) || /^%[0-9a-f]{2}/i.test(expr.slice(close, close + 3))))
                continue;
            out.add(`[env ${m[1]}]`);
        }
    }
    return [...out];
}
/** `rel` (relative to the dir of the repository file `path`) as a repository path, `\` read as `/`, `.` and `..` resolved. */
function repoPath(path, rel) {
    const out = path.split('/').slice(0, -1);
    for (const seg of rel.replace(/\\/g, '/').split('/')) {
        if (seg === '..')
            out.pop();
        else if (seg !== '' && seg !== '.')
            out.push(seg);
    }
    return out.join('/');
}
/**
 * The files an Import's `Project` value names (each `;` part, `%XX`
 * unescaped): a literal path or one from `$(MSBuildThisFileDirectory)`
 * inside the repository, or `GetPathOfFileAbove('<name>'[, <start>])`
 * from `$(MSBuildThisFileDirectory)` plus `..` segments, or `$(P)` plus a
 * literal path when `dirOf(P)` gives P's repository dir; null when a part
 * is anything else (another property, a wildcard, an absolute path, one
 * above the repository root).
 */
function importTargets(path, project, dirOf) {
    const out = [];
    for (const raw of project.split(';')) {
        const part = msbuildUnescape(raw).trim();
        if (!part)
            continue;
        const via = /^\$\(\s*([A-Za-z_][\w-]*)\s*\)([^$@%*?]*)$/.exec(part);
        if (via && via[1].toLowerCase() !== 'msbuildthisfiledirectory') {
            const base = dirOf(via[1]);
            const file = base === null ? '' : base ? `${base}/_` : '_';
            if (base === null || leavesRepository(file, via[2]))
                return null;
            out.push({ path: repoPath(file, via[2]) });
            continue;
        }
        const above = FILE_ABOVE.exec(part);
        if (above) {
            const name = (above[1] ?? above[2]).trim();
            const up = above[3] ?? above[4] ?? '';
            if (/[\\/]/.test(name) || (up && leavesRepository(path, `${up}/x`)))
                return null;
            out.push({ above: name, from: repoPath(path, up || '.') });
            continue;
        }
        const local = THIS_DIR_PATH.exec(part);
        if (!local || !local[1] || leavesRepository(path, local[1]))
            return null;
        out.push({ path: repoPath(path, local[1]) });
    }
    return out;
}
/**
 * The property data flow of a pinned MSBuild file (one linear scan) or
 * response file (its `-p:` / `-property:` / `-rp:` / `-restoreProperty:`
 * global properties, with `-`, `--` or `/`, separated by `;` or `,`,
 * outside `#` comment lines; they define names unconditionally, and
 * MSBuild expands `%NAME%` there from the environment). Other files:
 * nothing. A file larger than PINNED_READ_MAX: `unread`.
 */
export function propertyFlow(path, text) {
    const kind = fileKind(path);
    const defs = [];
    const roots = [];
    // Equal lists of names are shared (never mutated): a file of thousands of alike Imports keeps one list per shape.
    const lists = new Map();
    const shared = (xs) => {
        const key = xs.join('\n');
        const was = lists.get(key);
        if (was)
            return was;
        lists.set(key, xs);
        return xs;
    };
    // The conditions of alike Imports repeat: each distinct one is read once.
    const conditions = new Map();
    const conditionRefs = (c) => {
        let refs = conditions.get(c);
        if (!refs)
            conditions.set(c, (refs = shared(expressionRefs(c))));
        return refs;
    };
    /** A property definition: `valueRefs` what its value reads, `cond` its enclosing conditions' reads, `value` its value. */
    const define = (name, at, unconditional, valueRefs, cond, value) => {
        const refs = cond.length > 0 ? shared([...valueRefs, ...cond]) : valueRefs;
        const dir = unconditional && value !== undefined ? thisDirDef(value) : null;
        defs.push({ name, at, unconditional, refs, ...(dir !== null ? { dir } : {}) });
        if (RESTORE_SOURCE_SETTING.test(name))
            roots.push({ kind: 'setting', value: name, at, refs, cond: [], conditional: !unconditional, sdk: null });
        else if (value !== undefined && IMPORT_HOOK.test(name)) {
            roots.push({ kind: 'import', value: HOOK_SWITCH[name.toLowerCase()] ?? value, at, refs: valueRefs, cond, conditional: !unconditional, sdk: null, hook: name });
        }
    };
    if ((kind === 'rsp' || kind === 'msbuild') && text.length > PINNED_READ_MAX)
        return { defs, roots, unread: true };
    if (kind === 'rsp') {
        let offset = 0;
        for (const line of text.split('\n')) {
            if (!line.trimStart().startsWith('#')) {
                for (const m of line.matchAll(/(?:[^\s"]|"[^"]*"?)+/g)) {
                    const sw = /^(?:--?|\/)(?:p|property|rp|restoreproperty):([\s\S]*)$/i.exec(m[0].replace(/"/g, ''));
                    if (!sw)
                        continue;
                    // A quoted value may hold `;` (`-p:RestoreSources="a;%B%"`): each name the switch defines reads every `%NAME%` in it.
                    const env = expressionRefs(sw[1], true).filter((r) => r.startsWith('[env '));
                    for (const part of sw[1].split(/[;,]/)) {
                        const eq = part.indexOf('=');
                        const name = (eq < 0 ? part : part.slice(0, eq)).trim();
                        if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name))
                            define(name, offset + (m.index ?? 0), true, eq < 0 ? [] : env, [], eq < 0 ? undefined : part.slice(eq + 1));
                    }
                }
            }
            offset += line.length + 1;
        }
        return { defs, roots, unread: false };
    }
    if (kind !== 'msbuild')
        return { defs, roots, unread: false };
    const attr = (t, name) => {
        const a = t.attrs.find(([n]) => n.toLowerCase() === name);
        return a ? decodeXml(a[1]) : undefined;
    };
    const finish = (f, content) => {
        if (f.parent.toLowerCase() !== 'propertygroup')
            return;
        const value = decodeXml(content);
        define(f.tag.name, f.tag.start, !f.conditioned, shared(expressionRefs(value)), f.cond, value);
    };
    const stack = [];
    for (const t of scanXml(text).tags) {
        if (t.close) {
            const top = stack[stack.length - 1];
            if (top && top.tag.name === t.name) {
                stack.pop();
                finish(top, text.slice(top.tag.end, t.start));
            }
            continue;
        }
        const parent = stack[stack.length - 1];
        const condition = attr(t, 'condition');
        const name = t.name.toLowerCase();
        const own = condition !== undefined ? conditionRefs(condition) : [];
        // A Choose's Otherwise applies when none of its Whens does: it reads their conditions.
        if (name === 'when' && parent?.tag.name.toLowerCase() === 'choose')
            parent.whens.push(...own);
        const f = {
            tag: t,
            parent: parent?.tag.name ?? '',
            cond: parent?.cond ?? [],
            conditioned: (parent?.conditioned ?? false) || condition !== undefined || name === 'when' || name === 'otherwise' || name === 'target',
            whens: [],
        };
        const reads = [...own, ...(name === 'otherwise' ? parent?.whens ?? [] : [])];
        // A self-closed element encloses nothing: its own conditions go on it directly.
        if (reads.length > 0 && t.selfClose)
            f.cond = shared([...new Set(reads), ...f.cond]);
        else if (reads.length > 0) {
            const pseudo = `#${t.start}@${path}`;
            defs.push({ name: pseudo, at: t.start, unconditional: false, refs: [...new Set(reads), ...f.cond] });
            f.cond = [pseudo];
        }
        if (name === 'import') {
            const project = attr(t, 'project') ?? '';
            roots.push({ kind: 'import', value: project, at: t.start, refs: shared(expressionRefs(project)), cond: f.cond, conditional: f.conditioned, sdk: attr(t, 'sdk') ?? null });
        }
        // The implicit imports of `<Project Sdk="A;B">` and of a top-level `<Sdk Name="X" />`: an unconditional Import of each
        // SDK's files (a PLAIN_SDK loads nothing of the repository: no root).
        const sdks = !parent && name === 'project' ? attr(t, 'sdk') : name === 'sdk' && parent?.tag.name.toLowerCase() === 'project' && stack.length === 1 ? attr(t, 'name') : undefined;
        for (const s of sdks?.split(';') ?? []) {
            const sdk = s.split('/')[0].trim();
            if (sdk && !PLAIN_SDK.test(sdk))
                roots.push({ kind: 'import', value: 'Sdk.props', at: t.start, refs: [], cond: [], conditional: false, sdk });
        }
        // A task's Output that sets a property: the task's attribute values flow into it (inside a target: never unconditional).
        const output = name === 'output' ? attr(t, 'propertyname') : undefined;
        if (output !== undefined && parent)
            define(msbuildUnescape(output).trim(), t.start, false, [...new Set(parent.tag.attrs.flatMap(([, v]) => expressionRefs(decodeXml(v))))], f.cond);
        if (t.selfClose)
            finish(f, '');
        else
            stack.push(f);
    }
    return { defs, roots, unread: false };
}
/** A pseudo-name of expressionRefs in words. */
function hostReadWords(ref) {
    if (ref === '[env ?]')
        return 'an environment variable whose name is computed';
    if (ref.startsWith('[env '))
        return `the environment variable ${ref.slice(5, -1)}`;
    if (ref === '[registry]' || /^\[GetRegistryValue/i.test(ref))
        return 'the registry';
    if (ref.startsWith('[metadata '))
        return `the item metadata %(${ref.slice(10, -1)}), and the engine does not follow items into a package-source setting (list the sources as a property or in nuget.config)`;
    if (ref.startsWith('[item '))
        return `the item list @(${ref.slice(6, -1)}), and the engine does not follow items into a package-source setting (list the sources as a property or in nuget.config)`;
    return /^\[(?:UserDomainName|UserName|MachineName)\]$/i.test(ref) ? `$([System.Environment]::${ref.slice(1, -1)})` : `$([System.Environment]::${ref.slice(1, -1)}(...))`;
}
/** The most reads restoreHostReads lists (the rest are counted in `more`). */
export const RESTORE_READS_MAX = 50;
/**
 * restoreHostReads' work budget: the import steps it may take (each Import or source setting it reads and each one it
 * checks, each import edge it follows, each file it adds to an import closure, each step of an upward file search and
 * each definition of a name rule (b) follows, and each defining or evaluation file it compares to decide whether a
 * definition is in a reading file's evaluation). Past it the restore parks ("too many imports to analyse").
 */
export const RESTORE_WORK_MAX = 100_000;
/** True when a pinned file's text, decoded as UTF-8, is not UTF-8 text: a UTF-16 byte order mark (two replacement characters) or a NUL in its first KB. */
const notUtf8 = (text) => text.startsWith('��') || text.slice(0, 1024).includes('\0');
/** The auto-imported files MSBuild finds nearest above a project (each the nearest one only), and the response file it auto-reads. */
const AUTO_FILES = ['directory.build.props', 'directory.build.targets', 'directory.packages.props', 'directory.build.rsp'];
/** Thrown when restoreHostReads spends more than RESTORE_WORK_MAX import steps. */
class OverBudget extends Error {
}
/**
 * Whether a commit's package-source settings depend on your environment or
 * machine (engine.ts nugetRestore parks before the network opens on any
 * read). `files` are its pinned definition files (MSBuild, response and
 * nuget.config files; others are ignored).
 *
 * The evaluation of a file F is F, the nearest `Directory.Build.props`,
 * `Directory.Build.targets`, `Directory.Packages.props` and
 * `Directory.Build.rsp` at or above F's dir (the nearest one only, as
 * MSBuild finds them), and every pinned file those import with no
 * condition and no conditioned group, `Choose` branch or target around the
 * Import, transitively, by a path importTargets resolves to a pinned file
 * (a `GetPathOfFileAbove` search included, so a nested
 * `Directory.Build.props` that imports the next one up brings it in; a
 * `$(P)` path when P's only pinned definition is unconditional and names
 * its file's dir, as `<RepoRoot>$(MSBuildThisFileDirectory)</RepoRoot>`
 * does). An SDK import hook (IMPORT_HOOK: `CustomAfterMicrosoftCommonTargets`,
 * `DirectoryBuildTargetsPath`, `ImportDirectoryBuildTargets`, ...) is an
 * Import of the file its value names (for an `Import*` switch: the nearest
 * Directory file of its kind at or above its file's dir) under the
 * definition's conditions. An `Sdk` Import, and the implicit one of each SDK
 * of `<Project Sdk="A;B">` and of a top-level `<Sdk Name="X" />` (no
 * condition), loads nothing of the repository for a PLAIN_SDK and a file the
 * engine cannot resolve for any other SDK.
 *
 * A name read in F at an offset is env-settable when it is not reserved
 * (isReservedProperty; with the Arcade SDK in use, ARCADE_PROPERTIES too),
 * not a source setting itself, and has no
 * unconditional definition (no condition and no conditioned group, `Choose`
 * branch or target around it) in F before the read or in another file of
 * F's evaluation. A host read is a GetEnvironmentVariable(s),
 * ExpandEnvironmentVariables, GetFolderPath or registry function,
 * `[System.Environment]::UserName`, `UserDomainName` or `MachineName`, or
 * a response file's `%NAME%`; an item list or item metadata (`@(Name)`,
 * `%(Name.Meta)`) counts as one, as
 * the engine does not follow items. A name reaches what the values and
 * conditions of its pinned definitions read, each where it is defined,
 * transitively (memoised per name). A read is (at most one per setting or
 * Import, RESTORE_READS_MAX in all):
 * (a) a source setting (RESTORE_SOURCE_SETTING) whose value or conditions
 *     (own and enclosing) reach an env-settable name or a host read;
 * (b) when any pinned file sets a source setting, a conditioned Import
 *     whose conditions reach an env-settable name or a host read, when its
 *     target cannot be resolved to pinned files, or the pinned files it
 *     loads (it and what they import, under any condition) set a source
 *     setting, import a file that cannot be resolved, or define a
 *     (non-reserved) name that a source setting's value or condition, an
 *     Import path or the condition of an Import that can change the
 *     sources (this rule, to a fixpoint) reaches: your environment decides
 *     whether a file that can change the sources loads;
 * (c) an Import whose `Project` value reaches a host read, a name no pinned
 *     file defines, or an env-settable profile name (PROFILE_ENV): your
 *     environment chooses which file loads (a name no pinned file defines
 *     only in a file of a .NET project's evaluation: DOTNET_EVALUATED files
 *     and the pinned files they reach by resolvable Imports, under any
 *     condition); each `%NAME%` in a pinned
 *     nuget.config value, which NuGet expands; and a pinned file the engine
 *     cannot read (larger than PINNED_READ_MAX, or not UTF-8 text).
 *
 * Each import closure is memoised per file and each Import resolved once
 * per directory, but closures of nested files overlap, so the work can grow with the
 * square of the import graph (whether a definition is in a reading file's
 * evaluation is memoised per name and reading file): past RESTORE_WORK_MAX
 * import steps the
 * result is one read, "too many imports to analyse", with its remedy.
 */
export function restoreHostReads(files, workMax = RESTORE_WORK_MAX) {
    const reads = [];
    const seenReads = new Set();
    let more = 0;
    const names = new Set();
    const fixes = new Set();
    /** Records one read (its words built only while under RESTORE_READS_MAX; past it, counted in `more`). */
    const add = (read, name) => {
        if (name)
            names.add(name);
        if (reads.length >= RESTORE_READS_MAX) {
            more++;
            return;
        }
        const words = typeof read === 'string' ? read : read();
        if (seenReads.has(words))
            return;
        seenReads.add(words);
        reads.push(words);
    };
    /** True when the engine can read the file; else records why not. Checked as each file is read, so a budget park leaves the rest untouched. */
    const readable = (f) => {
        if (notUtf8(f.text)) {
            add(`${f.path}: not UTF-8 text (UTF-16 or binary), so the engine cannot read its package-source settings`);
            fixes.add(`re-save ${f.path} as UTF-8`);
        }
        else if (f.text.length > PINNED_READ_MAX) {
            add(`${f.path}: larger than ${PINNED_READ_MAX / 1024} KB, so the engine did not read it and cannot tell whether its package-source settings depend on your environment`);
            fixes.add(`keep ${f.path} under ${PINNED_READ_MAX / 1024} KB`);
        }
        else
            return true;
        return false;
    };
    try {
        msbuildReads(files, readable, add, workMax);
    }
    catch (e) {
        if (!(e instanceof OverBudget))
            throw e;
        // First, so the park names it even past RESTORE_READS_MAX reads.
        reads.unshift(`the pinned MSBuild files: too many imports to analyse (more than ${workMax} import steps), so the engine cannot tell whether their package-source settings depend on your environment`);
        if (reads.length > RESTORE_READS_MAX) {
            reads.pop();
            more++;
        }
        fixes.add(`keep the pinned MSBuild files within the engine's limit of ${workMax} import steps (too many imports to analyse)`);
    }
    // (c): NuGet expands %NAME% in a config value.
    for (const f of files) {
        if (fileKind(f.path) !== 'nuget' || !readable(f))
            continue;
        for (const t of scanXml(f.text).tags) {
            for (const [, raw] of t.attrs) {
                const value = decodeXml(raw);
                for (const r of expressionRefs(value, true).filter((x) => x.startsWith('[env ')))
                    add(`${f.path}: the value ${JSON.stringify(value.slice(0, 200))} reads ${hostReadWords(r)}`);
            }
        }
    }
    return { reads, more, names: [...names].sort(), fixes: [...fixes] };
}
/** restoreHostReads' rules (a), (b) and (c)'s Import paths over the `readable` MSBuild and response files of `files`; throws OverBudget past `workMax` import steps. */
function msbuildReads(files, readable, add, workMax) {
    let work = 0;
    const spend = (n) => {
        work += n;
        if (work > workMax)
            throw new OverBudget();
    };
    const flows = [];
    // Equal Import paths across files share one string (thousands of files may import the same few).
    const values = new Map();
    for (const f of files) {
        const kind = fileKind(f.path);
        if ((kind !== 'msbuild' && kind !== 'rsp') || !readable(f))
            continue;
        const flow = propertyFlow(f.path, f.text);
        spend(flow.roots.length);
        for (const r of flow.roots) {
            const was = values.get(r.value);
            if (was === undefined)
                values.set(r.value, r.value);
            else
                r.value = was;
        }
        flows.push({ path: f.path, lpath: f.path.toLowerCase(), flow });
    }
    const flowAt = new Map(flows.map((f) => [f.lpath, f]));
    const pinned = new Set(files.map((f) => f.path.toLowerCase()));
    // ARCADE_PROPERTIES are reserved only where a pinned file uses the Arcade SDK (an Sdk import or a global.json msbuild-sdks entry).
    const arcade = flows.some((f) => f.flow.roots.some((r) => r.sdk !== null && r.sdk.split(';').some((s) => ARCADE_SDK.test(s))))
        || files.some((f) => fileKind(f.path) === 'global' && projectSdkMentions(f.path, f.text).some((s) => ARCADE_SDK.test(s)));
    const defsBy = new Map();
    /** Per name: the files with an unconditional definition, and the first and last offset there. */
    const fixedAt = new Map();
    for (const { path, lpath, flow } of flows) {
        for (const d of flow.defs) {
            const key = d.name.toLowerCase();
            let list = defsBy.get(key);
            if (!list)
                defsBy.set(key, (list = []));
            list.push({ lpath, path, ...d });
            if (!d.unconditional)
                continue;
            let at = fixedAt.get(key);
            if (!at)
                fixedAt.set(key, (at = new Map()));
            const was = at.get(lpath);
            at.set(lpath, was ? { first: Math.min(was.first, d.at), last: Math.max(was.last, d.at) } : { first: d.at, last: d.at });
        }
    }
    /** The setting or Import in words. */
    const what = (root) => (root.kind === 'setting' ? `<${root.value}>` : root.hook ? `<${root.hook}> (an SDK import hook)` : `Import ${JSON.stringify(root.value.slice(0, 200))}`);
    /** What an Import the engine cannot resolve loads, in words. */
    const unresolvedWords = (root) => (root.sdk !== null ? `a file of the SDK ${JSON.stringify(root.sdk.trim().slice(0, 200))}, which the engine cannot see` : 'a file the engine cannot resolve to a pinned file');
    /** P's repository dir, when P's only pinned definition is unconditional and names its file's dir (thisDirDef), else null. */
    const dirOf = (name) => {
        const ds = defsBy.get(name.toLowerCase());
        const d = ds?.length === 1 ? ds[0] : undefined;
        if (!d || d.dir === undefined || leavesRepository(d.path, d.dir ? `${d.dir}/_` : '_'))
            return null;
        return repoPath(d.path, d.dir);
    };
    /** The nearest pinned file `name` at or above the repository dir `from` (lower case), or null. */
    const fileAbove = (name, from) => {
        for (let dir = from;; dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '') {
            spend(1);
            const p = `${dir ? `${dir}/` : ''}${name}`.toLowerCase();
            if (pinned.has(p))
                return p;
            if (!dir)
                return null;
        }
    };
    const resolvedAt = new Map();
    /** The files an Import of the file `path` loads as pinned repository paths (lower case), or null when one is not a pinned file; memoised per importing dir and Import. */
    const resolved = (root, path) => {
        const here = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        const key = `${here}
${root.sdk ?? ''}
${root.hook ?? ''}
${root.value}`;
        const cached = resolvedAt.get(key);
        if (cached !== undefined)
            return cached;
        let out = [];
        const sw = root.hook ? HOOK_SWITCH[root.hook.toLowerCase()] : undefined;
        if (root.sdk !== null)
            out = PLAIN_SDK.test(root.sdk) ? [] : null;
        else if (sw) {
            const p = fileAbove(sw, here);
            out = p ? [p] : [];
        }
        else {
            for (const t of importTargets(path, root.value, dirOf) ?? [null]) {
                const p = t === null ? null : 'path' in t ? (pinned.has(t.path.toLowerCase()) ? t.path.toLowerCase() : null) : fileAbove(t.above, t.from);
                if (p === null) {
                    out = null;
                    break;
                }
                out.push(p);
            }
        }
        resolvedAt.set(key, out);
        return out;
    };
    /** Per file: the anchors of its evaluation (the file and its nearest auto-imported files). */
    const anchorsAt = new Map();
    /** Per repository dir (lower case): the nearest pinned AUTO_FILES at or above it. */
    const nearestAt = new Map();
    const nearest = (dir) => {
        const below = [];
        let found;
        for (let d = dir; d !== null; d = d ? (d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '') : null) {
            if ((found = nearestAt.get(d)))
                break;
            below.push(d);
        }
        let out = found ?? AUTO_FILES.map(() => null);
        for (let i = below.length - 1; i >= 0; i--) {
            const d = below[i];
            const up = out;
            out = AUTO_FILES.map((base, j) => (pinned.has(d ? `${d}/${base}` : base) ? (d ? `${d}/${base}` : base) : up[j]));
            nearestAt.set(d, out);
        }
        return out;
    };
    const anchors = (lpath) => {
        const cached = anchorsAt.get(lpath);
        if (cached)
            return cached;
        const out = [lpath, ...nearest(lpath.includes('/') ? lpath.slice(0, lpath.lastIndexOf('/')) : '').filter((p) => p !== null)];
        anchorsAt.set(lpath, out);
        return out;
    };
    /**
     * The pinned files `start` imports with no condition, transitively, with itself (lower case), memoised per file: a
     * file whose closure is known adds that closure whole (it holds the closures of all its members).
     */
    const closures = new Map();
    const closure = (start) => {
        const cached = closures.get(start);
        if (cached)
            return cached;
        const seen = new Set([start]);
        const queue = [start];
        for (let i = 0; i < queue.length; i++) {
            const f = flowAt.get(queue[i]);
            for (const r of f?.flow.roots ?? []) {
                if (r.kind !== 'import' || r.conditional)
                    continue;
                for (const t of resolved(r, f.path) ?? []) {
                    spend(1);
                    if (seen.has(t))
                        continue;
                    const known = closures.get(t);
                    if (known) {
                        spend(known.size);
                        for (const x of known)
                            seen.add(x);
                    }
                    else {
                        seen.add(t);
                        queue.push(t);
                    }
                }
            }
        }
        closures.set(start, seen);
        return seen;
    };
    /** settable's memo: whether a file of the reading file's evaluation other than itself defines the name unconditionally. */
    const insideAt = new Map();
    /** Why `name`, read in `lpath` at `at`, is env-settable (see above), or null when it is not. */
    const settable = (name, lpath, at) => {
        const at2 = fixedAt.get(name.toLowerCase());
        if (!at2)
            return 'none';
        const own = at2.get(lpath);
        if (own && own.first < at)
            return null;
        if (at2.size > (own ? 1 : 0)) {
            // Whether another file of lpath's evaluation defines the name: memoised per (name, reading file), iterating the
            // smaller of the defining files and the anchors' closures, each iteration charged to the budget.
            const key = `${name.toLowerCase()}\n${lpath}`;
            let inside = insideAt.get(key);
            if (inside === undefined) {
                const cs = anchors(lpath).map(closure);
                let steps = 0;
                if (at2.size <= cs.reduce((n, c) => n + c.size, 0)) {
                    inside = false;
                    for (const p of at2.keys()) {
                        steps++;
                        if (p !== lpath && cs.some((c) => c.has(p))) {
                            inside = true;
                            break;
                        }
                    }
                }
                else {
                    inside = cs.some((c) => {
                        for (const p of c) {
                            steps++;
                            if (p !== lpath && at2.has(p))
                                return true;
                        }
                        return false;
                    });
                }
                spend(steps);
                insideAt.set(key, inside);
            }
            if (inside)
                return null;
            return 'elsewhere';
        }
        return own ? (own.last > at ? 'after' : 'self') : 'none';
    };
    const stops = (ref) => isReservedProperty(ref) || RESTORE_SOURCE_SETTING.test(ref) || (arcade && ARCADE_PROPERTIES.test(ref));
    /** What one read is: a hit, a name to follow through its definitions, or a stop (reserved names, source settings). */
    const direct = (ref, lpath, at, mode) => {
        if (ref.startsWith('['))
            return { ref, why: 'host' };
        if (ref.startsWith('#'))
            return 'follow';
        if (stops(ref))
            return 'stop';
        if (mode === 'value') {
            const why = settable(ref, lpath, at);
            return why ? { ref, why } : 'follow';
        }
        if (!defsBy.has(ref.toLowerCase()))
            return mode === 'path' ? { ref, why: 'undefined' } : PROFILE_ENV.test(ref) ? { ref, why: 'profile' } : 'follow';
        return PROFILE_ENV.test(ref) && settable(ref, lpath, at) ? { ref, why: 'profile' } : 'follow';
    };
    /**
     * Per name (lower case): the hit its definitions reach, for one mode, computed once for all names by propagating hits
     * backwards from the definitions that read one directly (linear in the reads; cycles need no special case).
     */
    const solved = new Map();
    const solve = (mode) => {
        const cached = solved.get(mode);
        if (cached)
            return cached;
        const hits = new Map();
        const readers = new Map();
        const queue = [];
        for (const [key, ds] of defsBy) {
            if (stops(key))
                continue;
            for (const d of ds) {
                for (const r of d.refs) {
                    const x = direct(r, d.lpath, d.at, mode);
                    if (x === 'stop')
                        continue;
                    if (x === 'follow') {
                        const k = r.toLowerCase();
                        let list = readers.get(k);
                        if (!list)
                            readers.set(k, (list = []));
                        list.push(key);
                    }
                    else if (!hits.has(key)) {
                        hits.set(key, x);
                        queue.push(key);
                    }
                }
            }
        }
        for (let i = 0; i < queue.length; i++) {
            const hit = hits.get(queue[i]);
            for (const p of readers.get(queue[i]) ?? []) {
                if (hits.has(p))
                    continue;
                hits.set(p, hit);
                queue.push(p);
            }
        }
        solved.set(mode, hits);
        return hits;
    };
    /** The first hit of what `refs` (read in `lpath` at `at`) reach, with the name it went through. */
    const firstHit = (refs, lpath, at, mode) => {
        spend(1);
        for (const r of refs) {
            const x = direct(r, lpath, at, mode);
            if (x === 'stop')
                continue;
            if (x !== 'follow')
                return { hit: x, via: '' };
            const h = solve(mode).get(r.toLowerCase());
            if (h)
                return { hit: h, via: r.startsWith('#') || h.ref.toLowerCase() === r.toLowerCase() ? '' : ` through $(${r})` };
        }
        return null;
    };
    const why = {
        none: ', which no pinned file gives an unconditional value',
        self: ', which its only unconditional definition reads before giving it a value',
        after: ', which its file gives an unconditional value only after the read',
        elsewhere: ', which pinned files give an unconditional value only outside this evaluation (in files not auto-imported, imported under a condition, or imported by a path the engine does not resolve: only literal and $(MSBuildThisFileDirectory)-based paths)',
    };
    const valueWords = ({ hit, via }) => (hit.why === 'host' ? `${hostReadWords(hit.ref)}${via}` : `$(${hit.ref})${via}${why[hit.why] ?? ''}`);
    const pathWords = ({ hit, via }) => {
        const what = hit.why === 'host' ? hostReadWords(hit.ref) : `$(${hit.ref})`;
        return `${what}${via} in its path, ${hit.why === 'undefined' ? 'which no pinned file defines, ' : ''}so your environment chooses which file loads`;
    };
    const nameOf = (hit) => (hit.why === 'host' ? undefined : hit.ref);
    /**
     * The files of a .NET project's evaluation (DOTNET_EVALUATED files and every pinned file they reach by resolvable
     * Imports, under any condition), computed on first use.
     */
    let dotnetFiles;
    const inDotnet = (lpath) => {
        if (!dotnetFiles) {
            const seen = new Set(flows.filter((f) => DOTNET_EVALUATED.test(f.lpath)).map((f) => f.lpath));
            const queue = [...seen];
            for (let i = 0; i < queue.length; i++) {
                const f = flowAt.get(queue[i]);
                for (const r of f.flow.roots) {
                    if (r.kind !== 'import')
                        continue;
                    for (const t of resolved(r, f.path) ?? []) {
                        spend(1);
                        if (seen.has(t) || !flowAt.has(t))
                            continue;
                        seen.add(t);
                        queue.push(t);
                    }
                }
            }
            dotnetFiles = seen;
        }
        return dotnetFiles.has(lpath);
    };
    // (a) and (c)'s Import paths.
    let sets = '';
    /** The conditioned Imports that rule (b) may make reads. */
    const conditioned = new Set();
    for (const { path, lpath, flow } of flows) {
        for (const root of flow.roots) {
            if (root.kind === 'setting') {
                if (!sets)
                    sets = `${path} sets ${what(root)}`;
                const x = firstHit(root.refs, lpath, root.at, 'value');
                if (x)
                    add(() => `${path}: ${what(root)} reads ${valueWords(x)}`, nameOf(x.hit));
                continue;
            }
            let x = firstHit(root.refs, lpath, root.at, 'path');
            // A name no pinned file defines is a read only in a file of a .NET project's evaluation (a .vcxproj's $(VCTargetsPath) is not).
            if (x?.hit.why === 'undefined' && !inDotnet(lpath))
                x = firstHit(root.refs, lpath, root.at, 'foreign');
            if (x)
                add(() => `${path}: ${what(root)} reads ${pathWords(x)}`);
            else if (root.conditional && root.cond.length > 0)
                conditioned.add(root);
        }
    }
    // (b): a file sets the sources, so whether an Import that can change them loads must not depend on your environment.
    if (!sets || conditioned.size === 0)
        return;
    /** Per file: why the pinned files it loads (it and what they import, under any condition) can change the sources. */
    const changes = new Map();
    const changed = [];
    const change = (lpath, reason) => {
        if (changes.has(lpath))
            return;
        changes.set(lpath, reason);
        changed.push(lpath);
    };
    /** Per pinned file: the Imports (under any condition) that load it, with their files. */
    const importers = new Map();
    /** The names a source setting's value or condition, an Import path, or the condition of an Import that can change the sources reaches (lower case, never reserved). */
    const relevant = new Set();
    const pending = [];
    const reach = (refs) => {
        for (const r of refs) {
            if (r.startsWith('[') || stops(r))
                continue;
            const k = r.toLowerCase();
            if (relevant.has(k))
                continue;
            relevant.add(k);
            pending.push(k);
        }
    };
    /** The Imports that can change the sources: their own conditions become relevant. */
    const canChange = new Set();
    const changing = (root) => {
        if (canChange.has(root))
            return;
        canChange.add(root);
        reach(root.cond);
    };
    for (const f of flows) {
        const setting = f.flow.roots.find((r) => r.kind === 'setting');
        if (setting)
            change(f.lpath, `${f.path} sets ${what(setting)}`);
    }
    for (const f of flows) {
        for (const r of f.flow.roots) {
            spend(1);
            reach(r.refs);
            if (r.kind !== 'import')
                continue;
            const ts = resolved(r, f.path);
            if (!ts) {
                change(f.lpath, `${sets}, and ${r.hook ? `${f.path}: ${what(r)} names ${JSON.stringify(r.value.slice(0, 200))}` : `${f.path} imports ${JSON.stringify(r.value.slice(0, 200))}`}, ${unresolvedWords(r)}`);
                changing(r);
                continue;
            }
            for (const t of ts) {
                let list = importers.get(t);
                if (!list)
                    importers.set(t, (list = []));
                list.push(r, f);
            }
        }
    }
    // To a fixpoint: a relevant name makes the files that define it change the sources, and those the Imports that load them.
    for (let n = 0, c = 0; n < pending.length || c < changed.length;) {
        if (n < pending.length) {
            const k = pending[n++];
            for (const d of defsBy.get(k) ?? []) {
                spend(1);
                reach(d.refs);
                if (!k.startsWith('#'))
                    change(d.lpath, `${d.path} defines $(${d.name}), which a package-source setting or an Import reads`);
            }
            continue;
        }
        const t = changed[c++];
        const list = importers.get(t) ?? [];
        for (let i = 0; i < list.length; i += 2) {
            spend(1);
            changing(list[i]);
            change(list[i + 1].lpath, changes.get(t));
        }
    }
    for (const { path, lpath, flow } of flows) {
        for (const root of flow.roots) {
            if (!conditioned.has(root) || !canChange.has(root))
                continue;
            const x = firstHit(root.cond, lpath, root.at, 'value');
            if (!x)
                continue;
            const ts = resolved(root, path);
            const lead = ts ? `${changes.get(ts.find((t) => changes.has(t)))}, and ${path}: ${what(root)}` : `${sets}, and ${path}: ${what(root)} (${unresolvedWords(root)})`;
            // A CI or profile name here is no name to pin, and no source setting sits under this condition: no name for the remedy.
            const n = nameOf(x.hit);
            add(() => `${lead} has a condition that reads ${valueWords(x)}`, n && !isEnvironmentOnlyName(n) ? n : undefined);
        }
    }
}
//# sourceMappingURL=dotnet-package-refs.js.map