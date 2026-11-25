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
/** True when `name` is a property MSBuild or the SDK defines (RESERVED_PROPERTIES). */
export declare const isReservedProperty: (name: string) => boolean;
/**
 * True when `name` is one your CI system or user profile sets (`CI`,
 * `TF_BUILD`, `GITHUB_*`, `BUILD_*`, `SYSTEM_*`, `HOME`, `USERPROFILE`, ...):
 * a value a repository should not pin, so the park's remedy is to move the
 * source setting out from under it rather than to give it a value.
 */
export declare const isEnvironmentOnlyName: (name: string) => boolean;
/**
 * The names an MSBuild expression reads: each `$(Name)` as `Name`, and
 * host reads as pseudo-names in brackets (`[env NAME]` for a literal
 * GetEnvironmentVariable, `[env ?]` for a computed one, `[registry]`,
 * `[GetFolderPath]`, ...). With `percent`, `%NAME%` counts as `[env NAME]`;
 * a two-hex-digit name (`%AB%`) counts too unless it is part of a run of
 * `%XX` escapes (`%C3%A9`: an escape just before it, or one starting at
 * its closing `%`).
 */
export declare function expressionRefs(expr: string, percent?: boolean): string[];
/** Where an Import's `Project` part points: a repository path, or a `GetPathOfFileAbove` search for a file name from a repository dir. */
export type ImportTarget = {
    path: string;
} | {
    above: string;
    from: string;
};
/** One pinned file's property data flow (propertyFlow). Offsets (`at`) order what one file reads and defines. */
export interface PropertyFlow {
    /**
     * Each property definition: the names its value and conditions (its own and its ancestors') read; unconditional when
     * no condition, `Choose` branch or target encloses it. A condition is one pseudo-definition (a name starting with
     * `#`, never unconditional) that reads the condition and its enclosing one's pseudo-name, so a deep nest stays linear.
     */
    defs: Array<{
        name: string;
        at: number;
        unconditional: boolean;
        refs: string[];
        dir?: string;
    }>;
    /**
     * `setting`: a source setting (RESTORE_SOURCE_SETTING, also task-set through an Output, or a response file's `-p:`),
     * `value` its name, `refs` its value and conditions. `import`: an Import, `value` its `Project` value, `refs` what
     * that reads, `cond` its own and its groups' conditions, `conditional` when a condition, `Choose` branch or target
     * encloses it, `sdk` its `Sdk` attribute (it loads a file of that SDK), `hook` the property when it is the
     * definition of an SDK import hook (IMPORT_HOOK: `value` the path it names, or for an `Import*` switch the
     * Directory file it turns on or off).
     */
    roots: Array<{
        kind: 'setting' | 'import';
        value: string;
        at: number;
        refs: string[];
        cond: string[];
        conditional: boolean;
        sdk: string | null;
        hook?: string;
    }>;
    /** The file is larger than PINNED_READ_MAX and was not read. */
    unread: boolean;
}
/**
 * The property data flow of a pinned MSBuild file (one linear scan) or
 * response file (its `-p:` / `-property:` / `-rp:` / `-restoreProperty:`
 * global properties, with `-`, `--` or `/`, separated by `;` or `,`,
 * outside `#` comment lines; they define names unconditionally, and
 * MSBuild expands `%NAME%` there from the environment). Other files:
 * nothing. A file larger than PINNED_READ_MAX: `unread`.
 */
export declare function propertyFlow(path: string, text: string): PropertyFlow;
/** restoreHostReads' result. */
export interface RestoreHostReads {
    /** The static reads (each parks the restore step), at most RESTORE_READS_MAX: the file, the setting or Import, and what it reads. */
    reads: string[];
    /** How many more reads there were than `reads` lists. */
    more: number;
    /** The property names among them your environment can set (sorted): the park asks to give them an unconditional value, or (isEnvironmentOnlyName) to move the setting out from under them. */
    names: string[];
    /** Remedies for files the engine could not read (`re-save <file> as UTF-8`). */
    fixes: string[];
}
/** The most reads restoreHostReads lists (the rest are counted in `more`). */
export declare const RESTORE_READS_MAX = 50;
/**
 * restoreHostReads' work budget: the import steps it may take (each Import or source setting it reads, each import
 * edge it follows, each file it adds to an import closure). Past it the restore parks ("too many imports to analyse").
 */
export declare const RESTORE_WORK_MAX = 100000;
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
 * definition's conditions. An `Sdk` Import loads nothing of the repository
 * for `Microsoft.NET.Sdk*` and `Microsoft.Build.*` and a file the engine
 * cannot resolve for any other SDK.
 *
 * A name read in F at an offset is env-settable when it is not reserved
 * (isReservedProperty), not a source setting itself, and has no
 * unconditional definition (no condition and no conditioned group, `Choose`
 * branch or target around it) in F before the read or in another file of
 * F's evaluation. A host read is a GetEnvironmentVariable(s),
 * ExpandEnvironmentVariables, GetFolderPath or registry function,
 * `[System.Environment]::UserName`, `UserDomainName` or `MachineName`, or
 * a response file's `%NAME%`; an item list (`@(Name)`) counts as one, as
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
 *     environment chooses which file loads; each `%NAME%` in a pinned
 *     nuget.config value, which NuGet expands; and a pinned file the engine
 *     cannot read (larger than PINNED_READ_MAX, or not UTF-8 text).
 *
 * Each import closure is memoised per file and each Import resolved once
 * per directory, but closures of nested files overlap, so the work can grow with the
 * square of the import graph: past RESTORE_WORK_MAX import steps the
 * result is one read, "too many imports to analyse", with its remedy.
 */
export declare function restoreHostReads(files: ReadonlyArray<{
    path: string;
    text: string;
}>, workMax?: number): RestoreHostReads;
//# sourceMappingURL=dotnet-package-refs.d.ts.map