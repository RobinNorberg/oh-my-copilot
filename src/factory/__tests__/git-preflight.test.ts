import { describe, expect, it } from 'vitest';
import type { Exec } from '../../ship/exec.js';
import { HOST_GIT_ATTR_SOURCE_MIN } from '../../team/git-worktree.js';
import { FACTORY_GIT_MIN_VERSION, factoryGitProblem, gitVersionAtLeast, parseGitVersion } from '../git-preflight.js';

const out = (stdout: string, status = 0, stderr = ''): Exec => () => ({ status, stdout, stderr });

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
    const base = 'git 2.25.1 is too old for the factory: it needs git >= 2.41 (merge-tree --write-tree and GIT_ATTR_SOURCE).';
    expect(factoryGitProblem(out('git version 2.25.1\n'), 'linux')).toBe(
      `${base} On Ubuntu: sudo add-apt-repository ppa:git-core/ppa && sudo apt-get update && sudo apt-get install git`,
    );
    expect(factoryGitProblem(out('git version 2.25.1\n'), 'win32')).toBe(base);
  });

  it('accepts a new enough git, including the exact boundary and a release candidate', () => {
    expect(factoryGitProblem(out('git version 2.50.1.windows.1\n'))).toBeNull();
    expect(factoryGitProblem(out('git version 2.43.0 (Apple Git-146)\n'))).toBeNull();
    expect(factoryGitProblem(out('git version 2.41.0\n'))).toBeNull();
    expect(factoryGitProblem(out('git version 2.41.0.rc1\n'))).toBeNull();
    expect(factoryGitProblem(out('git version 2.40.1\n'), 'win32')).toMatch(/^git 2\.40\.1 is too old/);
    // 2.38 runs merge-tree --write-tree but ignores GIT_ATTR_SOURCE, so the lane checkout would apply the tree's eol attributes.
    expect(factoryGitProblem(out('git version 2.39.3 (Apple Git-146)\n'), 'win32')).toMatch(/^git 2\.39\.3 is too old/);
    expect(factoryGitProblem(out('git version 2.38.0\n'), 'win32')).toMatch(/^git 2\.38\.0 is too old/);
  });

  it('takes its minimum from HOST_GIT_ATTR_SOURCE_MIN, the git that honours GIT_ATTR_SOURCE', () => {
    expect(FACTORY_GIT_MIN_VERSION).toEqual(HOST_GIT_ATTR_SOURCE_MIN.split('.').slice(0, 2).map(Number));
    expect(FACTORY_GIT_MIN_VERSION).toEqual([2, 41]);
  });

  it('reports an unreadable git, with the first stderr line when there is one', () => {
    expect(factoryGitProblem(out('', 1))).toMatch(/could not be read$/);
    expect(factoryGitProblem(out('', 127, 'spawn git ENOENT\nmore'))).toMatch(/could not be read: spawn git ENOENT$/);
    expect(factoryGitProblem(out('something odd\n', 0))).toMatch(/could not be read$/);
  });
});
