import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { TEST_DIRS } = vi.hoisted(() => ({ TEST_DIRS: { configDir: '' } }));

vi.mock('../utils/config-dir.js', () => ({
  getCopilotConfigDir: () => TEST_DIRS.configDir,
}));

import { formatReport, runConflictCheck } from '../cli/commands/doctor-conflicts.js';

describe('doctor: legacy-named project config', () => {
  const originalCwd = process.cwd();
  let project: string;

  beforeEach(() => {
    TEST_DIRS.configDir = mkdtempSync(join(tmpdir(), 'omg-doctor-config-'));
    project = mkdtempSync(join(tmpdir(), 'omg-doctor-project-'));
    process.chdir(project);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(project, { recursive: true, force: true });
    rmSync(TEST_DIRS.configDir, { recursive: true, force: true });
  });

  it('reports .copilot/omc.jsonc with the rename command, as a warning only, and never renames it', () => {
    const baseline = runConflictCheck();
    expect(baseline.legacyProjectConfigs).toEqual([]);

    mkdirSync(join(project, '.copilot'), { recursive: true });
    writeFileSync(join(project, '.copilot', 'omc.jsonc'), '{}');
    const report = runConflictCheck();

    expect(report.legacyProjectConfigs).toHaveLength(1);
    // Warning only: the exit code matches the run without the legacy file.
    expect(report.hasConflicts).toBe(baseline.hasConflicts);
    const text = formatReport(report, false);
    expect(text).toContain('Legacy project config name');
    expect(text).toContain('mv ".copilot/omc.jsonc" ".copilot/omg.jsonc"');
    // The doctor reports; it does not move the user's file.
    expect(runConflictCheck().legacyProjectConfigs[0].legacyPath).toBe(join(project, '.copilot', 'omc.jsonc'));
  });

  it('reports a legacy file shadowed by the canonical one as ignored', () => {
    mkdirSync(join(project, '.copilot'), { recursive: true });
    writeFileSync(join(project, '.copilot', 'omg.jsonc'), '{}');
    writeFileSync(join(project, '.copilot', 'omc.jsonc'), '{}');
    const text = formatReport(runConflictCheck(), false);
    expect(text).toContain('Legacy project config ignored');
    expect(text).not.toContain('mv "');
  });

  it('includes the legacy entries in --json output', () => {
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(join(project, '.claude', 'omc.jsonc'), '{}');
    const parsed = JSON.parse(formatReport(runConflictCheck(), true));
    expect(parsed.legacyProjectConfigs[0].renameCommand).toBe(
      'mkdir -p ".copilot" && mv ".claude/omc.jsonc" ".copilot/omg.jsonc"',
    );
  });
});
