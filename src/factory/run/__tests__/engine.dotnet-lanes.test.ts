/**
 * .NET write lanes on the GitHub forge (fake lanes, real git, scripted gh):
 * whether a run is a .NET one comes from trusted input only (the trusted
 * base commit's tree, the trusted ship.prepare checks), never from the PR
 * head (engine.ts dotnetRepo). The local forge's dotnet gate rule is covered
 * by engine.local.dogfood.test.ts, Azure DevOps by engine.ado.dotnet.test.ts.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { dotnetSandboxEnv, sandboxNugetConfig } from '../../../copilot-run/dotnet-sandbox.js';
import { runFactoryEngine } from '../engine.js';
import type { LaneStartInput } from '../lane.js';
import { readFactoryState } from '../state.js';
import { commitFile, FakeLanes, gitIn, ISSUE, review, type LaneScript } from './fake-lanes.js';
import { h, opts, useEngineHarness } from './engine-harness.js';

useEngineHarness();

const RULE = 'Always pass `-m:1`';
const READY = 'The dependencies are already installed in node_modules.';
const CSPROJ = '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net10.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n';

/** Files committed on dev and pushed (the trusted base the run starts from). */
function onBase(files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(h.root, rel)), { recursive: true });
    writeFileSync(join(h.root, rel), text);
  }
  gitIn(h.root, 'add', '.');
  gitIn(h.root, 'commit', '-q', '-m', 'base files');
  gitIn(h.root, 'push', '-q', 'origin', 'dev');
}

const sandboxed = (lanes: FakeLanes, over: Partial<ReturnType<NonNullable<FakeLanes['laneSandbox']>>> = {}) => {
  lanes.laneSandbox = () => ({ sandboxed: true, writeNetwork: 'none', windowsCopy: true, ...over });
  return lanes;
};
const finding = { severity: 'major', file: 'src/greet.ts', line: 1, summary: 'greet must return hi' };

