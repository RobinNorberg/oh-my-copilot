import { describe, expect, it } from 'vitest';
import { matchPathGlob, routePathsToRole, routeTaskToRole } from '../role-router.js';

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
  ])('%s vs %s -> %s', (glob, path, want) => {
    expect(matchPathGlob(glob, path)).toBe(want);
  });
});

describe('path rules before the keyword fallback', () => {
  const rules = [{ glob: 'docs/**', role: 'writer' }, { glob: 'src/**', role: 'executor' }];
  it('picks the first rule that matches any path', () => {
    expect(routePathsToRole(['src/a.ts', 'docs/x.md'], rules)).toBe('writer');
    expect(routePathsToRole(['lib/a.ts'], rules)).toBeUndefined();
  });
  it('wins over a keyword intent and is high confidence', () => {
    expect(routeTaskToRole('debug the crash', '', 'executor', { paths: ['docs/a.md'], rules })).toMatchObject({ role: 'writer', confidence: 'high' });
  });
  it('falls back to keywords when no rule matches, and is unchanged without rules', () => {
    expect(routeTaskToRole('debug the crash', '', 'executor', { paths: ['lib/a.ts'], rules }).role).toBe('debugger');
    expect(routeTaskToRole('debug the crash', '', 'executor').role).toBe('debugger');
  });
});
