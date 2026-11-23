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
 * path under node_modules, and a pure delete (`<Exec Command="rimraf
 * node_modules" />`, `del /q node_modules\.cache`) reads nothing there.
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
/** Above this size a pinned file is not read: its references are unknown (nodeModulesReferences counts one; L1). */
export declare const PINNED_READ_MAX: number;
/**
 * True when a path has a `node_modules` segment (`\` read as `/`, any case,
 * trailing dots and spaces dropped as Windows does). The parentheses,
 * quotes, commas, `:`, `=`, `@` and other punctuation of an MSBuild expression or a response-file switch count as
 * boundaries too, so `$(MSBuildThisFileDirectory)node_modules\x` (a property
 * ends in a separator) and a property function's argument
 * (`$([MSBuild]::NormalizePath('..', 'node_modules', 'x.props'))`) count.
 */
export declare function hasNodeModulesSegment(value: string): boolean;
/** True when this module reads a pinned definition file of that name (the others are never fetched). */
export declare const readsForNodeModulesRefs: (path: string) => boolean;
/**
 * The references into a node_modules dir in one pinned definition file:
 * `<what> <value>` for each, in file order. `path` is its repository path
 * (its basename decides how it is read); `text` its bytes as UTF-8. A file
 * larger than PINNED_READ_MAX is not read: one reference, "not read",
 * so the caller treats its references as unknown (conservative). Every
 * scan is linear (L1).
 */
export declare function nodeModulesReferences(path: string, text: string): string[];
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
export declare function restoreSettingMentions(path: string, text: string): string[];
/**
 * The MSBuild project SDKs a pinned file has NuGet resolve (M3): a
 * versioned `Sdk="<name>/<version>"` on `Project` or `Import` (a `;` list
 * too), an `Sdk` element or `Import` with `Name` and `Version`, or a
 * `global.json` `msbuild-sdks` entry. NuGet's MSBuild SDK resolver reads
 * NuGet's own config hierarchy (it ignores RestoreConfigFile). An
 * unversioned `Sdk="Microsoft.NET.Sdk"` is the dotnet SDK's own and does
 * not count. A file larger than PINNED_READ_MAX is not read (none).
 */
export declare function projectSdkMentions(path: string, text: string): string[];
//# sourceMappingURL=dotnet-package-refs.d.ts.map