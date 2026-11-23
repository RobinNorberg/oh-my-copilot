/**
 * Live: a real `dotnet build` and `dotnet test` gate through the real factory
 * gate sandbox (createSandboxRunner: a turnless Copilot runtime, no prompt,
 * no model turn) on a generated .NET fixture, with no user sandbox grants.
 *
 * Opt-in: runs only with OMG_LIVE_DOTNET=1 (`OMG_LIVE_DOTNET=1 npx vitest run
 * src/factory/run/__tests__/dotnet-gate.live.test.ts`). Skips itself off
 * Windows (the only verified host), without `dotnet` on PATH, when
 * the sandbox cannot start (no copilot CLI or SDK), and, for the test case,
 * when the xunit packages are not already in the NuGet global packages folder
 * (the sandbox has no network, so nothing is restored from a feed). The
 * restore case reaches nuget.org (api.nuget.org only) and writes only a
 * throwaway packages dir; it skips when your cache already holds its package.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nugetPackagesDir } from '../../../copilot-run/dotnet-sandbox.js';
import { resolveLocalGateArgv } from '../../../factory/run/local-gate.js';
import { classifyNugetFailure, dotnetRestoreArgs, parseCatFileBatch, writeDefinitionTree } from '../../../factory/run/nuget-restore.js';
import { resolveDefaultPluginRoot } from '../../../smoke/copilot-session-env.js';
import { createSandboxRunner } from '../../../factory/run/sandbox-exec.js';
import { findOnPath } from '../../../utils/windows-search.js';
const onWindows = process.platform === 'win32';
const dotnet = onWindows ? findOnPath('dotnet', { ...process.env, PATHEXT: '.EXE' }, 'win32') : null;
/** The packages the xunit project restores offline (the same versions `dotnet new xunit` picked on SDK 10.0.101). */
const XUNIT = [['microsoft.net.test.sdk', '17.14.1'], ['xunit', '2.9.3'], ['xunit.runner.visualstudio', '3.1.4']];
const packages = nugetPackagesDir(process.env, homedir());
const xunitCached = !!packages && XUNIT.every(([id, v]) => existsSync(join(packages, id, v)));
/** A small package with no dependencies on net10.0 that the restore case fetches; skipped when your cache already has it. */
const UNCACHED = ['Humanizer.Core', '2.14.1'];
const uncachedCached = !!packages && existsSync(join(packages, UNCACHED[0].toLowerCase(), UNCACHED[1]));
let dir;
/** The user's checkout (the job homes go under its .omg/) and the engine-owned checkout the gate runs in. */
let root;
let checkout;
/** Only a host without the runtime skips; any other no-verdict fails the test. */
const NO_RUNTIME = /copilot-sdk is not installed|copilot CLI not found|names no \.js\/\.exe target/;
const LIB = '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net10.0</TargetFramework>\n    <Nullable>enable</Nullable>\n  </PropertyGroup>\n</Project>\n';
const TESTS = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
  <ItemGroup>
${XUNIT.map(([id, v]) => `    <PackageReference Include="${{ 'microsoft.net.test.sdk': 'Microsoft.NET.Test.Sdk', xunit: 'xunit', 'xunit.runner.visualstudio': 'xunit.runner.visualstudio' }[id]}" Version="${v}" />`).join('\n')}
  </ItemGroup>
  <ItemGroup>
    <ProjectReference Include="..\\Lib\\Lib.csproj" />
  </ItemGroup>
