import { describe, expect, it } from 'vitest';
import { classifyNugetFailure, dotnetRestoreArgs, nugetRunPackagesDir } from '../nuget-restore.js';
import { join } from 'node:path';
// Lines from real sandboxed dotnet runs (.NET SDK 10.0.101, Windows), paths shortened.
const OFFLINE_DNS = [
    'C:\\work\\Greeter.sln : error NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json. [C:\\work\\Greeter.sln]',
    'C:\\work\\src\\Greeter\\Greeter.csproj : error NU1301:   No such host is known. (api.nuget.org:443) [C:\\work\\Greeter.sln]',
    '  Failed to restore C:\\work\\src\\Greeter\\Greeter.csproj (in 5,79 sec).',
].join('\n');
const OFFLINE_PROXY = "C:\\work\\src\\Greeter\\Greeter.csproj : error NU1301:   The proxy tunnel request to proxy 'http://127.0.0.1:50917/' failed with status code '403'.\" [C:\\work\\Greeter.sln]";
const AUDIT_ONLY = 'C:\\work\\src\\Greeter\\Greeter.csproj : warning NU1900: Error occurred while getting package vulnerability data: Unable to load the service index for source https://api.nuget.org/v3/index.json.\nPassed!  - Failed:     0, Passed:     2';
const COMPILE = "C:\\work\\src\\Greeter\\Greet.cs(3,20): error CS1002: ; expected [C:\\work\\src\\Greeter\\Greeter.csproj]";
describe('classifyNugetFailure', () => {
    it('reads the offline NU1301 of a gate with no network (DNS and the sandbox proxy) as a restore failure, not a private feed', () => {
        expect(classifyNugetFailure(OFFLINE_DNS)).toEqual({ kind: 'restore', codes: ['NU1301'], sources: [] });
        expect(classifyNugetFailure(OFFLINE_PROXY)).toEqual({ kind: 'restore', codes: ['NU1301'], sources: [] });
    });
    it('reads NU1100-NU1103 and the NU1300 series; never a warning or a compile error', () => {
        expect(classifyNugetFailure('a.csproj : error NU1101: Unable to find package Nope.Nope. No packages exist with this id in source(s): nuget.org')).toEqual({ kind: 'restore', codes: ['NU1101'], sources: [] });
        // A real restore with nuget.org reachable, for a version that does not exist (Windows with Visual Studio's offline source).
        const missing = [
            'C:\\work\\src\\Greeter\\Greeter.csproj : error NU1102: Unable to find package Newtonsoft.Json with version (>= 99.0.0)',
            'C:\\work\\src\\Greeter\\Greeter.csproj : error NU1102:   - Found 86 version(s) in nuget.org [ Nearest version: 13.0.4 ]',
            'C:\\work\\src\\Greeter\\Greeter.csproj : error NU1102:   - Found 1 version(s) in Microsoft Visual Studio Offline Packages [ Nearest version: 13.0.1 ]',
        ].join('\n');
        expect(classifyNugetFailure(missing)).toEqual({ kind: 'restore', codes: ['NU1102'], sources: [] });
        expect(classifyNugetFailure('a.csproj : error NU1101: Unable to find package Nope. No packages exist with this id in source(s): Microsoft Visual Studio Offline Packages, nuget.org')).toMatchObject({ kind: 'restore' });
        expect(classifyNugetFailure('a.csproj : error NU1100: Unable to resolve \'X (>= 1.0.0)\' for \'net10.0\'.').codes).toEqual(['NU1100']);
        expect(classifyNugetFailure('a.csproj : error NU1103: Unable to find a stable package X with version (>= 1.0.0)').codes).toEqual(['NU1103']);
        expect(classifyNugetFailure('a.csproj : error NU1302: You are running the restore operation with an HTTP source').codes).toEqual(['NU1302']);
        expect(classifyNugetFailure(AUDIT_ONLY)).toBeNull();
        expect(classifyNugetFailure(COMPILE)).toBeNull();
        expect(classifyNugetFailure('a.csproj : error NU1107: Version conflict detected')).toBeNull();
        expect(classifyNugetFailure(undefined)).toBeNull();
        expect(classifyNugetFailure(`${OFFLINE_DNS}\n${COMPILE}\na.csproj : error NU1101: x`).codes).toEqual(['NU1101', 'NU1301']);
    });
    it('a source other than nuget.org, a local source or a feed answering 401/403 is a private feed', () => {
        expect(classifyNugetFailure('a.csproj : error NU1301: Unable to load the service index for source https://pkgs.example.test/org/_packaging/feed/nuget/v3/index.json.')).toEqual({ kind: 'private-feed', codes: ['NU1301'], sources: ['https://pkgs.example.test/org/_packaging/feed/nuget/v3/index.json'] });
        expect(classifyNugetFailure("a.csproj : error NU1301: The local source 'D:\\feed' doesn't exist.")).toMatchObject({ kind: 'private-feed', sources: ['D:\\feed'] });
        expect(classifyNugetFailure('a.csproj : error NU1101: Unable to find package X. No packages exist with this id in source(s): MyFeed, nuget.org')).toMatchObject({ kind: 'private-feed', sources: ['MyFeed'] });
        expect(classifyNugetFailure('a.csproj : error NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json.\n  Response status code does not indicate success: 401 (Unauthorized).')).toMatchObject({ kind: 'private-feed', sources: [] });
    });
});
describe('dotnetRestoreArgs', () => {
    it('restores the gate\'s targets with its runtime and properties', () => {
        expect(dotnetRestoreArgs(['test'])).toEqual(['restore']);
        expect(dotnetRestoreArgs(['test', 'App.sln', '-c', 'Release', '--filter', 'X'])).toEqual(['restore', 'App.sln']);
        expect(dotnetRestoreArgs(['build', 'src/App', '-r', 'win-x64', '-p:NuGetAudit=false', '--', 'x'])).toEqual(['restore', 'src/App', '-r', 'win-x64', '-p:NuGetAudit=false']);
        expect(dotnetRestoreArgs(['test', '--project', 'tests/T.csproj'])).toEqual(['restore', 'tests/T.csproj']);
        expect(dotnetRestoreArgs(['build', '--solution=App.sln'])).toEqual(['restore', 'App.sln']);
    });
    it('null for a gate that runs no MSBuild', () => {
        expect(dotnetRestoreArgs(['test', 'bin/T.dll'])).toBeNull();
        expect(dotnetRestoreArgs(['run'])).toBeNull();
        expect(dotnetRestoreArgs([])).toBeNull();
    });
});
describe('nugetRunPackagesDir', () => {
    it('lies under the gate job root, per run', () => {
        expect(nugetRunPackagesDir(join('r', 'gates'), 'issue-7')).toBe(join('r', 'gates', 'nuget', 'issue-7'));
    });
});
//# sourceMappingURL=nuget-restore.test.js.map