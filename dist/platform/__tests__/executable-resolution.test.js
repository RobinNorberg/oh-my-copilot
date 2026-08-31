import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, spawnSync: vi.fn() };
});
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, existsSync: vi.fn() };
});
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { isExecutableAvailable, probeExecutable, resolveExecutable, } from '../executable-resolution.js';
const mockSpawnSync = spawnSync;
const mockExistsSync = existsSync;
function spawnResult(overrides = {}) {
    return { status: 0, signal: null, stdout: '', stderr: '', ...overrides };
}
afterEach(() => {
    vi.unstubAllEnvs();
    mockSpawnSync.mockReset();
    mockExistsSync.mockReset();
});
describe('resolveExecutable', () => {
    it('uses which with a bounded, shell-free spawn on POSIX', () => {
        mockSpawnSync.mockReturnValue(spawnResult({ stdout: '/usr/local/bin/codex\n' }));
        expect(resolveExecutable('codex', 'linux')).toBe('/usr/local/bin/codex');
        expect(mockSpawnSync).toHaveBeenCalledWith('which', ['codex'], { timeout: 5000, encoding: 'utf8', shell: false, windowsHide: true });
    });
    it('uses where.exe on Windows and takes the first absolute line', () => {
        vi.stubEnv('SystemRoot', 'C:\\Windows');
        mockSpawnSync.mockReturnValue(spawnResult({ stdout: 'codex\r\nC:\\Tools\\codex.cmd\r\n' }));
        expect(resolveExecutable('codex', 'win32')).toBe('C:\\Tools\\codex.cmd');
        expect(mockSpawnSync).toHaveBeenCalledWith('where.exe', ['codex'], expect.objectContaining({ timeout: 5000, encoding: 'utf8', shell: false, windowsHide: true }));
    });
    it('runs where.exe from a neutral directory, not the inherited cwd', () => {
        vi.stubEnv('SystemRoot', 'C:\\Windows');
        mockSpawnSync.mockReturnValue(spawnResult({ stdout: 'C:\\Program Files\\nodejs\\codex.exe\r\n' }));
        resolveExecutable('codex', 'win32');
        // where.exe searches the current directory before PATH, so inheriting the
        // cwd would let a repo-planted codex.exe outrank the real install.
        const options = mockSpawnSync.mock.calls[0][2];
        expect(options.cwd).toBe('C:\\Windows');
        expect(options.cwd).not.toBe(process.cwd());
    });
    it('does not override the cwd on POSIX, where which never searches it', () => {
        mockSpawnSync.mockReturnValue(spawnResult({ stdout: '/usr/local/bin/codex\n' }));
        resolveExecutable('codex', 'linux');
        const options = mockSpawnSync.mock.calls[0][2];
        expect(options.cwd).toBeUndefined();
    });
    it('falls back to the Windows directory when SystemRoot is unset', () => {
        vi.stubEnv('SystemRoot', '');
        vi.stubEnv('windir', '');
        mockSpawnSync.mockReturnValue(spawnResult({ stdout: 'C:\\Program Files\\nodejs\\codex.exe\r\n' }));
        resolveExecutable('codex', 'win32');
        // Still never the inherited cwd.
        const options = mockSpawnSync.mock.calls[0][2];
        expect(options.cwd).toBe('C:\\Windows');
    });
    it('rejects unsafe binary names without spawning anything', () => {
        expect(resolveExecutable('../evil', 'linux')).toBeUndefined();
        expect(resolveExecutable('rm -rf /', 'linux')).toBeUndefined();
        expect(mockSpawnSync).not.toHaveBeenCalled();
    });
    it('treats a finder timeout, signal, or nonzero exit as unresolved', () => {
        mockSpawnSync.mockReturnValue(spawnResult({ status: null, signal: 'SIGTERM' }));
        expect(resolveExecutable('codex', 'linux')).toBeUndefined();
        mockSpawnSync.mockReturnValue(spawnResult({ status: 1 }));
        expect(resolveExecutable('codex', 'linux')).toBeUndefined();
        mockSpawnSync.mockReturnValue(spawnResult({ error: new Error('spawn failed') }));
        expect(resolveExecutable('codex', 'linux')).toBeUndefined();
    });
    it('survives a spawn implementation that returns nothing', () => {
        mockSpawnSync.mockReturnValue(undefined);
        expect(resolveExecutable('codex', 'linux')).toBeUndefined();
    });
});
describe('isExecutableAvailable', () => {
    it('checks absolute paths on disk instead of searching PATH', () => {
        mockExistsSync.mockReturnValue(true);
        expect(isExecutableAvailable('/opt/bin/pyright', 'linux')).toBe(true);
        expect(mockSpawnSync).not.toHaveBeenCalled();
    });
    it('reports a bare name as available only when the resolver finds it', () => {
        mockSpawnSync.mockReturnValue(spawnResult({ stdout: '/usr/bin/prettier\n' }));
        expect(isExecutableAvailable('prettier', 'linux')).toBe(true);
        mockSpawnSync.mockReturnValue(spawnResult({ status: 1 }));
        expect(isExecutableAvailable('prettier', 'linux')).toBe(false);
    });
    it('bounds the PATH lookup with a timeout so a hook cannot hang', () => {
        mockSpawnSync.mockReturnValue(spawnResult({ status: 1 }));
        isExecutableAvailable('prettier', 'linux');
        expect(mockSpawnSync.mock.calls[0][2]).toMatchObject({ timeout: 5000 });
    });
});
describe('probeExecutable', () => {
    it('returns the first non-blank stdout line on success', () => {
        mockSpawnSync.mockReturnValue(spawnResult({ stdout: '\ncodex 1.2.3\nextra\n' }));
        expect(probeExecutable('/usr/local/bin/codex', { platform: 'linux' })).toEqual({
            exitedZero: true,
            output: 'codex 1.2.3',
        });
    });
    it('retries a Windows .cmd shim through COMSPEC when direct exec reports EINVAL', () => {
        vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
        mockSpawnSync
            .mockReturnValueOnce(spawnResult({
            status: null,
            error: Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' }),
        }))
            .mockReturnValueOnce(spawnResult({ stdout: 'codex 1.2.3\n' }));
        const result = probeExecutable('C:\\Tools\\codex.cmd', { platform: 'win32' });
        expect(result).toEqual({ exitedZero: true, output: 'codex 1.2.3' });
        expect(mockSpawnSync).toHaveBeenNthCalledWith(2, 'C:\\Windows\\System32\\cmd.exe', ['/d', '/v:off', '/s', '/c', '""C:\\Tools\\codex.cmd" --version"'], expect.objectContaining({ windowsVerbatimArguments: true, shell: false }));
    });
    it('refuses the COMSPEC retry for a batch path outside the literal-safe grammar', () => {
        vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
        mockSpawnSync.mockReturnValueOnce(spawnResult({
            status: null,
            error: Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' }),
        }));
        const result = probeExecutable('C:\\Tools\\co&dex.cmd', { platform: 'win32' });
        expect(result.exitedZero).toBe(false);
        expect(result.error).toContain('literal-safe');
        expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    });
    it('refuses the COMSPEC retry when an argument is outside the safe grammar', () => {
        vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
        mockSpawnSync.mockReturnValueOnce(spawnResult({
            status: null,
            error: Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' }),
        }));
        const result = probeExecutable('C:\\Tools\\codex.cmd', {
            platform: 'win32',
            args: ['--version & calc'],
        });
        expect(result.exitedZero).toBe(false);
        expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    });
    it('does not retry a non-batch failure through COMSPEC', () => {
        mockSpawnSync.mockReturnValueOnce(spawnResult({ status: 1 }));
        expect(probeExecutable('/usr/local/bin/codex', { platform: 'linux' }).exitedZero).toBe(false);
        expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    });
});
//# sourceMappingURL=executable-resolution.test.js.map