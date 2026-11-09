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

const realOr = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
};

/** `path` is `root` or inside it (both resolved through symlinks where they exist). */
export function isUnder(path: string, root: string): boolean {
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
export function engineOwnedDir(dir: string, untrustedRoots: readonly string[]): string {
  if (!isAbsolute(dir)) throw new Error(`local forge: state directory ${dir} is not absolute`);
  if (existsSync(dir) && !lstatSync(dir).isDirectory()) throw new Error(`local forge: state directory ${dir} is not a directory`);
  const real = realOr(dir);
  const root = untrustedRoots.find((r) => r.trim() !== '' && isUnder(real, r));
  if (root) throw new Error(`local forge: state directory ${real} is under the untrusted root ${root}`);
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
export function noLinkPath(anchor: string, path: string, create = true, refuseLinkedAnchor = false): boolean {
  const top = resolve(anchor);
  const rel = relative(top, resolve(path));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`local forge: ${path} is not under ${anchor}`);
  const parts = rel.split(sep);
  // The runtime root (`.omg`) sits in the untrusted tree: it too must not be a link to somewhere else. A checkout root may be one.
  if (refuseLinkedAnchor && lstatSync(top, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`local forge: refusing to go through the symbolic link ${top}`);
  if (create) mkdirSync(top, { recursive: true, mode: 0o700 });
  let cur = top;
  for (const [i, part] of parts.entries()) {
    cur = join(cur, part);
    const leaf = i === parts.length - 1;
    let st = lstatSync(cur, { throwIfNoEntry: false });
    if (!st && !leaf) {
      if (!create) return false;
      try {
        mkdirSync(cur, { mode: 0o700 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      st = lstatSync(cur);
    }
    if (st?.isSymbolicLink()) throw new Error(`local forge: refusing to go through the symbolic link ${cur}`);
    if (st && !leaf && !st.isDirectory()) throw new Error(`local forge: ${cur} is not a directory`);
  }
  return true;
}

/**
 * Write a file atomically; the parent is created. With `anchor`, no
 * component below it may be a symbolic link (noLinkPath).
 */
export function writeAtomic(path: string, content: string, anchor?: string, refuseLinkedAnchor = false): void {
  if (anchor === undefined) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  else noLinkPath(anchor, path, true, refuseLinkedAnchor);
  atomicWriteFileSync(path, content);
}

/** Append to a file under `anchor` without following a link below it (O_NOFOLLOW on the leaf where the platform has it). */
export function appendNoFollow(anchor: string, path: string, text: string, refuseLinkedAnchor = false): void {
  noLinkPath(anchor, path, true, refuseLinkedAnchor);
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export const LOCK_TIMEOUT_MS = 15_000;
/** A lock directory older than this is left over from a crashed writer. */
export const LOCK_STALE_MS = 60_000;

/** How long a Windows EPERM/EACCES on the lock directory is waited out as a pending delete. */
export const PENDING_DELETE_MS = 2_000;

const OWNER = 'owner';
const ownerOf = (lock: string): string | undefined => {
  try {
    return readFileSync(join(lock, OWNER), 'utf8');
  } catch {
    return undefined;
  }
};

/**
 * Remove a stale lock: rename it to a name only this waiter uses, so two
 * waiters never both break one lock (the second rename fails), then check
 * the renamed lock is still stale (a fresh lock taken in between goes back)
 * and remove it.
 */
function breakStaleLock(lock: string, staleMs: number, token: string, seenOwner: string | undefined): void {
  // The lock must still be the one judged stale: a release and a fresh acquire in between changes its owner token.
  if (ownerOf(lock) !== seenOwner) return;
  const aside = `${lock}.stale-${token}`;
  try {
    renameSync(lock, aside);
  } catch {
    return; // another waiter broke it first, or it was released
  }
  // Checked again on the renamed lock: a fresh lock taken between the check above and the rename goes back.
  if (ownerOf(aside) === seenOwner && Date.now() - statSync(aside).mtimeMs > staleMs) {
    rmSync(aside, { recursive: true, force: true });
    return;
  }
  try {
    renameSync(aside, lock);
  } catch {
    rmSync(aside, { recursive: true, force: true }); // its owner finds its token gone and leaves the newer lock alone
  }
}

/**
 * Run `fn` while holding `<path>.lock` (an exclusive mkdir holding an owner
 * token). Only the owner releases the lock; a lock older than `staleMs` is
 * broken by one waiter.
 */
export function withFileLock<T>(path: string, fn: () => T, o: { timeoutMs?: number; staleMs?: number } = {}): T {
  const lock = `${path}.lock`;
  const token = `${process.pid}-${randomUUID()}`;
  const staleMs = o.staleMs ?? LOCK_STALE_MS;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + (o.timeoutMs ?? LOCK_TIMEOUT_MS);
  let deniedSince: number | undefined;
  for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, OWNER), token);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Windows: EPERM/EACCES while a removed lock directory's delete is still pending.
      const pending = process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES');
      if (code !== 'EEXIST' && !pending) throw err;
      if (pending) {
        // A pending delete clears within moments; a lasting EPERM is a real permission error, not a wait.
        deniedSince ??= Date.now();
        if (Date.now() - deniedSince > PENDING_DELETE_MS) throw err;
      } else {
        deniedSince = undefined;
        let age: number;
        try {
          age = Date.now() - statSync(lock).mtimeMs;
        } catch {
          continue; // released between the mkdir and the stat
        }
        if (age > staleMs) {
          breakStaleLock(lock, staleMs, token, ownerOf(lock));
          continue;
        }
      }
      if (Date.now() > deadline) throw new Error(`local forge: timed out waiting for the lock ${lock}`);
      sleep(wait);
    }
  }
  try {
    return fn();
  } finally {
    if (ownerOf(lock) === token) rmSync(lock, { recursive: true, force: true });
  }
}

export interface LocalPr {
  number: number;
  /** Branch names (refs/heads/<name> in the mirror). */
  head: string;
  base: string;
  title: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft: boolean;
  itemId?: number;
  createdAt: string;
  /** The head sha MERGED was detected at. */
  mergedHead?: string;
  mergedAt?: string;
  /** Why a CLOSED PR was closed (`cancelled`: omg factory run cancel), when, and its head then. */
  closedReason?: string;
  closedAt?: string;
  closedHead?: string;
}

export interface LocalPrStore {
  version: 1;
  /** The next PR number; numbers are never reused. */
  next: number;
  prs: LocalPr[];
}

const empty = (): LocalPrStore => ({ version: 1, next: 1, prs: [] });

function validPr(p: unknown): p is LocalPr {
  const r = p as Partial<LocalPr> | null;
  return !!r && Number.isInteger(r.number) && (r.number as number) > 0 && typeof r.head === 'string' && typeof r.base === 'string'
    && typeof r.title === 'string' && (r.state === 'OPEN' || r.state === 'MERGED' || r.state === 'CLOSED') && typeof r.isDraft === 'boolean';
}

/** The store at `path`; an absent file is an empty store, a malformed one throws. */
export function readPrStore(path: string): LocalPrStore {
  if (!existsSync(path)) return empty();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`local forge: the PR store ${path} is not valid JSON (${(err as Error).message})`);
  }
  const s = parsed as Partial<LocalPrStore> | null;
  if (!s || s.version !== 1 || !Number.isInteger(s.next) || !Array.isArray(s.prs) || !s.prs.every(validPr)) {
    throw new Error(`local forge: the PR store ${path} is malformed`);
  }
  return { version: 1, next: Math.max(s.next as number, ...s.prs.map((p) => p.number + 1)), prs: s.prs };
}

/** Locked read-modify-write of the store; `fn` mutates the store and returns a result. */
export function updatePrStore<T>(path: string, fn: (store: LocalPrStore) => T): T {
  return withFileLock(path, () => {
    const store = readPrStore(path);
    const result = fn(store);
    writeAtomic(path, `${JSON.stringify(store, null, 2)}\n`);
    return result;
  });
}
