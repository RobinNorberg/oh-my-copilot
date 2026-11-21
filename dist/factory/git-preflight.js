/**
 * Host git check for the factory: `merge-tree --write-tree` (mirror sync, lane
 * commits) needs git 2.38. Run once, early, so an old git (Ubuntu 20.04 ships
 * 2.25) gets one actionable message instead of git's usage text from a later
 * command. The private layout has its own, stricter check (gitVersionProblem).
 */
import { defaultExec } from '../ship/exec.js';
export const FACTORY_GIT_MIN_VERSION = [2, 38];
/** "major.minor" from `git --version` output ("git version 2.50.1.windows.1", "git version 2.39.3 (Apple Git-146)"), or null. */
export function parseGitVersion(text) {
    const m = /git version (\d+)\.(\d+)/.exec(text);
    return m ? [Number(m[1]), Number(m[2])] : null;
}
export function gitVersionAtLeast(version, min) {
    return version[0] > min[0] || (version[0] === min[0] && version[1] >= min[1]);
}
/** Null, or the actionable message for a git on PATH that is too old for the factory (or whose version cannot be read). */
export function factoryGitProblem(exec = defaultExec) {
    const r = exec('git', ['--version'], {});
    const want = `${FACTORY_GIT_MIN_VERSION[0]}.${FACTORY_GIT_MIN_VERSION[1]}`;
    const v = r.status === 0 ? parseGitVersion(r.stdout) : null;
    if (!v)
        return `the factory needs git >= ${want} (merge-tree --write-tree), and \`git --version\` could not be read`;
    if (gitVersionAtLeast(v, FACTORY_GIT_MIN_VERSION))
        return null;
    const full = /git version (\S+)/.exec(r.stdout)?.[1] ?? `${v[0]}.${v[1]}`;
    return `git ${full} is too old for the factory: it needs git >= ${want} (merge-tree --write-tree). On Ubuntu: add-apt-repository ppa:git-core/ppa && apt-get install git`;
}
//# sourceMappingURL=git-preflight.js.map