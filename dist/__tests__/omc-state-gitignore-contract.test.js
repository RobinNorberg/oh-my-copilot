import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
describe('.omc gitignore state contract', () => {
    it('ignores runtime .omc state while allowing project skills to be committed intentionally', () => {
        const gitignore = readFileSync(resolve(process.cwd(), '.gitignore'), 'utf-8')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        expect(gitignore).toEqual(expect.arrayContaining([
            '!.omg/',
            '.omg/*',
            '!.omg/skills/',
            '!.omg/skills/**',
        ]));
        expect(gitignore.indexOf('!.omg/')).toBeLessThan(gitignore.indexOf('.omg/*'));
        expect(gitignore.indexOf('.omg/*')).toBeLessThan(gitignore.indexOf('!.omg/skills/'));
        expect(gitignore.indexOf('!.omg/skills/')).toBeLessThan(gitignore.indexOf('!.omg/skills/**'));
    });
});
//# sourceMappingURL=omc-state-gitignore-contract.test.js.map