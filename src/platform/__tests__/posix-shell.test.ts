import { describe, it, expect, vi, afterEach } from 'vitest';
import { findPosixShell, resolvePosixCommandInvocation } from '../posix-shell.js';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn() };
});

import { existsSync } from 'fs';
const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

function normalize(value: string | null): string | null {
  return value === null ? null : value.replace(/\\/g, '/');
}

afterEach(() => {
  vi.unstubAllEnvs();
  mockExistsSync.mockReset();
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  }
});

describe('findPosixShell on Windows', () => {
  it('prefers $SHELL when it names an existing POSIX shell', () => {
    setPlatform('win32');
    vi.stubEnv('SHELL', 'D:\\Tools\\Git\\bin\\bash.exe');
    vi.stubEnv('PATH', '');
    mockExistsSync.mockImplementation((p: string) => normalize(p) === 'D:/Tools/Git/bin/bash.exe');

    expect(normalize(findPosixShell())).toBe('D:/Tools/Git/bin/bash.exe');
  });

  it('ignores a $SHELL pointing at cmd.exe and falls back to PATH', () => {
    setPlatform('win32');
    vi.stubEnv('SHELL', 'C:\\Windows\\System32\\cmd.exe');
    vi.stubEnv('PATH', 'C:\\Program Files\\Git\\bin');
    mockExistsSync.mockImplementation((p: string) => {
      const n = normalize(p);
      return n === 'C:/Windows/System32/cmd.exe' || n === 'C:/Program Files/Git/bin/bash.exe';
    });

    expect(normalize(findPosixShell())).toBe('C:/Program Files/Git/bin/bash.exe');
  });

  it('never selects the System32 WSL bash launcher', () => {
    setPlatform('win32');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.stubEnv('SHELL', '');
    vi.stubEnv('PATH', 'C:\\Windows\\System32');
    vi.stubEnv('ProgramFiles', '');
    vi.stubEnv('ProgramFiles(x86)', '');
    vi.stubEnv('LOCALAPPDATA', '');
    vi.stubEnv('SystemDrive', 'C:');
    mockExistsSync.mockImplementation((p: string) => normalize(p) === 'C:/Windows/System32/bash.exe');

    expect(findPosixShell()).toBeNull();
  });

  it('falls back to a common Git for Windows install location', () => {
    setPlatform('win32');
    vi.stubEnv('SHELL', '');
    vi.stubEnv('PATH', 'C:\\Windows\\System32');
    vi.stubEnv('ProgramFiles', 'C:\\Program Files');
    mockExistsSync.mockImplementation((p: string) => normalize(p) === 'C:/Program Files/Git/bin/bash.exe');

    expect(normalize(findPosixShell())).toBe('C:/Program Files/Git/bin/bash.exe');
  });

  it('returns null when no POSIX shell is installed', () => {
    setPlatform('win32');
    vi.stubEnv('SHELL', '');
    vi.stubEnv('PATH', 'C:\\Windows\\System32');
    vi.stubEnv('ProgramFiles', 'C:\\Program Files');
    vi.stubEnv('ProgramFiles(x86)', '');
    vi.stubEnv('LOCALAPPDATA', '');
    vi.stubEnv('SystemDrive', 'C:');
    mockExistsSync.mockReturnValue(false);

    expect(findPosixShell()).toBeNull();
  });
});

describe('resolvePosixCommandInvocation', () => {
  it('runs the raw command through the platform shell outside Windows', () => {
    setPlatform('linux');
    expect(resolvePosixCommandInvocation('FOO=1 ./eval.sh 2>/dev/null')).toEqual({
      file: 'FOO=1 ./eval.sh 2>/dev/null',
      args: [],
      shell: true,
    });
  });

  it('routes the command through bash -c on Windows', () => {
    setPlatform('win32');
    vi.stubEnv('SHELL', '');
    vi.stubEnv('PATH', 'C:\\Program Files\\Git\\bin');
    mockExistsSync.mockImplementation((p: string) => normalize(p) === 'C:/Program Files/Git/bin/bash.exe');

    const invocation = resolvePosixCommandInvocation('FOO=1 ./eval.sh 2>/dev/null');
    expect(normalize(invocation!.file)).toBe('C:/Program Files/Git/bin/bash.exe');
    // -c, not -lc: no profile sourcing, matching the POSIX `sh -c` path.
    expect(invocation!.args).toEqual(['-c', 'FOO=1 ./eval.sh 2>/dev/null']);
    expect(invocation!.shell).toBe(false);
  });

  it('returns null on Windows without a POSIX shell instead of falling back to cmd.exe', () => {
    setPlatform('win32');
    vi.stubEnv('SHELL', '');
    vi.stubEnv('PATH', '');
    vi.stubEnv('ProgramFiles', '');
    vi.stubEnv('ProgramFiles(x86)', '');
    vi.stubEnv('LOCALAPPDATA', '');
    vi.stubEnv('SystemDrive', 'C:');
    mockExistsSync.mockReturnValue(false);

    expect(resolvePosixCommandInvocation('./eval.sh')).toBeNull();
  });
});
