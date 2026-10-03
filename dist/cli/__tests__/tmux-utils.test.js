/**
 * Tests for src/cli/tmux-utils.ts
 *
 * Covers:
 * - wrapWithLoginShell (issue #1153 — shell RC not loaded in tmux)
 * - quoteShellArg
 * - sanitizeTmuxToken
 * - createHudWatchPane login shell wrapping
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { exec, execFile, execFileSync, spawnSync } from 'child_process';
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        execFileSync: vi.fn(),
        exec: vi.fn(),
        execFile: vi.fn(),
        spawnSync: vi.fn(),
    };
});
const resolution = vi.hoisted(() => ({ resolveHostBinaryLaunch: vi.fn() }));
vi.mock('../../platform/executable-resolution.js', async (importOriginal) => {
    const actual = await importOriginal();
    resolution.resolveHostBinaryLaunch.mockImplementation(actual.resolveHostBinaryLaunch);
    return { ...actual, resolveHostBinaryLaunch: resolution.resolveHostBinaryLaunch };
});
import { buildHostBinarySpawn, buildTmuxShellCommand, buildTmuxShellCommandWithEnv, createHudWatchPane, quoteForCmd, isCopilotAvailable, isNativeWindowsShell, killTmuxPane, listHudWatchPaneIdsInCurrentWindow, resolveLaunchPolicy, tmuxExec, tmuxEnv, tmuxSpawn, tmuxCmdAsync, wrapWithLoginShell, quoteShellArg, sanitizeTmuxToken, } from '../tmux-utils.js';
import { win32 } from 'path';
import { PSMUX_NS_DIR, __setPsmuxDetectionForTests } from '../../team/psmux-adapter.js';
const mockedExecFileSync = vi.mocked(execFileSync);
const mockedExec = vi.mocked(exec);
const mockedExecFile = vi.mocked(execFile);
function mockExecFileAsync(stdout = '', stderr = '') {
    mockedExecFile.mockImplementation(((_command, _args, _options, callback) => {
        const cb = typeof _options === 'function' ? _options : callback;
        cb?.(null, stdout, stderr);
        return {};
    }));
}
function mockExecAsync(stdout = '', stderr = '') {
    mockedExec.mockImplementation(((_command, _options, callback) => {
        const cb = typeof _options === 'function' ? _options : callback;
        cb?.(null, stdout, stderr);
        return {};
    }));
}
const mockedSpawnSync = vi.mocked(spawnSync);
const baselinePlatform = process.platform;
afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: baselinePlatform, configurable: true });
});
// ---------------------------------------------------------------------------
// resolveLaunchPolicy
// ---------------------------------------------------------------------------
describe('resolveLaunchPolicy', () => {
    it('forces direct mode for --print even when tmux is available', () => {
        vi.mocked(execFileSync).mockReturnValue(Buffer.from('tmux 3.4'));
        expect(resolveLaunchPolicy({}, ['--print'])).toBe('direct');
    });
    it('forces direct mode for -p even when tmux is available', () => {
        vi.mocked(execFileSync).mockReturnValue(Buffer.from('tmux 3.4'));
        expect(resolveLaunchPolicy({}, ['-p'])).toBe('direct');
    });
    it('does not treat --print-system-prompt as print mode', () => {
        vi.mocked(execFileSync).mockReturnValue(Buffer.from('tmux 3.4'));
        expect(resolveLaunchPolicy({ TMUX: '1' }, ['--print-system-prompt'])).toBe('inside-tmux');
    });
    it('returns "direct" when CMUX_SURFACE_ID is set (cmux terminal)', () => {
        mockedExecFileSync.mockReturnValue('tmux 3.6a');
        expect(resolveLaunchPolicy({ CMUX_SURFACE_ID: 'C0D4B400-6C27-4957-BD01-32735B2251CD' })).toBe('direct');
    });
    it('keeps inside-tmux authoritative even when tmux availability probing fails', () => {
        mockedExecFileSync.mockImplementation(() => {
            throw new Error('tmux not found');
        });
        expect(resolveLaunchPolicy({ TMUX: '/tmp/tmux-501/default,1234,0' })).toBe('inside-tmux');
    });
    it('prefers inside-tmux over cmux when both TMUX and CMUX_SURFACE_ID are set', () => {
        mockedExecFileSync.mockReturnValue('tmux 3.6a');
        expect(resolveLaunchPolicy({
            TMUX: '/tmp/tmux-501/default,1234,0',
            CMUX_SURFACE_ID: 'some-id',
        })).toBe('inside-tmux');
    });
    it('returns "outside-tmux" when tmux is available but no TMUX or CMUX env', () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        mockedExecFileSync.mockReturnValue('tmux 3.6a');
        expect(resolveLaunchPolicy({})).toBe('outside-tmux');
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
    it('returns "direct" when tmux is not available', () => {
        mockedExecFileSync.mockImplementation(() => {
            throw new Error('tmux not found');
        });
        expect(resolveLaunchPolicy({})).toBe('direct');
    });
    it('returns "outside-tmux" with requireTmux=true even when CMUX_SURFACE_ID is set', () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        mockedExecFileSync.mockReturnValue('tmux 3.6a');
        expect(resolveLaunchPolicy({ CMUX_SURFACE_ID: 'some-id' }, [], { requireTmux: true })).toBe('outside-tmux');
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
    it('returns "direct" with requireTmux=true when tmux is not available', () => {
        mockedExecFileSync.mockImplementation(() => {
            throw new Error('tmux not found');
        });
        expect(resolveLaunchPolicy({}, [], { requireTmux: true })).toBe('direct');
    });
    it('still respects --print over requireTmux=true', () => {
        mockedExecFileSync.mockReturnValue('tmux 3.6a');
        expect(resolveLaunchPolicy({ CMUX_SURFACE_ID: 'some-id' }, ['--print'], { requireTmux: true })).toBe('direct');
    });
    it('still respects TMUX env (inside-tmux) over requireTmux=true', () => {
        expect(resolveLaunchPolicy({ TMUX: '/tmp/tmux-0/default,1,0', CMUX_SURFACE_ID: 'some-id' }, [], { requireTmux: true })).toBe('inside-tmux');
    });
    it('detects tmux.cmd via COMSPEC on win32', () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
        mockedSpawnSync.mockReset();
        mockedSpawnSync
            .mockReturnValueOnce({
            status: 0,
            stdout: 'C:\\Program Files\\psmux\\tmux.cmd\r\n',
            stderr: '',
            pid: 0,
            output: [],
            signal: null,
        })
            .mockReturnValueOnce({
            status: 0,
            stdout: '',
            stderr: '',
            pid: 0,
            output: [],
            signal: null,
        });
        expect(resolveLaunchPolicy({})).toBe('outside-tmux');
        expect(mockedSpawnSync).toHaveBeenNthCalledWith(1, 'where.exe', ['tmux'], {
            timeout: 5000,
            encoding: 'utf8',
            shell: false,
            windowsHide: true,
            // The finder runs from a directory only administrators can write to,
            // so a planted tmux next to the CWD cannot win resolution.
            cwd: process.env.SystemRoot || process.env.windir || 'C:\\Windows',
        });
        // shell:false keeps the space in "Program Files" from splitting the path.
        expect(mockedSpawnSync).toHaveBeenNthCalledWith(2, 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', '"C:\\Program Files\\psmux\\tmux.cmd" -V'], { timeout: 5000, shell: false, windowsHide: true });
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
});
describe('quoteForCmd (cmd.exe + CRT argv quoting)', () => {
    it('doubles a backslash run before an embedded quote so `\\"` cannot split argv', () => {
        // Reviewer repro (t2.js): `a\" --allow-all-tools \"` must reach the child as ONE element.
        expect(quoteForCmd('a\\" --allow-all-tools \\"')).toBe('"a\\\\"" --allow-all-tools \\\\"""');
    });
    it('doubles embedded quotes so cmd.exe quote parity stays even', () => {
        expect(quoteForCmd('x" & echo PWNED & "')).toBe('"x"" & echo PWNED & """');
        expect(quoteForCmd('a"b')).toBe('"a""b"');
    });
    it('rejects % instead of pretending to escape it (cmd.exe expands %VAR% inside quotes)', () => {
        expect(() => quoteForCmd('%PATH%')).toThrow('cmd_argv_percent_unsupported');
        expect(() => quoteForCmd('100% done')).toThrow('cmd_argv_percent_unsupported');
        expect(() => quoteForCmd('%%SECRET%%')).toThrow('cmd_argv_percent_unsupported');
    });
    it.each(['a & b', 'a|b', 'a^b', 'a<b>c', '(a)', 'a !VAR! b'])('keeps cmd metacharacters inside one quoted element: %j', (arg) => {
        expect(quoteForCmd(arg)).toBe(`"${arg}"`);
    });
    it('doubles a trailing backslash run before the closing quote', () => {
        expect(quoteForCmd('C:\\Program Files\\x\\')).toBe('"C:\\Program Files\\x\\\\"');
        expect(quoteForCmd('trail two\\\\')).toBe('"trail two\\\\\\\\"');
        // Unquoted (no metacharacters): backslashes are literal to the CRT.
        expect(quoteForCmd('trailing\\')).toBe('trailing\\');
    });
    it('quotes the empty string and still rejects CR/LF/NUL', () => {
        expect(quoteForCmd('')).toBe('""');
        expect(() => quoteForCmd('a\nb')).toThrow();
        expect(() => quoteForCmd('a\rb')).toThrow();
        expect(() => quoteForCmd('a\0b')).toThrow();
    });
});
describe('buildHostBinarySpawn', () => {
    it('spawns a native .exe directly with the argv array (no cmd.exe, no verbatim)', () => {
        resolution.resolveHostBinaryLaunch.mockReturnValueOnce({ file: 'C:\\bin\\copilot.exe', viaCmd: false });
        expect(buildHostBinarySpawn('copilot', ['-p', '%PATH% "x"'], 'C:\\Windows\\System32\\cmd.exe')).toEqual({
            command: 'C:\\bin\\copilot.exe',
            args: ['-p', '%PATH% "x"'],
            windowsVerbatimArguments: false,
        });
    });
    it('routes a .cmd shim through COMSPEC /d /s /c with an outer-quoted, quoteForCmd-quoted line', () => {
        resolution.resolveHostBinaryLaunch.mockReturnValueOnce({ file: 'C:\\Program Files\\nodejs\\copilot.cmd', viaCmd: true });
        expect(buildHostBinarySpawn('copilot', ['--allow-tool=shell(npm test)', '--no-ask-user'], 'C:\\Windows\\System32\\cmd.exe')).toEqual({
            command: 'C:\\Windows\\System32\\cmd.exe',
            args: ['/d', '/s', '/c', '""C:\\Program Files\\nodejs\\copilot.cmd" "--allow-tool=shell(npm test)" --no-ask-user"'],
            windowsVerbatimArguments: true,
        });
    });
    it('throws rather than put % on a cmd.exe line', () => {
        resolution.resolveHostBinaryLaunch.mockReturnValueOnce({ file: 'copilot', viaCmd: true });
        expect(() => buildHostBinarySpawn('copilot', ['%USERPROFILE%'])).toThrow('cmd_argv_percent_unsupported');
    });
});
describe('resolveHostBinaryLaunch', () => {
    it('never routes through cmd.exe off win32', async () => {
        const { resolveHostBinaryLaunch } = await vi.importActual('../../platform/executable-resolution.js');
        expect(resolveHostBinaryLaunch('copilot', 'linux')).toEqual({ file: 'copilot', viaCmd: false });
    });
    it('classifies absolute win32 paths by extension', async () => {
        const { resolveHostBinaryLaunch } = await vi.importActual('../../platform/executable-resolution.js');
        expect(resolveHostBinaryLaunch('C:\\bin\\copilot.exe', 'win32')).toEqual({ file: 'C:\\bin\\copilot.exe', viaCmd: false });
        expect(resolveHostBinaryLaunch('C:\\npm\\copilot.cmd', 'win32')).toEqual({ file: 'C:\\npm\\copilot.cmd', viaCmd: true });
        expect(resolveHostBinaryLaunch('C:\\npm\\copilot.BAT', 'win32')).toEqual({ file: 'C:\\npm\\copilot.BAT', viaCmd: true });
    });
});
describe('isCopilotAvailable', () => {
    it('probes the host CLI via COMSPEC with verbatim args on win32 so npm .cmd wrappers resolve (#4154)', () => {
        vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', undefined);
        const originalPlatform = process.platform;
        const originalComspec = process.env.COMSPEC;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
        try {
            mockedSpawnSync.mockClear();
            mockedExecFileSync.mockClear();
            resolution.resolveHostBinaryLaunch.mockReturnValueOnce({ file: 'copilot', viaCmd: true });
            mockedSpawnSync.mockReturnValueOnce({ status: 0 });
            expect(isCopilotAvailable()).toBe(true);
            expect(mockedExecFileSync).not.toHaveBeenCalled();
            expect(mockedSpawnSync).toHaveBeenCalledWith('C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', '"copilot --version"'], { stdio: 'ignore', windowsVerbatimArguments: true });
            resolution.resolveHostBinaryLaunch.mockReturnValueOnce({ file: 'copilot', viaCmd: true });
            mockedSpawnSync.mockReturnValueOnce({ status: 9009 });
            expect(isCopilotAvailable()).toBe(false);
        }
        finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
            if (originalComspec === undefined)
                delete process.env.COMSPEC;
            else
                process.env.COMSPEC = originalComspec;
        }
    });
    it('probes a native copilot.exe directly on win32 (no cmd.exe)', () => {
        vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', undefined);
        const originalPlatform = process.platform;
        const originalComspec = process.env.COMSPEC;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        try {
            mockedSpawnSync.mockClear();
            resolution.resolveHostBinaryLaunch.mockReturnValueOnce({ file: 'C:\\bin\\copilot.exe', viaCmd: false });
            mockedSpawnSync.mockReturnValueOnce({ status: 0 });
            expect(isCopilotAvailable()).toBe(true);
            expect(mockedSpawnSync).toHaveBeenCalledWith('C:\\bin\\copilot.exe', ['--version'], { stdio: 'ignore', windowsVerbatimArguments: false });
        }
        finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
            if (originalComspec === undefined)
                delete process.env.COMSPEC;
            else
                process.env.COMSPEC = originalComspec;
        }
    });
    // Binary-selection cases run on the POSIX branch (execFileSync); the win32
    // COMSPEC branch is covered above.
    const onPosix = (fn) => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        try {
            fn();
        }
        finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        }
    };
    it('probes copilot --version by default (no CLAUDE_CODE_ENTRYPOINT)', () => onPosix(() => {
        vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', undefined);
        mockedExecFileSync.mockClear();
        mockedExecFileSync.mockReturnValue(Buffer.from('1.0.88'));
        expect(isCopilotAvailable()).toBe(true);
        expect(mockedExecFileSync.mock.calls.at(-1)?.slice(0, 2)).toEqual(['copilot', ['--version']]);
    }));
    it('probes claude --version when CLAUDE_CODE_ENTRYPOINT is set', () => onPosix(() => {
        vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'cli');
        mockedExecFileSync.mockClear();
        mockedExecFileSync.mockReturnValue(Buffer.from('2.1.116'));
        expect(isCopilotAvailable()).toBe(true);
        expect(mockedExecFileSync.mock.calls.at(-1)?.slice(0, 2)).toEqual(['claude', ['--version']]);
    }));
    it('probes an explicitly passed binary', () => onPosix(() => {
        vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', undefined);
        mockedExecFileSync.mockClear();
        mockedExecFileSync.mockReturnValue(Buffer.from('2.1.116'));
        expect(isCopilotAvailable('claude')).toBe(true);
        expect(mockedExecFileSync.mock.calls.at(-1)?.slice(0, 2)).toEqual(['claude', ['--version']]);
    }));
});
// ---------------------------------------------------------------------------
// tmuxEnv — psmux detached-session env stripping (issue #3265)
// ---------------------------------------------------------------------------
describe('tmuxEnv', () => {
    it('strips PSMUX_SESSION so psmux does not block detached new-session -d', () => {
        vi.stubEnv('TMUX', '/tmp/tmux-0/default,1,0');
        vi.stubEnv('PSMUX_SESSION', 'psmux-session-1');
        const env = tmuxEnv();
        expect(env.TMUX).toBeUndefined();
        expect(env.PSMUX_SESSION).toBeUndefined();
    });
    it('preserves unrelated env vars', () => {
        vi.stubEnv('PSMUX_SESSION', 'psmux-session-1');
        vi.stubEnv('COPILOT_HOME', '/tmp/cfg');
        const env = tmuxEnv();
        expect(env.COPILOT_HOME).toBe('/tmp/cfg');
        expect(env.PSMUX_SESSION).toBeUndefined();
    });
    it('passes a PSMUX_SESSION-free env to execFile for detached creation (stripTmux: true)', () => {
        vi.stubEnv('PSMUX_SESSION', 'psmux-session-1');
        mockedExecFileSync.mockClear();
        mockedExecFileSync.mockReturnValue('');
        tmuxExec(['new-session', '-d', '-s', 'omc-detached'], { stripTmux: true });
        const lastCall = mockedExecFileSync.mock.calls.at(-1);
        expect(lastCall).toBeDefined();
        const passedEnv = lastCall[2].env;
        expect(passedEnv?.PSMUX_SESSION).toBeUndefined();
    });
    it('leaves PSMUX_SESSION intact when stripTmux is not set (in-session split path)', () => {
        vi.stubEnv('PSMUX_SESSION', 'psmux-session-1');
        mockedExecFileSync.mockClear();
        mockedExecFileSync.mockReturnValue('');
        tmuxExec(['split-window', '-h']);
        const lastCall = mockedExecFileSync.mock.calls.at(-1);
        expect(lastCall).toBeDefined();
        const passedEnv = lastCall[2].env;
        expect(passedEnv?.PSMUX_SESSION).toBe('psmux-session-1');
    });
});
describe('tmux command execution parity on Windows', () => {
    it('routes tmuxExec through COMSPEC when where resolves tmux.cmd', () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
        mockedSpawnSync.mockClear();
        mockedExecFileSync.mockClear();
        mockedSpawnSync.mockReturnValueOnce({
            status: 0,
            stdout: 'C:\\Program Files\\psmux\\tmux.cmd\r\n',
            stderr: '',
            pid: 0,
            output: [],
            signal: null,
        });
        mockedExecFileSync.mockReturnValue('ok');
        tmuxExec(['list-sessions']);
        expect(mockedExecFileSync).toHaveBeenLastCalledWith('C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', '"C:\\Program Files\\psmux\\tmux.cmd" list-sessions'], expect.objectContaining({ encoding: 'utf-8' }));
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
    it('routes tmuxSpawn through COMSPEC when where resolves tmux.cmd', () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
        mockedSpawnSync.mockClear();
        mockedSpawnSync
            .mockReturnValueOnce({
            status: 0,
            stdout: 'C:\\Program Files\\psmux\\tmux.cmd\r\n',
            stderr: '',
            pid: 0,
            output: [],
            signal: null,
        })
            .mockReturnValueOnce({
            status: 0,
            stdout: '',
            stderr: '',
            pid: 0,
            output: [],
            signal: null,
        });
        tmuxSpawn(['list-panes']);
        expect(mockedSpawnSync).toHaveBeenLastCalledWith('C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', '"C:\\Program Files\\psmux\\tmux.cmd" list-panes'], expect.objectContaining({ encoding: 'utf-8' }));
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
    it('quotes parenthesized tmux arguments when invoking through COMSPEC', () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
        mockedSpawnSync.mockClear();
        mockedExecFileSync.mockClear();
        mockedSpawnSync.mockReturnValueOnce({
            status: 0,
            stdout: 'C:\\Program Files\\psmux\\tmux.cmd\r\n',
            stderr: '',
            pid: 0,
            output: [],
            signal: null,
        });
        mockedExecFileSync.mockReturnValue('ok');
        tmuxExec(['send-keys', 'foo(bar)']);
        expect(mockedExecFileSync).toHaveBeenLastCalledWith('C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', '"C:\\Program Files\\psmux\\tmux.cmd" send-keys "foo(bar)"'], expect.objectContaining({ encoding: 'utf-8' }));
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
    it('uses argv execution for tmux format args on native Windows instead of POSIX shell quoting', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
        mockedSpawnSync.mockClear();
        mockedExecFile.mockClear();
        mockedExec.mockClear();
        mockedSpawnSync.mockReturnValueOnce({
            status: 0,
            stdout: 'C:\\Program Files\\psmux\\tmux.cmd\r\n',
            stderr: '',
            pid: 0,
            output: [],
            signal: null,
        });
        mockExecFileAsync('42\n');
        await tmuxCmdAsync(['display-message', '-p', '#{window_width}']);
        expect(mockedExec).not.toHaveBeenCalled();
        expect(mockedExecFile).toHaveBeenLastCalledWith('C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', '"C:\\Program Files\\psmux\\tmux.cmd" display-message -p #{window_width}'], expect.objectContaining({ encoding: 'utf-8' }), expect.any(Function));
    });
    it('uses argv execution for tmux format args outside native Windows too', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        mockedExec.mockClear();
        mockedExecFile.mockClear();
        mockExecFileAsync('42\n');
        await tmuxCmdAsync(['display-message', '-p', '#{window_width}']);
        // No shell means no quoting: tmux receives the format string verbatim.
        expect(mockedExec).not.toHaveBeenCalled();
        expect(mockedExecFile).toHaveBeenLastCalledWith('tmux', ['display-message', '-p', '#{window_width}'], expect.objectContaining({ encoding: 'utf-8' }), expect.any(Function));
    });
});
// ---------------------------------------------------------------------------
// Fork (psmux): -S namespace translation at the exec layer
// ---------------------------------------------------------------------------
describe('psmux namespace translation', () => {
    const nsPath = win32.join(PSMUX_NS_DIR, 'omg-abc-def-12345678');
    const tmuxExe = 'C:\\psmux\\tmux.exe';
    function resolveTmuxExeOnce() {
        mockedSpawnSync.mockReturnValueOnce({
            status: 0,
            stdout: `${tmuxExe}\r\n`,
            stderr: '',
            pid: 0,
            output: [],
            signal: null,
        });
    }
    afterEach(() => {
        __setPsmuxDetectionForTests(undefined);
    });
    it('rewrites -S <namespace path> to -L, substitutes #{socket_path} and restores tabs in stdout', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        __setPsmuxDetectionForTests(true);
        mockedSpawnSync.mockClear();
        mockedExecFile.mockClear();
        resolveTmuxExeOnce();
        // Resolve like the real execFile's custom promisify ({ stdout, stderr }).
        mockedExecFile.mockImplementation(((_command, _args, _options, callback) => {
            callback?.(null, { stdout: `%1|${nsPath}|4242\n`, stderr: '' });
            return {};
        }));
        const result = await tmuxCmdAsync(['-S', nsPath, 'split-window', '-P', '-F', '#{pane_id}\t#{socket_path}\t#{pid}']);
        expect(mockedExecFile).toHaveBeenLastCalledWith(tmuxExe, ['-L', 'omg-abc-def-12345678', 'split-window', '-P', '-F', `#{pane_id}|${nsPath}|#{pid}`], expect.objectContaining({ encoding: 'utf-8' }), expect.any(Function));
        expect(result.stdout).toBe(`%1\t${nsPath}\t4242\n`);
    });
    it('leaves stdout untouched when no tab format was mapped', () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        __setPsmuxDetectionForTests(true);
        mockedSpawnSync.mockClear();
        mockedExecFileSync.mockClear();
        resolveTmuxExeOnce();
        mockedExecFileSync.mockReturnValue('a|b');
        expect(tmuxExec(['-S', nsPath, 'capture-pane', '-p'])).toBe('a|b');
        expect(mockedExecFileSync).toHaveBeenLastCalledWith(tmuxExe, ['-L', 'omg-abc-def-12345678', 'capture-pane', '-p'], expect.objectContaining({ encoding: 'utf-8' }));
    });
    it('translates tmuxSpawn argv and stdout', () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        __setPsmuxDetectionForTests(true);
        mockedSpawnSync.mockClear();
        resolveTmuxExeOnce();
        mockedSpawnSync.mockReturnValueOnce({
            status: 0, stdout: '$1|t\n', stderr: '', pid: 0, output: [], signal: null,
        });
        const result = tmuxSpawn(['-S', nsPath, 'list-sessions', '-F', '#{session_id}\t#{session_name}']);
        expect(mockedSpawnSync).toHaveBeenLastCalledWith(tmuxExe, ['-L', 'omg-abc-def-12345678', 'list-sessions', '-F', '#{session_id}|#{session_name}'], expect.objectContaining({ encoding: 'utf-8' }));
        expect(result.stdout).toBe('$1\tt\n');
    });
    it('fails closed for any other -S path on psmux', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        __setPsmuxDetectionForTests(true);
        mockedExecFile.mockClear();
        await expect(tmuxCmdAsync(['-S', 'C:\\Users\\u\\.psmux/default', 'kill-server']))
            .rejects.toThrow('psmux_socket_path_unsupported');
        expect(() => tmuxExec(['-S', 'C:\\Temp\\o-1.sock', 'ls'])).toThrow('psmux_socket_path_unsupported');
        expect(mockedExecFile).not.toHaveBeenCalled();
    });
    it('passes argv through unchanged when tmux is not psmux or without -S', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        __setPsmuxDetectionForTests(false);
        mockedSpawnSync.mockClear();
        mockedExecFile.mockClear();
        resolveTmuxExeOnce();
        mockExecFileAsync('');
        await tmuxCmdAsync(['-S', nsPath, 'list-sessions', '-F', '#{session_id}\t#{session_name}']);
        expect(mockedExecFile).toHaveBeenLastCalledWith(tmuxExe, ['-S', nsPath, 'list-sessions', '-F', '#{session_id}\t#{session_name}'], expect.objectContaining({ encoding: 'utf-8' }), expect.any(Function));
        __setPsmuxDetectionForTests(true);
        resolveTmuxExeOnce();
        await tmuxCmdAsync(['display-message', '-p', '#{pid}']);
        expect(mockedExecFile).toHaveBeenLastCalledWith(tmuxExe, ['display-message', '-p', '#{pid}'], expect.objectContaining({ encoding: 'utf-8' }), expect.any(Function));
    });
});
// ---------------------------------------------------------------------------
// isNativeWindowsShell
// ---------------------------------------------------------------------------
describe('isNativeWindowsShell', () => {
    it('keeps plain MSYS tmux on the POSIX path', () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        vi.stubEnv('MSYSTEM', 'MSYS');
        vi.stubEnv('MINGW_PREFIX', '');
        vi.stubEnv('SYSTEM', '');
        expect(isNativeWindowsShell()).toBe(false);
    });
    it('does not mistake SYSTEM for an MSYS shell marker', () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        vi.stubEnv('MSYSTEM', '');
        vi.stubEnv('MINGW_PREFIX', '');
        vi.stubEnv('SYSTEM', 'MSYS');
        expect(isNativeWindowsShell()).toBe(true);
    });
});
// ---------------------------------------------------------------------------
// wrapWithLoginShell
// ---------------------------------------------------------------------------
describe('wrapWithLoginShell', () => {
    it('uses COMSPEC wrapping instead of Unix exec syntax on native Windows shells', () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
        vi.stubEnv('SHELL', '');
        vi.stubEnv('HOME', 'C:\\Users\\test');
        const result = wrapWithLoginShell('claude --print');
        expect(result).toBe('C:\\Windows\\System32\\cmd.exe /d /s /c "claude --print"');
        expect(result).not.toContain('exec ');
        expect(result).not.toContain('-lc');
        expect(result).not.toContain('.bashrc');
        expect(result).not.toContain('.zshrc');
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
    it('uses cmd-style argument quoting for Windows tmux shell commands', () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        expect(buildTmuxShellCommand('claude', ['--print', 'hello world'])).toBe('claude --print "hello world"');
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
    it('uses cmd-style env injection for Windows tmux shell commands', () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        expect(buildTmuxShellCommandWithEnv('claude', ['--print'], { CODEX_HOME: 'C:\\Users\\me\\codex home' }))
            .toBe('set "CODEX_HOME=C:\\Users\\me\\codex home" && claude --print');
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
    it('escapes literal percent signs in native env assignments', () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        expect(buildTmuxShellCommandWithEnv('claude', [], { TOKEN: 'literal%PATH%' }))
            .toContain('set "TOKEN=literal%%PATH%%"');
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
    it.each(['line\nbreak', 'line\rbreak', `nul\0value`])('rejects unsafe native env value %j', (value) => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        expect(() => buildTmuxShellCommandWithEnv('claude', [], { TOKEN: value })).toThrow('Native Windows tmux command values cannot contain NUL, CR, or LF characters');
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
    it('keeps Unix login-shell wrapping on MSYS2 Windows', () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        vi.stubEnv('MSYSTEM', 'MINGW64');
        vi.stubEnv('SHELL', '/usr/bin/bash');
        vi.stubEnv('HOME', '/home/testuser');
        const result = wrapWithLoginShell('claude');
        expect(result).toContain('exec ');
        expect(result).toContain('-lc');
        expect(result).toContain('/home/testuser/.bashrc');
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
    it('wraps command with login shell using $SHELL', () => {
        vi.stubEnv('SHELL', '/bin/zsh');
        const result = wrapWithLoginShell('claude --print');
        expect(result).toContain('/bin/zsh');
        expect(result).toContain('-lc');
        expect(result).toContain('claude --print');
        expect(result).toMatch(/^exec /);
    });
    it('defaults to /bin/sh when $SHELL is not set', () => {
        vi.stubEnv('SHELL', '');
        const result = wrapWithLoginShell('codex');
        expect(result).toContain('/bin/sh');
        expect(result).toContain('-lc');
    });
    it('properly quotes the inner command containing single quotes', () => {
        vi.stubEnv('SHELL', '/bin/zsh');
        const result = wrapWithLoginShell("perl -e 'print 1'");
        expect(result).toContain('-lc');
        expect(result).toContain('perl');
        expect(result).toContain('print 1');
    });
    it('uses exec to replace the outer shell process', () => {
        vi.stubEnv('SHELL', '/bin/bash');
        const result = wrapWithLoginShell('my-command');
        expect(result).toMatch(/^exec /);
    });
    it('works with complex multi-statement commands', () => {
        vi.stubEnv('SHELL', '/bin/zsh');
        const cmd = 'sleep 0.3; echo hello; claude --dangerously-skip-permissions';
        const result = wrapWithLoginShell(cmd);
        expect(result).toContain('/bin/zsh');
        expect(result).toContain('-lc');
        expect(result).toContain('sleep 0.3');
        expect(result).toContain('claude');
    });
    it('handles shells with unusual paths', () => {
        vi.stubEnv('SHELL', '/usr/local/bin/fish');
        const result = wrapWithLoginShell('codex');
        expect(result).toContain('/usr/local/bin/fish');
        expect(result).toContain('-lc');
    });
    it('sources ~/.zshrc for zsh shells', () => {
        vi.stubEnv('SHELL', '/bin/zsh');
        vi.stubEnv('HOME', '/home/testuser');
        const result = wrapWithLoginShell('claude');
        expect(result).toContain('.zshrc');
        expect(result).toContain('/home/testuser/.zshrc');
    });
    it('sources ~/.bashrc for bash shells', () => {
        vi.stubEnv('SHELL', '/bin/bash');
        vi.stubEnv('HOME', '/home/testuser');
        const result = wrapWithLoginShell('claude');
        expect(result).toContain('.bashrc');
        expect(result).toContain('/home/testuser/.bashrc');
    });
    it('sources ~/.fishrc for fish shells', () => {
        vi.stubEnv('SHELL', '/usr/local/bin/fish');
        vi.stubEnv('HOME', '/home/testuser');
        const result = wrapWithLoginShell('codex');
        expect(result).toContain('.fishrc');
        expect(result).toContain('/home/testuser/.fishrc');
    });
    it('skips rc sourcing when HOME is not set', () => {
        vi.stubEnv('SHELL', '/bin/zsh');
        vi.stubEnv('HOME', '');
        const result = wrapWithLoginShell('claude');
        expect(result).not.toContain('.zshrc');
        expect(result).toContain('claude');
    });
    it('uses conditional test before sourcing rc file', () => {
        vi.stubEnv('SHELL', '/bin/zsh');
        vi.stubEnv('HOME', '/home/testuser');
        const result = wrapWithLoginShell('claude');
        expect(result).toContain('[ -f');
        expect(result).toContain('] && .');
    });
});
// ---------------------------------------------------------------------------
// quoteShellArg
// ---------------------------------------------------------------------------
describe('quoteShellArg', () => {
    it('wraps value in single quotes', () => {
        expect(quoteShellArg('hello')).toBe("'hello'");
    });
    it('escapes embedded single quotes', () => {
        const result = quoteShellArg("it's");
        expect(result).toContain("'\"'\"'");
    });
});
// ---------------------------------------------------------------------------
// sanitizeTmuxToken
// ---------------------------------------------------------------------------
describe('sanitizeTmuxToken', () => {
    it('lowercases and replaces non-alphanumeric with hyphens', () => {
        expect(sanitizeTmuxToken('My_Project.Name')).toBe('my-project-name');
        expect(sanitizeTmuxToken('MyProject')).toBe('myproject');
        expect(sanitizeTmuxToken('my project!')).toBe('my-project');
    });
    it('strips leading and trailing hyphens', () => {
        expect(sanitizeTmuxToken('--hello--')).toBe('hello');
    });
    it('returns "unknown" for empty result', () => {
        expect(sanitizeTmuxToken('...')).toBe('unknown');
        expect(sanitizeTmuxToken('!!!')).toBe('unknown');
    });
});
// ---------------------------------------------------------------------------
// createHudWatchPane — login shell wrapping
// ---------------------------------------------------------------------------
describe('createHudWatchPane login shell wrapping', () => {
    it('wraps hudCmd with wrapWithLoginShell in source code', () => {
        // Verify the source uses wrapWithLoginShell for the HUD command
        const fs = require('fs');
        const path = require('path');
        const source = fs.readFileSync(path.join(__dirname, '..', 'tmux-utils.ts'), 'utf-8');
        expect(source).toContain('wrapWithLoginShell(hudCmd)');
    });
});
describe('HUD pane tmux server targeting', () => {
    it('creates HUD panes against the current tmux server', () => {
        vi.stubEnv('TMUX', '/tmp/tmux-100/default,123,0');
        mockedExecFileSync.mockReturnValue('%12\n');
        expect(createHudWatchPane('/tmp/project', 'omg hud --watch')).toBe('%12');
        const lastCall = mockedExecFileSync.mock.calls.at(-1);
        expect(lastCall?.[1]?.[0]).toBe('split-window');
        expect(lastCall?.[2]?.env?.TMUX).toBe('/tmp/tmux-100/default,123,0');
    });
    it('lists HUD panes against the current tmux server', () => {
        vi.stubEnv('TMUX', '/tmp/tmux-100/default,123,0');
        mockedExecFileSync.mockReturnValue('%2\tnode\tnode /tmp/omc.js hud --watch\n');
        expect(listHudWatchPaneIdsInCurrentWindow()).toEqual(['%2']);
        const lastCall = mockedExecFileSync.mock.calls.at(-1);
        expect(lastCall?.[1]).toEqual(['list-panes', '-F', '#{pane_id}\t#{pane_current_command}\t#{pane_start_command}']);
        expect(lastCall?.[2]?.env?.TMUX).toBe('/tmp/tmux-100/default,123,0');
    });
    it('kills HUD panes against the current tmux server', () => {
        vi.stubEnv('TMUX', '/tmp/tmux-100/default,123,0');
        mockedExecFileSync.mockReturnValue('');
        killTmuxPane('%9');
        const lastCall = mockedExecFileSync.mock.calls.at(-1);
        expect(lastCall?.[1]).toEqual(['kill-pane', '-t', '%9']);
        expect(lastCall?.[2]?.env?.TMUX).toBe('/tmp/tmux-100/default,123,0');
    });
});
//# sourceMappingURL=tmux-utils.test.js.map