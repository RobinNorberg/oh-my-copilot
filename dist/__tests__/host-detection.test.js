import { describe, it, expect, vi, afterEach } from 'vitest';
import { getHostCliType } from '../utils/host-detection.js';
describe('getHostCliType', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });
    it('returns copilot by default when no env vars are set', () => {
        vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');
        vi.stubEnv('COPILOT_CLI', '');
        expect(getHostCliType()).toBe('copilot');
    });
    it('returns claude when CLAUDE_CODE_ENTRYPOINT is set', () => {
        vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'plugin');
        expect(getHostCliType()).toBe('claude');
    });
    it('returns copilot when only COPILOT_CLI is set', () => {
        vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');
        vi.stubEnv('COPILOT_CLI', '1');
        expect(getHostCliType()).toBe('copilot');
    });
    it('returns claude when both env vars are set (Claude Code takes precedence)', () => {
        vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'plugin');
        vi.stubEnv('COPILOT_CLI', '1');
        expect(getHostCliType()).toBe('claude');
    });
});
//# sourceMappingURL=host-detection.test.js.map