import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildListToolsResponse, callTool, getEnabledTools } from '../../mcp/tool-registry.js';
import { bridgeCleanupBudget, buildSdkInProcessTools } from '../sdk-inprocess-tools.js';
import { buildSdkExcludedTools } from '../sdk-policy.js';
// Records what the SDK converter receives and returns it unchanged, so a
// handler's result is exactly the MCP CallTool result it converted.
const seen = [];
const identitySdk = { convertMcpCallToolResult: (r) => { seen.push(r); return r; } };
describe('sdk in-process tools: parity with the t MCP server', () => {
    let dir;
    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'omg-inproc-'));
        execFileSync('git', ['init', '-q'], { cwd: dir });
    });
    afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
    it('offers every ListTools entry under its Copilot MCP name with the same description and schema', () => {
        const set = buildSdkInProcessTools(identitySdk, 't', ['t-host_smoke'], '');
        const mcp = buildListToolsResponse('').tools.filter((t) => t.name !== 'host_smoke');
        expect(set.disabledMcpServer).toBe('t');
        expect(set.tools.map((t) => t.name)).toEqual(mcp.map((t) => `t-${t.name}`));
        expect(set.tools.map((t) => ({ description: t.description, parameters: t.parameters })))
            .toEqual(mcp.map((t) => ({ description: t.description, parameters: t.inputSchema })));
        expect(set.tools.every((t) => t.skipPermission === true)).toBe(true);
        expect(set.tools).toHaveLength(getEnabledTools('').length - 1);
    });
    it('drops excluded names and honours the session OMC_DISABLE_TOOLS like the server', () => {
        const set = buildSdkInProcessTools(identitySdk, 't', ['t-host_smoke', 't-state_clear'], 'lsp,ast');
        const names = set.tools.map((t) => t.name);
        expect(names).not.toContain('t-state_clear');
        expect(names).not.toContain('t-host_smoke');
        expect(names).toEqual(buildListToolsResponse('lsp,ast').tools
            .map((t) => `t-${t.name}`)
            .filter((n) => n !== 't-state_clear' && n !== 't-host_smoke'));
    });
    it.each([
        ['state_list_active', () => ({ workingDirectory: dir })],
        ['notepad_read', () => ({ workingDirectory: dir })],
        ['state_read', () => ({ mode: 'not-a-mode', workingDirectory: dir })],
        ['state_get_status', () => undefined],
    ])('%s returns the CallTool result, converted', async (name, args) => {
        const set = buildSdkInProcessTools(identitySdk, 't', [], '');
        const tool = set.tools.find((t) => t.name === `t-${name}`);
        seen.length = 0;
        const result = await tool.handler(args());
        expect(seen).toHaveLength(1);
        expect(result).toBe(seen[0]);
        expect(result).toEqual(await callTool(name, args()));
        expect(result).toMatchObject({ content: [expect.objectContaining({ type: 'text' })], isError: expect.any(Boolean) });
    });
    it('offers no tool for a bare server name in excludedTools (workerDenyTools: [t]) and keeps the server disabled', () => {
        const set = buildSdkInProcessTools(identitySdk, 't', buildSdkExcludedTools('t', ['t']), '');
        expect(set.tools).toEqual([]);
        expect(set.disabledMcpServer).toBe('t');
        expect(typeof set.cleanup).toBe('function');
    });
    // Timeline model of killBridgeWithEscalation: an identity check (cost
    // `poll`), each signal stage (cost `signal`), and waitForExit(t) polling
    // (poll + 100 ms sleep) until t has elapsed; worst case, the bridge never
    // exits before SIGKILL. Measured costs: win32 poll ~500 ms (PowerShell
    // CIM), taskkill ~340 ms; POSIX poll and kill are a few ms.
    const timeline = (budget, poll, signal) => {
        const wait = (t) => (t <= 0 ? 0 : Math.ceil(t / (poll + 100)) * (poll + 100));
        const sigkillAt = poll + signal + wait(budget.gracePeriodMs) + signal + wait(budget.sigtermGraceMs);
        return { sigkillAt, doneAt: sigkillAt + signal + wait(budget.finalWaitMs) };
    };
    it('escalates bridge cleanup to SIGKILL inside the host\'s 5 s cleanup deadline on POSIX', () => {
        const budget = bridgeCleanupBudget('linux');
        expect(budget).toEqual(bridgeCleanupBudget('darwin'));
        expect(budget.parallel).toBe(true);
        expect(budget.gracePeriodMs).toBeGreaterThan(0); // SIGINT/SIGTERM work on POSIX: keep a grace
        const { sigkillAt, doneAt } = timeline(budget, 5, 1);
        expect(sigkillAt).toBeLessThan(5_000);
        expect(doneAt).toBeLessThanOrEqual(4_000); // with margin for the LSP disconnect
    });
    it('goes straight to taskkill /F on win32, where /T without /F does not stop the bridge', () => {
        const budget = bridgeCleanupBudget('win32');
        expect(budget).toMatchObject({ gracePeriodMs: 0, sigtermGraceMs: 0, parallel: true });
        const { sigkillAt, doneAt } = timeline(budget, 500, 340);
        expect(sigkillAt).toBeLessThan(1_500);
        expect(doneAt).toBeLessThanOrEqual(4_000);
        // The POSIX budget on win32 sends /F only after ~4.8 s (measured) and finishes past the deadline.
        expect(timeline(bridgeCleanupBudget('linux'), 500, 340).doneAt).toBeGreaterThan(5_000);
    });
    it('returns null without the SDK converter, so the host keeps the MCP server', () => {
        expect(buildSdkInProcessTools({}, 't', [])).toBeNull();
        expect(buildSdkInProcessTools(null, 't', [])).toBeNull();
    });
    it('callTool keeps the server error contract', async () => {
        expect(await callTool('no_such_tool', {})).toEqual({ content: [{ type: 'text', text: 'Unknown tool: no_such_tool' }], isError: true });
        const boom = [{ name: 'boom', description: '', schema: {}, handler: async () => { throw new Error('bad'); } }];
        expect(await callTool('boom', {}, boom)).toEqual({ content: [{ type: 'text', text: 'Error: bad' }], isError: true });
    });
});
//# sourceMappingURL=sdk-inprocess-tools.test.js.map