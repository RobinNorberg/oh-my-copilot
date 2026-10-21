import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import { resolveSystemPython } from '../bridge-manager.js';
import { hasExecutable } from '../../../__tests__/helpers/platform.js';
const VERSION_PROBE = ['-c', 'import sys; assert sys.version_info >= (3,); print(sys.executable)'];
/** Fake probe: `interpreters` maps a command line to its stdout; anything else fails like a missing binary. */
function fakeProbe(interpreters) {
    const calls = [];
    const probe = async (command, args) => {
        const line = [command, ...args.slice(0, args.length - VERSION_PROBE.length)].join(' ');
        calls.push(line);
        expect(args.slice(-VERSION_PROBE.length)).toEqual(VERSION_PROBE);
        if (line in interpreters)
            return interpreters[line];
        throw new Error(`spawn ${command} ENOENT`);
    };
    return { calls, probe };
}
describe('resolveSystemPython', () => {
    it('uses python3 when it runs', async () => {
        const { calls, probe } = fakeProbe({ python3: '/usr/bin/python3\n' });
        await expect(resolveSystemPython('linux', probe)).resolves.toBe('/usr/bin/python3');
        expect(calls).toEqual(['python3']);
    });
    it('only probes python3 on POSIX hosts', async () => {
        const { calls, probe } = fakeProbe({ python: '/usr/bin/python', 'py -3': '/usr/bin/py' });
        await expect(resolveSystemPython('linux', probe)).resolves.toBeNull();
        expect(calls).toEqual(['python3']);
    });
    it('falls back to python on Windows when python3 is the failing Store stub', async () => {
        const { calls, probe } = fakeProbe({ python: 'C:\\Python312\\python.exe\r\n' });
        await expect(resolveSystemPython('win32', probe)).resolves.toBe('C:\\Python312\\python.exe');
        expect(calls).toEqual(['python3', 'python']);
    });
    it('falls back to the py -3 launcher on Windows and returns the real interpreter path', async () => {
        const { calls, probe } = fakeProbe({ 'py -3': 'C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python313\\python.exe\r\n' });
        await expect(resolveSystemPython('win32', probe)).resolves.toBe('C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python313\\python.exe');
        expect(calls).toEqual(['python3', 'python', 'py -3']);
    });
    it('skips a candidate that runs but reports no interpreter path', async () => {
        const { probe } = fakeProbe({ python3: '', python: 'C:\\Python312\\python.exe' });
        await expect(resolveSystemPython('win32', probe)).resolves.toBe('C:\\Python312\\python.exe');
    });
    it('returns null when no candidate works', async () => {
        const { calls, probe } = fakeProbe({});
        await expect(resolveSystemPython('win32', probe)).resolves.toBeNull();
        expect(calls).toEqual(['python3', 'python', 'py -3']);
    });
    it.runIf(hasExecutable('python3'))('resolves a real interpreter file on this host', async () => {
        const executable = await resolveSystemPython();
        expect(executable).not.toBeNull();
        expect(fs.statSync(executable).isFile()).toBe(true);
    });
});
//# sourceMappingURL=system-python.test.js.map