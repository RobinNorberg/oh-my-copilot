import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyNugetFailure, DEFINITION_TREE_NUGET_CONFIG, dotnetRestoreArgs, gitBlobId, missingDefinitionFile, nugetConfigUnreadableReason, nugetRunPackagesDir, nugetSubstituted, parseCatFileBatch, removeEngineDir, restoreApprovalNote, normalizeRestoreSource, restoreGraphArgs, restoreGraphSources, restoreSourcesDifference, restorePhase, writeDefinitionTree } from '../nuget-restore.js';
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
        // A compiler diagnostic means the build started: a NuGet line after it is not a restore error.
        expect(classifyNugetFailure(`${OFFLINE_DNS}\n${COMPILE}\na.csproj : error NU1101: x`).codes).toEqual(['NU1301']);
        expect(classifyNugetFailure(`${OFFLINE_DNS}\na.csproj : error NU1101: x`).codes).toEqual(['NU1101', 'NU1301']);
    });
    it('reads the restore phase only (M3): never a NuGet line the build or the tests print after their first output line', () => {
        // Real `dotnet test` output (SDK 10.0.101): the project output lines and VSTest's lines, then what a test printed.
        const testRun = [
            '  Determining projects to restore...',
            '  All projects are up-to-date for restore.',
            '  Greeter -> C:\\work\\src\\Greeter\\bin\\Debug\\net10.0\\Greeter.dll',
            '  Greeter.Tests -> C:\\work\\tests\\Greeter.Tests\\bin\\Debug\\net10.0\\Greeter.Tests.dll',
            'Test run for C:\\work\\tests\\Greeter.Tests\\bin\\Debug\\net10.0\\Greeter.Tests.dll (.NETCoreApp,Version=v10.0)',
            'VSTest version 18.0.1 (x64)',
            '',
            'Starting test execution, please wait...',
            'A total of 1 test files matched the specified pattern.',
        ].join('\n');
        const printed = 'C:\\work\\src\\Greeter\\Greeter.csproj : error NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json. [C:\\work\\Greeter.sln]';
        expect(classifyNugetFailure(`${testRun}\n${printed}\nFailed!  - Failed:     1, Passed:     1`)).toBeNull();
        expect(classifyNugetFailure(`  Greeter -> C:\\work\\src\\Greeter\\bin\\Debug\\net10.0\\Greeter.dll\n${printed}`)).toBeNull();
        expect(classifyNugetFailure(`Build succeeded.\n${printed}`)).toBeNull();
        // A line that is not MSBuild's (no project file before " : error") is never one, in any phase.
        expect(classifyNugetFailure('my test says error NU1301: nope')).toBeNull();
        expect(classifyNugetFailure('C:\\work\\Greet.cs(3,20): error NU1301: nope [C:\\work\\App.csproj]')).toBeNull();
        expect(restorePhase(`a\n${testRun}\nb`)).toBe('a\n  Determining projects to restore...\n  All projects are up-to-date for restore.\n');
    });
    it('a real partial restore failure of a solution (one project fails, MSBuild suffix) and of a project restored directly (no suffix)', () => {
        // Real `dotnet build` of a two-project solution and `dotnet restore B/B.csproj` (SDK 10.0.101, paths shortened).
        const solution = [
            '  Determining projects to restore...',
            'C:\\w\\B\\B.csproj : error NU1102: Unable to find package Newtonsoft.Json with version (>= 99.0.0) [C:\\w\\S.sln]',
            'C:\\w\\B\\B.csproj : error NU1102:   - Found 86 version(s) in nuget.org [ Nearest version: 14.0.1-beta2 ] [C:\\w\\S.sln]',
            '  Failed to restore C:\\w\\B\\B.csproj (in 542 ms).',
            '  Restored C:\\w\\A\\A.csproj (in 1,2 sec).',
            '',
            'Build FAILED.',
        ].join('\n');
        expect(classifyNugetFailure(solution)).toEqual({ kind: 'restore', codes: ['NU1102'], sources: [] });
        const direct = 'C:\\w\\B\\B.csproj : error NU1102: Unable to find package Newtonsoft.Json with version (>= 99.0.0)\n  Failed to restore C:\\w\\B\\B.csproj (in 238 ms).';
        expect(classifyNugetFailure(direct)).toEqual({ kind: 'restore', codes: ['NU1102'], sources: [] });
    });
    it('a source other than nuget.org, a local source or a feed answering 401/403 is a private feed', () => {
        expect(classifyNugetFailure('a.csproj : error NU1301: Unable to load the service index for source https://pkgs.example.test/org/_packaging/feed/nuget/v3/index.json.')).toEqual({ kind: 'private-feed', codes: ['NU1301'], sources: ['https://pkgs.example.test/org/_packaging/feed/nuget/v3/index.json'] });
        expect(classifyNugetFailure("a.csproj : error NU1301: The local source 'D:\\feed' doesn't exist.")).toMatchObject({ kind: 'private-feed', sources: ['D:\\feed'] });
        expect(classifyNugetFailure('a.csproj : error NU1101: Unable to find package X. No packages exist with this id in source(s): MyFeed, nuget.org')).toMatchObject({ kind: 'private-feed', sources: ['MyFeed'] });
        expect(classifyNugetFailure('a.csproj : error NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json.\n  Response status code does not indicate success: 401 (Unauthorized).')).toMatchObject({ kind: 'private-feed', sources: [] });
    });
});
describe('classifyNugetFailure: a NuGet config it could not read (config-unreadable)', () => {
    // As the Windows sandbox printed it (.NET SDK 10.0.101) when the walk up from a checkout under <repo>/.omg reached the repository's own file.
    const DENIED = [
        "C:\\Program Files\\dotnet\\sdk\\10.0.101\\NuGet.targets(780,5): error : Failed to read NuGet.Config due to unauthorized access. Path: 'C:\\repo\\NuGet.Config'. [C:\\repo\\.omg\\team\\t\\worktrees\\w\\App\\App.csproj]",
        "C:\\Program Files\\dotnet\\sdk\\10.0.101\\NuGet.targets(780,5): error :   Access to the path 'C:\\repo\\NuGet.Config' is denied. [C:\\repo\\.omg\\team\\t\\worktrees\\w\\App\\App.csproj]",
        'Build FAILED.',
    ].join('\n');
    it('has its own kind with the paths, no NU code, and wins over NU codes beside it', () => {
        expect(classifyNugetFailure(DENIED)).toEqual({ kind: 'config-unreadable', codes: [], sources: ['C:\\repo\\NuGet.Config'] });
        const invalid = "/usr/share/dotnet/sdk/10.0.101/NuGet.targets(780,5): error : NuGet.Config is not valid XML. Path: '/home/u/repo/nuget.config'.";
        expect(classifyNugetFailure(invalid)).toEqual({ kind: 'config-unreadable', codes: [], sources: ['/home/u/repo/nuget.config'] });
        expect(classifyNugetFailure(`${DENIED}\na.csproj : error NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json.`).kind).toBe('config-unreadable');
    });
    it('only in the restore phase, and only as an MSBuild error line (anchored as NU errors: a project, solution or MSBuild file)', () => {
        expect(classifyNugetFailure(`  App -> C:\\w\\App.dll\n${DENIED}`)).toBeNull();
        expect(classifyNugetFailure("  Failed to read NuGet.Config due to unauthorized access. Path: 'C:\\repo\\NuGet.Config'.")).toBeNull();
        // L5: a test or tool printing the words on a line of its own shape is no config failure.
        expect(classifyNugetFailure("Program.cs says error : Failed to read NuGet.Config due to unauthorized access. Path: 'C:\\x'.")).toBeNull();
        expect(classifyNugetFailure("[xunit] error : Failed to read NuGet.Config due to unauthorized access. Path: 'C:\\x'.")).toBeNull();
    });
    it('M3: the MSBuild project SDK resolver failure (real sandbox output) carries the SDK names', () => {
        const p = 'C:\\repo\\.omg\\team\\factory-run\\worktrees\\issue-1\\A\\A.proj';
        const out = [
            `${p} : error : Could not resolve SDK "Microsoft.Build.NoTargets". Exactly one of the probing messages below indicates why we could not resolve the SDK. Investigate and resolve that message to correctly specify the SDK.`,
            `${p} : error :   SDK resolver "Microsoft.DotNet.MSBuildWorkloadSdkResolver" returned null.`,
            `${p} : error :   Failed to load NuGet settings. Failed to read NuGet.Config due to unauthorized access. Path: 'C:\\repo\\NuGet.Config'.`,
            `${p} : error MSB4236: The SDK 'Microsoft.Build.NoTargets/3.7.56' specified could not be found.`,
        ].join('\n');
        expect(classifyNugetFailure(out)).toEqual({ kind: 'config-unreadable', codes: [], sources: ['C:\\repo\\NuGet.Config'], sdks: ['Microsoft.Build.NoTargets'] });
        const why = nugetConfigUnreadableReason(['C:\\repo\\NuGet.Config'], null, ['Microsoft.Build.NoTargets']);
        expect(why).toContain('MSBuild project SDKs resolved from NuGet (Microsoft.Build.NoTargets)');
        expect(why).toContain('ignores RestoreConfigFile');
        expect(why).toContain('factory.run.layout "private"');
    });
    it('the park reason names the file (no doubled backslashes) and what to do, for one config and for NuGet\'s own hierarchy', () => {
        const one = nugetConfigUnreadableReason(['C:\\repo\\NuGet.Config'], null);
        expect(one).toContain('"C:\\repo\\NuGet.Config"');
        expect(one).not.toContain('\\\\');
        expect(one).toContain('says nothing about the code');
        expect(one).toContain('the root nuget.config of its checkout');
        const walk = nugetConfigUnreadableReason(['C:\\repo\\NuGet.Config'], 'the repository pins a nuget.config below its root (src/nuget.config)');
        expect(walk).toContain('pins a nuget.config below its root (src/nuget.config)');
        expect(walk).toContain('factory.run.layout "private"');
    });
    it('the tree stub is the same nuget.org-only file a checkout without a root config reads', () => {
        expect(DEFINITION_TREE_NUGET_CONFIG).toContain('<add key="nuget.org" value="https://api.nuget.org/v3/index.json"');
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
    it('null for a gate that runs no MSBuild or names a target outside the repository (the tree holds only repository files)', () => {
        expect(dotnetRestoreArgs(['test', 'C:\\elsewhere\\App.sln'])).toBeNull();
        expect(dotnetRestoreArgs(['build', '../other/App.csproj'])).toBeNull();
        expect(dotnetRestoreArgs(['test', '--project', '/abs/T.csproj'])).toBeNull();
        expect(dotnetRestoreArgs(['test', 'bin/T.dll'])).toBeNull();
        expect(dotnetRestoreArgs(['run'])).toBeNull();
        expect(dotnetRestoreArgs([])).toBeNull();
    });
});
describe('restoreApprovalNote (the gate-definition-changed park with gateInstall "sandboxed")', () => {
    it('every platform: the approval lets the engine restore the files with api.nuget.org reachable, and their MSBuild targets run in that restore', () => {
        const both = '. With factory.run.gateInstall "sandboxed", approving with --allow-gate-change also lets the engine run dotnet restore on these definition files with api.nuget.org reachable, and the MSBuild targets in these files run during that restore';
        for (const p of ['win32', 'linux', 'darwin'])
            expect(restoreApprovalNote(p).startsWith(both), p).toBe(true);
    });
    it('Windows also names loopback and the local network; Linux and macOS do not', () => {
        expect(restoreApprovalNote('win32').endsWith('api.nuget.org reachable, and the MSBuild targets in these files run during that restore; on Windows loopback and your local network are reachable from it too')).toBe(true);
        for (const p of ['linux', 'darwin']) {
            expect(restoreApprovalNote(p).endsWith('api.nuget.org reachable, and the MSBuild targets in these files run during that restore'), p).toBe(true);
            expect(restoreApprovalNote(p), p).not.toMatch(/loopback|local network/);
        }
    });
});
describe('nugetRunPackagesDir', () => {
    it('lies under the gate job root, per run', () => {
        expect(nugetRunPackagesDir(join('r', 'gates'), 'issue-7')).toBe(join('r', 'gates', 'nuget', 'issue-7'));
    });
});
describe('writeDefinitionTree', () => {
    let tmp;
    afterEach(() => rmSync(tmp, { recursive: true, force: true }));
    const blob = (text) => Buffer.from(text, 'utf8');
    const id = (text) => gitBlobId(blob(text), 40);
    const store = (texts) => {
        const m = new Map(texts.map((t) => [id(t), blob(t)]));
        return (oids) => new Map(oids.filter((o) => m.has(o)).map((o) => [o, m.get(o)]));
    };
    it('writes only the pinned definition files at their paths, from blobs checked against their ids; a gitlink is skipped', () => {
        tmp = mkdtempSync(join(tmpdir(), 'omg-deftree-'));
        const proj = '<Project Sdk="Microsoft.NET.Sdk" />\n';
        const props = '<Project>\n  <Import Project="build/common.msbuild" />\n</Project>\n';
        const entries = [
            ['App.sln', id('sln\n'), '100644'], ['Directory.Build.props', id(props), '100644'], ['src/App/App.csproj', id(proj), '100755'],
            ['build/common.msbuild', id('<Project />\n'), '100644'], ['build/Hello.cs', id('class X {}\n'), '100644'], ['tools/Tasks.dll', id('MZ'), '100644'],
            ['src/App/Program.cs', id('x'), '100644'], ['vendor/lib.csproj', '1'.repeat(40), '160000'],
        ];
        const dir = join(tmp, 'tree');
        const r = writeDefinitionTree(dir, entries, store(['sln\n', props, proj, '<Project />\n', 'class X {}\n', 'MZ', 'x']));
        expect(r).toEqual({ files: ['App.sln', 'Directory.Build.props', 'src/App/App.csproj'], stubs: ['Directory.Build.targets', 'Directory.Solution.props', 'Directory.Solution.targets', 'Directory.Packages.props', 'nuget.config'] });
        // The head's own root Directory.Build.props stays as it is: no stub over it.
        expect(readFileSync(join(dir, 'Directory.Build.props'), 'utf8')).toBe(props);
        expect(readFileSync(join(dir, 'src', 'App', 'App.csproj'), 'utf8')).toBe(proj);
        expect(existsSync(join(dir, 'build'))).toBe(false);
        expect(existsSync(join(dir, 'tools'))).toBe(false);
        expect(existsSync(join(dir, 'vendor'))).toBe(false);
    });
    it('a pinned symlink, a bad path, a blob that is not its object, or a case clash: a problem, and no link is made', () => {
        tmp = mkdtempSync(join(tmpdir(), 'omg-deftree-'));
        const p = '<Project />\n';
        const cases = [
            [[['Directory.Build.props', id('../../outside.props'), '120000']], /is a symbolic link/],
            [[['../evil.props', id(p), '100644']], /segment/],
            [[['a/.git/x.props', id(p), '100644']], /\.git path segment/],
            [[['a\\..\\..\\x.props', id(p), '100644']], /character Windows cannot write/],
            [[['x.props:stream', id(p), '100644']], /character Windows cannot write|symbolic/],
            [[['nul.props', id(p), '100644']], /device name/],
            [[['x.props ', id(p), '100644']], /dot or space/],
            [[['x.props', id('something else'), '100644']], /could not be read from git as that object/],
        ];
        for (const [i, [entries, why]] of cases.entries()) {
            const r = writeDefinitionTree(join(tmp, `t${i}`), entries, (oids) => {
                const m = new Map();
                for (const o of oids)
                    m.set(o, blob(p));
                return m;
            });
            expect('problem' in r && r.problem, JSON.stringify(entries)).toMatch(why);
        }
        if (process.platform === 'win32' || process.platform === 'darwin') {
            const r = writeDefinitionTree(join(tmp, 'clash'), [['A.props', id(p), '100644'], ['a.props', id(p), '100644']], store([p]));
            expect('problem' in r && r.problem).toMatch(/could not be written to the definition tree \(EEXIST\)/);
        }
    });
    it('parseCatFileBatch reads binary blobs byte for byte and skips a missing object', () => {
        const a = Buffer.from([0xef, 0xbb, 0xbf, 0x3c, 0x0a, 0x00, 0xff]);
        const buf = Buffer.concat([Buffer.from(`${gitBlobId(a, 40)} blob ${a.length}\n`), a, Buffer.from('\n'), Buffer.from(`${'2'.repeat(40)} missing\n`)]);
        const m = parseCatFileBatch(buf);
        expect([...m.keys()]).toEqual([gitBlobId(a, 40)]);
        expect(m.get(gitBlobId(a, 40)).equals(a)).toBe(true);
    });
    it('missingDefinitionFile names the file a real MSB4019 asks for, relative to the tree', () => {
        const tree = resolve('C:\\w\\tree');
        const line = `${join(tree, 'Directory.Build.props')}(2,3): error MSB4019: The imported project "${join(tree, 'build', 'common.msbuild')}" was not found. Confirm that the expression in the Import declaration "$(MSBuildThisFileDirectory)build/common.msbuild", which evaluated to "${tree}\\build/common.msbuild", is correct, and that the file exists on disk. [${join(tree, 'App', 'App.csproj')}]`;
        expect(missingDefinitionFile(line, tree)).toBe('build/common.msbuild');
        expect(missingDefinitionFile('error NU1101: x', tree)).toBeUndefined();
    });
    it('missingDefinitionFile: a path outside the tree comes back as one visible, quoted, bounded line (it is restore output)', () => {
        const tree = resolve('C:\\w\\tree');
        const outside = `C:\\elsewhere\\x\u202Eevil\u0007${'a'.repeat(400)}.props`;
        const got = missingDefinitionFile(`App.csproj : error MSB4019: The imported project "${outside}" was not found.`, tree);
        expect(got.startsWith('"') && got.endsWith('"')).toBe(true);
        expect(got).toContain('<U+202E>');
        expect(got).not.toMatch(/[\u202E\u0007]/);
        expect(JSON.parse(got).length).toBeLessThanOrEqual(200);
    });
});
describe('writeDefinitionTree stubs (the walk up out of the tree)', () => {
    let tmp;
    afterEach(() => rmSync(tmp, { recursive: true, force: true }));
    const blob = (text) => Buffer.from(text, 'utf8');
    const id = (text) => gitBlobId(blob(text), 40);
    const all = (oids, texts) => new Map(texts.filter((t) => oids.includes(id(t))).map((t) => [id(t), blob(t)]));
    it('a head with none of them at its root: every stub at the root only, empty projects and a nuget.org-only config; never global.json or a .rsp', () => {
        tmp = mkdtempSync(join(tmpdir(), 'omg-defstub-'));
        const proj = '<Project Sdk="Microsoft.NET.Sdk" />\n';
        const sub = '<Project><PropertyGroup><X>1</X></PropertyGroup></Project>\n';
        const dir = join(tmp, 'tree');
        const r = writeDefinitionTree(dir, [['src/App/App.csproj', id(proj), '100644'], ['src/Directory.Build.props', id(sub), '100644'], ['src/nuget.config', id('<configuration />\n'), '100644']], (o) => all(o, [proj, sub, '<configuration />\n']));
        expect(r).toEqual({ files: ['src/App/App.csproj', 'src/Directory.Build.props', 'src/nuget.config'], stubs: ['Directory.Build.props', 'Directory.Build.targets', 'Directory.Solution.props', 'Directory.Solution.targets', 'Directory.Packages.props', 'nuget.config'] });
        for (const n of ['Directory.Build.props', 'Directory.Build.targets', 'Directory.Solution.props', 'Directory.Solution.targets', 'Directory.Packages.props'])
            expect(readFileSync(join(dir, n), 'utf8'), n).toBe('<Project />\n');
        const config = readFileSync(join(dir, 'nuget.config'), 'utf8');
        expect(config).toMatch(/<packageSources>\s*<clear \/>\s*<add key="nuget\.org" value="https:\/\/api\.nuget\.org\/v3\/index\.json" protocolVersion="3" \/>\s*<\/packageSources>/);
        expect(config).toMatch(/<disabledPackageSources>\s*<clear \/>\s*<\/disabledPackageSources>/);
        expect(config).toMatch(/<packageSourceMapping>\s*<clear \/>\s*<\/packageSourceMapping>/);
        // The head's own file in a subdir is untouched, and nothing else is made.
        expect(readFileSync(join(dir, 'src', 'Directory.Build.props'), 'utf8')).toBe(sub);
        expect(readFileSync(join(dir, 'src', 'nuget.config'), 'utf8')).toBe('<configuration />\n');
        expect(readdirSync(dir).sort()).toEqual(['Directory.Build.props', 'Directory.Build.targets', 'Directory.Packages.props', 'Directory.Solution.props', 'Directory.Solution.targets', 'nuget.config', 'src']);
        expect(existsSync(join(dir, 'global.json'))).toBe(false);
    });
    it('the head\'s own root files win: no stub over them (nuget.config in any case; an MSBuild name exactly, or a case variant on a case-insensitive file system)', () => {
        tmp = mkdtempSync(join(tmpdir(), 'omg-defstub-'));
        const texts = ['<Project><!-- head packages --></Project>\n', '<configuration><!-- head --></configuration>\n', '{ "sdk": { "version": "10.0.101" } }\n', '-p:X=1\n'];
        const dir = join(tmp, 'tree');
        const r = writeDefinitionTree(dir, [
            ['Directory.Packages.props', id(texts[0]), '100644'], ['NuGet.Config', id(texts[1]), '100644'], ['global.json', id(texts[2]), '100644'], ['Directory.Build.rsp', id(texts[3]), '100644'],
            ['directory.build.props', id(texts[0]), '100644'],
        ], (o) => all(o, texts));
        expect('files' in r).toBe(true);
        if (!('files' in r))
            return;
        expect(r.stubs).not.toContain('Directory.Packages.props');
        expect(r.stubs).not.toContain('nuget.config');
        expect(readFileSync(join(dir, 'Directory.Packages.props'), 'utf8')).toBe(texts[0]);
        expect(readFileSync(join(dir, 'NuGet.Config'), 'utf8')).toBe(texts[1]);
        expect(readFileSync(join(dir, 'global.json'), 'utf8')).toBe(texts[2]);
        expect(readFileSync(join(dir, 'Directory.Build.rsp'), 'utf8')).toBe(texts[3]);
        // `directory.build.props`: on a case-insensitive file system (Windows, macOS) MSBuild opens it as Directory.Build.props, so no stub;
        // on Linux MSBuild matches names exactly and never reads it, so the stub stops the walk there.
        if (process.platform === 'win32' || process.platform === 'darwin') {
            expect(r.stubs).not.toContain('Directory.Build.props');
            expect(readFileSync(join(dir, 'Directory.Build.props'), 'utf8')).toBe(texts[0]);
        }
        else {
            expect(r.stubs).toContain('Directory.Build.props');
        }
    });
});
describe('removeEngineDir (L1)', () => {
    let tmp;
    afterEach(() => rmSync(tmp, { recursive: true, force: true }));
    it('removes the dir and unlinks links inside it without following them; the canary outside survives', () => {
        tmp = mkdtempSync(join(tmpdir(), 'omg-rmengine-'));
        const root = join(tmp, 'gates');
        const canary = join(tmp, 'canary');
        mkdirSync(canary);
        writeFileSync(join(canary, 'keep.txt'), 'CANARY');
        const dir = join(root, 'nuget', 'issue-7');
        mkdirSync(join(dir, 'pkg'), { recursive: true });
        symlinkSync(canary, join(dir, 'pkg', 'junc'), process.platform === 'win32' ? 'junction' : 'dir');
        // A file symlink needs a privilege on Windows (EPERM there): only where it can be made.
        try {
            symlinkSync(join(canary, 'keep.txt'), join(dir, 'file-link'));
        }
        catch (error) {
            if (error.code !== 'EPERM')
                throw error;
        }
        expect(removeEngineDir(dir, root)).toBe(true);
        expect(existsSync(dir)).toBe(false);
        expect(readdirSync(canary)).toEqual(['keep.txt']);
        expect(readFileSync(join(canary, 'keep.txt'), 'utf8')).toBe('CANARY');
        expect(removeEngineDir(dir, root)).toBe(false);
    });
    it('refuses a dir that is itself a link (junction or symlink) or resolves outside the root, and leaves the target alone', () => {
        tmp = mkdtempSync(join(tmpdir(), 'omg-rmengine-'));
        const root = join(tmp, 'gates');
        const canary = join(tmp, 'canary');
        mkdirSync(join(root, 'nuget'), { recursive: true });
        mkdirSync(canary);
        writeFileSync(join(canary, 'keep.txt'), 'CANARY');
        const top = join(root, 'nuget', 'issue-8');
        symlinkSync(canary, top, process.platform === 'win32' ? 'junction' : 'dir');
        expect(() => removeEngineDir(top, root)).toThrow(/is a link or not a directory/);
        // A parent that is a link: the dir resolves outside the root.
        const parent = join(root, 'nuget-defs');
        mkdirSync(join(canary, 'issue-9'));
        symlinkSync(canary, parent, process.platform === 'win32' ? 'junction' : 'dir');
        expect(() => removeEngineDir(join(parent, 'issue-9'), root)).toThrow(/does not resolve below/);
        expect(() => removeEngineDir(root, root)).toThrow(/does not resolve below/);
        expect(readdirSync(canary).sort()).toEqual(['issue-9', 'keep.txt']);
    });
});
describe('nugetSubstituted: NU1603, a version the project names that NuGet replaced', () => {
    // As .NET SDK 10.0.101 printed it (a local feed with 13.0.1 and 13.0.3, a reference to 13.0.2).
    const NU1603 = "/r/App/App.csproj : warning NU1603: App depends on Newtonsoft.Json (>= 13.0.2) but Newtonsoft.Json 13.0.2 was not found. Newtonsoft.Json 13.0.3 was resolved instead.";
    it('is a failure of its own kind with NuGet\'s message, from the restore phase only', () => {
        expect(nugetSubstituted(`${NU1603}\n  Restored /r/App/App.csproj (in 407 ms).\n  App -> /r/App/bin/App.dll`)).toEqual({ kind: 'substituted', codes: ['NU1603'], sources: ['App depends on Newtonsoft.Json (>= 13.0.2) but Newtonsoft.Json 13.0.2 was not found. Newtonsoft.Json 13.0.3 was resolved instead.'] });
        expect(nugetSubstituted(NU1603.replace('warning', 'error'))?.kind).toBe('substituted');
        // MSBuild repeats warnings in its summary after the build started: not the restore phase.
        expect(nugetSubstituted(`  App -> /r/App/bin/App.dll\nBuild succeeded.\n${NU1603}`)).toBeNull();
        // NU1604 (an exclusive lower bound) and a floating version's restore print no NU1603.
        expect(nugetSubstituted("/r/App/App.csproj : warning NU1604: Project dependency Newtonsoft.Json (> 13.0.1 && < 14.0.0) does not contain an inclusive lower bound.")).toBeNull();
        expect(nugetSubstituted(undefined)).toBeNull();
        // classifyNugetFailure does not read it: a pass with NU1603 is no NU error.
        expect(classifyNugetFailure(NU1603)).toBeNull();
    });
});
describe('the restore-source equality check (restoreGraphArgs, normalizeRestoreSource, restoreGraphSources, restoreSourcesDifference)', () => {
    it('evaluates what the restore restores: the same target and properties, the runtime as RuntimeIdentifier, offline graph only', () => {
        expect(restoreGraphArgs(['restore', 'App.sln', '-r', 'linux-x64', '-p:Configuration=Release'])).toEqual(['msbuild', 'App.sln', '-p:RuntimeIdentifier=linux-x64', '-p:Configuration=Release', '-t:GenerateRestoreGraphFile', '-p:ExcludeRestorePackageImports=true', '-nologo']);
        expect(restoreGraphArgs(['restore', '--runtime=win-x64'])).toEqual(['msbuild', '-p:RuntimeIdentifier=win-x64', '-t:GenerateRestoreGraphFile', '-p:ExcludeRestorePackageImports=true', '-nologo']);
        expect(restoreGraphArgs(dotnetRestoreArgs(['test', 'src/App/App.csproj', '-c', 'Release']))).toEqual(['msbuild', 'src/App/App.csproj', '-t:GenerateRestoreGraphFile', '-p:ExcludeRestorePackageImports=true', '-nologo']);
    });
    it('normalises sources: URLs case-insensitively without trailing slashes, in-repository paths relative to each tree, others absolute', () => {
        expect(normalizeRestoreSource(' https://API.NuGet.org/v3/index.json/ ', 'C:\\t', 'win32')).toBe('https://api.nuget.org/v3/index.json');
        expect(normalizeRestoreSource('C:\\defs\\tree\\feed\\', 'C:\\defs\\tree', 'win32')).toBe('<repository>/feed');
        expect(normalizeRestoreSource('C:\\work\\checkout\\Feed', 'C:\\work\\checkout', 'win32')).toBe('<repository>/feed');
        expect(normalizeRestoreSource('feed', 'C:\\work\\checkout', 'win32')).toBe('<repository>/feed');
        expect(normalizeRestoreSource('C:\\corp-feed', 'C:\\work\\checkout', 'win32')).toBe('c:/corp-feed');
        expect(normalizeRestoreSource('C:\\work\\checkout-other\\feed', 'C:\\work\\checkout', 'win32')).toBe('c:/work/checkout-other/feed');
        expect(normalizeRestoreSource('/srv/Feed/', '/w/co', 'linux')).toBe('/srv/Feed');
        expect(normalizeRestoreSource('/w/co/Feed', '/w/co', 'linux')).toBe('<repository>/Feed');
        expect(normalizeRestoreSource('..', '/w/co', 'linux')).toBe('/w');
    });
    const graph = (root, projects, sep = '\\') => JSON.stringify({
        format: 1,
        projects: Object.fromEntries(Object.entries(projects).map(([p, s]) => [`${root}${sep}${p}`, { restore: { projectPath: `${root}${sep}${p}`, ...(s ? { sources: Object.fromEntries(s.map((x) => [x, {}])) } : {}) } }])),
    });
    it('reads each project\'s sources from a dgspec, keyed by the project relative to the tree', () => {
        const tree = restoreGraphSources(`\uFEFF${graph('C:\\defs\\t', { 'src\\App\\App.csproj': ['https://api.nuget.org/v3/index.json', 'C:\\defs\\t\\feed'], 'src\\Lib\\Lib.csproj': undefined })}`, 'C:\\defs\\t', 'win32');
        expect(tree).toEqual({ projects: new Map([['<repository>/src/app/app.csproj', ['<repository>/feed', 'https://api.nuget.org/v3/index.json']], ['<repository>/src/lib/lib.csproj', []]]) });
        const checkout = restoreGraphSources(graph('C:\\work\\co', { 'src\\App\\App.csproj': ['C:\\work\\co\\feed\\', 'https://api.nuget.org/v3/index.json/'], 'src\\Lib\\Lib.csproj': [] }), 'C:\\work\\co', 'win32');
        expect('projects' in tree && 'projects' in checkout && restoreSourcesDifference(tree.projects, checkout.projects)).toBeNull();
        expect(restoreGraphSources('not json', 'C:\\t', 'win32')).toEqual({ problem: 'the restore graph is not valid JSON' });
        expect(restoreGraphSources('{"format":1}', 'C:\\t', 'win32')).toEqual({ problem: 'the restore graph has no projects object' });
        expect(restoreGraphSources('{"projects":{"C:\\\\t\\\\a.csproj":{"restore":{"sources":["x"]}}}}', 'C:\\t', 'win32')).toMatchObject({ problem: expect.stringContaining('not an object') });
    });
    it('names the first project whose sources differ, or that only one graph has (K3: a corp feed set by a file only the checkout has)', () => {
        const tree = new Map([['<repository>/lib/lib.csproj', ['https://api.nuget.org/v3/index.json']], ['<repository>/z.csproj', ['a']]]);
        const corp = new Map([['<repository>/lib/lib.csproj', ['c:/corp-feed']], ['<repository>/z.csproj', ['a']]]);
        expect(restoreSourcesDifference(tree, corp)).toEqual({ project: '<repository>/lib/lib.csproj', tree: ['https://api.nuget.org/v3/index.json'], checkout: ['c:/corp-feed'] });
        expect(restoreSourcesDifference(tree, new Map([['<repository>/z.csproj', ['a']]]))).toEqual({ project: '<repository>/lib/lib.csproj', tree: ['https://api.nuget.org/v3/index.json'], checkout: null });
        expect(restoreSourcesDifference(tree, new Map([...tree, ['<repository>/z.csproj', ['a', 'b']]]))).toEqual({ project: '<repository>/z.csproj', tree: ['a'], checkout: ['a', 'b'] });
        expect(restoreSourcesDifference(new Map(), new Map())).toBeNull();
    });
});
//# sourceMappingURL=nuget-restore.test.js.map