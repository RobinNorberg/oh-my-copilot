/**
 * Host git check for the factory: `merge-tree --write-tree` (mirror sync, lane
 * commits) needs git 2.38. Run once, early, so an old git (Ubuntu 20.04 ships
 * 2.25) gets one actionable message instead of git's usage text from a later
 * command. The private layout has its own, stricter check (gitVersionProblem).
 */
import { type Exec } from '../ship/exec.js';
export declare const FACTORY_GIT_MIN_VERSION: readonly [2, 38];
/** "major.minor" from `git --version` output ("git version 2.50.1.windows.1", "git version 2.39.3 (Apple Git-146)"), or null. */
export declare function parseGitVersion(text: string): [number, number] | null;
export declare function gitVersionAtLeast(version: readonly [number, number], min: readonly [number, number]): boolean;
/** Null, or the actionable message for a git on PATH that is too old for the factory (or whose version cannot be read). */
export declare function factoryGitProblem(exec?: Exec): string | null;
//# sourceMappingURL=git-preflight.d.ts.map