import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { detectHostCliType, getHostCliType } from '../utils/host-detection.js';
import { detectHostCliSignal } from '../utils/host-signal.js';

describe('getHostCliType', () => {
  beforeEach(() => {
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('COPILOT_CLI', '');
    vi.stubEnv('COPILOT_AGENT_SESSION_ID', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns copilot by default when no env vars are set', () => {
    expect(getHostCliType()).toBe('copilot');
  });

  it('returns claude when CLAUDE_CODE_ENTRYPOINT is set', () => {
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'plugin');
    expect(getHostCliType()).toBe('claude');
  });

  it('does not treat CLAUDECODE alone as a Claude host signal', () => {
    vi.stubEnv('CLAUDECODE', '1');
    expect(getHostCliType()).toBe('copilot');
  });

  it('returns copilot when only COPILOT_CLI is set', () => {
    vi.stubEnv('COPILOT_CLI', '1');
    expect(getHostCliType()).toBe('copilot');
  });

  it('returns copilot when a Copilot session inherited CLAUDE_CODE_ENTRYPOINT (Copilot marker wins)', () => {
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'cli');
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('COPILOT_CLI', '1');
    expect(getHostCliType()).toBe('copilot');
  });

  it('treats COPILOT_AGENT_SESSION_ID as a Copilot session marker', () => {
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'cli');
    vi.stubEnv('COPILOT_AGENT_SESSION_ID', 'abc');
    expect(getHostCliType()).toBe('copilot');
  });
});

describe('detectHostCliType', () => {
  it('reads only the env it is given', () => {
    expect(detectHostCliType({})).toBe('copilot');
    expect(detectHostCliType({ CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe('claude');
    expect(detectHostCliType({ CLAUDE_CODE_ENTRYPOINT: 'cli', COPILOT_CLI: '1' })).toBe('copilot');
  });
});

describe('detectHostCliSignal', () => {
  it('names a host only when its signal is present', () => {
    expect(detectHostCliSignal({})).toBeNull();
    expect(detectHostCliSignal({ COPILOT_AGENT_SESSION_ID: 's' })).toBe('copilot');
    expect(detectHostCliSignal({ CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe('claude');
  });
});
