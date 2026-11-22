import { describe, expect, it } from 'vitest';
import { DOTNET_DEFINITION_PATTERNS, describeGateSources, dotnetBuildDirIndex, gateDefinition, gateDefinitionSources, gateSourcePathspec, isDotnetDefinitionFile, patternSourceChanges, shellPath, strayDotnetDefinitionFiles } from '../local-gate.js';
describe('gate definitions that the repository cannot pin park as unknown', () => {
    it('npx fetches registry code: unresolved, in any spelling', () => {
        for (const gate of [['npx', 'vitest'], ['npx.cmd', '-y', 'eslint', '.'], ['C:\\tools\\npx.exe', 'x'], ['/usr/bin/npx', 'x']]) {
            const out = gateDefinitionSources(gate);
            expect(out.sources, gate.join(' ')).toEqual([]);
            expect(out.unresolved, gate.join(' ')).toMatch(/runs npx, which fetches and runs registry code/);
        }
    });
    it('a bare binary is looked up on PATH, so no repository file defines it', () => {
        for (const gate of [['vitest'], ['cargo', 'test'], ['make', 'check'], ['pytest.exe', '-q']]) {
            const out = gateDefinitionSources(gate);
            expect(out.sources, gate.join(' ')).toEqual([]);
            expect(out.unresolved, gate.join(' ')).toMatch(/from PATH, and the repository holds no file that defines it/);
        }
    });
    it('a gate named by a path keeps its file as the definition, and node keeps its script', () => {
        expect(gateDefinitionSources(['./ci/gate.sh'])).toEqual({ sources: [{ path: 'ci/gate.sh' }] });
        expect(gateDefinitionSources(['node_modules/.bin/vitest', 'run'])).toEqual({ sources: [{ path: 'node_modules/.bin/vitest' }] });
        expect(gateDefinitionSources(['node', 'scripts/gate.mjs'])).toEqual({ sources: [{ path: 'scripts/gate.mjs' }] });
    });
    it('a program outside the repository is unresolved with or without arguments (make and pytest read repository files implicitly)', () => {
        for (const gate of [['/usr/bin/make'], ['/usr/local/bin/pytest'], ['C:/Python312/Scripts/pytest.exe'], ['/usr/local/bin/gate']]) {
            const out = gateDefinitionSources(gate);
            expect(out.sources, gate[0]).toEqual([]);
            expect(out.unresolved, gate[0]).toMatch(/a program outside the repository/);
        }
    });
    it('node options before the script park, except --run, node --test and inline code', () => {
        expect(gateDefinitionSources(['node', '--run', 'test'])).toEqual(gateDefinitionSources(['npm', 'run', 'test']));
        for (const gate of [
            ['node', '--test'],
            ['node', '--test', '--test-reporter=spec', 'test/'],
            ['node', '--test', '--test-concurrency=1', '--experimental-test-coverage'],
            ['node', '-e', 'process.exit(0)'],
            ['node', '--eval=1'],
            ['node', '--print', '1'],
            ['node', 'scripts/gate.mjs', '--flag'],
        ]) {
            const out = gateDefinitionSources(gate);
            expect(out.unresolved, gate.join(' ')).toBeUndefined();
            expect(out.sources, gate.join(' ')).toEqual(gate[1] === 'scripts/gate.mjs' ? [{ path: 'scripts/gate.mjs' }] : []);
        }
        for (const gate of [
            ['node', '-r', './hook.js', 'scripts/gate.mjs'],
            ['node', '--import', './x.mjs', 'scripts/gate.mjs'],
            ['node', '--test', '-r', './hook.js'],
            ['node', '-r', './hook.js', '-e', '1'],
            ['node', '--watch', 'scripts/gate.mjs'],
        ]) {
            const out = gateDefinitionSources(gate);
            expect(out.sources, gate.join(' ')).toEqual([]);
            expect(out.unresolved, gate.join(' ')).toMatch(/option/);
        }
        expect(gateDefinitionSources(['node', '.yarn/releases/yarn-4.1.0.cjs', 'test'])).toEqual(gateDefinitionSources(['yarn', 'test']));
        expect(gateDefinitionSources(['node', 'scripts/gate.mjs'])).toEqual({ sources: [{ path: 'scripts/gate.mjs' }] });
    });
    it('npm-style gates are unchanged', () => {
        expect(gateDefinitionSources(['npm', 'test']).unresolved).toBeUndefined();
        expect(gateDefinitionSources(['pnpm', 'lint']).unresolved).toBeUndefined();
    });
    it('a program outside the repository that takes arguments parks, like its bare name', () => {
        for (const gate of [
            ['/bin/sh', 'scripts/ci.sh'],
            ['/usr/bin/env', 'npx', 'vitest'],
            ['/usr/bin/python3', 'tools/test.py'],
            ['/home/u/.cargo/bin/cargo', 'test'],
            ['C:\\Program Files\\Git\\bin\\sh.exe', 'scripts\\ci.sh'],
            ['C:/tools/cargo.exe', 'test'],
        ]) {
            const out = gateDefinitionSources(gate);
            expect(out.sources, gate.join(' ')).toEqual([]);
            expect(out.unresolved, gate.join(' ')).toMatch(/a program outside the repository/);
        }
    });
    it('npx-cli.js, pnpm.js and yarn.js run through node map to their bare forms', () => {
        for (const target of ['/usr/lib/node_modules/npm/bin/npx-cli.js', 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js']) {
            expect(gateDefinitionSources(['node', target, 'vitest']).unresolved, target).toMatch(/runs npx/);
        }
        for (const [file, bare] of [['pnpm.cjs', 'pnpm'], ['pnpm.js', 'pnpm'], ['yarn.js', 'yarn']]) {
            const target = `C:\\Users\\u\\corepack\\${file}`;
            expect(gateDefinitionSources(['node', target, 'test']), file).toEqual(gateDefinitionSources([bare, 'test']));
            expect(gateDefinitionSources(['node', target, 'dlx', 'x']).unresolved, file).toMatch(/dlx/);
        }
    });
});
describe('a dotnet gate is defined by the repository\'s solution, project and MSBuild files', () => {
    const PATTERNS = [...DOTNET_DEFINITION_PATTERNS.map((path) => ({ path, pattern: true })), ...['bin', 'obj', 'artifacts'].map((d) => ({ path: `${d}/**`, pattern: true, buildDir: true }))];
    const named = (gate) => gateDefinitionSources(gate).sources.filter((s) => !('pattern' in s));
    it('dotnet build / dotnet test, by name or by an absolute path to the host, are pinned by the pattern sources', () => {
        for (const gate of [['dotnet', 'test'], ['dotnet', 'build'], ['dotnet.exe', 'test', '-c', 'Release'], ['C:\\Program Files\\dotnet\\dotnet.exe', 'test'], ['/usr/share/dotnet/dotnet', 'build', '--no-restore'], ['dotnet', 'TEST']]) {
            expect(gateDefinitionSources(gate), gate.join(' ')).toEqual({ sources: PATTERNS });
        }
    });
    it('every file MSBuild reads on its own is a definition file: project files of any extension, .user, shared items, imports, response files', () => {
        for (const p of ['App.sln', 'App.slnx', 'App.slnf', 'src/App/App.csproj', 'x/Y.FSPROJ', 'a.vbproj', 'build.proj', 'web/web.esproj', 'db/Db.sqlproj', 'Shared/Shared.shproj', 'Shared/Shared.projitems',
            'Tests/Tests.csproj.user', 'App.sln.user', 'Directory.Build.props', 'Directory.Packages.props', 'src/Directory.Build.targets', 'build/My.tasks', 'Directory.Build.rsp', 'ci/build.rsp',
            'global.json', 'NuGet.Config', 'src/packages.lock.json', 'dotnet.config']) {
            expect(isDotnetDefinitionFile(p), p).toBe(true);
        }
        for (const p of ['src/App/Program.cs', 'README.md', 'project.json', 'tests/ci.runsettings', 'xunit.runner.json', 'proj', 'src/myproj', 'App.csproj.bak', 'build/common.msbuild']) {
            expect(isDotnetDefinitionFile(p), p).toBe(false);
        }
    });
    it('repository paths the argv names are file sources (an adapter dir a tree source); paths outside the repository and after -- are not', () => {
        expect(named(['dotnet', 'test', 'tests/App.Tests/App.Tests.csproj', '--settings', 'ci.runsettings', '@build.rsp']))
            .toEqual([{ path: 'tests/App.Tests/App.Tests.csproj', file: true }, { path: 'ci.runsettings', file: true }, { path: 'build.rsp', file: true }]);
        expect(gateDefinitionSources(['dotnet', 'test', '--settings=C:\\ci\\x.runsettings', '-c', 'Release', '--filter', 'Category=Unit', '--', 'tests/x']).sources).toEqual(PATTERNS);
        // F9: dotnet test's run settings after -- may name adapter dirs too.
        expect(named(['dotnet', 'test', '--', 'RunConfiguration.TestAdaptersPaths=adapters;C:\\x;tools/more/', 'RunConfiguration.X=1'])).toEqual([{ path: 'adapters', tree: true }, { path: 'tools/more', tree: true }]);
        expect(named(['dotnet', 'build', '--', 'RunConfiguration.TestAdaptersPaths=adapters'])).toEqual([]);
    });
    it('the argv spellings: --settings:x, -s:x, -a (test adapter path) for test; for build -a is --arch, -s is --source and -d takes no value', () => {
        expect(named(['dotnet', 'test', '--settings:ci.runsettings'])).toEqual([{ path: 'ci.runsettings', file: true }]);
        expect(named(['dotnet', 'test', '-s:ci.runsettings'])).toEqual([{ path: 'ci.runsettings', file: true }]);
        expect(named(['dotnet', 'test', '-a', 'adapters'])).toEqual([{ path: 'adapters', tree: true }]);
        expect(named(['dotnet', 'test', '--test-adapter-path:adapters/'])).toEqual([{ path: 'adapters', tree: true }]);
        expect(named(['dotnet', 'build', '-a', 'x64', '-s', 'feed', 'App.sln'])).toEqual([{ path: 'App.sln', file: true }]);
        expect(named(['dotnet', 'build', '-d', 'App.sln'])).toEqual([{ path: 'App.sln', file: true }]);
        expect(named(['dotnet', 'test', '-d', 'diag.log', 'App.sln'])).toEqual([{ path: 'App.sln', file: true }]);
        // The same path named as a project and as an adapter dir is pinned whole.
        expect(named(['dotnet', 'test', 'tools', '-a', 'tools'])).toEqual([{ path: 'tools', tree: true }]);
        // MSBuild switches with a colon name no repository file.
        expect(named(['dotnet', 'build', '-p:Configuration=Release', '-bl:out.binlog', '-v:q'])).toEqual([]);
    });
    it('any other dotnet subcommand, or an option before it, is unresolved (dotnet run, exec, tool, a dll)', () => {
        for (const gate of [['dotnet'], ['dotnet', 'run'], ['dotnet', 'exec', 'x.dll'], ['dotnet', 'tool', 'run', 'x'], ['dotnet', 'bin/App.dll'], ['dotnet', '--diagnostics', 'test'], ['dotnet', 'msbuild'], ['dotnet', 'vstest', 'x.dll']]) {
            const out = gateDefinitionSources(gate);
            expect(out.sources, gate.join(' ')).toEqual([]);
            expect(out.unresolved, gate.join(' ')).toMatch(/only dotnet build and dotnet test/);
        }
    });
    it('a dotnet executable inside the repository is its own file, as any repository path is', () => {
        expect(gateDefinitionSources(['./tools/dotnet', 'test'])).toEqual({ sources: [{ path: 'tools/dotnet' }] });
    });
    it('a dotnet.cmd / dotnet.bat shim is not the dotnet host (the sandbox gives it no -m:1): it parks as a program from PATH, or is its own file', () => {
        for (const cmd of ['dotnet.cmd', 'DOTNET.BAT']) {
            const out = gateDefinitionSources([cmd, 'test']);
            expect(out.sources, cmd).toEqual([]);
            expect(out.unresolved, cmd).toMatch(/from PATH/);
        }
        expect(gateDefinitionSources(['C:\\tools\\dotnet.cmd', 'test']).unresolved).toMatch(/a program outside the repository/);
        expect(gateDefinitionSources(['tools/dotnet.cmd', 'test'])).toEqual({ sources: [{ path: 'tools/dotnet.cmd' }] });
    });
    const tree = (over = {}) => Object.entries({
        'App.sln': 'a1', 'src/App/App.csproj': 'b1', 'src/App/Program.cs': 'c1', 'tests/App.Tests/AppTests.cs': 'd1', 'README.md': 'e1', ...over,
    }).filter(([, oid]) => oid !== '').map(([p, oid]) => [p, oid]);
    it('the definition changes with any matching file of the tree, at any depth and in any case, and not with code or tests', () => {
        const { sources } = gateDefinitionSources(['dotnet', 'test']);
        const def = (t) => gateDefinition(sources, () => { throw new Error('pattern sources never read a file'); }, () => t);
        const base = def(tree());
        expect(def(tree({ 'src/App/Program.cs': 'c2', 'tests/App.Tests/AppTests.cs': 'd2', 'README.md': 'e2' }))).toBe(base);
        expect(def([...tree()].reverse())).toBe(base);
        const changes = [{ 'src/App/App.csproj': 'b2' }, { 'App.sln': '' }, { 'Directory.Build.props': 'f1' }, { 'src/Directory.Build.targets': 'f1' }, { 'NuGet.Config': 'f1' }, { 'global.json': 'f1' },
            { 'src/App/packages.lock.json': 'f1' }, { 'App.slnx': 'f1' }, { 'build/Custom.Targets': 'f1' }, { 'tests/Directory.Build.rsp': 'f1' }, { 'tools/Other.FSPROJ': 'f1' },
            // MSBuild's automatic imports: the project's .user file, a shared project's items, any project extension.
            { 'src/App/App.csproj.user': 'f1' }, { 'Shared/Shared.projitems': 'f1' }, { 'web/web.esproj': 'f1' }, { 'build/Custom.tasks': 'f1' }];
        for (const change of changes) {
            expect(def(tree(change)), JSON.stringify(change)).not.toBe(base);
        }
        expect(() => gateDefinition(sources, () => undefined)).toThrow(/needs the commit's file list/);
    });
    it('a named directory compares every blob under it, so a same-named file replaced inside it is seen', () => {
        const { sources } = gateDefinitionSources(['dotnet', 'test', '--test-adapter-path', 'adapters']);
        const read = () => { throw new Error('tree sources never read a file'); };
        const def = (over) => gateDefinition(sources, read, () => tree({ 'adapters/My.TestAdapter.dll': 'g1', 'adapters/sub/x.json': 'h1', 'adaptersx/y.dll': 'i1', ...over }));
        const base = def({});
        expect(def({ 'adapters/My.TestAdapter.dll': 'g2' })).not.toBe(base);
        expect(def({ 'adapters/sub/x.json': 'h2' })).not.toBe(base);
        expect(def({ 'adapters/new.dll': 'j1' })).not.toBe(base);
        // A sibling whose name only starts the same is not under it.
        expect(def({ 'adaptersx/y.dll': 'i2' })).toBe(base);
        // A named file in another case (Windows resolves it) is still compared.
        const file = gateDefinitionSources(['dotnet', 'test', '--settings', 'CI.runsettings']).sources;
        const one = (oid) => gateDefinition(file, read, () => tree({ 'ci.runsettings': oid }));
        expect(one('k1')).not.toBe(one('k2'));
    });
    it('F4: a project directory named in the argv pins no test code under it; only an adapter dir is pinned whole', () => {
        const read = () => { throw new Error('file and tree sources never read a file'); };
        const files = { 'tests/Foo.Tests/Foo.Tests.csproj': 'p1', 'tests/Foo.Tests/FooTests.cs': 't1', 'tests/Foo.Tests/Sub/More.cs': 'm1' };
        const dirGate = gateDefinitionSources(['dotnet', 'test', 'tests/Foo.Tests']).sources;
        const def = (over) => gateDefinition(dirGate, read, () => tree({ ...files, ...over }));
        const base = def({});
        // A comment change, a new or a removed test file under the project dir: the definition is the same.
        expect(def({ 'tests/Foo.Tests/FooTests.cs': 't2' })).toBe(base);
        expect(def({ 'tests/Foo.Tests/New.cs': 'n1' })).toBe(base);
        expect(def({ 'tests/Foo.Tests/Sub/More.cs': '' })).toBe(base);
        // Its project file still is, by the pattern sources.
        expect(def({ 'tests/Foo.Tests/Foo.Tests.csproj': 'p2' })).not.toBe(base);
        // As an adapter dir the same path is pinned by every blob under it.
        const adapter = gateDefinitionSources(['dotnet', 'test', '-a', 'tests/Foo.Tests']).sources;
        const adef = (over) => gateDefinition(adapter, read, () => tree({ ...files, ...over }));
        expect(adef({ 'tests/Foo.Tests/FooTests.cs': 't2' })).not.toBe(adef({}));
    });
    it('an npm gate\'s definition is unchanged by the pattern and tree handling (no file list is needed)', () => {
        const { sources } = gateDefinitionSources(['npm', 'test']);
        const out = gateDefinition(sources, (p) => (p === 'package.json' ? '{"scripts":{"test":"vitest"}}' : undefined));
        expect(JSON.parse(out)[0]).toEqual(['package.json', [['pretest', null], ['test', 'vitest'], ['posttest', null]]]);
    });
    it('names the changed files and gives git pathspecs for the patterns, quoting a path with spaces', () => {
        const { sources } = gateDefinitionSources(['dotnet', 'test']);
        const a = [['App.sln', '1'], ['src/App.csproj', '2'], ['src/x.cs', '3']];
        const b = [['App.sln', '1'], ['src/App.csproj', '9'], ['src/x.cs', '4'], ['Directory.Build.props', '5'], ['src/App.csproj.user', '6']];
        expect(patternSourceChanges(sources, a, b)).toEqual(['Directory.Build.props', 'src/App.csproj', 'src/App.csproj.user']);
        expect(patternSourceChanges(sources, a, a)).toEqual([]);
        expect(gateSourcePathspec({ path: '*.csproj', pattern: true })).toBe("':(glob,icase)**/*.csproj'");
        expect(gateSourcePathspec({ path: 'scripts/gate.mjs' })).toBe('scripts/gate.mjs');
        expect(gateSourcePathspec({ path: 'My Tests/ci.runsettings', tree: true })).toBe("'My Tests/ci.runsettings'");
        expect(shellPath("it's/a b.csproj")).toBe("'it'\\''s/a b.csproj'");
        expect(describeGateSources([{ path: '*.sln', pattern: true }, { path: 'ci.runsettings' }])).toBe('**/*.sln, ci.runsettings');
    });
    it('stray untracked files MSBuild would read in the prepare checkout: definition files outside bin/, obj/ and artifacts/ (those are removed before the gate)', () => {
        expect(strayDotnetDefinitionFiles([
            'Tests/Tests.csproj.user', 'Directory.Build.rsp', 'src/App/obj/App.csproj.evil.props', 'src/App/obj/App.csproj.nuget.g.props', 'src/App/OBJ/App.csproj.nuget.g.targets',
            'src/App/obj/project.assets.json', 'src/App/obj/Debug/net10.0/x.props', 'src/App/bin/Debug/net10.0/App.dll', 'src/App/bin/x.targets', 'TestResults/a.trx', 'src/App/Program.cs',
            'artifacts/obj/App/App.csproj.nuget.g.props', 'build/obj.props', 'Tests/Properties/launchSettings.json', 'node_modules/x/obj/y.props',
            // A node_modules dir is a package tree, whoever installed it (real packages ship *.props, *.vcxproj, *.sln files): exempt; a head tracking one parks instead (trackedPackageTreeProjects).
            'tools/node_modules/pkg/Directory.Build.props', 'web/NODE_MODULES/pkg/Properties/launchSettings.json',
        ])).toEqual(['Tests/Tests.csproj.user', 'Directory.Build.rsp', 'build/obj.props', 'Tests/Properties/launchSettings.json']);
    });
    it('build output dirs: the first bin/obj/artifacts segment in any case, not under a node_modules dir that comes first; never a path with an empty, . or .. segment', () => {
        expect(dotnetBuildDirIndex('src/App/obj/x.props')).toBe(2);
        expect(dotnetBuildDirIndex('src/App/Bin/Debug/a.dll')).toBe(2);
        expect(dotnetBuildDirIndex('artifacts/obj/App/a.json')).toBe(0);
        expect(dotnetBuildDirIndex('src/App/obj')).toBe(2);
        expect(dotnetBuildDirIndex('src/App/objx/a')).toBe(-1);
        expect(dotnetBuildDirIndex('src/App/Program.cs')).toBe(-1);
        expect(dotnetBuildDirIndex('node_modules/pkg/bin/cli.js')).toBe(-1);
        expect(dotnetBuildDirIndex('a/NODE_MODULES/obj/x')).toBe(-1);
        expect(dotnetBuildDirIndex('a/obj/node_modules/x')).toBe(1);
        for (const p of ['a//obj/x', './obj/x', 'a/../obj/x', 'a/b\\c/obj/x'])
            expect(dotnetBuildDirIndex(p), p).toBe(-1);
    });
    it('follow-up 1: every tracked path under bin/, obj/ or artifacts/ is part of a dotnet gate\'s definition (added, changed or removed); a file named bin is not', () => {
        const { sources } = gateDefinitionSources(['dotnet', 'test']);
        const base = [['src/App/App.csproj', 'a'], ['src/App/Program.cs', 'b'], ['tools/bin', 'c'], ['artifacts/readme.txt', 'd']];
        const head = [...base.slice(0, 3), ['artifacts/readme.txt', 'e'], ['src/App/obj/project.assets.json', 'f'], ['tests/T/Bin/Debug/T.dll', 'g'], ['src/App/Program.cs', 'b'], ['tools/bin', 'h']];
        expect(patternSourceChanges(sources, base, head)).toEqual(['artifacts/readme.txt', 'src/App/obj/project.assets.json', 'tests/T/Bin/Debug/T.dll']);
        expect(gateDefinition(sources, () => undefined, () => base)).not.toBe(gateDefinition(sources, () => undefined, () => [...base, ['src/App/obj/x.cache', 'z']]));
        expect(sources.filter((x) => x.buildDir).map(gateSourcePathspec)).toEqual(["':(glob,icase)**/bin/**'", "':(glob,icase)**/obj/**'", "':(glob,icase)**/artifacts/**'"]);
        expect(describeGateSources(sources.filter((x) => x.buildDir))).toBe('**/bin/**, **/obj/**, **/artifacts/**');
    });
    it('F2: the Microsoft.Testing.Platform launch profiles are definition files', () => {
        for (const p of ['Tests/Properties/launchSettings.json', 'LAUNCHSETTINGS.JSON', 'Tests/Tests.run.json'])
            expect(isDotnetDefinitionFile(p), p).toBe(true);
        for (const p of ['Tests/settings.json', 'run.json.bak', 'Tests/runjson'])
            expect(isDotnetDefinitionFile(p), p).toBe(false);
    });
    it('L1: a name with a colon is matched as written too (on Linux it is a plain file name): src/evil:1.props pins and never auto-merges', () => {
        for (const p of ['src/evil:1.props', 'obj/App.csproj.x:y.props', 'a:Directory.Build.props', 'src/b:c.csproj'])
            expect(isDotnetDefinitionFile(p), p).toBe(true);
        expect(strayDotnetDefinitionFiles(['src/evil:1.props'])).toEqual(['src/evil:1.props']);
        for (const p of ['notes:2026.txt', 'src/a:b.cs'])
            expect(isDotnetDefinitionFile(p), p).toBe(false);
    });
    it('F7: a basename is matched as Windows opens it: trailing dots and spaces, an NTFS stream suffix and default-ignorable characters folded', () => {
        for (const p of ['src/App.csproj.', 'src/App.csproj .', 'src/App.csproj::$DATA', 'src/App.csproj:evil', 'Directory.Build.props​', 'Ｄirectory.Build.props', 'global.json. ']) {
            expect(isDotnetDefinitionFile(p), JSON.stringify(p)).toBe(true);
        }
    });
});
//# sourceMappingURL=local-gate.sources.test.js.map