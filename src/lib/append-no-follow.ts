/**
 * Appends to a file without following a symlink or junction at its path.
 *
 * The hook debug logs live in TEMP, which in a copilot_run lane is the
 * lane-writable `<job home>/tmp`: a lane could plant `tmp/<name>.log` as a
 * link to a file outside it, and a plain appendFileSync would follow it.
 */

import * as fs from 'fs';

/**
 * Appends `text` to `file` and returns true, or returns false (writing
 * nothing) when `file` is a symlink, a junction, a hard link (nlink > 1) or
 * not a regular file. POSIX opens with O_NOFOLLOW. Windows has no
 * O_NOFOLLOW, so the path is lstat'ed before the open and again after it,
 * and the write goes ahead only when both name the file that was opened.
 */
export function appendFileNoFollow(file: string, text: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') {
    let fd: number;
    try {
      fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ELOOP') return false;
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
  const unsafe = (st: fs.Stats): boolean => st.isSymbolicLink() || !st.isFile() || st.nlink > 1;
  const before = lstatOrNull(file);
  if (before && unsafe(before)) return false;
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    const after = lstatOrNull(file);
    const opened = fs.fstatSync(fd);
    if (!after || unsafe(after) || after.ino !== opened.ino || after.dev !== opened.dev || opened.nlink > 1) return false;
    if (before && (before.ino !== opened.ino || before.dev !== opened.dev)) return false;
    fs.writeSync(fd, text);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

function lstatOrNull(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
