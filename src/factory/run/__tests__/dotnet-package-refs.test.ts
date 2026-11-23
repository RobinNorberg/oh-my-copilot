/**
 * References from pinned definition files into node_modules (dotnet-package-refs.ts) and the exact-tree check a
 * dotnet gate needs when they exist (prepare.ts gateTreeExactProblem). Throwaway dirs only; every link target lies in
 * the same temp dir.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hasNodeModulesSegment, nodeModulesReferences, readsForNodeModulesRefs } from '../dotnet-package-refs.js';
import { gateTreeExactProblem, linkNodeModules } from '../prepare.js';

/** The ASP.NET Core React/Angular SPA template's project file (shortened): mentions node_modules, reads nothing there. */
const SPA_CSPROJ = `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <SpaRoot>ClientApp\\</SpaRoot>
    <DefaultItemExcludes>$(DefaultItemExcludes);$(SpaRoot)node_modules\\**</DefaultItemExcludes>
  </PropertyGroup>
  <ItemGroup>
    <Content Remove="$(SpaRoot)**" />
    <None Remove="$(SpaRoot)**" />
    <None Include="$(SpaRoot)**" Exclude="$(SpaRoot)node_modules\\**" />
    <Content Remove="$(SpaRoot)node_modules\\**" />
  </ItemGroup>
  <Target Name="DebugEnsureNodeEnv" BeforeTargets="Build" Condition=" '$(Configuration)' == 'Debug' And !Exists('$(SpaRoot)node_modules') ">
    <Exec Command="node --version" ContinueOnError="true" />
    <Exec WorkingDirectory="$(SpaRoot)" Command="npm install" />
  </Target>
</Project>
`;

