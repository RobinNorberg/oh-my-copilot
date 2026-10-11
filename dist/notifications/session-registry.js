/**
 * Session Registry Module
 *
 * Maps platform message IDs to tmux pane IDs for reply correlation.
 * Uses JSONL append format for atomic writes, following the pattern from
 * session-replay.ts with secure file permissions from daemon.ts.
 *
 * Registry location: XDG-aware global OMC state (legacy ~/.omg/state fallback for reads)
 * File permissions: 0600 (owner read/write only)
 */
import { existsSync, readFileSync, mkdirSync, openSync, closeSync, writeSync, unlinkSync, statSync, constants, } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { atomicWriteFileSync } from '../lib/atomic-write.js';
import { isProcessAlive } from '../platform/index.js';
import { getGlobalOmcStateCandidates, getGlobalOmcStateRoot } from '../utils/paths.js';
// ============================================================================
// Constants
// ============================================================================
/** Secure file permissions (owner read/write only) */
const SECURE_FILE_MODE = 0o600;
/** Maximum age for entries (24 hours) */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Lock settings */
const LOCK_TIMEOUT_MS = 2000;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 10000;
const LOCK_MAX_WAIT_MS = 10000;
/**
 * Return the registry state directory.
 * OMC_TEST_REGISTRY_DIR overrides the default global state dir so that tests
 * can redirect all I/O to a temporary directory without touching global state.
 */
function getRegistryStateDir() {
    return process.env['OMC_TEST_REGISTRY_DIR'] ?? getGlobalOmcStateRoot();
}
/** Global registry JSONL path */
function getRegistryPath() {
    return join(getRegistryStateDir(), 'reply-session-registry.jsonl');
}
function getRegistryReadPaths() {
    if (process.env['OMC_TEST_REGISTRY_DIR']) {
        return [getRegistryPath()];
    }
    return getGlobalOmcStateCandidates('reply-session-registry.jsonl');
}
/** Lock file path for cross-process synchronization */
function getLockPath() {
    return join(getRegistryStateDir(), 'reply-session-registry.lock');
}
// Shared array for Atomics.wait-based synchronous sleep
const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));
// ============================================================================
// Core Functions
// ============================================================================
/**
 * Ensure registry directory exists with secure permissions
 */
function ensureRegistryDir() {
    const registryDir = dirname(getRegistryPath());
    if (!existsSync(registryDir)) {
        mkdirSync(registryDir, { recursive: true, mode: 0o700 });
    }
}
/**
 * Synchronous sleep helper used while waiting for lock acquisition.
 */
function sleepMs(ms) {
    try {
        Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
    }
    catch {
        // Main thread: Atomics.wait throws on Node <22
        const waitUntil = Date.now() + ms;
        while (Date.now() < waitUntil) { /* spin */ }
    }
}
/**
 * Read/parse lock snapshot.
 *
 * Supports:
 * - current JSON format: {"pid":123,"token":"...","acquiredAt":...}
 * - legacy text format: "123:1700000000000"
 */
function readLockSnapshot() {
    try {
        const raw = readFileSync(getLockPath(), 'utf-8');
        const trimmed = raw.trim();
        if (!trimmed) {
            return { raw, pid: null, token: null };
        }
        try {
            const parsed = JSON.parse(trimmed);
            const pid = typeof parsed.pid === 'number' && Number.isFinite(parsed.pid) ? parsed.pid : null;
            const token = typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : null;
            return { raw, pid, token };
        }
        catch {
            const [pidStr] = trimmed.split(':');
            const parsedPid = Number.parseInt(pidStr ?? '', 10);
            return {
                raw,
                pid: Number.isFinite(parsedPid) && parsedPid > 0 ? parsedPid : null,
                token: null,
            };
        }
    }
    catch {
        return null;
    }
}
/**
 * Remove lock file only if content still matches expected snapshot.
 */
