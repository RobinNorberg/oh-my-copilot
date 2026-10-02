import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { TEST_DIRS } = vi.hoisted(() => ({ TEST_DIRS: { configDir: '' } }));

vi.mock('../utils/config-dir.js', () => ({
  getCopilotConfigDir: () => TEST_DIRS.configDir,
}));

import { checkNodeOnPath, formatReport, runConflictCheck } from '../cli/commands/doctor-conflicts.js';

const MISSING = 'node not found on PATH';

describe('doctor: node on PATH', () => {
  const emptyDirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of emptyDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function emptyPathDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'omc-doctor-nopath-'));
    emptyDirs.push(dir);
    return dir;
  }

  it('passes when node resolves on PATH', () => {
    expect(checkNodeOnPath()).toBe(true);
  });

  it('fails when PATH has no node', () => {
    const dir = emptyPathDir();
    expect(checkNodeOnPath({ PATH: dir, Path: dir })).toBe(false);
  });

  it('finds node in a PATH directory whose name contains a space', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omc doctor node path '));
    emptyDirs.push(dir);
    const target = join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    copyFileSync(process.execPath, target);
    chmodSync(target, 0o755);
    expect(checkNodeOnPath({ PATH: dir, Path: dir })).toBe(true);
  });

  it('words the missing-node impact for the Claude Code host', () => {
    TEST_DIRS.configDir = emptyPathDir();
    vi.stubEnv('PATH', emptyPathDir());
    vi.stubEnv('COPILOT_CLI', '');
    vi.stubEnv('COPILOT_AGENT_SESSION_ID', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'cli');
    const text = formatReport(runConflictCheck(), false);
    expect(text).toContain(MISSING);
    expect(text).toContain('Claude Code cannot run any OMC hook');
    expect(text).not.toContain('PreToolUse hook fails closed');
  });

  it('reports a missing node as a conflict with the fail-closed explanation', () => {
    TEST_DIRS.configDir = emptyPathDir();
    vi.stubEnv('PATH', emptyPathDir());
    vi.stubEnv('COPILOT_CLI', '1');
    const report = runConflictCheck();
    expect(report.nodeOnPath).toBe(false);
    expect(report.hasConflicts).toBe(true);
    const text = formatReport(report, false);
    expect(text).toContain(MISSING);
    expect(text).toContain('PreToolUse hook fails closed');

    vi.unstubAllEnvs();
    expect(formatReport(runConflictCheck(), false)).not.toContain(MISSING);
  });
});
