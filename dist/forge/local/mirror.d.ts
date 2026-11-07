/**
 * The local forge's on-disk layout and git argv (offline forge plan §1.1).
 * Pure: paths, the repo id and argv builders. It never spawns; the engine
 * runs these argv through its guarded Exec. readMirrorRef reads a ref file.
 *
 * Layout under the engine-owned stateDir (getGlobalOmcStatePath('forge'),
 * outside every untrusted root):
 *   <stateDir>/local/<repo-id>.git              the bare mirror (git remote `omg-local`)
 *   <stateDir>/local/<repo-id>/prs.json         the PR store
 *   <stateDir>/local/<repo-id>/checks/<sha>.json the local-gate record per head
 */
/** The git remote the engine registers for the mirror; never `origin`. */
export declare const LOCAL_REMOTE = "omg-local";
export declare function isLocalBranchName(name: string): boolean;
/**
 * `<dir name>-<12 hex>`: the hash of the resolved root (case-folded on
 * Windows), so two checkouts with one basename never share a mirror.
 */
export declare function localRepoId(root: string, platform?: NodeJS.Platform): string;
export declare const localForgeDir: (stateDir: string) => string;
export declare const localMirrorPath: (stateDir: string, root: string) => string;
export declare const localStoreDir: (stateDir: string, root: string) => string;
export declare const localPrStorePath: (stateDir: string, root: string) => string;
export declare const localCheckRecordPath: (stateDir: string, root: string, head: string) => string;
/** `git init --bare --quiet <mirror>`: run once by the engine (any cwd). */
export declare const mirrorInitArgs: (mirror: string) => string[];
/** `git remote add omg-local <mirror>` in the user's checkout. */
export declare const mirrorRemoteAddArgs: (mirror: string) => string[];
/** `git remote get-url omg-local`: the engine compares it to localMirrorPath before every push. */
export declare const mirrorRemoteGetUrlArgs: () => string[];
/** `git push omg-local <sha>:refs/heads/<branch>`: no `+`, so a base sync is fast-forward only (a divergence is refused by git). */
export declare const mirrorPushArgs: (commit: string, to: string) => string[];
/** `git fetch omg-local <branch>`. */
export declare const mirrorFetchArgs: (from: string) => string[];
/** The backlog files at a commit: `git ls-tree -z --name-only <sha> -- <dir>/` (paths, NUL-separated). */
export declare const backlogListArgs: (commit: string, dir: string) => string[];
/** One backlog file at a commit: `git show <sha>:<path>`. */
export declare const backlogShowArgs: (commit: string, path: string) => string[];
/** Whether `head` is in `base` (a local PR is MERGED): `git merge-base --is-ancestor <head> <base>`, exit 0 yes, 1 no. */
export declare const mergedArgs: (head: string, base: string) => string[];
/**
 * The commit `refs/heads/<branch>` names in the bare mirror, read from the
 * loose ref or packed-refs; undefined when the mirror or the branch is absent.
 */
export declare function readMirrorRef(mirror: string, name: string): string | undefined;
//# sourceMappingURL=mirror.d.ts.map