describe('.NET write lanes on the GitHub forge', () => {
  it('a trusted base with a project file: write lanes (implement, fix) get dotnet and the -m:1 rule, review lanes nothing', async () => {
    onBase({ 'App.sln': 'Microsoft Visual Studio Solution File\n', 'src/App/App.csproj': CSPROJ });
    const lanes = sandboxed(new FakeLanes(h.root, [commitFile('src/App/Greet.cs', 'x\n'), review('request-changes', [finding]), commitFile('src/App/Greet.cs', 'y\n'), review('approve')]));
    expect((await runFactoryEngine(opts(lanes))).gate?.name).toBe('merge');
    expect(lanes.started.map((l) => [l.laneId.replace(/^issue-\d+-/, ''), l.dotnet ?? false])).toEqual([['implement-1', true], ['review-1', false], ['fix-1', true], ['review-2', false]]);
    expect(lanes.started[0].prompt).toContain(RULE);
    expect(lanes.started[0].prompt).toContain('NuGet cannot reach its feed here');
    expect(lanes.started[2].prompt).toContain(RULE);
    expect(lanes.started[1].prompt).not.toContain('-m:1');
  });

  it('a pure Node repository: no lane gets dotnet and no prompt names it', async () => {
    onBase({ 'package.json': '{ "name": "demo" }\n', 'bin/cli.js': '#!/usr/bin/env node\n' });
    const lanes = sandboxed(new FakeLanes(h.root, [commitFile('src/greet.ts'), review('approve')]));
    await runFactoryEngine(opts(lanes));
    expect(lanes.started.every((l) => l.dotnet === undefined)).toBe(true);
    expect(lanes.started.some((l) => l.prompt.includes('-m:1'))).toBe(false);
  });

  it('an iOS / React Native / C++ / Python repository (project.pbxproj, *.vcxproj, *.pyproj, *.esproj, *.proj) is not a .NET run', async () => {
    onBase({
      'package.json': '{ "name": "demo" }\n', 'ios/App.xcodeproj/project.pbxproj': '// !$*UTF8*$!\n', 'windows/App/App.vcxproj': '<Project />\n',
      'tools/pkg.pyproj': '<Project />\n', 'web/App.esproj': '<Project />\n', 'build.proj': '<Project />\n',
    });
    const lanes = sandboxed(new FakeLanes(h.root, [commitFile('src/greet.ts'), review('approve')]));
    await runFactoryEngine(opts(lanes));
    expect(lanes.started.length).toBeGreaterThan(0);
    expect(lanes.started.every((l) => l.dotnet === undefined)).toBe(true);
    expect(lanes.started.some((l) => l.prompt.includes('-m:1'))).toBe(false);
  });

  it('trusted base only: a PR head that adds a project file to a Node repository does not flip its later lanes', async () => {
    onBase({ 'package.json': '{ "name": "demo" }\n' });
    const lanes = sandboxed(new FakeLanes(h.root, [commitFile('src/App/App.csproj', CSPROJ), review('request-changes', [finding]), commitFile('src/greet.ts', 'hi\n'), review('approve')]));
    await runFactoryEngine(opts(lanes));
    expect(lanes.started.map((l) => l.laneId.replace(/^issue-\d+-/, ''))).toEqual(['implement-1', 'review-1', 'fix-1', 'review-2']);
    expect(lanes.started.every((l) => l.dotnet === undefined)).toBe(true);
  });

  it('a trusted ship.prepare check that runs dotnet makes a repository with no project file at its base a .NET one', async () => {
    onBase({ 'README.md': 'x\n' });
    const lanes = sandboxed(new FakeLanes(h.root, [commitFile('src/greet.ts'), review('approve')]));
    await runFactoryEngine(opts(lanes, { runUserConfig: { ship: { prepare: { checks: [['dotnet', 'test', 'Lib/Lib.Tests.csproj']] } } } }));
    expect(lanes.started.map((l) => l.dotnet ?? false)).toEqual([true, false]);
  });

  it('a mixed repository (Node + .NET): the write lane keeps its node_modules handling and gets the .NET settings', async () => {
    onBase({ 'package.json': '{ "name": "demo" }\n', 'src/App/App.csproj': CSPROJ });
    mkdirSync(join(h.root, 'node_modules'), { recursive: true });
    const lanes = sandboxed(new FakeLanes(h.root, [commitFile('src/greet.ts'), review('approve')]));
    await runFactoryEngine(opts(lanes));
    const [write, rev] = lanes.started;
    expect(write.dotnet).toBe(true);
    expect(typeof write.beforeSandboxedSession).toBe('function');
    expect(typeof write.nodeModulesGrant).toBe('function');
    expect(write.prompt).toContain(READY);
    expect(write.prompt).toContain(RULE);
    expect(rev.dotnet).toBeUndefined();
  });

  it('the NuGet config: one file for a root nuget.config or none; NuGet\'s own hierarchy only when the trusted base pins a lower one', async () => {
    onBase({ 'src/App/App.csproj': CSPROJ, 'nuget.config': '<configuration />\n', 'node_modules/pkg/nuget.config': '<configuration />\n' });
    const one = sandboxed(new FakeLanes(h.root, [commitFile('src/sub/nuget.config', '<configuration />\n'), review('approve')]));
    await runFactoryEngine(opts(one));
    // A lower file under node_modules is a package's, and the PR head's is not trusted: one file.
    expect(one.started[0].dotnet).toBe(true);
    expect(one.started[0].dotnetNugetHierarchy).toBeUndefined();
  });

  it('a trusted base with a nuget.config below its root: write lanes read NuGet\'s own hierarchy', async () => {
    onBase({ 'src/App/App.csproj': CSPROJ, 'nuget.config': '<configuration />\n', 'src/App/NuGet.Config': '<configuration />\n' });
    const lanes = sandboxed(new FakeLanes(h.root, [commitFile('src/greet.ts'), review('approve')]));
    await runFactoryEngine(opts(lanes));
    expect(lanes.started[0]).toMatchObject({ dotnet: true, dotnetNugetHierarchy: expect.stringContaining('below its root (src/App/NuGet.Config') });
    expect(lanes.started[1].dotnetNugetHierarchy).toBeUndefined();
  });

  it('the Microsoft.Testing.Platform prompt variant and a reachable NuGet follow the trusted base on this forge too', async () => {
    onBase({ 'src/App/App.csproj': CSPROJ, 'global.json': '{ "test": { "runner": "Microsoft.Testing.Platform" } }\n' });
    const lanes = sandboxed(new FakeLanes(h.root, [commitFile('src/greet.ts'), review('approve')]), { writeNetwork: 'registry', allowedHosts: ['api.nuget.org'] });
    await runFactoryEngine(opts(lanes));
    expect(lanes.started[0].prompt).toContain('runs its tests on Microsoft.Testing.Platform');
    expect(lanes.started[0].prompt).not.toContain('NuGet cannot reach its feed here');
  });

  describe('round 5: a write lane takes its NuGet policy from the base AND the commit its worktree starts at', () => {
    const SETTINGS_ONLY = '<configuration><config><add key="dependencyVersion" value="Lowest" /></config></configuration>\n';
    const LOWER = '<configuration><packageSources><clear /><add key="corp" value="corp-feed" /></packageSources></configuration>\n';
    const LIB = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="Humanizer.Core" Version="2.14.1" /></ItemGroup></Project>\n';
    interface Seen { input: LaneStartInput; env: Record<string, string>; fallback: boolean }

    /** The implement lane writes `files` (the PR head); the fix lane on that head records what its sandboxed dotnet gets. */
    async function fixLaneOn(files: Record<string, string>): Promise<Seen> {
      // `/.omg/` (the root only) and no node_modules entry, so a head's tools/.omg/ and node_modules/ files are committed.
      onBase({ '.gitignore': '/.omg/\nbin/\nobj/\n', 'nuget.config': SETTINGS_ONLY, 'App.sln': 'Microsoft Visual Studio Solution File\n', 'src/App/App.csproj': CSPROJ });
      let seen: Seen | undefined;
      const write: LaneScript = ({ worktree }) => {
        for (const [rel, text] of Object.entries(files)) {
          mkdirSync(dirname(join(worktree, rel)), { recursive: true });
          writeFileSync(join(worktree, rel), text);
        }
        return { finalText: 'Changed.', credits: 5 };
      };
      const fix: LaneScript = (ctx) => {
        // What job.ts builds for the lane's sandboxed dotnet: the REAL builders, from the lane's start options.
        const prof = mkdtempSync(join(h.dir, 'prof-'));
        const cfg = sandboxNugetConfig(ctx.worktree, prof, process.platform, { hierarchy: ctx.input.dotnetNugetHierarchy, noAdd: ctx.input.dotnetNugetNoAddSource });
        seen = { input: ctx.input, env: dotnetSandboxEnv(prof, {}, prof, process.platform, undefined, cfg).env, fallback: existsSync(join(prof, 'nuget', 'nuget.config')) };
        return commitFile('src/App/Greet.cs', 'y\n')(ctx);
      };
      const lanes = sandboxed(new FakeLanes(h.root, [write, review('request-changes', [finding]), fix, review('approve')]));
      await runFactoryEngine(opts(lanes));
      expect(lanes.started.map((l) => l.laneId.replace(/^issue-\d+-/, '')).slice(0, 3)).toEqual(['implement-1', 'review-1', 'fix-1']);
      // The implement lane started at the base: one file and nuget.org added for the settings-only root config.
      expect(lanes.started[0]).toMatchObject({ dotnet: true });
      expect(lanes.started[0].dotnetNugetHierarchy).toBeUndefined();
      expect(lanes.started[0].dotnetNugetNoAddSource).toBeUndefined();
      expect(seen).toBeDefined();
      return seen!;
    }

    const noNugetOrg = (s: Seen) => {
      expect(s.env.RestoreAdditionalProjectSources).toBeUndefined();
      expect(s.fallback).toBe(false);
    };

    it('the head adds RestoreSources in a subdirectory props file: nothing is added (NuGet would append nuget.org to it)', async () => {
      const s = await fixLaneOn({ 'Lib/Lib.csproj': LIB, 'Lib/Directory.Build.props': '<Project><PropertyGroup><RestoreSources>corp-feed</RestoreSources></PropertyGroup></Project>\n' });
      expect(s.input).toMatchObject({ dotnet: true, dotnetNugetNoAddSource: true });
      expect(s.env.RestoreConfigFile).toMatch(/nuget\.config$/);
      noNugetOrg(s);
    });

    it('the head adds an import the engine cannot pin: nothing is added', async () => {
      const s = await fixLaneOn({ 'Lib/Lib.csproj': LIB, 'Lib/Directory.Build.props': '<Project><Import Project="../eng/Sources.msbuild" Condition="Exists(\'../eng/Sources.msbuild\')" /></Project>\n' });
      expect(s.input).toMatchObject({ dotnet: true, dotnetNugetNoAddSource: true });
      noNugetOrg(s);
    });

    it('the head adds tools/.omg/Lib/nuget.config: NuGet\'s own hierarchy (the git policy names it)', async () => {
      const s = await fixLaneOn({ 'tools/.omg/Lib/Lib.csproj': LIB, 'tools/.omg/Lib/nuget.config': LOWER });
      expect(s.input.dotnetNugetHierarchy).toContain('below its root (tools/.omg/Lib/nuget.config');
      expect(s.env.RestoreConfigFile).toBeUndefined();
      noNugetOrg(s);
    });

    it('the head adds a project and a nuget.config under node_modules: NuGet\'s own hierarchy (no scan looks there)', async () => {
      const s = await fixLaneOn({ 'node_modules/x/Lib.csproj': LIB, 'node_modules/x/nuget.config': LOWER });
      expect(s.input.dotnetNugetHierarchy).toContain('under a node_modules directory (node_modules/x/Lib.csproj');
      expect(s.env.RestoreConfigFile).toBeUndefined();
      noNugetOrg(s);
    });

    it('an ordinary head (a source file only): the fix lane keeps one file with nuget.org added for the settings-only root config', async () => {
      const s = await fixLaneOn({ 'src/App/Greet.cs': 'x\n' });
      expect(s.input.dotnetNugetHierarchy).toBeUndefined();
      expect(s.input.dotnetNugetNoAddSource).toBeUndefined();
      expect(s.env.RestoreAdditionalProjectSources).toBe('https://api.nuget.org/v3/index.json');
    });
  });

  it('a trusted base that cannot be listed fails the step before any lane starts', async () => {
    onBase({ 'README.md': 'x\n' });
    const lanes = new FakeLanes(h.root, [commitFile('src/greet.ts'), review('approve')]);
    const exec = h.exec;
    const failing: typeof h.exec = (cmd, args, o) => (cmd === 'git' && args.includes('ls-tree') && args.includes('-r') ? { status: 128, stdout: '', stderr: 'fatal: not a tree object' } : exec(cmd, args, o));
    const out = await runFactoryEngine(opts(lanes, { exec: failing }));
    expect(out.exitCode, out.message).not.toBe(0);
    expect(out.message).toMatch(/could not be listed to tell whether it is a \.NET repository \(git ls-tree exit 128: fatal: not a tree object\)/);
    expect(lanes.started).toEqual([]);
    // A step error, read before the lane is recorded: no lane start failure that would consume a lane retry (review of #606 L4).
    expect(out.message).not.toMatch(/could not start/);
    expect(readFactoryState(h.root, ISSUE)?.lanes ?? []).toEqual([]);
  });
});
