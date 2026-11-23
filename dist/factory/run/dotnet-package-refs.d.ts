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
 * The rule is textual and deliberately narrow: only the attributes that make
 * MSBuild or NuGet read a file are looked at (`Import Project`,
 * `ProjectReference Include`, `UsingTask AssemblyFile`, a solution's project
 * entries, a `nuget.config` source or fallback folder value), and one counts
 * when its value has a `node_modules` path segment once `\` is read as `/`.
 * MSBuild property expansion makes exact resolution impossible, so a value
 * is not expanded: a property that holds the node_modules part
 * (`$(NodeModules)\x.props` with `<NodeModules>..\node_modules</NodeModules>`)
 * is not seen, and a reference that resolves elsewhere counts. A mere
 * mention does not count: the ASP.NET SPA templates' `<Content
 * Remove="$(SpaRoot)node_modules\**" />` and `<Exec Command="npm install" />`
 * read nothing from there.
 */
/**
 * True when a path has a `node_modules` segment (`\` read as `/`, any case,
 * trailing dots and spaces dropped as Windows does). The parentheses,
 * quotes, commas and other punctuation of an MSBuild expression count as
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
 * (its basename decides how it is read); `text` its bytes as UTF-8.
 */
export declare function nodeModulesReferences(path: string, text: string): string[];
//# sourceMappingURL=dotnet-package-refs.d.ts.map