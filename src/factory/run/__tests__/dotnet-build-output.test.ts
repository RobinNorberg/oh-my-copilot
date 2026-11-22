/**
 * cleanDotnetBuildOutput (dotnet-clean.ts), the logic of the step the engine
 * runs in the OS sandbox before a dotnet gate. Every test works in its own
 * temp dir, and every link target ("outside") is a sibling of the checkout
 * inside that temp dir, checked after the removal: a bug that followed a link
 * can only reach files the test created. That the sandbox denies a delete
 * through a link swapped in mid-walk is shown by the live test
 * (dotnet-gate.live.test.ts) with the real sandbox.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanDotnetBuildOutput, DOTNET_BUILD_DIRS } from '../dotnet-clean.js';
import { DOTNET_BUILD_DIRS as GATE_BUILD_DIRS, dotnetBuildDirIndex, inPackageTree, isDotnetDefinitionFile, isDotnetProjectFile, strayDotnetDefinitionFiles, trackedPackageTreeProjects, underDotnetBuildDir } from '../local-gate.js';

let dir: string;
let checkout: string;
let outside: string;
const links: string[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omg-dotnet-out-'));
  checkout = join(dir, 'checkout');
  outside = join(dir, 'outside');
  mkdirSync(checkout);
  mkdirSync(join(outside, 'obj'), { recursive: true });
  writeFileSync(join(outside, 'keep.txt'), 'outside');
  writeFileSync(join(outside, 'obj', 'x.props'), 'outside');
  git('init', '-q');
});
afterEach(() => {
  // Links first, never followed, then the temp dir.
  for (const l of links.splice(0)) { try { if (lstatSync(l).isSymbolicLink()) unlinkSync(l); } catch { /* gone */ } }
  rmSync(dir, { recursive: true, force: true });
});