describe('nodeModulesReferences', () => {
  it('finds Import Project, ProjectReference Include and UsingTask AssemblyFile values with a node_modules segment', () => {
    const proj = `<Project Sdk="Microsoft.NET.Sdk">
  <Import Project="..\\node_modules\\x\\build\\x.props" Condition="Exists('..\\node_modules\\x')" />
  <ItemGroup><ProjectReference Include="../node_modules/lib/Lib.csproj" /></ItemGroup>
  <UsingTask TaskName="T" AssemblyFile="$(MSBuildThisFileDirectory)node_modules/t/T.dll" />
  <Import Project="build/common.props" />
</Project>`;
    expect(nodeModulesReferences('App/App.csproj', proj)).toEqual([
      'Import Project "..\\\\node_modules\\\\x\\\\build\\\\x.props"',
      'ProjectReference Include "../node_modules/lib/Lib.csproj"',
      'UsingTask AssemblyFile "$(MSBuildThisFileDirectory)node_modules/t/T.dll"',
    ]);
  });

  it('the ASP.NET SPA template (Remove/Exclude globs, Exec npm install, a Condition) is not a reference', () => {
    expect(nodeModulesReferences('src/Web/Web.csproj', SPA_CSPROJ)).toEqual([]);
  });

  it('comments are skipped, entities decoded, attribute quotes and case of the element any; ImportGroup is not Import', () => {
    expect(nodeModulesReferences('D.props', '<Project><!-- <Import Project="node_modules/a.props" /> --><ImportGroup Label="node_modules" /></Project>')).toEqual([]);
    expect(nodeModulesReferences('D.targets', `<Project><import project='&#x6E;ode_modules/a.targets'/></Project>`)).toEqual(['Import Project "node_modules/a.targets"']);
    expect(nodeModulesReferences('D.props', '<Project><Import\n  Project="NODE_MODULES./a.props"/></Project>')).toHaveLength(1);
  });

  it('solutions (.sln, .slnx, .slnf) and nuget.config local sources', () => {
    const sln = 'Microsoft Visual Studio Solution File, Format Version 12.00\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "src\\App\\App.csproj", "{1}"\nEndProject\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Evil", "node_modules\\evil\\Evil.csproj", "{2}"\nEndProject\n';
    expect(nodeModulesReferences('All.sln', sln)).toEqual(['solution project "node_modules\\\\evil\\\\Evil.csproj"']);
    expect(nodeModulesReferences('All.slnx', '<Solution><Project Path="src/App/App.csproj" /><Project Path="node_modules/e/E.csproj" /></Solution>')).toEqual(['solution project "node_modules/e/E.csproj"']);
    expect(nodeModulesReferences('All.slnf', JSON.stringify({ solution: { path: 'All.sln', projects: ['src\\App\\App.csproj', 'node_modules\\e\\E.csproj'] } }))).toEqual(['solution filter project "node_modules\\\\e\\\\E.csproj"']);
    expect(nodeModulesReferences('All.slnf', '{ not json "node_modules/x.csproj" ')).toHaveLength(1);
    const config = '<configuration><packageSources><add key="nuget.org" value="https://api.nuget.org/v3/index.json" /><add key="local" value="./node_modules/pkgs" /></packageSources><fallbackPackageFolders><add key="f" value="..\\node_modules\\fb" /></fallbackPackageFolders></configuration>';
    expect(nodeModulesReferences('NuGet.Config', config)).toEqual(['nuget.config value "./node_modules/pkgs"', 'nuget.config value "..\\\\node_modules\\\\fb"']);
  });

  it('a literal > inside an earlier quoted attribute does not end the tag', () => {
    expect(nodeModulesReferences('a.csproj', `<Project><Import Condition="&apos;$(A)&apos;>&apos;0&apos;" Project="..\\node_modules\\x\\b.props" /></Project>`)).toEqual(['Import Project "..\\\\node_modules\\\\x\\\\b.props"']);
    expect(nodeModulesReferences('a.csproj', `<Project><Import Condition="'$(A)'>'0'" Project='node_modules/x/b.props' /><Import Condition='"a">"b"' Project="ok.props" /></Project>`)).toEqual(['Import Project "node_modules/x/b.props"']);
  });

  it('an inline task Code Source and an Exec Command that names a node_modules path count; npm install, npm ci and npm run do not', () => {
    const task = `<Project><UsingTask TaskName="T" TaskFactory="RoslynCodeTaskFactory" AssemblyFile="$(MSBuildToolsPath)\\Microsoft.Build.Tasks.Core.dll"><Task><Code Type="Class" Language="cs" Source="..\\node_modules\\x\\t.cs" /></Task></UsingTask></Project>`;
    expect(nodeModulesReferences('a.csproj', task)).toEqual(['UsingTask Code Source "..\\\\node_modules\\\\x\\\\t.cs"']);
    expect(nodeModulesReferences('a.csproj', '<Project><Target Name="B" BeforeTargets="Build"><Exec Command="node node_modules/x/check.js" /></Target></Project>')).toEqual(['Exec Command "node node_modules/x/check.js"']);
    expect(nodeModulesReferences('a.targets', '<Project><Target Name="B"><Exec Command="$(SpaRoot)node_modules\\.bin\\tsc -p ." /></Target></Project>')).toHaveLength(1);
    const npm = '<Project><Target Name="B"><Exec WorkingDirectory="$(SpaRoot)" Command="npm install" /><Exec Command="npm ci" /><Exec WorkingDirectory="$(SpaRoot)" Command="npm run build -- --configuration production" /><Exec Command="node --version" ContinueOnError="true" /></Target></Project>';
    expect(nodeModulesReferences('Web.csproj', npm)).toEqual([]);
    // A mere item glob is still no reference.
    expect(nodeModulesReferences('a.csproj', '<Project><ItemGroup><Content Remove="$(SpaRoot)node_modules\\**" /></ItemGroup><Target Name="B"><Exec Command="npm install" /></Target></Project>')).toEqual([]);
  });

  it('response files: every token outside comment lines', () => {
    expect(nodeModulesReferences('Directory.Build.rsp', '-logger:node_modules/x/l.dll')).toEqual(['response file token "-logger:node_modules/x/l.dll"']);
    const rsp = '# -logger:node_modules/commented.dll\n-distributedlogger:Central,node_modules\\c.dll*Fwd,ok.dll\n@node_modules/x/more.rsp\n-p:Tool="..\\node_modules\\t"\n-nologo -p:Configuration=Release\n';
    expect(nodeModulesReferences('src/App/App.rsp', rsp)).toEqual([
      'response file token "-distributedlogger:Central,node_modules\\\\c.dll*Fwd,ok.dll"',
      'response file token "@node_modules/x/more.rsp"',
      'response file token "-p:Tool=\\"..\\\\node_modules\\\\t\\""',
    ]);
    expect(nodeModulesReferences('Directory.Build.rsp', '-nologo\n-p:TreatWarningsAsErrors=true\n')).toEqual([]);
  });

  it('global.json sdk.paths (JSON with comments; not JSON: every string)', () => {
    expect(nodeModulesReferences('global.json', '{"sdk":{"paths":["node_modules/dotnet", "$host$"]}}')).toEqual(['global.json sdk.paths "node_modules/dotnet"']);
    expect(nodeModulesReferences('global.json', '{ // pinned\n "sdk": { "version": "10.0.101", "paths": [".dotnet", "$host$"] } }')).toEqual([]);
    expect(nodeModulesReferences('global.json', '{"sdk":{"version":"10.0.101"},"msbuild-sdks":{"node_modules":"1.0"}}')).toEqual([]);
    expect(nodeModulesReferences('global.json', '{ "sdk": { "paths": ["node_modules/d" ')).toHaveLength(1);
  });

  it('only the files it reads, and the segment rule', () => {
    for (const p of ['a/App.csproj', 'x.props', 'Directory.Build.targets', 'x.tasks', 'a.projitems', 'App.csproj.user', 'A.sln', 'A.slnx', 'A.slnf', 'nuget.config', 'NuGet.Config']) expect(readsForNodeModulesRefs(p), p).toBe(true);
    for (const p of ['global.json', 'Directory.Build.rsp', 'tests/x.rsp']) expect(readsForNodeModulesRefs(p), p).toBe(true);
    for (const p of ['packages.lock.json', 'launchSettings.json']) expect(readsForNodeModulesRefs(p), p).toBe(false);
    for (const v of ['node_modules/x', '..\\node_modules\\x', 'a/Node_Modules /b', '$(SpaRoot)node_modules\\x.props', "$([MSBuild]::NormalizePath('..', 'node_modules', 'x.props'))"]) expect(hasNodeModulesSegment(v), v).toBe(true);
    for (const v of ['node_modulesx/a', 'my_node_modules/a', '$(NodeModules)/x.props']) expect(hasNodeModulesSegment(v), v).toBe(false);
  });
});

