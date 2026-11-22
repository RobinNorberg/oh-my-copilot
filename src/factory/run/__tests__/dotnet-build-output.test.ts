/**
 * removeDotnetBuildOutput (prepare.ts): a dotnet gate starts from no leftover
 * build state. Every test works in its own temp dir, and every link target
 * ("outside") is a sibling of the checkout inside that temp dir, checked
 * after the removal: a bug that followed a link can only reach files the test
 * created.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeDotnetBuildOutput } from '../prepare.js';

let dir: string;
let checkout: string;
let outside: string;
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
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
}
/** What the engine lists: every untracked file, ignored or not. */
const untracked = (): string[] => git('ls-files', '--others', '-z').split('\0').filter(Boolean);
const exists = (rel: string): boolean => { try { lstatSync(join(checkout, rel)); return true; } catch { return false; } };
const outsideIntact = (): void => {
  expect(readdirSync(outside).sort()).toEqual(['keep.txt', 'obj']);
  expect(existsSync(join(outside, 'obj', 'x.props'))).toBe(true);
};

describe('removeDotnetBuildOutput', () => {
  it('removes untracked files under bin/, obj/ and artifacts/ (any case, artifacts layout) and the dirs it emptied; tracked files and everything else stay', () => {
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
    const removed = removeDotnetBuildOutput(checkout, untracked());
    expect(removed).toBe(6);
    for (const gone of ['src/App/obj', 'src/App/bin/Debug', 'src/Lib/OBJ', 'artifacts']) expect(exists(gone), gone).toBe(false);
    for (const kept of ['src/App/bin/tracked.txt', 'src/App/App.csproj', 'src/App/Notes.cs', 'node_modules/pkg/bin/cli.js', 'src/App/objx/keep.txt']) expect(exists(kept), kept).toBe(true);
    expect(git('status', '--porcelain')).not.toMatch(/tracked\.txt/);
  });

  it('an obj/ that is a junction or symlink to a dir outside the checkout is unlinked, never followed', () => {
    put('src/App/App.csproj');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    link(outside, 'src/App/obj');
    const listed = untracked();
    // Windows git lists the junction's content, POSIX git the link itself: both name the link's path first.
    expect(listed.some((p) => p === 'src/App/obj' || p.startsWith('src/App/obj/'))).toBe(true);
    expect(removeDotnetBuildOutput(checkout, listed)).toBe(1);
    expect(exists('src/App/obj')).toBe(false);
    expect(exists('src/App/App.csproj')).toBe(true);
    outsideIntact();
  });

  it('a link inside bin/ is unlinked itself; a link above the build dir is left alone, and nothing through it is touched', () => {
    put('src/App/App.csproj');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    put('src/App/bin/Debug/App.dll');
    link(outside, 'src/App/bin/Debug/linked');
    link(outside, 'src/Other');
    const removed = removeDotnetBuildOutput(checkout, untracked());
    expect(removed).toBe(2);
    expect(exists('src/App/bin')).toBe(false);
    expect(lstatSync(join(checkout, 'src', 'Other')).isSymbolicLink()).toBe(true);
    outsideIntact();
  });

  it('never leaves the checkout for a listed path with .., an empty or absolute segment, and leaves what is not there', () => {
    const rel = join('..', 'outside', 'obj', 'x.props').replace(/\\/g, '/');
    expect(removeDotnetBuildOutput(checkout, [rel, '../outside/keep.txt', '/obj/x', 'a//obj/x', 'missing/obj/x.props', `${outside.replace(/\\/g, '/')}/obj/x.props`])).toBe(0);
    outsideIntact();
  });

  it('a plain file named obj or bin is not build output; a path through a file stops there', () => {
    put('src/obj', 'a file');
    put('src/bin', 'a file');
    expect(removeDotnetBuildOutput(checkout, ['src/obj', 'src/bin', 'src/obj/x'])).toBe(0);
    expect(exists('src/obj') && exists('src/bin')).toBe(true);
  });
});