function git(...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'core.autocrlf=false', ...args], { cwd: checkout, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
function put(rel: string, text = 'x'): void {
  mkdirSync(dirname(join(checkout, rel)), { recursive: true });
  writeFileSync(join(checkout, rel), text);
}
/** A dir link at `rel` in the checkout to `target` (a junction on Windows: no privilege needed). */
function link(target: string, rel: string): void {
  mkdirSync(dirname(join(checkout, rel)), { recursive: true });
  symlinkSync(target, join(checkout, rel), process.platform === 'win32' ? 'junction' : 'dir');
  links.push(join(checkout, rel));
}
/** The engine's inputs (readGateCheckout): every untracked path (ignored or not), and the tracked paths under a build dir. */
const untracked = (): string[] => git('ls-files', '--others', '-z').split('\0').filter(Boolean);
const kept = (): string[] => git('ls-files', '-z').split('\0').filter((p) => p && dotnetBuildDirIndex(p) >= 0);
const leftUnder = (): string[] => untracked().filter((p) => dotnetBuildDirIndex(p) >= 0);
const exists = (rel: string): boolean => { try { lstatSync(join(checkout, rel)); return true; } catch { return false; } };
const outsideIntact = (): void => {
  expect(readdirSync(outside).sort()).toEqual(['keep.txt', 'obj']);
  expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('outside');
  expect(existsSync(join(outside, 'obj', 'x.props'))).toBe(true);
};
const base = (): void => {
  put('src/App/App.csproj');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
};

describe('cleanDotnetBuildOutput', () => {
  it('the step and the gate checks name the same build dirs', () => {
    expect([...DOTNET_BUILD_DIRS]).toEqual([...GATE_BUILD_DIRS]);
  });

  it('empties bin/, obj/ and artifacts/ (any case, artifacts layout) but the tracked files; everything else stays', () => {
    writeFileSync(join(checkout, '.gitignore'), 'bin/\nobj/\nartifacts/\n');
    put('src/App/App.csproj');
    put('src/App/bin/tracked.txt');
    git('add', '-f', '.');
    git('commit', '-q', '-m', 'base');
    put('src/App/obj/App.csproj.nuget.g.targets', '<Project><PropertyGroup><IsTestProject>false</IsTestProject></PropertyGroup></Project>');
    put('src/App/obj/Debug/net10.0/App.dll');
    put('src/App/bin/Debug/net10.0/App.dll');
    put('src/Lib/OBJ/project.assets.json');
    put('artifacts/obj/App/App.csproj.nuget.g.props');
    put('artifacts/bin/App/debug/App.dll');
    put('src/App/Notes.cs');
    put('node_modules/pkg/bin/cli.js');
    put('src/App/objx/keep.txt');
    const r = cleanDotnetBuildOutput(checkout, kept());
    expect(r.errors).toEqual([]);
    expect(r.removed).toBe(4);
    for (const gone of ['src/App/obj', 'src/App/bin/Debug', 'src/Lib/OBJ', 'artifacts']) expect(exists(gone), gone).toBe(false);
    for (const stay of ['src/App/bin/tracked.txt', 'src/App/App.csproj', 'src/App/Notes.cs', 'node_modules/pkg/bin/cli.js', 'src/App/objx/keep.txt']) expect(exists(stay), stay).toBe(true);
    expect(git('status', '--porcelain')).not.toMatch(/tracked\.txt/);
    expect(leftUnder()).toEqual([]);
  });

  it('H1: a git repository initialised in obj/, bin/ or artifacts/ goes with what it hid from git ls-files', () => {
    base();
    for (const d of ['src/App/obj', 'src/App/bin', 'artifacts']) {
      put(`${d}/Debug/stale.dll`, 'stale');
      spawnSync('git', ['init', '-q'], { cwd: join(checkout, d) });
    }
    put('src/App/obj/App.csproj.nuget.g.targets');
    put('src/App/obj/Evil.props');
    // What the reviewer saw: only the dirs are listed, nothing under them.
    expect(untracked().sort()).toEqual(['artifacts/', 'src/App/bin/', 'src/App/obj/']);
    expect(cleanDotnetBuildOutput(checkout, kept()).errors).toEqual([]);
    for (const d of ['src/App/obj', 'src/App/bin', 'artifacts']) expect(exists(d), d).toBe(false);
    expect(untracked()).toEqual([]);
  });

  it('a nested repository outside the build dirs is not entered (the engine parks on it)', () => {
    base();
    put('vendor/lib/obj/stale.dll');
    spawnSync('git', ['init', '-q'], { cwd: join(checkout, 'vendor', 'lib') });
    cleanDotnetBuildOutput(checkout, kept());
    expect(exists('vendor/lib/obj/stale.dll')).toBe(true);
  });

  it('H2: an obj/ that is a junction or symlink to a dir outside the checkout is unlinked; the target survives', () => {
    base();
    link(outside, 'src/App/obj');
    const listed = untracked();
    // Windows git lists the junction's content, POSIX git the link itself.
    expect(listed.some((p) => p === 'src/App/obj' || p.startsWith('src/App/obj/'))).toBe(true);
    const r = cleanDotnetBuildOutput(checkout, kept());
    expect(r).toEqual({ removed: 1, errors: [] });
    expect(exists('src/App/obj')).toBe(false);
    expect(exists('src/App/App.csproj')).toBe(true);
    outsideIntact();
  });

  it('a link inside bin/ is unlinked itself; a link outside the build dirs is left alone and not walked through', () => {
    base();
    put('src/App/bin/Debug/App.dll');
    link(outside, 'src/App/bin/Debug/linked');
    // The outside dir holds an obj/: reached only through the link, it is never touched.
    link(outside, 'src/Other');
    expect(cleanDotnetBuildOutput(checkout, kept()).errors).toEqual([]);
    expect(exists('src/App/bin')).toBe(false);
    expect(lstatSync(join(checkout, 'src', 'Other')).isSymbolicLink()).toBe(true);
    outsideIntact();
  });

  it('a node_modules reached through a junction is never walked: the obj/ in its target stays', () => {
    base();
    link(outside, 'node_modules');
    link(outside, 'src/App/node_modules');
    expect(cleanDotnetBuildOutput(checkout, kept())).toEqual({ removed: 0, errors: [] });
    outsideIntact();
  });

  it('a hard link under obj/ goes as a name only: the other name outside keeps the content', () => {
    base();
    mkdirSync(join(checkout, 'src', 'App', 'obj'), { recursive: true });
    linkSync(join(outside, 'keep.txt'), join(checkout, 'src', 'App', 'obj', 'hard.txt'));
    expect(cleanDotnetBuildOutput(checkout, kept()).errors).toEqual([]);
    expect(exists('src/App/obj')).toBe(false);
    outsideIntact();
  });

  it('a plain untracked file named obj or bin goes too (the engine\'s check would park on it); a tracked one stays', () => {
    put('src/bin', 'tracked file');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    put('src/obj', 'a file');
    expect(kept()).toEqual(['src/bin']);
    expect(cleanDotnetBuildOutput(checkout, kept())).toEqual({ removed: 1, errors: [] });
    expect(exists('src/obj')).toBe(false);
    expect(exists('src/bin')).toBe(true);
  });

  it.runIf(process.platform === 'win32')('Windows: a kept path matches in any case', () => {
    put('src/App/Bin/Tracked.txt');
    git('add', '-f', '.');
    git('commit', '-q', '-m', 'base');
    put('src/App/bin/stale.dll');
    expect(cleanDotnetBuildOutput(checkout, ['src/app/bin/tracked.txt'], 'win32').errors).toEqual([]);
    expect(exists('src/App/Bin/Tracked.txt')).toBe(true);
    expect(exists('src/App/Bin/stale.dll')).toBe(false);
  });
});

describe('node_modules dirs are package trees, whoever installed them (review of #606: the segment exemption)', () => {
  it('a mixed repo: a nested node_modules a prepare build or npm ci made (bin/ dirs, a junction-backed package, *.props / *.vcxproj / *.sln files) is neither cleaned nor checked', () => {
    writeFileSync(join(checkout, '.gitignore'), 'bin/\nobj/\nnode_modules/\n');
    put('src/Web/Web.csproj');
    put('src/Web/ClientApp/package.json', '{}');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    put('src/Web/ClientApp/node_modules/vite/bin/vite.js', 'vite');
    put('src/Web/ClientApp/node_modules/addon/build/addon.vcxproj');
    put('src/Web/ClientApp/node_modules/addon/build/config.props');
    put('src/Web/ClientApp/node_modules/addon/build/binding.sln');
    put('src/Web/ClientApp/node_modules/addon/obj/x.txt');
    mkdirSync(join(outside, 'esbuild', 'bin'), { recursive: true });
    writeFileSync(join(outside, 'esbuild', 'bin', 'esbuild'), 'outside');
    link(join(outside, 'esbuild'), 'src/Web/ClientApp/node_modules/esbuild');
    // A differently cased package tree: the same predicate on both sides, on every platform.
    put('tools/Node_Modules/pkg/bin/cli.js');
    put('src/Web/obj/stale.dll');
    const before = untracked();
    // Git for Windows lists files through the junction-backed package dir; the checks leave them out all the same.
    expect(leftUnder()).toEqual(['src/Web/obj/stale.dll']);
    expect(strayDotnetDefinitionFiles(before)).toEqual([]);
    expect(cleanDotnetBuildOutput(checkout, kept())).toEqual({ removed: 1, errors: [] });
    for (const stay of ['src/Web/ClientApp/node_modules/vite/bin/vite.js', 'src/Web/ClientApp/node_modules/addon/obj/x.txt', 'src/Web/ClientApp/node_modules/addon/build/addon.vcxproj', 'tools/Node_Modules/pkg/bin/cli.js']) expect(exists(stay), stay).toBe(true);
    expect(lstatSync(join(checkout, 'src', 'Web', 'ClientApp', 'node_modules', 'esbuild')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, 'esbuild', 'bin', 'esbuild'), 'utf8')).toBe('outside');
    expect(exists('src/Web/obj')).toBe(false);
    expect(leftUnder()).toEqual([]);
    expect(strayDotnetDefinitionFiles(untracked())).toEqual([]);
  });

  it('a node_modules inside a build dir is build output: it goes, and the checks see it', () => {
    base();
    put('src/App/obj/node_modules/x.txt');
    link(outside, 'src/App/bin/node_modules');
    expect(dotnetBuildDirIndex('src/App/obj/node_modules/x.txt')).toBe(2);
    expect(cleanDotnetBuildOutput(checkout, kept()).errors).toEqual([]);
    for (const gone of ['src/App/obj', 'src/App/bin']) expect(exists(gone), gone).toBe(false);
    outsideIntact();
  });

  it('a junctioned root node_modules (the engine\'s link to yours) is never walked or removed', () => {
    base();
    mkdirSync(join(outside, 'pkg', 'bin'), { recursive: true });
    writeFileSync(join(outside, 'pkg', 'bin', 'cli.js'), 'outside');
    link(outside, 'node_modules');
    expect(cleanDotnetBuildOutput(checkout, kept())).toEqual({ removed: 0, errors: [] });
    expect(lstatSync(join(checkout, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, 'pkg', 'bin', 'cli.js'), 'utf8')).toBe('outside');
  });

  it('trackedPackageTreeProjects: the .NET definition files a head tracks under a node_modules dir (a park), not under a build dir', () => {
    expect(trackedPackageTreeProjects([
      'x/node_modules/App/App.csproj', 'node_modules/pkg/Directory.Build.props', 'A/NODE_MODULES/b.sln',
      'src/App/App.csproj', 'node_modules/pkg/README.md', 'src/App/obj/node_modules/c.csproj',
    ])).toEqual(['x/node_modules/App/App.csproj', 'node_modules/pkg/Directory.Build.props', 'A/NODE_MODULES/b.sln']);
  });
});

