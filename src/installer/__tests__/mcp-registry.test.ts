import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  getClaudeMcpConfigPath,
  getUnifiedMcpRegistryPath,
  getCodexConfigPath,
  inspectUnifiedMcpRegistrySync,
  syncUnifiedMcpRegistryTargets,
} from '../mcp-registry.js';

describe('unified MCP registry sync — headers (upstream PR #3054)', () => {
  let testRoot: string;
  let claudeDir: string;
  let codexDir: string;
  let omcDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    testRoot = mkdtempSync(join(tmpdir(), 'omc-mcp-registry-headers-'));
    claudeDir = join(testRoot, '.copilot');
    codexDir = join(testRoot, '.codex');
    omcDir = join(testRoot, '.omcp');

    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(omcDir, { recursive: true });
    process.env.COPILOT_CONFIG_DIR = claudeDir;
    process.env.CLAUDE_MCP_CONFIG_PATH = join(testRoot, '.claude.json');
    process.env.CODEX_HOME = codexDir;
    process.env.OMC_HOME = omcDir;
  });

  afterEach(() => {
    process.env = originalEnv;

    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('preserves HTTP MCP headers from .claude.json through registry, Claude rewrite, and Codex TOML', () => {
    const mcpServers = {
      remoteOmc: {
        url: 'https://lab.example.com/mcp',
        type: 'sse',
        headers: {
          Authorization: 'Bearer test-token',
          'X-Custom-Header': 'custom-value',
        },
        timeout: 30,
      },
    };
    writeFileSync(getClaudeMcpConfigPath(), JSON.stringify({
      mcpServers,
    }, null, 2));

    const { settings: syncedSettings, result } = syncUnifiedMcpRegistryTargets({ theme: 'dark' });

    expect(result.bootstrappedFromClaude).toBe(true);
    expect(result.serverNames).toEqual(['remoteOmc']);
    expect(syncedSettings).toEqual({ theme: 'dark' });
    expect(JSON.parse(readFileSync(getUnifiedMcpRegistryPath(), 'utf-8'))).toEqual(mcpServers);
    expect(JSON.parse(readFileSync(getClaudeMcpConfigPath(), 'utf-8'))).toEqual({
      mcpServers,
    });

    const codexConfig = readFileSync(getCodexConfigPath(), 'utf-8');
    expect(codexConfig).toContain('[mcp_servers.remoteOmc]');
    expect(codexConfig).toContain('url = "https://lab.example.com/mcp"');
    expect(codexConfig).toContain('type = "sse"');
    expect(codexConfig).toContain('[mcp_servers.remoteOmc.headers]');
    expect(codexConfig).toContain('Authorization = "Bearer test-token"');
    expect(codexConfig).toContain('X-Custom-Header = "custom-value"');

    const status = inspectUnifiedMcpRegistrySync();
    expect(status.claudeMismatched).toEqual([]);
    expect(status.codexMismatched).toEqual([]);
  });

  it('normalizes headers conservatively and drops invalid or empty header maps', () => {
    const settings = {
      mcpServers: {
        emptyHeaders: {
          url: 'https://empty.example.com/mcp',
          headers: {},
        },
        invalidHeaders: {
          url: 'https://invalid.example.com/mcp',
          headers: {
            Authorization: 123,
          },
        },
      },
    };

    syncUnifiedMcpRegistryTargets(settings);

    expect(JSON.parse(readFileSync(getUnifiedMcpRegistryPath(), 'utf-8'))).toEqual({
      emptyHeaders: {
        url: 'https://empty.example.com/mcp',
      },
      invalidHeaders: {
        url: 'https://invalid.example.com/mcp',
      },
    });
  });
});
