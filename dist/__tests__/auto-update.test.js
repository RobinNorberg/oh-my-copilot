import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        execSync: vi.fn(),
    };
});
vi.mock('../installer/index.js', async () => {
    const actual = await vi.importActual('../installer/index.js');
    return {
        ...actual,
        install: vi.fn(),
        HOOKS_DIR: '/tmp/omc-test-hooks',
        isProjectScopedPlugin: vi.fn(),
        isRunningAsPlugin: vi.fn(),
        checkNodeVersion: vi.fn(),
    };
});
vi.mock('fs', async () => {
    const actual = await vi.importActual('fs');
    return {
        ...actual,
        cpSync: vi.fn(),
        existsSync: vi.fn(),
        mkdirSync: vi.fn(),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
    };
});
import { execSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { install, isProjectScopedPlugin, isRunningAsPlugin, checkNodeVersion } from '../installer/index.js';
import { reconcileUpdateRuntime, performUpdate, fetchLatestRelease, } from '../features/auto-update.js';
const mockedExecSync = vi.mocked(execSync);
const mockedCpSync = vi.mocked(cpSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedMkdirSync = vi.mocked(mkdirSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedInstall = vi.mocked(install);
const mockedIsProjectScopedPlugin = vi.mocked(isProjectScopedPlugin);
const mockedIsRunningAsPlugin = vi.mocked(isRunningAsPlugin);
const mockedCheckNodeVersion = vi.mocked(checkNodeVersion);
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const originalGhToken = process.env.GH_TOKEN;
const originalGithubToken = process.env.GITHUB_TOKEN;
function mockPlatform(platform) {
    Object.defineProperty(process, 'platform', {
        configurable: true,
        value: platform,
    });
}
describe('auto-update reconciliation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.GH_TOKEN;
        delete process.env.GITHUB_TOKEN;
        mockedCpSync.mockImplementation(() => undefined);
        mockedExistsSync.mockReturnValue(true);
        mockedIsProjectScopedPlugin.mockReturnValue(false);
        // Default: running as plugin so forceHooks/refreshHooksInPlugin logic works
        mockedIsRunningAsPlugin.mockReturnValue(true);
        mockedReadFileSync.mockImplementation((path) => {
            if (String(path).includes('.omc-version.json')) {
                return JSON.stringify({
                    version: '4.1.5',
                    installedAt: '2026-02-09T00:00:00.000Z',
                    installMethod: 'npm',
                });
            }
            return '';
        });
        mockedCheckNodeVersion.mockReturnValue({
            valid: true,
            current: 20,
            required: 20,
        });
        mockedInstall.mockReturnValue({
            success: true,
            message: 'ok',
            installedAgents: [],
            installedCommands: [],
            installedSkills: [],
            hooksConfigured: true,
            hookConflicts: [],
            errors: [],
        });
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        delete process.env.CLAUDE_PLUGIN_ROOT;
        if (originalGhToken === undefined) {
            delete process.env.GH_TOKEN;
        }
        else {
            process.env.GH_TOKEN = originalGhToken;
        }
        if (originalGithubToken === undefined) {
            delete process.env.GITHUB_TOKEN;
        }
        else {
            process.env.GITHUB_TOKEN = originalGithubToken;
        }
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', originalPlatformDescriptor);
        }
    });
    it('fetches latest release without Authorization when no GitHub token is configured', async () => {
        const release = {
            tag_name: 'v4.1.5',
            name: '4.1.5',
            published_at: '2026-02-09T00:00:00.000Z',
            html_url: 'https://example.com/release',
            body: 'notes',
            prerelease: false,
            draft: false,
        };
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => release,
        });
        vi.stubGlobal('fetch', fetchMock);
        await expect(fetchLatestRelease()).resolves.toEqual(release);
        expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/releases/latest'), {
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'oh-my-copilot-updater',
            },
        });
    });
    it('uses GITHUB_TOKEN for latest release requests when GH_TOKEN is absent', async () => {
        process.env.GITHUB_TOKEN = 'github-token-value';
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({
                tag_name: 'v4.1.5',
                name: '4.1.5',
                published_at: '2026-02-09T00:00:00.000Z',
                html_url: 'https://example.com/release',
                body: 'notes',
                prerelease: false,
                draft: false,
            }),
        });
        vi.stubGlobal('fetch', fetchMock);
        await fetchLatestRelease();
        expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/releases/latest'), expect.objectContaining({
            headers: expect.objectContaining({
                Authorization: 'Bearer github-token-value',
            }),
        }));
    });
    it('prefers GH_TOKEN over GITHUB_TOKEN for latest release requests', async () => {
        process.env.GH_TOKEN = 'gh-token-value';
        process.env.GITHUB_TOKEN = 'github-token-value';
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({
                tag_name: 'v4.1.5',
                name: '4.1.5',
                published_at: '2026-02-09T00:00:00.000Z',
                html_url: 'https://example.com/release',
                body: 'notes',
                prerelease: false,
                draft: false,
            }),
        });
        vi.stubGlobal('fetch', fetchMock);
        await fetchLatestRelease();
        expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/releases/latest'), expect.objectContaining({
            headers: expect.objectContaining({
                Authorization: 'Bearer gh-token-value',
            }),
        }));
    });
    it('adds a helpful rate-limit hint for unauthenticated 403 release responses', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            headers: new Headers({
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': '1893456000',
            }),
            text: async () => JSON.stringify({ message: 'API rate limit exceeded' }),
        }));
        await expect(fetchLatestRelease()).rejects.toThrow(/GitHub API rate limit exceeded.*Set GH_TOKEN or GITHUB_TOKEN.*2030-01-01T00:00:00.000Z/);
    });
    it('does not leak a configured token in token-authenticated 403 errors', async () => {
        process.env.GH_TOKEN = 'super-secret-token';
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            headers: new Headers({
                'x-ratelimit-remaining': '0',
            }),
            text: async () => JSON.stringify({ message: 'API rate limit exceeded' }),
        }));
        await expect(fetchLatestRelease()).rejects.toThrow(/configured GitHub token appears to be rate limited/);
        await expect(fetchLatestRelease()).rejects.not.toThrow(/super-secret-token/);
    });
    it('reconciles runtime state without re-injecting settings hooks', () => {
        mockedExistsSync.mockReturnValue(false);
        const result = reconcileUpdateRuntime({ verbose: false });
        expect(result.success).toBe(true);
        expect(mockedMkdirSync).toHaveBeenCalledWith('/tmp/omc-test-hooks', { recursive: true });
        expect(mockedInstall).toHaveBeenCalledWith({
            force: true,
            verbose: false,
            skipCopilotCheck: true,
            forceHooks: false,
            refreshHooksInPlugin: false,
        });
    });
    it('skips hooks directory prep in project-scoped plugin reconciliation', () => {
        mockedIsProjectScopedPlugin.mockReturnValue(true);
        const result = reconcileUpdateRuntime({ verbose: false });
        expect(result.success).toBe(true);
        expect(mockedMkdirSync).not.toHaveBeenCalled();
        expect(mockedInstall).toHaveBeenCalledWith({
            force: true,
            verbose: false,
            skipCopilotCheck: true,
            forceHooks: false,
            refreshHooksInPlugin: false,
        });
    });
    it('is idempotent when reconciliation runs repeatedly', () => {
        const first = reconcileUpdateRuntime({ verbose: false });
        const second = reconcileUpdateRuntime({ verbose: false });
        expect(first.success).toBe(true);
        expect(second.success).toBe(true);
        expect(mockedInstall).toHaveBeenNthCalledWith(1, {
            force: true,
            verbose: false,
            skipCopilotCheck: true,
            forceHooks: false,
            refreshHooksInPlugin: false,
        });
        expect(mockedInstall).toHaveBeenNthCalledWith(2, {
            force: true,
            verbose: false,
            skipCopilotCheck: true,
            forceHooks: false,
            refreshHooksInPlugin: false,
        });
    });
    it('runs reconciliation as part of performUpdate without plugin hook reinjection', async () => {
        // Set env var so performUpdate takes the direct reconciliation path
        // (simulates being in the re-exec'd process after npm install)
        process.env.OMC_UPDATE_RECONCILE = '1';
        process.env.CLAUDE_PLUGIN_ROOT = join(homedir(), '.copilot', 'plugins', 'cache', 'omc', 'oh-my-copilot', '4.1.5');
        // Clear entrypoint so shouldBlockStandaloneUpdateInCurrentSession() returns false
        const savedEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
        delete process.env.CLAUDE_CODE_ENTRYPOINT;
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                tag_name: 'v4.1.5',
                name: '4.1.5',
                published_at: '2026-02-09T00:00:00.000Z',
                html_url: 'https://example.com/release',
                body: 'notes',
                prerelease: false,
                draft: false,
            }),
        }));
        mockedExecSync.mockReturnValue('');
        const result = await performUpdate({ verbose: false });
        expect(result.success).toBe(true);
        expect(mockedExecSync).toHaveBeenCalledWith('npm install -g oh-my-copilot@latest', expect.any(Object));
        expect(mockedInstall).toHaveBeenCalledWith({
            force: true,
            verbose: false,
            skipCopilotCheck: true,
            forceHooks: false,
            refreshHooksInPlugin: false,
        });
        delete process.env.OMC_UPDATE_RECONCILE;
        if (savedEntrypoint !== undefined)
            process.env.CLAUDE_CODE_ENTRYPOINT = savedEntrypoint;
        else
            delete process.env.CLAUDE_CODE_ENTRYPOINT;
    });
    it('does not persist metadata when reconciliation fails', async () => {
        // Set env var so performUpdate takes the direct reconciliation path
        process.env.OMC_UPDATE_RECONCILE = '1';
        const savedEntrypoint2 = process.env.CLAUDE_CODE_ENTRYPOINT;
        delete process.env.CLAUDE_CODE_ENTRYPOINT;
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                tag_name: 'v4.1.5',
                name: '4.1.5',
                published_at: '2026-02-09T00:00:00.000Z',
                html_url: 'https://example.com/release',
                body: 'notes',
                prerelease: false,
                draft: false,
            }),
        }));
        mockedExecSync.mockReturnValue('');
        mockedInstall.mockReturnValue({
            success: false,
            message: 'fail',
            installedAgents: [],
            installedCommands: [],
            installedSkills: [],
            hooksConfigured: false,
            hookConflicts: [],
            errors: ['boom'],
        });
        const result = await performUpdate({ verbose: false });
        expect(result.success).toBe(false);
        expect(result.errors).toEqual(['Reconciliation failed: boom']);
        expect(mockedWriteFileSync).not.toHaveBeenCalled();
        delete process.env.OMC_UPDATE_RECONCILE;
        if (savedEntrypoint2 !== undefined)
            process.env.CLAUDE_CODE_ENTRYPOINT = savedEntrypoint2;
        else
            delete process.env.CLAUDE_CODE_ENTRYPOINT;
    });
});
//# sourceMappingURL=auto-update.test.js.map