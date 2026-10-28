/**
 * The engine's own record of the state files it writes (review finding 1).
 *
 * Lanes run Copilot with a shell and read untrusted issue and PR content, so
 * any lane may rewrite `.omg/`: the factory run state, its owner file, the
 * ship state, and their seals (unkeyed sha256, recomputable by anyone). The
 * seals therefore only catch accidental hand edits. The engine is the one
 * trusted party, and it keeps, for every engine-owned file, the sha256 and
 * exact content of its last write (or "absent", for lock files). Every
 * reload, every save and every lane poll re-reads the files and compares;
 * any difference is `awaiting-human: state-tampered`, and the engine puts
 * its own bytes back after moving the changed file aside.
 *
 * The record lives in memory and in a sidecar outside the repository:
 * `$OMC_STATE_DIR/factory-ledger/` when that is set, else
 * `~/.omg/factory-ledger/`, directory mode 0700 and file mode 0600. The
 * sidecar also holds the shared-git snapshot taken before each running lane
 * (so a lost lane or a resume is compared against it) and the snapshot after
 * the last checked lane (re-compared before the engine's next git command).
 *
 * Residual risk: lanes are not sandboxed, so a lane whose shell can reach the
 * user's home can also rewrite this sidecar. An HMAC key kept next to it would
 * not change that (the lane could read the key), so there is none; the
 * defence is that the sidecar is outside the repository and the worktree a
 * lane is told to work in, and that the engine compares against its in-memory
 * copy while it runs.
 */
import { createHash } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { atomicWriteFileSync } from '../../lib/atomic-write.js';
export class LedgerError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LedgerError';
    }
}
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
/** `$OMC_STATE_DIR/factory-ledger` or `~/.omg/factory-ledger`: outside the repository. */
export function defaultLedgerDir(env = process.env) {
    const base = env.OMC_STATE_DIR?.trim() ? resolve(env.OMC_STATE_DIR) : join(homedir(), '.omg');
    return join(base, 'factory-ledger');
}
/** `run-<issue>.json`, or `run-heal-<sig8>.json` for a ci-heal run. */
export function ledgerFilePath(dir, root, key) {
    return join(dir, sha256(resolve(root).toLowerCase()).slice(0, 16), `run-${key}.json`);
}
/** The empty directory the engine passes as core.hooksPath (exec.ts hardenedGitExec). */
export function emptyHooksDir(dir) {
    const path = join(dir, 'empty-hooks');
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
}
/** The file's bytes, or null when it does not exist. */
export function currentBytes(path) {
    return existsSync(path) ? readFileSync(path) : null;
}
export class EngineLedger {
    file;
    data;
    existed;
    constructor(file, data, existed) {
        this.file = file;
        this.data = data;
        this.existed = existed;
    }
    /** Load the sidecar for (root, issue), or start an empty one; a malformed sidecar is refused. */
    static open(dir, root, issue) {
        const file = ledgerFilePath(dir, root, issue);
        if (!existsSync(file))
            return new EngineLedger(file, { version: 1, root: resolve(root), issue, files: {}, baselines: {} }, false);
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(file, 'utf8'));
        }
        catch (error) {
            throw new LedgerError(`the engine ledger ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
        const d = parsed;
        const filesOk = typeof d?.files === 'object' && d.files !== null && Object.values(d.files).every((f) => typeof f === 'object' && f !== null && (f.content === null ? f.sha256 === null : typeof f.content === 'string' && f.sha256 === sha256(f.content)));
        if (d?.version !== 1 || d.issue !== issue || !filesOk || typeof d.baselines !== 'object' || d.baselines === null) {
            throw new LedgerError(`the engine ledger ${file} is malformed; move it aside only after checking the run's state files by hand`);
        }
        return new EngineLedger(file, d, true);
    }
    tracks(path) {
        return Object.prototype.hasOwnProperty.call(this.data.files, resolve(path));
    }
    /** The content of the engine's last write of `path` (null: absent; undefined: not tracked). */
    recorded(path) {
        return this.data.files[resolve(path)]?.content;
    }
    /** Record the engine's write of `path` (null: the file must not exist) and persist the sidecar. */
    record(path, content) {
        this.data.files[resolve(path)] = { sha256: content === null ? null : sha256(content), content };
        this.persist();
    }
    /**
     * True when `bytes` (one read of `path`, null: absent) are exactly the
     * engine's last write of it. The caller parses these same bytes, so a swap
     * between a hash and a second read cannot happen. Untracked: false.
     */
    matches(path, bytes) {
        const rec = this.data.files[resolve(path)];
        if (!rec)
            return false;
        return (bytes === null ? null : sha256(bytes)) === rec.sha256;
    }
    /** Engine-owned files whose bytes differ from the engine's last write (optionally only `paths`). */
    mismatches(paths) {
        const wanted = paths ? new Set(paths.map((p) => resolve(p))) : null;
        const out = [];
        for (const [path, rec] of Object.entries(this.data.files)) {
            if (wanted && !wanted.has(path))
                continue;
            const now = currentBytes(path);
            const hash = now === null ? null : sha256(now);
            if (hash !== rec.sha256)
                out.push(path);
        }
        return out.sort();
    }
    /**
     * Move each mismatched file aside (`<file>.tampered-<stamp>`) and write the
     * engine's own bytes back; returns the aside paths.
     */
    restore(paths, stamp) {
        const aside = [];
        for (const raw of paths) {
            const path = resolve(raw);
            const rec = this.data.files[path];
            if (!rec)
                continue;
            if (existsSync(path)) {
                const to = `${path}.tampered-${stamp}`;
                renameSync(path, to);
                aside.push(to);
            }
            if (rec.content !== null)
                atomicWriteFileSync(path, rec.content);
        }
        return aside;
    }
    setBaseline(laneId, snapshot) {
        this.data.baselines[laneId] = snapshot;
        this.persist();
    }
    baseline(laneId) {
        return this.data.baselines[laneId];
    }
    dropBaseline(laneId) {
        if (!(laneId in this.data.baselines))
            return;
        delete this.data.baselines[laneId];
        this.persist();
    }
    get recheck() {
        return this.data.recheck;
    }
    setRecheck(recheck) {
        if (recheck)
            this.data.recheck = recheck;
        else
            delete this.data.recheck;
        this.persist();
    }
    persist() {
        const dir = dirname(this.file);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        atomicWriteFileSync(this.file, JSON.stringify(this.data));
        try {
            chmodSync(this.file, 0o600);
        }
        catch { /* best effort on Windows */ }
    }
}
/** True when the directory exists and holds no entry. */
export function isEmptyDir(path) {
    return existsSync(path) && readdirSync(path).length === 0;
}
//# sourceMappingURL=ledger.js.map