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
 * not a regular file. POSIX opens with O_NOFOLLOW. Windows has no
 * O_NOFOLLOW, so the path is lstat'ed before the open and again after it,
 * and the write goes ahead only when both name the file that was opened.
 */
export declare function appendFileNoFollow(file: string, text: string, platform?: NodeJS.Platform): boolean;
//# sourceMappingURL=append-no-follow.d.ts.map