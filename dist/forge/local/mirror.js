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
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { basename, join, resolve } from 'path';
/** The git remote the engine registers for the mirror; never `origin`. */
export const LOCAL_REMOTE = 'omg-local';
const HEX40 = /^[0-9a-f]{40}$/;
/** A branch name the argv builders accept (a strict subset of check-ref-format). */
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])$/;
export function isLocalBranchName(name) {
    return BRANCH.test(name) && !name.endsWith('.lock') && !name.split('/').some((s) => s.startsWith('.') || s === '');
}
function branch(name) {
    if (!isLocalBranchName(name))
        throw new Error(`local forge: ${JSON.stringify(name)} is not a plain branch name`);
    return name;
}
function sha(value) {
    if (!HEX40.test(value))
        throw new Error(`local forge: expected a 40-hex commit sha, got ${JSON.stringify(value)}`);
    return value;
}
/**
 * `<dir name>-<12 hex>`: the hash of the resolved root (case-folded on
 * Windows), so two checkouts with one basename never share a mirror.
 */
export function localRepoId(root, platform = process.platform) {
    const abs = resolve(root).replace(/\\/g, '/').replace(/\/+$/, '');
    const key = platform === 'win32' ? abs.toLowerCase() : abs;
    const name = basename(key).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 60) || 'repo';
    return `${name}-${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12)}`;
}
export const localForgeDir = (stateDir) => join(stateDir, 'local');
export const localMirrorPath = (stateDir, root) => join(localForgeDir(stateDir), `${localRepoId(root)}.git`);
export const localStoreDir = (stateDir, root) => join(localForgeDir(stateDir), localRepoId(root));
export const localPrStorePath = (stateDir, root) => join(localStoreDir(stateDir, root), 'prs.json');
export const localCheckRecordPath = (stateDir, root, head) => join(localStoreDir(stateDir, root), 'checks', `${sha(head)}.json`);
/** `git init --bare --quiet <mirror>`: run once by the engine (any cwd). */
export const mirrorInitArgs = (mirror) => ['init', '--bare', '--quiet', mirror];
/** `git remote add omg-local <mirror>` in the user's checkout. */
export const mirrorRemoteAddArgs = (mirror) => ['remote', 'add', LOCAL_REMOTE, mirror];
/** `git remote get-url omg-local`: the engine compares it to localMirrorPath before every push. */
export const mirrorRemoteGetUrlArgs = () => ['remote', 'get-url', LOCAL_REMOTE];
/** `git push omg-local <sha>:refs/heads/<branch>`: no `+`, so a base sync is fast-forward only (a divergence is refused by git). */
export const mirrorPushArgs = (commit, to) => ['push', LOCAL_REMOTE, `${sha(commit)}:refs/heads/${branch(to)}`];
/** `git fetch omg-local <branch>`. */
export const mirrorFetchArgs = (from) => ['fetch', LOCAL_REMOTE, branch(from)];
/** The backlog files at a commit: `git ls-tree -z --name-only <sha> -- <dir>/` (paths, NUL-separated). */
export const backlogListArgs = (commit, dir) => ['ls-tree', '-z', '--name-only', sha(commit), '--', `${dir}/`];
/** One backlog file at a commit: `git show <sha>:<path>`. */
export const backlogShowArgs = (commit, path) => ['show', `${sha(commit)}:${path}`];
/** Whether `head` is in `base` (a local PR is MERGED): `git merge-base --is-ancestor <head> <base>`, exit 0 yes, 1 no. */
export const mergedArgs = (head, base) => ['merge-base', '--is-ancestor', sha(head), sha(base)];
/**
 * The commit `refs/heads/<branch>` names in the bare mirror, read from the
 * loose ref or packed-refs; undefined when the mirror or the branch is absent.
 */
export function readMirrorRef(mirror, name) {
    const ref = `refs/heads/${branch(name)}`;
    const loose = join(mirror, ...ref.split('/'));
    if (existsSync(loose)) {
        const value = readFileSync(loose, 'utf8').trim();
        if (HEX40.test(value))
            return value;
        throw new Error(`local forge: ${loose} does not hold a commit sha`);
    }
    const packed = join(mirror, 'packed-refs');
    if (!existsSync(packed))
        return undefined;
    for (const line of readFileSync(packed, 'utf8').split(/\r?\n/)) {
        const m = /^([0-9a-f]{40}) (\S+)$/.exec(line);
        if (m && m[2] === ref)
            return m[1];
    }
    return undefined;
}
//# sourceMappingURL=mirror.js.map