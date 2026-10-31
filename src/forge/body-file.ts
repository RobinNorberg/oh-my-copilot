/**
 * How a tracker write's body file is read (shipyard-factory design PR 7a,
 * 7b): the factory guard reads a gh `--body-file` with it, and the Azure
 * DevOps adapter reads a work item body with it. No process imports here:
 * src/forge stays free of child_process.
 */

import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'fs';
import { isAbsolute, relative, resolve } from 'path';

/** Whether `path` names a file directly in the absolute directory `dir` (the caller's body directory). */
export function isBodyFileIn(path: string, dir: string): boolean {
  if (!isAbsolute(path) || !isAbsolute(dir)) return false;
  const rel = relative(resolve(dir), resolve(path));
  // No `:` either: `b.md:s` names an NTFS alternate data stream of b.md.
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel) && !/[\\/:]/.test(rel);
}

/** The most characters a tracker write's body file may hold. */
export const MAX_TRACKER_BODY_CHARS = 65536;

/**
 * Read a tracker write's body file as the reader's own bytes: a regular file
 * with one link (no symlink, junction or hardlink), the same file when opened
 * as when checked, at most MAX_TRACKER_BODY_CHARS characters.
 */
export function readTrackerBody(path: string, fail: (reason: string) => Error): Buffer {
  let reason: string | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) {
      reason = '--body-file must be a regular file with one link (no symlink, junction or hardlink)';
    } else {
      const fd = openSync(path, 'r');
      try {
        const opened = fstatSync(fd, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== before.dev || opened.ino !== before.ino) {
          reason = '--body-file changed while it was checked';
        } else if (opened.size > BigInt(MAX_TRACKER_BODY_CHARS * 4)) {
          // UTF-8 spends at most 4 bytes per character: a larger file cannot fit.
          reason = `--body-file is longer than ${MAX_TRACKER_BODY_CHARS} characters`;
        } else {
          const raw = readFileSync(fd);
          if (raw.toString('utf8').length <= MAX_TRACKER_BODY_CHARS) return raw;
          reason = `--body-file is longer than ${MAX_TRACKER_BODY_CHARS} characters`;
        }
      } finally {
        closeSync(fd);
      }
    }
  } catch (error) {
    reason = `cannot read --body-file: ${error instanceof Error ? error.message : String(error)}`;
  }
  throw fail(reason);
}
