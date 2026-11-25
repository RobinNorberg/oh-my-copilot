/**
 * References from pinned definition files into node_modules (dotnet-package-refs.ts) and the exact-tree check a
 * dotnet gate needs when they exist (prepare.ts gateTreeExactProblem). Throwaway dirs only; every link target lies in
 * the same temp dir.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expressionRefs, hasNodeModulesSegment, isEnvironmentOnlyName, isReservedProperty, nodeModulesReferences, PINNED_READ_MAX, projectSdkMentions, readsForNodeModulesRefs, RESTORE_READS_MAX, RESTORE_WORK_MAX, restoreHostReads, restoreSettingMentions, unpinnedImports } from '../dotnet-package-refs.js';
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


describe('restoreHostReads: package-source settings that depend on your environment or machine', () => {
  const props = (body: string) => `<Project>${body}</Project>\n`;
  const pg = (body: string, cond?: string) => `<PropertyGroup${cond ? ` Condition="${cond}"` : ''}>${body}</PropertyGroup>`;
  const lib = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n';
  const CORP = '<Project><PropertyGroup><RestoreSources>https://corp.invalid/v3/index.json</RestoreSources></PropertyGroup></Project>\n';
  const reads = (files: Record<string, string>) => restoreHostReads(Object.entries(files).map(([path, text]) => ({ path, text })));
  const parks = (files: Record<string, string>) => reads(files).reads.length > 0;

  it('expressionRefs: properties, registry, environment functions, %NAME% only when asked', () => {
    expect(expressionRefs(`$(A);$( B );$(C.Replace('x','y'));$(Registry:HKEY_X)`).sort()).toEqual(['A', 'B', 'C', '[registry]']);
    expect(expressionRefs(`$([System.Environment]::GetEnvironmentVariable('CORP'))`)).toEqual(['[env CORP]']);
    expect(expressionRefs(`$([System.Environment]::GetEnvironmentVariable($(N)))`).sort()).toEqual(['N', '[env ?]']);
    expect(expressionRefs(`$([System.Environment]::GetFolderPath(SpecialFolder.UserProfile))`)).toEqual(['[GetFolderPath]']);
    expect(expressionRefs(`$([System.Environment]::UserDomainName)$([System.Environment]:: MachineName)`)).toEqual(['[UserDomainName]', '[MachineName]']);
    expect(expressionRefs('%CORP%/feed')).toEqual([]);
    expect(expressionRefs('%CORP%/feed', true)).toEqual(['[env CORP]']);
    // A URL's %XX escapes are not environment variables; a two-hex-digit name outside an escape run is one.
    expect(expressionRefs('https://x/a%C3%A9b', true)).toEqual([]);
    expect(expressionRefs('https://x/My%20Project/a', true)).toEqual([]);
    expect(expressionRefs('https://x/a%2F%2Fb', true)).toEqual([]);
    expect(expressionRefs('https://x/caf%C3%A9%2Fx?c=%E2%9C%93ok', true)).toEqual([]);
    expect(expressionRefs('https://corp/%AB%/v3', true)).toEqual(['[env AB]']);
    expect(expressionRefs('%AB%', true)).toEqual(['[env AB]']);
    expect(expressionRefs('%A%B%', true).sort()).toEqual(['[env A]', '[env B]']);
    // A host-read word outside a property function reads nothing.
    expect(expressionRefs('GetEnvironmentVariable(CORP)')).toEqual([]);
  });

  it('reserved: what MSBuild or the SDK defines (typed SDK booleans too); never profile or CI names', () => {
    for (const n of ['Configuration', 'MSBuildThisFileDirectory', 'PkgNewtonsoft_Json', 'IsCrossTargetingBuild', 'SelfContained', 'PublishTrimmed', 'PublishAot', 'PublishSingleFile', 'PublishReadyToRun', 'UseAppHost', 'IsAotCompatible', 'UseWPF', 'UseWindowsForms', 'EnableWindowsTargeting', 'os']) expect(isReservedProperty(n), n).toBe(true);
    for (const n of ['USERPROFILE', 'HOME', 'USERDOMAIN', 'APPDATA', 'CI', 'TF_BUILD', 'GITHUB_ACTIONS', 'BUILD_BUILDNUMBER', 'NCrunch', 'UseCorpFeed']) expect(isReservedProperty(n), n).toBe(false);
    for (const n of ['EnableDefaultItems', 'EnableDefaultCompileItems', 'BuildingForLiveUnitTesting', 'BundledNETCoreAppTargetFrameworkVersion', 'NETCoreAppMaximumVersion', 'MicrosoftNETCoreAppRefPackageVersion', 'UsingMicrosoftNETSdkWebAssembly', 'UsingMicrosoftNETSdkStaticWebAssets', 'PlatformName', 'IsPublishing', '_IsPublishing', 'TargetFrameworkProfile', 'ImportDirectoryBuildProps', 'ImportDirectoryBuildTargets', 'SdkAnalysisLevel', 'UseMaui', 'MauiVersion', 'BuildingSolutionFile', 'BuildProjectReferences', 'DefaultItemExcludes', 'Prefer32Bit', 'IsImplicitlyTriggeredBuild', 'IsTestingPlatformApplication', 'IsAspireHost']) expect(isReservedProperty(n), n).toBe(true);
    // CI and profile names: the remedy moves the setting out from under them.
    for (const n of ['CI', 'TF_BUILD', 'GITHUB_ACTIONS', 'BUILD_BUILDNUMBER', 'SYSTEM_TEAMPROJECT', 'HOME', 'USERPROFILE', 'USERDOMAIN']) expect(isEnvironmentOnlyName(n), n).toBe(true);
    for (const n of ['UseCorpFeed', 'CorpFeed', 'InternalBuild']) expect(isEnvironmentOnlyName(n), n).toBe(false);
  });

  it('an ordinary repo reads nothing: no source setting, so Import conditions on CI and environment names do not matter; a nuget.config with literal sources', () => {
    const r = reads({
      'nuget.config': '<configuration><packageSources><clear /><add key="nuget.org" value="https://api.nuget.org/v3/index.json" /></packageSources></configuration>',
      'Directory.Build.props': props(pg(`<RepoRoot Condition="'$(RepoRoot)' == ''">$(MSBuildThisFileDirectory)</RepoRoot><ContinuousIntegrationBuild Condition="'$(TF_BUILD)' == 'true'">true</ContinuousIntegrationBuild><Version Condition="'$(BUILD_BUILDNUMBER)' != ''">$(BUILD_BUILDNUMBER)</Version><HomeTools>$(HOME)/bin</HomeTools>`)
        + `<Import Project="$(RepoRoot)eng/Versions.props" /><Import Project="eng/ci.props" Condition="'$(ContinuousIntegrationBuild)' == 'true'" /><ImportGroup Condition="'$(NCrunch)' != '1'"><Import Project="eng/a.props" /></ImportGroup><Import Project="eng/u.props" Condition="'$(USERDOMAIN)' == 'CORP'" />`),
      'Lib/Lib.csproj': lib,
      'Directory.Build.rsp': '-p:FromRsp=1\n-nr:false\n-m\n',
    });
    expect(r).toEqual({ reads: [], more: 0, names: [], fixes: [] });
  });

  it('(a) a source setting whose value or condition (own, group, Choose branch, target) reads an env-settable name or a host read', () => {
    expect(reads({ 'a.props': props(pg('<RestoreSources>$(CORP_FEED)</RestoreSources>')) })).toEqual({ reads: ['a.props: <RestoreSources> reads $(CORP_FEED), which no pinned file gives an unconditional value'], more: 0, names: ['CORP_FEED'], fixes: [] });
    expect(reads({ 'a.props': props(pg('<RestoreSources>https://corp/v3</RestoreSources>', "'$(UseCorp)' == 'true'")) }).reads).toEqual(['a.props: <RestoreSources> reads $(UseCorp), which no pinned file gives an unconditional value']);
    // A default conditioned on itself is no unconditional value.
    expect(reads({ 'a.props': props(pg(`<UseCorp Condition="'$(UseCorp)' == ''">false</UseCorp><RestoreSources Condition="'$(UseCorp)' == 'true'">https://corp/v3</RestoreSources>`)) }).names).toEqual(['UseCorp']);
    // A Choose: the When's condition, and an Otherwise reads its Whens' conditions.
    expect(parks({ 'a.props': props(`<Choose><When Condition="'$(UseCorp)' == 'true'">${pg('<RestoreSources>https://corp/v3</RestoreSources>')}</When></Choose>`) })).toBe(true);
    expect(reads({ 'a.props': props(`<Choose><When Condition="'$(UseCorp)' == 'true'">${pg('<X>1</X>')}</When><Otherwise>${pg('<RestoreSources>https://api.nuget.org/v3/index.json</RestoreSources>')}</Otherwise></Choose>`) }).names).toEqual(['UseCorp']);
    // Every source setting, a task Output (escaped name too) inside a conditioned target.
    for (const s of ['RestoreAdditionalProjectSources', 'RestoreFallbackFolders', 'RestoreAdditionalProjectFallbackFolders', 'RestoreConfigFile', 'RestoreRootConfigDirectory']) expect(parks({ 'a.props': props(pg(`<${s}>$(CORP)</${s}>`)) }), s).toBe(true);
    // RestorePackagesPath is where packages land, not a source: neither its value nor its condition parks.
    expect(parks({ 'a.props': props(pg(`<RestorePackagesPath Condition="'$(CI)' == 'true'">$(CORP_PKGS)</RestorePackagesPath>`)) })).toBe(false);
    expect(reads({ 'a.targets': props(`<Target Name="T" Condition="'$(UseCorp)' == 'true'"><CreateProperty Value="https://corp/v3"><Output TaskParameter="Value" PropertyName="Restore%53ources" /></CreateProperty></Target>`) }).reads).toEqual(['a.targets: <RestoreSources> reads $(UseCorp), which no pinned file gives an unconditional value']);
    // Host reads.
    expect(reads({ 'a.props': props(pg(`<RestoreSources>$([System.Environment]::GetEnvironmentVariable('CORP'))</RestoreSources>`)) }).reads).toEqual(['a.props: <RestoreSources> reads the environment variable CORP']);
    expect(reads({ 'a.props': props(pg('<RestoreConfigFile>$(Registry:HKEY_CURRENT_USER\\Corp@Config)</RestoreConfigFile>')) }).reads).toEqual(['a.props: <RestoreConfigFile> reads the registry']);
    expect(reads({ 'a.props': props(pg('<RestoreSources>C:/corp/feed</RestoreSources>', "'$([System.Environment]::UserDomainName)' == 'CORP'")) }).reads).toEqual(['a.props: <RestoreSources> reads $([System.Environment]::UserDomainName)']);
    // Entities are decoded.
    expect(reads({ 'a.props': props(pg('<RestoreSources>$(&#67;orpFeeds)</RestoreSources>')) }).names).toEqual(['CorpFeeds']);
    // A source setting that reads a source setting (an append) is not an environment read.
    expect(parks({ 'a.props': props(pg('<RestoreAdditionalProjectSources>$(RestoreAdditionalProjectSources);$(MSBuildThisFileDirectory)feed</RestoreAdditionalProjectSources>')) })).toBe(false);
  });

  it('reads are followed through every pinned definition, transitively; the reason names the property it went through', () => {
    const r = reads({ 'a.props': props(pg('<Base>$(CORP_FEED)</Base><Feeds>$(Base);x</Feeds><RestoreSources>$(Feeds)</RestoreSources>')) });
    expect(r).toEqual({ reads: ['a.props: <RestoreSources> reads $(CORP_FEED) through $(Feeds), which no pinned file gives an unconditional value'], more: 0, names: ['CORP_FEED'], fixes: [] });
    // A conditional redefinition the environment decides counts even after an unconditional one.
    expect(reads({ 'a.props': props(pg('<Feed>https://api.nuget.org/v3/index.json</Feed>') + pg('<Feed>https://corp/v3</Feed>', "'$(UseCorp)' == 'true'") + pg('<RestoreSources>$(Feed)</RestoreSources>')) }).names).toEqual(['UseCorp']);
    // A response file's %NAME%.
    expect(reads({ 'Directory.Build.rsp': '-p:CorpFeed=%OMG25_CORP_FEED%\n', 'Directory.Build.props': props(pg(`<RestoreSources Condition="Exists('$(CorpFeed)')">$(CorpFeed)</RestoreSources>`)) }).reads)
      .toEqual(['Directory.Build.props: <RestoreSources> reads the environment variable OMG25_CORP_FEED through $(CorpFeed)']);
    expect(reads({ 'Directory.Build.rsp': '-rp:RestoreSources=%FEED%;X=1\n' }).reads).toEqual(['Directory.Build.rsp: <RestoreSources> reads the environment variable FEED']);
    expect(reads({ 'a.rsp': '-p:"Deterministic=true"\n-nr:false\n-m\n/p:A=b;C=d\n' }).reads).toEqual([]);
    // Every switch spelling, `,` and `;` separators, quotes; `#` comment lines are not read.
    for (const rsp of ['-p:Foo=1,RestoreSources=%FEED%', '--property:RestoreSources=%FEED%', '-property:RestoreSources=%FEED%', '/p:RestoreSources=%FEED%', '/property:RestoreSources=%FEED%', '-p:"RestoreSources=%FEED%"', '-p:A=1;RestoreSources=%FEED%', '-restoreProperty:RestoreSources=%FEED%']) {
      expect(reads({ 'Directory.Build.rsp': `${rsp}\n` }).reads, rsp).toEqual(['Directory.Build.rsp: <RestoreSources> reads the environment variable FEED']);
    }
    expect(parks({ 'Directory.Build.rsp': '# -p:RestoreSources=%FEED%\n  #-p:RestoreSources=%FEED%\n-m\n' })).toBe(false);
  });

  it('where an unconditional definition counts: the same file before the read, a Directory.Build.* / Directory.Packages.props or response file, a file imported by a resolvable path', () => {
    const setting = pg(`<RestoreSources Condition="'$(Feed)' != ''">$(Feed)</RestoreSources>`);
    const def = pg('<Feed>https://api.nuget.org/v3/index.json</Feed>');
    expect(parks({ 'a.props': props(def + setting) })).toBe(false);
    // After the read in the same file: the environment's value is what the setting saw.
    expect(parks({ 'a.props': props(setting + def) })).toBe(true);
    expect(parks({ 'Lib/Lib.csproj': props(setting), 'Directory.Build.props': props(def) })).toBe(false);
    expect(parks({ 'Lib/Lib.csproj': props(setting), 'Directory.Packages.props': props(def) })).toBe(false);
    // An auto-imported file only on the path above the read's file: src/Directory.Packages.props is not above Lib/.
    expect(parks({ 'Lib/Lib.csproj': props(setting), 'src/Directory.Packages.props': props(def) })).toBe(true);
    expect(parks({ 'Lib/Lib.csproj': props(setting), 'Directory.Build.rsp': '-p:Feed=https://api.nuget.org/v3/index.json\n' })).toBe(false);
    expect(parks({ 'Lib/Lib.csproj': props(setting), 'Directory.Build.props': props('<Import Project="$(MSBuildThisFileDirectory)eng\\Feeds.props" />'), 'eng/Feeds.props': props(def) })).toBe(false);
    expect(parks({ 'Lib/Lib.csproj': props(setting), 'Directory.Build.props': props('<Import Project="../eng/Feeds.props" />'), 'eng/Feeds.props': props(def) })).toBe(true);
    // A pinned file nothing imports by a path the engine can resolve, a conditioned group, a target: no unconditional value.
    expect(parks({ 'Lib/Lib.csproj': props(setting), 'eng/Unused.props': props(def) })).toBe(true);
    expect(parks({ 'a.props': props(pg('<Feed>https://api.nuget.org/v3/index.json</Feed>', "'$(Configuration)' == 'Debug'") + setting) })).toBe(true);
    expect(parks({ 'a.props': props(`<Target Name="T">${def}</Target>${setting}`) })).toBe(true);
  });

  it('(b) when a file sets a source setting, an Import whose condition (own or group) reads an env-settable name or a host read parks; reserved names do not', () => {
    const imp = (cond: string, body = '') => ({ 'Directory.Build.props': props(`${body}<Import Project="$(MSBuildThisFileDirectory)eng/CorpFeed.props" Condition="${cond}" />`), 'eng/CorpFeed.props': CORP });
    expect(reads(imp("'$(UseCorpFeed)' == 'true'"))).toEqual({
      reads: ['eng/CorpFeed.props sets <RestoreSources>, and Directory.Build.props: Import "$(MSBuildThisFileDirectory)eng/CorpFeed.props" has a condition that reads $(UseCorpFeed), which no pinned file gives an unconditional value'],
      more: 0,
      names: ['UseCorpFeed'],
      fixes: [],
    });
    // A CI or profile name read only by an Import's condition is no name for the remedy (no source setting sits under it).
    expect(reads(imp("'$(USERDOMAIN)' == 'CORP'"))).toEqual(expect.objectContaining({ reads: [expect.stringContaining('has a condition that reads $(USERDOMAIN)')], names: [] }));
    expect(reads(imp("Exists('$(CORP_TOOLS)/feed.marker')")).names).toEqual(['CORP_TOOLS']);
    expect(reads(imp("'$(InternalBuild)' == 'true'", pg('<InternalBuild>$(TF_BUILD)</InternalBuild>')))).toEqual(expect.objectContaining({ reads: [expect.stringContaining('reads $(TF_BUILD) through $(InternalBuild)')], names: [] }));
    // One read per Import: the first name its condition reaches.
    expect(reads(imp("'$(InternalBuild)' == 'true'", pg('<InternalBuild>true</InternalBuild>', "'$(TF_BUILD)' == 'True'"))).names).toEqual(['InternalBuild']);
    expect(reads(imp("'$(Registry:HKEY_LOCAL_MACHINE\\Corp@Feed)' != ''")).reads).toEqual([expect.stringContaining('has a condition that reads the registry')]);
    // A target that is not a pinned file: the engine cannot tell what it sets.
    expect(parks({ 'Directory.Build.props': props(`<ImportGroup Condition="'$(CI)' == 'true'"><Import Project="eng/ci.props" /></ImportGroup>${pg('<RestoreSources>https://api.nuget.org/v3/index.json</RestoreSources>')}`) })).toBe(true);
    // A literal source setting with imports conditioned only on reserved names (and names a pinned file defines unconditionally): no read.
    for (const cond of ["'$(IsCrossTargetingBuild)' != 'true'", "'$(Configuration)' == 'Debug' and '$(OS)' == 'Windows_NT'", "'$(SelfContained)' == 'true'", "Exists('$(MSBuildThisFileDirectory)eng/x.props')"]) expect(parks(imp(cond)), cond).toBe(false);
    expect(parks(imp("'$(UseCorpFeed)' == 'true'", pg('<UseCorpFeed>false</UseCorpFeed>')))).toBe(false);
    // RestorePackagesPath names no source: it does not make Import conditions matter.
    expect(parks({ 'Directory.Build.props': props(`${pg('<RestorePackagesPath>$(MSBuildThisFileDirectory)packages</RestorePackagesPath>')}<Import Project="eng/ci.props" Condition="'$(CI)' == 'true'" />`) })).toBe(false);
  });

  it('(c) an Import path the environment chooses, a %NAME% in a nuget.config value: parks whether or not a file sets a source setting', () => {
    for (const [project, why] of [
      ['$(LocalOverrides)', 'reads $(LocalOverrides) in its path, which no pinned file defines'],
      ['$(USERPROFILE)/corp/Build.props', 'reads $(USERPROFILE) in its path, which no pinned file defines'],
      ['$([System.Environment]::GetFolderPath(SpecialFolder.UserProfile))/x.props', 'reads $([System.Environment]::GetFolderPath(...)) in its path'],
    ]) expect(reads({ 'Directory.Build.props': props(`<Import Project="${project}" />`) }).reads, project).toEqual([expect.stringContaining(why)]);
    // A profile name a pinned file defines only conditionally still picks the file; a repository property does not.
    expect(parks({ 'a.props': props(`${pg("<HOME Condition=\"'$(HOME)' == ''\">x</HOME>")}<Import Project="$(HOME)/corp.props" />`) })).toBe(true);
    expect(parks({ 'a.props': props(`${pg("<RepoRoot Condition=\"'$(RepoRoot)' == ''\">$(MSBuildThisFileDirectory)</RepoRoot>")}<Import Project="$(RepoRoot)eng/x.props" />`) })).toBe(false);
    expect(reads({ 'nuget.config': '<configuration><packageSources><clear /><add key="corp" value="%CORP_FEED%" /></packageSources></configuration>' }).reads).toEqual(['nuget.config: the value "%CORP_FEED%" reads the environment variable CORP_FEED']);
  });

  it('a file above the cap, or one that is not UTF-8 text, is a read the engine cannot clear, with its remedy', () => {
    for (const p of ['a.props', 'a.rsp', 'nuget.config']) {
      expect(reads({ [p]: 'x'.repeat(PINNED_READ_MAX + 1) }), p).toEqual({ reads: [`${p}: larger than 256 KB, so the engine did not read it and cannot tell whether its package-source settings depend on your environment`], more: 0, names: [], fixes: [`keep ${p} under 256 KB`] });
    }
    // UTF-16 (with its byte order mark or without) as the engine decodes a blob: as UTF-8.
    const utf16 = (s: string, bom: boolean) => Buffer.from(`${bom ? '\ufeff' : ''}${s}`, 'utf16le').toString('utf8');
    for (const bom of [true, false]) {
      expect(reads({ 'Directory.Build.props': utf16(props(pg('<RestoreSources>$(CorpFeed)</RestoreSources>')), bom) }), String(bom)).toEqual({
        reads: ['Directory.Build.props: not UTF-8 text (UTF-16 or binary), so the engine cannot read its package-source settings'], more: 0, names: [], fixes: ['re-save Directory.Build.props as UTF-8'],
      });
    }
    expect(reads({ 'nuget.config': Buffer.from('\ufeff<configuration />', 'utf16le').toString('utf8') }).fixes).toEqual(['re-save nuget.config as UTF-8']);
    // A UTF-8 byte order mark and CRLF line ends are UTF-8 text; files the rule does not read are not checked.
    expect(parks({ 'Directory.Build.props': `\ufeff${props(pg('<LangVersion>latest</LangVersion>'))}`.replace(/\n/g, '\r\n'), 'global.json': '\u0000' })).toBe(false);
  });

  it('where an unconditional definition counts: only files of the evaluation of the file that reads it (rule 2)', () => {
    const read = props(pg('<RestoreSources>$(CorpFeed)</RestoreSources>'));
    const def = props(pg('<CorpFeed>https://api.nuget.org/v3/index.json</CorpFeed>'));
    // A conditioned Import (on OS or Configuration) of the file that defines it: no unconditional value.
    for (const cond of ["'$(OS)' != 'Windows_NT'", "'$(Configuration)' == 'Release'"]) {
      expect(reads({ 'Directory.Build.props': props(`<Import Project="$(MSBuildThisFileDirectory)eng/Unix.props" Condition="${cond}" />${pg('<RestoreSources>$(CorpFeed)</RestoreSources>')}`), 'eng/Unix.props': def }).reads, cond)
        .toEqual(['Directory.Build.props: <RestoreSources> reads $(CorpFeed), which pinned files give an unconditional value only outside this evaluation (in files not auto-imported, imported under a condition, or imported by a path the engine does not resolve: only literal and $(MSBuildThisFileDirectory)-based paths)']);
    }
    // Imported unconditionally, by a group with no condition too: counts.
    expect(parks({ 'Directory.Build.props': props(`<ImportGroup><Import Project="eng/Unix.props" /></ImportGroup>${pg('<RestoreSources>$(CorpFeed)</RestoreSources>')}`), 'eng/Unix.props': def })).toBe(false);
    // Imported only by another project; a sibling Directory.Build.props; a response file that MSBuild does not auto-read.
    expect(parks({ 'samples/S/S.csproj': props('<Import Project="$(MSBuildThisFileDirectory)../../eng/Defaults.props" />'), 'eng/Defaults.props': def, 'Directory.Build.props': read })).toBe(true);
    expect(parks({ 'Directory.Build.props': read, 'tests/Directory.Build.props': def })).toBe(true);
    expect(parks({ 'Directory.Build.props': read, 'eng/ci.rsp': '-p:CorpFeed=https://api.nuget.org/v3/index.json\n' })).toBe(true);
    expect(parks({ 'Directory.Build.props': read, 'Directory.Build.rsp': '-p:CorpFeed=https://api.nuget.org/v3/index.json\n' })).toBe(false);
    // The nearest Directory.Build.props only, unless it imports the next one up (GetPathOfFileAbove).
    const lib = props(pg('<RestoreSources>$(CorpFeed)</RestoreSources>'));
    expect(parks({ 'src/Lib/Lib.csproj': lib, 'Directory.Build.props': def, 'src/Directory.Build.props': props(pg('<LangVersion>latest</LangVersion>')) })).toBe(true);
    expect(parks({ 'src/Lib/Lib.csproj': lib, 'Directory.Build.props': def, 'src/Directory.Build.props': props(`<Import Project="$([MSBuild]::GetPathOfFileAbove('Directory.Build.props', '$(MSBuildThisFileDirectory)../'))" />`) })).toBe(false);
    expect(parks({ 'src/Lib/Lib.csproj': lib, 'Directory.Build.props': def })).toBe(false);
    // A Directory.Build.targets and a Directory.Packages.props above count too; through an unconditional chain of imports.
    expect(parks({ 'src/Lib/Lib.csproj': lib, 'Directory.Build.targets': props('<Import Project="eng/a.props" />'), 'eng/a.props': props('<Import Project="b.props" />'), 'eng/b.props': def })).toBe(false);
    // Defined after the read in the same file says so.
    expect(reads({ 'a.props': props(pg('<RestoreSources>$(CorpFeed)</RestoreSources><CorpFeed>x</CorpFeed>')) }).reads).toEqual(['a.props: <RestoreSources> reads $(CorpFeed), which its file gives an unconditional value only after the read']);
  });

  it('(b) refined: a conditioned Import parks only when what it loads can change the sources (rule 3)', () => {
    const literal = pg('<RestoreAdditionalProjectSources>$(MSBuildThisFileDirectory)artifacts/packages</RestoreAdditionalProjectSources>');
    const ci = (imported: Record<string, string>, cond = "'$(CI)' == 'true'") => ({ 'Directory.Build.props': props(`${literal}<Import Project="$(MSBuildThisFileDirectory)eng/ci.props" Condition="${cond}" />`), ...imported });
    // Sets nothing that a source setting or an Import reads: no read.
    expect(reads(ci({ 'eng/ci.props': props(pg('<ContinuousIntegrationBuild>true</ContinuousIntegrationBuild>')) }))).toEqual({ reads: [], more: 0, names: [], fixes: [] });
    expect(parks(ci({ 'eng/ci.props': props(pg('<VersionSuffix>ci.$(BUILD_BUILDNUMBER)</VersionSuffix>')) }, "'$(TF_BUILD)' == 'True'"))).toBe(false);
    // Sets a source setting itself, or through what it imports (under any condition).
    expect(parks(ci({ 'eng/ci.props': props(pg('<RestoreSources>https://corp/v3</RestoreSources>')) }))).toBe(true);
    expect(reads(ci({ 'eng/ci.props': props('<Import Project="feeds.props" Condition="true" />'), 'eng/feeds.props': props(pg('<RestoreSources>https://corp/v3</RestoreSources>')) })).reads)
      .toEqual(['eng/feeds.props sets <RestoreSources>, and Directory.Build.props: Import "$(MSBuildThisFileDirectory)eng/ci.props" has a condition that reads $(CI), which no pinned file gives an unconditional value']);
    // Defines a name a source setting's value or condition, an Import path or an Import condition reads.
    const feedFrom = (body: string) => ({ 'Directory.Build.props': props(`<Import Project="$(MSBuildThisFileDirectory)eng/ci.props" Condition="'$(CI)' == 'true'" />${body}`), 'eng/ci.props': props(pg('<Feed>https://corp/v3</Feed>')) });
    expect(reads(feedFrom(pg('<Feed Condition="\'$(Feed)\' == \'\'">x</Feed><RestoreSources>$(Feed)</RestoreSources>'))).reads).toEqual([
      'Directory.Build.props: <RestoreSources> reads $(Feed), which pinned files give an unconditional value only outside this evaluation (in files not auto-imported, imported under a condition, or imported by a path the engine does not resolve: only literal and $(MSBuildThisFileDirectory)-based paths)',
      'eng/ci.props defines $(Feed), which a package-source setting or an Import reads, and Directory.Build.props: Import "$(MSBuildThisFileDirectory)eng/ci.props" has a condition that reads $(CI), which no pinned file gives an unconditional value',
    ]);
    expect(parks(feedFrom(`${literal}<Import Project="$(MSBuildThisFileDirectory)eng/x.props" Condition="'$(Feed)' != ''" />`))).toBe(true);
    // Imports a file the engine cannot resolve; or is one.
    expect(parks(ci({ 'eng/ci.props': props('<Import Project="$(RepoRoot)eng/x.props" />') }))).toBe(true);
    expect(reads(ci({})).reads).toEqual(['Directory.Build.props sets <RestoreAdditionalProjectSources>, and Directory.Build.props: Import "$(MSBuildThisFileDirectory)eng/ci.props" (a file the engine cannot resolve to a pinned file) has a condition that reads $(CI), which no pinned file gives an unconditional value']);
    // An Sdk import loads the SDK's file.
    expect(parks({ 'Directory.Build.props': props(`${literal}<Import Project="Sdk.props" Sdk="Microsoft.NET.Sdk" Condition="'$(CI)' == 'true'" />`) })).toBe(false);
  });

  it('linear: a definition chain read by thousands of Import conditions (11k x 3k, two ~256 KB files), cycles, a deep chain and a deep nest stay fast and capped', () => {
    const chain = (n: number) => Array.from({ length: n }, (_, i) => `<A${i}>$(A${i + 1})</A${i}>`).join('');
    const imports = Array.from({ length: 3000 }, (_, i) => `<Import Project="$(MSBuildThisFileDirectory)e/x${i}.props" Condition="'$(A0)'=='1'" />\n`).join('');
    const files = [{ path: 'Directory.Build.props', text: props(pg(`${chain(11000)}<RestoreSources>https://x</RestoreSources>`)) }, { path: 'p0/P.csproj', text: props(imports) }];
    expect(files[0].text.length).toBeGreaterThan(200 * 1024);
    expect(files[1].text.length).toBeGreaterThan(200 * 1024);
    let start = performance.now();
    const r = restoreHostReads(files);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(r.reads).toHaveLength(RESTORE_READS_MAX);
    expect(r.more).toBe(3000 - RESTORE_READS_MAX);
    expect(r.reads[0]).toContain('reads $(A1) through $(A0), which its file gives an unconditional value only after the read');
    // A cycle, and a long cycle whose names are all defined first: no read; one read when a link reads the environment.
    expect(reads({ 'a.props': props(pg('<A>x</A><B>x</B><A>$(B)</A><B>$(A)</B><RestoreSources>$(A)</RestoreSources>')) }).reads).toEqual([]);
    expect(reads({ 'a.props': props(pg('<A>x</A><B>x</B><A>$(B)</A><B>$(A);$(CORP)</B><RestoreSources>$(A)</RestoreSources>')) }).reads).toEqual(['a.props: <RestoreSources> reads $(CORP) through $(A), which no pinned file gives an unconditional value']);
    const ring = Array.from({ length: 5000 }, (_, i) => `<C${i}>x</C${i}>`).join('') + Array.from({ length: 5000 }, (_, i) => `<C${i}>$(C${(i + 1) % 5000})</C${i}>`).join('');
    start = performance.now();
    expect(reads({ 'a.props': props(pg(`${ring}<RestoreSources>$(C0)</RestoreSources>`)) }).reads).toEqual([]);
    // A deep chain defined first, whose end reads the environment: found through the chain's head.
    const deep = Array.from({ length: 10000 }, (_, i) => `<D${i}>${i === 0 ? '$(CORP)' : `$(D${i - 1})`}</D${i}>`).join('');
    expect(reads({ 'a.props': props(pg(`${deep}<RestoreSources>$(D9999)</RestoreSources>`)) }).reads).toEqual(['a.props: <RestoreSources> reads $(CORP) through $(D9999), which no pinned file gives an unconditional value']);
    // A deep nest of conditioned groups.
    const nest = Array.from({ length: 5000 }, (_, i) => `<PropertyGroup Condition="'$(C${i})'=='1'">`).join('');
    expect(reads({ 'a.props': props(`${nest}<RestoreSources>x</RestoreSources>`) }).reads).toHaveLength(1);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  // Round 32 (the fourth review of the rule).
  const ORG = '<RestoreSources>https://api.nuget.org/v3/index.json</RestoreSources>';
  const imp = (p: string, cond?: string) => `<Import Project="$(MSBuildThisFileDirectory)${p}"${cond ? ` Condition="${cond}"` : ''} />`;

  it('(b) chained conditional imports: a reserved name, or a name only an Import that cannot change the sources reads, makes no read', () => {
    // eng/ci.props defaults Configuration (reserved); eng/Release.props, imported on it, sets only Optimize.
    expect(reads({ 'Directory.Build.props': props(`${pg(ORG)}${imp('eng/ci.props', "'$(CI)' == 'true'")}${imp('eng/Release.props', "'$(Configuration)' == 'Release'")}`), 'eng/ci.props': props(pg("<Configuration Condition=\"'$(Configuration)' == ''\">Release</Configuration>")), 'eng/Release.props': props(pg('<Optimize>true</Optimize>')) }))
      .toEqual({ reads: [], more: 0, names: [], fixes: [] });
    // eng/ci.props sets ContinuousIntegrationBuild, which only the condition of an Import of a file that sets nothing source-related reads.
    expect(parks({ 'Directory.Build.props': props(`${pg(ORG)}${imp('eng/ci.props', "'$(CI)' == 'true'")}${imp('eng/Signing.props', "'$(ContinuousIntegrationBuild)' == 'true'")}`), 'eng/ci.props': props(pg('<ContinuousIntegrationBuild>true</ContinuousIntegrationBuild>')), 'eng/Signing.props': props(pg('<SignAssembly>true</SignAssembly>')) })).toBe(false);
    // ... but when that Import's file can change the sources, the name is relevant (to a fixpoint): both Imports read.
    const chain = { 'Directory.Build.props': props(`${pg(ORG)}${imp('eng/ci.props', "'$(CI)' == 'true'")}${imp('eng/Corp.props', "'$(InternalBuild)' == 'true'")}`), 'eng/ci.props': props(pg('<InternalBuild>true</InternalBuild>')), 'eng/Corp.props': props('<Import Project="Feeds.props" />'), 'eng/Feeds.props': CORP };
    expect(reads(chain).reads).toEqual([
      'eng/ci.props defines $(InternalBuild), which a package-source setting or an Import reads, and Directory.Build.props: Import "$(MSBuildThisFileDirectory)eng/ci.props" has a condition that reads $(CI), which no pinned file gives an unconditional value',
      'eng/Feeds.props sets <RestoreSources>, and Directory.Build.props: Import "$(MSBuildThisFileDirectory)eng/Corp.props" has a condition that reads $(InternalBuild), which pinned files give an unconditional value only outside this evaluation (in files not auto-imported, imported under a condition, or imported by a path the engine does not resolve: only literal and $(MSBuildThisFileDirectory)-based paths)',
    ]);
    // A second hop: the conditioned file imports one that redefines a name the source setting reads.
    expect(parks({ 'Directory.Build.props': props(`${pg('<Mid>https://api.nuget.org/v3/index.json</Mid>')}${imp('eng/Corp.props', "'$(UseCorp)' == 'true'")}${pg('<Top>$(Mid)</Top><RestoreSources>$(Top)</RestoreSources>')}`), 'eng/Corp.props': props(imp('Inner.props')), 'eng/Inner.props': props(pg('<Mid>https://corp/v3</Mid>')) })).toBe(true);
  });

  it('an item list in a source setting\'s value or condition parks: the engine does not follow items', () => {
    expect(reads({ 'Directory.Build.props': props(`<ItemGroup><CorpFeed Include="$(CORP_FEED)" /></ItemGroup>${pg('<RestoreSources>@(CorpFeed)</RestoreSources>')}`) }).reads)
      .toEqual(['Directory.Build.props: <RestoreSources> reads the item list @(CorpFeed), and the engine does not follow items into a package-source setting (list the sources as a property or in nuget.config)']);
    expect(parks({ 'Directory.Build.props': props(pg("<RestoreSources>@(Feed->'%(Url)')</RestoreSources>")) })).toBe(true);
    expect(parks({ 'Directory.Build.props': props(pg(ORG, "'@(CorpFeed)' != ''")) })).toBe(true);
    // Through a property too; an item list elsewhere is not read.
    expect(parks({ 'Directory.Build.props': props(pg('<Feed>@(CorpFeed)</Feed><RestoreSources>$(Feed)</RestoreSources>')) })).toBe(true);
    expect(parks({ 'Directory.Build.props': props(`${pg(`<Items>@(Compile)</Items>${ORG}`)}`) })).toBe(false);
    expect(expressionRefs("@(A);@(B->'%(X)')").sort()).toEqual(['[item A]', '[item B]', '[metadata X]']);
  });

  it('item metadata (%(Item.Meta), %(Meta)) in a source setting\'s value, condition or a task Output parks like an item list; %XX escapes and %NAME% do not change', () => {
    const items = '<ItemGroup><CorpFeed Include="$(CORP_FEED)" /></ItemGroup>';
    const target = (body: string) => ({ 'Directory.Build.props': props(items), 'Directory.Build.targets': props(`<Target Name="CorpFeeds" BeforeTargets="_GetRestoreSettings">${body}</Target>`) });
    expect(reads(target(pg('<RestoreSources>%(CorpFeed.Identity)</RestoreSources>'))).reads)
      .toEqual(['Directory.Build.targets: <RestoreSources> reads the item metadata %(CorpFeed), and the engine does not follow items into a package-source setting (list the sources as a property or in nuget.config)']);
    expect(parks(target('<CreateProperty Value="%(CorpFeed.Identity)"><Output TaskParameter="Value" PropertyName="RestoreSources" /></CreateProperty>'))).toBe(true);
    expect(parks(target(pg('<RestoreSources>https://corp.invalid/v3/index.json</RestoreSources>', "'%(Identity)' != ''")))).toBe(true);
    expect(expressionRefs('%(CorpFeed.Identity)')).toEqual(['[metadata CorpFeed]']);
    // %XX escapes and %NAME% keep their meaning.
    expect(expressionRefs('https://x/a%C3%A9b', true)).toEqual([]);
    expect(expressionRefs('%CORP%', true)).toEqual(['[env CORP]']);
    expect(expressionRefs('https://x/My%20Project')).toEqual([]);
  });

  it('SDK import hooks are Imports: their value is the path, their conditions the Import\'s; an Import* switch loads its Directory file', () => {
    const hook = (name: string, cond: string, value = '$(MSBuildThisFileDirectory)eng/CorpFeed.targets') => props(pg(`<${name} Condition="${cond}">${value}</${name}>`));
    expect(reads({ 'Directory.Build.props': hook('CustomAfterMicrosoftCommonTargets', "'$(UseCorp)' == 'true'"), 'eng/CorpFeed.targets': CORP }).reads)
      .toEqual(['eng/CorpFeed.targets sets <RestoreSources>, and Directory.Build.props: <CustomAfterMicrosoftCommonTargets> (an SDK import hook) has a condition that reads $(UseCorp), which no pinned file gives an unconditional value']);
    for (const name of ['CustomBeforeMicrosoftCommonProps', 'CustomAfterDirectoryBuildTargets', 'DirectoryBuildTargetsPath', 'DirectoryPackagesPropsPath']) {
      expect(parks({ 'Directory.Build.props': hook(name, "'$(UseCorp)' == 'true'"), 'eng/CorpFeed.targets': CORP }), name).toBe(true);
    }
    // The hook's file sets nothing source-related, or the condition reads a reserved name: no read.
    expect(parks({ 'Directory.Build.props': `${hook('CustomAfterMicrosoftCommonTargets', "'$(UseCorp)' == 'true'").replace('</Project>', `${pg(ORG)}</Project>`)}`, 'eng/CorpFeed.targets': props('<Target Name="X" />') })).toBe(false);
    expect(parks({ 'Directory.Build.props': hook('CustomAfterMicrosoftCommonTargets', "'$(Configuration)' == 'Release'"), 'eng/CorpFeed.targets': CORP })).toBe(false);
    // Its path follows rule (c); an unconditional one is an unconditional Import (its definitions count in the evaluation).
    expect(reads({ 'Directory.Build.props': props(pg('<CustomAfterMicrosoftCommonTargets>$(CORP_TOOLS)/feed.targets</CustomAfterMicrosoftCommonTargets>')) }).reads)
      .toEqual(['Directory.Build.props: <CustomAfterMicrosoftCommonTargets> (an SDK import hook) reads $(CORP_TOOLS) in its path, which no pinned file defines, so your environment chooses which file loads']);
    expect(parks({ 'Directory.Build.props': props(`${pg('<DirectoryPackagesPropsPath>$(MSBuildThisFileDirectory)eng/Packages.props</DirectoryPackagesPropsPath>')}${pg('<RestoreSources>$(Feed)</RestoreSources>')}`), 'eng/Packages.props': props(pg('<Feed>https://api.nuget.org/v3/index.json</Feed>')) })).toBe(false);
    // ImportDirectoryBuildTargets under a condition decides whether the nearest Directory.Build.targets loads.
    const dbt = (cond: string, targets = CORP) => ({ 'Directory.Build.props': props(pg('<ImportDirectoryBuildTargets>false</ImportDirectoryBuildTargets>', cond)), 'Directory.Build.targets': targets });
    expect(reads(dbt("'$(UseCorp)' != 'true'")).names).toEqual(['UseCorp']);
    expect(parks(dbt("'$(UseCorp)' != 'true'", props(pg('<LangVersion>latest</LangVersion>'))))).toBe(false);
    // Reading a switch (or a hook) is not a definition of it.
    expect(parks({ 'Directory.Build.props': props(`${pg(ORG)}${imp('eng/x.props', "'$(ImportDirectoryBuildProps)' == 'true'")}`), 'eng/x.props': props(pg('<LangVersion>latest</LangVersion>')) })).toBe(false);
  });

  it('an Sdk Import under an environment condition parks unless the Sdk is the .NET SDK\'s or a Microsoft.Build.* one', () => {
    const sdk = (name: string) => ({ 'Directory.Build.props': props(`${pg(ORG)}<Import Project="Sdk.props" Sdk="${name}" Condition="'$(UseCorp)' == 'true'" />`) });
    expect(reads(sdk('Corp.Feeds.Sdk')).reads)
      .toEqual(['Directory.Build.props sets <RestoreSources>, and Directory.Build.props: Import "Sdk.props" (a file of the SDK "Corp.Feeds.Sdk", which the engine cannot see) has a condition that reads $(UseCorp), which no pinned file gives an unconditional value']);
    for (const name of ['Microsoft.NET.Sdk', 'Microsoft.NET.Sdk.Web', 'Microsoft.Build.Traversal', 'Microsoft.Build.NoTargets/3.7.0']) expect(parks(sdk(name)), name).toBe(false);
    // An Sdk Import with no condition (Arcade) and no source setting in MSBuild: nothing.
    expect(parks({ 'Directory.Build.props': props('<Import Project="Sdk.props" Sdk="Microsoft.DotNet.Arcade.Sdk" />') })).toBe(false);
  });

  it('a $(P) Import path resolves when P\'s only definition names its file\'s dir; otherwise the read says the path is not resolved', () => {
    const versions = props(pg('<NuGetOrgFeed>https://api.nuget.org/v3/index.json</NuGetOrgFeed>'));
    const root = (def: string) => ({ 'Directory.Build.props': props(`${pg(def)}<Import Project="$(RepoRoot)eng/Versions.props" />${pg('<RestoreSources>$(NuGetOrgFeed)</RestoreSources>')}`), 'eng/Versions.props': versions });
    for (const def of ['<RepoRoot>$(MSBuildThisFileDirectory)</RepoRoot>', "<RepoRoot>$([MSBuild]::NormalizeDirectory('$(MSBuildThisFileDirectory)'))</RepoRoot>", '<RepoRoot>$([MSBuild]::EnsureTrailingSlash($(MSBuildThisFileDirectory)))</RepoRoot>']) {
      expect(parks(root(def)), def).toBe(false);
    }
    // From a nested file: $(MSBuildThisFileDirectory) plus a relative path.
    expect(parks({ 'eng/Root.props': props(pg('<RepoRoot>$(MSBuildThisFileDirectory)../</RepoRoot>')), 'Directory.Build.props': props(`<Import Project="eng/Root.props" /><Import Project="$(RepoRoot)eng/Versions.props" />${pg('<RestoreSources>$(NuGetOrgFeed)</RestoreSources>')}`), 'eng/Versions.props': versions })).toBe(false);
    // A conditional default, or a second definition: not resolved.
    for (const def of ["<RepoRoot Condition=\"'$(RepoRoot)' == ''\">$(MSBuildThisFileDirectory)</RepoRoot>", '<RepoRoot>$(MSBuildThisFileDirectory)</RepoRoot><RepoRoot>$(MSBuildThisFileDirectory)</RepoRoot>']) {
      expect(reads(root(def)).reads, def).toEqual([expect.stringContaining('or imported by a path the engine does not resolve: only literal and $(MSBuildThisFileDirectory)-based paths)')]);
    }
  });

  it('rule (c)\'s undefined name in an Import path counts only in a .NET project\'s evaluation; C++, SSDT and WiX toolset names are reserved', () => {
    const vcx = props(`<Import Project="$(VCTargetsPath)\\Microsoft.Cpp.Default.props" /><ImportGroup Condition="'$(Configuration)|$(Platform)'=='Release|x64'"><Import Project="$(UserRootDir)\\Microsoft.Cpp.$(Platform).user.props" Condition="exists('$(UserRootDir)\\Microsoft.Cpp.$(Platform).user.props')" /></ImportGroup>`);
    const sql = props(`<Import Condition="'$(SQLDBExtensionsRefPath)' != ''" Project="$(SQLDBExtensionsRefPath)\\Microsoft.Data.Tools.Schema.SqlTasks.targets" />`);
    const wix = props('<Import Project="$(WixTargetsPath)" />');
    for (const [p, t] of [['native/H/H.vcxproj', vcx], ['db/Db/Db.sqlproj', sql], ['setup/S.wixproj', wix]]) {
      expect(parks({ 'Lib/Lib.csproj': lib, [p]: t }), p).toBe(false);
      expect(parks({ 'Lib/Lib.csproj': lib, [p]: t, 'Directory.Build.props': props(pg(ORG)) }), `${p} with a literal setting`).toBe(false);
    }
    for (const n of ['VCTargetsPath', 'UserRootDir', 'SQLDBExtensionsRefPath', 'WixTargetsPath']) expect(isReservedProperty(n), n).toBe(true);
    // Another project kind's own undefined name: not a read; the same Import in a .NET file, or in a file one imports (under any condition), is.
    const other = props('<Import Project="$(CorpToolsDir)corp.props" />');
    expect(parks({ 'tools/x.proj': other })).toBe(false);
    for (const p of ['Lib/Lib.csproj', 'Lib/Lib.fsproj', 'Lib/Lib.vbproj', 'Directory.Build.props', 'Directory.Build.targets', 'Directory.Packages.props']) {
      expect(reads({ [p]: other }).reads, p).toEqual([`${p}: Import "$(CorpToolsDir)corp.props" reads $(CorpToolsDir) in its path, which no pinned file defines, so your environment chooses which file loads`]);
    }
    expect(parks({ 'tools/x.proj': other, 'Directory.Build.props': props(`<Import Project="tools/x.proj" Condition="'$(Configuration)' == 'Release'" />`) })).toBe(true);
    // A host or profile read in another project kind's Import path still counts.
    expect(parks({ 'tools/x.proj': props('<Import Project="$(USERPROFILE)/corp.props" />') })).toBe(true);
  });

  it('Arcade SDK names are reserved only when the pinned files use the Arcade SDK', () => {
    const dbp = props('<Import Project="Sdk.props" Sdk="Microsoft.DotNet.Arcade.Sdk" /><Import Project="$(RepositoryEngineeringDir)Analyzers.props" />');
    const globalJson = '{ "sdk": { "version": "10.0.100" }, "msbuild-sdks": { "Microsoft.DotNet.Arcade.Sdk": "10.0.0-beta.25500.1" } }\n';
    expect(parks({ 'global.json': globalJson, 'Directory.Build.props': dbp, 'eng/Analyzers.props': props(pg('<EnableNETAnalyzers>true</EnableNETAnalyzers>')) })).toBe(false);
    // The global.json entry alone, or the Sdk import alone, is enough.
    const engImport = props('<Import Project="$(RepositoryEngineeringDir)Analyzers.props" />');
    expect(parks({ 'global.json': globalJson, 'Directory.Build.props': engImport })).toBe(false);
    expect(parks({ 'Directory.Build.props': dbp })).toBe(false);
    for (const n of ['RepoRoot', 'RepositoryRoot', 'ArtifactsDir', 'ArtifactsBinDir', 'ArtifactsObjDir', 'ArtifactsPackagesDir', 'DotNetRoot', 'DotNetTool', 'ArcadeSdkFoo']) {
      expect(parks({ 'global.json': globalJson, 'Directory.Build.props': props(`<Import Project="$(${n})x.props" />`) }), n).toBe(false);
      // Without the Arcade SDK they are ordinary names: undefined, your environment sets them.
      expect(parks({ 'Directory.Build.props': props(`<Import Project="$(${n})x.props" />`) }), `${n} without Arcade`).toBe(true);
    }
    expect(parks({ 'Directory.Build.props': props(pg('<RestoreAdditionalProjectSources>$(ArtifactsDir)packages</RestoreAdditionalProjectSources>')) })).toBe(true);
  });

  it('the Microsoft.Common.CrossTargeting, CSharp, VisualBasic and FSharp hooks are SDK import hooks too', () => {
    for (const name of ['CustomBeforeMicrosoftCSharpTargets', 'CustomAfterMicrosoftCSharpTargets', 'CustomAfterMicrosoftCommonCrossTargetingTargets', 'CustomBeforeMicrosoftCommonCrossTargetingTargets', 'CustomAfterMicrosoftVisualBasicTargets', 'CustomBeforeMicrosoftFSharpTargets', 'CustomAfterMicrosoftCSharpProps']) {
      const files = { 'Directory.Build.props': props(pg(`<${name} Condition="'$(UseCorpFeed)' == 'true'">$(MSBuildThisFileDirectory)eng/Corp.targets</${name}>`)), 'eng/Corp.targets': CORP };
      expect(reads(files).reads, name).toEqual([`eng/Corp.targets sets <RestoreSources>, and Directory.Build.props: <${name}> (an SDK import hook) has a condition that reads $(UseCorpFeed), which no pinned file gives an unconditional value`]);
    }
  });

  it('<Project Sdk="A;B"> and a top-level <Sdk Name="X" /> are Imports of each SDK; only Microsoft.NET.Sdk[.X] and Microsoft.Build.X load nothing of the repository', () => {
    const conditioned = (target: string) => ({ 'Directory.Build.props': props(`${pg(ORG)}<Import Project="$(MSBuildThisFileDirectory)eng/Web.props" Condition="'$(UseCorpFeed)' == 'true'" />`), 'eng/Web.props': target });
    expect(reads(conditioned('<Project>\n  <Sdk Name="Corp.Feeds.Sdk" />\n</Project>\n')).reads)
      .toEqual(['Directory.Build.props sets <RestoreSources>, and eng/Web.props imports "Sdk.props", a file of the SDK "Corp.Feeds.Sdk", which the engine cannot see, and Directory.Build.props: Import "$(MSBuildThisFileDirectory)eng/Web.props" has a condition that reads $(UseCorpFeed), which no pinned file gives an unconditional value']);
    expect(parks(conditioned('<Project Sdk="Microsoft.NET.Sdk;Corp.Feeds.Sdk/1.0.0"></Project>\n'))).toBe(true);
    for (const sdk of ['Microsoft.NET.Sdk', 'Microsoft.NET.Sdk.Web', 'Microsoft.NET.Sdk/10.0.100', 'Microsoft.Build.NoTargets/3.7.56']) expect(parks(conditioned(`<Project Sdk="${sdk}"></Project>\n`)), sdk).toBe(false);
    // A name that only starts like the .NET SDK's is another SDK.
    expect(parks({ 'Directory.Build.props': props(`${pg(ORG)}<Import Project="Sdk.props" Sdk="Microsoft.NET.SdkCorpFeeds" Condition="'$(UseCorpFeed)' == 'true'" />`) })).toBe(true);
    // Unconditioned project SDKs of ordinary repositories: nothing.
    expect(parks({
      'Directory.Build.props': props(`${pg(ORG)}<Import Project="$(MSBuildThisFileDirectory)eng/ci.props" Condition="'$(CI)' == 'true'" />`),
      'eng/ci.props': props(pg('<ContinuousIntegrationBuild>true</ContinuousIntegrationBuild>')),
      'tests/T/T.csproj': '<Project Sdk="MSTest.Sdk/3.6.4"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n',
      'src/AppHost/AppHost.csproj': '<Project Sdk="Microsoft.NET.Sdk">\n  <Sdk Name="Aspire.AppHost.Sdk" Version="9.0.0" />\n</Project>\n',
      'src/Mobile/Mobile.csproj': '<Project Sdk="Uno.Sdk"></Project>\n',
      'dirs.proj': '<Project Sdk="Microsoft.Build.Traversal/4.1.82"></Project>\n',
      'Directory.Build.targets': props(`<Import Project="Sdk.targets" Sdk="MSTest.Sdk" Condition="'$(IsTestProject)' == 'true'" />`),
    })).toBe(false);
  });

  it('$(P) Import paths: NormalizeDirectory with extra literal arguments resolves; an environment argument does not', () => {
    const files = (def: string) => ({ 'Directory.Build.props': props(`${pg(`<EngRoot>${def}</EngRoot>${ORG}`)}<Import Project="$(EngRoot)ci.props" Condition="'$(CI)' == 'true'" />`), 'eng/ci.props': props(pg('<ContinuousIntegrationBuild>true</ContinuousIntegrationBuild>')) });
    for (const def of ["$([MSBuild]::NormalizeDirectory($(MSBuildThisFileDirectory), 'eng'))", "$([MSBuild]::NormalizeDirectory('$(MSBuildThisFileDirectory)', 'eng', ''))", '$([MSBuild]::NormalizeDirectory($(MSBuildThisFileDirectory), eng))']) {
      expect(parks(files(def)), def).toBe(false);
    }
    for (const def of ["$([MSBuild]::NormalizeDirectory($(MSBuildThisFileDirectory), '$(CORP_SUB)'))", "$([MSBuild]::NormalizeDirectory($(MSBuildThisFileDirectory), 'C:/corp'))", "$([MSBuild]::EnsureTrailingSlash($(MSBuildThisFileDirectory), 'eng'))"]) {
      expect(parks(files(def)), def).toBe(true);
    }
  });

  it('settable and firstHit are memoised and budgeted: many defining files outside the evaluation, read many times, finish fast', () => {
    const fill = (unit: (n: number) => string) => {
      const out: string[] = [];
      for (let n = 0, len = 0; ; n++) {
        const s = unit(n);
        if (len + s.length > PINNED_READ_MAX - 400) break;
        out.push(s);
        len += s.length + 1;
      }
      return out.join('\n');
    };
    // settableQuad: K files define Feed unconditionally outside each reader's evaluation; RF files read it thousands of times.
    const settableQuad = (k: number, rf: number) => [
      { path: 'src/Directory.Build.props', text: props(pg('<Feed>https://x</Feed><RestoreSources>$(Feed)</RestoreSources>')) },
      ...Array.from({ length: k }, (_, i) => ({ path: `A${i}/x.props`, text: props(pg('<Feed>https://x</Feed>')) })),
      ...Array.from({ length: rf }, (_, j) => ({ path: `r/r${j}.props`, text: props(pg(fill((n) => `<Y${n}>$(Feed)</Y${n}>`))) })),
    ];
    // rootsQuad: thousands of settings conditioned on a name K files define outside their evaluation.
    const rootsQuad = (k: number, rf: number) => [
      ...Array.from({ length: k }, (_, i) => ({ path: `A${i}/x.props`, text: props(pg('<Feed>https://x</Feed>')) })),
      ...Array.from({ length: rf }, (_, j) => ({ path: `r/r${j}.props`, text: props(fill((n) => `<PropertyGroup><RestoreSources Condition="'$(Feed)'!='${n}'">x</RestoreSources></PropertyGroup>`)) })),
    ];
    let start = performance.now();
    expect(restoreHostReads(settableQuad(2000, 10)).reads).toEqual([]);
    expect(performance.now() - start).toBeLessThan(3000);
    start = performance.now();
    const r = restoreHostReads(rootsQuad(5000, 12));
    expect(performance.now() - start).toBeLessThan(3000);
    expect(r.reads[0]).toContain('r/r0.props: <RestoreSources> reads $(Feed), which pinned files give an unconditional value only outside this evaluation');
    // Memoised per (name, reading file) and iterating the smaller side: tens of thousands of reads of a name 2,000 files
    // define take a few thousand steps, not reads x files; each root's reads are charged, so a small budget parks.
    expect(restoreHostReads(settableQuad(2000, 2), 20_000).fixes).toEqual([]);
    // Each firstHit (per setting or Import) is charged: 1,500 settings take 1,500 steps to read and 1,500 more to check.
    const settings = props(Array.from({ length: 1500 }, (_, i) => pg(`<RestoreSources Condition="'$(Configuration)' == '${i}'">https://x</RestoreSources>`)).join(''));
    expect(restoreHostReads([{ path: 'a.props', text: settings }], 3100).fixes).toEqual([]);
    expect(restoreHostReads([{ path: 'a.props', text: settings }], 2900).fixes).toEqual([expect.stringContaining('too many imports to analyse')]);
  });

  it('a response file switch whose quoted value holds a ; list: each %NAME% in it counts', () => {
    expect(reads({ 'Directory.Build.rsp': '-p:RestoreSources="https://corp/v3;%CORP_FEED2%"\n' }).reads).toEqual(['Directory.Build.rsp: <RestoreSources> reads the environment variable CORP_FEED2']);
    expect(reads({ 'Directory.Build.rsp': '-p:RestoreSources=";%CORP_FEED%"\n' }).reads).toEqual(['Directory.Build.rsp: <RestoreSources> reads the environment variable CORP_FEED']);
    expect(parks({ 'Directory.Build.rsp': '-p:RestoreSources="https://a/v3;https://b/v3" -p:Other=%HOME%\n' })).toBe(false);
  });

  it('work budget: a mesh of unconditional imports and a deep chain of nested Directory.Build.props finish fast, with a result or the budget park', () => {
    const mesh = (n: number) => Array.from({ length: n }, (_, k) => ({ path: `e/p${k}.props`, text: props(Array.from({ length: n }, (_, j) => imp(`p${j}.props`)).join('\n') + pg(`${k === 0 ? '<X>https://x</X>' : ''}<RestoreSources>$(X)</RestoreSources>`)) }));
    const deepDirs = (n: number) => {
      const out = [{ path: 'Directory.Build.props', text: props(pg('<Feed>https://x</Feed>')) }];
      let dir = '';
      for (let i = 0; i < n; i++) {
        dir += `d${i}/`;
        out.push({ path: `${dir}Directory.Build.props`, text: props(`<Import Project="$([MSBuild]::GetPathOfFileAbove('Directory.Build.props', '$(MSBuildThisFileDirectory)../'))" />`) });
        out.push({ path: `${dir}P${i}.csproj`, text: props(pg('<RestoreSources>$(Feed)</RestoreSources>')) });
      }
      return out;
    };
    const park = ['the pinned MSBuild files: too many imports to analyse (more than 100000 import steps), so the engine cannot tell whether their package-source settings depend on your environment'];
    const fix = ["keep the pinned MSBuild files within the engine's limit of 100000 import steps (too many imports to analyse)"];
    let start = performance.now();
    // Within the budget, a result: every file of the mesh is in every evaluation; the nested files reach the root one.
    expect(restoreHostReads(mesh(100))).toEqual({ reads: [], more: 0, names: [], fixes: [] });
    expect(restoreHostReads(deepDirs(400))).toEqual({ reads: [], more: 0, names: [], fixes: [] });
    // Past it, the park, with its remedy (whatever was found before stays).
    expect(restoreHostReads(mesh(400))).toEqual({ reads: park, more: 0, names: [], fixes: fix });
    expect(restoreHostReads(deepDirs(800))).toEqual({ reads: park, more: 0, names: [], fixes: fix });
    expect(performance.now() - start).toBeLessThan(4000);
    expect(RESTORE_WORK_MAX).toBe(100_000);
    // The budget counts each Import or source setting read, edge followed and file added to a closure.
    start = performance.now();
    expect(restoreHostReads(deepDirs(400), 10_000).fixes).toEqual(["keep the pinned MSBuild files within the engine's limit of 10000 import steps (too many imports to analyse)"]);
    expect(restoreHostReads(mesh(30), 30 * 31)).toEqual(expect.objectContaining({ fixes: [expect.stringContaining('too many imports to analyse')] }));
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
