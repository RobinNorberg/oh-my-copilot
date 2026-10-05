import { mkdirSync, mkdtempSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const PACKAGE_ROOT = resolve(__dirname, '..', '..', '..');
const { runCopilotSmoke, resolvePackageRoot } = vi.hoisted(() => ({ runCopilotSmoke: vi.fn(), resolvePackageRoot: vi.fn() }));
vi.mock('../../smoke/copilot-smoke.js', () => ({ runCopilotSmoke, resolvePackageRoot }));
import { hostSmokeTool } from '../../tools/host-smoke-tool.js';
import { allTools, buildListToolsResponse } from '../tool-registry.js';
function fakeReport(ok) {
    return {
        ok,
        tier: 0,
        pluginRoot: '/repo',
        pluginVersion: '5.6.2',
        copilot: { bin: '/bin/copilot', version: '1.0.91' },
        checks: [
            { id: 'plugin.manifest', ok: true, detail: 'oh-my-copilot 5.6.2' },
            { id: 'copilot.plugin_list', ok, detail: ok ? 'found' : 'plugin list returned []' },
        ],
        artifacts: {},
        durationMs: 12,
    };
}
describe('host_smoke MCP tool', () => {
    beforeEach(() => {
        runCopilotSmoke.mockReset();
        resolvePackageRoot.mockReset();
        resolvePackageRoot.mockReturnValue(PACKAGE_ROOT);
        vi.stubEnv('OMC_SMOKE_ALLOW_LIVE', '');
        vi.stubEnv('OMC_SMOKE_ALLOW_ANY_ROOT', '');
    });
    afterEach(() => {
        vi.unstubAllEnvs();
    });
    it('is registered in the standalone registry with a JSON schema', () => {
        expect(allTools.map((t) => t.name)).toContain('host_smoke');
        const entry = buildListToolsResponse('').tools.find((t) => t.name === 'host_smoke');
        expect(entry).toBeDefined();
        expect(entry.inputSchema.required).toEqual([]);
        expect(entry.inputSchema.properties).toMatchObject({
            tier: { type: 'integer' },
            pluginRoot: { type: 'string' },
            keepHome: { type: 'boolean' },
            delegate: { type: 'boolean' },
        });
    });
    it('is filtered out by OMC_DISABLE_TOOLS=smoke', () => {
        const names = buildListToolsResponse('smoke').tools.map((t) => t.name);
        expect(names).not.toContain('host_smoke');
    });
    it('returns the report JSON without isError when ok', async () => {
        runCopilotSmoke.mockResolvedValue(fakeReport(true));
        const result = await hostSmokeTool.handler({});
        expect(runCopilotSmoke).toHaveBeenCalledWith({ tier: 0 });
        expect(result.isError).toBeUndefined();
        expect(JSON.parse(result.content[0].text)).toEqual(fakeReport(true));
    });
    it('sets isError when the report is not ok and forwards options (tier 1 opted in)', async () => {
        vi.stubEnv('OMC_SMOKE_ALLOW_LIVE', '1');
        runCopilotSmoke.mockResolvedValue(fakeReport(false));
        const result = await hostSmokeTool.handler({
            tier: 1,
            pluginRoot: PACKAGE_ROOT,
            model: 'gpt-5-mini',
            maxCredits: 40,
            timeoutMs: 5000,
            keepHome: true,
            delegate: true,
        });
        expect(runCopilotSmoke).toHaveBeenCalledWith({
            tier: 1,
            pluginRoot: PACKAGE_ROOT,
            model: 'gpt-5-mini',
            maxCredits: 40,
            timeoutMs: 5000,
            keepHome: true,
            delegate: true,
        });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text).ok).toBe(false);
    });
    it('refuses tier 1 without OMC_SMOKE_ALLOW_LIVE=1', async () => {
        const result = await hostSmokeTool.handler({ tier: 1 });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/OMC_SMOKE_ALLOW_LIVE=1/);
        expect(runCopilotSmoke).not.toHaveBeenCalled();
    });
    it('refuses a foreign pluginRoot unless OMC_SMOKE_ALLOW_ANY_ROOT=1', async () => {
        runCopilotSmoke.mockResolvedValue(fakeReport(true));
        const foreign = mkdtempSync(join(tmpdir(), 'host-smoke-foreign-'));
        try {
            const refused = await hostSmokeTool.handler({ pluginRoot: foreign });
            expect(refused.isError).toBe(true);
            expect(refused.content[0].text).toMatch(/OMC_SMOKE_ALLOW_ANY_ROOT=1/);
            expect(runCopilotSmoke).not.toHaveBeenCalled();
            vi.stubEnv('OMC_SMOKE_ALLOW_ANY_ROOT', '1');
            const allowed = await hostSmokeTool.handler({ pluginRoot: foreign });
            expect(allowed.isError).toBeUndefined();
            expect(runCopilotSmoke).toHaveBeenCalledWith({ tier: 0, pluginRoot: foreign });
        }
        finally {
            rmSync(foreign, { recursive: true, force: true });
        }
    });
    it('accepts the package root through a symlink/junction (realpath compare)', async () => {
        runCopilotSmoke.mockResolvedValue(fakeReport(true));
        const base = mkdtempSync(join(tmpdir(), 'host-smoke-link-'));
        const real = join(base, 'real');
        const link = join(base, 'link');
        mkdirSync(real);
        resolvePackageRoot.mockReturnValue(real);
        symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
        try {
            const result = await hostSmokeTool.handler({ pluginRoot: link });
            expect(result.isError).toBeUndefined();
        }
        finally {
            // Drop the link itself before the recursive delete so nothing is traversed through it.
            try {
                unlinkSync(link);
            }
            catch {
                rmdirSync(link);
            }
            rmSync(base, { recursive: true, force: true });
        }
    });
    it('reports a thrown error as isError text', async () => {
        runCopilotSmoke.mockRejectedValue(new Error('boom'));
        const result = await hostSmokeTool.handler({});
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('host_smoke failed: boom');
    });
});
//# sourceMappingURL=host-smoke-tool.test.js.map