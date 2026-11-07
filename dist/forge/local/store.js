/**
 * The local forge's engine-owned files (offline forge plan §1.1): the PR
 * store and the check records live under the forge stateDir, which must be
 * outside every untrusted root (a lane must not be able to forge a PR state
 * or a green gate). Writes are atomic (temp file + rename); a store
 * read-modify-write holds a lock directory, so concurrent writers never lose
 * an update or reuse a PR number.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { atomicWriteFileSync } from '../../lib/atomic-write.js';
const realOr = (p) => {
    try {
        return realpathSync.native(p);
    }
    catch {
        return resolve(p);
    }
};
/** `path` is `root` or inside it (both resolved through symlinks where they exist). */
export function isUnder(path, root) {
    const rel = relative(realOr(root), realOr(path));
    const folded = process.platform === 'win32' ? rel.toLowerCase() : rel;
    return folded === '' || (!folded.startsWith('..') && !isAbsolute(folded));
}
/**
 * Refuse `dir` when it is not absolute, exists but is not a directory, or is
 * under one of `untrustedRoots`. Nothing is created (a dry run writes
 * nothing); the writers create it on first write. Returns the real path
 * when it exists, else the resolved one.
 */
export function engineOwnedDir(dir, untrustedRoots) {
    if (!isAbsolute(dir))
        throw new Error(`local forge: state directory ${dir} is not absolute`);
    if (existsSync(dir) && !lstatSync(dir).isDirectory())
        throw new Error(`local forge: state directory ${dir} is not a directory`);
    const real = realOr(dir);
    const root = untrustedRoots.find((r) => r.trim() !== '' && isUnder(real, r));
    if (root)
        throw new Error(`local forge: state directory ${real} is under the untrusted root ${root}`);
    return real;
}
/** Write a file atomically; the parent is created. */
export function writeAtomic(path, content) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(path, content);
}
const sleep = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
export const LOCK_TIMEOUT_MS = 15_000;
/** A lock directory older than this is left over from a crashed writer. */
export const LOCK_STALE_MS = 60_000;
/** Run `fn` while holding `<path>.lock` (an exclusive mkdir). */
export function withFileLock(path, fn, o = {}) {
    const lock = `${path}.lock`;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + (o.timeoutMs ?? LOCK_TIMEOUT_MS);
    for (let wait = 5;; wait = Math.min(wait * 2, 100)) {
        try {
            mkdirSync(lock);
            break;
        }
        catch (err) {
            if (err.code !== 'EEXIST')
                throw err;
            try {
                if (Date.now() - statSync(lock).mtimeMs > (o.staleMs ?? LOCK_STALE_MS)) {
                    rmSync(lock, { recursive: true, force: true });
                    continue;
                }
            }
            catch {
                continue; // released between the mkdir and the stat
            }
            if (Date.now() > deadline)
                throw new Error(`local forge: timed out waiting for the lock ${lock}`);
            sleep(wait);
        }
    }
    try {
        return fn();
    }
    finally {
        rmSync(lock, { recursive: true, force: true });
    }
}
const empty = () => ({ version: 1, next: 1, prs: [] });
function validPr(p) {
    const r = p;
    return !!r && Number.isInteger(r.number) && r.number > 0 && typeof r.head === 'string' && typeof r.base === 'string'
        && typeof r.title === 'string' && (r.state === 'OPEN' || r.state === 'MERGED' || r.state === 'CLOSED') && typeof r.isDraft === 'boolean';
}
/** The store at `path`; an absent file is an empty store, a malformed one throws. */
export function readPrStore(path) {
    if (!existsSync(path))
        return empty();
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch (err) {
        throw new Error(`local forge: the PR store ${path} is not valid JSON (${err.message})`);
    }
    const s = parsed;
    if (!s || s.version !== 1 || !Number.isInteger(s.next) || !Array.isArray(s.prs) || !s.prs.every(validPr)) {
        throw new Error(`local forge: the PR store ${path} is malformed`);
    }
    return { version: 1, next: Math.max(s.next, ...s.prs.map((p) => p.number + 1)), prs: s.prs };
}
/** Locked read-modify-write of the store; `fn` mutates the store and returns a result. */
export function updatePrStore(path, fn) {
    return withFileLock(path, () => {
        const store = readPrStore(path);
        const result = fn(store);
        writeAtomic(path, `${JSON.stringify(store, null, 2)}\n`);
        return result;
    });
}
//# sourceMappingURL=store.js.map