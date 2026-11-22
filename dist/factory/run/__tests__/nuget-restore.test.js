import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyNugetFailure, dotnetRestoreArgs, gitBlobId, missingDefinitionFile, nugetRunPackagesDir, parseCatFileBatch, removeEngineDir, restorePhase, writeDefinitionTree } from '../nuget-restore.js';
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
        expect(r).toEqual({ files: ['App.sln', 'Directory.Build.props', 'src/App/App.csproj'] });
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
//# sourceMappingURL=nuget-restore.test.js.map