/**
 * Appends to a file without following a symlink or junction at its path.
 *
 * The hook debug logs live in TEMP, which in a copilot_run lane is the
 * lane-writable `<job home>/tmp`: a lane could plant `tmp/<name>.log` as a
 * link to a file outside it, and a plain appendFileSync would follow it.
 */

import * as fs from 'fs';

/** Open errors that mean a link, a FIFO without a reader or another non-file sits at the path. */
const REFUSED = new Set(['ELOOP', 'EMLINK', 'ENXIO']);

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
export function appendFileNoFollow(file: string, text: string, platform: NodeJS.Platform = process.platform): boolean {
  const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  if (platform !== 'win32') {
    let fd: number;
    try {
      fd = fs.openSync(file, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600);
    } catch (err) {
      if (REFUSED.has((err as NodeJS.ErrnoException).code ?? '')) return false;
      throw err;
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink > 1) return false;
      fs.writeSync(fd, text);
      return true;
    } finally {
      fs.closeSync(fd);
    }
  }
  // NTFS file IDs exceed 2^53: compare them as bigints.
  const unsafe = (st: fs.BigIntStats): boolean => st.isSymbolicLink() || !st.isFile() || st.nlink > 1n;
  const before = lstatOrNull(file);
  if (before && unsafe(before)) return false;
  let fd: number;
  try {
    fd = before ? fs.openSync(file, O_WRONLY | O_APPEND) : fs.openSync(file, 'ax', 0o600);
  } catch (err) {
    // The name was created or removed since the lstat: something raced the write.
    if (['EEXIST', 'ENOENT'].includes((err as NodeJS.ErrnoException).code ?? '')) return false;
    throw err;
  }
  try {
    const after = lstatOrNull(file);
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!after || unsafe(after) || after.ino !== opened.ino || after.dev !== opened.dev || opened.nlink > 1n) return false;
    if (before && (before.ino !== opened.ino || before.dev !== opened.dev)) return false;
    fs.writeSync(fd, text);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Creates `file` for appending and returns its fd; throws (EEXIST) when the
 * name already exists, a symlink or junction included: O_CREAT|O_EXCL never
 * follows a link (CREATE_NEW on Windows). Writes through the fd keep reaching
 * the created file after its name is renamed or replaced.
 */
export function openAppendExclusive(file: string): number {
  const { O_WRONLY, O_APPEND, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
  return fs.openSync(file, O_WRONLY | O_APPEND | O_CREAT | O_EXCL | (O_NOFOLLOW ?? 0), 0o600);
}

function lstatOrNull(file: string): fs.BigIntStats | null {
  try {
    return fs.lstatSync(file, { bigint: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
