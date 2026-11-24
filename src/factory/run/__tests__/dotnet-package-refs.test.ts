/**
 * References from pinned definition files into node_modules (dotnet-package-refs.ts) and the exact-tree check a
 * dotnet gate needs when they exist (prepare.ts gateTreeExactProblem). Throwaway dirs only; every link target lies in
 * the same temp dir.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hasNodeModulesSegment, nodeModulesReferences, PINNED_READ_MAX, projectSdkMentions, readsForNodeModulesRefs, restoreSettingMentions, unpinnedImports } from '../dotnet-package-refs.js';
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

describe('M3: an Exec is exempt only as a whole, plain delete command (after MSBuild unescaping)', () => {
  it('round 4: rimraf and npx run node_modules code and count; WorkingDirectory or EnvironmentVariables naming node_modules count and void the exemption', () => {
    for (const c of ['rimraf ./node_modules', 'rimraf.cmd node_modules', 'npx rimraf node_modules', 'npx --yes rimraf node_modules', 'npx -y rm -rf node_modules', 'npx del node_modules']) {
      expect(nodeModulesReferences('a.csproj', `<Target Name="C"><Exec Command="${c}" /></Target>`), c).toHaveLength(1);
    }
    // npx counts whatever it names (it runs node_modules/.bin/<name> first); a plain rimraf on a path outside node_modules names none.
    for (const c of ['npx rimraf dist', 'npx.cmd tsc -p .', 'npm ci &amp;&amp; npx ng build']) {
      expect(nodeModulesReferences('a.csproj', `<Exec Command="${c}" />`), c).toEqual([expect.stringContaining('Exec Command (npx runs node_modules/.bin)')]);
    }
    expect(nodeModulesReferences('a.csproj', '<Exec Command="rimraf dist" />')).toEqual([]);
    expect(nodeModulesReferences('a.csproj', '<Exec Command="rm -rf dist" WorkingDirectory="ClientApp\\node_modules\\.bin" />')).toEqual([
      'Exec WorkingDirectory "ClientApp\\\\node_modules\\\\.bin"',
      'Exec Command (run in or with node_modules) "rm -rf dist [ClientApp\\\\node_modules\\\\.bin]"',
    ]);
    expect(nodeModulesReferences('a.csproj', '<Exec Command="del /q node_modules\\.cache" EnvironmentVariables="PATH=node_modules/.bin;$(PATH)" />')).toHaveLength(2);
    // The SPA templates' ordinary lines still name nothing.
    for (const c of ['npm install', 'npm ci', 'npm run build -- --configuration production']) {
      expect(nodeModulesReferences('a.csproj', `<Exec WorkingDirectory="$(SpaRoot)" Command="${c}" />`), c).toEqual([]);
    }
  });

  it('round 5: every package-runner spelling counts like npx; npm run, npm install and npm ci stay non-references', () => {
    for (const c of ['&quot;npx&quot; rimraf dist', "'npx' rimraf dist", 'npx.cmd rimraf dist', 'npx.exe tsc', 'NPX tsc', 'npm exec rimraf dist', 'npm x rimraf dist', 'npm.cmd exec -- tsc', '&quot;npm&quot; exec tsc', 'pnpm dlx rimraf dist', 'pnpm exec tsc', 'yarn dlx rimraf dist', 'yarn exec tsc', 'bunx rimraf dist', 'bunx.cmd tsc', 'cd ClientApp &amp;&amp; pnpm exec ng build']) {
      expect(nodeModulesReferences('a.csproj', `<Exec Command="${c}" />`), c).toEqual([expect.stringContaining('Exec Command (npx runs node_modules/.bin)')]);
    }
    for (const c of ['npm run build', 'npm install', 'npm ci', 'pnpm install', 'yarn install', 'npm run exec', 'npxtool run', 'mynpx run', 'echo npm-exec']) {
      expect(nodeModulesReferences('a.csproj', `<Exec WorkingDirectory="$(SpaRoot)" Command="${c}" />`), c).toEqual([]);
    }
  });

  it('rm -rf, del, rd, rmdir and Remove-Item with plain paths do not count', () => {
    for (const c of ['rm -rf node_modules', 'rm.exe -rf node_modules', 'del /q node_modules\\.cache', 'rd /s /q node_modules', 'rmdir /s /q ClientApp\\node_modules', 'Remove-Item -Recurse node_modules']) {
      expect(nodeModulesReferences('a.csproj', `<Target Name="C"><Exec Command="${c}" /></Target>`), c).toEqual([]);
    }
    // ASP.NET Core 2.x SpaServices: the webpack run counts (its gate needs the engine's exact tree).
    expect(nodeModulesReferences('a.csproj', '<Exec Command="node node_modules/webpack/bin/webpack.js --config webpack.config.vendor.js" />')).toHaveLength(1);
  });

  it('a chain, an MSBuild escape, a substitution or a property after a delete counts (the review bypasses)', () => {
    for (const c of [
      'rimraf node_modules%0Anode node_modules/x/e.js',
      'rimraf node_modules%26%26node node_modules/x/e.js',
      'rimraf node_modules%3Bnode node_modules/x/e.js',
      'rimraf node_modules &amp;&amp; node node_modules/x/a.js',
      'rimraf node_modules; node node_modules/x/a.js',
      'rimraf node_modules | node node_modules/x/a.js',
      'rimraf node_modules&#10;node node_modules/x/a.js',
      'rm -rf $(node node_modules/x/a.js)',
      'rm -rf `node node_modules/x/a.js`',
      'rimraf $(SpaRoot)node_modules',
      'rm -rf node_modules &gt; node_modules/x/out',
      'npm prune &amp;&amp; del /q node_modules\\.cache',
      'npx -c rimraf node_modules',
      'rimraf &quot;node_modules&quot;',
    ]) {
      expect(nodeModulesReferences('a.csproj', `<Exec Command="${c}" />`), c).toHaveLength(1);
    }
    expect(nodeModulesReferences('a.csproj', '<Exec Command="rimraf node_modules%0Anode node_modules/x/e.js" />')[0]).toContain('node node_modules/x/e.js');
  });

  it('SPA template commands name no node_modules path and still do not count', () => {
    for (const c of ['npm install', 'npm ci', 'npm run build -- --configuration production', 'node --version']) expect(nodeModulesReferences('a.csproj', `<Exec WorkingDirectory="$(SpaRoot)" Command="${c}" />`), c).toEqual([]);
    expect(nodeModulesReferences('a.csproj', '<ItemGroup><Content Remove="$(SpaRoot)node_modules\\**" /></ItemGroup>')).toEqual([]);
  });
});

describe('M2: unpinnedImports', () => {
  it('an Import whose value does not end in a pinned extension counts; ordinary imports do not', () => {
    expect(unpinnedImports('Directory.Build.props', '<Project><Import Project="eng/Sources.msbuild" Condition="Exists(\'eng/Sources.msbuild\')" /></Project>')).toEqual(['eng/Sources.msbuild']);
    expect(unpinnedImports('Directory.Build.props', '<Project><Import Project="$(MSBuildThisFileDirectory)eng\\Versions.props" /></Project>')).toEqual([]);
    expect(unpinnedImports('a.csproj', '<Project><Import Project="$(CustomProps)" /><Import Project="eng/*" /><import project="x.targets;y.xml" /></Project>')).toEqual(['$(CustomProps)', 'eng/*', 'y.xml']);
    expect(unpinnedImports('a.csproj', '<Project><Import Project="a.Shared.projitems" Label="Shared" /><Import Project="b.vcxproj" /><Import Project="Sdk.targets" Sdk="Microsoft.NET.Sdk" /></Project>')).toEqual([]);
    // Round 7: any wildcard counts, whatever extension follows it (MSBuild imports every match).
    expect(unpinnedImports('Lib/Directory.Build.props', '<Project><Import Project="eng/*.props" /><Import Project="../**/Sources.props" /><Import Project="../n*_modules/corp/Sources.props" /><Import Project="eng/Ver?ions.props" /><Import Project="$(MSBuildThisFileDirectory)eng/*.targets" /></Project>')).toEqual(['eng/*.props', '../**/Sources.props', '../n*_modules/corp/Sources.props', 'eng/Ver?ions.props', '$(MSBuildThisFileDirectory)eng/*.targets']);
    expect(unpinnedImports('Lib/Directory.Build.props', '<Project><Import Project="eng/%2A.props" /></Project>')).toEqual(['eng/%2A.props']);
    expect(unpinnedImports('src/Directory.Build.props', `<Project><Import Project="$([MSBuild]::GetPathOfFileAbove('Directory.Build.props', '$(MSBuildThisFileDirectory)../'))" /></Project>`)).toEqual([]);
    expect(unpinnedImports('Directory.Build.props', `<Project><Import Project="$([MSBuild]::GetPathOfFileAbove('Sources.msbuild', '$(MSBuildThisFileDirectory)../'))" /></Project>`)).toHaveLength(1);
    // Round 4: the unquoted form counts the same way.
    expect(unpinnedImports('src/Directory.Build.props', '<Project><Import Project="$([MSBuild]::GetPathOfFileAbove(Directory.Build.props, $(MSBuildThisFileDirectory)..))" /></Project>')).toEqual([]);
    expect(unpinnedImports('src/Directory.Build.props', '<Project><Import Project="$([MSBuild]::GetPathOfFileAbove(Directory.Build.props, $(MSBuildThisFileDirectory)..\\))" /></Project>')).toEqual([]);
    expect(unpinnedImports('Directory.Build.props', '<Project><Import Project="$([MSBuild]::GetPathOfFileAbove(Sources.msbuild, $(MSBuildThisFileDirectory)..))" /></Project>')).toHaveLength(1);
    expect(unpinnedImports('Directory.Build.props', '<Project><Import Project="$([MSBuild]::GetPathOfFileAbove($(Name).props, $(MSBuildThisFileDirectory)..))" /></Project>')).toHaveLength(1);
    expect(unpinnedImports('a.csproj', '<Project><!-- <Import Project="x.msbuild" /> --></Project>')).toEqual([]);
    expect(unpinnedImports('nuget.config', '<Import Project="x.msbuild" />')).toEqual([]);
    expect(unpinnedImports('a.props', 'x'.repeat(PINNED_READ_MAX + 1))).toHaveLength(1);
  });

  it('round 5: GetPathOfFileAbove starts only at $(MSBuildThisFileDirectory) plus `..` inside the repository; an Import that leaves the repository counts', () => {
    const imp = (path: string, value: string) => unpinnedImports(path, `<Project><Import Project="${value}" /></Project>`);
    // The start dir: only the importing file's dir or one above it that is still inside the repository.
    for (const v of [
      "$([MSBuild]::GetPathOfFileAbove('Corp.props', 'C:/corp'))",
      '$([MSBuild]::GetPathOfFileAbove(Corp.props, $(CorpRoot)))',
      '$([MSBuild]::GetPathOfFileAbove(x.props, $(MSBuildThisFileDirectory)../eng/Sources.msbuild))',
      "$([MSBuild]::GetPathOfFileAbove('x.props', '$(MSBuildThisFileDirectory)eng'))",
      '$([MSBuild]::GetPathOfFileAbove(x.props, $(MSBuildProjectDirectory)))',
    ]) expect(imp('src/a/A.csproj', v), v).toEqual([v]);
    for (const v of [
      '$([MSBuild]::GetPathOfFileAbove(x.props))',
      "$([MSBuild]::GetPathOfFileAbove('x.props', '$(MSBuildThisFileDirectory)'))",
      "$([MSBuild]::GetPathOfFileAbove('x.props', '$(MSBuildThisFileDirectory)../..'))",
      '$([MSBuild]::GetPathOfFileAbove(x.props, $(MSBuildThisFileDirectory)..\\..\\))',
      '$([msbuild]::getpathoffileabove(X.PROPS, $(msbuildthisfiledirectory)..))',
    ]) expect(imp('src/a/A.csproj', v), v).toEqual([]);
    // Round 6: a start above the root searches nothing the engine's trees hold (a file above the checkout is a config the
    // engine cannot see), so it is pinned like GetDirectoryNameOfFileAbove: the root Directory.Build.props idiom restores.
    expect(imp('src/a/A.csproj', "$([MSBuild]::GetPathOfFileAbove('x.props', '$(MSBuildThisFileDirectory)../../..'))")).toEqual([]);
    expect(imp('Directory.Build.props', "$([MSBuild]::GetPathOfFileAbove('Directory.Build.props', '$(MSBuildThisFileDirectory)../'))")).toEqual([]);
    expect(imp('Directory.Build.props', '$([MSBuild]::GetDirectoryNameOfFileAbove($(MSBuildThisFileDirectory).., Directory.Build.props))\\Directory.Build.props')).toEqual([]);
    // A literal path or one after $(MSBuildThisFileDirectory): absolute or above the root counts; inside does not.
    for (const v of ['../../outside/Corp.props', '$(MSBuildThisFileDirectory)..\\..\\outside\\Corp.props', 'C:\\corp\\Corp.props', '/opt/corp/Corp.props', '\\\\server\\share\\Corp.props']) {
      expect(imp('a/A.csproj', v), v).toEqual([v]);
    }
    for (const v of ['../eng/Versions.props', '$(MSBuildThisFileDirectory)..\\eng\\Versions.props', 'eng/./x.props']) expect(imp('a/A.csproj', v), v).toEqual([]);
    expect(imp('Directory.Build.props', '../Corp.props')).toHaveLength(1);
    // Not resolved (documented): a path built from another property counts by its extension only.
    expect(imp('a/A.csproj', '$(RepoRoot)eng/Versions.props')).toEqual([]);
  });
});

describe('round 6: node_modules imports, separators after $(MSBuildThisFileDirectory), %XX escapes', () => {
  const imp = (path: string, value: string) => unpinnedImports(path, `<Project><Import Project="${value}" /></Project>`);

  it('an Import with a node_modules segment is never pinned (any case, either separator, escaped, after a property, as a GetPathOfFileAbove name)', () => {
    for (const v of [
      '../node_modules/corp/Sources.props',
      '..\\NODE_MODULES\\corp\\Sources.props',
      '../node%5fmodules/corp/Sources.props',
      '$(MSBuildThisFileDirectory)../node_modules/corp/Sources.props',
      '$(RepoRoot)node_modules\\corp\\Sources.props',
      "$([MSBuild]::GetPathOfFileAbove('node_modules/corp/Sources.props', '$(MSBuildThisFileDirectory)'))",
    ]) expect(imp('Lib/Directory.Build.props', v), v).toEqual([v]);
  });

  it('$(MSBuildThisFileDirectory) ends in a separator: a separator after it stays inside the repository', () => {
    for (const v of ['$(MSBuildThisFileDirectory)\\eng\\Versions.props', '$(MSBuildThisFileDirectory)/eng/Versions.props', '$(MSBuildThisFileDirectory)eng\\Versions.props']) {
      expect(imp('Directory.Build.props', v), v).toEqual([]);
    }
    expect(imp('Directory.Build.props', '$(MSBuildThisFileDirectory)\\..\\corp.props')).toHaveLength(1);
  });

  it('%XX is unescaped before the checks; an escaped ; does not split', () => {
    for (const v of ['%2e%2e/corp/Sources.props', '$(MSBuildThisFileDirectory)%2e%2e\\corp.props', 'C%3a/corp/corp.props']) expect(imp('Directory.Build.props', v), v).toEqual([v]);
    expect(imp('Directory.Build.props', 'eng/a.props%3Beng/b.props')).toEqual([]);
    expect(imp('Directory.Build.props', 'eng/Sources%2emsbuild')).toHaveLength(1);
  });

  it('the attack forms stay unpinned', () => {
    for (const v of [
      '../../outside/Corp.props',
      'C:/corp/corp.props',
      '\\\\server\\share\\corp.props',
      "$([MSBuild]::GetPathOfFileAbove('Directory.Build.props', '$(CorpRoot)'))",
      "$([MSBuild]::GetPathOfFileAbove('../../corp.props', '$(MSBuildThisFileDirectory)'))",
      "$([MSBuild]::GetPathOfFileAbove('C:/corp/corp.props'))",
      "$([System.IO.Path]::Combine('..','corp.props'))",
    ]) expect(imp('Directory.Build.props', v), v).toEqual([v]);
  });

  it('package runners: a path prefix, options before the subcommand, pnpx, bun x and .ps1 count; yarn/pnpm <bin> and yarn run do not', () => {
    for (const c of ['C:\\nodejs\\npx.cmd tsc', '/usr/bin/npx tsc', '&quot;C:\\Program Files\\nodejs\\npx.cmd&quot; tsc', 'npm --yes exec tsc', 'npm -y x tsc', 'pnpm --silent dlx tsc', 'yarn --cwd web exec tsc', 'pnpm --dir=web exec tsc', 'pnpx tsc', 'bun x tsc', 'npx.ps1 tsc', 'pnpm.ps1 dlx tsc']) {
      expect(nodeModulesReferences('a.csproj', `<Exec Command="${c}" />`), c).toEqual([expect.stringContaining('Exec Command (npx runs node_modules/.bin)')]);
    }
    for (const c of ['pnpm tsc', 'yarn tsc', 'yarn run tsc', 'npm run-script build', 'npm --prefix web run build', 'bun run build', 'pnpm --filter web build']) {
      expect(nodeModulesReferences('a.csproj', `<Exec Command="${c}" />`), c).toEqual([]);
    }
  });
});

describe('H2 / M3: restore settings and project SDKs in pinned files', () => {
  it('restoreSettingMentions: the restore properties in MSBuild and response files, any case; other files none', () => {
    expect(restoreSettingMentions('src/App/App.csproj', '<Project><PropertyGroup><RestoreSources>corp</RestoreSources></PropertyGroup></Project>')).toEqual(['RestoreSources']);
    expect(restoreSettingMentions('Directory.Build.props', '<restoreadditionalprojectsources>x</restoreadditionalprojectsources><RestoreConfigFile>a</RestoreConfigFile>')).toEqual(['RestoreConfigFile', 'restoreadditionalprojectsources']);
    expect(restoreSettingMentions('Directory.Build.rsp', '-p:RestoreSources=https://example.test/v3/index.json')).toEqual(['RestoreSources']);
    for (const p of ['RestoreFallbackFolders', 'RestorePackagesPath', 'RestoreNoCache', 'RestoreIgnoreFailedSources']) expect(restoreSettingMentions('a.props', `<${p}>x</${p}>`)).toEqual([p]);
    expect(restoreSettingMentions('a.props', '<RestoreLockedMode>true</RestoreLockedMode>')).toEqual([]);
    expect(restoreSettingMentions('nuget.config', '<RestoreSources/>')).toEqual([]);
    expect(restoreSettingMentions('a.props', 'x'.repeat(PINNED_READ_MAX + 1))).toHaveLength(1);
  });

  it('projectSdkMentions: versioned Sdk attributes, Sdk elements, Import Sdk+Version and global.json msbuild-sdks', () => {
    expect(projectSdkMentions('A/A.proj', '<Project Sdk="Microsoft.Build.NoTargets/3.7.56" />')).toEqual(['Microsoft.Build.NoTargets/3.7.56']);
    expect(projectSdkMentions('A/A.csproj', '<Project Sdk="Microsoft.NET.Sdk" />')).toEqual([]);
    expect(projectSdkMentions('dirs.proj', '<Project><Sdk Name="Microsoft.Build.Traversal" Version="4.1.0" /></Project>')).toEqual(['Microsoft.Build.Traversal/4.1.0']);
    expect(projectSdkMentions('a.props', '<Project><Import Project="Sdk.props" Sdk="X.Sdk" Version="1.0.0" /></Project>')).toEqual(['X.Sdk/1.0.0']);
    expect(projectSdkMentions('global.json', '{ "sdk": { "version": "10.0.101" }, "msbuild-sdks": { "Microsoft.Build.Traversal": "4.1.0" } }')).toEqual(['Microsoft.Build.Traversal/4.1.0']);
    expect(projectSdkMentions('global.json', '{ "sdk": { "version": "10.0.101" } }')).toEqual([]);
  });
});

describe('L1: linear scans of crafted pinned files', () => {
  const rep = (s: string, n = PINNED_READ_MAX) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
  it('each pathological 256 KB input under 200 ms', () => {
    const cases: Array<[string, string]> = [
      ['a.props', rep('<!--')], ['a.props', rep('<Import "')], ['a.props', `<Import ${rep('a')}`], ['a.props', rep('<Exec ')],
      ['a.props', rep('<Exec Command="')], ['a.props', `<Exec ${rep('x="a" ')}`], ['Directory.Build.rsp', rep('-p:a=b ')],
      ['global.json', rep('"\\')], ['a.slnf', rep('"\\')], ['a.sln', rep('Project(\n')], ['nuget.config', rep('<add value="')],
      ['a.props', rep('<a>')], ['a.props', `<Exec Command="${rep('npm -a ')}" />`], ['a.props', `<Exec Command="${rep('npm -a b ')}" />`],
      ['a.props', `<Import Project="${rep('%2e')}" />`],
    ];
    for (const [p, t] of cases) {
      const start = performance.now();
      nodeModulesReferences(p, t);
      restoreSettingMentions(p, t);
      projectSdkMentions(p, t);
      unpinnedImports(p, t);
      expect(performance.now() - start, `${p} ${t.slice(0, 12)}`).toBeLessThan(200);
    }
  });

  it('a file above the cap is not read: its references are unknown (one, conservative)', () => {
    expect(nodeModulesReferences('a.props', rep('x', PINNED_READ_MAX + 1))).toEqual([expect.stringContaining('not read')]);
  });
});
