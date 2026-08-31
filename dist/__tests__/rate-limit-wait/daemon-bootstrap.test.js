import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { tmpdir } from 'os';
const { mockSpawn, mockResolveDaemonModulePath, mockIsTmuxAvailable } = vi.hoisted(() => ({
    mockSpawn: vi.fn(),
    mockResolveDaemonModulePath: vi.fn(),
    mockIsTmuxAvailable: vi.fn(() => true),
}));
vi.mock('child_process', async () => {
    const actual = await vi.importActual('child_process');
    return {
        ...actual,
        spawn: mockSpawn,
    };
});
vi.mock('../../utils/daemon-module-path.js', () => ({
    resolveDaemonModulePath: mockResolveDaemonModulePath,
}));
vi.mock('../../features/rate-limit-wait/tmux-detector.js', async () => {
    const actual = await vi.importActual('../../features/rate-limit-wait/tmux-detector.js');
    return {
        ...actual,
        isTmuxAvailable: mockIsTmuxAvailable,
    };
});
const DAEMON_MODULE_PATH = '/repo/dist/features/rate-limit-wait/daemon.js';
describe('daemon bootstrap', () => {
    const originalEnv = { ...process.env };
    const testDir = join(tmpdir(), `omc-daemon-bootstrap-test-${Date.now()}`);
    let startDaemon;
    beforeEach(async () => {
        vi.resetModules();
        mockSpawn.mockReset();
        mockResolveDaemonModulePath.mockReset();
        mockIsTmuxAvailable.mockReset();
        mockIsTmuxAvailable.mockReturnValue(true);
        mockResolveDaemonModulePath.mockReturnValue(DAEMON_MODULE_PATH);
        ({ startDaemon } = await import('../../features/rate-limit-wait/daemon.js'));
    });
    afterEach(() => {
        process.env = { ...originalEnv };
        rmSync(testDir, { recursive: true, force: true });
    });
    it('uses resolved daemon module path and sanitized child env when starting', () => {
        const unref = vi.fn();
        mockSpawn.mockReturnValue({ pid: 4242, unref });
        process.env.PATH = '/usr/bin:/bin';
        process.env.TMUX = '/tmp/tmux-1000/default,100,0';
        process.env.OMC_STATE_DIR = '/tmp/omc-central-state';
        process.env.COPILOT_CONFIG_DIR = '/tmp/claude-profile';
        process.env.CLAUDE_SESSION_ID = 'session-current';
        process.env.CLAUDECODE_SESSION_ID = 'session-legacy-alias';
        process.env.ANTHROPIC_API_KEY = 'super-secret';
        process.env.GITHUB_TOKEN = 'token-should-not-leak';
        const config = {
            stateFilePath: join(testDir, 'state.json'),
            pidFilePath: join(testDir, 'daemon.pid'),
            logFilePath: join(testDir, 'daemon.log'),
            pollIntervalMs: 1234,
            verbose: true,
        };
        const result = startDaemon(config);
        expect(result.success).toBe(true);
        expect(result.message).toContain('Daemon started with PID 4242');
        expect(unref).toHaveBeenCalledTimes(1);
        expect(mockResolveDaemonModulePath).toHaveBeenCalledTimes(1);
        expect(mockResolveDaemonModulePath).toHaveBeenCalledWith(expect.any(String), ['features', 'rate-limit-wait', 'daemon.js']);
        expect(mockSpawn).toHaveBeenCalledTimes(1);
        const [command, args, spawnOptions] = mockSpawn.mock.calls[0];
        // The running interpreter, not a PATH lookup that a Volta/nvm shim can break.
        expect(command).toBe(process.execPath);
        expect(args[0]).toBe('-e');
        // The URL is derived the same way the daemon derives it, so the assertion
        // holds on Windows where a POSIX-looking path resolves under a drive root.
        expect(args[1]).toContain(`import(${JSON.stringify(pathToFileURL(DAEMON_MODULE_PATH).href)})`);
        expect(spawnOptions?.detached).toBe(true);
        expect(spawnOptions?.stdio).toBe('ignore');
        const childEnv = spawnOptions?.env;
        expect(childEnv.PATH).toBe('/usr/bin:/bin');
        expect(childEnv.TMUX).toBe('/tmp/tmux-1000/default,100,0');
        expect(childEnv.OMC_STATE_DIR).toBe('/tmp/omc-central-state');
        expect(childEnv.COPILOT_CONFIG_DIR).toBe('/tmp/claude-profile');
        // A detached daemon must not pin itself to the launching session: that
        // session's cache is removed at session end, while another live session
        // may have the version the daemon should use on its next poll.
        expect(childEnv.CLAUDE_SESSION_ID).toBeUndefined();
        expect(childEnv.CLAUDECODE_SESSION_ID).toBeUndefined();
        expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
        expect(childEnv.GITHUB_TOKEN).toBeUndefined();
        const configPath = childEnv.OMC_DAEMON_CONFIG_FILE;
        expect(configPath).toBeTruthy();
        expect(existsSync(configPath)).toBe(true);
        const persistedConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
        expect(persistedConfig.pollIntervalMs).toBe(1234);
        expect(persistedConfig.verbose).toBe(true);
    });
    it('uses a file URL in daemon import script so Windows backslashes are not parsed as JS escapes', () => {
        const unref = vi.fn();
        mockSpawn.mockReturnValue({ pid: 4243, unref });
        mockResolveDaemonModulePath.mockReturnValue('C:\\Users\\soung\\AppData\\Roaming\\npm\\node_modules\\oh-my-copilot\\dist\\features\\rate-limit-wait\\daemon.js');
        const config = {
            stateFilePath: join(testDir, 'state.json'),
            pidFilePath: join(testDir, 'daemon.pid'),
            logFilePath: join(testDir, 'daemon.log'),
        };
        const result = startDaemon(config);
        expect(result.success).toBe(true);
        const [, args] = mockSpawn.mock.calls[0];
        const daemonScript = args[1];
        expect(daemonScript).toContain('import("file://');
        expect(daemonScript).not.toContain("import('C:\\Users");
        expect(daemonScript).not.toContain('\\features\\rate-limit-wait\\daemon.js');
    });
    it('returns already running when config pid file points to a live process', () => {
        const config = {
            stateFilePath: join(testDir, 'state.json'),
            pidFilePath: join(testDir, 'daemon.pid'),
            logFilePath: join(testDir, 'daemon.log'),
        };
        // Use current process PID so isDaemonRunning() reports true.
        mkdirSync(testDir, { recursive: true });
        writeFileSync(config.pidFilePath, String(process.pid));
        const result = startDaemon(config);
        expect(result.success).toBe(false);
        expect(result.message).toBe('Daemon is already running');
        expect(mockSpawn).not.toHaveBeenCalled();
    });
});
//# sourceMappingURL=daemon-bootstrap.test.js.map