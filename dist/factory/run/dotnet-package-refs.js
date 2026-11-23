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
 * path under node_modules.
 */
import { parseJsonc } from '../../utils/jsonc.js';
/** XML comments, which MSBuild and NuGet never read. */
const XML_COMMENT = /<!--[\s\S]*?-->/g;
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
/** The values of `attr` on every `<element ...>` tag of an XML text (comments removed, entities decoded), any case. */
function attributeValues(xml, element, attr) {
    const out = [];
    const text = xml.replace(XML_COMMENT, '');
    // A quoted attribute value may hold a literal `>` (`Condition="'$(A)'>'0'"`): it does not end the tag.
    const tag = new RegExp(`<${element}(?=[\\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>`, 'gi');
    const attribute = new RegExp(`(?:^|\\s)${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
    for (const m of text.matchAll(tag)) {
        const a = attribute.exec(m[1]);
        if (a)
            out.push(decodeXml(a[1] ?? a[2] ?? ''));
    }
    return out;
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
 * (its basename decides how it is read); `text` its bytes as UTF-8.
 */
export function nodeModulesReferences(path, text) {
    const kind = fileKind(path);
    const values = [];
    if (kind === 'msbuild') {
        for (const v of attributeValues(text, 'Import', 'Project'))
            values.push(['Import Project', v]);
        for (const v of attributeValues(text, 'ProjectReference', 'Include'))
            values.push(['ProjectReference Include', v]);
        for (const v of attributeValues(text, 'UsingTask', 'AssemblyFile'))
            values.push(['UsingTask AssemblyFile', v]);
        // An inline task's code file (RoslynCodeTaskFactory compiles it).
        for (const v of attributeValues(text, 'Code', 'Source'))
            values.push(['UsingTask Code Source', v]);
        // A command whose exit code decides the build, when it names a path under node_modules (`node node_modules/x/check.js`);
        // `npm install`, `npm ci` or `npm run build` name none and do not count.
        for (const v of attributeValues(text, 'Exec', 'Command'))
            values.push(['Exec Command', v]);
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
            for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"/g))
                values.push(['global.json string', m[1]]);
        }
    }
    else if (kind === 'slnx') {
        for (const v of attributeValues(text, 'Project', 'Path'))
            values.push(['solution project', v]);
    }
    else if (kind === 'sln') {
        // `Project("{type guid}") = "Name", "path\to\App.csproj", "{project guid}"`
        for (const m of text.matchAll(/^\s*Project\s*\([^)]*\)\s*=\s*"[^"]*"\s*,\s*"([^"]*)"/gim))
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
            for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"/g))
                values.push(['solution filter string', m[1]]);
        }
    }
    else if (kind === 'nuget') {
        // A local source or fallback folder: any `<add value="...">` that is not an http(s) feed.
        for (const v of attributeValues(text, 'add', 'value'))
            if (!/^https?:\/\//i.test(v.trim()))
                values.push(['nuget.config value', v]);
    }
    return values.filter(([, v]) => hasNodeModulesSegment(v)).map(([what, v]) => `${what} ${JSON.stringify(v.slice(0, 200))}`);
}
//# sourceMappingURL=dotnet-package-refs.js.map