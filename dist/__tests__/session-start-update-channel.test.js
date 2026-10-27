import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'session-start.mjs');
const NODE = process.execPath;
const HOUR_MS = 60 * 60 * 1000;
/**
 * Update channel, cache TTL and host rules of the session-start update check.
 * Everything runs against a local fake registry/marketplace server, so no
 * test reaches the network; requests are counted per path.
 */
describe('session-start.mjs update channel', () => {
    let tempDir;
    let copilotDir;
    let cachePath;
    let copilotPluginRoot;
    let server = null;
    let requests = [];
    let baseUrl = '';
    beforeEach(async () => {
        tempDir = mkdtempSync(join(tmpdir(), 'omc-update-channel-'));
        copilotDir = join(tempDir, 'home', '.copilot');
        cachePath = join(copilotDir, '.omg', 'update-check.json');
        mkdirSync(join(copilotDir, '.omg'), { recursive: true });
        // Copilot CLI's plugin layout: <copilotHome>/installed-plugins/<marketplace>/<plugin>.
        copilotPluginRoot = join(copilotDir, 'installed-plugins', 'omc', 'oh-my-copilot');
        mkdirSync(copilotPluginRoot, { recursive: true });
        writeFileSync(join(copilotPluginRoot, 'package.json'), JSON.stringify({ name: 'oh-my-copilot', version: '1.0.0' }));
        requests = [];
        server = createServer((req, res) => {
            requests.push(req.url ?? '');
            res.writeHead(200, { 'content-type': 'application/json' });
            if (req.url === '/marketplace.json') {
                res.end(JSON.stringify({ name: 'omc', plugins: [{ name: 'oh-my-copilot', version: '9.9.9' }], version: '9.9.9' }));
            }
            else {
                res.end(JSON.stringify({ version: '8.8.8' }));
            }
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string')
            throw new Error('no port');
        baseUrl = `http://127.0.0.1:${address.port}`;
    });
    afterEach(() => {
        server?.close();
        server = null;
        rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    /** Env with every host signal cleared, so the caller states the host. */
    function env(overrides) {
        const base = {
            ...process.env,
            HOME: join(tempDir, 'home'),
            USERPROFILE: join(tempDir, 'home'),
            COPILOT_HOME: copilotDir,
            OMC_UPDATE_REGISTRY_BASE: baseUrl,
            OMC_UPDATE_MARKETPLACE_URL: `${baseUrl}/marketplace.json`,
            CLAUDE_PLUGIN_ROOT: '',
            PLUGIN_ROOT: '',
        };
        for (const key of ['OMC_HOOK_EVENT', 'COPILOT_CLI', 'COPILOT_AGENT_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT']) {
            delete base[key];
        }
        return { ...base, ...overrides };
    }
    /** Run the detached refresh child; async so the local server can answer. */
    function refresh(scriptPath, childEnv) {
        return new Promise((resolve, reject) => {
            const child = spawn(NODE, [scriptPath, '--refresh-update-cache'], { stdio: 'ignore', env: childEnv });
            child.on('error', reject);
            child.on('close', (code) => resolve(code));
        });
    }
    function readCache() {
        return JSON.parse(readFileSync(cachePath, 'utf-8'));
    }
    it('takes a Copilot plugin install\'s latest version from marketplace.json, not npm', async () => {
        const status = await refresh(SCRIPT_PATH, env({ CLAUDE_PLUGIN_ROOT: copilotPluginRoot, OMC_HOOK_EVENT: 'SessionStart' }));
        expect(status).toBe(0);
        expect(readCache()).toMatchObject({
            source: 'copilot-plugin',
            latestVersion: '9.9.9',
            currentVersion: '1.0.0',
            updateAvailable: true,
        });
        expect(requests).toContain('/marketplace.json');
        expect(requests).not.toContain('/oh-my-copilot/latest');
    });
    it('recognises a Copilot plugin install from the script location alone', async () => {
        // A copy of the hook inside installed-plugins, with no plugin-root env var.
        mkdirSync(join(copilotPluginRoot, 'scripts'), { recursive: true });
        copyFileSync(SCRIPT_PATH, join(copilotPluginRoot, 'scripts', 'session-start.mjs'));
        cpSync(join(REPO_ROOT, 'scripts', 'lib'), join(copilotPluginRoot, 'scripts', 'lib'), { recursive: true });
        const status = await refresh(join(copilotPluginRoot, 'scripts', 'session-start.mjs'), env({ OMC_HOOK_EVENT: 'SessionStart' }));
        expect(status).toBe(0);
        expect(readCache()).toMatchObject({ source: 'copilot-plugin', latestVersion: '9.9.9', currentVersion: '1.0.0' });
    });
    it('never fetches the Claude Code version under the Copilot host', async () => {
        await refresh(SCRIPT_PATH, env({ CLAUDE_PLUGIN_ROOT: copilotPluginRoot, OMC_HOOK_EVENT: 'SessionStart' }));
        expect(requests).not.toContain('/@anthropic-ai/claude-code/latest');
        expect(readCache().claudeCodeLatestVersion).toBeUndefined();
    });
    it('also skips the Claude Code fetch on the Copilot env signal alone', async () => {
        await refresh(SCRIPT_PATH, env({ CLAUDE_PLUGIN_ROOT: copilotPluginRoot, COPILOT_CLI: '1' }));
        expect(requests).not.toContain('/@anthropic-ai/claude-code/latest');
    });
    it('still fetches the Claude Code version under the Claude host', async () => {
        await refresh(SCRIPT_PATH, env({ CLAUDE_CODE_ENTRYPOINT: 'cli', COPILOT_CLI: '1' }));
        expect(requests).toContain('/@anthropic-ai/claude-code/latest');
        expect(readCache().claudeCodeLatestVersion).toBe('8.8.8');
    });
    it('trusts a cache younger than 6 hours for the same channel and version', async () => {
        writeFileSync(cachePath, JSON.stringify({
            timestamp: Date.now() - 5 * HOUR_MS,
            latestVersion: '1.0.0',
            currentVersion: '1.0.0',
            updateAvailable: false,
            source: 'copilot-plugin',
        }));
        await refresh(SCRIPT_PATH, env({ CLAUDE_PLUGIN_ROOT: copilotPluginRoot, OMC_HOOK_EVENT: 'SessionStart' }));
        expect(requests).toEqual([]);
        expect(readCache().latestVersion).toBe('1.0.0');
    });
    it('refetches once the cache is older than 6 hours', async () => {
        writeFileSync(cachePath, JSON.stringify({
            timestamp: Date.now() - 7 * HOUR_MS,
            latestVersion: '1.0.0',
            currentVersion: '1.0.0',
            updateAvailable: false,
            source: 'copilot-plugin',
        }));
        await refresh(SCRIPT_PATH, env({ CLAUDE_PLUGIN_ROOT: copilotPluginRoot, OMC_HOOK_EVENT: 'SessionStart' }));
        expect(readCache().latestVersion).toBe('9.9.9');
    });
    it('refreshes a fresh cache early when the installed version changed', async () => {
        writeFileSync(cachePath, JSON.stringify({
            timestamp: Date.now(),
            latestVersion: '1.0.0',
            currentVersion: '0.9.0',
            updateAvailable: true,
            source: 'copilot-plugin',
        }));
        await refresh(SCRIPT_PATH, env({ CLAUDE_PLUGIN_ROOT: copilotPluginRoot, OMC_HOOK_EVENT: 'SessionStart' }));
        expect(readCache()).toMatchObject({ latestVersion: '9.9.9', currentVersion: '1.0.0' });
    });
    it('refreshes a fresh cache early when the channel changed', async () => {
        writeFileSync(cachePath, JSON.stringify({
            timestamp: Date.now(),
            latestVersion: '8.8.8',
            currentVersion: '1.0.0',
            updateAvailable: true,
            source: 'npm',
        }));
        await refresh(SCRIPT_PATH, env({ CLAUDE_PLUGIN_ROOT: copilotPluginRoot, OMC_HOOK_EVENT: 'SessionStart' }));
        expect(readCache()).toMatchObject({ source: 'copilot-plugin', latestVersion: '9.9.9' });
    });
    it('uses npm latest for an install outside any plugin tree', async () => {
        const npmRoot = join(tempDir, 'npm-global', 'oh-my-copilot');
        mkdirSync(npmRoot, { recursive: true });
        writeFileSync(join(npmRoot, 'package.json'), JSON.stringify({ name: 'oh-my-copilot', version: '1.0.0' }));
        await refresh(SCRIPT_PATH, env({ CLAUDE_PLUGIN_ROOT: npmRoot, OMC_HOOK_EVENT: 'SessionStart' }));
        expect(readCache()).toMatchObject({ source: 'npm', latestVersion: '8.8.8' });
        expect(requests).not.toContain('/marketplace.json');
    });
});
//# sourceMappingURL=session-start-update-channel.test.js.map