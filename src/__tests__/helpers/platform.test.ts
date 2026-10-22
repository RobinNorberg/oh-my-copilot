import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { pathToFileURL } from 'url';
import {
  IS_WIN,
  canCreateJunctions,
  canCreateSymlinks,
  hasExecutable,
  posixOnly,
  removeTempDir,
  requiresExecutable,
  requiresSymlinks,
  scaleTiming,
  toFileUrl,
  toPosix,
} from './platform.js';

describe('platform test helpers', () => {
  const originalPath = process.env.PATH;
  const directories: string[] = [];

  afterEach(() => {
    process.env.PATH = originalPath;
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function binDir(...segments: string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'omc-platform-helper-'));
    directories.push(root);
    const dir = join(root, ...segments);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function writeExecutable(dir: string, name: string): string {
    const file = join(dir, name);
    writeFileSync(file, IS_WIN ? '@echo off\r\n' : '#!/bin/sh\n');
    if (!IS_WIN) chmodSync(file, 0o755);
    return file;
  }

  it('reports the host platform', () => {
    expect(IS_WIN).toBe(process.platform === 'win32');
    expect(posixOnly('reason')).toBe(IS_WIN);
  });

  it('scales wall-clock ceilings only on Windows', () => {
    expect(scaleTiming(500)).toBe(IS_WIN ? 2000 : 500);
  });

  it('normalizes separators and builds file URLs', () => {
    expect(toPosix('a\\b\\c')).toBe('a/b/c');
    expect(toPosix('a/b')).toBe('a/b');
    const path = join(tmpdir(), 'some file.txt');
    expect(toFileUrl(path)).toBe(pathToFileURL(path).href);
    expect(toFileUrl(path)).toMatch(/^file:\/\/\//);
  });

  it('removes a temp tree while a child process still has its cwd inside it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omc-platform-helper-'));
    directories.push(root);
    const cwd = join(root, 'project');
    mkdirSync(cwd);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { cwd, stdio: 'ignore' });
    const exited = new Promise(resolve => child.once('exit', resolve));
    await new Promise(resolve => child.once('spawn', resolve));

    try {
      await removeTempDir(root);
      expect(existsSync(root)).toBe(false);
    } finally {
      child.kill();
      await exited;
    }
  });

  it('caches symlink and junction probes', () => {
    const symlinks = canCreateSymlinks();
    expect(canCreateSymlinks()).toBe(symlinks);
    expect(requiresSymlinks()).toBe(!symlinks);
    if (!IS_WIN) expect(symlinks).toBe(true);
    // Junctions need no privilege on Windows and fall back to dir symlinks elsewhere.
    expect(canCreateJunctions()).toBe(true);
  });

  it('finds an executable on PATH and misses an unknown one', () => {
    const dir = binDir('bin');
    writeExecutable(dir, IS_WIN ? 'omc-probe-tool.cmd' : 'omc-probe-tool');
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`;

    expect(hasExecutable('omc-probe-tool')).toBe(true);
    expect(requiresExecutable('omc-probe-tool')).toBe(false);
    expect(hasExecutable('omc-probe-tool-missing-7f3a')).toBe(false);
    expect(requiresExecutable('omc-probe-tool-missing-7f3a')).toBe(true);
  });

  it.skipIf(IS_WIN)('ignores a non-executable file on POSIX', () => {
    const dir = binDir('bin');
    writeFileSync(join(dir, 'omc-probe-plain'), '');
    process.env.PATH = dir;
    expect(hasExecutable('omc-probe-plain')).toBe(false);
  });

  it('resolves an absolute path directly, ignoring PATH', () => {
    const dir = binDir('abs');
    const file = writeExecutable(dir, IS_WIN ? 'omc-abs-tool.cmd' : 'omc-abs-tool');
    process.env.PATH = '';

    expect(hasExecutable(file)).toBe(true);
    expect(hasExecutable(join(dir, 'omc-abs-missing'))).toBe(false);
  });

  it.skipIf(!IS_WIN)('tries PATHEXT after a dotted name that is not itself executable (win32 only)', () => {
    const dir = binDir('bin');
    writeExecutable(dir, 'omc-tool.v2.exe');
    process.env.PATH = dir;

    expect(hasExecutable('omc-tool.v2')).toBe(true);
    expect(hasExecutable(join(dir, 'omc-tool.v2'))).toBe(true);
    expect(hasExecutable('omc-tool.v3')).toBe(false);
  });

  it('returns false instead of throwing when the temp dir is unwritable', async () => {
    vi.resetModules();
    vi.doMock('fs', async importOriginal => ({
      ...(await importOriginal<typeof import('fs')>()),
      mkdtempSync: () => { throw new Error('EACCES'); },
    }));
    try {
      const fresh = await import('./platform.js');
      expect(fresh.canCreateSymlinks()).toBe(false);
      expect(fresh.canCreateJunctions()).toBe(false);
    } finally {
      vi.doUnmock('fs');
      vi.resetModules();
    }
  });

  it.skipIf(!IS_WIN)('treats the WindowsApps python Store stub as absent (win32 only)', () => {
    const stubDir = binDir('Microsoft', 'WindowsApps');
    writeExecutable(stubDir, 'python3.exe');
    writeExecutable(stubDir, 'winget.exe');
    process.env.PATH = stubDir;

    expect(hasExecutable('python3')).toBe(false);
    expect(hasExecutable('winget')).toBe(true);
  });
});
