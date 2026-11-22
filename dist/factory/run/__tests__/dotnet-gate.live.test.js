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
 * (the sandbox has no network, so nothing is restored from a feed).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nugetPackagesDir } from '../../../copilot-run/dotnet-sandbox.js';
import { resolveLocalGateArgv } from '../../../factory/run/local-gate.js';
import { resolveDefaultPluginRoot } from '../../../smoke/copilot-session-env.js';
import { createSandboxRunner } from '../../../factory/run/sandbox-exec.js';
import { findOnPath } from '../../../utils/windows-search.js';
const onWindows = process.platform === 'win32';
const dotnet = onWindows ? findOnPath('dotnet', { ...process.env, PATHEXT: '.EXE' }, 'win32') : null;
/** The packages the xunit project restores offline (the same versions `dotnet new xunit` picked on SDK 10.0.101). */
const XUNIT = [['microsoft.net.test.sdk', '17.14.1'], ['xunit', '2.9.3'], ['xunit.runner.visualstudio', '3.1.4']];
const packages = nugetPackagesDir(process.env, homedir());
const xunitCached = !!packages && XUNIT.every(([id, v]) => existsSync(join(packages, id, v)));
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