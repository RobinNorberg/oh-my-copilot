import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExecutable } from '../executable-resolution.js';
/**
 * End-to-end guard against a repo-planted executable, using the real where.exe.
 * This file deliberately mocks nothing: the whole point is what the OS resolver
 * does with an untrusted current directory.
 *
 * Windows-only. `which` on POSIX does not search the cwd, so there is nothing
 * to plant against, and process.chdir is unavailable under some vitest pools.
 */
const canChangeDirectory = typeof process.chdir === 'function';
const runOnWindows = process.platform === 'win32' && canChangeDirectory;
describe.skipIf(!runOnWindows)('resolveExecutable with a planted executable in the cwd', () => {
    const originalCwd = process.cwd();
    let plantedDir;
    afterEach(() => {
        process.chdir(originalCwd);
        if (plantedDir)
            rmSync(plantedDir, { recursive: true, force: true });
        plantedDir = undefined;
    });
    it('ignores a planted node.exe in the current directory', () => {
        plantedDir = mkdtempSync(join(tmpdir(), 'omc-planted-cwd-'));
        const planted = join(plantedDir, 'node.exe');
        writeFileSync(planted, 'not a real executable');
        process.chdir(plantedDir);
        // Establish that the plant really would win: where.exe run from this
        // directory reports it ahead of the genuine PATH entry.
        const fromPlantedCwd = spawnSync('where.exe', ['node'], {
            cwd: plantedDir,
            encoding: 'utf8',
            shell: false,
        });
        expect(fromPlantedCwd.stdout.split(/\r?\n/)[0].trim()).toBe(planted);
        // The resolver must not pick it up, and must still find the real node.
        const resolved = resolveExecutable('node');
        expect(resolved).toBeDefined();
        expect(resolved).not.toBe(planted);
        expect(resolved.toLowerCase()).not.toContain('omc-planted-cwd-');
    });
});
//# sourceMappingURL=executable-resolution.planted-cwd.test.js.map