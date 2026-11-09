/**
 * The local forge's engine-owned files (offline forge plan §1.1): the PR
 * store and the check records live under the forge stateDir, which must be
 * outside every untrusted root (a lane must not be able to forge a PR state
 * or a green gate). Writes are atomic (temp file + rename); a store
 * read-modify-write holds a lock directory, so concurrent writers never lose
 * an update or reuse a PR number.
 */
import { randomUUID } from 'crypto';
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
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
/**
 * Refuse a path under `anchor` (the checkout or the runtime root, both in
 * the untrusted working tree) when any component below `anchor`, the leaf
 * included, is a symbolic link (or a junction), or a parent is not a
 * directory: a planted link must not redirect a write or a read outside the
 * tree. With `create`, the anchor is made when missing and the parents below
 * it one at a time, each checked again; without it, false when a parent is
 * missing. The leaf may be absent.
 */
export function noLinkPath(anchor, path, create = true) {
    const top = resolve(anchor);
    const rel = relative(top, resolve(path));
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
        throw new Error(`local forge: ${path} is not under ${anchor}`);
    const parts = rel.split(sep);
    if (create)
        mkdirSync(top, { recursive: true, mode: 0o700 });
    let cur = top;
    for (const [i, part] of parts.entries()) {
        cur = join(cur, part);
        const leaf = i === parts.length - 1;
        let st = lstatSync(cur, { throwIfNoEntry: false });
        if (!st && !leaf) {
            if (!create)
                return false;
            try {
                mkdirSync(cur, { mode: 0o700 });
            }
            catch (err) {
                if (err.code !== 'EEXIST')
                    throw err;
            }
            st = lstatSync(cur);
        }
        if (st?.isSymbolicLink())
            throw new Error(`local forge: refusing to go through the symbolic link ${cur}`);
        if (st && !leaf && !st.isDirectory())
            throw new Error(`local forge: ${cur} is not a directory`);
    }
    return true;
}
/**
 * Write a file atomically; the parent is created. With `anchor`, no
 * component below it may be a symbolic link (noLinkPath).
 */
export function writeAtomic(path, content, anchor) {
    if (anchor === undefined)
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    else
        noLinkPath(anchor, path);
    atomicWriteFileSync(path, content);
}
/** Append to a file under `anchor` without following a link below it (O_NOFOLLOW on the leaf where the platform has it). */
export function appendNoFollow(anchor, path, text) {
    noLinkPath(anchor, path);
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
        writeFileSync(fd, text);
    }
    finally {
        closeSync(fd);
    }
}
const sleep = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
export const LOCK_TIMEOUT_MS = 15_000;
/** A lock directory older than this is left over from a crashed writer. */
export const LOCK_STALE_MS = 60_000;
const OWNER = 'owner';
const ownerOf = (lock) => {
    try {
        return readFileSync(join(lock, OWNER), 'utf8');
    }
    catch {
        return undefined;
    }
};
/**
 * Remove a stale lock: rename it to a name only this waiter uses, so two
 * waiters never both break one lock (the second rename fails), then check
 * the renamed lock is still stale (a fresh lock taken in between goes back)
 * and remove it.
 */
function breakStaleLock(lock, staleMs, token) {
    const aside = `${lock}.stale-${token}`;
    try {
        renameSync(lock, aside);
    }
    catch {
        return; // another waiter broke it first, or it was released
    }
    if (Date.now() - statSync(aside).mtimeMs > staleMs) {
        rmSync(aside, { recursive: true, force: true });
        return;
    }
    try {
        renameSync(aside, lock);
    }
    catch {
        rmSync(aside, { recursive: true, force: true }); // its owner finds its token gone and leaves the newer lock alone
    }
}
/**
 * Run `fn` while holding `<path>.lock` (an exclusive mkdir holding an owner
 * token). Only the owner releases the lock; a lock older than `staleMs` is
 * broken by one waiter.
 */
export function withFileLock(path, fn, o = {}) {
    const lock = `${path}.lock`;
    const token = `${process.pid}-${randomUUID()}`;
    const staleMs = o.staleMs ?? LOCK_STALE_MS;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + (o.timeoutMs ?? LOCK_TIMEOUT_MS);
    for (let wait = 5;; wait = Math.min(wait * 2, 100)) {
        try {
            mkdirSync(lock);
            writeFileSync(join(lock, OWNER), token);
            break;
        }
        catch (err) {
            const code = err.code;
            // Windows: EPERM/EACCES while a removed lock directory's delete is still pending.
            const pending = process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES');
            if (code !== 'EEXIST' && !pending)
                throw err;
            if (!pending) {
                let age;
                try {
                    age = Date.now() - statSync(lock).mtimeMs;
                }
                catch {
                    continue; // released between the mkdir and the stat
                }
                if (age > staleMs) {
                    breakStaleLock(lock, staleMs, token);
                    continue;
                }
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
        if (ownerOf(lock) === token)
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
/** At most this many characters of review text in one record. */
export const MAX_LOCAL_REVIEW_CHARS = 20_000;
/** `<storeDir>/prs/<n>/reviews.jsonl`: engine-owned (outside every lane-writable root), beside prs.json. */
export const localReviewsPath = (storeDir, pr) => join(storeDir, 'prs', String(pr), 'reviews.jsonl');
function validReview(r, pr) {
    const v = r;
    return !!v && v.version === 1 && typeof v.id === 'string' && v.pr === pr && typeof v.author === 'string' && v.author !== ''
        && (v.state === 'approved' || v.state === 'changes-requested' || v.state === 'commented') && typeof v.body === 'string'
        && typeof v.head === 'string' && /^[0-9a-f]{40}$/.test(v.head) && typeof v.at === 'string';
}
/** The PR's played-back reviews in order; none when the file is absent. A malformed line throws (the file is engine-owned). */
export function readLocalReviews(storeDir, pr) {
    const path = localReviewsPath(storeDir, pr);
    if (!noLinkPath(storeDir, path, false) || !existsSync(path))
        return [];
    return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '').map((line, i) => {
        let r;
        try {
            r = JSON.parse(line);
        }
        catch {
            throw new Error(`local forge: review record ${i + 1} of ${path} is not valid JSON`);
        }
        if (!validReview(r, pr))
            throw new Error(`local forge: review record ${i + 1} of ${path} is malformed`);
        return r;
    });
}
/** Append one review record under the file's lock, without following a link below `storeDir`. */
export function appendLocalReview(storeDir, record) {
    if (!validReview(record, record.pr))
        throw new Error('local forge: refusing a malformed review record');
    if (record.body.length > MAX_LOCAL_REVIEW_CHARS)
        throw new Error(`local forge: the review text is over ${MAX_LOCAL_REVIEW_CHARS} characters`);
    const path = localReviewsPath(storeDir, record.pr);
    noLinkPath(storeDir, path);
    withFileLock(path, () => appendNoFollow(storeDir, path, `${JSON.stringify(record)}\n`));
}
//# sourceMappingURL=store.js.map