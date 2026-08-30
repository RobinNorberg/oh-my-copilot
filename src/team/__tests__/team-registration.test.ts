import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readProbeResult, writeProbeResult, getRegistrationStrategy,
  registerMcpWorker, unregisterMcpWorker, isMcpWorker, listMcpWorkers
} from '../team-registration.js';
import { getCopilotConfigDir } from '../../utils/config-dir.js';
import type { ConfigProbeResult } from '../types.js';

const TEST_DIR = join(tmpdir(), '__test_team_reg__');
const TEST_TEAM = 'test-team-reg-team';
let configDir: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousOmcStateDir: string | undefined;

beforeEach(() => {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousOmcStateDir = process.env.OMC_STATE_DIR;
  process.env.HOME = TEST_DIR;
  process.env.USERPROFILE = TEST_DIR;
  delete process.env.OMC_STATE_DIR;

  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, '.omc', 'state'), { recursive: true });
  configDir = join(getCopilotConfigDir(), 'teams', TEST_TEAM);
  mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });

  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousOmcStateDir === undefined) delete process.env.OMC_STATE_DIR;
  else process.env.OMC_STATE_DIR = previousOmcStateDir;
});

describe('probeResult', () => {
  it('writes and reads probe result', () => {
    const result: ConfigProbeResult = { probeResult: 'pass', probedAt: '2026-01-01', version: '1.0' };
    writeProbeResult(TEST_DIR, result);
    expect(readProbeResult(TEST_DIR)?.probeResult).toBe('pass');
  });

  it('returns null when not probed', () => {
    expect(readProbeResult(TEST_DIR)).toBeNull();
  });
});

describe('getRegistrationStrategy', () => {
  it('returns shadow when not probed', () => {
    expect(getRegistrationStrategy(TEST_DIR)).toBe('shadow');
  });

  it('returns config when probe passed', () => {
    writeProbeResult(TEST_DIR, { probeResult: 'pass', probedAt: '', version: '' });
    expect(getRegistrationStrategy(TEST_DIR)).toBe('config');
  });

  it('returns shadow when probe failed', () => {
    writeProbeResult(TEST_DIR, { probeResult: 'fail', probedAt: '', version: '' });
    expect(getRegistrationStrategy(TEST_DIR)).toBe('shadow');
  });

  it('returns shadow when probe partial', () => {
    writeProbeResult(TEST_DIR, { probeResult: 'partial', probedAt: '', version: '' });
    expect(getRegistrationStrategy(TEST_DIR)).toBe('shadow');
  });
});

describe('registerMcpWorker / unregisterMcpWorker', () => {
  it('registers worker in shadow registry', () => {
    registerMcpWorker(TEST_TEAM, 'w1', 'codex', 'gpt-5', 'sess1', '/cwd', TEST_DIR);
    const workers = listMcpWorkers(TEST_TEAM, TEST_DIR);
    expect(workers).toHaveLength(1);
    expect(workers[0].name).toBe('w1');
    expect(workers[0].agentType).toBe('mcp-codex');
  });

  it('replaces existing worker on re-register', () => {
    registerMcpWorker(TEST_TEAM, 'w1', 'codex', 'gpt-5', 'sess1', '/cwd', TEST_DIR);
    registerMcpWorker(TEST_TEAM, 'w1', 'gemini', 'gemini-pro', 'sess2', '/cwd2', TEST_DIR);
    const workers = listMcpWorkers(TEST_TEAM, TEST_DIR);
    expect(workers).toHaveLength(1);
    expect(workers[0].agentType).toBe('mcp-gemini');
  });

  it('registers multiple workers', () => {
    registerMcpWorker(TEST_TEAM, 'w1', 'codex', 'gpt-5', 'sess1', '/cwd', TEST_DIR);
    registerMcpWorker(TEST_TEAM, 'w2', 'gemini', 'gemini-pro', 'sess2', '/cwd', TEST_DIR);
    const workers = listMcpWorkers(TEST_TEAM, TEST_DIR);
    expect(workers).toHaveLength(2);
  });

  it('unregisters worker', () => {
    registerMcpWorker(TEST_TEAM, 'w1', 'codex', 'gpt-5', 'sess1', '/cwd', TEST_DIR);
    unregisterMcpWorker(TEST_TEAM, 'w1', TEST_DIR);
    expect(listMcpWorkers(TEST_TEAM, TEST_DIR)).toEqual([]);
  });

  it('unregister is no-op for nonexistent worker', () => {
    registerMcpWorker(TEST_TEAM, 'w1', 'codex', 'gpt-5', 'sess1', '/cwd', TEST_DIR);
    unregisterMcpWorker(TEST_TEAM, 'w2', TEST_DIR);
    expect(listMcpWorkers(TEST_TEAM, TEST_DIR)).toHaveLength(1);
  });
});

describe('isMcpWorker', () => {
  it('returns true for tmux backend', () => {
    expect(isMcpWorker({ backendType: 'tmux' })).toBe(true);
  });

  it('returns false for other backends', () => {
    expect(isMcpWorker({ backendType: 'other' })).toBe(false);
    expect(isMcpWorker({})).toBe(false);
  });
});
