/**
 * Appends to a file without following a symlink or junction at its path.
 *
 * The hook debug logs live in TEMP, which in a copilot_run lane is the
 * lane-writable `<job home>/tmp`: a lane could plant `tmp/<name>.log` as a
 * link to a file outside it, and a plain appendFileSync would follow it.
 */
/**
 * Appends `text` to `file` and returns true, or returns false (writing
 * nothing) when `file` is a symlink, a junction, a hard link (nlink > 1) or
 * not a regular file. POSIX opens with O_NOFOLLOW (ELOOP, EMLINK on
 * FreeBSD) and O_NONBLOCK (a FIFO fails with ENXIO instead of hanging).
 * Windows has no O_NOFOLLOW, so the path is lstat'ed before the open and
 * again after it, and the write goes ahead only when both name the file that
 * was opened. A missing file is created exclusively, an existing one is
 * opened without O_CREAT: a link swapped in between cannot create its target.
 */
export declare function appendFileNoFollow(file: string, text: string, platform?: NodeJS.Platform): boolean;
/**
 * Creates `file` for appending and returns its fd; throws (EEXIST) when the
 * name already exists, a symlink or junction included: O_CREAT|O_EXCL never
 * follows a link (CREATE_NEW on Windows). Writes through the fd keep reaching
 * the created file after its name is renamed or replaced.
 */
export declare function openAppendExclusive(file: string): number;
//# sourceMappingURL=append-no-follow.d.ts.map