function removeLockIfUnchanged(snapshot) {
    try {
        const currentRaw = readFileSync(getLockPath(), 'utf-8');
        if (currentRaw !== snapshot.raw) {
            return false;
        }
    }
    catch {
        return false;
    }
    try {
        unlinkSync(getLockPath());
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Acquire registry lock (cross-process) using O_EXCL lock file semantics.
 * Returns lock file descriptor when acquired, null on timeout.
 */
function acquireRegistryLock() {
    ensureRegistryDir();
    const started = Date.now();
    while (Date.now() - started < LOCK_TIMEOUT_MS) {
        try {
            const token = randomUUID();
            const fd = openSync(getLockPath(), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, SECURE_FILE_MODE);
            // Write lock payload for stale-lock checks + ownership-safe unlock.
            const lockPayload = JSON.stringify({
                pid: process.pid,
                acquiredAt: Date.now(),
                token,
            });
            writeSync(fd, lockPayload, null, 'utf-8');
            return { fd, token };
        }
        catch (error) {
            const err = error;
            if (err.code !== 'EEXIST') {
                throw error;
            }
            // Remove stale lock only if ownership checks indicate it's safe.
            try {
                const lockAgeMs = Date.now() - statSync(getLockPath()).mtimeMs;
                if (lockAgeMs > LOCK_STALE_MS) {
                    const snapshot = readLockSnapshot();
                    if (!snapshot) {
                        sleepMs(LOCK_RETRY_MS);
                        continue;
                    }
                    // Never reap an active lock held by a live process.
                    if (snapshot.pid !== null && isProcessAlive(snapshot.pid)) {
                        sleepMs(LOCK_RETRY_MS);
                        continue;
                    }
                    if (removeLockIfUnchanged(snapshot)) {
                        continue;
                    }
                }
            }
            catch {
                // Lock may disappear between stat/unlink attempts
            }
            sleepMs(LOCK_RETRY_MS);
        }
    }
    return null;
}
/**
 * Acquire registry lock with retries up to a cumulative deadline.
 * Returns null if the deadline is exceeded (e.g. lock holder is a hung process).
 */
function acquireRegistryLockOrWait(maxWaitMs = LOCK_MAX_WAIT_MS) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        const lock = acquireRegistryLock();
        if (lock !== null) {
            return lock;
        }
        sleepMs(LOCK_RETRY_MS);
    }
    return null;
}
/**
 * Release registry lock.
 */
function releaseRegistryLock(lock) {
    try {
        closeSync(lock.fd);
    }
    catch {
        // Ignore close errors
    }
    // Ownership-safe unlock: only remove lock if token still matches our lock.
    const snapshot = readLockSnapshot();
    if (!snapshot || snapshot.token !== lock.token) {
        return;
    }
    removeLockIfUnchanged(snapshot);
}
/**
 * Execute a mutation while holding the registry lock. Mutations never proceed
 * without ownership: callers receive `null` and can retry after lock failure.
 */
function withRegistryLock(onLocked) {
    const lock = acquireRegistryLockOrWait();
    if (lock === null)
        return null;
    try {
        return onLocked();
    }
    finally {
        releaseRegistryLock(lock);
    }
}
/**
 * Reserve an empty registry while the exact listener generation is stopped.
 * Holding this lock prevents a concurrent notification registration from being
 * lost between its empty check and process termination.
 */
export function lockRegistryIfEmpty() {
    const lock = acquireRegistryLock();
    if (lock === null)
        return null;
    if (readAllMappingsUnsafe().length > 0) {
        releaseRegistryLock(lock);
        return 'active';
    }
    let released = false;
    return () => {
        if (!released) {
            released = true;
            releaseRegistryLock(lock);
        }
    };
}
/**
 * Register a message mapping (atomic JSONL append).
 *
 * Uses O_WRONLY | O_APPEND | O_CREAT for atomic appends (up to PIPE_BUF bytes on Linux).
 * Each mapping serializes to well under 4096 bytes, making this operation atomic.
 */
export function registerMessage(mapping) {
    return withRegistryLock(() => {
        ensureRegistryDir();
        const existing = readAllMappingsUnsafe().find((candidate) => candidate.platform === mapping.platform &&
            candidate.messageId === mapping.messageId &&
            candidate.sessionId === mapping.sessionId &&
            candidate.tmuxPaneId === mapping.tmuxPaneId);
        if (existing)
            return true;
        const line = JSON.stringify(mapping) + '\n';
        const fd = openSync(getRegistryPath(), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, SECURE_FILE_MODE);
        try {
            writeSync(fd, Buffer.from(line, 'utf-8'));
            return true;
        }
        finally {
            closeSync(fd);
        }
    }) ?? false;
}
/**
 * Load all mappings from the JSONL file
 */
export function loadAllMappings() {
    return withRegistryLock(() => readAllMappingsUnsafe()) ?? readAllMappingsUnsafe();
}
/**
 * Load all mappings without lock.
 * Caller must already hold lock (or accept race risk).
 */
function readAllMappingsUnsafe() {
    for (const registryPath of getRegistryReadPaths()) {
        if (!existsSync(registryPath)) {
            continue;
        }
        try {
            const content = readFileSync(registryPath, 'utf-8');
            return content
                .split('\n')
                .filter(line => line.trim())
                .map(line => {
                try {
                    return JSON.parse(line);
                }
                catch {
                    return null;
                }
            })
                .filter((m) => m !== null);
        }
        catch {
            continue;
        }
    }
    return [];
}
/**
 * Look up a mapping by platform and message ID.
 * Returns the most recent entry when duplicates exist (last match in append-ordered JSONL).
 */
export function lookupByMessageId(platform, messageId) {
    const mappings = loadAllMappings();
    // Use findLast so that the most recently appended entry wins when duplicates exist.
    return mappings.findLast(m => m.platform === platform && m.messageId === messageId) ?? null;
}
/**
 * Remove all entries for a given session ID.
 * This is a rewrite operation (infrequent - only on session-end).
 */