describe('gateTreeExactProblem', () => {
  let tmp: string;
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));
  const put = (p: string, t = 'x') => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, t); };
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';

  /** Your repository with node_modules/x (a package with build/x.props) and @s/y, and a checkout with the engine's tree. */
  function world(): { root: string; co: string } {
    tmp = mkdtempSync(join(tmpdir(), 'omg-exact-'));
    const root = join(tmp, 'yours');
    put(join(root, 'node_modules', 'x', 'build', 'x.props'), '<Project/>');
    put(join(root, 'node_modules', '@s', 'y', 'index.js'), '');
    put(join(root, 'node_modules', '.package-lock.json'), '{}');
    const co = join(tmp, 'co');
    mkdirSync(co);
    expect(linkNodeModules(root, co)).toBeNull();
    return { root, co };
  }

  it('the engine\'s untouched tree passes', () => {
    const { root, co } = world();
    expect(gateTreeExactProblem(root, co, [], ['node_modules/.package-lock.json'], false)).toBeNull();
  });

  it('the repro: the link to node_modules/x replaced by a plain dir holding the PR\'s own x.props is tampered', () => {
    const { root, co } = world();
    unlinkSync(join(co, 'node_modules', 'x'));
    put(join(co, 'node_modules', 'x', 'build', 'x.props'), '<Project><PropertyGroup><IsTestProject>false</IsTestProject></PropertyGroup></Project>');
    expect(gateTreeExactProblem(root, co, [], ['node_modules/x/build/x.props'], false)).toEqual({ problem: expect.stringMatching(/node_modules\/x is a plain directory where the engine links your node_modules\/x/), tampered: true });
  });

  it('a re-pointed link, a planted entry, an edited top-level file, a link gone: tampered', () => {
    let w = world();
    const elsewhere = join(tmp, 'elsewhere');
    mkdirSync(elsewhere);
    unlinkSync(join(w.co, 'node_modules', 'x'));
    symlinkSync(realpathSync.native(elsewhere), join(w.co, 'node_modules', 'x'), linkType);
    expect(gateTreeExactProblem(w.root, w.co, [], [], false)?.tampered).toBe(true);
    rmSync(tmp, { recursive: true, force: true });
    w = world();
    put(join(w.co, 'node_modules', 'evil', 'Evil.props'));
    expect(gateTreeExactProblem(w.root, w.co, [], [], false)).toEqual({ problem: expect.stringMatching(/node_modules\/evil is a plain directory/), tampered: true });
    rmSync(tmp, { recursive: true, force: true });
    w = world();
    writeFileSync(join(w.co, 'node_modules', '.package-lock.json'), '{"x":1}');
    expect(gateTreeExactProblem(w.root, w.co, [], [], false)?.problem).toMatch(/is not the engine's copy/);
    rmSync(tmp, { recursive: true, force: true });
    w = world();
    unlinkSync(join(w.co, 'node_modules', 'x'));
    expect(gateTreeExactProblem(w.root, w.co, [], [], false)).toEqual({ problem: expect.stringMatching(/node_modules\/x, which the engine links to your node_modules\/x, is gone/), tampered: true });
  });

  it('cache dirs may hold what a check wrote; a copied tree, or a node_modules the engine did not build, cannot be verified', () => {
    const { root, co } = world();
    put(join(co, 'node_modules', '.vite', 'deps', 'a.js'));
    expect(gateTreeExactProblem(root, co, [], [], false)).toBeNull();
    expect(gateTreeExactProblem(root, co, [], [], true)).toEqual({ problem: expect.stringMatching(/copied tree/), tampered: false });
    expect(gateTreeExactProblem(root, co, [], ['src/Web/ClientApp/node_modules/z/z.props'], false)).toEqual({ problem: expect.stringMatching(/src\/Web\/ClientApp\/node_modules in the checkout is not a node_modules tree the engine built/), tampered: false });
  });

  it('a checkout with no node_modules has nothing to import: fine; one your checkout has no source for is not the engine\'s', () => {
    tmp = mkdtempSync(join(tmpdir(), 'omg-exact-'));
    const root = join(tmp, 'yours');
    mkdirSync(root);
    const co = join(tmp, 'co');
    mkdirSync(co);
    expect(gateTreeExactProblem(root, co, [], [], false)).toBeNull();
    put(join(co, 'node_modules', 'x', 'x.props'));
    expect(gateTreeExactProblem(root, co, [], [], false)?.tampered).toBe(false);
  });
});

