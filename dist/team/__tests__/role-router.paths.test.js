import { describe, expect, it } from 'vitest';
import { globLimitProblem, matchPathGlob, routePathsToRole, routeTaskToRole } from '../role-router.js';
describe('matchPathGlob', () => {
    it.each([
        ['src/**', 'src/a/b.ts', true],
        ['src/**', 'src', false],
        ['src/*.ts', 'src/a.ts', true],
        ['src/*.ts', 'src/a/b.ts', false],
        ['**/*.md', 'README.md', true],
        ['**/*.md', 'docs/a/b.md', true],
        ['docs/?.md', 'docs/a.md', true],
        ['docs/?.md', 'docs/ab.md', false],
        ['a.b', 'axb', false],
        ['**', '', true],
        ['src/**', 'srcx/a', false],
        ['/abs/**', 'abs/a', false],
        ['../x', '../x', false],
        ['src/**', 'src\\a\\b.ts', true],
        ['*/*/*/*/*/*/*/*/*/*', 'a/b/c/d/e/f/g/h/i/j', false],
        ['a/**/b/**/c', 'a/x/y/b/z/c', true],
        ['a/**/b/**/c', 'a/b/c', true],
        ['a/**/b/**/c', 'a/b/b', false],
        ['**/**/**/x', 'x', false],
        ['src/**', 'src/', true],
        ['**/foo.ts', 'a/b/foo.ts', true],
        ['**/foo.ts', 'a/b/xfoo.ts', false],
        ['*.ts', 'a.ts', true],
        ['*.ts', 'dir/a.ts', false],
        ['a*b*c', 'aXXbYYc', true],
        ['a*b*c', 'aXXbYY', false],
        ['./x', 'x', false],
    ])('%s vs %s -> %s', (glob, path, want) => {
        expect(matchPathGlob(glob, path)).toBe(want);
    });
});
describe('matchPathGlob is linear and bounded', () => {
    it('the pathological glob returns in a few milliseconds on a 5000-char path', () => {
        const glob = '**a**a**a**a**a**a**a**b';
        const t0 = performance.now();
        expect(matchPathGlob(glob, 'a'.repeat(5000))).toBe(false);
        expect(matchPathGlob(glob, 'a'.repeat(1000))).toBe(false);
        expect(performance.now() - t0).toBeLessThan(50);
    });
    it('a single-segment pathological glob stays fast on a long segment', () => {
        const t0 = performance.now();
        expect(matchPathGlob('*a*a*a*a*a*a*a*b', 'a'.repeat(1000))).toBe(false);
        expect(matchPathGlob('*a*a*a*a*a*a*a*a', `${'a'.repeat(1000)}`)).toBe(true);
        expect(performance.now() - t0).toBeLessThan(200);
    });
    it('paths over 1024 characters never match', () => {
        expect(matchPathGlob('**', 'a'.repeat(1024))).toBe(true);
        expect(matchPathGlob('**', 'a'.repeat(1025))).toBe(false);
    });
    it('more than 2 ** segments or 8 wildcards is over the limits', () => {
        expect(globLimitProblem('**/a/**')).toBeUndefined();
        expect(globLimitProblem('**/a/**/b/**')).toContain('2 ** segments');
        expect(globLimitProblem('*/*/*/*/*/*/*/*/*')).toMatch(/wildcards/);
        expect(matchPathGlob('**/a/**/b/**', 'a/b/x')).toBe(false);
    });
});
describe('path rules', () => {
    const rules = [{ glob: 'docs/**', role: 'writer' }, { glob: 'src/**', role: 'executor' }];
    it('picks the first rule that matches any path', () => {
        expect(routePathsToRole(['src/a.ts', 'docs/x.md'], rules)).toBe('writer');
        expect(routePathsToRole(['lib/a.ts'], rules)).toBeUndefined();
    });
    it('keyword routing is unchanged', () => {
        expect(routeTaskToRole('debug the crash', '', 'executor').role).toBe('debugger');
    });
});
//# sourceMappingURL=role-router.paths.test.js.map