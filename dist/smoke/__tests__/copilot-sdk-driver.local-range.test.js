/**
 * findCopilotSdk's node-resolution branch: a `@microsoft/copilot-sdk` that node
 * resolves from this module (a project-local install) must be in `^2.0.3` like
 * a global one. Its own file: the mock replaces the package for every import here.
 */
import { describe, expect, it, vi } from 'vitest';
import { loadCopilotSdk } from '../copilot-sdk-driver.js';
// A module node resolves whose package.json version cannot be read as ^2.0.3 (createRequire finds no package).
vi.mock('@microsoft/copilot-sdk', () => ({
    CopilotClient: class {
    },
    RuntimeConnection: { forSpawnedStdio: (o) => o },
}));
/** No global root: no APPDATA (win32), and `npm root -g` fails. */
const noGlobal = (() => ({ status: 1, stdout: '', stderr: '' }));
describe('loadCopilotSdk: the node-resolved SDK is range-checked', () => {
    it('refuses a resolved SDK outside ^2.0.3 with a clear error when no global SDK is found', async () => {
        await expect(loadCopilotSdk({}, noGlobal)).rejects.toThrow(/@microsoft\/copilot-sdk .* resolved from this module is outside the supported range \^2\.0\.3; install @microsoft\/copilot-sdk@\^2\.0\.3/);
    });
});
//# sourceMappingURL=copilot-sdk-driver.local-range.test.js.map