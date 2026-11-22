/**
 * Host git check for the factory: `merge-tree --write-tree` (mirror sync, lane
 * commits) needs git 2.38, and the attribute-free lane checkout needs
 * GIT_ATTR_SOURCE (git 2.41, HOST_GIT_ATTR_SOURCE_MIN: an older git ignores it
 * and applies the tree's eol attributes). Run once, early, so an old git
 * (Ubuntu 20.04 ships 2.25, 22.04 2.34) gets one actionable message instead of
 * git's usage text from a later command. The private layout has its own,
 * stricter check (gitVersionProblem).
 */

import { defaultExec, type Exec } from '../ship/exec.js';
import { HOST_GIT_ATTR_SOURCE_MIN } from '../team/git-worktree.js';

export const FACTORY_GIT_MIN_VERSION = HOST_GIT_ATTR_SOURCE_MIN.split('.').slice(0, 2).map(Number) as unknown as readonly [number, number];

const NEED = '(merge-tree --write-tree and GIT_ATTR_SOURCE)';

/** "major.minor" from `git --version` output ("git version 2.50.1.windows.1", "git version 2.39.3 (Apple Git-146)"), or null. */
export function parseGitVersion(text: string): [number, number] | null {
  const m = /git version (\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function gitVersionAtLeast(version: readonly [number, number], min: readonly [number, number]): boolean {
  return version[0] > min[0] || (version[0] === min[0] && version[1] >= min[1]);
}

/** Null, or the actionable message for a git on PATH that is too old for the factory (or whose version cannot be read). */
export function factoryGitProblem(exec: Exec = defaultExec, platform: NodeJS.Platform = process.platform): string | null {
  const r = exec('git', ['--version'], {});
  const want = `${FACTORY_GIT_MIN_VERSION[0]}.${FACTORY_GIT_MIN_VERSION[1]}`;
  const v = r.status === 0 ? parseGitVersion(r.stdout) : null;
  if (!v) {
    const why = r.stderr.trim().split(/\r?\n/)[0]?.trim();
    return `the factory needs git >= ${want} ${NEED}, and \`git --version\` could not be read${why ? `: ${why}` : ''}`;
  }
  if (gitVersionAtLeast(v, FACTORY_GIT_MIN_VERSION)) return null;
  const full = /git version (\S+)/.exec(r.stdout)?.[1] ?? `${v[0]}.${v[1]}`;
  const hint = platform === 'linux' ? ' On Ubuntu: sudo add-apt-repository ppa:git-core/ppa && sudo apt-get update && sudo apt-get install git' : '';
  return `git ${full} is too old for the factory: it needs git >= ${want} ${NEED}.${hint}`;
}
