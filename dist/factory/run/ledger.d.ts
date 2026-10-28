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
import type { RepoSnapshot } from './review-guard.js';
import type { FactoryLaneKind, FactoryRunKey } from './state.js';
export declare class LedgerError extends Error {
    constructor(message: string);
}
/** One engine-owned file: the bytes of the engine's last write, or null for "must not exist". */
export interface LedgerFile {
    sha256: string | null;
    content: string | null;
}
export interface LedgerRecheck {
    laneId: string;
    kind: FactoryLaneKind;
    /** Shared git state right after the lane's check passed (re-based after the engine's own fetch / push). */
    snapshot: RepoSnapshot;
}
export declare const sha256: (data: string | Buffer) => string;
/** `$OMC_STATE_DIR/factory-ledger` or `~/.omg/factory-ledger`: outside the repository. */
export declare function defaultLedgerDir(env?: NodeJS.ProcessEnv): string;
/** `run-<issue>.json`, or `run-heal-<sig8>.json` for a ci-heal run. */
export declare function ledgerFilePath(dir: string, root: string, key: FactoryRunKey): string;
/** The empty directory the engine passes as core.hooksPath (exec.ts hardenedGitExec). */
export declare function emptyHooksDir(dir: string): string;
/** The file's bytes, or null when it does not exist. */
export declare function currentBytes(path: string): Buffer | null;
export declare class EngineLedger {
    readonly file: string;
    private readonly data;
    readonly existed: boolean;
    private constructor();
    /** Load the sidecar for (root, issue), or start an empty one; a malformed sidecar is refused. */
    static open(dir: string, root: string, issue: FactoryRunKey): EngineLedger;
    tracks(path: string): boolean;
    /** The content of the engine's last write of `path` (null: absent; undefined: not tracked). */
    recorded(path: string): string | null | undefined;
    /** Record the engine's write of `path` (null: the file must not exist) and persist the sidecar. */
    record(path: string, content: string | null): void;
    /**
     * True when `bytes` (one read of `path`, null: absent) are exactly the
     * engine's last write of it. The caller parses these same bytes, so a swap
     * between a hash and a second read cannot happen. Untracked: false.
     */
    matches(path: string, bytes: Buffer | null): boolean;
    /** Engine-owned files whose bytes differ from the engine's last write (optionally only `paths`). */
    mismatches(paths?: readonly string[]): string[];
    /**
     * Move each mismatched file aside (`<file>.tampered-<stamp>`) and write the
     * engine's own bytes back; returns the aside paths.
     */
    restore(paths: readonly string[], stamp: string): string[];
    setBaseline(laneId: string, snapshot: RepoSnapshot): void;
    baseline(laneId: string): RepoSnapshot | undefined;
    dropBaseline(laneId: string): void;
    get recheck(): LedgerRecheck | undefined;
    setRecheck(recheck: LedgerRecheck | undefined): void;
    private persist;
}
/** True when the directory exists and holds no entry. */
export declare function isEmptyDir(path: string): boolean;
//# sourceMappingURL=ledger.d.ts.map