import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { defaultExec } from '../exec.js';
import { resolveBareExe } from '../../utils/windows-search.js';

const win = process.platform === 'win32';

describe.skipIf(!win)('bare executable resolution refuses a cwd plant on any Node version', () => {
  let root: string;
  let bin: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'omg-plant-'));
    bin = join(root, 'bin');
    mkdirSync(bin);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('runs the PATH git, not a git.exe planted in the cwd', () => {
    // node.exe renamed git.exe: if it ran, `--version` would print a node version.
    copyFileSync(process.execPath, join(root, 'git.exe'));
    const result = defaultExec('git', ['--version'], { cwd: root });
    expect(result.stdout).toMatch(/^git version /);
  });

  it('searches only absolute PATH entries and skips .cmd/.bat', () => {
    writeFileSync(join(bin, 'tool.cmd'), '@echo off\r\n');
    writeFileSync(join(root, 'tool.exe'), '');
    expect(resolveBareExe('tool', { PATH: `.;;${bin}`, PATHEXT: '.EXE;.CMD' })).toBeNull();
    writeFileSync(join(bin, 'tool.exe'), '');
    expect(resolveBareExe('tool', { PATH: `.;;${bin}`, PATHEXT: '.CMD;.EXE' })?.toLowerCase()).toBe(join(bin, 'tool.exe').toLowerCase());
  });

  it('leaves a name that already has a path alone', () => {
    expect(resolveBareExe('C:\\x\\git.exe')).toBe('C:\\x\\git.exe');
  });
});
