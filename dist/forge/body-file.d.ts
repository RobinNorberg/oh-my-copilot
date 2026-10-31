/**
 * How a tracker write's body file is read (shipyard-factory design PR 7a,
 * 7b): the factory guard reads a gh `--body-file` with it, and the Azure
 * DevOps adapter reads a work item body with it. No process imports here:
 * src/forge stays free of child_process.
 */
/** The most characters a tracker write's body file may hold. */
export declare const MAX_TRACKER_BODY_CHARS = 65536;
/**
 * Read a tracker write's body file as the reader's own bytes: a regular file
 * with one link (no symlink, junction or hardlink), the same file when opened
 * as when checked, at most MAX_TRACKER_BODY_CHARS characters.
 */
export declare function readTrackerBody(path: string, fail: (reason: string) => Error): Buffer;
//# sourceMappingURL=body-file.d.ts.map