import { describe, expect, it } from 'vitest';
import { AZ_PYTHON_PREFIX, AzBinaryError, resolveAzEntry } from '../az-binary.js';
const MSI = 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2';
const files = (...paths) => {
    const set = new Set(paths.map((p) => p.toLowerCase()));
    return (p) => set.has(p.toLowerCase());
};
const win = (path, isFile, key = 'Path') => ({ platform: 'win32', env: { [key]: path }, isFile });
describe('resolveAzEntry', () => {
    it('POSIX runs az directly', () => {
        expect(resolveAzEntry({ platform: 'linux', env: { PATH: '/usr/bin' }, isFile: () => false })).toEqual({ command: 'az', prefix: [], env: {} });
        expect(resolveAzEntry({ platform: 'darwin', env: {}, isFile: () => false }).command).toBe('az');
    });
    it('Windows runs the MSI bundled python.exe with -IBm azure.cli and AZ_INSTALLER=MSI', () => {
        const entry = resolveAzEntry(win(`C:\\Windows\\system32;"${MSI}\\wbin";C:\\tools`, files(`${MSI}\\wbin\\az.cmd`, `${MSI}\\python.exe`)));
        expect(entry).toEqual({ command: `${MSI}\\python.exe`, prefix: ['-IBm', 'azure.cli'], env: { AZ_INSTALLER: 'MSI' } });
        expect(AZ_PYTHON_PREFIX).toEqual(['-IBm', 'azure.cli']);
    });
    it('reads PATH under any casing of the name', () => {
        expect(resolveAzEntry(win(`${MSI}\\wbin`, files(`${MSI}\\wbin\\az.cmd`, `${MSI}\\python.exe`), 'PATH')).command).toBe(`${MSI}\\python.exe`);
    });
    it('takes the first absolute PATH entry holding az.cmd', () => {
        const other = 'D:\\az';
        const entry = resolveAzEntry(win(`${other}\\wbin;${MSI}\\wbin`, files(`${other}\\wbin\\az.cmd`, `${other}\\python.exe`, `${MSI}\\wbin\\az.cmd`, `${MSI}\\python.exe`)));
        expect(entry.command).toBe(`${other}\\python.exe`);
    });
    it('skips relative PATH entries (they resolve against the checkout)', () => {
        const isFile = (p) => /^(?:\.\\)?wbin\\az\.cmd$/i.test(p) || /python\.exe$/i.test(p);
        expect(() => resolveAzEntry(win('.\\wbin;wbin', isFile))).toThrow(AzBinaryError);
    });
    it('refuses a layout without the bundled python.exe (no cmd.exe fallback)', () => {
        expect(() => resolveAzEntry(win(`${MSI}\\wbin`, files(`${MSI}\\wbin\\az.cmd`)))).toThrow(/no bundled .*python\.exe.*never through cmd\.exe/);
    });
    it('refuses when az.cmd is not on PATH', () => {
        expect(() => resolveAzEntry(win('C:\\Windows', files()))).toThrow(/Azure CLI not found/);
        expect(() => resolveAzEntry({ platform: 'win32', env: {}, isFile: () => true })).toThrow(AzBinaryError);
    });
});
//# sourceMappingURL=az-binary.test.js.map