import { describe, expect, it } from 'vitest';
import { factoryGitProblem, gitVersionAtLeast, parseGitVersion } from '../git-preflight.js';
const out = (stdout, status = 0, stderr = '') => () => ({ status, stdout, stderr });
describe('git preflight', () => {
    it('parses the version forms git prints', () => {
        expect(parseGitVersion('git version 2.25.1')).toEqual([2, 25]);
        expect(parseGitVersion('git version 2.50.1.windows.1')).toEqual([2, 50]);
        expect(parseGitVersion('git version 2.39.3 (Apple Git-146)\n')).toEqual([2, 39]);
        expect(parseGitVersion('usage: git')).toBeNull();
    });
    it('compares major then minor', () => {
        expect(gitVersionAtLeast([2, 38], [2, 38])).toBe(true);
        expect(gitVersionAtLeast([2, 37], [2, 38])).toBe(false);
        expect(gitVersionAtLeast([3, 0], [2, 38])).toBe(true);
        expect(gitVersionAtLeast([1, 99], [2, 38])).toBe(false);
    });
    it('names the version and the need for an old git, with the Ubuntu fix only on Linux', () => {
        const base = 'git 2.25.1 is too old for the factory: it needs git >= 2.38 (merge-tree --write-tree).';
        expect(factoryGitProblem(out('git version 2.25.1\n'), 'linux')).toBe(`${base} On Ubuntu: sudo add-apt-repository ppa:git-core/ppa && sudo apt-get update && sudo apt-get install git`);
        expect(factoryGitProblem(out('git version 2.25.1\n'), 'win32')).toBe(base);
    });
    it('accepts a new enough git, including the exact boundary and a release candidate', () => {
        expect(factoryGitProblem(out('git version 2.50.1.windows.1\n'))).toBeNull();
        expect(factoryGitProblem(out('git version 2.39.3 (Apple Git-146)\n'))).toBeNull();
        expect(factoryGitProblem(out('git version 2.38.0\n'))).toBeNull();
        expect(factoryGitProblem(out('git version 2.38.0.rc1\n'))).toBeNull();
        expect(factoryGitProblem(out('git version 2.37.9\n'), 'win32')).toMatch(/^git 2\.37\.9 is too old/);
    });
    it('reports an unreadable git, with the first stderr line when there is one', () => {
        expect(factoryGitProblem(out('', 1))).toMatch(/could not be read$/);
        expect(factoryGitProblem(out('', 127, 'spawn git ENOENT\nmore'))).toMatch(/could not be read: spawn git ENOENT$/);
        expect(factoryGitProblem(out('something odd\n', 0))).toMatch(/could not be read$/);
    });
});
//# sourceMappingURL=git-preflight.test.js.map