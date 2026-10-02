import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
const { TEST_DIRS } = vi.hoisted(() => ({ TEST_DIRS: { configDir: '' } }));
vi.mock('../utils/config-dir.js', () => ({
    getCopilotConfigDir: () => TEST_DIRS.configDir,
}));
import { checkEnvFlags, formatReport, runConflictCheck } from '../cli/commands/doctor-conflicts.js';
const WARNING = 'COPILOT_CONFIG_DIR is no longer read; set COPILOT_HOME instead';
describe('doctor: retired COPILOT_CONFIG_DIR', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });
    it('flags COPILOT_CONFIG_DIR when COPILOT_HOME is unset', () => {
        vi.stubEnv('COPILOT_CONFIG_DIR', '/legacy/copilot');
        vi.stubEnv('COPILOT_HOME', '');
        expect(checkEnvFlags().legacyConfigDirEnv).toBe(true);
    });
    it('does not flag when COPILOT_HOME is also set', () => {
        vi.stubEnv('COPILOT_CONFIG_DIR', '/legacy/copilot');
        vi.stubEnv('COPILOT_HOME', '/new/copilot');
        expect(checkEnvFlags().legacyConfigDirEnv).toBe(false);
    });
    it('does not flag when COPILOT_CONFIG_DIR is unset', () => {
        vi.stubEnv('COPILOT_CONFIG_DIR', '');
        vi.stubEnv('COPILOT_HOME', '');
        expect(checkEnvFlags().legacyConfigDirEnv).toBe(false);
    });
    it('prints the warning without counting it as a conflict', () => {
        TEST_DIRS.configDir = mkdtempSync(join(tmpdir(), 'omc-doctor-legacy-'));
        vi.stubEnv('COPILOT_CONFIG_DIR', '');
        vi.stubEnv('COPILOT_HOME', '');
        const baseline = runConflictCheck();
        vi.stubEnv('COPILOT_CONFIG_DIR', '/legacy/copilot');
        const report = runConflictCheck();
        expect(report.envFlags.legacyConfigDirEnv).toBe(true);
        // Warning only: the exit code must match the run without the legacy variable.
        expect(report.hasConflicts).toBe(baseline.hasConflicts);
        expect(formatReport(report, false)).toContain(WARNING);
        vi.stubEnv('COPILOT_HOME', TEST_DIRS.configDir);
        expect(formatReport(runConflictCheck(), false)).not.toContain(WARNING);
    });
});
//# sourceMappingURL=doctor-legacy-config-dir.test.js.map