describe('gateTreeExactProblem: a repository that commits its node_modules', () => {
  let tmp: string;
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));
  const put = (p: string, t = 'x') => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, t); };

  /** A checkout whose node_modules is the head's own tracked files (plain dirs, no engine link), and yours beside it. */
  function committed(): { root: string; co: string } {
    tmp = mkdtempSync(join(tmpdir(), 'omg-exact-tracked-'));
    const root = join(tmp, 'yours');
    put(join(root, 'node_modules', 'x', 'build', 'x.props'), '<Project/>');
    const co = join(tmp, 'co');
    put(join(co, 'node_modules', 'x', 'build', 'x.props'), '<Project/>');
    put(join(co, 'node_modules', 'vendored', 'v.targets'), '<Project/>');
    // linkNodeModules leaves a node_modules that is already there alone.
    expect(linkNodeModules(root, co)).toBeNull();
    return { root, co };
  }

  it('the tracked tree is left to git\'s dirty check instead of parking lane-tampered', () => {
    const { root, co } = committed();
    // Without the head's listing it is not the engine's tree: tampered (the old verdict).
    expect(gateTreeExactProblem(root, co, [], [], false)?.tampered).toBe(true);
    expect(gateTreeExactProblem(root, co, [], [], false, [''])).toBeNull();
  });

  it('a file git does not track in it cannot be verified (gates, not lane-tampered); a cache dir may hold what a check wrote', () => {
    const { root, co } = committed();
    expect(gateTreeExactProblem(root, co, [], ['node_modules/x/build/planted.props'], false, [''])).toEqual({ problem: expect.stringMatching(/node_modules in the checkout is the repository's own .*node_modules\/x\/build\/planted\.props there is not tracked/), tampered: false });
    expect(gateTreeExactProblem(root, co, [], ['node_modules/.vite/deps/a.js'], false, [''])).toBeNull();
  });

  it('only the trees the head tracks files in are skipped: another one is still compared', () => {
    const { root, co } = committed();
    expect(gateTreeExactProblem(root, co, [], [], false, ['src/Web'])?.tampered).toBe(true);
  });
});
