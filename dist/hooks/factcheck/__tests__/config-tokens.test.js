import { describe, it, expect } from 'vitest';
import { expandTokens } from '../config.js';
import { getCopilotConfigDir } from '../../../utils/config-dir.js';
describe('factcheck expandTokens', () => {
    it('expands ${COPILOT_HOME}', () => {
        expect(expandTokens('${COPILOT_HOME}/x')).toBe(`${getCopilotConfigDir()}/x`);
    });
    it('expands legacy ${COPILOT_CONFIG_DIR} as an alias of ${COPILOT_HOME}', () => {
        expect(expandTokens('${COPILOT_CONFIG_DIR}/plugins')).toBe(`${getCopilotConfigDir()}/plugins`);
        expect(expandTokens('${COPILOT_CONFIG_DIR}')).toBe(expandTokens('${COPILOT_HOME}'));
    });
});
//# sourceMappingURL=config-tokens.test.js.map