export function removeSession(sessionId) {
    return withRegistryLock(() => {
        const mappings = readAllMappingsUnsafe();
        const filtered = mappings.filter(m => m.sessionId !== sessionId);
        if (filtered.length !== mappings.length)
            rewriteRegistryUnsafe(filtered);
        return true;
    }) ?? false;
}
/**
 * Remove the pane-injecting entries for a given pane ID. Called by the reply
 * listener when pane verification fails (stale pane cleanup) and by notify()
 * before a non-replyable message. Approval-gate entries (`approvalRef`, from
 * `omg graph` remote approval) are kept: their replies never touch a pane.
 *
 * Pane ids (`%N`) are per tmux/psmux server, and a mapping records no server
 * identifier. With `tmuxSessionName`, an entry recorded under another session
 * name is kept; a collision with the same session name on another server
 * still matches (removal is the safe side).
 */
export function removeMessagesByPane(paneId, tmuxSessionName) {
    return withRegistryLock(() => {
        const mappings = readAllMappingsUnsafe();
        const filtered = mappings.filter(m => m.tmuxPaneId !== paneId || Boolean(m.approvalRef)
            || Boolean(tmuxSessionName && m.tmuxSessionName && m.tmuxSessionName !== tmuxSessionName));
        if (filtered.length !== mappings.length)
            rewriteRegistryUnsafe(filtered);
        return true;
    }) ?? false;
}
/** Per-pane "non-replyable since" markers: `{ [tmuxSessionName | '']: ISO time }`. */
function getPaneReplyBlockPath(paneId) {
    return join(getRegistryStateDir(), `reply-blocked-pane-${paneId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}
/**
 * The pane's markers (a null-prototype object, so a session named
 * `__proto__` is an ordinary key), `{}` without a marker file, or null when
 * the file exists but cannot be read or parsed: callers fail closed.
 */
function readPaneReplyBlocks(paneId) {
    const blocks = Object.create(null);
    try {
        const parsed = JSON.parse(readFileSync(getPaneReplyBlockPath(paneId), 'utf-8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.assign(blocks, parsed) : null;
    }
    catch (err) {
        return err.code === 'ENOENT' ? blocks : null;
    }
}
/**
 * Record that the pane shows a non-replyable message (a Copilot permission
 * menu) from now on. No registry lock: it must hold when the lock times out.
 * {@link isPaneReplyBlocked} then refuses every mapping created before it, so
 * a reply mapping registered after removeMessagesByPane by a notification
 * that started earlier (concurrent hook children) is never injected.
 * Written via temp file + rename, so a reader never sees a truncated file.
 * An unparseable marker file is replaced by an unnamed marker, which refuses
 * every session's earlier mappings as the unparseable file did.
 */
export function markPaneNonReplyable(paneId, tmuxSessionName = '', at = new Date()) {
    ensureRegistryDir();
    const blocks = readPaneReplyBlocks(paneId) ?? Object.assign(Object.create(null), { '': at.toISOString() });
    blocks[tmuxSessionName] = at.toISOString();
    atomicWriteFileSync(getPaneReplyBlockPath(paneId), JSON.stringify(blocks));
}
/**
 * Whether a reply into the pane must be refused: a non-replyable marker for
 * the pane (same session name, or either side unnamed) is not older than the
 * mapping's `createdAt`. Without a mapping, any marker younger than MAX_AGE_MS.
 */
export function isPaneReplyBlocked(paneId, mapping, nowMs = Date.now()) {
    const blocks = readPaneReplyBlocks(paneId);
    if (!blocks)
        return true; // unreadable marker file: fail closed
    const createdMs = mapping ? new Date(mapping.createdAt).getTime() : NaN;
    return Object.entries(blocks).some(([session, at]) => {
        if (session && mapping?.tmuxSessionName && session !== mapping.tmuxSessionName)
            return false;
        const atMs = new Date(at).getTime();
        if (!Number.isFinite(atMs))
            return true; // unreadable marker: fail closed
        return Number.isFinite(createdMs) ? createdMs <= atMs : nowMs - atMs < MAX_AGE_MS;
    });
}
/**
 * Remove entries older than MAX_AGE_MS (24 hours).
 * This is a rewrite operation (infrequent - called periodically by daemon).
 */
export function pruneStale() {
    return withRegistryLock(() => {
        const now = Date.now();
        const mappings = readAllMappingsUnsafe();
        const filtered = mappings.filter(m => {
            try {
                return now - new Date(m.createdAt).getTime() < MAX_AGE_MS;
            }
            catch {
                return false;
            }
        });
        if (filtered.length !== mappings.length)
            rewriteRegistryUnsafe(filtered);
        return true;
    }) ?? false;
}
/**
 * Rewrite the entire registry file with new mappings.
 * Used by removeSession, removeMessagesByPane, and pruneStale.
 */
function rewriteRegistryUnsafe(mappings) {
    ensureRegistryDir();
    const content = mappings.length === 0
        ? ''
        : mappings.map(m => JSON.stringify(m)).join('\n') + '\n';
    atomicWriteFileSync(getRegistryPath(), content);
}
//# sourceMappingURL=session-registry.js.map