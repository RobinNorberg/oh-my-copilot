import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(),
    spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '', signal: null })),
  };
});

import { execFileSync } from 'child_process';
import { validateTmux } from '../tmux-session.js';

const mockedExecFileSync = vi.mocked(execFileSync);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('validateTmux', () => {
  it('skips probing when tmux context is already active', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('should not probe');
    });

    expect(() => validateTmux(true)).not.toThrow();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('probes tmux when context is absent', () => {
    mockedExecFileSync.mockReturnValue(Buffer.from('tmux 3.4'));

    expect(() => validateTmux(false)).not.toThrow();
    expect(mockedExecFileSync).toHaveBeenCalledWith('tmux', ['-V'], expect.objectContaining({
      encoding: 'utf-8',
      timeout: 5000,
      stdio: 'pipe',
    }));
  });

  it('throws install guidance when tmux is unavailable outside context', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('tmux missing');
    });

    expect(() => validateTmux(false)).toThrow(/tmux is not available/i);
  });
});
