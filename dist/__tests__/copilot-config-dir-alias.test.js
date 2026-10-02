import { describe, it, expect } from 'vitest';
import { COPILOT_HOME, COPILOT_CONFIG_DIR, INSTALLER_COPILOT_HOME, INSTALLER_COPILOT_CONFIG_DIR, } from '../index.js';
describe('deprecated COPILOT_CONFIG_DIR export alias', () => {
    it('resolves to the same value as COPILOT_HOME', () => {
        expect(typeof COPILOT_HOME).toBe('string');
        expect(COPILOT_CONFIG_DIR).toBe(COPILOT_HOME);
    });
    it('keeps the installer export names consistent', () => {
        expect(INSTALLER_COPILOT_CONFIG_DIR).toBe(INSTALLER_COPILOT_HOME);
        expect(INSTALLER_COPILOT_CONFIG_DIR).toBe(COPILOT_HOME);
    });
});
//# sourceMappingURL=copilot-config-dir-alias.test.js.map