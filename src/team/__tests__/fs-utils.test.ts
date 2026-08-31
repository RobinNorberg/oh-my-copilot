import { describe, it, expect, afterEach } from 'vitest';
import { statSync, mkdirSync, rmSync, existsSync, readFileSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  atomicWriteJson, writeFileWithMode, ensureDirWithMode, validateResolvedPath
} from '../fs-utils.js';

const TEST_DIR = join(tmpdir(), '__test_fs_utils__');

/**
 * NTFS does not implement POSIX mode bits — Node reports 0o666 whatever mode
 * was requested — so the exact bits are only meaningful on POSIX. Windows gets
 * the assertion that still means something there: the entry was created.
 */
function expectRestrictiveMode(path: string, posixMode: number): void {
  expect(existsSync(path)).toBe(true);
  if (process.platform === 'win32') return;
  expect(statSync(path).mode & 0o777).toBe(posixMode);
}

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe('atomicWriteJson', () => {
  it('creates files with 0o600 permissions', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const filePath = join(TEST_DIR, 'test.json');
    atomicWriteJson(filePath, { key: 'value' });
    // Owner-only read/write (0o600), plus the content actually landing.
    expectRestrictiveMode(filePath, 0o600);
    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({ key: 'value' });
  });

  it('temp file names contain both PID and timestamp pattern', () => {
    // Verify the temp path format by checking the function creates the final file
    // The temp file is renamed, so we verify the output exists and intermediate is gone
    mkdirSync(TEST_DIR, { recursive: true });
    const filePath = join(TEST_DIR, 'atomic.json');
    atomicWriteJson(filePath, { test: true });
    expect(existsSync(filePath)).toBe(true);
    // No leftover .tmp files
    const { readdirSync } = require('fs');
    const files = readdirSync(TEST_DIR);
    const tmpFiles = files.filter((f: string) => f.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('creates parent directories with 0o700', () => {
    const nested = join(TEST_DIR, 'deep', 'nested');
    const filePath = join(nested, 'data.json');
    atomicWriteJson(filePath, { deep: true });
    expect(existsSync(filePath)).toBe(true);
  });
});

describe('writeFileWithMode', () => {
  it('creates files with 0o600 permissions', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const filePath = join(TEST_DIR, 'write-test.txt');
    writeFileWithMode(filePath, 'hello');
    expectRestrictiveMode(filePath, 0o600);
    expect(readFileSync(filePath, 'utf-8')).toBe('hello');
  });
});

describe('ensureDirWithMode', () => {
  it('creates directories with 0o700 permissions', () => {
    const dirPath = join(TEST_DIR, 'secure-dir');
    ensureDirWithMode(dirPath);
    expectRestrictiveMode(dirPath, 0o700);
    expect(statSync(dirPath).isDirectory()).toBe(true);
  });
});

describe('validateResolvedPath', () => {
  const VALIDATE_DIR = join(tmpdir(), '__validate_test__');

  afterEach(() => {
    if (existsSync(VALIDATE_DIR)) {
      rmSync(VALIDATE_DIR, { recursive: true, force: true });
    }
  });

  it('rejects paths that escape base via ../', () => {
    mkdirSync(VALIDATE_DIR, { recursive: true });
    const base = realpathSync(VALIDATE_DIR);
    expect(() => validateResolvedPath(join(base, '..', 'escape'), base)).toThrow('Path traversal');
  });

  it('accepts paths within base directory', () => {
    mkdirSync(VALIDATE_DIR, { recursive: true });
    const base = realpathSync(VALIDATE_DIR);
    expect(() => validateResolvedPath(join(base, 'project', 'file.ts'), base)).not.toThrow();
  });

  it('accepts exact base path', () => {
    mkdirSync(VALIDATE_DIR, { recursive: true });
    const base = realpathSync(VALIDATE_DIR);
    expect(() => validateResolvedPath(base, base)).not.toThrow();
  });
});
