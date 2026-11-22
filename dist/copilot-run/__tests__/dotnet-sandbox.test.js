/**
 * dotnet-sandbox.ts: which commands count as dotnet, the -m:1 rewrite, the
 * NuGet packages folder lookup and the env a sandboxed dotnet gets.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOTNET_SINGLE_NODE_FLAG, dotnetSandboxArgs, dotnetSandboxEnv, isDotnetExe, nugetPackagesDir } from '../dotnet-sandbox.js';
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omg-dotnet-sandbox-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
describe('isDotnetExe', () => {
    it('is the dotnet host by name or path, in any case, and nothing else', () => {
        for (const exe of ['dotnet', 'dotnet.exe', 'DOTNET.EXE', 'C:\\Program Files\\dotnet\\dotnet.exe', '/usr/share/dotnet/dotnet'])
            expect(isDotnetExe(exe), exe).toBe(true);
        for (const exe of [undefined, '', 'node', 'C:\\tools\\dotnet-test.exe', '/usr/bin/dotnetx', 'npm', 'dotnet.cmd'])
            expect(isDotnetExe(exe), String(exe)).toBe(false);
    });
});
describe('dotnetSandboxArgs', () => {
    it('adds -m:1 to an MSBuild subcommand, before any --', () => {
        expect(dotnetSandboxArgs(['test'])).toEqual(['test', DOTNET_SINGLE_NODE_FLAG]);
        expect(dotnetSandboxArgs(['build', '-c', 'Release'])).toEqual(['build', '-c', 'Release', '-m:1']);
        expect(dotnetSandboxArgs(['test', '--', 'RunConfiguration.MaxCpuCount=2'])).toEqual(['test', '-m:1', '--', 'RunConfiguration.MaxCpuCount=2']);
        expect(dotnetSandboxArgs(['Restore'])).toEqual(['Restore', '-m:1']);
    });
    it('keeps an explicit node count, and leaves other subcommands and option-first argv alone', () => {
        for (const flag of ['-m', '-m:4', '/m', '-maxcpucount', '-maxCpuCount:2', '/maxcpucount:1'])
            expect(dotnetSandboxArgs(['build', flag])).toEqual(['build', flag]);
        // After `--` a -m is the app's or the test's, not MSBuild's.
        expect(dotnetSandboxArgs(['test', '--', '-m:4'])).toEqual(['test', '-m:1', '--', '-m:4']);
        for (const args of [[], ['--info'], ['format'], ['tool', 'restore'], ['exec', 'x.dll'], ['--diagnostics', 'build']])
            expect(dotnetSandboxArgs(args)).toEqual(args);
    });
});
describe('nugetPackagesDir', () => {
    it('NUGET_PACKAGES when absolute, else ~/.nuget/packages; only an existing directory', () => {
        const home = join(dir, 'home');
        expect(nugetPackagesDir({}, home)).toBeNull();
        mkdirSync(join(home, '.nuget', 'packages'), { recursive: true });
        expect(nugetPackagesDir({}, home)).toBe(join(home, '.nuget', 'packages'));
        const own = join(dir, 'cache');
        mkdirSync(own);
        expect(nugetPackagesDir({ NUGET_PACKAGES: own }, home)).toBe(own);
        expect(nugetPackagesDir({ nuget_packages: own }, home)).toBe(own);
        // A relative value would resolve against whatever the cwd is: the home default instead.
        expect(nugetPackagesDir({ NUGET_PACKAGES: 'cache' }, home)).toBe(join(home, '.nuget', 'packages'));
        // A missing dir or a file is no grant.
        expect(nugetPackagesDir({ NUGET_PACKAGES: join(dir, 'missing') }, home)).toBeNull();
        writeFileSync(join(dir, 'file'), '');
        expect(nugetPackagesDir({ NUGET_PACKAGES: join(dir, 'file') }, home)).toBeNull();
    });
});
describe('dotnetSandboxEnv', () => {
    it('win32: APPDATA in the job profile, the packages folder named and granted read-only', () => {
        const home = join(dir, 'home');
        mkdirSync(join(home, '.nuget', 'packages'), { recursive: true });
        const profile = join(dir, 'job', 'profile');
        const out = dotnetSandboxEnv(profile, { APPDATA: join(home, 'AppData', 'Roaming') }, home, 'win32');
        expect(out.env.APPDATA).toBe(join(profile, 'AppData', 'Roaming'));
        expect(out.env.NUGET_PACKAGES).toBe(join(home, '.nuget', 'packages'));
        expect(out.readonly).toEqual([join(home, '.nuget', 'packages')]);
        expect(out.env).toMatchObject({ UseSharedCompilation: 'false', EnableSourceControlManagerQueries: 'false', MSBUILDDISABLENODEREUSE: '1', DOTNET_CLI_USE_MSBUILD_SERVER: '0', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' });
        // Nothing of the real %APPDATA% (NuGet.Config, which can hold feed credentials) is named.
        expect(JSON.stringify(out)).not.toContain(JSON.stringify(join(home, 'AppData')).slice(1, -1));
    });
    it('elsewhere: no APPDATA; no packages folder, no grant', () => {
        const out = dotnetSandboxEnv(join(dir, 'profile'), {}, join(dir, 'home'), 'linux');
        expect(out.env.APPDATA).toBeUndefined();
        expect(out.env.NUGET_PACKAGES).toBeUndefined();
        expect(out.readonly).toEqual([]);
    });
});
//# sourceMappingURL=dotnet-sandbox.test.js.map