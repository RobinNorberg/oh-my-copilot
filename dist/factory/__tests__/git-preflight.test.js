import { describe, expect, it } from 'vitest';
import { factoryGitProblem, gitVersionAtLeast, parseGitVersion } from '../git-preflight.js';
const out = (stdout, status = 0) => () => ({ status, stdout, stderr: '' });
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
    it('names the version, the need and the Ubuntu fix for an old git', () => {
        expect(factoryGitProblem(out('git version 2.25.1\n'))).toBe('git 2.25.1 is too old for the factory: it needs git >= 2.38 (merge-tree --write-tree). On Ubuntu: add-apt-repository ppa:git-core/ppa && apt-get install git');
    });
    it('accepts a new enough git and reports an unreadable one', () => {
        expect(factoryGitProblem(out('git version 2.50.1.windows.1\n'))).toBeNull();
        expect(factoryGitProblem(out('git version 2.39.3 (Apple Git-146)\n'))).toBeNull();
        expect(factoryGitProblem(out('', 1))).toMatch(/could not be read/);
    });
});
//# sourceMappingURL=git-preflight.test.js.map