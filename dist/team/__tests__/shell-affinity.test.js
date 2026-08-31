import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildWorkerLaunchSpec, resolveSupportedShellAffinity, resolveShellFromCandidates, } from '../tmux-session.js';
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, existsSync: vi.fn() };
});
import { existsSync } from 'fs';
const mockExistsSync = existsSync;
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
/**
 * Pin the platform under test. Without this the suite inherits the host's — and
 * on Windows also the launching shell's MSYSTEM — so POSIX selection tests take
 * the MSYS `/bin/sh` short-circuit when run from Git Bash and pass under
 * PowerShell.
 */
function setPlatform(value) {
    Object.defineProperty(process, 'platform', { value, configurable: true });
}
afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    mockExistsSync.mockReset();
    if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
});
describe('resolveShellFromCandidates', () => {
    it('returns first existing candidate', () => {
        mockExistsSync.mockImplementation((p) => p === '/usr/bin/zsh');
        const result = resolveShellFromCandidates(['/bin/zsh', '/usr/bin/zsh'], '/home/user/.zshrc');
        expect(result).toEqual({ shell: '/usr/bin/zsh', rcFile: '/home/user/.zshrc' });
    });
    it('returns null when no candidates exist', () => {
        mockExistsSync.mockReturnValue(false);
        expect(resolveShellFromCandidates(['/bin/zsh', '/usr/bin/zsh'], '/home/user/.zshrc')).toBeNull();
    });
    it('resolves bash.exe from PATH on Windows when fixed Unix candidates do not exist', () => {
        const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: 'win32' });
        vi.stubEnv('PATH', 'C:\\Windows\\System32;D:\\SoftWare\\Git\\bin');
        mockExistsSync.mockImplementation((p) => p.replace(/\\/g, '/').replace(/\/+/g, '/') === 'D:/SoftWare/Git/bin/bash.exe');
        const result = resolveShellFromCandidates(['/bin/bash', '/usr/bin/bash'], 'C:/Users/test/.bashrc');
        expect(result?.rcFile).toBe('C:/Users/test/.bashrc');
        expect(result?.shell.replace(/\\/g, '/')).toBe('D:/SoftWare/Git/bin/bash.exe');
        if (originalDescriptor) {
            Object.defineProperty(process, 'platform', originalDescriptor);
        }
    });
});
describe('resolveSupportedShellAffinity', () => {
    it('returns null for undefined shellPath', () => {
        expect(resolveSupportedShellAffinity(undefined)).toBeNull();
    });
    it('returns null for unsupported shells (fish)', () => {
        mockExistsSync.mockReturnValue(true);
        expect(resolveSupportedShellAffinity('/usr/bin/fish')).toBeNull();
    });
    it('returns null for unsupported shells (nushell)', () => {
        mockExistsSync.mockReturnValue(true);
        expect(resolveSupportedShellAffinity('/usr/bin/nu')).toBeNull();
    });
    it('returns null when zsh binary does not exist', () => {
        mockExistsSync.mockReturnValue(false);
        expect(resolveSupportedShellAffinity('/bin/zsh')).toBeNull();
    });
    it('returns spec for existing zsh', () => {
        mockExistsSync.mockReturnValue(true);
        vi.stubEnv('HOME', '/home/testuser');
        const result = resolveSupportedShellAffinity('/bin/zsh');
        expect(result).toEqual({ shell: '/bin/zsh', rcFile: '/home/testuser/.zshrc' });
    });
    it('returns spec for existing bash', () => {
        mockExistsSync.mockReturnValue(true);
        vi.stubEnv('HOME', '/home/testuser');
        const result = resolveSupportedShellAffinity('/bin/bash');
        expect(result).toEqual({ shell: '/bin/bash', rcFile: '/home/testuser/.bashrc' });
    });
});
describe('buildWorkerLaunchSpec', () => {
    it('returns /bin/sh on MSYS2 (isUnixLikeOnWindows)', () => {
        setPlatform('win32');
        vi.stubEnv('MSYSTEM', 'MINGW64');
        mockExistsSync.mockReturnValue(true);
        // MSYS short-circuits before any shell probing, so an existing zsh loses.
        expect(buildWorkerLaunchSpec('/bin/zsh')).toEqual({ shell: '/bin/sh', rcFile: null });
    });
    it('uses user zsh when $SHELL is zsh and binary exists', () => {
        setPlatform('linux');
        vi.stubEnv('HOME', '/home/testuser');
        mockExistsSync.mockReturnValue(true);
        const result = buildWorkerLaunchSpec('/bin/zsh');
        expect(result.shell).toBe('/bin/zsh');
        expect(result.rcFile).toBe('/home/testuser/.zshrc');
    });
    it('falls back to zsh candidates when $SHELL is fish', () => {
        setPlatform('linux');
        vi.stubEnv('HOME', '/home/testuser');
        mockExistsSync.mockImplementation((p) => p === '/usr/bin/zsh');
        const result = buildWorkerLaunchSpec('/usr/bin/fish');
        expect(result.shell).toBe('/usr/bin/zsh');
        expect(result.rcFile).toBe('/home/testuser/.zshrc');
    });
    it('falls back to bash when zsh is missing', () => {
        setPlatform('linux');
        vi.stubEnv('HOME', '/home/testuser');
        mockExistsSync.mockImplementation((p) => p === '/bin/bash');
        const result = buildWorkerLaunchSpec('/usr/bin/fish');
        expect(result.shell).toBe('/bin/bash');
        expect(result.rcFile).toBe('/home/testuser/.bashrc');
    });
    it('falls back to /bin/sh when no supported shell found', () => {
        setPlatform('linux');
        mockExistsSync.mockReturnValue(false);
        const result = buildWorkerLaunchSpec('/usr/bin/fish');
        expect(result).toEqual({ shell: '/bin/sh', rcFile: null });
    });
    it('falls back to /bin/sh when no shellPath provided and no candidates found', () => {
        setPlatform('linux');
        mockExistsSync.mockReturnValue(false);
        const result = buildWorkerLaunchSpec(undefined);
        expect(result).toEqual({ shell: '/bin/sh', rcFile: null });
    });
});
//# sourceMappingURL=shell-affinity.test.js.map