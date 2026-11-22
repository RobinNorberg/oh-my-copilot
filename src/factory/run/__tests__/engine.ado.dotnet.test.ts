/**
 * .NET write lanes on the Azure DevOps forge (fake lanes, real git, the az
 * model): the trusted base commit's tree decides, as on GitHub
 * (engine.dotnet-lanes.test.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runFactoryEngine } from '../engine.js';
import { commitFile, FakeLanes, gitIn, review } from './fake-lanes.js';
import { h, opts, useAdoHarness } from './engine-ado-harness.js';

useAdoHarness();

function onBase(files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(h.root, rel)), { recursive: true });
    writeFileSync(join(h.root, rel), text);
  }
  gitIn(h.root, 'add', '.');
  gitIn(h.root, 'commit', '-q', '-m', 'base files');
  gitIn(h.root, 'push', '-q', 'origin', 'dev');
}

describe('.NET write lanes on the Azure DevOps forge', () => {
  it('a trusted base with a solution: the write lane gets dotnet and the -m:1 rule, the review lane nothing', async () => {
    onBase({ 'App.slnx': '<Solution />\n', 'src/App/App.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n' });
    const lanes = new FakeLanes(h.root, [commitFile('src/App/Greet.cs', 'x\n'), review('approve')]);
    lanes.laneSandbox = () => ({ sandboxed: true, writeNetwork: 'none', windowsCopy: true });
    await runFactoryEngine(opts(lanes));
    expect(lanes.started.map((l) => l.dotnet ?? false)).toEqual([true, false]);
    expect(lanes.started[0].prompt).toContain('Always pass `-m:1`');
  });

  it('an iOS / C++ / Python repository (project.pbxproj, *.vcxproj, *.pyproj): nothing', async () => {
    onBase({ 'ios/App.xcodeproj/project.pbxproj': '// !$*UTF8*$!\n', 'windows/App/App.vcxproj': '<Project />\n', 'tools/pkg.pyproj': '<Project />\n' });
    const lanes = new FakeLanes(h.root, [commitFile('src/greet.ts'), review('approve')]);
    lanes.laneSandbox = () => ({ sandboxed: true, writeNetwork: 'none', windowsCopy: true });
    await runFactoryEngine(opts(lanes));
    expect(lanes.started.length).toBeGreaterThan(0);
    expect(lanes.started.every((l) => l.dotnet === undefined)).toBe(true);
  });

  it('a Node repository: nothing', async () => {
    onBase({ 'package.json': '{ "name": "demo" }\n' });
    const lanes = new FakeLanes(h.root, [commitFile('src/greet.ts'), review('approve')]);
    lanes.laneSandbox = () => ({ sandboxed: true, writeNetwork: 'none', windowsCopy: true });
    await runFactoryEngine(opts(lanes));
    expect(lanes.started.length).toBeGreaterThan(0);
    expect(lanes.started.every((l) => l.dotnet === undefined)).toBe(true);
  });
});
