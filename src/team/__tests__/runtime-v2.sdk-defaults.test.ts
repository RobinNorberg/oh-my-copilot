/**
 * SDK team defaults (F5, F11, F2): the credit cap default, the branch
 * worktree default for SDK teams, and the optional blocker timeout.
 */

import { describe, expect, it, vi } from 'vitest';
import type { PluginConfig } from '../../shared/types.js';
import {
  DEFAULT_SDK_MAX_CREDITS_PER_WORKER,
  resolveBlockerTimeoutMs,
  resolveSdkDefaultWorktreeMode,
  resolveSdkTeamSettings,
} from '../runtime-v2.js';

describe('resolveSdkTeamSettings compactProtocol', () => {
  const withCompact = (value: unknown) => ({ team: { sdk: { compactProtocol: value } } }) as unknown as PluginConfig;

  it('defaults to false and passes a boolean through', () => {
    expect(resolveSdkTeamSettings({} as PluginConfig).compactProtocol).toBe(false);
    expect(resolveSdkTeamSettings(withCompact(true)).compactProtocol).toBe(true);
    expect(resolveSdkTeamSettings(withCompact(false)).compactProtocol).toBe(false);
  });

  it('rejects a non-boolean', () => {
    expect(() => resolveSdkTeamSettings(withCompact('yes'))).toThrow(/^invalid_team_sdk_config:compactProtocol/);
  });
});

describe('DEFAULT_SDK_MAX_CREDITS_PER_WORKER', () => {
  it('is 50 (above the Copilot runtime floor of 30 and one measured task)', () => {
    expect(DEFAULT_SDK_MAX_CREDITS_PER_WORKER).toBe(50);
  });
});

describe('resolveSdkDefaultWorktreeMode', () => {
  const ready = () => 'ready' as const;

  it.each([
    // transport, explicit setting, current mode, expected mode
    [true, undefined, 'disabled', 'named'],
    [true, '', 'disabled', 'named'],
    [true, 'disabled', 'disabled', 'disabled'],
    [true, 'off', 'disabled', 'disabled'],
    [true, 'detached', 'detached', 'detached'],
    [true, 'branch', 'named', 'named'],
    [false, undefined, 'disabled', 'disabled'],
    [false, 'branch', 'named', 'named'],
  ] as const)('sdk=%s explicit=%s current=%s -> %s', (sdk, explicit, current, expected) => {
    const leader = vi.fn(ready);
    const result = resolveSdkDefaultWorktreeMode({ sdk, explicit, current, leader });
    expect(result.mode).toBe(expected);
    if (expected === 'named' && current === 'disabled') {
      expect(result.notice).toBe('sdk workers use branch worktrees (set team.ops.worktreeMode to change)');
    } else {
      expect(result.notice).toBeUndefined();
      expect(leader).not.toHaveBeenCalled();
    }
  });

  it('keeps the shared checkout and says why when the leader checkout is dirty', () => {
    const result = resolveSdkDefaultWorktreeMode({ sdk: true, explicit: undefined, current: 'disabled', leader: () => 'dirty' });
    expect(result.mode).toBe('disabled');
    expect(result.notice).toContain('uncommitted changes');
  });

  it('keeps the shared checkout silently outside a git repo', () => {
    const result = resolveSdkDefaultWorktreeMode({ sdk: true, explicit: undefined, current: 'disabled', leader: () => 'not_git' });
    expect(result).toEqual({ mode: 'disabled' });
  });
});

describe('resolveBlockerTimeoutMs', () => {
  const withTimeout = (value: unknown) => ({ team: { sdk: { blockerTimeoutMinutes: value } } }) as unknown as PluginConfig;

  it('is off by default', () => {
    expect(resolveBlockerTimeoutMs({} as PluginConfig)).toBeNull();
  });

  it('converts minutes to milliseconds', () => {
    expect(resolveBlockerTimeoutMs(withTimeout(30))).toBe(1_800_000);
  });

  it.each([0, -5, 'ten', Number.NaN])('rejects %s', (value) => {
    expect(() => resolveBlockerTimeoutMs(withTimeout(value))).toThrow(/^invalid_team_sdk_config:blockerTimeoutMinutes/);
  });
});
