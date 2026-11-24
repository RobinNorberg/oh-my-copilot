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
 * itself, so the engine writes no root-config copy with nuget.org
 * (dotnet-sandbox.ts nugetOrgCopy; an extra signal that can only restrict:
 * such a setting overrides the copy's config source anyway).
 * Conservative: a comment or a condition counts, and a file larger than
 * PINNED_READ_MAX counts as `not read`. Other files: none.
 */
export declare function restoreSettingMentions(path: string, text: string): string[];
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
export declare function unpinnedImports(path: string, text: string): string[];
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