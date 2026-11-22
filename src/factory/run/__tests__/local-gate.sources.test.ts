import { describe, expect, it } from 'vitest';
import { DOTNET_DEFINITION_PATTERNS, describeGateSources, gateDefinition, gateDefinitionSources, gateSourcePathspec, patternSourceChanges } from '../local-gate.js';

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
  const PATTERNS = DOTNET_DEFINITION_PATTERNS.map((path) => ({ path, pattern: true }));

  it('dotnet build / dotnet test, by name or by an absolute path to the host, are pinned by the pattern sources', () => {
    for (const gate of [['dotnet', 'test'], ['dotnet', 'build'], ['dotnet.exe', 'test', '-c', 'Release'], ['C:\\Program Files\\dotnet\\dotnet.exe', 'test'], ['/usr/share/dotnet/dotnet', 'build', '--no-restore'], ['dotnet', 'TEST']]) {
      expect(gateDefinitionSources(gate), gate.join(' ')).toEqual({ sources: PATTERNS });
    }
    for (const p of ['*.sln', '*.slnx', '*.csproj', '*.fsproj', '*.vbproj', '*.props', '*.targets', 'global.json', 'nuget.config', 'packages.lock.json', 'Directory.Build.rsp']) {
      expect(DOTNET_DEFINITION_PATTERNS, p).toContain(p);
    }
  });

  it('repository files the argv names are sources too; paths outside the repository and after -- are not', () => {
    expect(gateDefinitionSources(['dotnet', 'test', 'tests/App.Tests/App.Tests.csproj', '--settings', 'ci.runsettings', '@build.rsp']).sources.filter((s) => !('pattern' in s)))
      .toEqual([{ path: 'tests/App.Tests/App.Tests.csproj' }, { path: 'ci.runsettings' }, { path: 'build.rsp' }]);
    expect(gateDefinitionSources(['dotnet', 'test', '--settings=C:\\ci\\x.runsettings', '-c', 'Release', '--filter', 'Category=Unit', '--', 'tests/x']).sources).toEqual(PATTERNS);
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

  it('the definition changes with any matching file of the tree, at any depth and in any case, and not with code or tests', () => {
    const { sources } = gateDefinitionSources(['dotnet', 'test']);
    const tree = (over: Record<string, string> = {}): Array<readonly [string, string]> => Object.entries({
      'App.sln': 'a1', 'src/App/App.csproj': 'b1', 'src/App/Program.cs': 'c1', 'tests/App.Tests/AppTests.cs': 'd1', 'README.md': 'e1', ...over,
    }).filter(([, oid]) => oid !== '').map(([p, oid]) => [p, oid] as const);
    const def = (t: Array<readonly [string, string]>) => gateDefinition(sources, () => { throw new Error('pattern sources never read a file'); }, () => t);
    const base = def(tree());
    expect(def(tree({ 'src/App/Program.cs': 'c2', 'tests/App.Tests/AppTests.cs': 'd2', 'README.md': 'e2' }))).toBe(base);
    expect(def([...tree()].reverse())).toBe(base);
    const changes: Array<Record<string, string>> = [{ 'src/App/App.csproj': 'b2' }, { 'App.sln': '' }, { 'Directory.Build.props': 'f1' }, { 'src/Directory.Build.targets': 'f1' }, { 'NuGet.Config': 'f1' }, { 'global.json': 'f1' },
      { 'src/App/packages.lock.json': 'f1' }, { 'App.slnx': 'f1' }, { 'build/Custom.Targets': 'f1' }, { 'tests/Directory.Build.rsp': 'f1' }, { 'tools/Other.FSPROJ': 'f1' }];
    for (const change of changes) {
      expect(def(tree(change)), JSON.stringify(change)).not.toBe(base);
    }
    expect(() => gateDefinition(sources, () => undefined)).toThrow(/needs the commit's file list/);
  });

  it('names the changed files and gives git pathspecs for the patterns', () => {
    const { sources } = gateDefinitionSources(['dotnet', 'test']);
    const a = [['App.sln', '1'], ['src/App.csproj', '2'], ['src/x.cs', '3']] as const;
    const b = [['App.sln', '1'], ['src/App.csproj', '9'], ['src/x.cs', '4'], ['Directory.Build.props', '5']] as const;
    expect(patternSourceChanges(sources, a, b)).toEqual(['Directory.Build.props', 'src/App.csproj']);
    expect(patternSourceChanges(sources, a, a)).toEqual([]);
    expect(gateSourcePathspec({ path: '*.csproj', pattern: true })).toBe("':(glob,icase)**/*.csproj'");
    expect(gateSourcePathspec({ path: 'scripts/gate.mjs' })).toBe('scripts/gate.mjs');
    expect(describeGateSources([{ path: '*.sln', pattern: true }, { path: 'ci.runsettings' }])).toBe('**/*.sln, ci.runsettings');
  });
});
