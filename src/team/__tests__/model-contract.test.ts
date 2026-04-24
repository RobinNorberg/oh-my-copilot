import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'child_process';
import {
  getContract,
  buildLaunchArgs,
  buildWorkerArgv,
  getWorkerEnv,
  parseCliOutput,
  isPromptModeAgent,
  getPromptModeArgs,
  resolveClaudeWorkerModel,
  isCliAvailable,
  shouldLoadShellRc,
  resolveCliBinaryPath,
  clearResolvedPathCache,
  validateCliBinaryPath,
  _testInternals,
} from '../model-contract.js';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(actual.spawnSync),
  };
});

function setProcessPlatform(platform: NodeJS.Platform): () => void {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  return () => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  };
}

describe('model-contract', () => {
  describe('backward-compat API shims', () => {
    it('shouldLoadShellRc returns false for non-interactive compatibility mode', () => {
      expect(shouldLoadShellRc()).toBe(false);
    });

    it('resolveCliBinaryPath resolves and caches paths', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      mockSpawnSync.mockReturnValue({ status: 0, stdout: '/usr/local/bin/copilot\n', stderr: '', pid: 0, output: [], signal: null });

      clearResolvedPathCache();
      expect(resolveCliBinaryPath('copilot')).toBe('/usr/local/bin/copilot');
      expect(resolveCliBinaryPath('copilot')).toBe('/usr/local/bin/copilot');
      expect(mockSpawnSync).toHaveBeenCalledTimes(1);
      clearResolvedPathCache();
    });

    it('resolveCliBinaryPath rejects unsafe names and paths', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      expect(() => resolveCliBinaryPath('../evil')).toThrow('Invalid CLI binary name');

      mockSpawnSync.mockReturnValue({ status: 0, stdout: '/tmp/evil/copilot\n', stderr: '', pid: 0, output: [], signal: null });
      clearResolvedPathCache();
      expect(() => resolveCliBinaryPath('copilot')).toThrow('untrusted location');
      clearResolvedPathCache();
      mockSpawnSync.mockRestore();
    });

    it('validateCliBinaryPath returns compatibility result object', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      mockSpawnSync.mockReturnValue({ status: 0, stdout: '/usr/local/bin/copilot\n', stderr: '', pid: 0, output: [], signal: null });

      clearResolvedPathCache();
      expect(validateCliBinaryPath('copilot')).toEqual({
        valid: true,
        binary: 'copilot',
        resolvedPath: '/usr/local/bin/copilot',
      });

      mockSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'not found', pid: 0, output: [], signal: null });
      clearResolvedPathCache();
      const invalid = validateCliBinaryPath('missing-cli');
      expect(invalid.valid).toBe(false);
      expect(invalid.binary).toBe('missing-cli');
      expect(invalid.reason).toContain('not found in PATH');
      clearResolvedPathCache();
      mockSpawnSync.mockRestore();
    });

    it('exposes compatibility test internals for path policy', () => {
      expect(_testInternals.UNTRUSTED_PATH_PATTERNS.some(p => p.test('/tmp/evil'))).toBe(true);
      expect(_testInternals.UNTRUSTED_PATH_PATTERNS.some(p => p.test('/usr/local/bin/copilot'))).toBe(false);
      const prefixes = _testInternals.getTrustedPrefixes();
      expect(prefixes).toContain('/usr/local/bin');
      expect(prefixes).toContain('/usr/bin');
    });
  });
  describe('getContract', () => {
    it('returns contract for claude', () => {
      const c = getContract('claude');
      expect(c.agentType).toBe('claude');
      expect(c.binary).toBe('claude');
    });
    it('returns contract for copilot', () => {
      const cp = getContract('copilot');
      expect(cp.agentType).toBe('copilot');
      expect(cp.binary).toBe('copilot');
    });
    it('returns contract for codex', () => {
      const c = getContract('codex');
      expect(c.agentType).toBe('codex');
      expect(c.binary).toBe('codex');
    });
    it('returns contract for gemini', () => {
      const c = getContract('gemini');
      expect(c.agentType).toBe('gemini');
      expect(c.binary).toBe('gemini');
    });
    it('throws for unknown agent type', () => {
      expect(() => getContract('unknown' as any)).toThrow('Unknown agent type');
    });

    it('blocks codex when external LLM is disabled', async () => {
      const origSecurity = process.env.OMC_SECURITY;
      process.env.OMC_SECURITY = 'strict';
      try {
        const { clearSecurityConfigCache } = await import('../../lib/security-config.js');
        clearSecurityConfigCache();
        expect(() => getContract('codex')).toThrow('blocked by security policy');
      } finally {
        if (origSecurity === undefined) {
          delete process.env.OMC_SECURITY;
        } else {
          process.env.OMC_SECURITY = origSecurity;
        }
        const { clearSecurityConfigCache } = await import('../../lib/security-config.js');
        clearSecurityConfigCache();
      }
    });

    it('blocks gemini when external LLM is disabled', async () => {
      const origSecurity = process.env.OMC_SECURITY;
      process.env.OMC_SECURITY = 'strict';
      try {
        const { clearSecurityConfigCache } = await import('../../lib/security-config.js');
        clearSecurityConfigCache();
        expect(() => getContract('gemini')).toThrow('blocked by security policy');
      } finally {
        if (origSecurity === undefined) {
          delete process.env.OMC_SECURITY;
        } else {
          process.env.OMC_SECURITY = origSecurity;
        }
        const { clearSecurityConfigCache } = await import('../../lib/security-config.js');
        clearSecurityConfigCache();
      }
    });

    it('allows claude even when external LLM is disabled', async () => {
      const origSecurity = process.env.OMC_SECURITY;
      process.env.OMC_SECURITY = 'strict';
      try {
        const { clearSecurityConfigCache } = await import('../../lib/security-config.js');
        clearSecurityConfigCache();
        expect(() => getContract('claude')).not.toThrow();
      } finally {
        if (origSecurity === undefined) {
          delete process.env.OMC_SECURITY;
        } else {
          process.env.OMC_SECURITY = origSecurity;
        }
        const { clearSecurityConfigCache } = await import('../../lib/security-config.js');
        clearSecurityConfigCache();
      }
    });
  });

  describe('buildLaunchArgs', () => {
    it('copilot includes --dangerously-skip-permissions', () => {
      const args = buildLaunchArgs('claude', { teamName: 't', workerName: 'w', cwd: '/tmp' });
      expect(args).toContain('--dangerously-skip-permissions');
    });
    it('codex includes --dangerously-bypass-approvals-and-sandbox', () => {
      const args = buildLaunchArgs('codex', { teamName: 't', workerName: 'w', cwd: '/tmp' });
      expect(args[0]).toBe('exec');
      expect(args).not.toContain('--full-auto');
      expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    });
    it('gemini includes --approval-mode yolo', () => {
      const args = buildLaunchArgs('gemini', { teamName: 't', workerName: 'w', cwd: '/tmp' });
      expect(args).toContain('--approval-mode');
      expect(args).toContain('yolo');
      expect(args).not.toContain('-p');
    });
    it('passes model flag when specified', () => {
      const args = buildLaunchArgs('codex', { teamName: 't', workerName: 'w', cwd: '/tmp', model: 'gpt-4' });
      expect(args).toContain('--model');
      expect(args).toContain('gpt-4');
    });
  });

  describe('getWorkerEnv', () => {
    it('returns correct env vars', () => {
      const env = getWorkerEnv('my-team', 'worker-1', 'codex');
      expect(env.OMC_TEAM_WORKER).toBe('my-team/worker-1');
      expect(env.OMC_TEAM_NAME).toBe('my-team');
      expect(env.OMC_WORKER_AGENT_TYPE).toBe('codex');
    });

    it('propagates allowlisted model selection env vars into worker startup env', () => {
      const env = getWorkerEnv('my-team', 'worker-1', 'claude', {
        ANTHROPIC_MODEL: 'claude-opus-4-1',
        CLAUDE_MODEL: 'claude-sonnet-4-5',
        ANTHROPIC_BASE_URL: 'https://example-gateway.invalid',
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_BEDROCK_OPUS_MODEL: 'us.anthropic.claude-opus-4-6-v1:0',
        CLAUDE_CODE_BEDROCK_SONNET_MODEL: 'us.anthropic.claude-sonnet-4-6-v1:0',
        CLAUDE_CODE_BEDROCK_HAIKU_MODEL: 'us.anthropic.claude-haiku-4-5-v1:0',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-6-custom',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6-custom',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5-custom',
        OMC_MODEL_HIGH: 'claude-opus-4-6-override',
        OMC_MODEL_MEDIUM: 'claude-sonnet-4-6-override',
        OMC_MODEL_LOW: 'claude-haiku-4-5-override',
        OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL: 'gpt-5',
        OMC_GEMINI_DEFAULT_MODEL: 'gemini-2.5-pro',
        ANTHROPIC_API_KEY: 'should-not-be-forwarded',
      });

      expect(env.ANTHROPIC_MODEL).toBe('claude-opus-4-1');
      expect(env.CLAUDE_MODEL).toBe('claude-sonnet-4-5');
      expect(env.ANTHROPIC_BASE_URL).toBe('https://example-gateway.invalid');
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
      expect(env.CLAUDE_CODE_BEDROCK_OPUS_MODEL).toBe('us.anthropic.claude-opus-4-6-v1:0');
      expect(env.CLAUDE_CODE_BEDROCK_SONNET_MODEL).toBe('us.anthropic.claude-sonnet-4-6-v1:0');
      expect(env.CLAUDE_CODE_BEDROCK_HAIKU_MODEL).toBe('us.anthropic.claude-haiku-4-5-v1:0');
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4-6-custom');
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-sonnet-4-6-custom');
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5-custom');
      expect(env.OMC_MODEL_HIGH).toBe('claude-opus-4-6-override');
      expect(env.OMC_MODEL_MEDIUM).toBe('claude-sonnet-4-6-override');
      expect(env.OMC_MODEL_LOW).toBe('claude-haiku-4-5-override');
      expect(env.OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL).toBe('gpt-5');
      expect(env.OMC_GEMINI_DEFAULT_MODEL).toBe('gemini-2.5-pro');
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('rejects invalid team names', () => {
      expect(() => getWorkerEnv('Bad-Team', 'worker-1', 'codex')).toThrow('Invalid team name');
    });
  });

  describe('buildWorkerArgv', () => {
    it('builds codex interactive worker argv without the exec subcommand', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      mockSpawnSync.mockReturnValueOnce({ status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null } as any);

      expect(buildWorkerArgv('codex', { teamName: 'my-team', workerName: 'worker-1', cwd: '/tmp' })).toEqual([
        'codex',
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
      ]);
      expect(buildWorkerArgv('codex', { teamName: 'my-team', workerName: 'worker-1', cwd: '/tmp' })).not.toContain('exec');
      expect(mockSpawnSync).toHaveBeenCalledWith('which', ['codex'], { timeout: 5000, encoding: 'utf8' });
      mockSpawnSync.mockRestore();
    });

    it('builds claude interactive worker argv without the exec subcommand', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      mockSpawnSync.mockReturnValueOnce({ status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null } as any);

      const argv = buildWorkerArgv('claude', { teamName: 'my-team', workerName: 'worker-1', cwd: '/tmp' });

      expect(argv[0]).toBe('claude');
      expect(argv).toContain('--dangerously-skip-permissions');
      expect(argv).not.toContain('exec');
      expect(mockSpawnSync).toHaveBeenCalledWith('which', ['claude'], { timeout: 5000, encoding: 'utf8' });
      mockSpawnSync.mockRestore();
    });

    it('prefers resolved absolute binary path when available', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: '/usr/local/bin/codex\n', stderr: '', pid: 0, output: [], signal: null } as any);

      expect(buildWorkerArgv('codex', { teamName: 'my-team', workerName: 'worker-1', cwd: '/tmp' })[0]).toBe('/usr/local/bin/codex');
      mockSpawnSync.mockRestore();
    });
  });

  describe('parseCliOutput', () => {
    it('copilot returns trimmed output', () => {
      expect(parseCliOutput('claude', '  hello  ')).toBe('hello');
    });
    it('codex extracts result from JSONL', () => {
      const jsonl = JSON.stringify({ type: 'result', output: 'the answer' });
      expect(parseCliOutput('codex', jsonl)).toBe('the answer');
    });
    it('codex falls back to raw output if no JSONL', () => {
      expect(parseCliOutput('codex', 'plain text')).toBe('plain text');
    });
  });

  describe('isCliAvailable', () => {
    it('checks version without shell:true for standard binaries', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      const restorePlatform = setProcessPlatform('linux');
      mockSpawnSync.mockReset();
      mockSpawnSync
        .mockReturnValueOnce({ status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null } as any)
        .mockReturnValueOnce({ status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null } as any);

      isCliAvailable('codex');

      expect(mockSpawnSync).toHaveBeenNthCalledWith(1, 'which', ['codex'], { timeout: 5000, encoding: 'utf8' });
      expect(mockSpawnSync).toHaveBeenNthCalledWith(2, 'codex', ['--version'], { timeout: 5000, shell: false });
      restorePlatform();
      mockSpawnSync.mockRestore();
    });

    it('uses COMSPEC for .cmd binaries on win32', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      const restorePlatform = setProcessPlatform('win32');
      vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
      mockSpawnSync.mockReset();

      mockSpawnSync
        .mockReturnValueOnce({ status: 0, stdout: 'C:\\Tools\\codex.cmd\n', stderr: '', pid: 0, output: [], signal: null } as any)
        .mockReturnValueOnce({ status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null } as any);

      isCliAvailable('codex');

      expect(mockSpawnSync).toHaveBeenNthCalledWith(1, 'where', ['codex'], { timeout: 5000, encoding: 'utf8' });
      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        2,
        'C:\\Windows\\System32\\cmd.exe',
        ['/d', '/s', '/c', '"C:\\Tools\\codex.cmd" --version'],
        { timeout: 5000 }
      );
      restorePlatform();
      mockSpawnSync.mockRestore();
      vi.unstubAllEnvs();
    });

    it('uses shell:true for unresolved binaries on win32', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      const restorePlatform = setProcessPlatform('win32');
      mockSpawnSync.mockReset();

      mockSpawnSync
        .mockReturnValueOnce({ status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null } as any)
        .mockReturnValueOnce({ status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null } as any);

      isCliAvailable('gemini');

      expect(mockSpawnSync).toHaveBeenNthCalledWith(1, 'where', ['gemini'], { timeout: 5000, encoding: 'utf8' });
      expect(mockSpawnSync).toHaveBeenNthCalledWith(2, 'gemini', ['--version'], { timeout: 5000, shell: true });
      restorePlatform();
      mockSpawnSync.mockRestore();
    });
  });

  describe('prompt mode (headless TUI bypass)', () => {
    it('gemini supports prompt mode', () => {
      expect(isPromptModeAgent('gemini')).toBe(true);
      const c = getContract('gemini');
      expect(c.supportsPromptMode).toBe(true);
      expect(c.promptModeFlag).toBe('-p');
    });

    it('copilot does not support prompt mode', () => {
      expect(isPromptModeAgent('claude')).toBe(false);
    });

    it('codex launches as a persistent interactive worker, not prompt/exec mode', () => {
      expect(isPromptModeAgent('codex')).toBe(false);
      const c = getContract('codex');
      expect(c.supportsPromptMode).toBe(false);
      expect(c.promptModeFlag).toBeUndefined();
    });

    it('getPromptModeArgs returns flag + instruction for gemini', () => {
      const args = getPromptModeArgs('gemini', 'Read inbox');
      expect(args).toEqual(['-p', 'Read inbox']);
    });

    it('getPromptModeArgs returns empty array for interactive codex and claude workers', () => {
      expect(getPromptModeArgs('codex', 'Read inbox')).toEqual([]);
      expect(getPromptModeArgs('claude', 'Read inbox')).toEqual([]);
    });
  });

  describe('resolveClaudeWorkerModel (forceInherit)', () => {
    it('returns undefined when OMC_ROUTING_FORCE_INHERIT=true even if model env vars are set', () => {
      expect(resolveClaudeWorkerModel({
        OMC_ROUTING_FORCE_INHERIT: 'true',
        ANTHROPIC_MODEL: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        CLAUDE_MODEL: 'us.anthropic.claude-opus-4-6-v1:0',
      })).toBeUndefined();
    });

    it('returns undefined when OMC_ROUTING_FORCE_INHERIT=true with no model vars', () => {
      expect(resolveClaudeWorkerModel({
        OMC_ROUTING_FORCE_INHERIT: 'true',
      })).toBeUndefined();
    });

    it('returns explicit model when OMC_ROUTING_FORCE_INHERIT is not set', () => {
      const result = resolveClaudeWorkerModel({
        ANTHROPIC_MODEL: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      });
      expect(result).toBe('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    });

    it('returns undefined when no model env vars and no forceInherit', () => {
      expect(resolveClaudeWorkerModel({})).toBeUndefined();
    });
  });
});
