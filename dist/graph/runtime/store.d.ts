/**
 * File-backed projection snapshot store (graph runtime v2).
 *
 * Implements ProjectionStore over `<runsRoot>/<run_id>/projection.json`.
 * The journal is the source of truth; this snapshot only accelerates resume
 * and serves status. Every persist goes through temp+rename
 * (atomicWriteJsonSync); every read fails closed on corruption (AC-3).
 */
import type { RunDirHandle } from "./run-dir.js";
import type { ProjectionSnapshotEnvelope, ProjectionStore } from "./types.js";
/** Closed error surface for projection snapshot failures. */
export declare class ProjectionStoreError extends Error {
    readonly code: "descriptor_mismatch" | "corrupt";
    constructor(code: "descriptor_mismatch" | "corrupt", message: string);
}
/** Load/save surface over one run's `<run_id>/projection.json`. */
export declare class FileProjectionStore implements ProjectionStore {
    private readonly runsRoot;
    private readonly runId;
    private readonly handle?;
    constructor(runsRoot: string, runId: string, runDirHandle?: RunDirHandle);
    private runDir;
    save(envelope: ProjectionSnapshotEnvelope, assertOwnership?: () => void): Promise<void>;
    /**
     * The atomic writer hard-links the prior snapshot to a rollback name before
     * its rename. A writer killed inside that window leaves projection.json
     * with nlink 2, which the private-regular-file check rightly refuses, so
     * every later save would fail the run. Only the run's owner saves, and the
     * rollback link is useless once its writer is gone: drop it. Removing a
     * same-directory name never makes an outside hardlink pass that check.
     */
    private removeCrashedRollbackLinks;
    load(): Promise<ProjectionSnapshotEnvelope | null>;
}
//# sourceMappingURL=store.d.ts.map