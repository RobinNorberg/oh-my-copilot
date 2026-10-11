import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// fork deviation: tsc resolution order (project TypeScript, then PATH tsc via
// cmd.exe on win32) and a distinct "tsc not found" result.
const mocks = vi.hoisted(() => ({
    execFileSync: vi.fn(),
    resolveExecutable: vi.fn(),
}));
vi.mock('child_process', async (importOriginal) => ({
    ...await importOriginal(),
    execFileSync: mocks.execFileSync,
}));
vi.mock('../../../platform/executable-resolution.js', async (importOriginal) => ({
    ...await importOriginal(),
    resolveExecutable: mocks.resolveExecutable,
}));
import { runTscDiagnostics } from '../tsc-runner.js';
const TSC_ARGS = ['--noEmit', '--pretty', 'false'];
let directory;
function withLocalTypeScript() {
    const bin = join(directory, 'node_modules', 'typescript', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'tsc'), '');
    return join(bin, 'tsc');
}
function enoent() {
    return Object.assign(new Error('spawnSync tsc ENOENT'), { code: 'ENOENT' });
}
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'omc-tsc-resolve-'));
    writeFileSync(join(directory, 'tsconfig.json'), '{}');
    mocks.execFileSync.mockReset().mockReturnValue('');
    mocks.resolveExecutable.mockReset().mockReturnValue(undefined);
});
afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
});
describe('runTscDiagnostics compiler resolution', () => {
    it.each(['win32', 'linux'])('prefers the project TypeScript run by this Node (%s)', platform => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
        const local = withLocalTypeScript();
        expect(runTscDiagnostics(directory)).toMatchObject({ success: true, errorCount: 0 });
        expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
        const [file, args, options] = mocks.execFileSync.mock.calls[0];
        expect(file).toBe(process.execPath);
        expect(args).toEqual([local, ...TSC_ARGS]);
        expect(options).toMatchObject({ cwd: directory, shell: false });
        expect(mocks.resolveExecutable).not.toHaveBeenCalled();
    });
    it('falls back to the PATH tsc shim through cmd.exe on win32', () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
        mocks.resolveExecutable.mockReturnValue('C:\\Program Files\\nodejs\\tsc.cmd');
        expect(runTscDiagnostics(directory)).toMatchObject({ success: true });
        expect(mocks.resolveExecutable).toHaveBeenCalledWith('tsc');
        expect(mocks.execFileSync).toHaveBeenCalledWith('tsc --noEmit --pretty false', [], expect.objectContaining({ cwd: directory, shell: true }));
    });
    it('falls back to the PATH tsc without a shell on POSIX', () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
        runTscDiagnostics(directory);
        expect(mocks.execFileSync).toHaveBeenCalledWith('tsc', TSC_ARGS, expect.objectContaining({ shell: false }));
    });
    it('reports a missing win32 compiler as "tsc not found" without spawning', () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
        const result = runTscDiagnostics(directory);
        expect(mocks.execFileSync).not.toHaveBeenCalled();
        expect(result).toMatchObject({ success: false, diagnostics: [], errorCount: 1 });
        expect(result.error).toMatch(/^tsc not found \(ENOENT\)/);
    });
    it('reports a POSIX spawn ENOENT as "tsc not found", not as clean', () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
        mocks.execFileSync.mockImplementation(() => { throw enoent(); });
        const result = runTscDiagnostics(directory);
        expect(result).toMatchObject({ success: false, diagnostics: [], errorCount: 1 });
        expect(result.error).toContain('tsc not found (spawnSync tsc ENOENT)');
    });
    it('keeps a compiler invocation failure from reading as clean', () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
        mocks.execFileSync.mockImplementation(() => {
            throw Object.assign(new Error('Command failed'), { status: 2, stdout: 'error TS18003: No inputs were found.' });
        });
        const result = runTscDiagnostics(directory);
        expect(result.success).toBe(false);
        expect(result.errorCount).toBe(1);
        expect(result.error).toContain('TS18003');
        expect(result.error).not.toContain('tsc not found');
    });
});
//# sourceMappingURL=tsc-runner-resolution.test.js.map