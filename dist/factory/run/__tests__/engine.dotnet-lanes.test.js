/**
 * .NET write lanes on the GitHub forge (fake lanes, real git, scripted gh):
 * whether a run is a .NET one comes from trusted input only (the trusted
 * base commit's tree, the trusted ship.prepare checks), never from the PR
 * head (engine.ts dotnetRepo). The local forge's dotnet gate rule is covered
 * by engine.local.dogfood.test.ts, Azure DevOps by engine.ado.dotnet.test.ts.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runFactoryEngine } from '../engine.js';
import { commitFile, FakeLanes, gitIn, review } from './fake-lanes.js';
import { h, opts, useEngineHarness } from './engine-harness.js';
useEngineHarness();
const RULE = 'Always pass `-m:1`';
const READY = 'The dependencies are already installed in node_modules.';
const CSPROJ = '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net10.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n';
/** Files committed on dev and pushed (the trusted base the run starts from). */
function onBase(files) {
    for (const [rel, text] of Object.entries(files)) {
        mkdirSync(dirname(join(h.root, rel)), { recursive: true });
        writeFileSync(join(h.root, rel), text);
    }
    gitIn(h.root, 'add', '.');
    gitIn(h.root, 'commit', '-q', '-m', 'base files');
    gitIn(h.root, 'push', '-q', 'origin', 'dev');
}
const sandboxed = (lanes, over = {}) => {
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
    it('the Microsoft.Testing.Platform prompt variant and a reachable NuGet follow the trusted base on this forge too', async () => {
        onBase({ 'src/App/App.csproj': CSPROJ, 'global.json': '{ "test": { "runner": "Microsoft.Testing.Platform" } }\n' });
        const lanes = sandboxed(new FakeLanes(h.root, [commitFile('src/greet.ts'), review('approve')]), { writeNetwork: 'registry', allowedHosts: ['api.nuget.org'] });
        await runFactoryEngine(opts(lanes));
        expect(lanes.started[0].prompt).toContain('runs its tests on Microsoft.Testing.Platform');
        expect(lanes.started[0].prompt).not.toContain('NuGet cannot reach its feed here');
    });
    it('a trusted base that cannot be listed fails the step before any lane starts', async () => {
        onBase({ 'README.md': 'x\n' });
        const lanes = new FakeLanes(h.root, [commitFile('src/greet.ts'), review('approve')]);
        const exec = h.exec;
        const failing = (cmd, args, o) => (cmd === 'git' && args.includes('ls-tree') && args.includes('-r') ? { status: 128, stdout: '', stderr: 'fatal: not a tree object' } : exec(cmd, args, o));
        const out = await runFactoryEngine(opts(lanes, { exec: failing }));
        expect(out.exitCode, out.message).not.toBe(0);
        expect(out.message).toMatch(/could not be listed to tell whether it is a \.NET repository \(git ls-tree exit 128: fatal: not a tree object\)/);
        expect(lanes.started).toEqual([]);
    });
});
//# sourceMappingURL=engine.dotnet-lanes.test.js.map