</Project>
`;
function git(cwd, ...args) {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8' });
    if (r.status !== 0)
        throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}
beforeAll(() => {
    if (process.env.OMG_LIVE_DOTNET !== '1' || !onWindows || !dotnet)
        return;
    dir = mkdtempSync(join(tmpdir(), 'omg-dotnet-live-'));
    root = join(dir, 'repo');
    checkout = join(dir, 'checkout');
    mkdirSync(join(root, 'Lib'), { recursive: true });
    mkdirSync(join(root, 'Lib.Tests'));
    writeFileSync(join(root, '.gitignore'), 'bin/\nobj/\n.omg/\n');
    writeFileSync(join(root, 'Lib', 'Lib.csproj'), LIB);
    writeFileSync(join(root, 'Lib', 'Greeting.cs'), 'namespace Lib;\npublic static class Greeting { public static string Hello(string n) => $"Hello, {n}!"; }\n');
    writeFileSync(join(root, 'Lib.Tests', 'Lib.Tests.csproj'), TESTS);
    writeFileSync(join(root, 'Lib.Tests', 'GreetingTests.cs'), 'namespace Lib.Tests;\npublic class GreetingTests { [Xunit.Fact] public void Greets() => Xunit.Assert.Equal("Hello, Ada!", Lib.Greeting.Hello("Ada")); }\n');
    // The solution (.slnx on SDK 10) the plain dotnet test finds, made by the host's own dotnet.
    for (const args of [['new', 'sln', '-n', 'Fixture'], ['sln', 'add', join('Lib', 'Lib.csproj'), join('Lib.Tests', 'Lib.Tests.csproj')]]) {
        const r = spawnSync(dotnet, args, { cwd: root, encoding: 'utf8', env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
        if (r.status !== 0)
            throw new Error(`dotnet ${args.join(' ')}: ${r.stdout}${r.stderr}`);
    }
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'fixture');
    git(dir, 'clone', '-q', root, checkout);
});
afterAll(() => {
    if (dir)
        rmSync(dir, { recursive: true, force: true });
});
/** Run `argv` as the local gate in the real sandbox, with no user sandbox settings (no extra grants). */
async function gate(argv) {
    const cwd = checkout;
    const target = resolveLocalGateArgv(argv, { cwd });
    if ('missing' in target)
        throw new Error(target.missing);
    const run = createSandboxRunner(root, undefined, { user: { factory: { run: { sandbox: {} } } }, project: undefined });
    return run({ purpose: 'gate', argv, exe: target.exe, args: target.args, cwd, commonGitDir: join(checkout, '.git'), timeoutMs: 300_000 });
}
/** The engine's clean step (the built dist/factory/run/dotnet-clean-step.js, `npm run build` first) in the real sandbox, as ensureLocalGate runs it. */
async function cleanStep(cwd) {
    const script = join(resolveDefaultPluginRoot(process.env), 'dist', 'factory', 'run', 'dotnet-clean-step.js');
    const run = createSandboxRunner(root, undefined, { user: { factory: { run: { sandbox: {} } } }, project: undefined });
    return run({ purpose: 'clean', argv: ['node', script], exe: process.execPath, args: [script], cwd, commonGitDir: join(cwd, '.git'), timeoutMs: 300_000, network: 'none' });
}
describe.runIf(process.env.OMG_LIVE_DOTNET === '1' && onWindows && !!dotnet)('a dotnet gate in the real Windows gate sandbox (live, no model turn)', () => {
    it('dotnet build of a project with no packages passes', async (ctx) => {
        const r = await gate(['dotnet', 'build', 'Lib/Lib.csproj']);
        if (!r.ran && NO_RUNTIME.test(r.reason)) {
            ctx.skip(`no Copilot runtime here: ${r.reason}`);
            return;
        }
        expect(r.ran, r.ran ? '' : r.reason).toBe(true);
        if (!r.ran)
            return;
        expect(r.timedOut, r.output).toBe(false);
        expect(r.status, r.output).toBe(0);
        expect(r.output).toMatch(/Build succeeded/);
    }, 360_000);
    it.runIf(xunitCached)('dotnet test with cached xunit packages passes, no wrapper script and no grants configured', async (ctx) => {
        const r = await gate(['dotnet', 'test']);
        if (!r.ran && NO_RUNTIME.test(r.reason)) {
            ctx.skip(`no Copilot runtime here: ${r.reason}`);
            return;
        }
        expect(r.ran, r.ran ? '' : r.reason).toBe(true);
        if (!r.ran)
            return;
        expect(r.timedOut, r.output).toBe(false);
        expect(r.status, r.output).toBe(0);
        expect(r.output).toMatch(/Passed!\s+- Failed:\s+0, Passed:\s+1/);
    }, 360_000);
    it.runIf(xunitCached)('after the sandboxed clean step (as before every dotnet gate run) the build dirs and a nested repository in obj/ are gone and the gate restores offline and passes again', async (ctx) => {
        const first = await gate(['dotnet', 'test']);
        if (!first.ran && NO_RUNTIME.test(first.reason)) {
            ctx.skip(`no Copilot runtime here: ${first.reason}`);
            return;
        }
        // The PR's code hides a stale file from git ls-files behind a repository in obj/.
        writeFileSync(join(checkout, 'Lib.Tests', 'obj', 'stale.props'), '<Project />\n');
        git(join(checkout, 'Lib.Tests', 'obj'), 'init', '-q');
        const r0 = await cleanStep(checkout);
        expect(r0.ran, r0.ran ? '' : r0.reason).toBe(true);
        if (!r0.ran)
            return;
        expect(r0.status, r0.output).toBe(0);
        expect(r0.output).toMatch(/^removed [1-9]\d*$/m);
        const listed = spawnSync('git', ['ls-files', '--others', '-z'], { cwd: checkout, encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
        expect(listed).toEqual([]);
        const r = await gate(['dotnet', 'test']);
        expect(r.ran, r.ran ? '' : r.reason).toBe(true);
        if (!r.ran)
            return;
        expect(r.status, r.output).toBe(0);
        expect(r.output).toMatch(/Restored .*Lib\.Tests\.csproj/);
        expect(r.output).toMatch(/Passed!\s+- Failed:\s+0, Passed:\s+1/);
    }, 720_000);
    it.runIf(!uncachedCached)('the restore step fetches a package not in your cache from nuget.org into a throwaway packages dir, then the gate passes offline on it; your cache gains nothing', async (ctx) => {
        const co = join(dir, 'restore-checkout');
        git(dir, 'clone', '-q', root, co);
        writeFileSync(join(co, 'Lib', 'Lib.csproj'), LIB.replace('</PropertyGroup>', `</PropertyGroup>\n  <ItemGroup>\n    <PackageReference Include="${UNCACHED[0]}" Version="${UNCACHED[1]}" />\n  </ItemGroup>`));
        const run = createSandboxRunner(root, undefined, { user: { factory: { run: { sandbox: {} } } }, project: undefined });
        const throwaway = join(dir, 'run-packages');
        mkdirSync(throwaway);
        const build = ['dotnet', 'build', 'Lib/Lib.csproj'];
        const target = resolveLocalGateArgv(build, { cwd: co });
        if ('missing' in target)
            throw new Error(target.missing);
        const offline = await run({ purpose: 'gate', argv: build, exe: target.exe, args: target.args, cwd: co, commonGitDir: join(co, '.git'), timeoutMs: 300_000 });
        if (!offline.ran && NO_RUNTIME.test(offline.reason)) {
            ctx.skip(`no Copilot runtime here: ${offline.reason}`);
            return;
        }
        expect(offline.ran && offline.status, offline.ran ? offline.output : offline.reason).not.toBe(0);
        if (!offline.ran)
            return;
        expect(classifyNugetFailure(offline.output), offline.output).toMatchObject({ kind: 'restore' });
        const restoreArgv = ['dotnet', ...dotnetRestoreArgs(build.slice(1))];
        const rt = resolveLocalGateArgv(restoreArgv, { cwd: co });
        if ('missing' in rt)
            throw new Error(rt.missing);
        const restored = await run({ purpose: 'restore', argv: restoreArgv, exe: rt.exe, args: rt.args, cwd: co, commonGitDir: join(co, '.git'), timeoutMs: 300_000, network: 'nuget', nugetPackages: { dir: throwaway, writable: true } });
        expect(restored.ran && restored.status, restored.ran ? restored.output : restored.reason).toBe(0);
        expect(existsSync(join(throwaway, UNCACHED[0].toLowerCase(), UNCACHED[1]))).toBe(true);
        const r = await run({ purpose: 'gate', argv: build, exe: target.exe, args: target.args, cwd: co, commonGitDir: join(co, '.git'), timeoutMs: 300_000, nugetPackages: { dir: throwaway, writable: false } });
        expect(r.ran && r.status, r.ran ? r.output : r.reason).toBe(0);
        if (r.ran)
            expect(r.output).toMatch(/Build succeeded/);
        expect(!!packages && existsSync(join(packages, UNCACHED[0].toLowerCase(), UNCACHED[1]))).toBe(false);
    }, 900_000);
    it('H1: the restore in a definition tree written from the head\'s git objects never runs the <Exec> of an unpinned import the head rewrote', async (ctx) => {
        const repo = join(dir, 'h1-repo');
        const tree = join(dir, 'h1-tree');
        const marker = join(dir, 'h1-marker.txt');
        const hits = [];
        const srv = createServer((req, res) => { hits.push(req.url ?? ''); res.end('ok'); });
        await new Promise((r) => srv.listen(0, '127.0.0.1', () => r()));
        const port = srv.address().port;
        try {
            mkdirSync(join(repo, 'build'), { recursive: true });
            mkdirSync(join(repo, 'App'));
            writeFileSync(join(repo, 'Directory.Build.props'), '<Project>\n  <Import Project="$(MSBuildThisFileDirectory)build/common.msbuild" />\n</Project>\n');
            writeFileSync(join(repo, 'build', 'common.msbuild'), '<Project />\n');
            writeFileSync(join(repo, 'App', 'App.csproj'), LIB);
            git(repo, 'init', '-q', '-b', 'main');
            git(repo, 'add', '.');
            git(repo, 'commit', '-q', '-m', 'base');
            // The "PR" rewrites only the unpinned import: an Exec before the restore graph, a marker and a loopback canary.
            writeFileSync(join(repo, 'build', 'common.msbuild'), `<Project>\n  <Target Name="Evil" BeforeTargets="_GenerateRestoreGraph;CollectPackageReferences">\n    <Exec ContinueOnError="true" Command="echo RAN_EXEC_IN_RESTORE &gt; &quot;${marker}&quot;" />\n    <Exec ContinueOnError="true" Command="curl.exe -s -m 10 -o NUL http://127.0.0.1:${port}/h1-canary" />\n  </Target>\n</Project>\n`);
            git(repo, 'commit', '-q', '-am', 'head');
            const entries = spawnSync('git', ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.split('\0').filter(Boolean).map((line) => {
                const tab = line.indexOf('\t');
                const [mode, , oid] = line.slice(0, tab).split(' ');
                return [line.slice(tab + 1), oid, mode];
            });
            const written = writeDefinitionTree(tree, entries, (oids) => parseCatFileBatch(spawnSync('git', ['cat-file', '--batch'], { cwd: repo, input: `${oids.join('\n')}\n` }).stdout));
            expect(written).toEqual({ files: ['App/App.csproj', 'Directory.Build.props'] });
            const run = createSandboxRunner(root, undefined, { user: { factory: { run: { sandbox: {} } } }, project: undefined });
            const argv = ['dotnet', ...dotnetRestoreArgs(['build', 'App/App.csproj'])];
            const t = resolveLocalGateArgv(argv, { cwd: tree });
            if ('missing' in t)
                throw new Error(t.missing);
            const throwaway = join(dir, 'h1-packages');
            mkdirSync(throwaway);
            const r = await run({ purpose: 'restore', argv, exe: t.exe, args: t.args, cwd: tree, commonGitDir: join(repo, '.git'), timeoutMs: 300_000, network: 'nuget', nugetPackages: { dir: throwaway, writable: true } });
            if (!r.ran && NO_RUNTIME.test(r.reason)) {
                ctx.skip(`no Copilot runtime here: ${r.reason}`);
                return;
            }
            expect(r.ran, r.ran ? '' : r.reason).toBe(true);
            if (!r.ran)
                return;
            // NuGet's restore evaluation ignores a missing import: the restore succeeds without it, and its Exec never ran.
            expect(r.status, r.output).toBe(0);
            expect(r.output).not.toMatch(/RAN_EXEC_IN_RESTORE/);
            expect(existsSync(marker)).toBe(false);
            expect(hits).toEqual([]);
        }
        finally {
            srv.close();
        }
    }, 360_000);
    it('H2: the restore step reaches api.nuget.org and no other internet host; on Windows loopback stays reachable (the sandbox runs nothing without it)', async (ctx) => {
        const tree = join(dir, 'h2-tree');
        const hits = [];
        const srv = createServer((req, res) => { hits.push(req.url ?? ''); res.end('ok'); });
        await new Promise((r) => srv.listen(0, '127.0.0.1', () => r()));
        const port = srv.address().port;
        try {
            mkdirSync(join(tree, 'App'), { recursive: true });
            writeFileSync(join(tree, 'App', 'App.csproj'), LIB);
            // A pinned definition file (trusted: the test's own) that probes what the restore step can reach.
            writeFileSync(join(tree, 'Directory.Build.targets'), `<Project>\n  <Target Name="Probe" BeforeTargets="_GenerateRestoreGraph">\n    <Exec ContinueOnError="true" Command="curl.exe -s -m 10 -o NUL -w &quot;PROBE_LOOPBACK=%%{http_code}&quot; http://127.0.0.1:${port}/h2-loopback" />\n    <Exec ContinueOnError="true" Command="curl.exe -s -m 10 -o NUL -w &quot;PROBE_EXAMPLE=%%{http_code}&quot; https://example.com/" />\n    <Exec ContinueOnError="true" Command="curl.exe -s -m 10 -o NUL -w &quot;PROBE_NUGET=%%{http_code}&quot; https://api.nuget.org/v3/index.json" />\n  </Target>\n</Project>\n`);
            const run = createSandboxRunner(root, undefined, { user: { factory: { run: { sandbox: {} } } }, project: undefined });
            const argv = ['dotnet', 'restore', 'App/App.csproj'];
            const t = resolveLocalGateArgv(argv, { cwd: tree });
            if ('missing' in t)
                throw new Error(t.missing);
            const throwaway = join(dir, 'h2-packages');
            mkdirSync(throwaway);
            const r = await run({ purpose: 'restore', argv, exe: t.exe, args: t.args, cwd: tree, commonGitDir: join(checkout, '.git'), timeoutMs: 300_000, network: 'nuget', nugetPackages: { dir: throwaway, writable: true } });
            if (!r.ran && NO_RUNTIME.test(r.reason)) {
                ctx.skip(`no Copilot runtime here: ${r.reason}`);
                return;
            }
            expect(r.ran, r.ran ? '' : r.reason).toBe(true);
            if (!r.ran)
                return;
            expect(r.output).toMatch(/PROBE_NUGET=200/);
            expect(r.output).toMatch(/PROBE_EXAMPLE=000/);
            // Known gap (docs/REFERENCE.md, .NET repositories): the Windows sandbox runs no command with outbound allowed and
            // the local network denied, so loopback answers. When this fails, the runtime can deny it: set allowLocalNetwork
            // false for onlyHosts (sandbox.ts) and turn this into a not-reachable assertion.
            expect(r.output).toMatch(/PROBE_LOOPBACK=200/);
            expect(hits).toEqual(['/h2-loopback']);
        }
        finally {
            srv.close();
        }
    }, 360_000);
    it('H2: a junction obj -> a dir outside the checkout survives the clean step, and a sandboxed delete through it is denied', async (ctx) => {
        const co = join(dir, 'junction-checkout');
        const canary = join(dir, 'junction-canary');
        git(dir, 'clone', '-q', root, co);
        mkdirSync(join(canary, 'sub', 'tree'), { recursive: true });
        writeFileSync(join(canary, 'sub', 'f.txt'), 'CANARY');
        writeFileSync(join(canary, 'sub', 'tree', 'g.txt'), 'CANARY');
        const junction = join(co, 'Lib', 'obj');
        symlinkSync(canary, junction, 'junction');
        try {
            // What a raced walk would do: delete through the link a leftover process swapped in.
            writeFileSync(join(co, 'follow.mjs'), "import { rmSync, unlinkSync } from 'node:fs';\nfor (const f of [() => unlinkSync('Lib/obj/sub/f.txt'), () => rmSync('Lib/obj/sub/tree', { recursive: true })]) { try { f(); console.log('deleted'); } catch (e) { console.log('denied', e.code); } }\n");
            const run = createSandboxRunner(root, undefined, { user: { factory: { run: { sandbox: {} } } }, project: undefined });
            const follow = await run({ purpose: 'clean', argv: ['node', 'follow.mjs'], exe: process.execPath, args: ['follow.mjs'], cwd: co, commonGitDir: join(co, '.git'), timeoutMs: 120_000, network: 'none' });
            if (!follow.ran && NO_RUNTIME.test(follow.reason)) {
                ctx.skip(`no Copilot runtime here: ${follow.reason}`);
                return;
            }
            expect(follow.ran, follow.ran ? '' : follow.reason).toBe(true);
            if (!follow.ran)
                return;
            expect(follow.output).not.toMatch(/deleted/);
            expect(follow.output.match(/denied/g)).toHaveLength(2);
            expect(existsSync(join(canary, 'sub', 'f.txt')) && existsSync(join(canary, 'sub', 'tree', 'g.txt'))).toBe(true);
            // The clean step itself unlinks the junction, never follows it.
            const r = await cleanStep(co);
            expect(r.ran && r.status, r.ran ? r.output : r.reason).toBe(0);
            expect(existsSync(junction)).toBe(false);
            expect(readdirSync(canary)).toEqual(['sub']);
            expect(existsSync(join(canary, 'sub', 'f.txt')) && existsSync(join(canary, 'sub', 'tree', 'g.txt'))).toBe(true);
        }
        finally {
            try {
                if (lstatSync(junction).isSymbolicLink())
                    unlinkSync(junction);
            }
            catch { /* gone */ }
        }
    }, 360_000);
});
//# sourceMappingURL=dotnet-gate.live.test.js.map