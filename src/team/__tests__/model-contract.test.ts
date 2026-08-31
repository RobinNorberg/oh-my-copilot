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
  isHeadlessSupportedOnPlatform,
  validateCliAvailable,
  isCliAvailable,
  shouldLoadShellRc,
  resolveCliBinaryPath,
  clearResolvedPathCache,
  validateCliBinaryPath,
  resolveClaudeWorkerModel,
  shouldUseClaudeBareMode,
  _testInternals,
  buildValidatedWorkerLaunchDescriptor,
  validateWorkerLaunchDescriptor,
} from '../model-contract.js';
import type { CliAgentType } from '../model-contract.js';

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

function withAnthropicApiKey(value: string | undefined, fn: () => void): void {
  const original = process.env.ANTHROPIC_API_KEY;
  if (value === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = value;
  }
  try {
    fn();
  } finally {
    if (original === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = original;
    }
  }
}

function countArg(args: string[], expected: string): number {
  return args.filter(arg => arg === expected).length;
}

describe('model-contract', () => {
  describe('backward-compat API shims', () => {
    it('shouldLoadShellRc returns false for non-interactive compatibility mode', () => {
      expect(shouldLoadShellRc()).toBe(false);
    });

    it('resolveCliBinaryPath resolves and caches paths', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      const restorePlatform = setProcessPlatform('linux');
      mockSpawnSync.mockClear();
      mockSpawnSync.mockReturnValue({ status: 0, stdout: '/usr/local/bin/claude\n', stderr: '', pid: 0, output: [], signal: null });

      clearResolvedPathCache();
      expect(resolveCliBinaryPath('claude')).toBe('/usr/local/bin/claude');
      expect(resolveCliBinaryPath('claude')).toBe('/usr/local/bin/claude');
      expect(mockSpawnSync).toHaveBeenCalledTimes(1);
      clearResolvedPathCache();
      restorePlatform();
    });

    it('resolveCliBinaryPath rejects unsafe names and paths', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      const restorePlatform = setProcessPlatform('linux');
      expect(() => resolveCliBinaryPath('../evil')).toThrow('Invalid CLI binary name');

      mockSpawnSync.mockReturnValue({ status: 0, stdout: '/tmp/evil/claude\n', stderr: '', pid: 0, output: [], signal: null });
      clearResolvedPathCache();
      expect(() => resolveCliBinaryPath('claude')).toThrow('untrusted location');
      clearResolvedPathCache();
      restorePlatform();
      mockSpawnSync.mockRestore();
    });

    it('validateCliBinaryPath returns compatibility result object', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      const restorePlatform = setProcessPlatform('linux');
      mockSpawnSync.mockReturnValue({ status: 0, stdout: '/usr/local/bin/claude\n', stderr: '', pid: 0, output: [], signal: null });

      clearResolvedPathCache();
      expect(validateCliBinaryPath('claude')).toEqual({
        valid: true,
        binary: 'claude',
        resolvedPath: '/usr/local/bin/claude',
      });

      mockSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'not found', pid: 0, output: [], signal: null });
      clearResolvedPathCache();
      const invalid = validateCliBinaryPath('missing-cli');
      expect(invalid.valid).toBe(false);
      expect(invalid.binary).toBe('missing-cli');
      expect(invalid.reason).toContain('not found in PATH');
      clearResolvedPathCache();
      restorePlatform();
      mockSpawnSync.mockRestore();
    });

    it('exposes compatibility test internals for path policy', () => {
      const restorePlatform = setProcessPlatform('linux');
      try {
        expect(_testInternals.UNTRUSTED_PATH_PATTERNS.some(p => p.test('/tmp/evil'))).toBe(true);
        expect(_testInternals.UNTRUSTED_PATH_PATTERNS.some(p => p.test('/usr/local/bin/claude'))).toBe(false);
        const prefixes = _testInternals.getTrustedPrefixes();
        expect(prefixes).toContain('/usr/local/bin');
        expect(prefixes).toContain('/usr/bin');
      } finally {
        restorePlatform();
      }
    });

    it('isTrustedPrefix enforces directory boundaries (no sibling-prefix bypass)', () => {
      const origHome = process.env.HOME;
      const restorePlatform = setProcessPlatform('linux');
      process.env.HOME = '/home/tester';
      try {
        const { isTrustedPrefix } = _testInternals;
        // exact trusted dir + true descendants are trusted
        expect(isTrustedPrefix('/usr/bin')).toBe(true);
        expect(isTrustedPrefix('/usr/bin/codex')).toBe(true);
        expect(isTrustedPrefix('/usr/local/bin/claude')).toBe(true);
        expect(isTrustedPrefix('/opt/homebrew/bin/gemini')).toBe(true);
        expect(isTrustedPrefix('/home/tester/.local/bin/cli')).toBe(true);
        // siblings whose name merely begins with a trusted prefix are NOT trusted
        expect(isTrustedPrefix('/usr/bin-malicious/cli')).toBe(false);
        expect(isTrustedPrefix('/home/tester/.local/bin-evil/cli')).toBe(false);
        expect(isTrustedPrefix('/opt/homebrew-evil/x')).toBe(false);
        expect(isTrustedPrefix('/home/tester/Downloads/cli')).toBe(false);
        // custom trusted dirs (OMC_TRUSTED_CLI_DIRS) get the same boundary check
        const origCustom = process.env.OMC_TRUSTED_CLI_DIRS;
        process.env.OMC_TRUSTED_CLI_DIRS = '/opt/mybins';
        try {
          expect(isTrustedPrefix('/opt/mybins/grok')).toBe(true);
          expect(isTrustedPrefix('/opt/mybins-evil/grok')).toBe(false);
        } finally {
          if (origCustom === undefined) delete process.env.OMC_TRUSTED_CLI_DIRS;
          else process.env.OMC_TRUSTED_CLI_DIRS = origCustom;
        }
      } finally {
        restorePlatform();
        if (origHome === undefined) delete process.env.HOME;
        else process.env.HOME = origHome;
      }
    });

    it('treats Windows temp and Downloads locations as untrusted', () => {
      const restorePlatform = setProcessPlatform('win32');
      try {
        const patterns = _testInternals.untrustedPathPatterns();
        const untrusted = (p: string) => patterns.some(pattern => pattern.test(p));

        expect(untrusted('C:\\Users\\me\\AppData\\Local\\Temp\\claude.exe')).toBe(true);
        expect(untrusted('C:\\Windows\\Temp\\claude.exe')).toBe(true);
        expect(untrusted('C:\\Users\\me\\Downloads\\claude.exe')).toBe(true);
        // Case-insensitive, as the filesystem is.
        expect(untrusted('C:\\Users\\me\\appdata\\local\\temp\\claude.exe')).toBe(true);
        // A legitimate install location stays trusted.
        expect(untrusted('C:\\Program Files\\nodejs\\claude.exe')).toBe(false);
        // A directory that merely contains the word is not a temp segment.
        expect(untrusted('C:\\Tools\\contemporary\\claude.exe')).toBe(false);
      } finally {
        restorePlatform();
      }
    });

    it('leaves the POSIX untrusted list unchanged off win32', () => {
      const restorePlatform = setProcessPlatform('linux');
      try {
        const patterns = _testInternals.untrustedPathPatterns();
        const untrusted = (p: string) => patterns.some(pattern => pattern.test(p));

        expect(untrusted('/tmp/claude')).toBe(true);
        // Windows segment rules must not start rejecting POSIX paths.
        expect(untrusted('/home/user/Downloads/claude')).toBe(false);
        expect(untrusted('/usr/local/temp/claude')).toBe(false);
      } finally {
        restorePlatform();
      }
    });

    it('trusts standard Windows install roots and splits OMC_TRUSTED_CLI_DIRS on ;', () => {
      const restorePlatform = setProcessPlatform('win32');
      vi.stubEnv('USERPROFILE', 'C:\\Users\\tester');
      vi.stubEnv('APPDATA', 'C:\\Users\\tester\\AppData\\Roaming');
      vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\tester\\AppData\\Local');
      vi.stubEnv('ProgramFiles', 'C:\\Program Files');
      vi.stubEnv('OMC_TRUSTED_CLI_DIRS', 'C:\\Tools\\bin;D:\\Shared\\cli');
      try {
        const { isTrustedPrefix } = _testInternals;
        expect(isTrustedPrefix('C:\\Users\\tester\\AppData\\Roaming\\npm\\claude.cmd')).toBe(true);
        expect(isTrustedPrefix('C:\\Program Files\\nodejs\\codex.cmd')).toBe(true);
        expect(isTrustedPrefix('C:\\Users\\tester\\.cargo\\bin\\grok.exe')).toBe(true);
        // A drive-lettered custom dir survives the split instead of being shredded into 'C'.
        expect(isTrustedPrefix('C:\\Tools\\bin\\gemini.exe')).toBe(true);
        expect(isTrustedPrefix('D:\\Shared\\cli\\gemini.exe')).toBe(true);
        // Windows paths compare case-insensitively, the way the filesystem does.
        expect(isTrustedPrefix('c:\\program files\\NODEJS\\codex.cmd')).toBe(true);
        // Sibling directories that merely share a name prefix stay untrusted.
        expect(isTrustedPrefix('C:\\Tools\\bin-evil\\gemini.exe')).toBe(false);
        expect(isTrustedPrefix('C:\\Users\\tester\\Downloads\\claude.exe')).toBe(false);
      } finally {
        restorePlatform();
        vi.unstubAllEnvs();
      }
    });
  });
  describe('getContract', () => {
    it('returns contract for claude', () => {
      const c = getContract('claude');
      expect(c.agentType).toBe('claude');
      expect(c.binary).toBe('claude');
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
    it('returns contract for grok', () => {
      const c = getContract('grok');
      expect(c.agentType).toBe('grok');
      expect(c.binary).toBe('grok');
      expect(c.supportsPromptMode).toBe(true);
    });
    it('returns contract for antigravity', () => {
      const c = getContract('antigravity');
      expect(c.agentType).toBe('antigravity');
      expect(c.binary).toBe('agy');
      expect(c.supportsPromptMode).toBe(true);
      expect(c.promptModeFlag).toBe('-p');
      // Points to official install instructions, not a raw pipe-to-shell command.
      expect(c.installInstructions).toContain('antigravity.google');
      expect(c.installInstructions).not.toContain('| bash');
    });
    it('throws for unknown agent type', () => {
      expect(() => getContract('unknown' as any)).toThrow('Unknown agent type');
    });

    describe('antigravity Windows headless guard (omc team)', () => {
      it('reports antigravity headless unsupported on win32, supported elsewhere', () => {
        expect(isHeadlessSupportedOnPlatform('antigravity', 'win32')).toBe(false);
        expect(isHeadlessSupportedOnPlatform('antigravity', 'darwin')).toBe(true);
        expect(isHeadlessSupportedOnPlatform('antigravity', 'linux')).toBe(true);
        // Other prompt-mode providers stay supported on Windows.
        expect(isHeadlessSupportedOnPlatform('gemini', 'win32')).toBe(true);
        expect(isHeadlessSupportedOnPlatform('grok', 'win32')).toBe(true);
      });

      it('getPromptModeArgs throws for an antigravity team worker on Windows', () => {
        const restore = setProcessPlatform('win32');
        try {
          expect(() => getPromptModeArgs('antigravity', '/path/to/inbox.md')).toThrow(/not supported on Windows/);
          // Still works for gemini on Windows (uses its own stdin-safe handling elsewhere).
          expect(getPromptModeArgs('gemini', '/path/to/inbox.md')).toEqual(['-p', '/path/to/inbox.md']);
        } finally {
          restore();
        }
      });

      it('getPromptModeArgs builds antigravity args normally on non-Windows', () => {
        const restore = setProcessPlatform('darwin');
        try {
          expect(getPromptModeArgs('antigravity', '/path/to/inbox.md')).toEqual(['-p', '/path/to/inbox.md']);
        } finally {
          restore();
        }
      });

      it('validateCliAvailable refuses antigravity on Windows with a clear message', () => {
        const restore = setProcessPlatform('win32');
        try {
          expect(() => validateCliAvailable('antigravity')).toThrow(/not supported on Windows/);
        } finally {
          restore();
        }
      });
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

    it('blocks grok when external LLM is disabled', async () => {
      const origSecurity = process.env.OMC_SECURITY;
      process.env.OMC_SECURITY = 'strict';
      try {
        const { clearSecurityConfigCache } = await import('../../lib/security-config.js');
        clearSecurityConfigCache();
        expect(() => getContract('grok')).toThrow('blocked by security policy');
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
    it('claude includes --dangerously-skip-permissions', () => {
      const args = buildLaunchArgs('claude', { teamName: 't', workerName: 'w', cwd: '/tmp' });
      expect(args).toContain('--dangerously-skip-permissions');
    });
    it('detects Claude bare mode only for non-empty ANTHROPIC_API_KEY', () => {
      expect(shouldUseClaudeBareMode({ ANTHROPIC_API_KEY: 'sk-test' })).toBe(true);
      expect(shouldUseClaudeBareMode({ ANTHROPIC_API_KEY: '' })).toBe(false);
      expect(shouldUseClaudeBareMode({ ANTHROPIC_API_KEY: '   ' })).toBe(false);
      expect(shouldUseClaudeBareMode({})).toBe(false);
    });
    it('claude omits --bare when ANTHROPIC_API_KEY is absent, empty, or whitespace', () => {
      for (const value of [undefined, '', '   ']) {
        withAnthropicApiKey(value, () => {
          const args = buildLaunchArgs('claude', { teamName: 't', workerName: 'w', cwd: '/tmp' });
          expect(args).toContain('--dangerously-skip-permissions');
          expect(args).not.toContain('--bare');
        });
      }
    });
    it('claude includes --bare with API-key auth and dedupes exact extra flag', () => {
      withAnthropicApiKey('sk-test', () => {
        const args = buildLaunchArgs('claude', { teamName: 't', workerName: 'w', cwd: '/tmp' });
        expect(args).toContain('--dangerously-skip-permissions');
        expect(args).toContain('--bare');
        expect(countArg(args, '--bare')).toBe(1);

        const deduped = buildLaunchArgs('claude', {
          teamName: 't',
          workerName: 'w',
          cwd: '/tmp',
          extraFlags: ['--bare'],
        });
        expect(countArg(deduped, '--bare')).toBe(1);
      });
    });
    it('codex includes --dangerously-bypass-approvals-and-sandbox', () => {
      const args = buildLaunchArgs('codex', { teamName: 't', workerName: 'w', cwd: '/tmp' });
      expect(args).not.toContain('exec');
      expect(args).not.toContain('--full-auto');
      expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    });
    it('gemini includes --approval-mode yolo', () => {
      const args = buildLaunchArgs('gemini', { teamName: 't', workerName: 'w', cwd: '/tmp' });
      expect(args).toContain('--approval-mode');
      expect(args).toContain('yolo');
      expect(args).not.toContain('-p');
    });
    it('antigravity leads with --dangerously-skip-permissions (no --print; -p is appended later by getPromptModeArgs)', () => {
      const noModel = buildLaunchArgs('antigravity', { teamName: 't', workerName: 'w', cwd: '/tmp' });
      expect(noModel).toEqual(['--dangerously-skip-permissions']);
      expect(noModel).not.toContain('--model');
      // -p is NOT in buildLaunchArgs: agy's -p takes the prompt as its value and
      // is appended (with the instruction) by getPromptModeArgs.
      expect(noModel).not.toContain('-p');
      expect(noModel).not.toContain('--print');

      const withModel = buildLaunchArgs('antigravity', { teamName: 't', workerName: 'w', cwd: '/tmp', model: 'Gemini 3.1 Pro (High)' });
      expect(withModel).toEqual(['--dangerously-skip-permissions', '--model', 'Gemini 3.1 Pro (High)']);
      // approval flag precedes --model
      expect(withModel.indexOf('--dangerously-skip-permissions')).toBeLessThan(withModel.indexOf('--model'));
    });
    it('antigravity appends extraFlags after the model flag', () => {
      const args = buildLaunchArgs('antigravity', { teamName: 't', workerName: 'w', cwd: '/tmp', model: 'm', extraFlags: ['--foo'] });
      expect(args).toEqual(['--dangerously-skip-permissions', '--model', 'm', '--foo']);
    });
    it('grok includes --always-approve with no model and appends --model <m> when given', () => {
      const noModel = buildLaunchArgs('grok', { teamName: 't', workerName: 'w', cwd: '/tmp' });
      expect(noModel).toEqual(['--always-approve']);
      expect(noModel).not.toContain('--model');

      const withModel = buildLaunchArgs('grok', { teamName: 't', workerName: 'w', cwd: '/tmp', model: 'grok-4-fast' });
      expect(withModel).toEqual(['--always-approve', '--model', 'grok-4-fast']);
    });
    it('cursor leads with --force --trust and appends --model <m> when given (issue #3880)', () => {
      const noModel = buildLaunchArgs('cursor', { teamName: 't', workerName: 'w', cwd: '/tmp' });
      expect(noModel).toEqual(['--force', '--trust']);
      expect(noModel).not.toContain('--model');

      const emptyModel = buildLaunchArgs('cursor', { teamName: 't', workerName: 'w', cwd: '/tmp', model: '' });
      expect(emptyModel).toEqual(['--force', '--trust']);
      expect(emptyModel).not.toContain('--model');

      const withModel = buildLaunchArgs('cursor', { teamName: 't', workerName: 'w', cwd: '/tmp', model: 'cursor-grok-4.6-high' });
      expect(withModel).toEqual(['--force', '--trust', '--model', 'cursor-grok-4.6-high']);
    });
    it('cursor appends extraFlags after the model flag (issue #3880)', () => {
      const args = buildLaunchArgs('cursor', { teamName: 't', workerName: 'w', cwd: '/tmp', model: 'composer-2.5', extraFlags: ['--foo'] });
      expect(args).toEqual(['--force', '--trust', '--model', 'composer-2.5', '--foo']);

      const noModel = buildLaunchArgs('cursor', { teamName: 't', workerName: 'w', cwd: '/tmp', extraFlags: ['--foo'] });
      expect(noModel).toEqual(['--force', '--trust', '--foo']);
    });
    it('cursor keeps required trust flags singular when extra flags repeat them', () => {
      const args = buildLaunchArgs('cursor', {
        teamName: 't', workerName: 'w', cwd: '/tmp',
        extraFlags: ['--trust', '--force', '--trust', '--foo'],
      });
      expect(args).toEqual(['--force', '--trust', '--foo']);
      expect(countArg(args, '--force')).toBe(1);
      expect(countArg(args, '--trust')).toBe(1);
    });
    it('cursor removes documented force aliases from extra flags', () => {
      const args = buildLaunchArgs('cursor', {
        teamName: 't', workerName: 'w', cwd: '/tmp',
        extraFlags: ['-f', '--yolo', '--force', '--trust'],
      });
      expect(args).toEqual(['--force', '--trust']);
    });
    it('cursor worker argv leads with the cursor-agent binary then approval flags', () => {
      const argv = buildWorkerArgv('cursor', {
        teamName: 'cursor-team', workerName: 'w', cwd: '/tmp',
        model: 'cursor-grok-4.6-high', resolvedBinaryPath: '/usr/local/bin/cursor-agent',
      });
      expect(argv).toEqual([
        '/usr/local/bin/cursor-agent', '--force', '--trust', '--model', 'cursor-grok-4.6-high',
      ]);
    });
    it('every CLI provider carries an approval-bypass flag so no worker pane can block on a prompt', () => {
      // A team worker pane has nobody to answer an approval or trust question.
      // cursor was the sole provider launched bare, which stranded it on
      // "Workspace Trust Required" in any directory cursor had not seen before.
      const approvalFlags: Record<string, string> = {
        claude: '--dangerously-skip-permissions',
        codex: '--dangerously-bypass-approvals-and-sandbox',
        gemini: '--approval-mode',
        grok: '--always-approve',
        antigravity: '--dangerously-skip-permissions',
        cursor: '--trust',
      };
      for (const [agent, flag] of Object.entries(approvalFlags)) {
        const args = buildLaunchArgs(agent as CliAgentType, { teamName: 't', workerName: 'w', cwd: '/tmp' });
        expect(args, `${agent} must bypass approval prompts`).toContain(flag);
      }
    });
    it('passes model flag when specified', () => {
      const args = buildLaunchArgs('codex', { teamName: 't', workerName: 'w', cwd: '/tmp', model: 'gpt-4' });
      expect(args).toContain('--model');
      expect(args).toContain('gpt-4');
    });
    it('normalizes full Claude model ID to alias for claude agent (issue #1415)', () => {
      const args = buildLaunchArgs('claude', { teamName: 't', workerName: 'w', cwd: '/tmp', model: 'claude-sonnet-4-6' });
      expect(args).toContain('--model');
      expect(args).toContain('sonnet');
      expect(args).not.toContain('claude-sonnet-4-6');
    });
    it('passes Bedrock model ID through without normalization for claude agent (issue #1695)', () => {
      withAnthropicApiKey('sk-test', () => {
        const args = buildLaunchArgs('claude', { teamName: 't', workerName: 'w', cwd: '/tmp', model: 'us.anthropic.claude-opus-4-6-v1:0' });
        expect(args).toContain('--bare');
        expect(countArg(args, '--bare')).toBe(1);
        expect(args).toContain('--model');
        expect(args).toContain('us.anthropic.claude-opus-4-6-v1:0');
        expect(args).not.toContain('opus');
      });
    });
    it('passes Bedrock ARN model ID through without normalization (issue #1695)', () => {
      const arn = 'arn:aws:bedrock:us-east-2:123456789012:inference-profile/global.anthropic.claude-sonnet-4-6-v1:0';
      const args = buildLaunchArgs('claude', { teamName: 't', workerName: 'w', cwd: '/tmp', model: arn });
      expect(args).toContain('--model');
      expect(args).toContain(arn);
    });
    it('passes Vertex AI model ID through without normalization (issue #1695)', () => {
      const args = buildLaunchArgs('claude', { teamName: 't', workerName: 'w', cwd: '/tmp', model: 'vertex_ai/claude-sonnet-4-6@20250514' });
      expect(args).toContain('--model');
      expect(args).toContain('vertex_ai/claude-sonnet-4-6@20250514');
      expect(args).not.toContain('sonnet');
    });
    it('does not normalize non-Claude models for codex/gemini agents', () => {
      const args = buildLaunchArgs('codex', { teamName: 't', workerName: 'w', cwd: '/tmp', model: 'gpt-4o' });
      expect(args).toContain('gpt-4o');
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
    // resolveCliPath picks the platform's PATH finder; Windows uses where.exe.
    const expectedFinder = process.platform === 'win32' ? 'where.exe' : 'which';

    it('builds codex interactive worker argv without the exec subcommand', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      mockSpawnSync.mockReturnValueOnce({ status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null } as any);

      const argv = buildWorkerArgv('codex', { teamName: 'my-team', workerName: 'worker-1', cwd: '/tmp' });
      expect(argv).toEqual([
        'codex',
        '--dangerously-bypass-approvals-and-sandbox',
      ]);
      expect(argv).not.toContain('exec');
      expect(mockSpawnSync).toHaveBeenCalledWith(
        expectedFinder,
        ['codex'],
        expect.objectContaining({ timeout: 5000, encoding: 'utf8', shell: false, windowsHide: true }),
      );
      mockSpawnSync.mockRestore();
    });

    it('builds claude interactive worker argv without the exec subcommand', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      mockSpawnSync.mockReturnValueOnce({ status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null } as any);

      let argv: string[] = [];
      withAnthropicApiKey('sk-test', () => {
        argv = buildWorkerArgv('claude', { teamName: 'my-team', workerName: 'worker-1', cwd: '/tmp' });
      });

      expect(argv[0]).toBe('claude');
      expect(argv).toContain('--dangerously-skip-permissions');
      expect(argv).toContain('--bare');
      expect(countArg(argv, '--bare')).toBe(1);
      expect(argv).not.toContain('exec');
      expect(mockSpawnSync).toHaveBeenCalledWith(
        expectedFinder,
        ['claude'],
        expect.objectContaining({ timeout: 5000, encoding: 'utf8', shell: false, windowsHide: true }),
      );
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
    it('claude returns trimmed output', () => {
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
      clearResolvedPathCache();
      mockSpawnSync.mockClear();
      mockSpawnSync
        .mockReturnValueOnce({ status: 0, stdout: '/usr/local/bin/codex\n', stderr: '', pid: 0, output: [], signal: null } as any)
        .mockReturnValueOnce({ status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null } as any);

      isCliAvailable('codex');

      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        1,
        'which',
        ['codex'],
        { timeout: 5000, encoding: 'utf8', shell: false, windowsHide: true },
      );
      // The resolved absolute path is probed, never the bare name.
      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        2,
        '/usr/local/bin/codex',
        ['--version'],
        { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true },
      );
      restorePlatform();
      clearResolvedPathCache();
      mockSpawnSync.mockRestore();
    });

    it('falls back to COMSPEC when a .cmd shim refuses to start directly on win32', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      const restorePlatform = setProcessPlatform('win32');
      vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
      clearResolvedPathCache();
      mockSpawnSync.mockClear();

      mockSpawnSync
        .mockReturnValueOnce({ status: 0, stdout: 'C:\\Tools\\codex.cmd\n', stderr: '', pid: 0, output: [], signal: null } as any)
        // Node cannot exec a .cmd shim directly; it reports EINVAL without ever starting.
        .mockReturnValueOnce({ status: null, stdout: '', stderr: '', pid: 0, output: [], signal: null, error: Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' }) } as any)
        .mockReturnValueOnce({ status: 0, stdout: 'codex 1.2.3\n', stderr: '', pid: 0, output: [], signal: null } as any);

      expect(isCliAvailable('codex')).toBe(true);

      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        1,
        'where.exe',
        ['codex'],
        // cwd is the Windows directory, never the inherited one: where.exe
        // searches the current directory before PATH.
        expect.objectContaining({
          timeout: 5000, encoding: 'utf8', shell: false, windowsHide: true, cwd: expect.any(String),
        }),
      );
      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        3,
        'C:\\Windows\\System32\\cmd.exe',
        ['/d', '/v:off', '/s', '/c', '""C:\\Tools\\codex.cmd" --version"'],
        expect.objectContaining({ timeout: 5000, shell: false, windowsVerbatimArguments: true }),
      );
      restorePlatform();
      clearResolvedPathCache();
      mockSpawnSync.mockRestore();
      vi.unstubAllEnvs();
    });

    it('reports unavailable instead of shelling out to a bare name on win32', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      const restorePlatform = setProcessPlatform('win32');
      clearResolvedPathCache();
      mockSpawnSync.mockClear();

      // where.exe cannot resolve it.
      mockSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null } as any);

      expect(isCliAvailable('gemini')).toBe(false);

      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        1,
        'where.exe',
        ['gemini'],
        expect.objectContaining({
          timeout: 5000, encoding: 'utf8', shell: false, windowsHide: true, cwd: expect.any(String),
        }),
      );
      // Fail closed: no second spawn. A bare name under shell:true would let
      // cmd.exe resolve it against the CWD and run a planted gemini.cmd, and
      // would leave no resolved path for the trust check to inspect.
      expect(mockSpawnSync).toHaveBeenCalledTimes(1);
      restorePlatform();
      clearResolvedPathCache();
      mockSpawnSync.mockRestore();
    });

    it('probes an absolute contract binary without consulting the resolver', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      const restorePlatform = setProcessPlatform('linux');
      clearResolvedPathCache();
      mockSpawnSync.mockClear();
      mockSpawnSync.mockReturnValue({ status: 0, stdout: 'ok\n', stderr: '', pid: 0, output: [], signal: null } as any);

      const originalBinary = getContract('codex').binary;
      try {
        (getContract('codex') as { binary: string }).binary = '/opt/tools/codex';
        expect(isCliAvailable('codex')).toBe(true);
        expect(mockSpawnSync).toHaveBeenCalledTimes(1);
        expect(mockSpawnSync).toHaveBeenNthCalledWith(
          1,
          '/opt/tools/codex',
          ['--version'],
          expect.objectContaining({ shell: false }),
        );
      } finally {
        (getContract('codex') as { binary: string }).binary = originalBinary;
        restorePlatform();
        clearResolvedPathCache();
        mockSpawnSync.mockRestore();
      }
    });
  });

  describe('prompt mode (headless TUI bypass)', () => {
    it('gemini supports prompt mode', () => {
      expect(isPromptModeAgent('gemini')).toBe(true);
      const c = getContract('gemini');
      expect(c.supportsPromptMode).toBe(true);
      expect(c.promptModeFlag).toBe('-p');
    });

    it('claude does not support prompt mode', () => {
      expect(isPromptModeAgent('claude')).toBe(false);
    });

    it('codex launches as a persistent interactive worker, not prompt/exec mode', () => {
      expect(isPromptModeAgent('codex')).toBe(false);
      const c = getContract('codex');
      expect(c.supportsPromptMode).toBe(false);
      expect(c.promptModeFlag).toBeUndefined();
    });

    it('grok supports prompt mode', () => {
      expect(isPromptModeAgent('grok')).toBe(true);
      const c = getContract('grok');
      expect(c.supportsPromptMode).toBe(true);
      expect(c.promptModeFlag).toBe('-p');
    });

    it('antigravity supports prompt mode', () => {
      expect(isPromptModeAgent('antigravity')).toBe(true);
      const c = getContract('antigravity');
      expect(c.supportsPromptMode).toBe(true);
      expect(c.promptModeFlag).toBe('-p');
    });

    it('getPromptModeArgs returns flag + instruction for antigravity', () => {
      // agy --print has no Windows support, so the contract refuses there.
      if (process.platform === 'win32') {
        expect(() => getPromptModeArgs('antigravity', 'Read inbox'))
          .toThrow(/not supported on Windows/);
        return;
      }
      const args = getPromptModeArgs('antigravity', 'Read inbox');
      expect(args).toEqual(['-p', 'Read inbox']);
    });

    it('getPromptModeArgs returns flag + instruction for grok', () => {
      const args = getPromptModeArgs('grok', 'Read inbox');
      expect(args).toEqual(['-p', 'Read inbox']);
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

  describe('resolveClaudeWorkerModel (issue #1695)', () => {
    it('returns undefined when OMC_ROUTING_FORCE_INHERIT=true even if Bedrock model env vars are set', () => {
      vi.stubEnv('OMC_ROUTING_FORCE_INHERIT', 'true');
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
      vi.stubEnv('ANTHROPIC_MODEL', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');
      vi.stubEnv('CLAUDE_MODEL', 'us.anthropic.claude-opus-4-6-v1:0');
      vi.stubEnv('CLAUDE_CODE_BEDROCK_SONNET_MODEL', 'us.anthropic.claude-sonnet-4-6-v1:0');
      vi.stubEnv('OMC_MODEL_MEDIUM', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');
      expect(resolveClaudeWorkerModel()).toBeUndefined();
      vi.unstubAllEnvs();
    });

    it('returns undefined when OMC_ROUTING_FORCE_INHERIT=true on Vertex', () => {
      vi.stubEnv('OMC_ROUTING_FORCE_INHERIT', 'true');
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '');
      vi.stubEnv('CLAUDE_CODE_USE_VERTEX', '1');
      vi.stubEnv('ANTHROPIC_MODEL', 'vertex_ai/claude-sonnet-4-6@20250514');
      expect(resolveClaudeWorkerModel()).toBeUndefined();
      vi.unstubAllEnvs();
    });

    it('returns undefined when not on Bedrock or Vertex', () => {
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '');
      vi.stubEnv('CLAUDE_CODE_USE_VERTEX', '');
      vi.stubEnv('ANTHROPIC_MODEL', '');
      vi.stubEnv('CLAUDE_MODEL', '');
      expect(resolveClaudeWorkerModel()).toBeUndefined();
      vi.unstubAllEnvs();
    });

    it('returns ANTHROPIC_MODEL on Bedrock when set', () => {
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
      vi.stubEnv('ANTHROPIC_MODEL', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');
      vi.stubEnv('CLAUDE_MODEL', '');
      expect(resolveClaudeWorkerModel()).toBe('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
      vi.unstubAllEnvs();
    });

    it('returns CLAUDE_MODEL on Bedrock when ANTHROPIC_MODEL is not set', () => {
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
      vi.stubEnv('ANTHROPIC_MODEL', '');
      vi.stubEnv('CLAUDE_MODEL', 'us.anthropic.claude-opus-4-6-v1:0');
      expect(resolveClaudeWorkerModel()).toBe('us.anthropic.claude-opus-4-6-v1:0');
      vi.unstubAllEnvs();
    });

    it('falls back to CLAUDE_CODE_BEDROCK_SONNET_MODEL tier env var', () => {
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
      vi.stubEnv('ANTHROPIC_MODEL', '');
      vi.stubEnv('CLAUDE_MODEL', '');
      vi.stubEnv('CLAUDE_CODE_BEDROCK_SONNET_MODEL', 'us.anthropic.claude-sonnet-4-6-v1:0');
      expect(resolveClaudeWorkerModel()).toBe('us.anthropic.claude-sonnet-4-6-v1:0');
      vi.unstubAllEnvs();
    });

    it('falls back to OMC_MODEL_MEDIUM tier env var', () => {
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
      vi.stubEnv('ANTHROPIC_MODEL', '');
      vi.stubEnv('CLAUDE_MODEL', '');
      vi.stubEnv('CLAUDE_CODE_BEDROCK_SONNET_MODEL', '');
      vi.stubEnv('ANTHROPIC_DEFAULT_SONNET_MODEL', '');
      vi.stubEnv('OMC_MODEL_MEDIUM', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');
      expect(resolveClaudeWorkerModel()).toBe('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
      vi.unstubAllEnvs();
    });

    it('returns ANTHROPIC_MODEL on Vertex when set', () => {
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '');
      vi.stubEnv('CLAUDE_CODE_USE_VERTEX', '1');
      vi.stubEnv('ANTHROPIC_MODEL', 'vertex_ai/claude-sonnet-4-6@20250514');
      expect(resolveClaudeWorkerModel()).toBe('vertex_ai/claude-sonnet-4-6@20250514');
      vi.unstubAllEnvs();
    });

    it('returns undefined on Bedrock when no model env vars are set', () => {
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
      vi.stubEnv('ANTHROPIC_MODEL', '');
      vi.stubEnv('CLAUDE_MODEL', '');
      vi.stubEnv('CLAUDE_CODE_BEDROCK_SONNET_MODEL', '');
      vi.stubEnv('ANTHROPIC_DEFAULT_SONNET_MODEL', '');
      vi.stubEnv('OMC_MODEL_MEDIUM', '');
      expect(resolveClaudeWorkerModel()).toBeUndefined();
      vi.unstubAllEnvs();
    });

    it('detects Bedrock from model ID pattern even without CLAUDE_CODE_USE_BEDROCK', () => {
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '');
      vi.stubEnv('CLAUDE_CODE_USE_VERTEX', '');
      vi.stubEnv('ANTHROPIC_MODEL', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');
      vi.stubEnv('CLAUDE_MODEL', '');
      // isBedrock() detects Bedrock from the model ID pattern
      expect(resolveClaudeWorkerModel()).toBe('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
      vi.unstubAllEnvs();
    });
  });
  describe('worker launch descriptors', () => {
    it('captures exact binary model and appended prompt argv', () => {
      const descriptor = buildValidatedWorkerLaunchDescriptor('gemini', {
        teamName: 'team', workerName: 'worker-1', cwd: '/tmp', model: 'gemini-2.5-pro',
        resolvedBinaryPath: '/usr/bin/gemini',
      }, ['-p', 'read inbox']);
      expect(descriptor).toEqual({ schema_version: 1, provider: 'gemini', model: 'gemini-2.5-pro',
        binary: '/usr/bin/gemini', args: ['--approval-mode', 'yolo', '--model', 'gemini-2.5-pro', '-p', 'read inbox'] });
    });

    it.each([
      { schema_version: 2, provider: 'claude', model: null, binary: '/usr/bin/claude', args: [] },
      { schema_version: 1, provider: 'unknown', model: null, binary: '/usr/bin/unknown', args: [] },
      { schema_version: 1, provider: 'claude', binary: '/usr/bin/claude', args: [] },
      { schema_version: 1, provider: 'claude', model: null, binary: 'claude', args: [] },
      { schema_version: 1, provider: 'claude', model: null, binary: '/usr/bin/claude\0x', args: [] },
      { schema_version: 1, provider: 'claude', model: null, binary: '/usr/bin/claude', args: ['ok\0bad'] },
    ])('rejects malformed persisted descriptor %#', value => {
      expect(() => validateWorkerLaunchDescriptor(value)).toThrow();
    });

    it('returns a defensive argv copy', () => {
      const source = { schema_version: 1 as const, provider: 'codex' as const, model: null,
        binary: '/usr/bin/codex', args: ['--flag'] };
      const validated = validateWorkerLaunchDescriptor(source);
      validated.args.push('--changed');
      expect(source.args).toEqual(['--flag']);
    });

    it('normalizes persisted Cursor descriptors to the required trust flags', () => {
      const validated = validateWorkerLaunchDescriptor({
        schema_version: 1,
        provider: 'cursor',
        model: null,
        binary: '/usr/local/bin/cursor-agent',
        args: ['--yolo', '--model', 'composer-2.5', '--trust', '--force'],
      });
      expect(validated.args).toEqual(['--force', '--trust', '--model', 'composer-2.5']);
    });
  });

});