describe('the .NET path rules', () => {
  it('underDotnetBuildDir: a path under bin/, obj/ or artifacts/ at any depth, in any case, not under node_modules; not a file so named', () => {
    for (const p of ['src/App/obj/project.assets.json', 'bin/Tests.dll', 'a/ARTIFACTS/x', 'src/obj/node_modules/x']) expect(underDotnetBuildDir(p), p).toBe(true);
    for (const p of ['src/bin', 'src/objx/a', 'src/App/App.csproj', 'a/../obj/x', 'node_modules/pkg/bin/cli.js', 'a/Node_Modules/b/obj/c']) expect(underDotnetBuildDir(p), p).toBe(false);
    for (const p of ['node_modules/x', 'a/NODE_MODULES/b/obj/c', 'a/node_modules/']) expect(inPackageTree(p), p).toBe(true);
    for (const p of ['a/obj/node_modules/x', 'src/App/App.csproj', 'node_modulesx/a']) expect(inPackageTree(p), p).toBe(false);
  });

  it('isDotnetProjectFile (detecting a .NET run): solutions and C#, F#, VB project files only, as Windows opens the name', () => {
    for (const p of ['App.sln', 'src/App.slnx', 'src/App/App.csproj', 'x/Y.FSPROJ', 'a/B.vbproj', 'src/App/App.csproj::$DATA']) expect(isDotnetProjectFile(p), p).toBe(true);
    for (const p of ['package.json', 'App.slnf', 'Directory.Build.props', 'App.csproj.user', 'proj', 'build.proj', 'ios/App.xcodeproj/project.pbxproj', 'windows/App/App.vcxproj', 'x/pkg.pyproj', 'App.esproj', 'db.sqlproj']) expect(isDotnetProjectFile(p), p).toBe(false);
  });

  it('the gate definition still pins every *.*proj: the two lists have different jobs', () => {
    for (const p of ['windows/App/App.vcxproj', 'build.proj', 'App.esproj', 'App.csproj']) expect(isDotnetDefinitionFile(p), p).toBe(true);
  });
});
