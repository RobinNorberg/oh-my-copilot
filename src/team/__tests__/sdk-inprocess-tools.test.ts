import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildListToolsResponse, callTool, getEnabledTools } from '../../mcp/tool-registry.js';
import { buildSdkInProcessTools } from '../sdk-inprocess-tools.js';

// Records what the SDK converter receives and returns it unchanged, so a
// handler's result is exactly the MCP CallTool result it converted.
const seen: unknown[] = [];
const identitySdk = { convertMcpCallToolResult: (r: unknown) => { seen.push(r); return r; } };

describe('sdk in-process tools: parity with the t MCP server', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'omg-inproc-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('offers every ListTools entry under its Copilot MCP name with the same description and schema', () => {
    const set = buildSdkInProcessTools(identitySdk, 't', ['t-host_smoke'], '')!;
    const mcp = buildListToolsResponse('').tools.filter((t) => t.name !== 'host_smoke');
    expect(set.disabledMcpServer).toBe('t');
    expect(set.tools.map((t) => t.name)).toEqual(mcp.map((t) => `t-${t.name}`));
    expect(set.tools.map((t) => ({ description: t.description, parameters: t.parameters })))
      .toEqual(mcp.map((t) => ({ description: t.description, parameters: t.inputSchema })));
    expect(set.tools.every((t) => t.skipPermission === true)).toBe(true);
    expect(set.tools).toHaveLength(getEnabledTools('').length - 1);
  });

  it('drops excluded names and honours the session OMC_DISABLE_TOOLS like the server', () => {
    const set = buildSdkInProcessTools(identitySdk, 't', ['t-host_smoke', 't-state_clear'], 'lsp,ast')!;
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
    const set = buildSdkInProcessTools(identitySdk, 't', [], '')!;
    const tool = set.tools.find((t) => t.name === `t-${name}`)!;
    seen.length = 0;
    const result = await tool.handler(args());
    expect(seen).toHaveLength(1);
    expect(result).toBe(seen[0]);
    expect(result).toEqual(await callTool(name, args()));
    expect(result).toMatchObject({ content: [expect.objectContaining({ type: 'text' })], isError: expect.any(Boolean) });
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
