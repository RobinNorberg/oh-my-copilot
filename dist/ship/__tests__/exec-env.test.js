import { afterEach, describe, expect, it, vi } from 'vitest';
const spawnSync = vi.hoisted(() => vi.fn(() => ({ status: 0, stdout: '', stderr: '' })));
vi.mock('child_process', () => ({ spawnSync }));
import { defaultExec } from '../exec.js';
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
describe('defaultExec exe-search hardening', () => {
    afterEach(() => {
        Object.defineProperty(process, 'platform', realPlatform);
        spawnSync.mockClear();
    });
    it('keeps exactly one NoDefaultCurrentDirectoryInExePath=1 on win32 even when the caller overrides it', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        defaultExec('git', ['status'], { env: { NoDefaultCurrentDirectoryInExePath: '0', nodefaultcurrentdirectoryinexepath: '0' } });
        const calls = spawnSync.mock.calls;
        const env = calls[0][2].env;
        const entries = Object.entries(env).filter(([k]) => k.toUpperCase() === 'NODEFAULTCURRENTDIRECTORYINEXEPATH');
        expect(entries).toEqual([['NoDefaultCurrentDirectoryInExePath', '1']]);
    });
});
//# sourceMappingURL=exec-env.test.js.map